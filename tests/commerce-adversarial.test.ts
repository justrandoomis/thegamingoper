/**
 * Commerce core — adversarial QA (brief §4, §9 and the acceptance tests of §14; ARCHITECTURE §7).
 *
 * Every rule the commerce core is responsible for, attacked the way a careless client, a curious
 * shopper, a rushed employee or two requests at the same moment would attack it. Each test states
 * the CORRECT behaviour. When an attack got through, the commerce module was fixed — never the test.
 *
 * How the attacks are made
 *   · Races are deterministic: interleave() hands a service the same database with a second request
 *     run exactly before or after its n-th db.batch() — i.e. between the service's read and its write.
 *   · Stock and money go through the services (receiveStock, creditWallet, placeOrder, …). The few
 *     rows written directly — a listed used device, carts for the randomised cases, fixture orders
 *     for packing — are rows the services themselves write, so the last test can run the daily
 *     consistency checks over everything this file did and expect nothing to be found.
 *   · A setting a test changes is put back in `finally`.
 *
 * Attacks that got through, and where they were fixed (details in the module headers):
 *   · verifyPayment approved a proof declaring the wrong amount when the verifier typed the due amount
 *     as "received" — the override was skipped                                   payments/payments.server.ts
 *   · a serial held for one order's used device could be packed into another order; a used device's
 *     serial could be packed as new stock                                         inventory/stock.server.ts
 *   · adjustStock decided "no oversell" on a stale read; an order landing between its read and its
 *     write took available stock below zero once allow_oversell had ever been set  inventory/stock.server.ts
 *   · the unpaid-transfer job cancelled an order whose proof arrived while the job ran   orders/manage.server.ts, jobs.server.ts
 *   · the reservation-expiry job released the stock of an order whose proof arrived while it ran   inventory/stock.server.ts
 *   · optional checkout fields sent empty ("") the way HTML forms send them were refused   orders/place.server.ts
 * Closed outside this module's files: INSERT OR REPLACE could rewrite an append-only ledger row; the
 * database now refuses it (drizzle/0003_append_only_no_replace.sql, data owner).
 *
 * Real local D1 (tests/helpers/db.ts).
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { can, systemActor, type Actor } from "~/server/actor";
import { sealAudit, verifyAuditChain } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import {
  auditEvents,
  cartItems,
  carts,
  consents,
  couponRedemptions,
  coupons,
  customers,
  districts,
  files,
  governorates,
  journalEntries,
  journalLines,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  paymentProofs,
  payments,
  refunds,
  serials,
  shippingRates,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
  variantCosts,
  walletLedger,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, accountId, districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { CONSISTENCY_CHECKS, CRON_FREQUENT, runScheduledJobs } from "~/server/jobs.server";
import { defaultRolePermissions, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { setSetting } from "~/server/settings.server";
import { addToCart, applyCoupon, getCartCount, getCartView, getCheckoutCart, mergeGuestCart, setLineQty, type CartViewData } from "~/server/services/cart.server";
import { evaluateCoupon } from "~/server/services/coupons.server";
import { adjustStock, assignSerialsStatements, expireReservations, getAvailability, receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { getOrderByAccessToken, getOrderForCustomer, listOrdersForCustomer, lookupGuestOrder, transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder, type CheckoutInput, type CheckoutWho } from "~/server/services/orders/place.server";
import { TotalsError, computeTotals } from "~/server/services/orders/totals";
import type { PlaceOrderResult } from "~/server/services/orders/types";
import { getPaymentInstructions, recordCodCollection, submitPaymentProof, verifyPayment } from "~/server/services/payments/payments.server";
import { approveRefund, createRefund, getRefundableAmount, listPendingRefunds } from "~/server/services/refunds.server";
import { getShippingFee } from "~/server/services/shipping/fees.server";
import { creditWallet, getWalletBalance, listWalletEntries } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BAGHDAD = governorateId("baghdad");
const SYSTEM = systemActor("test.adversarial");

let t: TestDb;
let make: Fixtures;
/** Employees by role in this file (rows exist; actors are built per test with the permissions it needs). */
const staffIds: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  for (const name of ["finance", "finance2", "finance3", "owner", "manager", "cashier", "support", "fulfillment", "inventory", "content", "clerk", "boss", "ops", "requester", "approver", "approver2", "verifier", "senior"]) {
    staffIds[name] = await make.employee();
  }
});
afterAll(async () => {
  await t.dispose();
});

// ───────────────────────────────────────────────────────────────── helpers

const person = (name: string, ...permissions: Permission[]): Actor => ({ kind: "employee", id: staffIds[name], permissions: new Set(permissions) });
const role = (key: DefaultRoleKey, name: string = key): Actor => ({ kind: "employee", id: staffIds[name], permissions: defaultRolePermissions(key) });
const ops = () => person("ops", "orders.order.update", "orders.order.cancel", "orders.fulfillment.pack", "orders.fulfillment.ship", "orders.fulfillment.deliver", "orders.payment.record", "shipping.attempt.manage");

/** The expected failure of a call, as the AppError a route would see. Unexpected errors are rethrown. */
async function failureOf(promise: PromiseLike<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

/** Runs calls at the same moment; fulfilled values and the AppErrors of the others. */
async function settle<T>(calls: Promise<T>[]): Promise<{ ok: T[]; failed: AppError[] }> {
  const results = await Promise.allSettled(calls);
  const ok: T[] = [];
  const failed: AppError[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") ok.push(result.value);
    else {
      const appError = toAppError(result.reason);
      if (!appError) throw result.reason;
      failed.push(appError);
    }
  }
  return { ok, failed };
}

type HookOutcome = { ok: true; value: unknown } | { ok: false; error: unknown } | null;

/**
 * The same database, with `hook` run right before or right after the `call`-th db.batch() the
 * service makes: a second request placed deterministically between the service's read and write.
 */
function interleave(db: Db, at: { call: number; when: "before" | "after" }, hook: () => Promise<unknown>) {
  let calls = 0;
  let outcome: HookOutcome = null;
  const run = async () => {
    try {
      outcome = { ok: true, value: await hook() };
    } catch (error) {
      outcome = { ok: false, error };
    }
  };
  const batch = async (statements: unknown) => {
    calls += 1;
    const mine = calls === at.call;
    if (mine && at.when === "before") await run();
    const result = await (db.batch as unknown as (items: unknown) => Promise<unknown>).call(db, statements);
    if (mine && at.when === "after") await run();
    return result;
  };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") return batch;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
  return { db: proxy, outcome: (): HookOutcome => outcome };
}

/** Stock that arrived the way the store receives it: movements, a FIFO cost layer and, for tracked variants, serials. */
async function stocked(options: { priceIqd?: number; qty?: number; unitCostIqd?: number; trackSerials?: boolean } = {}) {
  const product = await make.product({ priceIqd: options.priceIqd ?? 400_000, trackSerials: options.trackSerials });
  const qty = options.qty ?? 5;
  if (qty > 0) {
    const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `ADV-${product.sku}-${i + 1}`) : undefined;
    await receiveStock(t.db, SYSTEM, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd: options.unitCostIqd ?? 250_000, serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW - HOUR);
  }
  const serialIds = options.trackSerials ? (await t.db.select({ id: serials.id }).from(serials).where(eq(serials.variantId, product.variantId)).orderBy(serials.serial)).map((row) => row.id) : [];
  return { ...product, serialIds };
}

/** A listed used device (its own serial, in stock) of `variantId`. Demo-flagged: listing evidence is the devices team's rule. */
async function listedUsedUnit(variantId: string, options: { priceIqd?: number; costIqd?: number } = {}) {
  const serialId = newId("ser");
  const unitId = newId("usd");
  await runBatch(t.db, [
    t.db.insert(serials).values({ id: serialId, serial: make.next("USED-SN"), variantId, status: "in_stock", locationId: DEFAULT_LOCATION_ID, source: "trade_in", createdAt: NOW, updatedAt: NOW }),
    t.db.insert(usedUnits).values({
      id: unitId,
      slug: make.next("used-unit"),
      variantId,
      serialId,
      grade: "A",
      priceIqd: options.priceIqd ?? 350_000,
      acquisitionCostIqd: options.costIqd ?? 200_000,
      warrantyDays: 30,
      status: "listed",
      isDemo: true,
      listedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ]);
  return { unitId, serialId };
}

async function couponRow(overrides: Partial<typeof coupons.$inferInsert> = {}) {
  const id = newId("cpn");
  const code = make.next("ADV").replace("-", "");
  await t.db.insert(coupons).values({ id, code, kind: "fixed", value: 10_000, isActive: true, createdAt: NOW, ...overrides });
  return { id, code };
}

type Line = { variantId: string; qty?: number } | { usedUnitId: string };

/**
 * The rows addToCart leaves behind (a guest cart, lines within the 10-unit limit, today's price as
 * the snapshot), written in one batch — for the randomised cases, where a few hundred carts through
 * addToCart would take minutes. Pricing, coupons and checkout still go through the services.
 */
async function rawCart(lines: { variantId: string; qty: number; priceIqd: number }[], couponCode: string | null = null): Promise<string> {
  const token = randomToken();
  const cartId = newId("crt");
  await runBatch(t.db, [
    // A stored coupon code is evaluated again on every read and at checkout, exactly as after applyCoupon.
    t.db.insert(carts).values({ id: cartId, tokenHash: await sha256Hex(token), customerId: null, couponCode, createdAt: NOW, updatedAt: NOW, locale: "ar" }),
    ...lines.map((line, index) => t.db.insert(cartItems).values({ id: newId("cit"), cartId, variantId: line.variantId, usedUnitId: null, qty: line.qty, addedAt: NOW + index, priceSnapshotIqd: line.priceIqd })),
  ]);
  return token;
}

/** A guest cart (cookie token) holding these lines. A customer may still check it out: nobody owns it yet. */
async function cartOf(lines: Line[], at: number = NOW): Promise<string> {
  let token: string | null = null;
  for (const line of lines) {
    const item = "usedUnitId" in line ? { usedUnitId: line.usedUnitId } : { variantId: line.variantId, qty: line.qty ?? 1 };
    token = (await addToCart(t.db, { cartToken: token, customerId: null, locale: "ar" }, item, at)).cartToken;
  }
  return token as string;
}

const shopper = (cartToken: string | null, customerId: string | null = null, extra: Partial<CheckoutWho> = {}): CheckoutWho => ({
  cartToken,
  customer: customerId ? { id: customerId } : null,
  locale: "ar",
  ip: null,
  storeMode: "live",
  ...extra,
});

/** A complete checkout form for the cart, with the total the shopper is shown for that governorate. */
async function checkoutBody(token: string, overrides: Partial<CheckoutInput> = {}, options: { customerId?: string | null; at?: number } = {}): Promise<CheckoutInput> {
  const governorate = typeof overrides.governorateId === "string" ? overrides.governorateId : BAGHDAD;
  const view = await getCartView(t.db, { cartToken: token, customerId: options.customerId ?? null, locale: "ar", governorateId: governorate }, options.at ?? NOW);
  return {
    idempotencyKey: randomToken(),
    phone: make.phone(),
    governorateId: governorate,
    areaText: "الكرادة داخل",
    addressText: "شارع 62، قرب الجسر المعلق، عمارة 4، الطابق الثاني",
    paymentMethod: "cod",
    expectedTotalIqd: view.totalIqd,
    ...overrides,
  };
}

/** Cart + checkout in one go. */
async function buy(lines: Line[], overrides: Partial<CheckoutInput> = {}, options: { customerId?: string | null; at?: number } = {}): Promise<PlaceOrderResult & { token: string; body: CheckoutInput }> {
  const at = options.at ?? NOW;
  const token = await cartOf(lines, at);
  const body = await checkoutBody(token, overrides, { customerId: options.customerId ?? null, at });
  const result = await placeOrder(t.db, shopper(token, options.customerId ?? null), body, at);
  return { ...result, token, body };
}

async function customerWithWallet(balanceIqd: number): Promise<string> {
  const customerId = await make.customer();
  if (balanceIqd > 0) await creditWallet(t.db, SYSTEM, { customerId, amountIqd: balanceIqd, kind: "topup", reason: "شحن رصيد للاختبار", idempotencyKey: `topup-${customerId}` }, NOW - DAY);
  return customerId;
}

/** A stored private proof image (what POST /api/upload/proof leaves behind). */
async function proofFile(overrides: Partial<typeof files.$inferInsert> = {}): Promise<string> {
  const id = newId("fil");
  await t.db.insert(files).values({ id, storageKey: `prv/${id}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 52_114, sha256: randomToken().toLowerCase(), createdAt: NOW, ...overrides });
  return id;
}

async function orderRow(orderId: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!row) throw new Error(`order ${orderId} missing`);
  return row;
}
async function paymentOf(orderId: string) {
  const row = await t.db.select().from(payments).where(eq(payments.orderId, orderId)).get();
  if (!row) throw new Error(`payment of ${orderId} missing`);
  return row;
}
async function levelOf(variantId: string) {
  const row = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
  if (!row) throw new Error(`no stock level for ${variantId}`);
  return row;
}
async function journalByKey(key: string) {
  return t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, key));
}

const COUNTED = [
  "orders",
  "order_items",
  "payments",
  "payment_proofs",
  "stock_reservations",
  "stock_movements",
  "wallet_ledger",
  "coupon_redemptions",
  "journal_entries",
  "journal_lines",
  "order_events",
  "audit_events",
  "guest_contacts",
  "consents",
  "refunds",
  "refund_items",
  "warranties",
  "approvals",
  "cart_items",
] as const;

/** Row counts of every table a checkout or a payment step writes — "nothing was written" means equal snapshots. */
async function counts(): Promise<Record<string, number>> {
  const row = await t.d1.prepare(`SELECT ${COUNTED.map((name) => `(SELECT count(*) FROM ${name}) AS ${name}`).join(", ")}`).first<Record<string, number>>();
  return { ...(row ?? {}) };
}

/** INSERT OR REPLACE of a raw row — the one write the append-only triggers cannot see. */
async function replaceRow(table: string, row: Record<string, unknown>) {
  const columns = Object.keys(row);
  await t.d1
    .prepare(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .bind(...columns.map((column) => row[column] ?? null))
    .run();
}

/** Seeded PRNG (mulberry32): the random cases are the same on every run, and a failure names its case. */
function prng(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)];
  return { next, int, pick };
}

const COST_KEY = /cost|margin|profit|landed|acquisition|cogs|supplier/i;

/** Every place in `value` (recursively) that carries a cost-like key or one of the secret numbers. */
function costLeaks(value: unknown, secrets: readonly number[]): string[] {
  const found: string[] = [];
  const visit = (node: unknown, at: string, depth: number) => {
    if (node === null || node === undefined || depth > 30) return;
    if (typeof node === "number") {
      if (secrets.includes(node)) found.push(`${at} = ${node}`);
      return;
    }
    if (typeof node === "string") {
      for (const secret of secrets) if (node.includes(String(secret))) found.push(`${at} contains ${secret}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${at}[${index}]`, depth + 1));
      return;
    }
    if (node instanceof Map) {
      for (const [key, item] of node) visit(item, `${at}.get(${String(key)})`, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        if (COST_KEY.test(key)) found.push(`${at}.${key}`);
        visit(child, `${at}.${key}`, depth + 1);
      }
    }
  };
  visit(value, "$", 0);
  return found;
}

// ───────────────────────────────────────────────────────────────── §4 / §14 guest checkout

describe("guest checkout — no account, Iraq delivery fields", () => {
  test("only the required fields: a guest buys without an account, a name, notes or a preferred time; consent stays off", async () => {
    const p = await stocked({ priceIqd: 120_000, qty: 3 });
    const token = await cartOf([{ variantId: p.variantId, qty: 2 }]);
    const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: BAGHDAD }, NOW);
    // Exactly the four required fields (phone in Arabic-Indic digits, as typed on an Arabic keyboard) — no marketingConsent key at all.
    const minimal: CheckoutInput = { idempotencyKey: randomToken(), phone: "٠٧٨١ ٢٣٤ ٥٦٧٨", governorateId: BAGHDAD, areaText: "المنصور", addressText: "شارع 14 رمضان، بناية 7", paymentMethod: "cod", expectedTotalIqd: view.totalIqd };
    const placed = await placeOrder(t.db, shopper(token), minimal, NOW);
    expect(placed).toMatchObject({ paymentStatus: "cod_due", totalIqd: 245_000, replayed: false });

    const order = await orderRow(placed.orderId);
    expect(order).toMatchObject({
      customerId: null,
      contactPhoneE164: "+9647812345678",
      contactName: null,
      districtId: null,
      areaText: "المنصور",
      notes: null,
      preferredDay: null,
      preferredWindow: null,
      marketingConsent: false,
      status: "new",
      paymentStatus: "cod_due",
    });
    expect(order.guestContactId).toBeTruthy();
    expect(await t.db.select().from(consents).where(eq(consents.subjectId, order.guestContactId as string))).toEqual([]);
  });

  test("optional fields left empty the way an HTML form sends them (\"\") are optional, not errors", async () => {
    const p = await stocked({ priceIqd: 60_000, qty: 2 });
    const token = await cartOf([{ variantId: p.variantId }]);
    const body = await checkoutBody(token);
    // An untouched <select> posts "", an empty textarea posts "".
    const form = { ...body, contactName: "", notes: "", preferredDay: "", preferredWindow: "", districtId: "" } as unknown as CheckoutInput;
    const placed = await placeOrder(t.db, shopper(token), form, NOW);
    expect(await orderRow(placed.orderId)).toMatchObject({ contactName: null, notes: null, preferredDay: null, preferredWindow: null, districtId: null, marketingConsent: false });
  });

  test("every required field is enforced — missing, blank or malformed — and a refused checkout writes nothing", async () => {
    const p = await stocked({ priceIqd: 45_000, qty: 3 });
    const token = await cartOf([{ variantId: p.variantId }]);
    const base = await checkoutBody(token);
    const baghdadDay = (offsetDays: number) => new Date(NOW + 3 * HOUR + offsetDays * DAY).toISOString().slice(0, 10);
    const cases: { name: string; patch: Record<string, unknown>; status?: number; code?: string; field: string; key: string | string[] }[] = [
      { name: "no phone", patch: { phone: undefined }, field: "phone", key: "required" },
      { name: "blank phone", patch: { phone: "    " }, field: "phone", key: "required" },
      { name: "phone too short", patch: { phone: "0770 123" }, field: "phone", key: "phone_invalid" },
      { name: "landline, not a mobile", patch: { phone: "0712 345 6789" }, field: "phone", key: "phone_invalid" },
      { name: "foreign mobile", patch: { phone: "+44 7700 900123" }, field: "phone", key: "phone_invalid" },
      { name: "words instead of a number", patch: { phone: "اتصلوا بي" }, field: "phone", key: "phone_invalid" },
      { name: "no governorate", patch: { governorateId: undefined }, field: "governorateId", key: "required" },
      { name: "blank governorate", patch: { governorateId: "" }, field: "governorateId", key: ["required", "invalid"] },
      { name: "unknown governorate", patch: { governorateId: "gov_atlantis" }, status: 409, code: "shipping_unavailable", field: "governorateId", key: "shipping_unavailable" },
      { name: "a district of another governorate", patch: { districtId: districtId("basra", "basra") }, field: "districtId", key: "district_invalid" },
      { name: "no area", patch: { areaText: undefined }, field: "areaText", key: "required" },
      { name: "blank area", patch: { areaText: "     " }, field: "areaText", key: "required" },
      { name: "one-letter area", patch: { areaText: "x" }, field: "areaText", key: "required" },
      { name: "no address", patch: { addressText: undefined }, field: "addressText", key: "required" },
      { name: "blank address", patch: { addressText: "        " }, field: "addressText", key: ["required", "too_short"] },
      { name: "an address too vague to deliver to", patch: { addressText: "بيت" }, field: "addressText", key: "too_short" },
      { name: "a day that does not exist", patch: { preferredDay: "2026-02-30" }, field: "preferredDay", key: "preferred_day_invalid" },
      { name: "a day in the past", patch: { preferredDay: baghdadDay(-2) }, field: "preferredDay", key: "preferred_day_invalid" },
      { name: "a day more than 30 days ahead", patch: { preferredDay: baghdadDay(45) }, field: "preferredDay", key: "preferred_day_invalid" },
      { name: "an unknown time window", patch: { preferredWindow: "midnight" }, field: "preferredWindow", key: "invalid" },
      { name: "notes longer than 500 characters", patch: { notes: "ا".repeat(501) }, field: "notes", key: "too_long" },
      { name: "consent sent as text", patch: { marketingConsent: "true" }, field: "marketingConsent", key: "invalid" },
      { name: "a till-only payment method", patch: { paymentMethod: "pos_cash" }, field: "paymentMethod", key: "invalid" },
      { name: "an invented payment method", patch: { paymentMethod: "card" }, field: "paymentMethod", key: "invalid" },
      { name: "a total with fils", patch: { expectedTotalIqd: base.expectedTotalIqd + 0.5 }, field: "expectedTotalIqd", key: "invalid" },
      { name: "a negative total", patch: { expectedTotalIqd: -1 }, field: "expectedTotalIqd", key: "too_small" },
      { name: "NaN as the total", patch: { expectedTotalIqd: Number.NaN }, field: "expectedTotalIqd", key: "invalid" },
      { name: "Infinity as the total", patch: { expectedTotalIqd: Number.POSITIVE_INFINITY }, field: "expectedTotalIqd", key: "invalid" },
      { name: "a guessable idempotency key", patch: { idempotencyKey: "abc" }, field: "idempotencyKey", key: "invalid" },
    ];
    const before = await counts();
    for (const attack of cases) {
      const input = { ...base, idempotencyKey: randomToken(), phone: make.phone(), ...attack.patch } as unknown as CheckoutInput;
      const failure = await failureOf(placeOrder(t.db, shopper(token), input, NOW));
      expect(failure, attack.name).toMatchObject({ status: attack.status ?? 400, code: attack.code ?? "invalid" });
      expect(Array.isArray(attack.key) ? attack.key : [attack.key], attack.name).toContain(failure.fields?.[attack.field]);
    }
    expect(await counts()).toEqual(before);
    expect(await getCartCount(t.db, { cartToken: token, customerId: null })).toBe(1);
    expect((await levelOf(p.variantId)).reserved).toBe(0);
  });

  test("a guest pays cash, by card transfer or by Zain Cash without an account — never from a wallet, not even with a wallet owner's phone", async () => {
    const p = await stocked({ priceIqd: 90_000, qty: 6 });
    for (const method of ["cod", "bank_transfer", "zaincash"] as const) {
      const placed = await buy([{ variantId: p.variantId }], { paymentMethod: method });
      const order = await orderRow(placed.orderId);
      expect(order, method).toMatchObject({ customerId: null, paymentMethod: method, status: method === "cod" ? "new" : "awaiting_payment" });
      expect(order.guestContactId, method).toBeTruthy();
    }

    const owner = await customerWithWallet(1_000_000);
    const ownerPhone = (await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, owner)).get())!.phone;
    const token = await cartOf([{ variantId: p.variantId }]);
    const body = await checkoutBody(token, { paymentMethod: "wallet", phone: ownerPhone });
    const before = await counts();
    expect(await failureOf(placeOrder(t.db, shopper(token), body, NOW))).toMatchObject({ code: "wallet_requires_account", status: 403, fields: { paymentMethod: "wallet_requires_account" } });
    expect(await counts()).toEqual(before);
    expect(await getWalletBalance(t.db, owner)).toBe(1_000_000);
    expect(await getCartCount(t.db, { cartToken: token, customerId: null })).toBe(1);
  });

  test("marketing consent is recorded only when the shopper ticks it", async () => {
    const p = await stocked({ priceIqd: 30_000, qty: 4 });
    const off = await buy([{ variantId: p.variantId }], { marketingConsent: false });
    const on = await buy([{ variantId: p.variantId }], { marketingConsent: true, contactName: "زينب" });
    const offOrder = await orderRow(off.orderId);
    const onOrder = await orderRow(on.orderId);
    expect(offOrder.marketingConsent).toBe(false);
    expect(await t.db.select().from(consents).where(eq(consents.subjectId, offOrder.guestContactId as string))).toEqual([]);
    expect(onOrder.marketingConsent).toBe(true);
    expect(await t.db.select().from(consents).where(eq(consents.subjectId, onOrder.guestContactId as string))).toEqual([
      expect.objectContaining({ subjectType: "guest_contact", kind: "marketing", granted: true, source: "checkout" }),
    ]);
  });
});

// ───────────────────────────────────────────────────────────────── §4 / §14 shipping

describe("shipping — 5,000 IQD to every governorate unless overrides are switched on", () => {
  async function activeGovernorates() {
    return t.db.select({ id: governorates.id, slug: governorates.slug }).from(governorates).where(eq(governorates.isActive, true));
  }

  test("all 19 governorates: 5,000 IQD in the cart and on the placed order", async () => {
    const govs = await activeGovernorates();
    expect(govs).toHaveLength(19);
    const p = await stocked({ priceIqd: 99_999, qty: 25 });
    for (const gov of govs) {
      const token = await cartOf([{ variantId: p.variantId }]);
      const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: gov.id }, NOW);
      expect([view.shippingIqd, view.totalIqd], gov.slug).toEqual([5_000, 104_999]);
      const placed = await placeOrder(t.db, shopper(token), await checkoutBody(token, { governorateId: gov.id }), NOW);
      const order = await orderRow(placed.orderId);
      expect([order.shippingIqd, order.totalIqd, order.governorateId], gov.slug).toEqual([5_000, 104_999, gov.id]);
    }
  });

  test("override rows do nothing while the switch is off; switched on, only active governorate-wide override rows apply; a fee that changed before confirmation is refused", async () => {
    const govs = await activeGovernorates();
    const basra = governorateId("basra");
    const duhokDistrict = (await t.db.select({ id: districts.id }).from(districts).where(eq(districts.governorateId, governorateId("duhok"))).limit(1).get())?.id ?? null;
    const rowIds = { basra: newId("shr"), najaf: newId("shr"), kirkuk: newId("shr"), duhok: newId("shr"), all: newId("shr") };
    await t.db.insert(shippingRates).values([
      { id: rowIds.basra, governorateId: basra, feeIqd: 7_000, isOverride: true, isActive: true, updatedAt: NOW },
      { id: rowIds.najaf, governorateId: governorateId("najaf"), feeIqd: 2_000, isOverride: false, isActive: true, updatedAt: NOW },
      { id: rowIds.kirkuk, governorateId: governorateId("kirkuk"), feeIqd: 9_000, isOverride: true, isActive: false, updatedAt: NOW },
      { id: rowIds.duhok, governorateId: governorateId("duhok"), districtId: duhokDistrict, feeIqd: 1_000, isOverride: true, isActive: true, updatedAt: NOW },
    ]);
    const fees = async () => Object.fromEntries(await Promise.all(govs.map(async (gov) => [gov.slug, await getShippingFee(t.db, gov.id)] as const)));
    const p = await stocked({ priceIqd: 75_000, qty: 4 });
    try {
      expect(new Set(Object.values(await fees()))).toEqual(new Set([5_000]));

      // The shopper sees 5,000 to Basra; the admin switches overrides on before they confirm.
      const token = await cartOf([{ variantId: p.variantId }]);
      const body = await checkoutBody(token, { governorateId: basra });
      expect(body.expectedTotalIqd).toBe(80_000);
      await setSetting(t.db, SYSTEM, "shipping.overrides_enabled", true, "اختبار الرسوم الخاصة", NOW);
      const on = await fees();
      expect(on.basra).toBe(7_000);
      for (const [slug, fee] of Object.entries(on)) if (slug !== "basra") expect(fee, slug).toBe(5_000);

      const before = await counts();
      expect(await failureOf(placeOrder(t.db, shopper(token), body, NOW))).toMatchObject({ code: "totals_changed", status: 409 });
      expect(await counts()).toEqual(before);
      const placed = await placeOrder(t.db, shopper(token), { ...body, idempotencyKey: randomToken(), expectedTotalIqd: 82_000 }, NOW);
      expect(await orderRow(placed.orderId)).toMatchObject({ shippingIqd: 7_000, totalIqd: 82_000 });

      // An all-governorates override applies where no governorate row does; Basra keeps its own.
      await t.db.insert(shippingRates).values({ id: rowIds.all, governorateId: null, feeIqd: 6_000, isOverride: true, isActive: true, updatedAt: NOW });
      const all = await fees();
      expect(all.basra).toBe(7_000);
      for (const [slug, fee] of Object.entries(all)) if (slug !== "basra") expect(fee, slug).toBe(6_000);

      // Switched off again: 5,000 everywhere, whatever the rows say.
      await setSetting(t.db, SYSTEM, "shipping.overrides_enabled", false, "انتهى الاختبار", NOW);
      expect(new Set(Object.values(await fees()))).toEqual(new Set([5_000]));
    } finally {
      await setSetting(t.db, SYSTEM, "shipping.overrides_enabled", false, "إعادة الإعداد", NOW);
      await t.db.delete(shippingRates).where(inArray(shippingRates.id, Object.values(rowIds)));
    }
  });

  test("a governorate where delivery is paused is never priced or ordered to", async () => {
    const halabja = governorateId("halabja");
    const p = await stocked({ priceIqd: 40_000, qty: 2 });
    const token = await cartOf([{ variantId: p.variantId }]);
    const body = await checkoutBody(token, { governorateId: halabja });
    await t.db.update(governorates).set({ isActive: false }).where(eq(governorates.id, halabja));
    try {
      expect((await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: halabja }, NOW)).shippingIqd).toBeNull();
      const before = await counts();
      expect(await failureOf(placeOrder(t.db, shopper(token), body, NOW))).toMatchObject({ code: "shipping_unavailable", status: 409, fields: { governorateId: "shipping_unavailable" } });
      expect(await counts()).toEqual(before);
    } finally {
      await t.db.update(governorates).set({ isActive: true }).where(eq(governorates.id, halabja));
    }
  });
});

// ───────────────────────────────────────────────────────────────── §14 wallet

describe("wallet — debited only inside the order's batch; guests and other customers cannot reach it", () => {
  test("a balance one dinar short: no order, no debit, no hold, cart intact; with that dinar the debit is part of the order itself", async () => {
    const p = await stocked({ priceIqd: 200_000, qty: 2 });
    const total = 205_000;
    const customerId = await customerWithWallet(total - 1);
    const token = await cartOf([{ variantId: p.variantId }]);
    const body = await checkoutBody(token, { paymentMethod: "wallet" }, { customerId });
    const before = await counts();
    const level = await levelOf(p.variantId);
    expect(await failureOf(placeOrder(t.db, shopper(token, customerId), body, NOW))).toMatchObject({ code: "wallet_insufficient", status: 409 });
    expect(await counts()).toEqual(before);
    expect(await levelOf(p.variantId)).toEqual(level);
    expect(await getWalletBalance(t.db, customerId)).toBe(total - 1);
    expect(await getCartCount(t.db, { cartToken: token, customerId })).toBe(1);

    await creditWallet(t.db, SYSTEM, { customerId, amountIqd: 1, kind: "adjustment", reason: "الدينار الناقص", idempotencyKey: `adj-${customerId}` }, NOW);
    // The same idempotency key works: the failed attempt left nothing behind, not even the key.
    const placed = await placeOrder(t.db, shopper(token, customerId), body, NOW);
    expect(placed).toMatchObject({ paymentStatus: "paid", totalIqd: total, replayed: false });
    const debits = await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.kind, "purchase")));
    expect(debits).toEqual([expect.objectContaining({ amountIqd: -total, refType: "order", refId: placed.orderId, at: NOW })]);
    const payment = await paymentOf(placed.orderId);
    expect(payment).toMatchObject({ method: "wallet", status: "paid", amountIqd: total, walletLedgerId: debits[0].id });
    expect(await journalByKey(`payment:${payment.id}:received`)).toHaveLength(1);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: total, customerId });
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
  });

  test("two orders spending the same balance at the same moment: one debit, never an overdraft", async () => {
    const p = await stocked({ priceIqd: 300_000, qty: 4 });
    const customerId = await customerWithWallet(400_000);
    const tokens = [await cartOf([{ variantId: p.variantId }]), await cartOf([{ variantId: p.variantId }])];
    const bodies = await Promise.all(tokens.map((token) => checkoutBody(token, { paymentMethod: "wallet" }, { customerId })));
    const { ok, failed } = await settle(tokens.map((token, i) => placeOrder(t.db, shopper(token, customerId), bodies[i], NOW)));
    expect(ok).toHaveLength(1);
    expect(failed.map((error) => error.code)).toEqual(["wallet_insufficient"]);
    expect(await getWalletBalance(t.db, customerId)).toBe(95_000);
    expect(await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.kind, "purchase")))).toHaveLength(1);
    expect((await levelOf(p.variantId)).reserved).toBe(1);
  });

  test("racing for the last unit: the wallet order that loses is not charged", async () => {
    const p = await stocked({ priceIqd: 150_000, qty: 1 });
    const customerId = await customerWithWallet(1_000_000);
    const tokens = [await cartOf([{ variantId: p.variantId }]), await cartOf([{ variantId: p.variantId }])];
    const bodies = await Promise.all(tokens.map((token) => checkoutBody(token, { paymentMethod: "wallet" }, { customerId })));
    const { ok, failed } = await settle(tokens.map((token, i) => placeOrder(t.db, shopper(token, customerId), bodies[i], NOW)));
    expect(ok).toHaveLength(1);
    expect(failed.map((error) => error.code)).toEqual(["insufficient_stock"]);
    expect(await getWalletBalance(t.db, customerId)).toBe(1_000_000 - 155_000);
    expect(await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.kind, "purchase")))).toHaveLength(1);
  });

  test("a customer cannot reach another customer's wallet, orders, proofs, cart or idempotency key", async () => {
    const p = await stocked({ priceIqd: 100_000, qty: 10 });
    const alice = await customerWithWallet(500_000);
    const bob = await customerWithWallet(0);

    // Bob's wallet is Bob's: Alice's balance does not pay for him.
    const bobToken = await cartOf([{ variantId: p.variantId }]);
    expect(await failureOf(placeOrder(t.db, shopper(bobToken, bob), await checkoutBody(bobToken, { paymentMethod: "wallet" }, { customerId: bob }), NOW))).toMatchObject({ code: "wallet_insufficient" });
    expect(await getWalletBalance(t.db, alice)).toBe(500_000);

    const aliceWallet = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId: alice });
    const aliceTransfer = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" }, { customerId: alice });
    const bobOrder = await buy([{ variantId: p.variantId }], {}, { customerId: bob });

    expect(await getOrderForCustomer(t.db, bob, aliceWallet.ref, "ar", NOW)).toBeNull();
    expect(await getOrderForCustomer(t.db, alice, aliceWallet.ref, "ar", NOW)).not.toBeNull();
    expect(await getOrderByAccessToken(t.db, aliceWallet.ref, bobOrder.accessToken, "ar", NOW)).toBeNull();
    expect((await listOrdersForCustomer(t.db, bob, "ar")).items.map((row) => row.ref)).toEqual([bobOrder.ref]);
    expect((await listWalletEntries(t.db, bob)).items).toEqual([]);
    expect((await listWalletEntries(t.db, alice)).items.map((entry) => entry.orderRef)).toContain(aliceWallet.ref);

    // Proofs for Alice's transfer: Bob signed in, or holding his own confirmation token.
    const fileId = await proofFile();
    for (const who of [{ orderRef: aliceTransfer.ref, customerId: bob }, { orderRef: aliceTransfer.ref, accessToken: bobOrder.accessToken }, { orderRef: aliceTransfer.ref }]) {
      expect(await failureOf(submitPaymentProof(t.db, who, { fileId, declaredAmountIqd: aliceTransfer.totalIqd }, NOW))).toMatchObject({ code: "not_found", status: 404 });
    }
    expect(await t.db.select().from(paymentProofs).where(eq(paymentProofs.fileId, fileId))).toEqual([]);

    // Replaying Alice's idempotency key from Bob's session does not hand him her order.
    const replayToken = await cartOf([{ variantId: p.variantId }]);
    const ordersBefore = (await counts()).orders;
    expect(await failureOf(placeOrder(t.db, shopper(replayToken, bob), { ...aliceWallet.body }, NOW))).toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect((await counts()).orders).toBe(ordersBefore);

    // Alice's cart: Bob (or a guest) holding its cookie sees nothing of it and cannot change it.
    const aliceCart = (await addToCart(t.db, { cartToken: null, customerId: alice, locale: "ar" }, { variantId: p.variantId, qty: 2 }, NOW)).cartToken;
    const aliceLine = (await getCartView(t.db, { cartToken: aliceCart, customerId: alice, locale: "ar" }, NOW)).lines[0];
    expect(aliceLine).toBeTruthy();
    expect((await getCartView(t.db, { cartToken: aliceCart, customerId: bob, locale: "ar" }, NOW)).lines.map((line) => line.id)).not.toContain(aliceLine.id);
    expect((await getCartView(t.db, { cartToken: aliceCart, customerId: null, locale: "ar" }, NOW)).lines).toEqual([]);
    expect(await failureOf(setLineQty(t.db, { cartToken: aliceCart, customerId: bob }, aliceLine.id, 7, NOW))).toMatchObject({ code: "not_found" });
    await mergeGuestCart(t.db, { cartToken: aliceCart, customerId: bob }, NOW);
    const aliceAfter = await getCartView(t.db, { cartToken: aliceCart, customerId: alice, locale: "ar" }, NOW);
    expect(aliceAfter.lines.map((line) => [line.id, line.qty])).toEqual([[aliceLine.id, 2]]);
  });
});

// ───────────────────────────────────────────────────────────────── §14 manual transfers

describe("manual transfers — amount and proof required, a person approves", () => {
  test("a proof needs an amount and a private image of this order; until a person approves, the order is not paid — jobs, systems and the database refuse", async () => {
    const p = await stocked({ priceIqd: 754_000, qty: 2 });
    const placed = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" });
    const total = 759_000;
    expect(placed.totalIqd).toBe(total);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paidIqd: 0 });
    const payment = await paymentOf(placed.orderId);
    expect(payment).toMatchObject({ method: "bank_transfer", status: "pending" });
    const who = { orderRef: placed.ref, accessToken: placed.accessToken };

    const other = await buy([{ variantId: p.variantId }], { paymentMethod: "zaincash" });
    const attacks: { name: string; input: () => Promise<Record<string, unknown>>; code: string; field?: string }[] = [
      { name: "no amount", input: async () => ({ fileId: await proofFile() }), code: "invalid", field: "declaredAmountIqd" },
      { name: "zero amount", input: async () => ({ fileId: await proofFile(), declaredAmountIqd: 0 }), code: "invalid", field: "declaredAmountIqd" },
      { name: "an amount with fils", input: async () => ({ fileId: await proofFile(), declaredAmountIqd: 759_000.5 }), code: "invalid", field: "declaredAmountIqd" },
      { name: "no image", input: async () => ({ declaredAmountIqd: total }), code: "invalid", field: "fileId" },
      { name: "a public file", input: async () => ({ fileId: await proofFile({ visibility: "public" }), declaredAmountIqd: total }), code: "proof_file_invalid" },
      { name: "a PDF", input: async () => ({ fileId: await proofFile({ mime: "application/pdf" }), declaredAmountIqd: total }), code: "proof_file_invalid" },
      { name: "a product photo", input: async () => ({ fileId: await proofFile({ kind: "product_image" }), declaredAmountIqd: total }), code: "proof_file_invalid" },
      { name: "another order's proof file", input: async () => ({ fileId: await proofFile({ ownerType: "order", ownerId: other.orderId }), declaredAmountIqd: total }), code: "proof_file_invalid" },
      { name: "a deleted file", input: async () => ({ fileId: await proofFile({ deletedAt: NOW }), declaredAmountIqd: total }), code: "proof_file_invalid" },
    ];
    for (const attack of attacks) {
      const failure = await failureOf(submitPaymentProof(t.db, who, (await attack.input()) as never, NOW + MINUTE));
      expect(failure, attack.name).toMatchObject({ code: attack.code });
      if (attack.field) expect(failure.fields?.[attack.field], attack.name).toBeTruthy();
    }
    expect(await t.db.select().from(paymentProofs).where(eq(paymentProofs.paymentId, payment.id))).toEqual([]);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });

    // The jobs never approve anything.
    await runScheduledJobs(t.db, CRON_FREQUENT, NOW + HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "awaiting_payment", paidIqd: 0 });

    await submitPaymentProof(t.db, who, { fileId: await proofFile(), declaredAmountIqd: total, reference: "TRX-77120" }, NOW + 2 * HOUR);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "payment_review", paymentStatus: "pending_verification", paidIqd: 0 });
    // A proof under review waits for a person, however long it takes.
    await runScheduledJobs(t.db, CRON_FREQUENT, NOW + 3 * DAY);
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "payment_review", paidIqd: 0 });

    // The database refuses "paid" for a transfer without a named verifier.
    await expect(t.d1.prepare("UPDATE payments SET status = 'paid' WHERE id = ?").bind(payment.id).run()).rejects.toThrow("TT:PAYMENT_NOT_VERIFIED");
    // Nobody but an employee can verify: not the server itself, not a shopper.
    const customerId = await make.customer();
    for (const actor of [SYSTEM, { kind: "customer", id: customerId } as Actor, { kind: "guest" } as Actor]) {
      expect(await failureOf(verifyPayment(t.db, actor, payment.id, { approve: true }, NOW + 3 * DAY)), actor.kind).toMatchObject({ code: "forbidden", status: 403 });
    }
    expect(await paymentOf(placed.orderId)).toMatchObject({ status: "pending_verification", verifiedBy: null });
  });

  test("roles without orders.payment.verify cannot approve or reject (cashier, support, fulfillment, inventory, content); finance can", async () => {
    const p = await stocked({ priceIqd: 250_000, qty: 2 });
    const placed = await buy([{ variantId: p.variantId }], { paymentMethod: "zaincash" });
    await submitPaymentProof(t.db, { orderRef: placed.ref, accessToken: placed.accessToken }, { fileId: await proofFile(), declaredAmountIqd: placed.totalIqd }, NOW + MINUTE);
    const payment = await paymentOf(placed.orderId);
    for (const key of ["cashier", "support", "fulfillment", "inventory", "content"] as const) {
      expect(defaultRolePermissions(key).has("orders.payment.verify"), key).toBe(false);
      expect(await failureOf(verifyPayment(t.db, role(key), payment.id, { approve: true }, NOW + HOUR)), key).toMatchObject({ code: "forbidden", status: 403 });
      expect(await failureOf(verifyPayment(t.db, role(key), payment.id, { approve: false, note: "الصورة غير واضحة" }, NOW + HOUR)), key).toMatchObject({ code: "forbidden" });
    }
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "payment_review", paidIqd: 0 });
    expect(await verifyPayment(t.db, role("finance"), payment.id, { approve: true }, NOW + HOUR)).toMatchObject({ status: "paid", override: false });
    expect(await paymentOf(placed.orderId)).toMatchObject({ status: "paid", verifiedBy: staffIds.finance });
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: placed.totalIqd });
  });

  test("a declared amount that differs from what is due needs the override permission and a reason — also when the verifier types the due amount as received", async () => {
    const p = await stocked({ priceIqd: 754_000, qty: 3 });
    const placed = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" });
    const due = placed.totalIqd;
    await submitPaymentProof(t.db, { orderRef: placed.ref, accessToken: placed.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 10_000, note: "حولت المبلغ" }, NOW + MINUTE);
    const payment = await paymentOf(placed.orderId);
    const clerk = person("verifier", "orders.payment.verify");

    expect(await failureOf(verifyPayment(t.db, clerk, payment.id, { approve: true }, NOW + HOUR))).toMatchObject({ code: "amount_mismatch", status: 403 });
    // The shopper declared 10,000 IQD. Typing the due amount as "received" must not skip the override.
    expect(await failureOf(verifyPayment(t.db, clerk, payment.id, { approve: true, receivedAmountIqd: due }, NOW + HOUR))).toMatchObject({ code: "amount_mismatch", status: 403 });
    expect(await paymentOf(placed.orderId)).toMatchObject({ status: "pending_verification", verifiedBy: null });
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "payment_review", paidIqd: 0 });

    const senior = person("senior", "orders.payment.verify", "orders.payment.override");
    for (const note of [undefined, "", "   ", "ok"]) {
      expect(await failureOf(verifyPayment(t.db, senior, payment.id, { approve: true, receivedAmountIqd: due, note }, NOW + HOUR)), String(note)).toMatchObject({ code: "invalid", fields: { note: "override_reason_required" } });
    }
    const reason = "كشف البنك يُظهر وصول المبلغ كاملاً؛ الزبون كتب المبلغ خطأ";
    expect(await verifyPayment(t.db, senior, payment.id, { approve: true, receivedAmountIqd: due, note: reason }, NOW + HOUR)).toMatchObject({ status: "paid", override: true });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, payment.id), eq(auditEvents.action, "orders.payment.override")));
    expect(audit).toEqual([expect.objectContaining({ actorId: staffIds.senior, reason })]);

    // The other direction: the proof says the right amount, the statement shows less.
    const second = await buy([{ variantId: p.variantId }], { paymentMethod: "zaincash" });
    await submitPaymentProof(t.db, { orderRef: second.ref, accessToken: second.accessToken }, { fileId: await proofFile(), declaredAmountIqd: second.totalIqd }, NOW + MINUTE);
    const secondPayment = await paymentOf(second.orderId);
    expect(await failureOf(verifyPayment(t.db, clerk, secondPayment.id, { approve: true, receivedAmountIqd: second.totalIqd - 1_000 }, NOW + HOUR))).toMatchObject({ code: "amount_mismatch" });
    expect(await verifyPayment(t.db, clerk, secondPayment.id, { approve: true, receivedAmountIqd: second.totalIqd }, NOW + HOUR)).toMatchObject({ status: "paid", override: false });
  });
});

// ───────────────────────────────────────────────────────────────── §9 / §14 integrity

describe("integrity — serials, stock, refunds, retries", () => {
  test("a serial is attached once, even when two packers scan it at the same moment", async () => {
    const p = await stocked({ trackSerials: true, qty: 2, priceIqd: 500_000 });
    const [serialId] = p.serialIds;
    const first = await make.order([{ variantId: p.variantId, sku: p.sku }]);
    const second = await make.order([{ variantId: p.variantId, sku: p.sku }]);
    const { ok, failed } = await settle([first, second].map((order) => runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: order.itemIds[0], serialIds: [serialId], actor: SYSTEM, now: NOW }))));
    expect(ok).toHaveLength(1);
    expect(failed.map((error) => error.code)).toEqual(["serial_not_available"]);
    const third = await make.order([{ variantId: p.variantId, sku: p.sku }]);
    expect(await failureOf(runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: third.itemIds[0], serialIds: [serialId], actor: SYSTEM, now: NOW })))).toMatchObject({ code: "serial_not_available" });
    expect(await t.db.select().from(orderItemSerials).where(and(eq(orderItemSerials.serialId, serialId), isNull(orderItemSerials.releasedAt)))).toHaveLength(1);
  });

  test("a used device's serial goes out with that device only: never packed into another order, held or listed", async () => {
    const p = await stocked({ trackSerials: true, qty: 1, priceIqd: 600_000 });
    const held = await listedUsedUnit(p.variantId, { priceIqd: 420_000, costIqd: 300_000 });
    const listed = await listedUsedUnit(p.variantId, { priceIqd: 410_000, costIqd: 290_000 });
    const usedOrder = await buy([{ usedUnitId: held.unitId }]);
    expect((await t.db.select().from(serials).where(eq(serials.id, held.serialId)).get())?.status).toBe("reserved");

    // A new console of the same model is sold to someone else; the packer scans the wrong box.
    const newOrder = await buy([{ variantId: p.variantId }]);
    const [newLine] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, newOrder.orderId));
    for (const serialId of [held.serialId, listed.serialId]) {
      expect(await failureOf(runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: newLine.id, serialIds: [serialId], actor: SYSTEM, now: NOW }))), serialId).toMatchObject({ code: "serial_not_available" });
    }
    expect((await t.db.select().from(serials).where(eq(serials.id, held.serialId)).get())?.status).toBe("reserved");
    expect((await t.db.select().from(serials).where(eq(serials.id, listed.serialId)).get())?.status).toBe("in_stock");

    // The right serials go where they belong, and both orders ship.
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: newLine.id, serialIds: [p.serialIds[0]], actor: SYSTEM, now: NOW }));
    const [usedLine] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, usedOrder.orderId));
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: usedLine.id, serialIds: [held.serialId], actor: SYSTEM, now: NOW }));
    for (const orderId of [newOrder.orderId, usedOrder.orderId]) {
      await transitionOrder(t.db, ops(), orderId, "confirmed", {}, NOW + MINUTE);
      await transitionOrder(t.db, ops(), orderId, "shipped", {}, NOW + 2 * MINUTE);
    }
    expect(await t.db.select({ serialId: orderItemSerials.serialId }).from(orderItemSerials).where(eq(orderItemSerials.orderItemId, usedLine.id))).toEqual([{ serialId: held.serialId }]);
    expect(await t.db.select({ serialId: orderItemSerials.serialId }).from(orderItemSerials).where(eq(orderItemSerials.orderItemId, newLine.id))).toEqual([{ serialId: p.serialIds[0] }]);
  });

  test("one used device, two shoppers checking out at the same moment: one order holds it, the other is told it is gone", async () => {
    const p = await stocked({ trackSerials: true, qty: 0, priceIqd: 650_000 });
    const device = await listedUsedUnit(p.variantId, { priceIqd: 470_000 });
    const tokens = [await cartOf([{ usedUnitId: device.unitId }]), await cartOf([{ usedUnitId: device.unitId }])];
    const bodies = await Promise.all(tokens.map((token) => checkoutBody(token)));
    const { ok, failed } = await settle(tokens.map((token, i) => placeOrder(t.db, shopper(token), bodies[i], NOW)));
    expect(ok).toHaveLength(1);
    expect(failed.map((error) => error.code)).toEqual(["used_unit_not_available"]);
    expect(await t.db.select().from(orderItems).where(eq(orderItems.usedUnitId, device.unitId))).toHaveLength(1);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, device.unitId)).get())?.status).toBe("reserved");
    // The loser's cart still holds the line, now marked unavailable, and it blocks checkout.
    const views = await Promise.all(tokens.map((token) => getCartView(t.db, { cartToken: token, customerId: null, locale: "ar" }, NOW)));
    const open = views.filter((view) => view.lines.length > 0);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ blocked: true, lines: [expect.objectContaining({ usedUnitId: device.unitId, problem: "unavailable" })] });
  });

  test("available stock cannot go below zero without the oversell permission — not even when an order lands between an adjustment's read and its write", async () => {
    const p = await stocked({ qty: 5, priceIqd: 80_000, unitCostIqd: 50_000 });
    const clerk = person("clerk", "inventory.stock.adjust");
    const boss = person("boss", "inventory.stock.adjust", "inventory.oversell.authorize");
    const removal = { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, delta: -1, reason: "علبة تالفة", kind: "damage" as const };
    await buy([{ variantId: p.variantId, qty: 5 }]); // every unit is promised

    expect(await failureOf(adjustStock(t.db, clerk, removal, NOW))).toMatchObject({ code: "insufficient_stock" });
    expect(await failureOf(adjustStock(t.db, clerk, { ...removal, allowOversell: true }, NOW))).toMatchObject({ code: "forbidden", detail: "inventory.oversell.authorize" });
    // An authorised oversell (a promised unit broke) …
    await adjustStock(t.db, boss, { ...removal, reason: "سقطت وحدة محجوزة وانكسرت", allowOversell: true }, NOW);
    expect(await levelOf(p.variantId)).toMatchObject({ onHand: 4, reserved: 5 });
    // … then the shelf is refilled: 3 free units again.
    await receiveStock(t.db, SYSTEM, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qty: 4, unitCostIqd: 52_000, ref: "refill" }, NOW);
    expect(await levelOf(p.variantId)).toMatchObject({ onHand: 8, reserved: 5 });

    // A clerk removes 2 of the 3 free units; a shopper's order for 2 lands between the clerk's read and write.
    const token = await cartOf([{ variantId: p.variantId, qty: 2 }]);
    const body = await checkoutBody(token);
    const race = interleave(t.db, { call: 1, when: "after" }, () => placeOrder(t.db, shopper(token), body, NOW));
    const outcome = await failureOf(adjustStock(race.db, clerk, { ...removal, delta: -2, reason: "جرد: وحدتان مفقودتان", kind: "adjust" }, NOW));
    expect(race.outcome()).toMatchObject({ ok: true });
    expect(outcome).toMatchObject({ code: "insufficient_stock" });
    const level = await levelOf(p.variantId);
    expect(level.onHand - level.reserved).toBeGreaterThanOrEqual(0);
    expect(level).toMatchObject({ onHand: 8, reserved: 7 });
  });

  test("no double refund: twice at once, a second one after the first, a new one beside a pending one, two approvers at once, one line twice", async () => {
    const p = await stocked({ priceIqd: 250_000, qty: 10 });
    const customerId = await customerWithWallet(5_000_000);
    const total = 255_000;

    // (a) Within the owner's threshold refunds are issued at once — two full refunds fired together.
    await setSetting(t.db, SYSTEM, "refunds.approval_threshold_iqd", 10_000_000, "اختبار الاسترداد الفوري", NOW);
    try {
      const order = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
      const payment = await paymentOf(order.orderId);
      const refunder = person("requester", "orders.refund.create");
      const { ok, failed } = await settle([1, 2].map((n) => createRefund(t.db, refunder, { orderId: order.orderId, paymentId: payment.id, amountIqd: total, method: "wallet", reason: `استرداد كامل ${n}` }, NOW)));
      expect(ok).toHaveLength(1);
      expect(failed.map((error) => error.code)).toEqual(["refund_exceeds_payment"]);
      expect(await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.kind, "refund")))).toEqual([expect.objectContaining({ amountIqd: total })]);
      expect(await orderRow(order.orderId)).toMatchObject({ refundedIqd: total, paymentStatus: "refunded" });
      // One more dinar afterwards, by any method.
      for (const method of ["cash", "wallet", "original"] as const) {
        expect(await failureOf(createRefund(t.db, refunder, { orderId: order.orderId, paymentId: payment.id, amountIqd: 1, method, reason: "دينار إضافي" }, NOW)), method).toMatchObject({ code: "refund_exceeds_payment" });
      }
    } finally {
      await setSetting(t.db, SYSTEM, "refunds.approval_threshold_iqd", 0, "إعادة الإعداد", NOW);
    }

    // (b) Above the threshold: a pending refund already counts; two approvers deciding at once issue it once.
    const order = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
    const payment = await paymentOf(order.orderId);
    const requester = person("requester", "orders.refund.create", "orders.refund.approve");
    const pending = await createRefund(t.db, requester, { orderId: order.orderId, paymentId: payment.id, amountIqd: total, method: "wallet", reason: "إرجاع كامل" }, NOW);
    expect(pending.status).toBe("pending");
    expect(await failureOf(createRefund(t.db, requester, { orderId: order.orderId, paymentId: payment.id, amountIqd: 1_000, method: "cash", reason: "استرداد آخر" }, NOW))).toMatchObject({ code: "refund_exceeds_payment" });
    const decisions = await settle([
      approveRefund(t.db, person("approver", "orders.refund.approve"), pending.refundId, { approve: true }, NOW + MINUTE),
      approveRefund(t.db, person("approver2", "orders.refund.approve"), pending.refundId, { approve: true }, NOW + MINUTE),
    ]);
    expect(decisions.ok.length).toBeGreaterThanOrEqual(1);
    for (const error of decisions.failed) expect(error.code).toBe("refund_not_pending");
    expect(await t.db.select().from(walletLedger).where(and(eq(walletLedger.refType, "refund"), eq(walletLedger.refId, pending.refundId)))).toHaveLength(1);
    expect(await journalByKey(`refund:${pending.refundId}`)).toHaveLength(1);
    expect(await orderRow(order.orderId)).toMatchObject({ refundedIqd: total });

    // (c) The same unit of a line refunded twice at the same moment (small amounts, so only the quantity can stop it).
    const third = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
    const [line] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, third.orderId));
    const thirdPayment = await paymentOf(third.orderId);
    const lineRefunds = await settle(
      [1, 2].map((n) => createRefund(t.db, requester, { orderId: third.orderId, paymentId: thirdPayment.id, items: [{ orderItemId: line.id, qty: 1 }], amountIqd: 1_000, method: "wallet", reason: `قطعة واحدة ${n}` }, NOW)),
    );
    expect(lineRefunds.ok).toHaveLength(1);
    expect(lineRefunds.failed.map((error) => error.code)).toEqual(["refund_qty_exceeds"]);
  });

  test("a refund is never approved by the person who requested it — including the one a cancellation opens", async () => {
    const p = await stocked({ priceIqd: 180_000, qty: 4 });
    const customerId = await customerWithWallet(2_000_000);
    const requester = person("requester", "orders.refund.create", "orders.refund.approve", "orders.order.cancel");

    const order = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
    const payment = await paymentOf(order.orderId);
    const pending = await createRefund(t.db, requester, { orderId: order.orderId, paymentId: payment.id, amountIqd: 50_000, method: "wallet", reason: "تعويض تأخير" }, NOW);
    expect(await failureOf(approveRefund(t.db, requester, pending.refundId, { approve: true }, NOW))).toMatchObject({ code: "approver_is_requester", status: 403 });
    expect(await failureOf(approveRefund(t.db, requester, pending.refundId, { approve: false, note: "تراجعت" }, NOW))).toMatchObject({ code: "approver_is_requester" });
    expect((await t.db.select().from(refunds).where(eq(refunds.id, pending.refundId)).get())?.status).toBe("pending");

    // Cancelling a paid order opens a refund in the canceller's name: the canceller cannot issue it either.
    const cancelled = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
    await transitionOrder(t.db, requester, cancelled.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW + MINUTE);
    const opened = await t.db.select().from(refunds).where(eq(refunds.orderId, cancelled.orderId));
    expect(opened).toEqual([expect.objectContaining({ status: "pending", createdBy: staffIds.requester, amountIqd: cancelled.totalIqd })]);
    expect(await failureOf(approveRefund(t.db, requester, opened[0].id, { approve: true }, NOW + 2 * MINUTE))).toMatchObject({ code: "approver_is_requester" });
    expect(await approveRefund(t.db, person("approver", "orders.refund.approve"), opened[0].id, { approve: true }, NOW + 2 * MINUTE)).toEqual({ status: "paid" });
  });

  test("retries never duplicate an order or a payment: the same key six times at once, a wallet order four times at once, three keys for one cart", async () => {
    const a = await stocked({ priceIqd: 70_000, qty: 20 });
    const b = await stocked({ priceIqd: 33_333, qty: 20 });
    const used = await listedUsedUnit(a.variantId, { priceIqd: 55_000 });
    const coupon = await couponRow({ kind: "fixed", value: 10_000, usageLimit: 5 });
    const token = await cartOf([{ variantId: a.variantId, qty: 2 }, { variantId: b.variantId, qty: 3 }, { usedUnitId: used.unitId }]);
    await applyCoupon(t.db, { cartToken: token, customerId: null }, coupon.code, NOW);
    const body = await checkoutBody(token);
    const before = await counts();
    const results = await Promise.all(Array.from({ length: 6 }, () => placeOrder(t.db, shopper(token), body, NOW)));
    expect(new Set(results.map((result) => `${result.orderId}|${result.ref}|${result.accessToken}|${result.totalIqd}`)).size).toBe(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    const after = await counts();
    expect(after.orders - before.orders).toBe(1);
    expect(after.payments - before.payments).toBe(1);
    expect(after.coupon_redemptions - before.coupon_redemptions).toBe(1);
    expect(after.guest_contacts - before.guest_contacts).toBe(1);
    expect(await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, results[0].orderId))).toHaveLength(2);
    expect((await levelOf(a.variantId)).reserved).toBe(2);
    expect((await levelOf(b.variantId)).reserved).toBe(3);
    // A later retry still answers with the first order; someone else's session does not.
    expect(await placeOrder(t.db, shopper(token), body, NOW + MINUTE)).toMatchObject({ orderId: results[0].orderId, replayed: true });
    expect(await failureOf(placeOrder(t.db, shopper(await cartOf([{ variantId: a.variantId }])), body, NOW + MINUTE))).toMatchObject({ code: "idempotency_conflict" });

    // Wallet: four submissions with one key debit once.
    const customerId = await customerWithWallet(1_000_000);
    const walletToken = await cartOf([{ variantId: b.variantId, qty: 2 }]);
    const walletBody = await checkoutBody(walletToken, { paymentMethod: "wallet" }, { customerId });
    const walletResults = await Promise.all(Array.from({ length: 4 }, () => placeOrder(t.db, shopper(walletToken, customerId), walletBody, NOW)));
    expect(new Set(walletResults.map((result) => result.orderId)).size).toBe(1);
    expect(await t.db.select().from(walletLedger).where(and(eq(walletLedger.customerId, customerId), eq(walletLedger.kind, "purchase")))).toHaveLength(1);
    expect(await getWalletBalance(t.db, customerId)).toBe(1_000_000 - walletBody.expectedTotalIqd);

    // Three different keys for one cart (two tabs and a double click): one order.
    const shared = await cartOf([{ variantId: a.variantId }]);
    const sharedBody = await checkoutBody(shared);
    const { ok, failed } = await settle([0, 1, 2].map(() => placeOrder(t.db, shopper(shared), { ...sharedBody, idempotencyKey: randomToken() }, NOW)));
    expect(ok).toHaveLength(1);
    for (const error of failed) expect(["cart_changed", "cart_empty"]).toContain(error.code);
  });

  test("payment steps repeated at the same moment apply once: proofs, verification, cash collection, wallet credits, refunds by key", async () => {
    const p = await stocked({ priceIqd: 120_000, qty: 12 });

    // Proofs: the same file three times, then three different files.
    const sameFile = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" });
    const fileId = await proofFile();
    const sameFileResults = await settle([0, 1, 2].map(() => submitPaymentProof(t.db, { orderRef: sameFile.ref, accessToken: sameFile.accessToken }, { fileId, declaredAmountIqd: sameFile.totalIqd }, NOW + MINUTE)));
    expect(sameFileResults.ok).toHaveLength(1);
    for (const error of sameFileResults.failed) expect(["proof_file_invalid", "proof_not_expected"]).toContain(error.code);
    const threeFiles = await buy([{ variantId: p.variantId }], { paymentMethod: "zaincash" });
    const threeResults = await settle(
      [0, 1, 2].map(async () => submitPaymentProof(t.db, { orderRef: threeFiles.ref, accessToken: threeFiles.accessToken }, { fileId: await proofFile(), declaredAmountIqd: threeFiles.totalIqd }, NOW + MINUTE)),
    );
    expect(threeResults.ok).toHaveLength(1);
    for (const error of threeResults.failed) expect(error.code).toBe("proof_not_expected");
    for (const order of [sameFile, threeFiles]) {
      const payment = await paymentOf(order.orderId);
      expect(await t.db.select().from(paymentProofs).where(eq(paymentProofs.paymentId, payment.id))).toHaveLength(1);
    }

    // Verification by three people at once: paid once, booked once.
    const payment = await paymentOf(sameFile.orderId);
    const verified = await settle(["finance", "finance2", "finance3"].map((name) => verifyPayment(t.db, person(name, "orders.payment.verify"), payment.id, { approve: true }, NOW + HOUR)));
    expect(verified.ok.length).toBeGreaterThanOrEqual(1);
    for (const error of verified.failed) expect(error.code).toBe("payment_not_pending");
    expect(await orderRow(sameFile.orderId)).toMatchObject({ status: "confirmed", paidIqd: sameFile.totalIqd });
    expect(await journalByKey(`payment:${payment.id}:received`)).toHaveLength(1);
    expect(await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, sameFile.orderId), eq(orderEvents.kind, "payment_verified")))).toHaveLength(1);

    // Cash on delivery recorded three times at once.
    const cod = await buy([{ variantId: p.variantId }]);
    await transitionOrder(t.db, ops(), cod.orderId, "confirmed", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), cod.orderId, "shipped", {}, NOW + 2 * MINUTE);
    const collected = await settle([0, 1, 2].map(() => recordCodCollection(t.db, ops(), cod.orderId, cod.totalIqd, NOW + HOUR)));
    expect(collected.ok.length).toBeGreaterThanOrEqual(1);
    for (const error of collected.failed) expect(error.code).toBe("payment_already_recorded");
    const codPayment = await paymentOf(cod.orderId);
    expect(await orderRow(cod.orderId)).toMatchObject({ paidIqd: cod.totalIqd, paymentStatus: "paid" });
    expect(await journalByKey(`payment:${codPayment.id}:received`)).toHaveLength(1);

    // A wallet credit and a refund repeated with the same key.
    const customerId = await customerWithWallet(0);
    const credit = { customerId, amountIqd: 75_000, kind: "topup" as const, reason: "حوالة شحن رصيد", idempotencyKey: `credit-${customerId}` };
    const credits = await Promise.all([0, 1, 2].map(() => creditWallet(t.db, SYSTEM, credit, NOW)));
    expect(new Set(credits.map((result) => result.entryId)).size).toBe(1);
    expect(await getWalletBalance(t.db, customerId)).toBe(75_000);
    const paid = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId: await customerWithWallet(1_000_000) });
    const paidPayment = await paymentOf(paid.orderId);
    const refundInput = { orderId: paid.orderId, paymentId: paidPayment.id, amountIqd: 20_000, method: "wallet" as const, reason: "تعويض", idempotencyKey: `refund-${paid.orderId}` };
    const refundResults = await Promise.all([0, 1, 2].map(() => createRefund(t.db, person("requester", "orders.refund.create"), refundInput, NOW)));
    expect(new Set(refundResults.map((result) => result.refundId)).size).toBe(1);
    expect(await t.db.select().from(refunds).where(eq(refunds.orderId, paid.orderId))).toHaveLength(1);
  });

  test("a single-use coupon used by three orders at the same moment is redeemed once", async () => {
    const p = await stocked({ priceIqd: 110_000, qty: 6 });
    const coupon = await couponRow({ kind: "fixed", value: 15_000, usageLimit: 1 });
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      const token = await cartOf([{ variantId: p.variantId }]);
      await applyCoupon(t.db, { cartToken: token, customerId: null }, coupon.code, NOW);
      tokens.push(token);
    }
    const bodies = await Promise.all(tokens.map((token) => checkoutBody(token)));
    for (const body of bodies) expect(body.expectedTotalIqd).toBe(100_000);
    const { ok, failed } = await settle(tokens.map((token, i) => placeOrder(t.db, shopper(token), bodies[i], NOW)));
    expect(ok).toHaveLength(1);
    for (const error of failed) expect(["coupon_usage_limit", "totals_changed"]).toContain(error.code);
    expect(await t.db.select().from(couponRedemptions).where(eq(couponRedemptions.couponId, coupon.id))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── §9 / §14 money

describe("money — whole dinars only, totals reconcile", () => {
  test("computeTotals: thousands of random and hostile inputs give whole dinars that add up, or a TotalsError — never NaN, Infinity or fractions", () => {
    const r = prng(0x51ab1e);
    const HOSTILE: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0.5, 1e300, Number.MAX_SAFE_INTEGER, 2 ** 53, -0, "5000", null, undefined, 1e-9];
    let refused = 0;
    for (let i = 0; i < 6_000; i++) {
      const lines: { unitPriceIqd: unknown; qty: unknown }[] = Array.from({ length: r.int(0, 15) }, () => ({ unitPriceIqd: r.int(0, 50_000_000), qty: r.int(1, 10) }));
      const subtotal = lines.reduce((sum, line) => sum + (line.unitPriceIqd as number) * (line.qty as number), 0);
      const input: { lines: typeof lines; discountIqd: unknown; shippingIqd: unknown } = { lines, discountIqd: r.int(0, subtotal), shippingIqd: r.pick([0, 5_000, r.int(0, 100_000)]) };
      if (r.next() < 0.5) {
        const hostile = r.pick(HOSTILE);
        const target = r.int(0, 4);
        if (target === 0 && lines.length) lines[r.int(0, lines.length - 1)].unitPriceIqd = hostile;
        else if (target === 1 && lines.length) lines[r.int(0, lines.length - 1)].qty = hostile;
        else if (target === 2) input.discountIqd = hostile;
        else if (target === 3) input.shippingIqd = hostile;
        else input.discountIqd = subtotal + r.int(1, 1_000);
      }
      let totals: ReturnType<typeof computeTotals>;
      try {
        totals = computeTotals(input as Parameters<typeof computeTotals>[0]);
      } catch (error) {
        expect(error, `case ${i}`).toBeInstanceOf(TotalsError);
        refused++;
        continue;
      }
      for (const value of Object.values(totals)) expect(Number.isSafeInteger(value) && value >= 0, `case ${i}: ${value}`).toBe(true);
      const lineSum = lines.reduce((sum, line) => sum + (line.unitPriceIqd as number) * (line.qty as number), 0);
      expect(totals.subtotalIqd === lineSum, `case ${i}`).toBe(true);
      expect(totals.discountIqd <= totals.subtotalIqd, `case ${i}`).toBe(true);
      expect(totals.totalIqd === totals.subtotalIqd - totals.discountIqd + totals.shippingIqd, `case ${i}`).toBe(true);
    }
    expect(refused).toBeGreaterThan(1_000); // the hostile half really was hostile
  });

  test(
    "randomised carts: every cart view and every placed order is whole dinars and reconciles line by line",
    async () => {
      const r = prng(0x7a3a3);
      const pool: Awaited<ReturnType<typeof stocked>>[] = [];
      for (let i = 0; i < 10; i++) {
        const priceIqd = r.pick([r.int(1, 9_999), r.int(10_000, 999_999), r.int(1_000_000, 4_999_999), 250 * r.int(1, 4_000), 333_333]);
        pool.push(await stocked({ priceIqd, qty: 50_000, unitCostIqd: Math.floor(priceIqd * 0.7) }));
      }
      const codes = [
        (await couponRow({ kind: "fixed", value: 25_000, minSubtotalIqd: 100_000 })).code,
        (await couponRow({ kind: "percent", value: 1_250 })).code,
        (await couponRow({ kind: "percent", value: 3_333, maxDiscountIqd: 77_777 })).code,
        (await couponRow({ kind: "percent", value: 10_000 })).code, // 100 %: only the delivery is paid
        (await couponRow({ kind: "fixed", value: 999_999_999 })).code, // more than any cart: capped at the subtotal
        (await couponRow({ kind: "percent", value: 1 })).code, // 0.01 %: rounds to whole dinars
      ];
      const govs = await t.db.select({ id: governorates.id }).from(governorates).where(eq(governorates.isActive, true));
      const ints = (label: string, values: (number | null)[]) => {
        for (const value of values) expect(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, `${label}: ${String(value)}`).toBe(true);
      };

      // 300 random carts priced through the real services; every third is checked out (100 orders,
      // all four payment methods). A wallet case funds its own customer with exactly the total.
      const CASES = 300;
      const specs = Array.from({ length: CASES }, (_, i) => ({
        label: `case ${i}`,
        place: i % 3 === 0,
        lines: [...pool]
          .sort(() => r.next() - 0.5)
          .slice(0, r.int(1, 4))
          .map((product) => ({ variantId: product.variantId, qty: r.int(1, 10), priceIqd: product.priceIqd })),
        coupon: r.next() < 0.6 ? r.pick(codes) : null,
        governorate: r.pick(govs).id,
        method: r.pick(["cod", "cod", "bank_transfer", "zaincash", "wallet"] as const),
      }));
      for (const spec of specs) await runCase(spec);

      async function runCase({ label, place, lines, coupon, governorate, method }: (typeof specs)[number]) {
        const token = await rawCart(lines, coupon);
        const view: CartViewData = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: governorate }, NOW);
        if (coupon) expect(view.coupon !== null || view.couponIssue?.reason === "min_subtotal", label).toBe(true);
        ints(label, [view.subtotalIqd, view.discountIqd, view.shippingIqd, view.totalIqd, ...view.lines.flatMap((line) => [line.unitPriceIqd, line.qty, line.lineTotalIqd, line.maxQty])]);
        for (const line of view.lines) expect(line.lineTotalIqd, label).toBe(line.unitPriceIqd * line.qty);
        expect(view.subtotalIqd, label).toBe(view.lines.reduce((sum, line) => sum + line.lineTotalIqd, 0));
        expect(view.discountIqd <= view.subtotalIqd, label).toBe(true);
        expect(view.shippingIqd, label).toBe(5_000);
        expect(view.totalIqd, label).toBe(view.subtotalIqd - view.discountIqd + 5_000);
        if (!place) return;

        let customerId: string | null = null;
        if (method === "wallet") {
          customerId = await make.customer();
          for (let funded = 0, n = 0; funded < view.totalIqd; funded += 100_000_000, n++) {
            await creditWallet(t.db, SYSTEM, { customerId, amountIqd: Math.min(100_000_000, view.totalIqd - funded), kind: "topup", reason: "شحن للاختبار", idempotencyKey: `fund-${n}-${customerId}` }, NOW);
          }
        }
        const placed = await placeOrder(
          t.db,
          shopper(token, customerId),
          { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorate, areaText: "حي الجامعة", addressText: "شارع الربيع، دار 12", paymentMethod: method, expectedTotalIqd: view.totalIqd },
          NOW,
        );
        expect(placed.totalIqd, label).toBe(view.totalIqd);
        const order = await orderRow(placed.orderId);
        const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, placed.orderId));
        const payment = await paymentOf(placed.orderId);
        ints(label, [order.subtotalIqd, order.discountIqd, order.shippingIqd, order.taxIqd, order.totalIqd, order.paidIqd, order.refundedIqd, payment.amountIqd, ...items.flatMap((item) => [item.unitPriceIqd, item.qty, item.totalIqd, item.discountIqd])]);
        expect([order.subtotalIqd, order.discountIqd, order.shippingIqd, order.totalIqd], label).toEqual([view.subtotalIqd, view.discountIqd, 5_000, view.totalIqd]);
        expect(order.subtotalIqd, label).toBe(items.reduce((sum, item) => sum + item.totalIqd, 0));
        for (const item of items) expect(item.totalIqd, label).toBe(item.unitPriceIqd * item.qty);
        expect(payment.amountIqd, label).toBe(order.totalIqd);
        const redemption = await t.db.select().from(couponRedemptions).where(eq(couponRedemptions.orderId, placed.orderId)).get();
        expect(redemption?.amountIqd ?? 0, label).toBe(order.discountIqd);
        if (customerId) {
          const debit = await t.db.select().from(walletLedger).where(and(eq(walletLedger.refType, "order"), eq(walletLedger.refId, placed.orderId))).get();
          expect(debit?.amountIqd, label).toBe(-order.totalIqd);
          expect(order.paidIqd, label).toBe(order.totalIqd);
          expect(await getWalletBalance(t.db, customerId), label).toBe(0);
        }
      }
    },
    240_000,
  );
});

// ───────────────────────────────────────────────────────────────── §7.8 append-only history

describe("append-only history", () => {
  test("rows written by a real order refuse UPDATE and DELETE: audit, stock movements, wallet ledger, order events, consents, journal, seals", async () => {
    const p = await stocked({ priceIqd: 210_000, qty: 3, unitCostIqd: 140_000 });
    const customerId = await customerWithWallet(1_000_000);
    const order = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet", marketingConsent: true }, { customerId });
    await transitionOrder(t.db, ops(), order.orderId, "shipped", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), order.orderId, "delivered", {}, NOW + 2 * MINUTE);
    let sealed = await sealAudit(t.db, NOW + 3 * MINUTE);
    while (sealed.remaining) sealed = await sealAudit(t.db, NOW + 3 * MINUTE);

    const one = async (query: string, ...params: unknown[]) => {
      const row = await t.d1.prepare(query).bind(...params).first<{ id: string }>();
      if (!row) throw new Error(`no row for ${query}`);
      return row.id;
    };
    const targets: [table: string, id: string, column: string, value: unknown][] = [
      ["audit_events", await one("SELECT id FROM audit_events WHERE entity_id = ? ORDER BY seq LIMIT 1", order.orderId), "reason", "تعديل"],
      ["stock_movements", await one("SELECT id FROM stock_movements WHERE ref_id = ? AND kind = 'sale' LIMIT 1", order.orderId), "unit_cost_iqd", 1],
      ["wallet_ledger", await one("SELECT id FROM wallet_ledger WHERE ref_id = ? LIMIT 1", order.orderId), "amount_iqd", 0],
      ["order_events", await one("SELECT id FROM order_events WHERE order_id = ? LIMIT 1", order.orderId), "kind", "nothing_happened"],
      ["consents", await one("SELECT id FROM consents WHERE subject_id = ? LIMIT 1", customerId), "granted", 0],
      ["journal_entries", await one("SELECT id FROM journal_entries WHERE ref_id = ? LIMIT 1", order.orderId), "memo", "edited"],
      ["journal_lines", await one("SELECT l.id FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.ref_id = ? LIMIT 1", order.orderId), "debit_iqd", 1],
      ["audit_seals", await one("SELECT id FROM audit_seals ORDER BY to_seq DESC LIMIT 1"), "hash", "0".repeat(64)],
    ];
    for (const [table, id, column, value] of targets) {
      const before = await t.d1.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      await expect(t.d1.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`).bind(value, id).run(), `UPDATE ${table}`).rejects.toThrow(`TT:IMMUTABLE:${table}`);
      await expect(t.d1.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run(), `DELETE ${table}`).rejects.toThrow(`TT:IMMUTABLE:${table}`);
      expect(await t.d1.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(), table).toEqual(before);
    }
  });

  test("a posted journal entry takes no extra line, and an unbalanced entry leaves nothing behind", async () => {
    const entry = await t.db.select().from(journalEntries).limit(1).get();
    expect(entry).toBeTruthy();
    expect(await failureOf(t.db.insert(journalLines).values({ id: newId("jl"), entryId: entry!.id, accountId: accountId("cash"), debitIqd: 1_000_000, creditIqd: 0 }))).toMatchObject({ code: "journal_sealed" });
    const id = newId("je");
    const linesBefore = (await counts()).journal_lines;
    const failure = await failureOf(
      runBatch(t.db, [
        t.db.insert(journalLines).values({ id: `${id}.1`, entryId: id, accountId: accountId("cash"), debitIqd: 100_000, creditIqd: 0 }),
        t.db.insert(journalLines).values({ id: `${id}.2`, entryId: id, accountId: accountId("sales_revenue"), debitIqd: 0, creditIqd: 99_999 }),
        t.db.insert(journalEntries).values({ id, at: NOW, period: "2026-11", memo: "غير متوازن" }),
      ]),
    );
    expect(failure).toMatchObject({ code: "journal_unbalanced" });
    expect((await counts()).journal_lines).toBe(linesBefore);
  });

  test("an audit event rewritten behind the triggers' back (guard dropped, then INSERT OR REPLACE) is caught by the hash chain", async () => {
    let sealed = await sealAudit(t.db, NOW + HOUR);
    while (sealed.remaining) sealed = await sealAudit(t.db, NOW + HOUR);
    expect((await verifyAuditChain(t.db)).ok).toBe(true);
    const victim = await t.d1.prepare("SELECT * FROM audit_events WHERE seq <= ? AND action = 'orders.order.place' ORDER BY seq DESC LIMIT 1").bind(sealed.lastSealedSeq).first<Record<string, unknown>>();
    expect(victim).toBeTruthy();
    // The database refuses the rewrite (drizzle/0003_append_only_no_replace.sql). Someone with full
    // database access can drop that guard first, and that is what the hash chain is there for.
    await expect(replaceRow("audit_events", { ...victim!, reason: "rewritten without a trace?" })).rejects.toThrow("TT:IMMUTABLE:audit_events");
    const guard = await t.d1.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'audit_events_no_replace'").first<{ sql: string }>();
    await t.d1.prepare("DROP TRIGGER audit_events_no_replace").run();
    try {
      await replaceRow("audit_events", { ...victim!, reason: "rewritten without a trace?" });
      const report = await verifyAuditChain(t.db);
      expect(report.ok).toBe(false);
      expect(report.problems.map((problem) => problem.kind)).toContain("seal_hash");
    } finally {
      await replaceRow("audit_events", victim!);
      await t.d1.prepare(guard!.sql).run();
    }
    expect((await verifyAuditChain(t.db)).ok).toBe(true);
  });

  // Closed by the data owner (drizzle/0003_append_only_no_replace.sql). SQLite's REPLACE deletes the
  // old row without firing the DELETE trigger (recursive_triggers is off on D1), so a ledger row could
  // be rewritten in place, and nothing like the audit hash chain watches the ledgers. Every append-only
  // table now refuses an INSERT OR REPLACE that meets an existing id or other UNIQUE key
  // (TT:IMMUTABLE:<table>); tests/db-invariants.test.ts proves it table by table.
  test("INSERT OR REPLACE must not rewrite a wallet ledger row", async () => {
    const original = await t.d1.prepare("SELECT * FROM wallet_ledger WHERE kind = 'topup' ORDER BY at, id LIMIT 1").first<Record<string, unknown>>();
    expect(original).toBeTruthy();
    try {
      await replaceRow("wallet_ledger", { ...original!, amount_iqd: Number(original!.amount_iqd) * 1_000 }).catch(() => undefined);
      const after = await t.d1.prepare("SELECT amount_iqd FROM wallet_ledger WHERE id = ?").bind(original!.id).first<{ amount_iqd: number }>();
      expect(after?.amount_iqd).toBe(original!.amount_iqd);
    } finally {
      await replaceRow("wallet_ledger", original!).catch(() => undefined);
    }
  });

  test("INSERT OR REPLACE is refused on every append-only row a real order wrote, by its id and by its idempotency key", async () => {
    const p = await stocked({ priceIqd: 150_000, qty: 2, unitCostIqd: 90_000 });
    const customerId = await customerWithWallet(600_000);
    const order = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet", marketingConsent: true }, { customerId });
    await transitionOrder(t.db, ops(), order.orderId, "shipped", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), order.orderId, "delivered", {}, NOW + 2 * MINUTE);
    let sealed = await sealAudit(t.db, NOW + 3 * MINUTE);
    while (sealed.remaining) sealed = await sealAudit(t.db, NOW + 3 * MINUTE);

    const rowOf = async (query: string, ...params: unknown[]) => {
      const row = await t.d1.prepare(query).bind(...params).first<Record<string, unknown>>();
      if (!row) throw new Error(`no row for ${query}`);
      return row;
    };
    const wallet = await rowOf("SELECT * FROM wallet_ledger WHERE ref_id = ? LIMIT 1", order.orderId);
    const entry = await rowOf("SELECT * FROM journal_entries WHERE ref_id = ? AND idempotency_key IS NOT NULL LIMIT 1", order.orderId);
    const attacks: [table: string, row: Record<string, unknown>, rewrite: Record<string, unknown>][] = [
      ["audit_events", await rowOf("SELECT * FROM audit_events WHERE entity_id = ? ORDER BY seq LIMIT 1", order.orderId), { reason: "تعديل" }],
      ["audit_seals", await rowOf("SELECT * FROM audit_seals ORDER BY to_seq DESC LIMIT 1"), { hash: "0".repeat(64) }],
      ["stock_movements", await rowOf("SELECT * FROM stock_movements WHERE ref_id = ? AND kind = 'sale' LIMIT 1", order.orderId), { unit_cost_iqd: 1 }],
      ["order_events", await rowOf("SELECT * FROM order_events WHERE order_id = ? LIMIT 1", order.orderId), { kind: "nothing_happened" }],
      ["consents", await rowOf("SELECT * FROM consents WHERE subject_id = ? LIMIT 1", customerId), { granted: 0 }],
      ["journal_lines", await rowOf("SELECT l.* FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id WHERE e.ref_id = ? LIMIT 1", order.orderId), { debit_iqd: 1 }],
      ["wallet_ledger", wallet, { amount_iqd: 1 }],
      // The same idempotency key under a new id would have deleted the original entry.
      ["wallet_ledger", wallet, { id: newId("wal"), amount_iqd: 1 }],
      ["journal_entries", entry, { memo: "edited" }],
      ["journal_entries", entry, { id: newId("je"), memo: "edited" }],
    ];
    for (const [table, row, rewrite] of attacks) {
      await expect(replaceRow(table, { ...row, ...rewrite }), table).rejects.toThrow(`TT:IMMUTABLE:${table}`);
      expect(await t.d1.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(row.id).first(), table).toEqual(row);
    }
  });
});

// ───────────────────────────────────────────────────────────────── §7.10 cost privacy

describe("cost privacy — nothing a shopper or a non-cost employee receives carries cost", () => {
  const LANDED = 913_731;
  const LAYER = 911_177;
  const USED_COST = 313_733;
  const TRACKED_COST = 500_017;
  const PRICE = 1_000_000;
  const USED_PRICE = 450_000;
  const SECRETS = [LANDED, LAYER, USED_COST, TRACKED_COST, PRICE - LANDED, PRICE - LAYER, USED_PRICE - USED_COST];

  async function costedCatalogue() {
    const p = await make.product({ priceIqd: PRICE });
    await t.db.insert(variantCosts).values({ variantId: p.variantId, unitCostMinor: 697, landedCostIqd: LANDED, updatedAt: NOW });
    await receiveStock(t.db, SYSTEM, { variantId: p.variantId, locationId: DEFAULT_LOCATION_ID, qty: 8, unitCostIqd: LAYER, ref: "rcv-privacy" }, NOW - HOUR);
    const tracked = await stocked({ trackSerials: true, qty: 1, priceIqd: 600_000, unitCostIqd: TRACKED_COST });
    return { p, tracked };
  }

  test("what a shopper receives — cart, checkout, order views, lookups, wallet, instructions, proofs — has no cost key and no cost value (inspected recursively)", async () => {
    const { p, tracked } = await costedCatalogue();
    const used = await listedUsedUnit(tracked.variantId, { priceIqd: USED_PRICE, costIqd: USED_COST });
    const customerId = await customerWithWallet(5_000_000);
    const coupon = await couponRow({ kind: "percent", value: 500 });
    const seen: Record<string, unknown> = {};

    const token = await cartOf([{ usedUnitId: used.unitId }]);
    seen.addToCart = await addToCart(t.db, { cartToken: token, customerId: null, locale: "en" }, { variantId: p.variantId, qty: 1 }, NOW);
    seen.applyCoupon = await applyCoupon(t.db, { cartToken: token, customerId: null, locale: "en" }, coupon.code, NOW);
    seen.cartView = await getCartView(t.db, { cartToken: token, customerId: null, locale: "en", governorateId: BAGHDAD }, NOW);
    seen.checkoutCart = await getCheckoutCart(t.db, { cartToken: token, customerId: null, locale: "en", governorateId: BAGHDAD }, NOW);
    seen.coupon = await evaluateCoupon(t.db, { code: coupon.code, subtotalIqd: PRICE, lines: [{ variantId: p.variantId, qty: 1, unitPriceIqd: PRICE }] }, NOW);
    seen.instructions = await getPaymentInstructions(t.db, "en");
    const guestBody = await checkoutBody(token);
    const guest = await placeOrder(t.db, shopper(token), guestBody, NOW);
    seen.placeGuest = guest;
    const wallet = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
    seen.placeWallet = { ...wallet, body: undefined };
    const transfer = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" });
    seen.proof = await submitPaymentProof(t.db, { orderRef: transfer.ref, accessToken: transfer.accessToken }, { fileId: await proofFile(), declaredAmountIqd: transfer.totalIqd }, NOW);

    // Costs now sit on sale movements, COGS postings and order lines: deliver both orders, refund part of one.
    await transitionOrder(t.db, ops(), wallet.orderId, "shipped", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), wallet.orderId, "delivered", {}, NOW + 2 * MINUTE);
    await transitionOrder(t.db, ops(), guest.orderId, "confirmed", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), guest.orderId, "shipped", {}, NOW + 2 * MINUTE);
    await recordCodCollection(t.db, ops(), guest.orderId, guest.totalIqd, NOW + 3 * MINUTE);
    await transitionOrder(t.db, ops(), guest.orderId, "delivered", {}, NOW + 3 * MINUTE);
    const walletPayment = await paymentOf(wallet.orderId);
    const refund = await createRefund(t.db, person("requester", "orders.refund.create"), { orderId: wallet.orderId, paymentId: walletPayment.id, amountIqd: 100_000, method: "wallet", reason: "خصم بعد التسليم" }, NOW + 4 * MINUTE);
    await approveRefund(t.db, person("approver", "orders.refund.approve"), refund.refundId, { approve: true }, NOW + 5 * MINUTE);
    expect((await t.db.select().from(orderItems).where(eq(orderItems.orderId, wallet.orderId)).get())?.costSnapshotIqd).toBe(LANDED);

    seen.customerOrder = await getOrderForCustomer(t.db, customerId, wallet.ref, "en", NOW + HOUR);
    seen.customerOrders = await listOrdersForCustomer(t.db, customerId, "en");
    seen.walletEntries = await listWalletEntries(t.db, customerId);
    seen.byToken = await getOrderByAccessToken(t.db, guest.ref, guest.accessToken, "en", NOW + HOUR);
    seen.transferView = await getOrderByAccessToken(t.db, transfer.ref, transfer.accessToken, "en", NOW + HOUR);
    seen.lookup = await lookupGuestOrder(t.db, { ref: guest.ref, phone: guestBody.phone }, { ip: "192.0.2.50", locale: "en" }, NOW + HOUR);

    // Not empty shells: the views really describe the orders.
    expect((seen.customerOrder as { lines: unknown[] } | null)?.lines.length).toBe(1);
    expect((seen.byToken as { lines: unknown[] } | null)?.lines.length).toBe(2);
    expect((seen.lookup as { ref: string } | null)?.ref).toBe(guest.ref);
    expect(costLeaks(seen, SECRETS)).toEqual([]);
  });

  test("what non-cost staff receive from the core carries no cost either", async () => {
    const { p } = await costedCatalogue();
    const support = role("support");
    expect(can(support, "cost.read")).toBe(false);
    const customerId = await customerWithWallet(5_000_000);
    const wallet = await buy([{ variantId: p.variantId }], { paymentMethod: "wallet" }, { customerId });
    await transitionOrder(t.db, ops(), wallet.orderId, "shipped", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), wallet.orderId, "delivered", {}, NOW + 2 * MINUTE);
    const walletPayment = await paymentOf(wallet.orderId);
    const transfer = await buy([{ variantId: p.variantId }], { paymentMethod: "zaincash" });
    await submitPaymentProof(t.db, { orderRef: transfer.ref, accessToken: transfer.accessToken }, { fileId: await proofFile(), declaredAmountIqd: transfer.totalIqd }, NOW);
    const cod = await buy([{ variantId: p.variantId }]);
    await transitionOrder(t.db, ops(), cod.orderId, "confirmed", {}, NOW + MINUTE);
    await transitionOrder(t.db, ops(), cod.orderId, "shipped", {}, NOW + 2 * MINUTE);

    const seen: Record<string, unknown> = {};
    seen.refundRequest = await createRefund(t.db, support, { orderId: wallet.orderId, paymentId: walletPayment.id, amountIqd: 50_000, method: "wallet", reason: "شكوى زبون" }, NOW + HOUR);
    seen.pendingRefunds = await listPendingRefunds(t.db, support);
    seen.refundable = await getRefundableAmount(t.db, walletPayment.id);
    seen.verify = await verifyPayment(t.db, person("verifier", "orders.payment.verify"), (await paymentOf(transfer.orderId)).id, { approve: true }, NOW + HOUR);
    seen.cod = await recordCodCollection(t.db, person("ops", "orders.payment.record"), cod.orderId, cod.totalIqd, NOW + HOUR);
    seen.credit = await creditWallet(t.db, person("finance", "customers.wallet.adjust"), { customerId, amountIqd: 5_000, kind: "adjustment", reason: "تعويض", idempotencyKey: `goodwill-${customerId}` }, NOW + HOUR);
    seen.availability = await getAvailability(t.db, [p.variantId]);
    expect((seen.pendingRefunds as unknown[]).length).toBeGreaterThan(0);
    expect(costLeaks(seen, SECRETS)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── §4 guest order lookup

describe("guest order lookup", () => {
  test("needs the reference AND the phone; a wrong reference and a wrong phone get the same answer", async () => {
    const p = await stocked({ priceIqd: 64_000, qty: 2 });
    const order = await buy([{ variantId: p.variantId }]);
    const phone = order.body.phone;
    const ip = "198.51.100.7";

    const found = await lookupGuestOrder(t.db, { ref: order.ref, phone }, { ip, locale: "ar" }, NOW);
    expect(found?.ref).toBe(order.ref);
    expect(found?.contact.phoneMasked).not.toContain(phone.slice(-8));
    // The same order however the shopper types it: lower case, spaces, local format.
    expect((await lookupGuestOrder(t.db, { ref: `  ${order.ref.toLowerCase()} `, phone: `0${phone.slice(4, 7)} ${phone.slice(7)}` }, { ip }, NOW))?.ref).toBe(order.ref);

    const wrongPhone = await lookupGuestOrder(t.db, { ref: order.ref, phone: make.phone() }, { ip: "198.51.100.8" }, NOW);
    const wrongRef = await lookupGuestOrder(t.db, { ref: "TT-ZZZZZZZZ", phone }, { ip: "198.51.100.8" }, NOW);
    expect(wrongPhone).toBeNull();
    expect(wrongRef).toStrictEqual(wrongPhone);

    // One without the other is not a lookup (and there is no phone-only search at all).
    expect(await failureOf(lookupGuestOrder(t.db, { ref: "", phone }, { ip }, NOW))).toMatchObject({ code: "invalid", status: 400, fields: { ref: "required" } });
    expect(await failureOf(lookupGuestOrder(t.db, { ref: order.ref, phone: "" }, { ip }, NOW))).toMatchObject({ code: "invalid", fields: { phone: "required" } });
  });

  test("attempts are limited per IP and per reference, and the limit looks the same for a real and an invented reference", async () => {
    const p = await stocked({ priceIqd: 64_000, qty: 4 });
    const at = NOW + 2 * HOUR;
    const first = await buy([{ variantId: p.variantId }]);

    // Per IP: ten guesses of either kind, then even the right answer waits.
    const ip = "203.0.113.10";
    for (let i = 0; i < 5; i++) expect(await lookupGuestOrder(t.db, { ref: first.ref, phone: make.phone() }, { ip }, at)).toBeNull();
    for (let i = 0; i < 5; i++) expect(await lookupGuestOrder(t.db, { ref: `TT-GUESS${2 + i}ZZ`, phone: first.body.phone }, { ip }, at)).toBeNull();
    expect(await failureOf(lookupGuestOrder(t.db, { ref: first.ref, phone: first.body.phone }, { ip }, at))).toMatchObject({ code: "rate_limited", status: 429 });
    expect((await lookupGuestOrder(t.db, { ref: first.ref, phone: first.body.phone }, { ip: "203.0.113.11" }, at))?.ref).toBe(first.ref);

    // Per reference, whoever asks: ten wrong phones from ten addresses lock the reference for the hour.
    const second = await buy([{ variantId: p.variantId }]);
    for (let i = 0; i < 10; i++) expect(await lookupGuestOrder(t.db, { ref: second.ref, phone: make.phone() }, { ip: `203.0.113.${100 + i}` }, at)).toBeNull();
    const real = await failureOf(lookupGuestOrder(t.db, { ref: second.ref, phone: second.body.phone }, { ip: "203.0.113.200" }, at));
    expect(real).toMatchObject({ code: "rate_limited", status: 429 });

    // An invented reference behaves exactly the same: the limiter does not reveal which references exist.
    const invented = "TT-NQ7K4XWZ";
    for (let i = 0; i < 10; i++) expect(await lookupGuestOrder(t.db, { ref: invented, phone: make.phone() }, { ip: `203.0.113.${150 + i}` }, at)).toBeNull();
    const fake = await failureOf(lookupGuestOrder(t.db, { ref: invented, phone: second.body.phone }, { ip: "203.0.113.201" }, at));
    expect([fake.code, fake.status, fake.retryAfterSec]).toEqual([real.code, real.status, real.retryAfterSec]);
  });
});

// ───────────────────────────────────────────────────────────────── scheduled jobs

describe("scheduled jobs", () => {
  /** Runs the 5-minute jobs once at `at`, so whatever earlier tests left due is out of the way. */
  async function sweep(at: number) {
    const run = await runScheduledJobs(t.db, CRON_FREQUENT, at);
    expect(run.ok).toBe(true);
  }
  async function releasesOf(orderId: string) {
    return t.db.select().from(stockMovements).where(and(eq(stockMovements.refType, "order"), eq(stockMovements.refId, orderId), eq(stockMovements.kind, "release")));
  }

  test("an expired reservation is released exactly once — also when two runs overlap", async () => {
    const T = NOW + 10 * DAY;
    await sweep(T - 1);
    const p = await stocked({ qty: 4 });
    const holder = await make.order([{ variantId: p.variantId, sku: p.sku, qty: 3 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: holder.orderId, lines: [{ variantId: p.variantId, qty: 3 }], expiresAt: T + 10 * MINUTE, actor: SYSTEM, now: T }));
    expect((await levelOf(p.variantId)).reserved).toBe(3);

    await runScheduledJobs(t.db, CRON_FREQUENT, T + 5 * MINUTE);
    expect((await levelOf(p.variantId)).reserved).toBe(3);

    const runs = await Promise.all([runScheduledJobs(t.db, CRON_FREQUENT, T + 15 * MINUTE), runScheduledJobs(t.db, CRON_FREQUENT, T + 15 * MINUTE)]);
    expect(runs.every((run) => run.ok)).toBe(true);
    expect(await levelOf(p.variantId)).toMatchObject({ onHand: 4, reserved: 0 });
    expect(await releasesOf(holder.orderId)).toHaveLength(1);
    expect(await t.db.select({ status: stockReservations.status }).from(stockReservations).where(eq(stockReservations.orderId, holder.orderId))).toEqual([{ status: "expired" }]);

    const before = await counts();
    await runScheduledJobs(t.db, CRON_FREQUENT, T + 20 * MINUTE);
    expect(await counts()).toEqual(before);
  });

  test("an unpaid transfer order past its window is cancelled with everything it held released; the next run changes nothing; overlapping runs cancel once", async () => {
    const T = NOW + 20 * DAY;
    await sweep(T - 1);
    const p = await stocked({ qty: 3, priceIqd: 130_000 });
    const tracked = await stocked({ trackSerials: true, qty: 1, priceIqd: 500_000 });
    const used = await listedUsedUnit(tracked.variantId, { priceIqd: 380_000 });
    const coupon = await couponRow({ kind: "fixed", value: 5_000, usageLimit: 1 });
    const token = await cartOf([{ variantId: p.variantId, qty: 2 }, { usedUnitId: used.unitId }], T);
    await applyCoupon(t.db, { cartToken: token, customerId: null }, coupon.code, T);
    const placed = await placeOrder(t.db, shopper(token), await checkoutBody(token, { paymentMethod: "zaincash" }, { at: T }), T);
    const due = T + 24 * HOUR;
    expect(await orderRow(placed.orderId)).toMatchObject({ status: "awaiting_payment", paymentDueAt: due });
    expect((await levelOf(p.variantId)).reserved).toBe(2);

    await runScheduledJobs(t.db, CRON_FREQUENT, due - MINUTE);
    expect((await orderRow(placed.orderId)).status).toBe("awaiting_payment");

    const run = await runScheduledJobs(t.db, CRON_FREQUENT, due + MINUTE);
    expect(run.ok).toBe(true);
    const order = await orderRow(placed.orderId);
    expect(order).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect(order.cancelReason).toContain("payment_window_expired");
    expect(await paymentOf(placed.orderId)).toMatchObject({ status: "cancelled" });
    expect((await levelOf(p.variantId)).reserved).toBe(0);
    expect(await releasesOf(placed.orderId)).toHaveLength(1);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, used.unitId)).get())?.status).toBe("listed");
    expect((await t.db.select().from(serials).where(eq(serials.id, used.serialId)).get())?.status).toBe("in_stock");
    expect((await t.db.select().from(couponRedemptions).where(eq(couponRedemptions.orderId, placed.orderId)).get())?.voidedAt).toBe(due + MINUTE);
    expect(await evaluateCoupon(t.db, { code: coupon.code, subtotalIqd: 130_000, lines: [{ variantId: p.variantId, qty: 1, unitPriceIqd: 130_000 }] }, due + HOUR)).toMatchObject({ ok: true });

    const before = await counts();
    const again = await runScheduledJobs(t.db, CRON_FREQUENT, due + 6 * MINUTE);
    expect(again.ok).toBe(true);
    expect(await counts()).toEqual(before);

    // A second order, two runs at the same moment: cancelled once.
    const second = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" }, { at: T + HOUR });
    const runs = await Promise.all([runScheduledJobs(t.db, CRON_FREQUENT, due + HOUR + MINUTE), runScheduledJobs(t.db, CRON_FREQUENT, due + HOUR + MINUTE)]);
    expect(runs.every((each) => each.ok)).toBe(true);
    expect((await orderRow(second.orderId)).status).toBe("cancelled");
    expect(await releasesOf(second.orderId)).toHaveLength(1);
    expect(await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, second.orderId), eq(orderEvents.kind, "status_changed")))).toHaveLength(1);
    expect((await levelOf(p.variantId)).reserved).toBe(0);
  });

  test("a proof that lands while the job is cancelling keeps the order and its stock", async () => {
    const T = NOW + 30 * DAY;
    await sweep(T - 1);
    const p = await stocked({ qty: 2, priceIqd: 215_000 });
    const placed = await buy([{ variantId: p.variantId }], { paymentMethod: "bank_transfer" }, { at: T });
    const due = T + 24 * HOUR;
    const fileId = await proofFile();
    // The shopper's upload started a second before the deadline and commits while the job is at work.
    const race = interleave(t.db, { call: 1, when: "before" }, () => submitPaymentProof(t.db, { orderRef: placed.ref, accessToken: placed.accessToken }, { fileId, declaredAmountIqd: placed.totalIqd }, due - 1_000));
    const run = await runScheduledJobs(race.db, CRON_FREQUENT, due + MINUTE);
    expect(run.ok).toBe(true);
    expect(race.outcome()).toMatchObject({ ok: true });

    expect(await orderRow(placed.orderId)).toMatchObject({ status: "payment_review", paymentStatus: "pending_verification" });
    expect(await paymentOf(placed.orderId)).toMatchObject({ status: "pending_verification" });
    expect((await levelOf(p.variantId)).reserved).toBe(1);
    expect(await t.db.select({ status: stockReservations.status }).from(stockReservations).where(eq(stockReservations.orderId, placed.orderId))).toEqual([{ status: "active" }]);
    // The proof is then reviewed as usual.
    expect(await verifyPayment(t.db, role("finance"), (await paymentOf(placed.orderId)).id, { approve: true }, due + HOUR)).toMatchObject({ status: "paid" });
    expect((await orderRow(placed.orderId)).status).toBe("confirmed");
  });

  test("a proof that lands while reservations are being expired keeps its stock", async () => {
    const T = NOW + 40 * DAY;
    await sweep(T - 1);
    const p = await stocked({ qty: 2, priceIqd: 175_000 });
    const placed = await buy([{ variantId: p.variantId }], { paymentMethod: "zaincash" }, { at: T });
    const due = T + 24 * HOUR;
    const fileId = await proofFile();
    const race = interleave(t.db, { call: 1, when: "before" }, () => submitPaymentProof(t.db, { orderRef: placed.ref, accessToken: placed.accessToken }, { fileId, declaredAmountIqd: placed.totalIqd }, due - 1_000));
    const result = await expireReservations(race.db, due + MINUTE);
    expect(race.outcome()).toMatchObject({ ok: true });
    expect(result.released).toBe(0);
    expect((await orderRow(placed.orderId)).status).toBe("payment_review");
    expect((await levelOf(p.variantId)).reserved).toBe(1);
    expect(await t.db.select({ status: stockReservations.status, expiresAt: stockReservations.expiresAt }).from(stockReservations).where(eq(stockReservations.orderId, placed.orderId))).toEqual([
      { status: "active", expiresAt: null },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────── the books after all of this

describe("afterwards", () => {
  test("after every attack in this file, the daily consistency checks find nothing and every wallet debit belongs to its wallet order", async () => {
    const findings: unknown[] = [];
    for (const check of CONSISTENCY_CHECKS) findings.push(...(await check.run(t.db)));
    expect(findings).toEqual([]);
    const orphans = await t.d1
      .prepare(
        `SELECT w.id FROM wallet_ledger AS w LEFT JOIN orders AS o ON o.id = w.ref_id AND w.ref_type = 'order'
         WHERE w.kind = 'purchase' AND (o.id IS NULL OR o.payment_method <> 'wallet' OR -w.amount_iqd <> o.total_iqd)`,
      )
      .all();
    expect(orphans.results).toEqual([]);
  });
});
