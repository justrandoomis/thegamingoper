/**
 * Admin module 12 "returns" — adversarial review (2026-11-11, owner: admin returns). Each test below failed on the
 * module as it was built and passes with the fix (the one marked "unchanged" guards behaviour the fix must keep);
 * docs/areas/admin-returns.md "Review" lists them:
 *
 *   1. IDOR: an employee who may only OPEN RMAs (cashier) marked other people's RMAs in transit, wrote notes on them and
 *      added photos to them — although the same RMA answers them 404 when they open it
 *   2. a unit that stayed with the customer ("keep") could be refunded through the RMA: goods AND money with the customer
 *   3. two refund requests racing for the same returned unit (a line bought twice, one returned) both passed — the unit
 *      was refunded twice (paid twice within the owner's threshold); the database's own bound (Σ refunded ≤ bought)
 *      cannot see it. The race is run deterministically: the competing request completes just before the write batch.
 *   4. a quoted repair went from "diagnosing" (or "awaiting parts") to "repairing" without the customer's approval, a
 *      changed quote was finished ("ready") unapproved, and a closed ticket took a quote answer
 *   5. an unrepairable device handed back marked its RMA "repaired"
 *   6. an inspector limited to one branch put returned goods into another branch's locations, and took them out of
 *      another branch's quarantine
 *   7. closing an RMA as store credit / exchange / repair / supplier return when none of that happened
 *   8. a refund of SOME of the returned units marked the RMA "refunded": it left the refund queue with units unpaid
 *   9. the policy's restocking fee (12.04 "per policy") was only a suggestion: the full value could be refunded
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { rmaAction } from "~/routes/admin/returns/rma.server";
import { systemActor, type EmployeeActor } from "~/server/actor";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import type { Db } from "~/server/db/drizzle.server";
import { branches, employeeRoles, inventoryLocations, orderItemSerials, orderItems, orders, payments, products, refunds, repairTickets, returnItems, returns, serials, settings, stockLevels, variantCosts, warranties } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { inspectItem, resolveQuarantine } from "~/server/services/admin/returns/inspect.server";
import { savePolicy, listPolicies } from "~/server/services/admin/returns/policy.server";
import { decideReturnRefund, requestReturnRefund } from "~/server/services/admin/returns/refund.server";
import { changeRepairStatus, openCounterRepair, openReturnRepair, recordQuoteDecision, setDiagnosis } from "~/server/services/admin/returns/repair.server";
import { addReturnNote, assertPhotoSlot, closeReturn, decideReturn, getReturnDetail, markInTransit, openReturn, queueCounts } from "~/server/services/admin/returns/rma.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { assignSerialsStatements, receiveStock } from "~/server/services/inventory/stock.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { recordCodCollection } from "~/server/services/payments/payments.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const system = systemActor("test.admin-returns-adversarial");
const urls = { photo: (id: string) => `/admin/returns/files/${id}` };

let t: TestDb;
let make: Fixtures;
let quarantineId: string;
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "support", "inventory", "cashier"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
  quarantineId = newId("loc");
  await t.db.insert(inventoryLocations).values({ id: quarantineId, code: `RQ-${randomToken(4)}`, name: "Returns quarantine", kind: "warehouse", isSellable: false });
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey, branchId: string | null = null): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}`, branchId });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key, branchId };
}

const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

async function stocked(priceIqd: number, qty: number, unitCostIqd: number, options: { trackSerials?: boolean; warrantyMonths?: number } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials });
  if (options.warrantyMonths) await t.db.update(products).set({ warrantyMonths: options.warrantyMonths }).where(eq(products.id, product.productId));
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `SN-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: unitCostIqd, landedCostIqd: unitCostIqd, updatedAt: NOW }).onConflictDoNothing();
  return product;
}

type Delivered = Awaited<ReturnType<typeof placeOrder>> & { items: (typeof orderItems.$inferSelect)[] };

/** A cash-on-delivery order taken to delivery through the core (serials attached at packing). */
async function delivered(lines: { variantId: string; qty: number }[], options: { customerId?: string | null } = {}): Promise<Delivered> {
  const customerId = options.customerId ?? null;
  const phone = make.phone();
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  const order = await placeOrder(
    t.db,
    { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: randomToken(), phone: `0${phone.slice(4)}`, governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة", addressText: "شارع 62، عمارة 4", marketingConsent: false, paymentMethod: "cod", expectedTotalIqd: view.totalIqd },
    NOW,
  );
  await transitionOrder(t.db, system, order.orderId, "confirmed", {}, NOW);
  await transitionOrder(t.db, system, order.orderId, "preparing", {}, NOW);
  const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId));
  for (const item of items) {
    const free = await t.db.select({ id: serials.id }).from(serials).where(and(eq(serials.variantId, item.variantId), eq(serials.status, "in_stock"))).limit(item.qty);
    if (free.length) await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: item.id, serialIds: free.map((row) => row.id), actor: system, now: NOW }));
  }
  await transitionOrder(t.db, system, order.orderId, "shipped", {}, NOW);
  await recordCodCollection(t.db, system, order.orderId, order.totalIqd, NOW);
  await transitionOrder(t.db, system, order.orderId, "delivered", {}, NOW);
  return { ...order, items };
}

const serialsOf = async (orderItemId: string) => (await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, orderItemId)).all()).map((row) => row.serialId);
const serialText = async (serialId: string) => (await t.db.select().from(serials).where(eq(serials.id, serialId)).get())!.serial;
const paymentOf = async (orderId: string) => (await t.db.select().from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "paid"))).get())!;
const itemsOf = async (returnId: string) => t.db.select().from(returnItems).where(eq(returnItems.returnId, returnId)).orderBy(returnItems.id).all();
const statusOf = async (returnId: string) => (await t.db.select({ status: returns.status }).from(returns).where(eq(returns.id, returnId)).get())?.status;

/** An RMA for `qty` units of each given line (all serials of serial-tracked lines), opened by `opener`, approved by a manager. */
async function rmaFor(order: Delivered, lines: { line: number; qty?: number }[], options: { opener?: EmployeeActor; approve?: boolean; reasonCode?: "defective" | "changed_mind" } = {}) {
  const items = [];
  for (const { line, qty } of lines) {
    const item = order.items[line];
    const serialIds = await serialsOf(item.id);
    items.push({ orderItemId: item.id, qty: qty ?? item.qty, serialIds: serialIds.length ? serialIds.slice(0, qty ?? item.qty) : undefined, sealed: true });
  }
  const opened = await openReturn(t.db, options.opener ?? as("support"), { orderRef: order.ref, items, reasonCode: options.reasonCode ?? "defective", reason: "لا يعمل بعد التشغيل", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY);
  if (options.approve !== false) await decideReturn(t.db, as("manager"), opened.returnId, { approve: true }, NOW + DAY + HOUR);
  return opened;
}

/** Inspects every unit of an RMA with one decision (serials scanned from the units themselves). */
async function inspectAll(returnId: string, decision: "restock" | "keep" | "refurbish" | "return_to_supplier" | "scrap", condition: "sellable" | "defective" = decision === "restock" ? "sellable" : "defective") {
  for (const item of await itemsOf(returnId)) {
    await inspectItem(t.db, as("inventory"), { returnId, itemId: item.id, condition, decision, serial: item.serialId ? await serialText(item.serialId) : undefined, locationId: decision === "refurbish" || decision === "return_to_supplier" ? quarantineId : undefined }, NOW + 2 * DAY);
  }
}

const session = (actor: EmployeeActor): EmployeeSession =>
  ({
    employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: actor.branchId ?? null, totpEnabled: false, passwordChangedAt: null },
    actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
  }) as EmployeeSession;
const form = (entries: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  return data;
};
const store = () => ({ put: async () => {}, get: async () => null, delete: async () => {} });

/**
 * The database a request uses, with a competing request run to its end just before this request's FIRST write batch —
 * the worst moment for a check that is made before the batch instead of inside it.
 */
function racing(db: Db, competitor: () => Promise<unknown>): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: Parameters<Db["batch"]>[0]) => {
          if (!fired) {
            fired = true;
            await competitor();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

// ───────────────────────────────────────────────────────────────── 1. IDOR

describe("an employee who may only open RMAs", () => {
  test("acts on the RMAs they opened, and on nobody else's: the same 404 their page answers", async () => {
    const pad = await stocked(40_000, 10, 25_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const other = await rmaFor(order, [{ line: 0 }], { opener: as("support") });
    const ctx = { locale: "en" as const, now: NOW + 2 * DAY };
    // the page itself is a 404 for them …
    expect(await failureOf(getReturnDetail(t.db, as("cashier"), other.rma, "ar", NOW + 2 * DAY, urls))).toMatchObject({ code: "not_found", status: 404 });
    // … and so is every change to it
    expect(await rmaAction(ctx, t.db, session(as("cashier")), other.rma, form({ intent: "transit", note: "أرسله العميل" }), store)).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(await rmaAction(ctx, t.db, session(as("cashier")), other.rma, form({ intent: "note", text: "ملاحظة من غير صاحبه" }), store)).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(await failureOf(markInTransit(t.db, as("cashier"), other.returnId, {}, NOW + 2 * DAY))).toMatchObject({ code: "not_found" });
    expect(await failureOf(addReturnNote(t.db, as("cashier"), other.returnId, { text: "ملاحظة من غير صاحبه" }, NOW + 2 * DAY))).toMatchObject({ code: "not_found" });
    expect(await failureOf(assertPhotoSlot(t.db, as("cashier"), other.returnId))).toMatchObject({ code: "not_found" });
    expect(await statusOf(other.returnId)).toBe("approved");
    // their own RMA: every one of those works
    const order2 = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const mine = await rmaFor(order2, [{ line: 0 }], { opener: as("cashier") });
    expect(await rmaAction(ctx, t.db, session(as("cashier")), mine.rma, form({ intent: "note", text: "اتصل العميل" }), store)).toMatchObject({ ok: true });
    expect(await rmaAction(ctx, t.db, session(as("cashier")), mine.rma, form({ intent: "transit" }), store)).toMatchObject({ ok: true });
    expect((await assertPhotoSlot(t.db, as("cashier"), mine.returnId)).id).toBe(mine.returnId);
    // an inspector (all RMAs) is not limited
    expect(await markInTransit(t.db, as("inventory"), other.returnId, {}, NOW + 2 * DAY)).toEqual({ replayed: false });
  });
});

// ───────────────────────────────────────────────────────────────── 2 + 5. kept units and failed repairs

describe("a unit that stayed with the customer", () => {
  test("is not refunded through the RMA — unless its repair under the RMA failed; a failed repair does not mark the RMA repaired", async () => {
    const console5 = await stocked(500_000, 3, 380_000, { trackSerials: true, warrantyMonths: 12 });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }], { customerId: await make.customer() });
    const rma = await rmaFor(order, [{ line: 0 }]);
    await inspectAll(rma.returnId, "keep");
    const [item] = await itemsOf(rma.returnId);
    const warranty = () => t.db.select({ status: warranties.status, voidReason: warranties.voidReason }).from(warranties).where(eq(warranties.serialId, item.serialId!)).get();
    expect((await warranty())?.status).toBe("active");
    const payment = await paymentOf(order.orderId);
    const ask = () => requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: payment.id, itemIds: [item.id], amountIqd: 500_000, method: "cash", reason: "استرداد قطعة بقيت معه", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    expect(await failureOf(ask())).toMatchObject({ code: "refund_not_ready", fields: { itemIds: "not_returned" } });
    expect((await t.db.select().from(refunds).where(eq(refunds.orderId, order.orderId)).all()).length).toBe(0);
    let detail = await getReturnDetail(t.db, as("support"), rma.rma, "ar", NOW + 3 * DAY, urls);
    expect(detail.items[0].refundable).toBe(false);
    expect(detail.can.refund).toBe(false);
    expect(detail.refundSuggestion).toBeNull();
    // repaired for the customer … and it cannot be repaired: handed back, the RMA is NOT "repaired"
    const ticket = await openReturnRepair(t.db, as("support"), { returnId: rma.returnId, itemId: item.id, issue: "لا يعطي صورة عبر HDMI أبداً" }, NOW + 3 * DAY);
    const ticketId = (await t.db.select({ id: repairTickets.id }).from(repairTickets).where(eq(repairTickets.ref, ticket.ref)).get())!.id;
    await changeRepairStatus(t.db, as("support"), { ticketId, from: "received", to: "diagnosing" }, NOW + 3 * DAY);
    await changeRepairStatus(t.db, as("support"), { ticketId, from: "diagnosing", to: "unrepairable", note: "اللوحة الأم محترقة" }, NOW + 4 * DAY);
    await changeRepairStatus(t.db, as("support"), { ticketId, from: "unrepairable", to: "delivered", note: "سُلم للعميل كما هو" }, NOW + 5 * DAY);
    expect(await t.db.select({ status: returns.status, resolution: returns.resolution, closedAt: returns.closedAt }).from(returns).where(eq(returns.id, rma.returnId)).get()).toEqual({ status: "inspected", resolution: null, closedAt: null });
    // the store could not repair it: now its money can go back
    detail = await getReturnDetail(t.db, as("support"), rma.rma, "ar", NOW + 5 * DAY, urls);
    expect(detail.items[0].refundable).toBe(true);
    expect(detail.can.refund).toBe(true);
    const asked = await ask();
    expect(asked).toMatchObject({ status: "pending", replayed: false });
    // once that money is paid, the store's warranty on the unit it paid for ends
    expect((await warranty())?.status).toBe("active");
    await decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: asked.refundId, approve: true }, NOW + 5 * DAY);
    expect(await warranty()).toEqual({ status: "void", voidReason: `refunded: ${rma.rma}` });
    expect(await statusOf(rma.returnId)).toBe("refunded");
  });

  test("a repair that worked resolves the RMA as repaired (unchanged)", async () => {
    const console5 = await stocked(450_000, 2, 300_000, { trackSerials: true });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const rma = await rmaFor(order, [{ line: 0 }]);
    await inspectAll(rma.returnId, "keep");
    const [item] = await itemsOf(rma.returnId);
    const ticket = await openReturnRepair(t.db, as("support"), { returnId: rma.returnId, itemId: item.id, issue: "المروحة تصدر صوتاً عالياً" }, NOW + 3 * DAY);
    const ticketId = (await t.db.select({ id: repairTickets.id }).from(repairTickets).where(eq(repairTickets.ref, ticket.ref)).get())!.id;
    for (const [from, to] of [["received", "diagnosing"], ["diagnosing", "repairing"], ["repairing", "ready"], ["ready", "delivered"]] as const) await changeRepairStatus(t.db, as("support"), { ticketId, from, to }, NOW + 4 * DAY);
    expect(await statusOf(rma.returnId)).toBe("repaired");
  });
});

// ───────────────────────────────────────────────────────────────── 3. never twice, also under a race

describe("never twice for the same unit", () => {
  test("two requests racing for the one returned unit of a line bought twice: one refund", async () => {
    const cable = await stocked(30_000, 10, 12_000);
    const order = await delivered([{ variantId: cable.variantId, qty: 2 }]);
    const rma = await rmaFor(order, [{ line: 0, qty: 1 }]);
    await inspectAll(rma.returnId, "restock");
    const [item] = await itemsOf(rma.returnId);
    const payment = await paymentOf(order.orderId);
    const input = () => ({ returnId: rma.returnId, paymentId: payment.id, itemIds: [item.id], amountIqd: 30_000, method: "cash" as const, reason: "قطعة لا تشحن", idempotencyKey: randomToken() });
    const competitor = () => requestReturnRefund(t.db, as("support"), input(), NOW + 3 * DAY);
    const raced = await failureOf(requestReturnRefund(racing(t.db, competitor), as("finance"), input(), NOW + 3 * DAY));
    expect(raced).toMatchObject({ code: "refund_qty_exceeds", status: 409 });
    const all = await t.db.select().from(refunds).where(eq(refunds.orderId, order.orderId)).all();
    expect(all.length).toBe(1);
    // sequentially it was always refused (unchanged)
    expect(await failureOf(competitor())).toMatchObject({ code: "refund_qty_exceeds" });
  });

  test("within the owner's threshold a refund is paid at once: racing, the unit's money still leaves once", async () => {
    await t.db.insert(settings).values({ key: "refunds.approval_threshold_iqd", value: 1_000_000, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value: 1_000_000 } });
    try {
      const cable = await stocked(25_000, 10, 10_000);
      const order = await delivered([{ variantId: cable.variantId, qty: 2 }]);
      const rma = await rmaFor(order, [{ line: 0, qty: 1 }]);
      await inspectAll(rma.returnId, "restock");
      const [item] = await itemsOf(rma.returnId);
      const payment = await paymentOf(order.orderId);
      const input = () => ({ returnId: rma.returnId, paymentId: payment.id, itemIds: [item.id], amountIqd: 25_000, method: "cash" as const, reason: "قطعة لا تعمل", idempotencyKey: randomToken() });
      const competitor = async () => expect(await requestReturnRefund(t.db, as("support"), input(), NOW + 3 * DAY)).toMatchObject({ status: "paid" });
      expect(await failureOf(requestReturnRefund(racing(t.db, competitor), as("finance"), input(), NOW + 3 * DAY))).toMatchObject({ code: "refund_qty_exceeds" });
      expect(await t.db.select({ status: refunds.status, amountIqd: refunds.amountIqd }).from(refunds).where(eq(refunds.orderId, order.orderId)).all()).toEqual([{ status: "paid", amountIqd: 25_000 }]);
      expect((await t.db.select({ refundedIqd: orders.refundedIqd }).from(orders).where(eq(orders.id, order.orderId)).get())?.refundedIqd).toBe(25_000);
      expect(await statusOf(rma.returnId)).toBe("refunded");
    } finally {
      await t.db.update(settings).set({ value: 0 }).where(eq(settings.key, "refunds.approval_threshold_iqd"));
    }
  });
});

// ───────────────────────────────────────────────────────────────── 4. the customer approves a quote first

test("a quoted repair never starts before the customer approved the price, whatever the status it starts from", async () => {
  const opened = await openCounterRepair(t.db, as("support"), { phone: "07701239876", deviceText: "PS4 Slim", issue: "لا يشحن اليد بعد التحديث", idempotencyKey: randomToken() }, NOW);
  const ticketId = (await t.db.select({ id: repairTickets.id }).from(repairTickets).where(eq(repairTickets.ref, opened.ref)).get())!.id;
  await changeRepairStatus(t.db, as("support"), { ticketId, from: "received", to: "diagnosing" }, NOW + HOUR);
  await setDiagnosis(t.db, as("support"), { ticketId, diagnosis: "منفذ الشحن تالف", quoteIqd: 35_000 }, NOW + 2 * HOUR);
  expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId, from: "diagnosing", to: "repairing" }, NOW + 3 * HOUR))).toMatchObject({ code: "quote_not_approved" });
  await changeRepairStatus(t.db, as("support"), { ticketId, from: "diagnosing", to: "awaiting_parts" }, NOW + 3 * HOUR);
  expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId, from: "awaiting_parts", to: "repairing" }, NOW + 4 * HOUR))).toMatchObject({ code: "quote_not_approved" });
  // approved, started — then the price changes: the new quote is approved again before the work is finished
  await recordQuoteDecision(t.db, as("support"), { ticketId, approved: true, note: "وافق هاتفياً" }, NOW + 4 * HOUR);
  await changeRepairStatus(t.db, as("support"), { ticketId, from: "awaiting_parts", to: "repairing" }, NOW + 4 * HOUR);
  await setDiagnosis(t.db, as("support"), { ticketId, diagnosis: "منفذ الشحن واللوحة تالفان", quoteIqd: 60_000 }, NOW + 5 * HOUR);
  expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId, from: "repairing", to: "ready" }, NOW + 6 * HOUR))).toMatchObject({ code: "quote_not_approved" });
  await recordQuoteDecision(t.db, as("support"), { ticketId, approved: true, note: "وافق على السعر الجديد" }, NOW + 6 * HOUR);
  await changeRepairStatus(t.db, as("support"), { ticketId, from: "repairing", to: "ready" }, NOW + 7 * HOUR);
  await changeRepairStatus(t.db, as("support"), { ticketId, from: "ready", to: "delivered" }, NOW + 8 * HOUR);
  expect((await t.db.select({ costIqd: repairTickets.costIqd }).from(repairTickets).where(eq(repairTickets.id, ticketId)).get())?.costIqd).toBe(60_000);
  // a closed ticket takes no quote answer any more
  expect(await failureOf(recordQuoteDecision(t.db, as("support"), { ticketId, approved: false, note: "تراجع بعد التسليم" }, NOW + 9 * HOUR))).toMatchObject({ code: "repair_changed" });
  // a repair without a price (warranty, or nothing quoted) is not held back
  const free = await openCounterRepair(t.db, as("support"), { phone: "07701239877", deviceText: "Xbox One", issue: "يحتاج تنظيفاً من الغبار", idempotencyKey: randomToken() }, NOW);
  const freeId = (await t.db.select({ id: repairTickets.id }).from(repairTickets).where(eq(repairTickets.ref, free.ref)).get())!.id;
  await changeRepairStatus(t.db, as("support"), { ticketId: freeId, from: "received", to: "diagnosing" }, NOW + HOUR);
  expect(await changeRepairStatus(t.db, as("support"), { ticketId: freeId, from: "diagnosing", to: "repairing" }, NOW + 2 * HOUR)).toMatchObject({ status: "repairing" });
});

// ───────────────────────────────────────────────────────────────── 6. branch limits

test("an inspector limited to a branch puts returned goods only into their branch's locations", async () => {
  const branchA = newId("brn");
  const branchB = newId("brn");
  await t.db.insert(branches).values([
    { id: branchA, code: make.next("BA"), name: { ar: "فرع أ" }, createdAt: NOW },
    { id: branchB, code: make.next("BB"), name: { ar: "فرع ب" }, createdAt: NOW },
  ]);
  const location = async (branchId: string, isSellable: boolean) => {
    const id = newId("loc");
    await t.db.insert(inventoryLocations).values({ id, code: make.next("LOC"), name: "Branch location", kind: "store", isSellable, branchId });
    return id;
  };
  const [shopA, shopB, holdA, holdB] = [await location(branchA, true), await location(branchB, true), await location(branchA, false), await location(branchB, false)];
  const clerkA = await employee("inventory", branchA);
  const pad = await stocked(60_000, 10, 40_000);
  const order = await delivered([
    { variantId: pad.variantId, qty: 1 },
    { variantId: (await stocked(45_000, 5, 30_000)).variantId, qty: 1 },
  ]);
  const rma = await rmaFor(order, [{ line: 0 }, { line: 1 }]);
  const padLine = order.items.find((line) => line.variantId === pad.variantId)!;
  const first = (await itemsOf(rma.returnId)).find((entry) => entry.orderItemId === padLine.id)!;
  const second = (await itemsOf(rma.returnId)).find((entry) => entry.orderItemId !== padLine.id)!;
  // not into the other branch: sellable, quarantine, or the store's default (wherever the unit left from)
  expect(await failureOf(inspectItem(t.db, clerkA, { returnId: rma.returnId, itemId: first.id, condition: "sellable", decision: "restock", locationId: shopB }, NOW + 2 * DAY))).toMatchObject({ code: "forbidden", status: 403 });
  expect(await failureOf(inspectItem(t.db, clerkA, { returnId: rma.returnId, itemId: first.id, condition: "opened", decision: "refurbish", locationId: holdB }, NOW + 2 * DAY))).toMatchObject({ code: "forbidden", status: 403 });
  expect(await failureOf(inspectItem(t.db, clerkA, { returnId: rma.returnId, itemId: first.id, condition: "sellable", decision: "restock" }, NOW + 2 * DAY))).toMatchObject({ code: "invalid", fields: { locationId: "required" } });
  // the page offers only their branch's locations
  const detail = await getReturnDetail(t.db, clerkA, rma.rma, "ar", NOW + 2 * DAY, urls);
  expect(detail.sellableLocations.map((row) => row.id)).toContain(shopA);
  expect(detail.sellableLocations.map((row) => row.id)).not.toContain(shopB);
  expect(detail.quarantineLocations.map((row) => row.id)).toEqual([holdA]);
  // into their own: yes
  await inspectItem(t.db, clerkA, { returnId: rma.returnId, itemId: first.id, condition: "sellable", decision: "restock", locationId: shopA }, NOW + 2 * DAY);
  expect((await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, pad.variantId), eq(stockLevels.locationId, shopA))).get())?.onHand).toBe(1);
  // a unit in another branch's quarantine is not theirs to move; back on sale only at their branch
  await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: second.id, condition: "opened", decision: "refurbish", locationId: holdB }, NOW + 2 * DAY);
  expect(await failureOf(resolveQuarantine(t.db, clerkA, { itemId: second.id, to: "stock", locationId: shopA, reason: "جُدد وفُحص" }, NOW + 3 * DAY))).toMatchObject({ code: "forbidden" });
  const clerkB = await employee("inventory", branchB);
  expect(await failureOf(resolveQuarantine(t.db, clerkB, { itemId: second.id, to: "stock", locationId: shopA, reason: "جُدد وفُحص" }, NOW + 3 * DAY))).toMatchObject({ code: "forbidden" });
  expect(await resolveQuarantine(t.db, clerkB, { itemId: second.id, to: "stock", locationId: shopB, reason: "جُدد وفُحص" }, NOW + 3 * DAY)).toMatchObject({ replayed: false });
});

// ───────────────────────────────────────────────────────────────── 7. closing says what happened

test("an RMA is closed as store credit, exchange, repair or supplier return only when that happened", async () => {
  const pad = await stocked(70_000, 6, 45_000);
  const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
  const rma = await rmaFor(order, [{ line: 0 }]);
  await inspectAll(rma.returnId, "restock");
  const [item] = await itemsOf(rma.returnId);
  const refund = await requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: (await paymentOf(order.orderId)).id, itemIds: [item.id], amountIqd: 70_000, method: "cash", reason: "نقداً للعميل", idempotencyKey: randomToken() }, NOW + 3 * DAY);
  await decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: refund.refundId, approve: true }, NOW + 3 * DAY);
  const close = (resolution: "store_credit" | "exchange" | "repair" | "supplier_return" | "refund") => closeReturn(t.db, as("manager"), rma.returnId, { resolution, note: "انتهى الطلب" }, NOW + 4 * DAY);
  expect(await failureOf(close("store_credit"))).toMatchObject({ code: "invalid", fields: { resolution: "no_store_credit_issued" } });
  expect(await failureOf(close("exchange"))).toMatchObject({ code: "invalid", fields: { resolution: "no_store_credit_issued" } });
  expect(await failureOf(close("repair"))).toMatchObject({ code: "invalid", fields: { resolution: "no_repair_done" } });
  expect(await failureOf(close("supplier_return"))).toMatchObject({ code: "invalid", fields: { resolution: "no_supplier_unit" } });
  expect(await close("refund")).toEqual({ status: "refunded", replayed: false });
});

// ───────────────────────────────────────────────────────────────── 8. partly refunded is not refunded

test("a refund of some returned units keeps the RMA in the refund queue until every returned unit is paid", async () => {
  const pad = await stocked(50_000, 6, 30_000);
  const cable = await stocked(15_000, 6, 6_000);
  const order = await delivered([
    { variantId: pad.variantId, qty: 1 },
    { variantId: cable.variantId, qty: 1 },
  ]);
  const rma = await rmaFor(order, [{ line: 0 }, { line: 1 }]);
  await inspectAll(rma.returnId, "restock");
  const items = await itemsOf(rma.returnId);
  const payment = await paymentOf(order.orderId);
  const queueBefore = (await queueCounts(t.db, as("support"), NOW + 3 * DAY)).refund!;
  const refundOf = async (itemId: string, amountIqd: number) => {
    const asked = await requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: payment.id, itemIds: [itemId], amountIqd, method: "cash", reason: "نقداً", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    await decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: asked.refundId, approve: true }, NOW + 3 * DAY);
  };
  const lineOf = (variantId: string) => order.items.find((line) => line.variantId === variantId)!.id;
  const first = items.find((entry) => entry.orderItemId === lineOf(pad.variantId))!;
  const second = items.find((entry) => entry.orderItemId === lineOf(cable.variantId))!;
  await refundOf(first.id, 50_000);
  expect(await statusOf(rma.returnId)).toBe("inspected");
  expect((await queueCounts(t.db, as("support"), NOW + 3 * DAY)).refund).toBe(queueBefore);
  await refundOf(second.id, 15_000);
  expect(await t.db.select({ status: returns.status, resolution: returns.resolution }).from(returns).where(eq(returns.id, rma.returnId)).get()).toEqual({ status: "refunded", resolution: "refund" });
  expect((await queueCounts(t.db, as("support"), NOW + 3 * DAY)).refund).toBe(queueBefore - 1);
});

test("a closed RMA takes no new refund: closing said nothing is left to do", async () => {
  const pad = await stocked(52_000, 6, 30_000);
  const cable = await stocked(16_000, 6, 6_000);
  const order = await delivered([
    { variantId: pad.variantId, qty: 1 },
    { variantId: cable.variantId, qty: 1 },
  ]);
  const rma = await rmaFor(order, [{ line: 0 }, { line: 1 }]);
  await inspectAll(rma.returnId, "restock");
  const items = await itemsOf(rma.returnId);
  const payment = await paymentOf(order.orderId);
  const lineOf = (variantId: string) => order.items.find((line) => line.variantId === variantId)!.id;
  const first = items.find((entry) => entry.orderItemId === lineOf(pad.variantId))!;
  const second = items.find((entry) => entry.orderItemId === lineOf(cable.variantId))!;
  const refundOf = (itemId: string, amountIqd: number) => requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: payment.id, itemIds: [itemId], amountIqd, method: "cash", reason: "نقداً", idempotencyKey: randomToken() }, NOW + 3 * DAY);
  const asked = await refundOf(first.id, 52_000);
  await decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: asked.refundId, approve: true }, NOW + 3 * DAY);
  // the customer settled for the first unit: the RMA is closed as refunded
  expect(await closeReturn(t.db, as("manager"), rma.returnId, { resolution: "refund", note: "اتفق العميل على قطعة واحدة" }, NOW + 4 * DAY)).toEqual({ status: "refunded", replayed: false });
  expect(await failureOf(refundOf(second.id, 16_000))).toMatchObject({ code: "refund_not_ready" });
  expect((await getReturnDetail(t.db, as("support"), rma.rma, "ar", NOW + 4 * DAY, urls)).can.refund).toBe(false);
});

// ───────────────────────────────────────────────────────────────── 9. the restocking fee is policy

test("a change-of-mind refund keeps the policy's restocking fee: the full value is refused, value − fee is accepted", async () => {
  await savePolicy(t.db, as("manager"), { productKind: "*", itemCondition: "*", isReturnable: true, windowDays: 30, requiresSealed: false, restockingFeeBps: 1000, note: {}, sort: 0, isActive: true, reason: "رسوم إعادة التخزين" }, NOW);
  try {
    const pad = await stocked(80_000, 4, 50_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }], { customerId: await make.customer() });
    const rma = await rmaFor(order, [{ line: 0 }], { reasonCode: "changed_mind" });
    await inspectAll(rma.returnId, "restock");
    const [item] = await itemsOf(rma.returnId);
    const detail = await getReturnDetail(t.db, as("support"), rma.rma, "ar", NOW + 3 * DAY, urls);
    expect(detail.items[0].feeIqd).toBe(8_000);
    expect(detail.refundSuggestion).toMatchObject({ itemsValueIqd: 80_000, feeIqd: 8_000, amountIqd: 72_000 });
    const ask = (amountIqd: number) => requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: detail.payments[0].id, itemIds: [item.id], amountIqd, method: "wallet", reason: "رصيد بعد الرسوم", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    expect(await failureOf(ask(80_000))).toMatchObject({ code: "refund_exceeds_policy", fields: { amountIqd: "refund_exceeds_policy" } });
    expect(await ask(72_000)).toMatchObject({ status: "pending" });
  } finally {
    for (const rule of (await listPolicies(t.db, as("manager"), "ar")).rules) await savePolicy(t.db, as("manager"), { id: rule.id, productKind: rule.productKind as never, itemCondition: rule.itemCondition, isReturnable: rule.isReturnable, windowDays: rule.windowDays, requiresSealed: rule.requiresSealed, restockingFeeBps: rule.restockingFeeBps, note: {}, sort: rule.sort, isActive: false, reason: "تنظيف بعد الاختبار" }, NOW);
  }
});
