/**
 * Point-of-sale sale — placePosSale (docs/CONTRACTS.md §1 "orders/pos-sale.server.ts", admin 06). Added by admin 06 pos
 * on 2026-11-11 as a commerce-core file with its own tests (tests/admin-pos-core.test.ts).
 *
 *   const sale = await placePosSale(db, actor, {
 *     idempotencyKey,                       // made on the device ONCE per sale (an offline sale keeps it until it syncs)
 *     shiftId,                              // the drawer the cash goes into (its register says where the goods leave from)
 *     customerId | contact: { phone, name }, // optional; wallet needs a customer account
 *     lines: [{ variantId, qty, unitPriceIqd, discountIqd, serialIds }, { usedUnitId, qty: 1, unitPriceIqd }],
 *     orderDiscountIqd, payments: [{ method: "pos_cash", amountIqd, tenderedIqd }, { method: "pos_card", amountIqd, reference }],
 *   }, now);
 *   // → { orderId, ref, receiptNumber, totalIqd, changeIqd, replayed, lateForClosedShift }
 *
 * WHY A FILE OF ITS OWN: placeOrder is the shopper's checkout (a cart, an address, payment later). A sale at the
 * counter has no cart and no address, is paid and handed over at once, and its cash lands in a drawer. This file
 * writes that sale with the core's own building blocks and invariants, in ONE db.batch:
 *
 *   guest contact (a phone without an account) · order (channel "pos", status delivered, paid, register, shift,
 *   cashier, branch, the device's time for an offline sale) · lines (price / name snapshots, cost snapshot [P],
 *   warranty terms) · STOCK — reserve → commit at the register's store location and the bins under it: one
 *   `stock_reservations` row per slice (committed in the same batch), a 'reserve' and FIFO 'sale' movements
 *   (unit cost [P]), cost layers consumed (guarded), `on_hand −= qty` guarded on the free units (units promised to
 *   web orders are never sold here; TT:INSUFFICIENT_STOCK otherwise, unless an authorised oversell) · serials
 *   through assignSerialsStatements (each must be at this store: TT:SERIAL_NOT_AVAILABLE otherwise; a serial is
 *   sold once) · a used device: reserveUsedUnitStatements, then sold with its own serial · payments (pos_cash,
 *   pos_card — a card charged on the bank's own terminal, recorded by its slip number —, wallet: the ledger
 *   debit, its overdraft trigger aborts everything) · the drawer's 'sale' cash movement (+ the cash applied; the
 *   change never enters the drawer) · warranties (one per serial, otherwise one per line; months for new goods,
 *   days for used devices) · the receipt (invoices kind "receipt", gap-free counter "pos_receipt" → RC-000001,
 *   frozen content, never cost data) · the books: each payment received (postPaymentReceived / postWalletPayment),
 *   revenue recognised (postSale — the goods were handed over) and the cost of goods (postCogs, FIFO) · order
 *   event · audit event.
 *
 * WHO: pos.sale.create; the shift must be the actor's own (or the actor holds pos.shift.review — a supervisor
 * recording a sale a device queued). allowOversell needs inventory.oversell.authorize. PRICES are the caller's: the
 * POS module prices the lines (price lists, the cashier's discount limits) — this file checks that the amounts add
 * up exactly (integer IQD, the database's CHECKs) and never trusts a client for anything else.
 *
 * THE SHIFT: open → the sale lands in it. Closed but not reviewed yet → only a sale queued offline (`offlineCreatedAt`)
 * is still recorded (it synced after the drawer was counted): the shift's expected cash and variance move by the cash
 * of the sale in the same batch (`lateForClosedShift: true`); a sale rung up now on a counted drawer is refused
 * (pos_shift_not_open — review 2026-11-11: a till tab left open after closing used to record it there). Closed and
 * reviewed → refused (pos_shift_reviewed): its books are final.
 *
 * IDEMPOTENCY: orders.idempotency_key stores sha256("tamtam.pos.sale.v1|" + key). The same key again (a double tap,
 * a lost response, a queued sale synced twice, two devices racing) returns the first sale with replayed: true —
 * nothing is written twice. The same key with different content → idempotency_conflict (409).
 *
 * Errors (POS_SALE_ERROR_KEYS; AppError): invalid (400, field keys), forbidden (403), not_found (404),
 * pos_shift_not_open, pos_shift_reviewed, pos_register_inactive, pos_location_invalid, insufficient_stock,
 * serial_not_available, serials_required, serials_count, used_unit_not_available, variant_inactive,
 * payment_total_mismatch, payment_duplicate_method, cash_tendered_short, wallet_requires_account,
 * wallet_insufficient, account_blocked, idempotency_conflict, period_closed (409).
 *
 * Must not import "cloudflare:workers".
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, sha256Hex } from "~/lib/ids";
import { LOCALE_CODES, type L10n } from "~/lib/locales";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  bundleItems,
  cashMovements,
  costLayers,
  customers,
  employees,
  guestContacts,
  invoices,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  posRegisters,
  posShifts,
  products,
  serials,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
  variantCosts,
  variants,
  warranties,
  type NewOrder,
  type NewOrderItem,
  type NewStockMovement,
  type NewWarranty,
  type PaymentMethod,
} from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { mapPostingError, postCogs, postPaymentReceived, postSale, postWalletPayment, postedBy } from "../accounting/post.server";
import { takeFifo, type CostLayerState } from "../inventory/fifo";
import { assignSerialsStatements, reserveUsedUnitStatements } from "../inventory/stock.server";
import { walletDebitStatement } from "../wallet.server";
import { addMonthsBaghdad } from "./manage.server";
import { lineName } from "./place.server";

export const POS_SALE_ERROR_KEYS = [
  "pos_shift_not_open",
  "pos_shift_reviewed",
  "pos_register_inactive",
  "pos_location_invalid",
  "insufficient_stock",
  "serial_not_available",
  "serials_required",
  "serials_count",
  "used_unit_not_available",
  "variant_inactive",
  "payment_total_mismatch",
  "payment_duplicate_method",
  "cash_tendered_short",
  "wallet_requires_account",
  "wallet_insufficient",
  "account_blocked",
  "idempotency_conflict",
  "period_closed",
] as const;

/** Payment methods of the till. "pos_card" = an external card terminal recorded by hand (no gateway). */
export const POS_PAYMENT_METHODS = ["pos_cash", "pos_card", "wallet"] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

/** Gap-free counter of POS receipts (sequences.name). */
export const POS_RECEIPT_SEQUENCE = "pos_receipt";
/** The largest amount one sale may carry (10 billion IQD) — a field error above it, never an overflow. */
export const MAX_POS_AMOUNT_IQD = 10_000_000_000;
export const MAX_POS_LINES = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const KEY_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const money = z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(MAX_POS_AMOUNT_IQD, "too_big");
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .overwrite(multiline ? cleanBlock : cleanLine)
    .trim()
    .max(max, "too_long")
    .nullish()
    .transform((value) => (value ? value : null));

export const PosSaleLineInput = z
  .object({
    /** A catalogue variant (new stock, a bundle) … */
    variantId: idSchema.optional(),
    /** … or one used device (qty 1, its own price). */
    usedUnitId: idSchema.optional(),
    qty: z.number({ error: "invalid" }).int("invalid").min(1, "too_small").max(999, "too_big"),
    /** Price of one unit as charged (the POS module decides it: the SKU's price or its price list's). */
    unitPriceIqd: money,
    /** Discount on this line, in IQD (line total = unit × qty − discount). */
    discountIqd: money.default(0),
    /** Serial-tracked units (or a bundle's tracked components): one serial id per unit. */
    serialIds: z.array(idSchema).max(999, "too_big").default([]),
  })
  .refine((line) => Boolean(line.variantId) !== Boolean(line.usedUnitId), { message: "invalid", path: ["variantId"] });

export const PosPaymentInput = z.object({
  method: z.enum(POS_PAYMENT_METHODS),
  /** What this method pays of the total (cash: the part applied, the change is not in it). */
  amountIqd: z.number({ error: "invalid" }).int("invalid").min(1, "too_small").max(MAX_POS_AMOUNT_IQD, "too_big"),
  /** Cash only: what the customer handed over (change = tendered − amount). */
  tenderedIqd: money.optional(),
  /** Card only: the slip number printed by the bank's terminal. Never a card number. */
  reference: optionalText(64),
});

export const PosSaleInput = z.object({
  idempotencyKey: z.string().regex(KEY_PATTERN, "invalid"),
  shiftId: idSchema,
  customerId: idSchema.nullish().transform((value) => value ?? null),
  /** A walk-in customer who gave a phone (no account): kept as a guest contact. */
  contact: z
    .object({ phone: z.string().trim().max(40, "too_long"), name: optionalText(100) })
    .nullish()
    .transform((value) => value ?? null),
  lines: z.array(PosSaleLineInput).min(1, "required").max(MAX_POS_LINES, "too_big"),
  /** Discount on the whole sale, in IQD (booked to sales discounts). */
  orderDiscountIqd: money.default(0),
  payments: z.array(PosPaymentInput).max(3, "too_big").default([]),
  notes: optionalText(500, true),
  /** When the device rang the sale up (an offline sale), epoch ms. */
  offlineCreatedAt: z.number().int().positive().nullish().transform((value) => value ?? null),
  /** Sell units the system has promised elsewhere (the goods already left): needs inventory.oversell.authorize. */
  allowOversell: z.boolean().default(false),
  /** Placed while the store runs in demo mode, or by a demo seed. */
  isDemo: z.boolean().default(false),
  locale: z.enum(LOCALE_CODES as [string, ...string[]]).default("ar"),
  /** Kept in the audit event (a discount's reason, an accepted offline price, an oversell). */
  reason: optionalText(500),
  /** Extra audit facts from the caller (the price lists applied, the discount limit, an offline price accepted). */
  auditFacts: z.record(z.string(), z.unknown()).optional(),
});
export type PosSaleInput = z.input<typeof PosSaleInput>;
type ParsedSale = z.output<typeof PosSaleInput>;

export type PosSaleResult = {
  orderId: string;
  ref: string;
  receiptNumber: string | null;
  totalIqd: number;
  /** Cash handed back (tendered − cash applied). */
  changeIqd: number;
  replayed: boolean;
  /** The shift was already counted: its expected cash and variance were moved by this sale. */
  lateForClosedShift: boolean;
};

/** The frozen content of a POS receipt (invoices.data). Never cost data. Serials are filtered by the reader. */
export type PosReceiptData = {
  kind: "pos_receipt";
  ref: string;
  at: number;
  offlineAt: number | null;
  register: { code: string; name: string };
  cashier: string | null;
  customer: { name: string | null; phoneMasked: string | null; account: boolean } | null;
  lines: { sku: string; name: L10n; qty: number; unitPriceIqd: number; discountIqd: number; totalIqd: number; serials: string[]; warrantyMonths: number | null; warrantyDays: number | null; used: boolean }[];
  subtotalIqd: number;
  orderDiscountIqd: number;
  totalIqd: number;
  payments: { method: PosPaymentMethod; amountIqd: number; reference: string | null }[];
  tenderedIqd: number | null;
  changeIqd: number;
  isDemo: boolean;
};

/** What orders.idempotency_key stores for a POS sale's key. */
export async function posSaleKeyHash(idempotencyKey: string): Promise<string> {
  return sha256Hex(`tamtam.pos.sale.v1|${idempotencyKey}`);
}

/** The sums of a sale exactly as they will be stored (throws invalid when they cannot be). Pure. */
export function posSaleTotals(input: { lines: readonly { unitPriceIqd: number; qty: number; discountIqd?: number }[]; orderDiscountIqd?: number }): {
  lineTotals: number[];
  subtotalIqd: number;
  lineDiscountIqd: number;
  orderDiscountIqd: number;
  totalIqd: number;
} {
  const lineTotals: number[] = [];
  let subtotal = 0;
  let lineDiscount = 0;
  input.lines.forEach((line, index) => {
    const gross = line.unitPriceIqd * line.qty;
    const discount = line.discountIqd ?? 0;
    if (!Number.isSafeInteger(gross) || gross > MAX_POS_AMOUNT_IQD) throw invalid({ [`lines.${index}.unitPriceIqd`]: "too_big" });
    if (discount > gross) throw invalid({ [`lines.${index}.discountIqd`]: "discount_exceeds_price" });
    lineTotals.push(gross - discount);
    subtotal += gross - discount;
    lineDiscount += discount;
  });
  const orderDiscount = input.orderDiscountIqd ?? 0;
  if (orderDiscount > subtotal) throw invalid({ orderDiscountIqd: "discount_exceeds_price" });
  if (subtotal > MAX_POS_AMOUNT_IQD) throw invalid({ lines: "too_big" });
  return { lineTotals, subtotalIqd: subtotal, lineDiscountIqd: lineDiscount, orderDiscountIqd: orderDiscount, totalIqd: subtotal - orderDiscount };
}

// ───────────────────────────────────────────────────────────────── reads

type ShiftContext = {
  shift: typeof posShifts.$inferSelect;
  register: typeof posRegisters.$inferSelect;
  /** The register's store location and the active, sellable locations under it (stock comes from these). */
  locationIds: string[];
  /** Every location of the store's tree (serials and used devices must be in it). */
  treeIds: string[];
  locationSort: Map<string, number>;
};

export type StoreTree = {
  /** The store location and the active, sellable locations under it (a till's stock comes from these). */
  locationIds: string[];
  /** Every location of the store's tree (serials and used devices must be in it). */
  treeIds: string[];
  /** Order of preference when free units tie: the store itself first, then its shelves by their sort. */
  locationSort: Map<string, number>;
};

/**
 * The location tree a register sells from: its location (which must be an active, sellable "store") and everything
 * under it (shelves, bins — at most 8 levels). Throws pos_location_invalid otherwise.
 */
export async function storeLocationTree(db: Db, rootId: string | null): Promise<StoreTree> {
  if (!rootId) throw new AppError("pos_location_invalid", 409);
  const tree = await db.all<{ id: string; kind: string; sellable: number; active: number; sort: number; root: number }>(sql`
    WITH RECURSIVE tree(id, depth) AS (
      SELECT id, 0 FROM inventory_locations WHERE id = ${rootId}
      UNION ALL
      SELECT l.id, tree.depth + 1 FROM inventory_locations AS l JOIN tree ON l.parent_id = tree.id WHERE tree.depth < 8
    )
    SELECT loc.id AS id, loc.kind AS kind, loc.is_sellable AS sellable, loc.is_active AS active, loc.sort AS sort, CASE WHEN loc.id = ${rootId} THEN 1 ELSE 0 END AS root
    FROM inventory_locations AS loc WHERE loc.id IN (SELECT id FROM tree)`);
  const root = tree.find((loc) => Number(loc.root) === 1);
  if (!root || root.kind !== "store" || !Number(root.active) || !Number(root.sellable)) throw new AppError("pos_location_invalid", 409, { detail: rootId });
  const usable = tree.filter((loc) => Number(loc.active) && Number(loc.sellable));
  return {
    locationIds: usable.map((loc) => loc.id),
    treeIds: tree.map((loc) => loc.id),
    locationSort: new Map(usable.map((loc) => [loc.id, Number(loc.root) === 1 ? -1 : Number(loc.sort)])),
  };
}

async function loadShift(db: Db, shiftId: string): Promise<ShiftContext> {
  const row = await db
    .select({ shift: posShifts, register: posRegisters })
    .from(posShifts)
    .innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId))
    .where(eq(posShifts.id, shiftId))
    .get();
  if (!row) throw notFound("pos_shift");
  if (!row.register.isActive) throw new AppError("pos_register_inactive", 409, { detail: row.register.id });
  if (!row.register.locationId) throw new AppError("pos_location_invalid", 409, { detail: row.register.id });
  return { shift: row.shift, register: row.register, ...(await storeLocationTree(db, row.register.locationId)) };
}

type ExistingSale = { id: string; ref: string; channel: string; totalIqd: number; posShiftId: string | null };

async function findSale(db: Db, keyHash: string): Promise<ExistingSale | null> {
  const row = await db
    .select({ id: orders.id, ref: orders.ref, channel: orders.channel, totalIqd: orders.totalIqd, posShiftId: orders.posShiftId })
    .from(orders)
    .where(eq(orders.idempotencyKey, keyHash))
    .get();
  return row ?? null;
}

async function replay(db: Db, existing: ExistingSale, input: ParsedSale): Promise<PosSaleResult> {
  const expected = posSaleTotals({ lines: input.lines, orderDiscountIqd: input.orderDiscountIqd }).totalIqd;
  if (existing.channel !== "pos" || existing.totalIqd !== expected || existing.posShiftId !== input.shiftId) {
    throw new AppError("idempotency_conflict", 409, { detail: existing.ref });
  }
  const receipt = await db.select({ number: invoices.number, data: invoices.data }).from(invoices).where(and(eq(invoices.orderId, existing.id), eq(invoices.kind, "receipt"))).get();
  const data = (receipt?.data ?? null) as Partial<PosReceiptData> | null;
  return { orderId: existing.id, ref: existing.ref, receiptNumber: receipt?.number ?? null, totalIqd: existing.totalIqd, changeIqd: Number(data?.changeIqd ?? 0), replayed: true, lateForClosedShift: false };
}

// ───────────────────────────────────────────────────────────────── the sale

/**
 * Records a sale at the till (file header). Throws AppError; never writes anything when it throws. A retry with the
 * same idempotency key returns the first sale (replayed: true).
 */
export async function placePosSale(db: Db, actor: Actor, raw: PosSaleInput, now: number): Promise<PosSaleResult> {
  assertCan(actor, "pos.sale.create");
  const input = PosSaleInput.parse(raw);
  if (input.allowOversell) assertCan(actor, "inventory.oversell.authorize");

  const keyHash = await posSaleKeyHash(input.idempotencyKey);
  const earlier = await findSale(db, keyHash);
  if (earlier) return replay(db, earlier, input);

  for (let attempt = 1; ; attempt++) {
    try {
      return await placeOnce(db, actor, input, keyHash, now);
    } catch (error) {
      // Another request with the same key won (or committed while this one was planning): answer with it.
      const winner = await findSale(db, keyHash);
      if (winner) return replay(db, winner, input);
      // A queued offline sale whose drawer was counted while it was being recorded lands as a late sale on a retry.
      const retry = isDbError(error, "COST_LAYER_CHANGED") || isUniqueViolation(error, "orders.ref") || (isDbError(error, "POS_SHIFT_CHANGED") && input.offlineCreatedAt !== null);
      if (retry && attempt < 4) continue;
      throw translateSaleError(error);
    }
  }
}

function translateSaleError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const posting = mapPostingError(error);
  if (posting) return posting;
  const info = mapDbError(error);
  switch (info?.code) {
    case "INSUFFICIENT_STOCK":
      return new AppError("insufficient_stock", 409, { detail: info.detail, cause: error });
    case "SERIAL_NOT_AVAILABLE":
      return new AppError("serial_not_available", 409, { detail: info.detail, fields: { serialIds: "serial_not_available" }, cause: error });
    case "SERIAL_COUNT_EXCEEDS_QTY":
      return new AppError("serials_count", 409, { detail: info.detail, fields: { serialIds: "serials_count" }, cause: error });
    case "USED_UNIT_NOT_AVAILABLE":
    case "USED_UNIT_CHANGED":
      return new AppError("used_unit_not_available", 409, { detail: info.detail, cause: error });
    case "WALLET_OVERDRAFT":
      return new AppError("wallet_insufficient", 409, { fields: { wallet: "wallet_insufficient" }, cause: error });
    case "POS_SHIFT_CHANGED":
      return new AppError("pos_shift_not_open", 409, { detail: info.detail, cause: error });
    case "COST_LAYER_CHANGED":
      return new AppError("order_changed", 409, { detail: info.detail, cause: error });
    default:
      return error;
  }
}

type LinePlan = {
  index: number;
  itemId: string;
  input: z.output<typeof PosSaleLineInput>;
  variantId: string;
  usedUnitId: string | null;
  sku: string;
  name: L10n;
  options: Record<string, string> | null;
  totalIqd: number;
  costSnapshotIqd: number | null;
  warrantyMonths: number | null;
  warrantyDays: number | null;
  /** Stock each unit of the line takes (a bundle: its components). Empty for a used device. */
  parts: { variantId: string; qty: number; tracked: boolean }[];
  serialIds: string[];
  serialNumbers: string[];
};

async function placeOnce(db: Db, actor: Actor, input: ParsedSale, keyHash: string, now: number): Promise<PosSaleResult> {
  const ctx = await loadShift(db, input.shiftId);
  const { shift, register } = ctx;
  if (actor.kind === "employee" && shift.openedBy !== actor.id && !can(actor, "pos.shift.review")) throw forbidden("pos.shift.review");
  let lateForClosedShift = false;
  if (shift.status !== "open") {
    if (shift.approvedBy) throw new AppError("pos_shift_reviewed", 409, { detail: shift.id });
    // Only a sale the device queued while it was offline (it could not know the drawer was counted) lands in a counted
    // drawer. A sale rung up now — a till tab left open after the shift was closed — never does: its cash was not in
    // the count, so moving the counted figures would show a shortage that is not there.
    if (input.offlineCreatedAt === null) throw new AppError("pos_shift_not_open", 409, { detail: shift.id });
    lateForClosedShift = true;
  }
  // A branch-limited employee sells only at their branch's registers.
  if (actor.kind === "employee" && actor.branchId != null && actor.branchId !== register.branchId) throw forbidden("branch");

  const totals = posSaleTotals({ lines: input.lines, orderDiscountIqd: input.orderDiscountIqd });

  // ── payments add up exactly (cash may be over-tendered: the change goes back to the customer)
  const methods = new Set<string>();
  let paid = 0;
  let tendered: number | null = null;
  let change = 0;
  for (const [index, payment] of input.payments.entries()) {
    if (methods.has(payment.method)) throw new AppError("payment_duplicate_method", 400, { fields: { [`payments.${index}.method`]: "payment_duplicate_method" } });
    methods.add(payment.method);
    paid += payment.amountIqd;
    if (payment.method === "pos_cash") {
      tendered = payment.tenderedIqd ?? payment.amountIqd;
      if (tendered < payment.amountIqd) throw new AppError("cash_tendered_short", 400, { fields: { [`payments.${index}.tenderedIqd`]: "cash_tendered_short" } });
      change = tendered - payment.amountIqd;
    } else if (payment.tenderedIqd !== undefined && payment.tenderedIqd !== payment.amountIqd) {
      throw invalid({ [`payments.${index}.tenderedIqd`]: "invalid" });
    }
  }
  if (paid !== totals.totalIqd) throw new AppError("payment_total_mismatch", 409, { fields: { payments: "payment_total_mismatch" }, detail: `${paid}≠${totals.totalIqd}` });

  // ── who bought (optional): an account (wallet allowed) or a phone kept as a guest contact
  const customerId = input.customerId;
  let customer: { id: string; phoneE164: string; name: string | null } | null = null;
  if (customerId) {
    const row = await db.select({ id: customers.id, status: customers.status, phoneE164: customers.phoneE164, name: customers.name }).from(customers).where(eq(customers.id, customerId)).get();
    if (!row) throw notFound("customer");
    if (row.status !== "active") throw new AppError("account_blocked", 403, { detail: customerId });
    customer = { id: row.id, phoneE164: row.phoneE164, name: row.name };
  }
  if (methods.has("wallet") && !customer) throw new AppError("wallet_requires_account", 403, { fields: { wallet: "wallet_requires_account" } });
  let guestPhone: string | null = null;
  if (!customer && input.contact?.phone) {
    guestPhone = normalizeIraqPhone(input.contact.phone);
    if (!guestPhone) throw invalid({ "contact.phone": "phone_invalid" });
  }
  const guest = guestPhone
    ? await db.select({ id: guestContacts.id }).from(guestContacts).where(eq(guestContacts.phoneE164, guestPhone)).orderBy(sql`${guestContacts.createdAt} DESC`).limit(1).get()
    : undefined;

  // ── what is sold: variants (and bundles' components), used devices, serials
  const variantIds = [...new Set(input.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])))];
  const usedIds = [...new Set(input.lines.flatMap((line) => (line.usedUnitId ? [line.usedUnitId] : [])))];
  if (usedIds.length !== input.lines.filter((line) => line.usedUnitId).length) throw invalid({ lines: "duplicate_line" });
  const serialIdsAll = input.lines.flatMap((line) => line.serialIds);
  if (new Set(serialIdsAll).size !== serialIdsAll.length) throw invalid({ serialIds: "serials_duplicate" });

  const usedRows = usedIds.length
    ? await db
        .select({ id: usedUnits.id, variantId: usedUnits.variantId, serialId: usedUnits.serialId, grade: usedUnits.grade, status: usedUnits.status, locationId: usedUnits.locationId, costIqd: usedUnits.acquisitionCostIqd, warrantyDays: usedUnits.warrantyDays })
        .from(usedUnits)
        .where(inArray(usedUnits.id, usedIds))
    : [];
  const usedOf = new Map(usedRows.map((row) => [row.id, row]));
  for (const id of usedIds) {
    const unit = usedOf.get(id);
    if (!unit || unit.status !== "listed" || !unit.locationId || !ctx.treeIds.includes(unit.locationId)) throw new AppError("used_unit_not_available", 409, { detail: id });
  }
  const allVariantIds = [...new Set([...variantIds, ...usedRows.map((row) => row.variantId)])];
  const [variantRows, bundleRows] = await Promise.all([
    db
      .select({ id: variants.id, sku: variants.sku, title: variants.title, options: variants.options, isActive: variants.isActive, trackSerials: variants.trackSerials, productName: products.name, warrantyMonths: products.warrantyMonths })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(inArray(variants.id, allVariantIds)),
    variantIds.length ? db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, variantIds)) : Promise.resolve([]),
  ]);
  const variantOf = new Map(variantRows.map((row) => [row.id, row]));
  const componentIds = [...new Set(bundleRows.map((row) => row.componentId))];
  const componentRows = componentIds.length ? await db.select({ id: variants.id, trackSerials: variants.trackSerials }).from(variants).where(inArray(variants.id, componentIds)) : [];
  const trackedComponent = new Map(componentRows.map((row) => [row.id, row.trackSerials]));
  const stockVariants = [...new Set([...variantIds.filter((id) => !bundleRows.some((row) => row.bundleId === id)), ...componentIds])];
  const [levelRows, layerRows, costRows, serialRows] = await Promise.all([
    stockVariants.length
      ? db
          .select({ variantId: stockLevels.variantId, locationId: stockLevels.locationId, onHand: stockLevels.onHand, reserved: stockLevels.reserved })
          .from(stockLevels)
          .where(and(inArray(stockLevels.variantId, stockVariants), inArray(stockLevels.locationId, ctx.locationIds)))
      : Promise.resolve([]),
    stockVariants.length
      ? db
          .select({ id: costLayers.id, variantId: costLayers.variantId, locationId: costLayers.locationId, qtyRemaining: costLayers.qtyRemaining, unitCostIqd: costLayers.unitCostIqd })
          .from(costLayers)
          .where(and(inArray(costLayers.variantId, stockVariants), inArray(costLayers.locationId, ctx.locationIds), sql`${costLayers.qtyRemaining} > 0`))
          .orderBy(asc(costLayers.receivedAt), asc(costLayers.id))
      : Promise.resolve([]),
    db.select({ variantId: variantCosts.variantId, landedCostIqd: variantCosts.landedCostIqd }).from(variantCosts).where(inArray(variantCosts.variantId, [...new Set([...allVariantIds, ...componentIds])])),
    serialIdsAll.length ? db.select({ id: serials.id, serial: serials.serial, variantId: serials.variantId, status: serials.status, locationId: serials.locationId }).from(serials).where(inArray(serials.id, serialIdsAll)) : Promise.resolve([]),
  ]);
  const landed = new Map(costRows.map((row) => [row.variantId, row.landedCostIqd]));
  const serialOf = new Map(serialRows.map((row) => [row.id, row]));
  const usedSerialIds = new Set(usedRows.flatMap((row) => (row.serialId ? [row.serialId] : [])));

  const orderId = newId("ord");
  const lines: LinePlan[] = input.lines.map((line, index) => {
    const used = line.usedUnitId ? usedOf.get(line.usedUnitId) : undefined;
    const variantId = used ? used.variantId : (line.variantId as string);
    const variant = variantOf.get(variantId);
    if (!variant) throw notFound("variant");
    if (used) {
      if (line.qty !== 1) throw invalid({ [`lines.${index}.qty`]: "used_unit_qty" });
      if (line.serialIds.length > 0) throw invalid({ [`lines.${index}.serialIds`]: "serials_not_tracked" });
    } else if (!variant.isActive) {
      throw new AppError("variant_inactive", 409, { detail: variantId, fields: { [`lines.${index}`]: "variant_inactive" } });
    }
    const components = used ? [] : bundleRows.filter((row) => row.bundleId === variantId);
    const parts = used
      ? []
      : components.length
        ? components.map((row) => ({ variantId: row.componentId, qty: row.qty, tracked: Boolean(trackedComponent.get(row.componentId)) }))
        : [{ variantId, qty: 1, tracked: variant.trackSerials }];
    // Serials: exactly one per tracked unit, of the right variant, here, free (the batch guards it again).
    const numbers: string[] = [];
    for (const part of parts) {
      const need = part.tracked ? part.qty * line.qty : 0;
      const given = line.serialIds.filter((id) => serialOf.get(id)?.variantId === part.variantId);
      if (need === 0 && given.length > 0) throw invalid({ [`lines.${index}.serialIds`]: "serials_not_tracked" });
      if (need > 0 && given.length === 0) throw new AppError("serials_required", 409, { fields: { [`lines.${index}.serialIds`]: "serials_required" }, detail: `${index}` });
      if (given.length !== need) throw new AppError("serials_count", 409, { fields: { [`lines.${index}.serialIds`]: "serials_count" }, detail: `${index}` });
    }
    for (const id of line.serialIds) {
      const serial = serialOf.get(id);
      if (!serial || !parts.some((part) => part.tracked && part.variantId === serial.variantId)) throw new AppError("serial_not_available", 409, { detail: id, fields: { [`lines.${index}.serialIds`]: "serial_not_available" } });
      if (serial.status !== "in_stock" || usedSerialIds.has(id) || !serial.locationId || !ctx.treeIds.includes(serial.locationId)) {
        throw new AppError("serial_not_available", 409, { detail: id, fields: { [`lines.${index}.serialIds`]: "serial_not_available" } });
      }
      numbers.push(serial.serial);
    }
    if (used?.serialId) {
      const own = serialRows.find((row) => row.id === used.serialId);
      if (own) numbers.push(own.serial);
    }
    const unitCost = (): number | null => {
      if (used) return used.costIqd ?? null;
      if (components.length === 0) return landed.get(variantId) ?? null;
      let sum = 0;
      for (const part of components) {
        const cost = landed.get(part.componentId);
        if (cost === undefined || cost === null) return null;
        sum += cost * part.qty;
      }
      return sum;
    };
    const options = { ...(variant.options ?? {}), ...(used ? { grade: used.grade } : {}) };
    return {
      index,
      itemId: newId("oit"),
      input: line,
      variantId,
      usedUnitId: used ? used.id : null,
      sku: variant.sku,
      name: lineName(variant.productName, variant.title ?? null),
      options: Object.keys(options).length ? options : null,
      totalIqd: totals.lineTotals[index] as number,
      costSnapshotIqd: unitCost(),
      warrantyMonths: used ? null : (variant.warrantyMonths ?? null),
      warrantyDays: used ? (used.warrantyDays > 0 ? used.warrantyDays : null) : null,
      parts,
      serialIds: line.serialIds,
      serialNumbers: numbers,
    };
  });
  // Used-device serials need fetching when they were not part of the given serials.
  const missingUsedSerials = usedRows.flatMap((row) => (row.serialId && !serialOf.has(row.serialId) ? [row.serialId] : []));
  if (missingUsedSerials.length) {
    const rows = await db.select({ id: serials.id, serial: serials.serial }).from(serials).where(inArray(serials.id, missingUsedSerials));
    for (const plan of lines) {
      const used = plan.usedUnitId ? usedOf.get(plan.usedUnitId) : undefined;
      const own = used?.serialId ? rows.find((row) => row.id === used.serialId) : undefined;
      if (own) plan.serialNumbers.push(own.serial);
    }
  }

  // ── stock: where each unit comes from (the store's locations, most free first), then its FIFO cost
  type Pool = { locationId: string; free: number; onHand: number; take: number };
  const pools = new Map<string, Pool[]>();
  for (const variantId of stockVariants) {
    const rows = levelRows.filter((row) => row.variantId === variantId);
    pools.set(
      variantId,
      rows
        .map((row) => ({ locationId: row.locationId, free: Math.max(row.onHand - row.reserved, 0), onHand: row.onHand, take: 0 }))
        .sort((a, b) => b.free - a.free || (ctx.locationSort.get(a.locationId) ?? 0) - (ctx.locationSort.get(b.locationId) ?? 0) || a.locationId.localeCompare(b.locationId)),
    );
  }
  const queues = new Map<string, CostLayerState[]>();
  for (const layer of layerRows) {
    const key = `${layer.variantId}|${layer.locationId}`;
    queues.set(key, [...(queues.get(key) ?? []), { id: layer.id, qtyRemaining: layer.qtyRemaining, unitCostIqd: layer.unitCostIqd }]);
  }
  const { actorKind, actorId } = actorRef(actor);
  const resBase = newId("res");
  let resCounter = 0;
  const reservationRows: (typeof stockReservations.$inferInsert)[] = [];
  const movementRows: NewStockMovement[] = [];
  const layerTakes = new Map<string, number>();
  const levelTakes = new Map<string, { variantId: string; locationId: string; qty: number; oversell: boolean; lineVariantId: string }>();
  let cogsIqd = 0;
  let uncostedUnits = 0;
  let oversoldUnits = 0;
  for (const plan of lines) {
    for (const part of plan.parts) {
      let need = part.qty * plan.input.qty;
      const pool = pools.get(part.variantId) ?? [];
      const allocations: { locationId: string; qty: number; oversell: boolean }[] = [];
      // Serial-tracked units leave from where their scanned serials are (when that location has them free), so each
      // location's count keeps matching the serials on it (review 2026-11-11: a unit scanned from a shelf used to come
      // off the store's own count when that had more free units). The rest comes from the pool below.
      if (part.tracked) {
        const where = new Map<string, number>();
        for (const id of plan.serialIds) {
          const serial = serialOf.get(id);
          if (serial?.variantId === part.variantId && serial.locationId) where.set(serial.locationId, (where.get(serial.locationId) ?? 0) + 1);
        }
        for (const [locationId, count] of where) {
          const slot = pool.find((entry) => entry.locationId === locationId);
          const take = slot ? Math.min(slot.free, count, need) : 0;
          if (!slot || take <= 0) continue;
          slot.free -= take;
          slot.take += take;
          need -= take;
          allocations.push({ locationId, qty: take, oversell: false });
        }
      }
      for (const slot of pool) {
        if (need === 0) break;
        const take = Math.min(slot.free, need);
        if (take <= 0) continue;
        slot.free -= take;
        slot.take += take;
        need -= take;
        allocations.push({ locationId: slot.locationId, qty: take, oversell: false });
      }
      if (need > 0) {
        if (!input.allowOversell) throw new AppError("insufficient_stock", 409, { detail: plan.variantId, fields: { [`lines.${plan.index}.qty`]: "insufficient_stock" } });
        // An authorised oversell: units on hand but promised elsewhere (never more than are on hand).
        const slot = [...pool].sort((a, b) => b.onHand - b.take - (a.onHand - a.take))[0];
        if (!slot || slot.onHand - slot.take < need) throw new AppError("insufficient_stock", 409, { detail: plan.variantId, fields: { [`lines.${plan.index}.qty`]: "insufficient_stock" } });
        slot.take += need;
        allocations.push({ locationId: slot.locationId, qty: need, oversell: true });
        oversoldUnits += need;
        need = 0;
      }
      for (const allocation of allocations) {
        const reservationId = `${resBase}.${++resCounter}`;
        reservationRows.push({ id: reservationId, orderId, variantId: part.variantId, locationId: allocation.locationId, qty: allocation.qty, status: "committed", expiresAt: null, createdAt: now, orderItemId: plan.itemId, releasedAt: now });
        movementRows.push({ id: `${reservationId}.reserve`, variantId: part.variantId, locationId: allocation.locationId, kind: "reserve", qtyDelta: 0, reservedDelta: allocation.qty, unitCostIqd: null, refType: "order", refId: orderId, reason: "pos_sale", actorKind, actorId, at: now });
        const key = `${part.variantId}|${allocation.locationId}`;
        const slices = takeFifo(queues.get(key) ?? [], allocation.qty, landed.get(part.variantId) ?? null);
        slices.forEach((slice, n) => {
          if (slice.layerId) layerTakes.set(slice.layerId, (layerTakes.get(slice.layerId) ?? 0) + slice.qty);
          if (slice.unitCostIqd === null) uncostedUnits += slice.qty;
          else cogsIqd += slice.unitCostIqd * slice.qty;
          movementRows.push({
            id: `${reservationId}.sale.${n + 1}`,
            variantId: part.variantId,
            locationId: allocation.locationId,
            kind: "sale",
            qtyDelta: -slice.qty,
            reservedDelta: -slice.qty,
            unitCostIqd: slice.unitCostIqd,
            refType: "order",
            refId: orderId,
            reason: slice.fallback ? (slice.unitCostIqd === null ? "no_cost_layer_uncosted" : "no_cost_layer_standard_cost") : allocation.oversell ? "pos_sale_oversold" : "pos_sale",
            actorKind,
            actorId,
            at: now,
          });
        });
        const level = levelTakes.get(key) ?? { variantId: part.variantId, locationId: allocation.locationId, qty: 0, oversell: false, lineVariantId: plan.variantId };
        level.qty += allocation.qty;
        level.oversell ||= allocation.oversell;
        levelTakes.set(key, level);
      }
    }
    if (plan.usedUnitId) {
      const cost = usedOf.get(plan.usedUnitId)?.costIqd;
      if (cost === null || cost === undefined) uncostedUnits += 1;
      else cogsIqd += cost;
    }
  }

  // ── the rows
  const ref = publicRef("TT");
  const isDemo = input.isDemo;
  const guestContactId = customer ? null : guestPhone ? (guest?.id ?? newId("gst")) : null;
  const phone = customer?.phoneE164 ?? guestPhone;
  const contactName = customer?.name ?? input.contact?.name ?? null;
  const mainMethod = [...input.payments].sort((a, b) => b.amountIqd - a.amountIqd)[0]?.method ?? "pos_cash";
  const cashPayment = input.payments.find((payment) => payment.method === "pos_cash");
  const cashier = actor.kind === "employee" ? actor.id : null;
  const cashierLabel = actor.kind === "employee" ? (actor.label ?? (await db.select({ name: employees.name }).from(employees).where(eq(employees.id, actor.id)).get())?.name ?? null) : null;

  const orderRow: NewOrder = {
    id: orderId,
    ref,
    idempotencyKey: keyHash,
    channel: "pos",
    customerId: customer?.id ?? null,
    guestContactId,
    status: "delivered",
    paymentStatus: "paid",
    paymentMethod: mainMethod as PaymentMethod,
    subtotalIqd: totals.subtotalIqd,
    discountIqd: totals.orderDiscountIqd,
    shippingIqd: 0,
    taxIqd: 0,
    totalIqd: totals.totalIqd,
    paidIqd: totals.totalIqd,
    refundedIqd: 0,
    contactName,
    contactPhoneE164: phone,
    notes: input.notes,
    marketingConsent: false,
    locale: input.locale as NewOrder["locale"],
    isDemo,
    placedAt: now,
    confirmedAt: now,
    deliveredAt: now,
    updatedAt: now,
    branchId: register.branchId,
    registerId: register.id,
    posShiftId: shift.id,
    cashierId: cashier,
    offlineCreatedAt: input.offlineCreatedAt,
  };
  const itemRows: NewOrderItem[] = lines.map((plan) => ({
    id: plan.itemId,
    orderId,
    variantId: plan.variantId,
    usedUnitId: plan.usedUnitId,
    sku: plan.sku,
    nameSnapshot: plan.name,
    optionsSnapshot: plan.options,
    unitPriceIqd: plan.input.unitPriceIqd,
    qty: plan.input.qty,
    discountIqd: plan.input.discountIqd,
    totalIqd: plan.totalIqd,
    costSnapshotIqd: plan.costSnapshotIqd,
    refundedQty: 0,
    warrantyMonths: plan.warrantyMonths,
    warrantyDays: plan.warrantyDays,
    isPreorder: false,
  }));

  const statements: BatchStatement[] = [];
  if (guestContactId && !guest && guestPhone) statements.push(db.insert(guestContacts).values({ id: guestContactId, phoneE164: guestPhone, name: input.contact?.name ?? null, createdAt: now }));
  statements.push(db.insert(orders).values(orderRow));
  for (const rows of chunkRows(orderItems, itemRows)) statements.push(db.insert(orderItems).values(rows));

  // The drawer: an open shift (guarded), or a counted one not reviewed yet (its expected cash and variance move).
  const cashIqd = cashPayment?.amountIqd ?? 0;
  if (!lateForClosedShift) {
    statements.push(expectThat(db, sql`EXISTS (SELECT 1 FROM pos_shifts WHERE id = ${shift.id} AND status = 'open')`, { code: "POS_SHIFT_CHANGED", detail: shift.id }));
  } else {
    statements.push(
      db
        .update(posShifts)
        .set({ expectedCashIqd: sql`coalesce(${posShifts.expectedCashIqd}, 0) + ${cashIqd}`, varianceIqd: sql`coalesce(${posShifts.varianceIqd}, 0) - ${cashIqd}` })
        .where(and(eq(posShifts.id, shift.id), eq(posShifts.status, "closed"), sql`${posShifts.approvedBy} IS NULL`)),
      expectChanged(db, 1, { code: "POS_SHIFT_CHANGED", detail: shift.id }),
    );
  }

  // Stock: reservations committed at once, levels guarded on the free units, movements, FIFO layers.
  for (const rows of chunkRows(stockReservations, reservationRows)) statements.push(db.insert(stockReservations).values(rows));
  for (const level of levelTakes.values()) {
    statements.push(
      level.oversell
        ? db
            .update(stockLevels)
            .set({ onHand: sql`${stockLevels.onHand} - ${level.qty}`, allowOversell: sql`CASE WHEN ${stockLevels.onHand} - ${level.qty} - ${stockLevels.reserved} < 0 THEN 1 ELSE ${stockLevels.allowOversell} END`, updatedAt: now })
            .where(and(eq(stockLevels.variantId, level.variantId), eq(stockLevels.locationId, level.locationId), sql`${stockLevels.onHand} >= ${level.qty}`))
        : db
            .update(stockLevels)
            .set({ onHand: sql`${stockLevels.onHand} - ${level.qty}`, updatedAt: now })
            .where(and(eq(stockLevels.variantId, level.variantId), eq(stockLevels.locationId, level.locationId), sql`${stockLevels.onHand} - ${stockLevels.reserved} >= ${level.qty}`)),
      expectChanged(db, 1, { code: "INSUFFICIENT_STOCK", detail: level.lineVariantId }),
    );
  }
  for (const rows of chunkRows(stockMovements, movementRows)) statements.push(db.insert(stockMovements).values(rows));
  for (const [layerId, take] of layerTakes) {
    statements.push(
      db
        .update(costLayers)
        .set({ qtyRemaining: sql`${costLayers.qtyRemaining} - ${take}` })
        .where(and(eq(costLayers.id, layerId), sql`${costLayers.qtyRemaining} >= ${take}`)),
      expectChanged(db, 1, { code: "COST_LAYER_CHANGED", detail: layerId }),
    );
  }

  // Serials: each must still be at this store, then sold once through the core's guarded statements.
  const treeJson = JSON.stringify(ctx.treeIds);
  for (const plan of lines) {
    if (plan.serialIds.length === 0) continue;
    for (const serialId of plan.serialIds) {
      statements.push(expectThat(db, sql`EXISTS (SELECT 1 FROM serials WHERE id = ${serialId} AND location_id IN (SELECT value FROM json_each(${treeJson})))`, { code: "SERIAL_NOT_AVAILABLE", detail: serialId }));
    }
    statements.push(...assignSerialsStatements(db, { orderItemId: plan.itemId, serialIds: plan.serialIds, actor, now }));
  }
  // A used device: listed → reserved → sold, with its own serial attached.
  for (const plan of lines) {
    if (!plan.usedUnitId) continue;
    const used = usedOf.get(plan.usedUnitId);
    statements.push(
      ...reserveUsedUnitStatements(db, { usedUnitId: plan.usedUnitId, orderId, now }),
      db
        .update(usedUnits)
        .set({ status: "sold", soldOrderItemId: plan.itemId, soldAt: now, updatedAt: now })
        .where(and(eq(usedUnits.id, plan.usedUnitId), eq(usedUnits.status, "reserved"))),
      expectChanged(db, 1, { code: "USED_UNIT_CHANGED", detail: plan.usedUnitId }),
    );
    if (used?.serialId) {
      statements.push(
        batchSql(db, sql`UPDATE serials SET status = 'sold', updated_at = ${now} WHERE id = ${used.serialId} AND status IN ('in_stock', 'reserved')`),
        db.insert(orderItemSerials).values({ orderItemId: plan.itemId, serialId: used.serialId, attachedAt: now, attachedBy: actorId }),
        expectThat(db, sql`(SELECT status FROM serials WHERE id = ${used.serialId}) = 'sold'`, { code: "SERIAL_NOT_AVAILABLE", detail: used.serialId }),
      );
    }
  }

  // Payments: received now, recorded by the cashier; the wallet's ledger debit aborts everything on overdraft.
  const paymentRows: { id: string; method: PosPaymentMethod; amountIqd: number; reference: string | null }[] = [];
  for (const payment of input.payments) {
    const paymentId = newId("pay");
    const ledgerId = payment.method === "wallet" ? newId("wal") : null;
    if (ledgerId && customer) {
      statements.push(walletDebitStatement(db, { id: ledgerId, customerId: customer.id, amountIqd: payment.amountIqd, refType: "order", refId: orderId, idempotencyKey: `order:${orderId}:wallet`, reason: "pos_sale", actor, now }));
    }
    statements.push(
      db.insert(payments).values({
        id: paymentId,
        orderId,
        method: payment.method,
        status: "paid",
        amountIqd: payment.amountIqd,
        reference: payment.method === "pos_card" ? payment.reference : null,
        idempotencyKey: `pos:${orderId}:${payment.method}`,
        verifiedBy: cashier,
        verifiedAt: now,
        createdAt: now,
        paidAt: now,
        updatedAt: now,
        posShiftId: shift.id,
        walletLedgerId: ledgerId,
        notes: payment.method === "pos_cash" && change > 0 ? `tendered ${tendered} IQD, change ${change} IQD` : null,
      }),
    );
    if (payment.method === "pos_cash") {
      statements.push(
        db.insert(cashMovements).values({ id: newId("cmv"), shiftId: shift.id, kind: "sale", amountIqd: payment.amountIqd, orderId, paymentId, reason: lateForClosedShift ? "pos_sale_after_close" : null, actorKind, actorId, idempotencyKey: `pos_sale:${orderId}:cash`, at: now }),
      );
    }
    const posting = { at: now, createdBy: postedBy(actor), isDemo };
    statements.push(
      ...(payment.method === "wallet"
        ? postWalletPayment(db, { ...posting, paymentId, orderId, ref, amountIqd: payment.amountIqd })
        : postPaymentReceived(db, { ...posting, paymentId, orderId, ref, method: payment.method, receivedIqd: payment.amountIqd, dueIqd: payment.amountIqd })),
    );
    paymentRows.push({ id: paymentId, method: payment.method, amountIqd: payment.amountIqd, reference: payment.method === "pos_card" ? payment.reference : null });
  }

  // Warranties start at the counter: one per serial, otherwise one per line.
  const warrantyRows: NewWarranty[] = [];
  for (const plan of lines) {
    const months = plan.warrantyMonths ?? 0;
    const days = plan.warrantyDays ?? 0;
    if (months <= 0 && days <= 0) continue;
    const endsAt = months > 0 ? addMonthsBaghdad(now, months) : now + days * DAY_MS;
    const used = plan.usedUnitId ? usedOf.get(plan.usedUnitId) : undefined;
    const lineSerials = used?.serialId ? [used.serialId] : plan.serialIds;
    const base = { orderItemId: plan.itemId, customerId: customer?.id ?? null, phoneE164: phone, startsAt: now, endsAt, status: "active" as const, usedUnitId: plan.usedUnitId, createdAt: now };
    if (lineSerials.length === 0) warrantyRows.push({ id: newId("wty"), serialId: null, ...base });
    else for (const serialId of lineSerials) warrantyRows.push({ id: newId("wty"), serialId, ...base });
  }
  for (const rows of chunkRows(warranties, warrantyRows)) statements.push(db.insert(warranties).values(rows));

  // The receipt: numbered once, in this batch, frozen (reprints show exactly this).
  const receipt: PosReceiptData = {
    kind: "pos_receipt",
    ref,
    at: now,
    offlineAt: input.offlineCreatedAt,
    register: { code: register.code, name: register.name },
    cashier: cashierLabel,
    customer: customer || guestPhone ? { name: contactName, phoneMasked: phone ? maskPhone(phone) : null, account: Boolean(customer) } : null,
    lines: lines.map((plan) => ({
      sku: plan.sku,
      name: plan.name,
      qty: plan.input.qty,
      unitPriceIqd: plan.input.unitPriceIqd,
      discountIqd: plan.input.discountIqd,
      totalIqd: plan.totalIqd,
      serials: plan.serialNumbers,
      warrantyMonths: plan.warrantyMonths,
      warrantyDays: plan.warrantyDays,
      used: Boolean(plan.usedUnitId),
    })),
    subtotalIqd: totals.subtotalIqd,
    orderDiscountIqd: totals.orderDiscountIqd,
    totalIqd: totals.totalIqd,
    payments: paymentRows.map(({ method, amountIqd, reference }) => ({ method, amountIqd, reference })),
    tenderedIqd: tendered,
    changeIqd: change,
    isDemo,
  };
  const receiptId = newId("inv");
  statements.push(
    batchSql(db, sql`INSERT INTO sequences (name, value) VALUES (${POS_RECEIPT_SEQUENCE}, 0) ON CONFLICT(name) DO NOTHING`),
    batchSql(db, sql`UPDATE sequences SET value = value + 1 WHERE name = ${POS_RECEIPT_SEQUENCE}`),
    batchSql(
      db,
      sql`INSERT INTO invoices (id, number, kind, order_id, total_iqd, data, issued_at, issued_by)
        SELECT ${receiptId}, 'RC-' || printf('%06d', s.value), 'receipt', ${orderId}, ${totals.totalIqd}, ${JSON.stringify(receipt)}, ${now}, ${cashier}
        FROM sequences AS s WHERE s.name = ${POS_RECEIPT_SEQUENCE}`,
    ),
    expectChanged(db, 1, { code: "RECEIPT_NOT_ISSUED", detail: orderId }),
  );

  // The books: payments received (above), revenue recognised and the cost of the goods that left.
  const posting = { at: now, createdBy: postedBy(actor), isDemo };
  statements.push(
    ...postSale(db, { ...posting, orderId, ref, subtotalIqd: totals.subtotalIqd, discountIqd: totals.orderDiscountIqd, shippingIqd: 0, totalIqd: totals.totalIqd, taxIqd: 0, refundedBeforeIqd: 0 }),
    ...postCogs(db, { ...posting, orderId, ref, cogsIqd }),
  );

  statements.push(
    db.insert(orderEvents).values({
      id: newId("oev"),
      orderId,
      kind: "placed",
      data: {
        channel: "pos",
        status: "delivered",
        paymentStatus: "paid",
        payments: paymentRows.map(({ method, amountIqd }) => ({ method, amountIqd })),
        totalIqd: totals.totalIqd,
        lines: itemRows.length,
        registerId: register.id,
        shiftId: shift.id,
        offline: input.offlineCreatedAt !== null,
        lateForClosedShift,
        warranties: warrantyRows.length,
        isDemo,
      },
      actorKind,
      actorId,
      at: now,
    }),
    auditStatement(db, {
      actor,
      action: "pos.sale.create",
      entityType: "order",
      entityId: orderId,
      summary: `${ref}: POS sale ${totals.totalIqd} IQD at ${register.code}`,
      after: {
        ref,
        registerId: register.id,
        shiftId: shift.id,
        totalIqd: totals.totalIqd,
        lineDiscountIqd: totals.lineDiscountIqd,
        orderDiscountIqd: totals.orderDiscountIqd,
        payments: paymentRows.map(({ method, amountIqd, reference }) => ({ method, amountIqd, reference })),
        changeIqd: change,
        customerId: customer?.id ?? null,
        guest: Boolean(guestContactId),
        lines: lines.map((plan) => ({ sku: plan.sku, qty: plan.input.qty, unitPriceIqd: plan.input.unitPriceIqd, discountIqd: plan.input.discountIqd, serials: plan.serialIds.length, used: Boolean(plan.usedUnitId) })),
        offlineCreatedAt: input.offlineCreatedAt,
        lateForClosedShift,
        oversoldUnits,
        uncostedUnits,
        isDemo,
        ...(input.auditFacts ?? {}),
      },
      reason: input.reason,
      at: now,
    }),
  );

  await runBatch(db, statements);
  const issued = await db.select({ number: invoices.number }).from(invoices).where(eq(invoices.id, receiptId)).get();
  return { orderId, ref, receiptNumber: issued?.number ?? null, totalIqd: totals.totalIqd, changeIqd: change, replayed: false, lateForClosedShift };
}

