/**
 * Admin 06 — the till: find an item (scan or search), the offline catalogue, the buyer, and the sale itself, priced on
 * the server and handed to the commerce core (orders/pos-sale.server.ts → placePosSale, one batch).
 *
 *   const hit = await lookupItem(db, actor, { shiftId, code: "711719575276" }, locale, now);       // keyboard wedge
 *   const sale = await createSale(db, actor, request, { locale, storeMode }, now);                  // → ref, receipt
 *   const results = await syncSales(db, actor, { sales: queued }, { locale, storeMode }, now);      // offline queue
 *
 * PRICES (06.06): a line costs the SKU's price, or its price list's when one applies to the point of sale at this
 * register's branch and the buyer's segments (pricing 03 `resolveListPrice`, quantity breaks included); a used device
 * costs its own price. The till sends the unit price it showed; a different price now → price_changed (the till
 * shows the new prices) — or, for a sale queued OFFLINE only, a person with pricing.discount.override records it at
 * the prices the customer paid, with a reason (audited; online, a lower price is a discount — never an accepted price).
 * DISCOUNTS: only with pos.discount.apply, always with a reason; each line and the whole sale at most
 * CASHIER_DISCOUNT_LIMIT_BPS (10 %) of the price; beyond it, or when a line's net unit price would fall under the
 * SKU's floor (its landed cost, or the price its minimum margin needs; a bundle without a cost of its own: its
 * components' cost — the cost itself never leaves the server), only pricing.discount.override.
 * PAYMENTS (06.03): cash (tendered and change), card (charged on the bank's own terminal, recorded by its slip number;
 * no terminal or gateway is connected), wallet (a customer the cashier identified by phone; never offline), mixed.
 * The wallet's balance reaches the till only with customers.wallet.read (the server refuses more than the balance).
 * The buyer (06.05): an account found by phone (the sale appears in their orders; warranties carry it), or a phone
 * kept as a guest contact, or nobody.
 * OFFLINE (06.07): `catalogSnapshot` is what the device caches; `syncSales` replays queued sales with the key each got
 * on the device, so a sale synced twice is recorded once. Stock is confirmed on sync: a shortage is a conflict (an
 * authorised oversell records goods that already left), as is a sold or unknown serial. `discardQueuedSale` drops a
 * conflict for good (a supervisor, with a reason; the trail keeps what the device held).
 * RECEIPTS (06.01): `printReceipt` — the first print is the original (recorded once), every later one a recorded copy.
 *
 * Errors (besides the core's POS_SALE_ERROR_KEYS): price_changed, price_missing, not_sellable, discount_not_allowed,
 * discount_over_limit, discount_below_floor (403), discount_reason_required, card_reference_required, wallet_offline,
 * serial_unknown, override_reason_required (400), customer_unknown, not_found (404), sale_recorded (409).
 */
import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import { assertBranch, assertCan, can, canAny, type Actor } from "~/server/actor";
import { audit, auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import {
  auditEvents,
  bundleItems,
  customerSegmentMembers,
  customers,
  invoices,
  orders,
  payments,
  posRegisters,
  posShifts,
  products,
  serials,
  stockLevels,
  usedUnits,
  variantCosts,
  variants,
} from "~/server/db/schema";
import { AppError, forbidden, invalid, notFound, toAppError, type AppErrorOptions } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { allocateAmount, priceForMargin } from "../pricing/rules";
import { resolveListPrice } from "../pricing/lists.server";
import { getAvailability } from "../../inventory/stock.server";
import { placePosSale, posSaleKeyHash, storeLocationTree, type PosReceiptData, type StoreTree } from "../../orders/pos-sale.server";
import { getWalletBalance } from "../../wallet.server";
import { assertAny, employeeNames, ID_PATTERN, KEY_PATTERN } from "./shared.server";
import {
  baghdadDayRange,
  CASHIER_DISCOUNT_LIMIT_BPS,
  discountBeyondLimit,
  latinDigits,
  TILL_METHODS,
  type CatalogSnapshot,
  type CustomerHit,
  type LookupResult,
  type ReceiptView,
  type SaleFilters,
  type SaleOutcome,
  type SaleRow,
  type TillItem,
  type TillMethod,
} from "./types";

export const SALE_ERROR_KEYS = [
  "price_changed",
  "price_missing",
  "not_sellable",
  "discount_not_allowed",
  "discount_over_limit",
  "discount_below_floor",
  "discount_reason_required",
  "card_reference_required",
  "wallet_offline",
  "serial_unknown",
  "override_reason_required",
  "customer_unknown",
  "sale_recorded",
] as const;

/** A refused sale that says what the till can do about it (the prices now; who may resolve it). */
export class PosSaleError extends AppError {
  readonly prices: { index: number; unitPriceIqd: number }[];
  readonly resolvable: "accept_prices" | "oversell" | null;
  constructor(code: string, status: number, extra: { prices?: { index: number; unitPriceIqd: number }[]; resolvable?: "accept_prices" | "oversell" | null }, options: AppErrorOptions = {}) {
    super(code, status, options);
    this.name = "PosSaleError";
    this.prices = extra.prices ?? [];
    this.resolvable = extra.resolvable ?? null;
  }
}

const PAGE_SIZE = 25;

// ───────────────────────────────────────────────────────────────── the till's context

type Till = { shift: typeof posShifts.$inferSelect; register: typeof posRegisters.$inferSelect; tree: StoreTree };

/** The shift a till works on: the employee's own drawer (or a supervisor's take-over), at a store location. */
async function tillOf(db: Db, actor: Actor, shiftId: string): Promise<Till> {
  if (!ID_PATTERN.test(shiftId)) throw invalid({ shiftId: "invalid" });
  const row = await db.select({ shift: posShifts, register: posRegisters }).from(posShifts).innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId)).where(eq(posShifts.id, shiftId)).get();
  if (!row) throw notFound("pos_shift");
  assertBranch(actor, row.register.branchId);
  if (actor.kind === "employee" && row.shift.openedBy !== actor.id && !can(actor, "pos.shift.review")) throw forbidden("pos.shift.review");
  return { ...row, tree: await storeLocationTree(db, row.register.locationId) };
}

type VariantFacts = {
  id: string;
  sku: string;
  barcode: string | null;
  title: L10n | null;
  productName: L10n;
  priceIqd: number;
  isActive: boolean;
  trackSerials: boolean;
  productStatus: string;
  warrantyMonths: number | null;
  attributes: Record<string, unknown> | null;
};

async function variantFacts(db: Db, where: SQL): Promise<VariantFacts[]> {
  return db
    .select({
      id: variants.id,
      sku: variants.sku,
      barcode: variants.barcode,
      title: variants.title,
      productName: products.name,
      priceIqd: variants.priceIqd,
      isActive: variants.isActive,
      trackSerials: variants.trackSerials,
      productStatus: products.status,
      warrantyMonths: products.warrantyMonths,
      attributes: products.attributes,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(where) as Promise<VariantFacts[]>;
}

function nameOf(facts: VariantFacts, locale: Locale): string {
  const product = pick(facts.productName, locale);
  const title = facts.title ? pick(facts.title, locale) : "";
  if (!title) return product;
  return title.toLowerCase().includes(product.toLowerCase()) ? title : `${product} — ${title}`;
}

/** Extra barcodes of a SKU (products.attributes.variantBarcodes[sku], kept by the catalog module). */
function extraBarcodes(facts: VariantFacts): string[] {
  const all = (facts.attributes as { variantBarcodes?: Record<string, unknown> } | null)?.variantBarcodes;
  const list = all && Array.isArray(all[facts.sku]) ? (all[facts.sku] as unknown[]) : [];
  return list.filter((code): code is string => typeof code === "string" && code.length > 0 && code !== facts.barcode);
}

function sellability(facts: VariantFacts): "inactive" | "archived" | "no_price" | null {
  if (facts.productStatus === "archived") return "archived";
  if (!facts.isActive) return "inactive";
  if (!(facts.priceIqd > 0)) return "no_price";
  return null;
}

/** Free units of each variant at the store (its shelves included); a bundle: the sets its components allow. */
async function stockHere(db: Db, tree: StoreTree, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const components = await db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, [...ids]));
  const stockIds = [...new Set([...ids, ...components.map((row) => row.componentId)])];
  const levels = await db
    .select({ variantId: stockLevels.variantId, free: sql<number>`sum(max(${stockLevels.onHand} - ${stockLevels.reserved}, 0))` })
    .from(stockLevels)
    .where(and(inArray(stockLevels.variantId, stockIds), inArray(stockLevels.locationId, tree.locationIds)))
    .groupBy(stockLevels.variantId);
  const free = new Map(levels.map((row) => [row.variantId, Number(row.free)]));
  for (const id of ids) {
    const parts = components.filter((row) => row.bundleId === id);
    out.set(id, parts.length ? Math.min(...parts.map((part) => Math.floor((free.get(part.componentId) ?? 0) / Math.max(1, part.qty)))) : (free.get(id) ?? 0));
  }
  return out;
}

async function segmentsOf(db: Db, customerId: string | null): Promise<string[]> {
  if (!customerId) return [];
  const rows = await db.select({ segmentId: customerSegmentMembers.segmentId }).from(customerSegmentMembers).where(eq(customerSegmentMembers.customerId, customerId));
  return rows.map((row) => row.segmentId);
}

type Priced = { unitPriceIqd: number; basePriceIqd: number; listCode: string | null };

/** The till's price of each variant: its price list's (channel "pos", this branch, the buyer's segments, the quantity) or its own. */
async function priceVariants(db: Db, till: Till, facts: readonly VariantFacts[], qtyOf: (id: string) => number, segmentIds: readonly string[], at: number): Promise<Map<string, Priced>> {
  const out = new Map<string, Priced>();
  const byQty = new Map<number, string[]>();
  for (const fact of facts) {
    const qty = Math.max(1, qtyOf(fact.id));
    byQty.set(qty, [...(byQty.get(qty) ?? []), fact.id]);
  }
  for (const [qty, ids] of byQty) {
    const lists = await resolveListPrice(db, { variantIds: ids, qty, channel: "pos", branchId: till.register.branchId, segmentIds, at });
    for (const id of ids) {
      const fact = facts.find((entry) => entry.id === id) as VariantFacts;
      const list = lists.get(id);
      out.set(id, { unitPriceIqd: list ? list.priceIqd : fact.priceIqd, basePriceIqd: fact.priceIqd, listCode: list ? list.listCode : null });
    }
  }
  return out;
}

async function tillItems(db: Db, till: Till, facts: readonly VariantFacts[], locale: Locale, at: number): Promise<TillItem[]> {
  if (facts.length === 0) return [];
  const ids = facts.map((fact) => fact.id);
  const [prices, here, all, bundles] = await Promise.all([
    priceVariants(db, till, facts, () => 1, [], at),
    stockHere(db, till.tree, ids),
    getAvailability(db, ids),
    db.select({ bundleId: bundleItems.bundleVariantId }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, ids)),
  ]);
  return facts.map((fact) => {
    const price = prices.get(fact.id) as Priced;
    return {
      kind: "variant",
      variantId: fact.id,
      usedUnitId: null,
      sku: fact.sku,
      name: nameOf(fact, locale),
      barcodes: [...(fact.barcode ? [fact.barcode] : []), ...extraBarcodes(fact)],
      unitPriceIqd: price.unitPriceIqd,
      basePriceIqd: price.basePriceIqd,
      listCode: price.listCode,
      trackSerials: fact.trackSerials,
      bundle: bundles.some((row) => row.bundleId === fact.id),
      stockHere: here.get(fact.id) ?? 0,
      stockAll: all.get(fact.id)?.available ?? 0,
      warrantyMonths: fact.warrantyMonths ?? null,
      warrantyDays: null,
      serial: null,
      grade: null,
    };
  });
}

// ───────────────────────────────────────────────────────────────── scan, search, catalogue

const codeOf = (raw: unknown) => latinDigits(typeof raw === "string" ? raw : "").trim().slice(0, 64);

/** A scanned or typed code: a SKU, a barcode (also a SKU's extra barcodes), or a serial number (a unit, a used device). */
export async function lookupItem(db: Db, actor: Actor, input: { shiftId: string; code: string }, locale: Locale, now: number): Promise<LookupResult> {
  assertCan(actor, "pos.sale.create");
  const till = await tillOf(db, actor, input.shiftId);
  const code = codeOf(input.code);
  if (!code) return { kind: "none", code: "" };
  let facts = await variantFacts(db, sql`upper(${variants.sku}) = upper(${code}) OR ${variants.barcode} = ${code}`);
  if (facts.length === 0) {
    const candidates = await variantFacts(db, sql`instr(coalesce(${products.attributes}, ''), ${code}) > 0`);
    facts = candidates.filter((fact) => extraBarcodes(fact).includes(code));
  }
  const fact = facts.sort((a, b) => Number(b.sku.toUpperCase() === code.toUpperCase()) - Number(a.sku.toUpperCase() === code.toUpperCase()))[0];
  if (fact) {
    const blocked = sellability(fact);
    if (blocked) return { kind: "not_sellable", sku: fact.sku, reason: blocked };
    const [item] = await tillItems(db, till, [fact], locale, now);
    return { kind: "item", item: item as TillItem };
  }
  const serial = await db.select().from(serials).where(sql`upper(${serials.serial}) = upper(${code})`).get();
  if (!serial) return { kind: "none", code };
  if (!can(actor, "inventory.serial.read")) return { kind: "serial_hidden" };
  const here = Boolean(serial.locationId && till.tree.treeIds.includes(serial.locationId));
  const used = await db.select().from(usedUnits).where(eq(usedUnits.serialId, serial.id)).get();
  if (used) {
    if (used.status !== "listed" || !here || !used.locationId || !till.tree.treeIds.includes(used.locationId)) return { kind: "serial_unavailable", serial: serial.serial, status: used.status, here };
    const [facts2] = await variantFacts(db, eq(variants.id, used.variantId));
    if (!facts2) return { kind: "none", code };
    return {
      kind: "item",
      item: {
        kind: "used",
        variantId: used.variantId,
        usedUnitId: used.id,
        sku: facts2.sku,
        name: nameOf(facts2, locale),
        barcodes: [],
        unitPriceIqd: used.priceIqd,
        basePriceIqd: used.priceIqd,
        listCode: null,
        trackSerials: true,
        bundle: false,
        stockHere: 1,
        stockAll: 1,
        warrantyMonths: null,
        warrantyDays: used.warrantyDays > 0 ? used.warrantyDays : null,
        serial: { id: serial.id, serial: serial.serial },
        grade: used.grade,
      },
    };
  }
  if (serial.status !== "in_stock" || !here) return { kind: "serial_unavailable", serial: serial.serial, status: serial.status, here };
  const [variantFact] = await variantFacts(db, eq(variants.id, serial.variantId));
  if (!variantFact) return { kind: "none", code };
  const blocked = sellability(variantFact);
  if (blocked) return { kind: "not_sellable", sku: variantFact.sku, reason: blocked };
  const [item] = await tillItems(db, till, [variantFact], locale, now);
  return { kind: "item", item: { ...(item as TillItem), serial: { id: serial.id, serial: serial.serial } } };
}

/** Items whose name or SKU contains the text (sellable only), for the till's search field. */
export async function searchItems(db: Db, actor: Actor, input: { shiftId: string; q: string }, locale: Locale, now: number): Promise<TillItem[]> {
  assertCan(actor, "pos.sale.create");
  const till = await tillOf(db, actor, input.shiftId);
  const q = latinDigits(input.q ?? "").trim().slice(0, 30);
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_\\]/g, (char) => `\\${char}`)}%`;
  const facts = await variantFacts(
    db,
    and(
      eq(variants.isActive, true),
      ne(products.status, "archived"),
      sql`${variants.priceIqd} > 0`,
      sql`(${variants.sku} LIKE ${like} ESCAPE '\\' OR json_extract(${products.name}, '$.ar') LIKE ${like} ESCAPE '\\' OR json_extract(${products.name}, '$.en') LIKE ${like} ESCAPE '\\' OR json_extract(${variants.title}, '$.ar') LIKE ${like} ESCAPE '\\' OR json_extract(${variants.title}, '$.en') LIKE ${like} ESCAPE '\\')`,
    ) as SQL,
  );
  return tillItems(db, till, facts.slice(0, 12), locale, now);
}

/** Every sellable item with its till price and the store's free units — what a device keeps for offline sales. */
export async function catalogSnapshot(db: Db, actor: Actor, input: { shiftId: string }, locale: Locale, now: number): Promise<CatalogSnapshot> {
  assertCan(actor, "pos.sale.create");
  const till = await tillOf(db, actor, input.shiftId);
  const facts = await variantFacts(db, and(eq(variants.isActive, true), ne(products.status, "archived"), sql`${variants.priceIqd} > 0`) as SQL);
  const items: TillItem[] = [];
  for (let start = 0; start < facts.length; start += 80) items.push(...(await tillItems(db, till, facts.slice(start, start + 80), locale, now)));
  return { at: now, registerId: till.register.id, locationId: till.register.locationId as string, items };
}

/**
 * The buyer's account by phone (customers.customer.read): name, masked phone, segments — and the wallet balance only
 * for roles with customers.wallet.read (module 07's rule; a cashier asks the customer how much to pay from it, and
 * the server refuses more than the balance). Review 2026-11-11: any phone typed at the till used to return its balance.
 */
export async function findCustomer(db: Db, actor: Actor, input: { phone: string }): Promise<CustomerHit | null> {
  assertCan(actor, "pos.sale.create");
  assertCan(actor, "customers.customer.read");
  const phone = normalizeIraqPhone(latinDigits(input.phone ?? ""));
  if (!phone) throw invalid({ phone: "phone_invalid" });
  const row = await db.select({ id: customers.id, name: customers.name, phoneE164: customers.phoneE164, status: customers.status }).from(customers).where(eq(customers.phoneE164, phone)).get();
  if (!row) return null;
  const [walletIqd, segmentIds] = await Promise.all([can(actor, "customers.wallet.read") ? getWalletBalance(db, row.id) : Promise.resolve(null), segmentsOf(db, row.id)]);
  return { id: row.id, name: row.name, phoneMasked: maskPhone(row.phoneE164), walletIqd, status: row.status, segmentIds };
}

// ───────────────────────────────────────────────────────────────── the sale

const money = z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(10_000_000_000, "too_big");
const text = (max: number, multiline = false) =>
  z
    .string()
    .overwrite(multiline ? cleanBlock : cleanLine)
    .trim()
    .max(max, "too_long")
    .nullish()
    .transform((value) => value || null);

export const SaleRequestInput = z.object({
  idempotencyKey: z.string().regex(KEY_PATTERN, "invalid"),
  shiftId: z.string().regex(ID_PATTERN, "invalid"),
  customer: z
    .object({ id: z.string().regex(ID_PATTERN, "invalid").nullish(), phone: z.string().max(40, "too_long").nullish(), name: text(100) })
    .nullish()
    .transform((value) => value ?? null),
  lines: z
    .array(
      z.object({
        variantId: z.string().regex(ID_PATTERN, "invalid").optional(),
        usedUnitId: z.string().regex(ID_PATTERN, "invalid").optional(),
        qty: z.number({ error: "invalid" }).int("invalid").min(1, "too_small").max(999, "too_big"),
        unitPriceIqd: money,
        discountIqd: money.default(0),
        // Serial NUMBERS as scanned or typed (Arabic-Indic / Persian digits read as Latin ones).
        serials: z.array(z.string().overwrite(latinDigits).trim().min(1).max(100)).max(999).default([]),
      }),
    )
    .min(1, "required")
    .max(100, "too_big"),
  orderDiscountIqd: money.default(0),
  payments: z
    .array(z.object({ method: z.enum(TILL_METHODS), amountIqd: money, tenderedIqd: money.optional(), reference: text(64) }))
    .max(3)
    .default([]),
  discountReason: text(300),
  notes: text(500, true),
  offlineCreatedAt: z.number().int().positive().nullish().transform((value) => value ?? null),
  acceptChargedPrices: z.boolean().default(false),
  allowOversell: z.boolean().default(false),
  overrideReason: text(300),
});
export type SaleRequestInput = z.input<typeof SaleRequestInput>;

export type SaleContext = { locale: Locale; storeMode: "demo" | "live" };

/** Records one sale (file header). Throws AppError / PosSaleError; a repeat of its key returns the first sale. */
export async function createSale(db: Db, actor: Actor, raw: SaleRequestInput, context: SaleContext, now: number): Promise<Extract<SaleOutcome, { ok: true }>> {
  assertCan(actor, "pos.sale.create");
  const input = SaleRequestInput.parse(raw);
  const payments = input.payments.filter((payment) => payment.amountIqd > 0);

  // A sale already recorded with this key is answered as it was, whatever changed since (prices, stock, the shift, the
  // connection): a response lost on the way back must never turn a recorded sale into a refusal.
  const earlier = await db.select({ id: orders.id }).from(orders).where(eq(orders.idempotencyKey, await posSaleKeyHash(input.idempotencyKey))).get();
  if (earlier) {
    const replayed = await placePosSale(
      db,
      actor,
      {
        idempotencyKey: input.idempotencyKey,
        shiftId: input.shiftId,
        lines: input.lines.map((line) => ({ variantId: line.usedUnitId ? undefined : line.variantId, usedUnitId: line.usedUnitId, qty: line.qty, unitPriceIqd: line.unitPriceIqd, discountIqd: line.discountIqd })),
        orderDiscountIqd: input.orderDiscountIqd,
        payments: payments.map((payment) => ({ method: payment.method, amountIqd: payment.amountIqd })),
      },
      now,
    );
    return { ok: true, ref: replayed.ref, receiptNumber: replayed.receiptNumber, totalIqd: replayed.totalIqd, changeIqd: replayed.changeIqd, replayed: true, lateForClosedShift: false };
  }
  const till = await tillOf(db, actor, input.shiftId);

  // ── the buyer
  let customerId: string | null = null;
  let contact: { phone: string; name: string | null } | null = null;
  if (input.customer?.id) {
    const row = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, input.customer.id)).get();
    if (!row) throw new AppError("customer_unknown", 404, { fields: { customer: "customer_unknown" } });
    customerId = row.id;
  } else if (input.customer?.phone) {
    const phone = normalizeIraqPhone(latinDigits(input.customer.phone));
    if (!phone) throw invalid({ "customer.phone": "phone_invalid" });
    const account = await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone)).get();
    if (account) customerId = account.id;
    else contact = { phone, name: input.customer.name ?? null };
  }
  if (payments.some((payment) => payment.method === "wallet")) {
    if (input.offlineCreatedAt) throw new AppError("wallet_offline", 409, { fields: { wallet: "wallet_offline" } });
    // The wallet is spent only for an account the cashier looked up and confirmed (by id), never for a typed phone.
    if (!input.customer?.id) throw new AppError("wallet_requires_account", 403, { fields: { wallet: "wallet_requires_account" } });
  }
  for (const [index, payment] of payments.entries()) {
    if (payment.method === "pos_card" && (!payment.reference || payment.reference.length < 3)) throw new AppError("card_reference_required", 400, { fields: { [`payments.${index}.reference`]: "card_reference_required" } });
  }
  if (input.allowOversell) {
    assertCan(actor, "inventory.oversell.authorize");
    if (!input.overrideReason || input.overrideReason.length < 3) throw invalid({ overrideReason: "override_reason_required" });
  }

  const auditFacts: Record<string, unknown> = {};
  const lines = [] as { variantId?: string; usedUnitId?: string; qty: number; unitPriceIqd: number; discountIqd: number; serialIds: string[] }[];
  {
    // ── prices: the server's, compared with what the till showed
    const variantLines = input.lines.filter((line) => line.variantId && !line.usedUnitId);
    const facts = variantLines.length ? await variantFacts(db, inArray(variants.id, [...new Set(variantLines.map((line) => line.variantId as string))])) : [];
    for (const [index, line] of input.lines.entries()) {
      if (line.variantId && !line.usedUnitId && !facts.some((fact) => fact.id === line.variantId)) throw new AppError("not_found", 404, { detail: line.variantId, fields: { [`lines.${index}`]: "not_found" } });
    }
    for (const fact of facts) {
      const blocked = sellability(fact);
      if (blocked) throw new AppError(blocked === "no_price" ? "price_missing" : "not_sellable", 409, { detail: fact.sku });
    }
    const qtyByVariant = new Map<string, number>();
    for (const line of variantLines) qtyByVariant.set(line.variantId as string, (qtyByVariant.get(line.variantId as string) ?? 0) + line.qty);
    const prices = await priceVariants(db, till, facts, (id) => qtyByVariant.get(id) ?? 1, await segmentsOf(db, customerId), now);
    const usedIds = input.lines.flatMap((line) => (line.usedUnitId ? [line.usedUnitId] : []));
    const usedRows = usedIds.length ? await db.select({ id: usedUnits.id, priceIqd: usedUnits.priceIqd, variantId: usedUnits.variantId }).from(usedUnits).where(inArray(usedUnits.id, usedIds)) : [];
    const changed: { index: number; unitPriceIqd: number }[] = [];
    const listsApplied: string[] = [];
    input.lines.forEach((line, index) => {
      const now = line.usedUnitId ? usedRows.find((row) => row.id === line.usedUnitId)?.priceIqd : prices.get(line.variantId as string)?.unitPriceIqd;
      if (now === undefined) throw new AppError("used_unit_not_available", 409, { detail: line.usedUnitId ?? line.variantId });
      if (now !== line.unitPriceIqd) changed.push({ index, unitPriceIqd: now });
      const code = line.variantId ? prices.get(line.variantId)?.listCode : null;
      if (code) listsApplied.push(code);
    });
    if (changed.length) {
      // Accepting the prices the customer paid is for a sale rung up OFFLINE from the device's catalogue only: online,
      // a lower price is a discount (limits, floor, reason, discount reports) — never an "accepted price".
      if (!input.acceptChargedPrices || !input.offlineCreatedAt) throw new PosSaleError("price_changed", 409, { prices: changed, resolvable: input.offlineCreatedAt && can(actor, "pricing.discount.override") ? "accept_prices" : null }, { detail: changed.map((row) => row.index).join(",") });
      assertCan(actor, "pricing.discount.override");
      if (!input.overrideReason || input.overrideReason.length < 3) throw invalid({ overrideReason: "override_reason_required" });
      auditFacts.acceptedPrices = changed.map((row) => ({ line: row.index, charged: input.lines[row.index]?.unitPriceIqd, priceNow: row.unitPriceIqd }));
    }
    if (listsApplied.length) auditFacts.priceLists = [...new Set(listsApplied)];

    // ── discounts: the cashier's limit, the margin floor, a reason
    const hasDiscount = input.orderDiscountIqd > 0 || input.lines.some((line) => line.discountIqd > 0);
    const override = can(actor, "pricing.discount.override");
    if (hasDiscount) {
      if (!canAny(actor, ["pos.discount.apply", "pricing.discount.override"])) throw new AppError("discount_not_allowed", 403, { fields: { discount: "discount_not_allowed" } });
      if (!input.discountReason || input.discountReason.length < 3) throw invalid({ discountReason: "discount_reason_required" });
      const beyond = discountBeyondLimit(input.lines, input.orderDiscountIqd, CASHIER_DISCOUNT_LIMIT_BPS);
      if (beyond !== null && !override) throw new AppError("discount_over_limit", 403, { fields: { [beyond === "order" ? "orderDiscountIqd" : `lines.${beyond}.discountIqd`]: "discount_over_limit" } });
      const floorLine = await lineUnderFloor(db, input.lines, input.orderDiscountIqd);
      if (floorLine !== null && !override) throw new AppError("discount_below_floor", 403, { fields: { [`lines.${floorLine}.discountIqd`]: "discount_below_floor" } });
      auditFacts.discountLimitBps = CASHIER_DISCOUNT_LIMIT_BPS;
      auditFacts.discountByOverride = beyond !== null || floorLine !== null;
    }

    // ── serials: numbers scanned at the till → their ids (the core checks where they are and that they are free)
    const allNumbers = input.lines.flatMap((line) => line.serials);
    const serialRows = allNumbers.length ? await db.select({ id: serials.id, serial: serials.serial, variantId: serials.variantId }).from(serials).where(inArray(sql`upper(${serials.serial})`, allNumbers.map((value) => value.toUpperCase()))) : [];
    const lineVariantIds = [...new Set(variantLines.map((line) => line.variantId as string))];
    const components = lineVariantIds.length ? await db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, lineVariantIds)) : [];
    input.lines.forEach((line, index) => {
      const own = line.variantId ? [line.variantId, ...components.filter((row) => row.bundleId === line.variantId).map((row) => row.componentId)] : [];
      const serialIds = line.serials.map((value) => {
        const row = serialRows.find((entry) => entry.serial.toUpperCase() === value.toUpperCase() && own.includes(entry.variantId));
        if (!row) throw new AppError("serial_unknown", 409, { detail: value, fields: { [`lines.${index}.serials`]: "serial_unknown" } });
        return row.id;
      });
      lines.push({ variantId: line.usedUnitId ? undefined : line.variantId, usedUnitId: line.usedUnitId, qty: line.qty, unitPriceIqd: line.unitPriceIqd, discountIqd: line.discountIqd, serialIds });
    });
  }
  if (input.offlineCreatedAt) auditFacts.offline = true;

  const reason = [input.discountReason, input.overrideReason].filter(Boolean).join(" · ") || null;
  try {
    const result = await placePosSale(
      db,
      actor,
      {
        idempotencyKey: input.idempotencyKey,
        shiftId: input.shiftId,
        customerId,
        contact,
        lines,
        orderDiscountIqd: input.orderDiscountIqd,
        payments: payments.map((payment) => ({ method: payment.method, amountIqd: payment.amountIqd, tenderedIqd: payment.method === "pos_cash" ? payment.tenderedIqd : undefined, reference: payment.reference })),
        notes: input.notes,
        offlineCreatedAt: input.offlineCreatedAt,
        allowOversell: input.allowOversell,
        isDemo: context.storeMode === "demo",
        locale: context.locale,
        reason,
        auditFacts,
      },
      now,
    );
    return { ok: true, ref: result.ref, receiptNumber: result.receiptNumber, totalIqd: result.totalIqd, changeIqd: result.changeIqd, replayed: result.replayed, lateForClosedShift: result.lateForClosedShift };
  } catch (error) {
    const appError = toAppError(error);
    if (appError?.code === "insufficient_stock") throw new PosSaleError("insufficient_stock", 409, { resolvable: input.offlineCreatedAt && can(actor, "inventory.oversell.authorize") ? "oversell" : null }, { detail: appError.detail, fields: appError.fields });
    throw error;
  }
}

/**
 * The first line whose net unit price (after its own and its share of the sale's discount) falls under its floor: the
 * SKU's landed cost, or the price its minimum margin needs; a bundle without a cost of its own: what its components
 * cost (review 2026-11-11 — bundles used to have no floor at all); a used device: what it was bought for.
 */
async function lineUnderFloor(db: Db, lines: readonly { variantId?: string; usedUnitId?: string; qty: number; unitPriceIqd: number; discountIqd: number }[], orderDiscountIqd: number): Promise<number | null> {
  const ids = [...new Set(lines.flatMap((line) => (line.variantId && !line.usedUnitId ? [line.variantId] : [])))];
  const usedIds = lines.flatMap((line) => (line.usedUnitId ? [line.usedUnitId] : []));
  const parts = ids.length ? await db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, ids)) : [];
  const costIds = [...new Set([...ids, ...parts.map((part) => part.componentId)])];
  const [costRows, usedRows] = await Promise.all([
    costIds.length ? db.select({ variantId: variantCosts.variantId, landed: variantCosts.landedCostIqd, minBps: variantCosts.minMarginBps }).from(variantCosts).where(inArray(variantCosts.variantId, costIds)) : Promise.resolve([]),
    usedIds.length ? db.select({ id: usedUnits.id, cost: usedUnits.acquisitionCostIqd }).from(usedUnits).where(inArray(usedUnits.id, usedIds)) : Promise.resolve([]),
  ]);
  /** A bundle without its own cost: the sum of its components' landed costs (null when one of them has none). */
  const bundleCost = (variantId: string): number | null => {
    const own = parts.filter((part) => part.bundleId === variantId);
    if (own.length === 0) return null;
    let sum = 0;
    for (const part of own) {
      const landed = costRows.find((row) => row.variantId === part.componentId)?.landed;
      if (landed === null || landed === undefined) return null;
      sum += landed * Math.max(1, part.qty);
    }
    return sum;
  };
  const net = lines.map((line) => line.unitPriceIqd * line.qty - line.discountIqd);
  const weights = net.map((value, index) => ({ id: String(index), weight: value }));
  const shares = orderDiscountIqd > 0 && net.some((value) => value > 0) ? allocateAmount(orderDiscountIqd, weights) : new Map<string, number>();
  for (const [index, line] of lines.entries()) {
    const unitNet = Math.floor((net[index]! - (shares.get(String(index)) ?? 0)) / Math.max(1, line.qty));
    let floor: number | null = null;
    if (line.usedUnitId) floor = usedRows.find((row) => row.id === line.usedUnitId)?.cost ?? null;
    else {
      const cost = costRows.find((row) => row.variantId === line.variantId);
      if (cost) floor = cost.minBps !== null && cost.minBps !== undefined && cost.minBps > 0 && cost.minBps < 10_000 ? priceForMargin(cost.landed, cost.minBps, 1) : cost.landed;
      else if (line.variantId) floor = bundleCost(line.variantId);
    }
    // A line with a discount only: an undiscounted line at its own price is never "under the floor" here.
    if (floor !== null && unitNet < floor && (line.discountIqd > 0 || orderDiscountIqd > 0)) return index;
  }
  return null;
}

export type SyncResult = { key: string; outcome: SaleOutcome };

/** Replays sales queued on a device (at most 20 a call), each with its own key: done, already done, or a conflict. */
export async function syncSales(db: Db, actor: Actor, raw: { sales: unknown[] }, context: SaleContext, now: number, t?: (key: string) => string): Promise<SyncResult[]> {
  assertCan(actor, "pos.sale.create");
  const list = Array.isArray(raw?.sales) ? raw.sales.slice(0, 20) : [];
  const out: SyncResult[] = [];
  for (const entry of list) {
    const key = typeof (entry as { idempotencyKey?: unknown })?.idempotencyKey === "string" ? (entry as { idempotencyKey: string }).idempotencyKey : "";
    try {
      const result = await createSale(db, actor, entry as SaleRequestInput, context, now);
      out.push({ key, outcome: result });
    } catch (error) {
      out.push({ key, outcome: saleFailure(error, t) });
    }
  }
  return out;
}

/**
 * An expected failure as the till's outcome (anything else is rethrown). With `t`, the message and every field error
 * are sentences in the employee's language (`errors.<key>`; a key without a sentence stays a key) — the till shows
 * them beside the field as they come.
 */
export function saleFailure(error: unknown, t?: (key: string) => string): Extract<SaleOutcome, { ok: false }> {
  const appError = toAppError(error);
  if (!appError) throw error;
  const say = (key: string): string | undefined => {
    const text = t ? t(`errors.${key}`) : undefined;
    return text && text !== `errors.${key}` ? text : undefined;
  };
  return {
    ok: false,
    code: appError.code,
    message: say(appError.code),
    fields: appError.fields ? Object.fromEntries(Object.entries(appError.fields).map(([name, key]) => [name, say(key) ?? key])) : undefined,
    prices: error instanceof PosSaleError && error.prices.length ? error.prices : undefined,
    resolvable: error instanceof PosSaleError ? error.resolvable : null,
  };
}

// ───────────────────────────────────────────────────────────────── sales and receipts

export type SalePage = { rows: SaleRow[]; total: number; page: number; pageCount: number; registers: { id: string; code: string; name: string }[]; all: boolean; totals: { count: number; totalIqd: number } | null };

/** POS sales (orders of channel "pos"), newest first; without pos.shift.review only the sales of one's own shifts. */
export async function listSales(db: Db, actor: Actor, filters: SaleFilters, _locale: Locale): Promise<SalePage> {
  assertAny(actor, ["pos.shift.review", "pos.receipt.reprint", "pos.sale.create"]);
  const all = can(actor, "pos.shift.review");
  const self = actor.kind === "employee" ? actor.id : "";
  const branchId = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const conditions: (SQL | undefined)[] = [eq(orders.channel, "pos")];
  if (!all) conditions.push(sql`${orders.posShiftId} IN (SELECT id FROM pos_shifts WHERE opened_by = ${self})`);
  if (branchId) conditions.push(eq(orders.branchId, branchId));
  if (filters.register) conditions.push(eq(orders.registerId, filters.register));
  if (filters.shift) conditions.push(eq(orders.posShiftId, filters.shift));
  if (filters.day) {
    const range = baghdadDayRange(filters.day);
    conditions.push(sql`${orders.placedAt} >= ${range.from} AND ${orders.placedAt} < ${range.to}`);
  }
  if (filters.method) conditions.push(sql`EXISTS (SELECT 1 FROM payments AS p WHERE p.order_id = ${orders.id} AND p.method = ${filters.method} AND p.status = 'paid')`);
  if (filters.q) {
    const q = filters.q.toUpperCase().replace(/[%_\\]/g, "");
    conditions.push(sql`(${orders.ref} LIKE ${`%${q}%`} OR EXISTS (SELECT 1 FROM invoices AS i WHERE i.order_id = ${orders.id} AND i.kind = 'receipt' AND i.number LIKE ${`%${q}%`}))`);
  }
  const where = and(...conditions);
  // The total of ONE shift is its drawer's figure: never for the drawer's owner, a supervisor's own till included
  // ("sales of this shift" from the shift report) — blind count, like the shift report itself.
  const ownShift = Boolean(all && filters.shift && self && (await db.select({ openedBy: posShifts.openedBy }).from(posShifts).where(eq(posShifts.id, filters.shift)).get())?.openedBy === self);
  const summary = await db.select({ n: sql<number>`count(*)`, total: sql<number>`coalesce(sum(${orders.totalIqd}), 0)` }).from(orders).where(where).get();
  const total = Number(summary?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db
    .select({ order: orders, register: { code: posRegisters.code, name: posRegisters.name }, receipt: invoices.number, lineDiscount: sql<number>`(SELECT coalesce(sum(i.discount_iqd), 0) FROM order_items AS i WHERE i.order_id = ${orders.id})` })
    .from(orders)
    .leftJoin(posRegisters, eq(posRegisters.id, orders.registerId))
    .leftJoin(invoices, and(eq(invoices.orderId, orders.id), eq(invoices.kind, "receipt")))
    .where(where)
    .orderBy(sql`${orders.placedAt} DESC`, sql`${orders.id} DESC`)
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  const ids = rows.map((row) => row.order.id);
  const [paymentRows, registers, cashiers] = await Promise.all([
    ids.length ? db.select({ orderId: payments.orderId, method: payments.method }).from(payments).where(and(inArray(payments.orderId, ids), eq(payments.status, "paid"))) : Promise.resolve([]),
    db.select({ id: posRegisters.id, code: posRegisters.code, name: posRegisters.name }).from(posRegisters).where(branchId ? eq(posRegisters.branchId, branchId) : undefined).orderBy(asc(posRegisters.code)),
    employeeNames(db, rows.map((row) => row.order.cashierId)),
  ]);
  return {
    rows: rows.map(({ order, register, receipt, lineDiscount }) => ({
      orderId: order.id,
      ref: order.ref,
      receiptNumber: receipt ?? null,
      at: order.placedAt,
      offlineAt: order.offlineCreatedAt,
      register: register?.code ? { code: register.code, name: register.name as string } : null,
      shiftId: order.posShiftId,
      cashier: order.cashierId ? (cashiers.get(order.cashierId) ?? order.cashierId) : null,
      customer: order.contactName ?? (order.contactPhoneE164 ? maskPhone(order.contactPhoneE164) : null),
      totalIqd: order.totalIqd,
      discountIqd: order.discountIqd + Number(lineDiscount ?? 0),
      methods: [...new Set(paymentRows.filter((row) => row.orderId === order.id).map((row) => row.method as TillMethod))],
      status: order.status,
      paymentStatus: order.paymentStatus,
      refundedIqd: order.refundedIqd,
      isDemo: order.isDemo,
    })),
    total,
    page,
    pageCount,
    registers,
    all,
    totals: all && !ownShift ? { count: total, totalIqd: Number(summary?.total ?? 0) } : null,
  };
}

/** The audit action of a receipt's original print (once per receipt); later prints are `pos.receipt.reprint`. */
export const RECEIPT_PRINT_ACTION = "pos.receipt.print";

/** One receipt for the print view (pos.receipt.reprint or pos.shift.review; a cashier: their own shifts' sales). */
export async function getReceipt(db: Db, actor: Actor, ref: string, locale: Locale): Promise<ReceiptView> {
  return (await receiptOf(db, actor, ref, locale)).view;
}

async function receiptOf(db: Db, actor: Actor, ref: string, locale: Locale): Promise<{ orderId: string; view: ReceiptView }> {
  assertAny(actor, ["pos.receipt.reprint", "pos.shift.review"]);
  const clean = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(clean)) throw notFound("receipt");
  const row = await db.select({ order: orders, receipt: invoices }).from(orders).innerJoin(invoices, and(eq(invoices.orderId, orders.id), eq(invoices.kind, "receipt"))).where(and(eq(orders.ref, clean), eq(orders.channel, "pos"))).get();
  if (!row) throw notFound("receipt");
  assertBranch(actor, row.order.branchId);
  if (!can(actor, "pos.shift.review")) {
    const shift = row.order.posShiftId ? await db.select({ openedBy: posShifts.openedBy }).from(posShifts).where(eq(posShifts.id, row.order.posShiftId)).get() : undefined;
    if (!(actor.kind === "employee" && shift?.openedBy === actor.id)) throw notFound("receipt");
  }
  const data = row.receipt.data as unknown as PosReceiptData;
  const showSerials = can(actor, "inventory.serial.read");
  const [prints, contact] = await Promise.all([
    db
      .select({ original: sql<number>`coalesce(sum(CASE WHEN ${auditEvents.action} = ${RECEIPT_PRINT_ACTION} THEN 1 ELSE 0 END), 0)`, copies: sql<number>`coalesce(sum(CASE WHEN ${auditEvents.action} = 'pos.receipt.reprint' THEN 1 ELSE 0 END), 0)` })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "order"), eq(auditEvents.entityId, row.order.id), inArray(auditEvents.action, [RECEIPT_PRINT_ACTION, "pos.receipt.reprint"])))
      .get(),
    getSetting(db, "store.contact").catch(() => ({}) as Record<string, unknown>),
  ]);
  const store = contact as { phone?: string; address?: L10n };
  return { orderId: row.order.id, view: {
    ref: data.ref,
    number: row.receipt.number,
    at: data.at,
    offlineAt: data.offlineAt ?? null,
    register: data.register,
    cashier: data.cashier,
    customer: data.customer,
    lines: data.lines.map((line) => ({ ...line, name: pick(line.name, locale), serials: showSerials ? line.serials : null })),
    subtotalIqd: data.subtotalIqd,
    orderDiscountIqd: data.orderDiscountIqd,
    discountIqd: data.orderDiscountIqd + data.lines.reduce((sum, line) => sum + line.discountIqd, 0),
    totalIqd: data.totalIqd,
    payments: data.payments,
    tenderedIqd: data.tenderedIqd,
    changeIqd: data.changeIqd,
    refundedIqd: row.order.refundedIqd,
    status: row.order.status,
    isDemo: data.isDemo,
    printed: Number(prints?.original ?? 0) > 0,
    copies: Number(prints?.copies ?? 0),
    store: { name: null, phone: store.phone ?? null, address: store.address ? pick(store.address, locale) || null : null },
  } };
}

/**
 * Prints a receipt (06.01) — the till right after the sale, or the receipt page. The FIRST print is the original:
 * recorded once (`pos.receipt.print`; a guard inside the write makes the second of two prints at once a copy). Every
 * later print is a COPY: it needs pos.receipt.reprint and is recorded and numbered (`pos.receipt.reprint`). Returns
 * the receipt as it prints and its copy number (0 = the original). Review 2026-11-11: the till printed through a hidden
 * frame that X-Frame-Options: DENY never loads, and any number of unmarked originals printed in the first 15 minutes.
 */
export async function printReceipt(db: Db, actor: Actor, ref: string, now: number, locale: Locale = "ar"): Promise<{ copy: number; receipt: ReceiptView }> {
  const { orderId, view } = await receiptOf(db, actor, ref, locale);
  if (!view.printed) {
    try {
      await runBatch(db, [
        expectThat(db, sql`NOT EXISTS (SELECT 1 FROM audit_events WHERE entity_type = 'order' AND entity_id = ${orderId} AND action = ${RECEIPT_PRINT_ACTION})`, { code: "RECEIPT_PRINTED", detail: orderId }),
        auditStatement(db, { actor, action: RECEIPT_PRINT_ACTION, entityType: "order", entityId: orderId, summary: `${view.ref}: receipt ${view.number ?? ""} printed`, after: { copy: 0, number: view.number }, at: now }),
      ]);
      return { copy: 0, receipt: { ...view, printed: true } };
    } catch (error) {
      // Another print of the same receipt was recorded first: this one is a copy.
      if (!isDbError(error, "RECEIPT_PRINTED")) throw error;
    }
  }
  const { copy } = await recordReprint(db, actor, view.ref, now);
  return { copy, receipt: { ...view, printed: true, copies: Math.max(view.copies, copy) } };
}

/** Records that a copy of a receipt was printed (pos.receipt.reprint; the original is `printReceipt`'s first print). */
export async function recordReprint(db: Db, actor: Actor, ref: string, now: number): Promise<{ copy: number }> {
  assertCan(actor, "pos.receipt.reprint");
  const order = await db.select({ id: orders.id, branchId: orders.branchId, posShiftId: orders.posShiftId }).from(orders).where(and(eq(orders.ref, ref.trim().toUpperCase()), eq(orders.channel, "pos"))).get();
  if (!order) throw notFound("receipt");
  assertBranch(actor, order.branchId);
  if (!can(actor, "pos.shift.review")) {
    const shift = order.posShiftId ? await db.select({ openedBy: posShifts.openedBy }).from(posShifts).where(eq(posShifts.id, order.posShiftId)).get() : undefined;
    if (!(actor.kind === "employee" && shift?.openedBy === actor.id)) throw notFound("receipt");
  }
  const before = await db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(and(eq(auditEvents.action, "pos.receipt.reprint"), eq(auditEvents.entityId, order.id))).get();
  const copy = Number(before?.n ?? 0) + 1;
  await audit(db, { actor, action: "pos.receipt.reprint", entityType: "order", entityId: order.id, after: { copy }, at: now });
  return { copy };
}

// ───────────────────────────────────────────────────────────────── a queued sale dropped on a device

export const DiscardQueuedSaleInput = z.object({
  key: z.string({ error: "invalid" }).regex(KEY_PATTERN, "invalid"),
  reason: z.string({ error: "reason_required" }).overwrite(cleanLine).trim().min(3, "reason_required").max(300, "too_long"),
  /** What the device holds for the sale (its request): kept in the trail, never trusted for anything else. */
  sale: z.unknown().optional(),
});
export type DiscardQueuedSaleInput = z.input<typeof DiscardQueuedSaleInput>;

/**
 * Drops a sale queued on a device that cannot be recorded — a conflict a person decided against (06.07). The goods
 * left and the cash went into a drawer, yet nothing reaches the books, so it needs a supervisor (pos.shift.review):
 * the cashier who rang the sale up and took the money does not erase it alone (review 2026-11-11: pos.sale.create
 * was enough). The trail keeps the key, the reason and what the device held (lines with their SKUs, payments,
 * totals, when it was rung up). A key the server already recorded is refused (`sale_recorded`: its sync answers with
 * the sale). Nothing else changes.
 */
export async function discardQueuedSale(db: Db, actor: Actor, raw: DiscardQueuedSaleInput, now: number): Promise<{ discarded: true }> {
  assertCan(actor, "pos.sale.create");
  assertCan(actor, "pos.shift.review");
  const input = DiscardQueuedSaleInput.parse(raw);
  const recorded = await db.select({ ref: orders.ref }).from(orders).where(eq(orders.idempotencyKey, await posSaleKeyHash(input.key))).get();
  if (recorded) throw new AppError("sale_recorded", 409, { detail: recorded.ref });
  const held = await queuedSummary(db, input.sale);
  await audit(db, {
    actor,
    action: "pos.offline.discard",
    entityType: "pos_offline_sale",
    entityId: input.key,
    summary: `Queued POS sale dropped${held && typeof held.totalIqd === "number" ? `: ${held.totalIqd} IQD` : ""}`,
    after: held ?? { unreadable: true },
    reason: input.reason,
    at: now,
  });
  return { discarded: true };
}

/** What a device held for a queued sale, for the trail: lines (with SKUs), payments, totals — no phone, no customer id. */
async function queuedSummary(db: Db, raw: unknown): Promise<Record<string, unknown> | null> {
  const parsed = SaleRequestInput.safeParse(raw);
  if (!parsed.success) return null;
  const sale = parsed.data;
  const ids = [...new Set(sale.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])))];
  const skus = ids.length ? await db.select({ id: variants.id, sku: variants.sku }).from(variants).where(inArray(variants.id, ids)) : [];
  const lines = sale.lines.map((line) => ({ sku: skus.find((row) => row.id === line.variantId)?.sku ?? null, usedUnitId: line.usedUnitId ?? null, qty: line.qty, unitPriceIqd: line.unitPriceIqd, discountIqd: line.discountIqd, serials: line.serials }));
  const gross = sale.lines.reduce((sum, line) => sum + line.unitPriceIqd * line.qty - line.discountIqd, 0);
  return {
    shiftId: sale.shiftId,
    offlineCreatedAt: sale.offlineCreatedAt,
    lines,
    orderDiscountIqd: sale.orderDiscountIqd,
    totalIqd: gross - sale.orderDiscountIqd,
    payments: sale.payments.map((payment) => ({ method: payment.method, amountIqd: payment.amountIqd, reference: payment.reference })),
    customer: sale.customer ? { account: Boolean(sale.customer.id), phone: Boolean(sale.customer.phone) } : null,
  };
}

