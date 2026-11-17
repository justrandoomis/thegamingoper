/**
 * Admin 06 "pos" — money follow-ups (2026-11-13):
 *
 *   1. A CASH REFUND PAID AT THE TILL is a drawer movement (services/admin/pos/refunds.server.ts): the drawer row rides
 *      in the commerce core's own refund batch — issued at once (the owner's threshold), or when a second person
 *      approves at the till — so the shift's expected cash, its blind count and the Z report know it; approved
 *      elsewhere, the drawer records it afterwards, once. Trade-in cash payouts from the drawer (module 13) count in
 *      expected cash and show as their own line.
 *   2. DIGITAL CODES ON TILL SALES (orders/pos-sale.server.ts → assignDigitalCodesStatements): one code per unit in the
 *      sale's batch, exactly like the web checkout; shown at the counter on request (services/admin/pos/codes.server.ts:
 *      its cashier while the shift is open, then a supervisor), audited, never on the receipt, revoked by a refund.
 */
import { and, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { encryptSecret } from "~/server/crypto.server";
import { auditEvents, cashMovements, digitalCodes, employeeRoles, invoices, inventoryLocations, orderItems, orders, payments, posShifts, refunds, settings } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { payoutDrawerKey } from "~/server/services/admin/devices/tradeins.server";
import { revealSaleCode, saleCodes } from "~/server/services/admin/pos/codes.server";
import { saveRegister } from "~/server/services/admin/pos/registers.server";
import { decideTillRefund, drawerOfRefundKey, payTillRefundFromDrawer, requestTillRefund, tillDecisionOf, tillRefundView } from "~/server/services/admin/pos/refunds.server";
import { createSale, getReceipt, type SaleRequestInput } from "~/server/services/admin/pos/sale.server";
import { closeShift, openShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { approveRefund } from "~/server/services/refunds.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.admin-pos-money");
const live = { locale: "ar" as const, storeMode: "live" as const };
const demo = { locale: "ar" as const, storeMode: "demo" as const };
let t: TestDb;
let make: Fixtures;
let storeId: string;
const staff: Partial<Record<"manager" | "manager2" | "finance" | "cashier" | "cashier2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  staff.manager = await employee("manager");
  staff.manager2 = await employee("manager");
  staff.finance = await employee("finance");
  staff.cashier = await employee("cashier");
  staff.cashier2 = await employee("cashier");
  storeId = newId("loc");
  await t.db.insert(inventoryLocations).values({ id: storeId, code: `MONEY-${randomToken(4)}`, name: "Shop", kind: "store", isSellable: true });
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key, branchId: null };
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
    return (toAppError(error) ?? error) as AppError;
  }
  throw new Error("expected a failure");
}
async function threshold(iqd: number) {
  await t.db.insert(settings).values({ key: "refunds.approval_threshold_iqd", value: iqd, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value: iqd } });
}

/** A fresh register at the shop and an open shift of `who` on it. */
async function shiftOf(who: EmployeeActor, float = 50_000): Promise<string> {
  const open = await t.db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.openedBy, who.id), eq(posShifts.status, "open"))).get();
  if (open) await closeShift(t.db, who, { shiftId: open.id, countedCashIqd: 0 }, NOW);
  const register = await saveRegister(t.db, as("manager"), { code: `MN-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`, name: "Till", locationId: storeId, isActive: true }, NOW);
  return (await openShift(t.db, who, { registerId: register.registerId, openingFloatIqd: float, idempotencyKey: randomToken(16) }, NOW)).shiftId;
}
async function stocked(price: number, options: { kind?: "console" | "digital"; qty?: number } = {}) {
  const product = await make.product({ priceIqd: price, kind: options.kind ?? "console" });
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: storeId, qty: options.qty ?? 10, unitCostIqd: Math.floor(price / 2), ref: "test" }, NOW);
  return product;
}
/** Codes for a variant in module 13's store, encrypted as module 13 stores them. */
async function codesFor(variantId: string, values: string[], isDemo = false): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, value] of values.entries()) {
    const id = newId("dco");
    await t.db.insert(digitalCodes).values({ id, variantId, codeEnc: await encryptSecret(value, TEST_VARS.DATA_KEY, `digital_code:${id}`), codeHash: randomToken(), status: "available", isDemo, createdAt: NOW - 1_000 + index });
    ids.push(id);
  }
  return ids;
}
const sale = (shiftId: string, variantId: string, priceIqd: number, qty = 1, extra: Partial<SaleRequestInput> = {}): SaleRequestInput => ({
  idempotencyKey: randomToken(18),
  shiftId,
  customer: null,
  lines: [{ variantId, qty, unitPriceIqd: priceIqd, discountIqd: 0, serials: [] }],
  payments: [{ method: "pos_cash", amountIqd: priceIqd * qty }],
  ...extra,
});
async function cashPaymentOf(ref: string): Promise<{ orderId: string; paymentId: string }> {
  const order = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, ref)).get();
  const payment = await t.db.select({ id: payments.id }).from(payments).where(and(eq(payments.orderId, order!.id), eq(payments.method, "pos_cash"))).get();
  return { orderId: order!.id, paymentId: payment!.id };
}
const ask = (who: EmployeeActor, ref: string, shiftId: string, paymentId: string, amountIqd: number) =>
  requestTillRefund(t.db, who, { ref, shiftId, paymentId, amountIqd, reason: "أعاد العميل القطعة سليمة", idempotencyKey: randomToken(18) }, NOW + 60_000);

// ───────────────────────────────────────────────────────────────── 1. cash refunds at the till

describe("a cash refund paid at the till is a drawer movement", () => {
  test("open shift → sale → cash refund → expected cash: the drawer row rides in the refund's own batch", async () => {
    await threshold(50_000);
    const shiftId = await shiftOf(as("cashier"), 50_000);
    const item = await stocked(100_000);
    const done = await createSale(t.db, as("cashier"), sale(shiftId, item.variantId, 100_000), live, NOW);
    const { orderId, paymentId } = await cashPaymentOf(done.ref);

    // a manager pays 30,000 back from the cashier's drawer (a supervisor may use a drawer at their branch)
    const refund = await ask(as("manager"), done.ref, shiftId, paymentId, 30_000);
    expect(refund).toMatchObject({ status: "paid", replayed: false });
    const row = await t.db.select().from(refunds).where(eq(refunds.id, refund.refundId)).get();
    expect(row).toMatchObject({ orderId, paymentId, amountIqd: 30_000, method: "cash", status: "paid" });
    expect(drawerOfRefundKey(row!.idempotencyKey)).toBe(shiftId);
    const moves = await t.db.select().from(cashMovements).where(eq(cashMovements.idempotencyKey, `refund:${refund.refundId}:drawer`));
    expect(moves).toEqual([expect.objectContaining({ shiftId, kind: "refund", amountIqd: -30_000, orderId, paymentId, reason: "أعاد العميل القطعة سليمة" })]); // the refund's words, never its id
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "pos.cash.refund"), eq(auditEvents.entityId, shiftId)))).toHaveLength(1);

    // the Z report (another supervisor): float 50,000 + sale 100,000 − refund 30,000
    const report = await shiftReport(t.db, as("finance"), shiftId, "ar");
    expect(report.cash).toMatchObject({ expectedIqd: 120_000, salesIqd: 100_000, refundsIqd: -30_000 });
    expect(report.moves.find((move) => move.kind === "refund")).toMatchObject({ amountIqd: -30_000, orderRef: done.ref });
    // the cashier counts what is in the drawer: no difference, nothing to review
    expect(await closeShift(t.db, as("cashier"), { shiftId, countedCashIqd: 120_000 }, NOW + 120_000)).toMatchObject({ needsReview: false });
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).varianceIqd).toBe(0);

    // the same form again is the same refund: nothing twice
    const again = await requestTillRefund(t.db, as("manager"), { ref: done.ref, shiftId, paymentId, amountIqd: 30_000, reason: "أعاد العميل القطعة سليمة", idempotencyKey: row!.idempotencyKey!.split(":").pop()! }, NOW + 60_000);
    expect(again).toMatchObject({ refundId: refund.refundId, replayed: true });
    expect(await t.db.select().from(cashMovements).where(like(cashMovements.idempotencyKey, `refund:${refund.refundId}:%`))).toHaveLength(1);
  });

  test("above the threshold it waits: nothing leaves the drawer until a second person approves at the till — never the one who asked", async () => {
    await threshold(0);
    const shiftId = await shiftOf(as("manager"), 20_000);
    const item = await stocked(60_000);
    const done = await createSale(t.db, as("manager"), sale(shiftId, item.variantId, 60_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    const asked = await ask(as("manager"), done.ref, shiftId, paymentId, 60_000);
    expect(asked.status).toBe("pending");
    expect(await t.db.select().from(cashMovements).where(eq(cashMovements.idempotencyKey, `refund:${asked.refundId}:drawer`))).toHaveLength(0);
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).cash.expectedIqd).toBe(80_000);

    expect((await failureOf(decideTillRefund(t.db, as("manager"), { ref: done.ref, refundId: asked.refundId, approve: true }, NOW + 1))).code).toBe("approver_is_requester");
    const paid = await decideTillRefund(t.db, as("manager2"), { ref: done.ref, refundId: asked.refundId, approve: true, note: "رأيت القطعة" }, NOW + 2);
    expect(paid).toEqual({ status: "paid", fromDrawer: true });
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).cash).toMatchObject({ expectedIqd: 20_000, refundsIqd: -60_000 });
    // the receipt's panel says where the cash left from
    const view = await tillRefundView(t.db, as("manager"), done.ref, "ar");
    expect(view?.refunds.find((entry) => entry.id === asked.refundId)).toMatchObject({ status: "paid", fromDrawer: true, drawer: { shiftId, open: true } });
    expect(view?.cash[0]).toMatchObject({ amountIqd: 60_000, refundableIqd: 0 });
  });

  test("approved outside the till no drawer moved; the drawer records it afterwards, once — by its owner or a supervisor", async () => {
    await threshold(0);
    const shiftId = await shiftOf(as("manager2"), 10_000);
    const item = await stocked(40_000);
    const done = await createSale(t.db, as("manager2"), sale(shiftId, item.variantId, 40_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    const asked = await ask(as("manager2"), done.ref, shiftId, paymentId, 15_000);
    // orders 05 approves it (the core, no drawer)
    await approveRefund(t.db, as("finance"), asked.refundId, { approve: true, note: "من صفحة الطلب" }, NOW + 1);
    expect(await t.db.select().from(cashMovements).where(eq(cashMovements.idempotencyKey, `refund:${asked.refundId}:drawer`))).toHaveLength(0);
    expect((await tillRefundView(t.db, as("manager2"), done.ref, "ar"))?.refunds[0]).toMatchObject({ status: "paid", fromDrawer: false });
    // a cashier of another drawer may not record it
    expect((await failureOf(payTillRefundFromDrawer(t.db, as("cashier2"), { ref: done.ref, refundId: asked.refundId }, NOW + 2))).status).toBe(403);
    expect(await payTillRefundFromDrawer(t.db, as("manager2"), { ref: done.ref, refundId: asked.refundId }, NOW + 3)).toEqual({ replayed: false });
    expect(await payTillRefundFromDrawer(t.db, as("manager2"), { ref: done.ref, refundId: asked.refundId }, NOW + 4)).toEqual({ replayed: true });
    expect((await t.db.select().from(cashMovements).where(eq(cashMovements.idempotencyKey, `refund:${asked.refundId}:drawer`)).get())?.reason).toBe("أعاد العميل القطعة سليمة");
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).cash).toMatchObject({ expectedIqd: 35_000, refundsIqd: -15_000 });
  });

  test("a closed drawer moves nothing: the refund is not issued, and a waiting one is decided on the order instead", async () => {
    await threshold(50_000);
    const shiftId = await shiftOf(as("cashier2"), 10_000);
    const item = await stocked(20_000);
    const done = await createSale(t.db, as("cashier2"), sale(shiftId, item.variantId, 20_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    await closeShift(t.db, as("cashier2"), { shiftId, countedCashIqd: 30_000 }, NOW + 1);
    const refused = await failureOf(ask(as("manager"), done.ref, shiftId, paymentId, 5_000));
    expect(refused).toMatchObject({ code: "till_refund_drawer", fields: { shiftId: "till_refund_drawer" } });
    expect(await t.db.select().from(refunds).where(eq(refunds.paymentId, paymentId))).toHaveLength(0);

    // a waiting till refund whose drawer closed: approving at the till is refused, nothing is issued
    await threshold(0);
    const open = await shiftOf(as("cashier2"), 10_000);
    const second = await createSale(t.db, as("cashier2"), sale(open, item.variantId, 20_000), live, NOW + 2);
    const pay2 = await cashPaymentOf(second.ref);
    const waiting = await ask(as("manager"), second.ref, open, pay2.paymentId, 20_000);
    await closeShift(t.db, as("cashier2"), { shiftId: open, countedCashIqd: 30_000 }, NOW + 3);
    expect((await failureOf(decideTillRefund(t.db, as("manager2"), { ref: second.ref, refundId: waiting.refundId, approve: true }, NOW + 4))).code).toBe("till_refund_drawer");
    expect((await t.db.select().from(refunds).where(eq(refunds.id, waiting.refundId)).get())?.status).toBe("pending");
  });

  test("only cash goes back at the till, never more than the payment has left, never by someone without the rights", async () => {
    await threshold(1_000_000);
    const shiftId = await shiftOf(as("manager"), 0);
    const item = await stocked(50_000);
    const byCard = await createSale(t.db, as("manager"), sale(shiftId, item.variantId, 50_000, 1, { payments: [{ method: "pos_card", amountIqd: 50_000, reference: "SLIP-4471" }] }), live, NOW);
    const order = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, byCard.ref)).get();
    const card = await t.db.select({ id: payments.id }).from(payments).where(eq(payments.orderId, order!.id)).get();
    expect((await failureOf(ask(as("manager"), byCard.ref, shiftId, card!.id, 10_000))).code).toBe("till_refund_not_cash");

    const byCash = await createSale(t.db, as("manager"), sale(shiftId, item.variantId, 50_000), live, NOW);
    const { paymentId } = await cashPaymentOf(byCash.ref);
    expect((await failureOf(ask(as("manager"), byCash.ref, shiftId, paymentId, 50_001))).code).toBe("refund_exceeds_payment");
    expect((await failureOf(ask(as("manager"), byCash.ref, shiftId, paymentId, 0))).fields).toMatchObject({ amountIqd: "too_small" });
    // a cashier holds neither pos.sale.refund nor orders.refund.create
    expect((await failureOf(ask(as("cashier"), byCash.ref, shiftId, paymentId, 1_000))).status).toBe(403);
    // finance approves refunds but does not sell or refund at the till
    expect((await failureOf(ask(as("finance"), byCash.ref, shiftId, paymentId, 1_000))).status).toBe(403);
    // a web order is not a till sale
    const web = await make.order([{ variantId: item.variantId, sku: item.sku, priceIqd: 50_000 }]);
    expect((await failureOf(ask(as("manager"), web.ref, shiftId, paymentId, 1_000))).status).toBe(404);
    expect(await t.db.select().from(cashMovements).where(and(eq(cashMovements.shiftId, shiftId), eq(cashMovements.kind, "refund")))).toHaveLength(0);
  });

  test("a cash trade-in payout taken from the drawer (module 13) counts in expected cash and shows as its own line", async () => {
    const shiftId = await shiftOf(as("cashier"), 300_000);
    const tradeInId = newId("tin");
    // exactly the row module 13's payOut({ shiftId }) writes in its payout batch (tests/admin-devices-followup.test.ts)
    await t.db.insert(cashMovements).values({ id: newId("cmv"), shiftId, kind: "pay_out", amountIqd: -120_000, reason: "trade_in TI-TEST01", actorKind: "employee", actorId: as("cashier").id, idempotencyKey: payoutDrawerKey(tradeInId), at: NOW });
    const report = await shiftReport(t.db, as("finance"), shiftId, "ar");
    expect(report.cash).toMatchObject({ expectedIqd: 180_000, payOutIqd: -120_000, tradeInIqd: -120_000 });
    expect(report.moves[0]).toMatchObject({ kind: "pay_out", tradeIn: true });
    // the drawer's owner sees their own move, never the expected total
    const own = await shiftReport(t.db, as("cashier"), shiftId, "ar");
    expect(own.cash.expectedIqd).toBeNull();
    expect(own.moves.map((move) => move.tradeIn)).toEqual([true]);
  });
});

// ───────────────────────────────────────────────────────────────── 2. digital codes on till sales

describe("digital codes on till sales", () => {
  test("a till sale takes one code per unit in its own batch; a demo sale demo codes only; too few codes leave the rest pending", async () => {
    const shiftId = await shiftOf(as("cashier"), 0);
    const card = await stocked(25_000, { kind: "digital" });
    const real = await codesFor(card.variantId, ["PSN-AAAA-0001", "PSN-AAAA-0002", "PSN-AAAA-0003"]);
    await codesFor(card.variantId, ["PSN-DEMO-0001"], true);

    const two = await createSale(t.db, as("cashier"), sale(shiftId, card.variantId, 25_000, 2), live, NOW);
    expect(two.codes).toEqual({ lines: 1, delivered: 2, pending: 0 });
    const order = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, two.ref)).get();
    const item = await t.db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, order!.id)).get();
    const delivered = await t.db.select().from(digitalCodes).where(eq(digitalCodes.orderItemId, item!.id));
    // soonest expiry first, then oldest: the first two real codes, never the demo one
    expect(delivered.map((code) => code.id).sort()).toEqual(real.slice(0, 2).sort());
    expect(delivered.every((code) => code.status === "delivered" && code.deliveredAt === NOW && !code.isDemo)).toBe(true);
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "orders.digital_code.deliver"), eq(auditEvents.entityId, order!.id)))).toHaveLength(1);

    const inDemo = await createSale(t.db, as("cashier"), sale(shiftId, card.variantId, 25_000, 1), demo, NOW);
    const demoOrder = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, inDemo.ref)).get();
    const demoItem = await t.db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, demoOrder!.id)).get();
    expect((await t.db.select().from(digitalCodes).where(eq(digitalCodes.orderItemId, demoItem!.id))).map((code) => code.isDemo)).toEqual([true]);

    // one real code left for three units: the sale goes through, two units wait for module 13
    const short = await createSale(t.db, as("cashier"), sale(shiftId, card.variantId, 25_000, 3), live, NOW);
    expect(short.codes).toEqual({ lines: 1, delivered: 1, pending: 2 });
    // a sale without code lines says nothing about codes
    const plain = await stocked(9_000);
    expect((await createSale(t.db, as("cashier"), sale(shiftId, plain.variantId, 9_000), live, NOW)).codes).toBeNull();
  });

  test("the cashier shows a code at the counter while the shift is open — audited, never on the receipt; then only a supervisor", async () => {
    const shiftId = await shiftOf(as("cashier2"), 0);
    const card = await stocked(30_000, { kind: "digital" });
    await codesFor(card.variantId, ["XBX-GIFT-7788"]);
    const done = await createSale(t.db, as("cashier2"), sale(shiftId, card.variantId, 30_000), live, NOW);
    const view = await saleCodes(t.db, as("cashier2"), done.ref, "ar");
    expect(view).toMatchObject({ canReveal: true, revealBlocked: null });
    const codeId = view.lines[0]!.codes[0]!.id;
    expect(JSON.stringify(view)).not.toContain("XBX-GIFT-7788");

    const shown = await revealSaleCode(t.db, TEST_VARS.DATA_KEY, as("cashier2"), { ref: done.ref, codeId }, NOW + 1);
    expect(shown).toEqual({ codeId, code: "XBX-GIFT-7788" });
    const reveal = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "orders.digital_code.reveal"), eq(auditEvents.entityId, codeId))).get();
    expect(reveal).toMatchObject({ actorKind: "employee", actorId: as("cashier2").id });
    expect(JSON.stringify(reveal)).not.toContain("XBX-GIFT-7788");
    expect((await t.db.select().from(digitalCodes).where(eq(digitalCodes.id, codeId)).get())).toMatchObject({ revealedAt: NOW + 1, revealCount: 1 });

    // the receipt — stored and as it prints — never carries the code
    const order = await t.db.select({ id: orders.id }).from(orders).where(eq(orders.ref, done.ref)).get();
    const stored = await t.db.select().from(invoices).where(eq(invoices.orderId, order!.id)).get();
    expect(JSON.stringify(stored)).not.toContain("XBX-GIFT-7788");
    expect(JSON.stringify(await getReceipt(t.db, as("manager"), done.ref, "ar"))).not.toContain("XBX-GIFT-7788");

    // another cashier cannot open this sale at all
    expect((await failureOf(revealSaleCode(t.db, TEST_VARS.DATA_KEY, as("cashier"), { ref: done.ref, codeId }, NOW + 2))).code).toBe("not_found");
    // after the shift: the cashier is told a supervisor shows it; a supervisor can
    await closeShift(t.db, as("cashier2"), { shiftId, countedCashIqd: 30_000 }, NOW + 3);
    expect(await saleCodes(t.db, as("cashier2"), done.ref, "ar")).toMatchObject({ canReveal: false, revealBlocked: "shift_closed" });
    expect((await failureOf(revealSaleCode(t.db, TEST_VARS.DATA_KEY, as("cashier2"), { ref: done.ref, codeId }, NOW + 4))).code).toBe("code_reveal_closed");
    expect((await revealSaleCode(t.db, TEST_VARS.DATA_KEY, as("manager"), { ref: done.ref, codeId }, NOW + 5)).code).toBe("XBX-GIFT-7788");
    // a code id of another order looks like one that does not exist
    expect((await failureOf(revealSaleCode(t.db, TEST_VARS.DATA_KEY, as("manager"), { ref: done.ref, codeId: newId("dco") }, NOW + 6))).code).toBe("not_found");
  });

  test("a refund of the sale at the till revokes its codes: a revoked code is never shown again", async () => {
    await threshold(1_000_000);
    const shiftId = await shiftOf(as("manager"), 0);
    const card = await stocked(15_000, { kind: "digital" });
    await codesFor(card.variantId, ["NSW-ESHOP-1234"]);
    const done = await createSale(t.db, as("manager"), sale(shiftId, card.variantId, 15_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    const codeId = (await saleCodes(t.db, as("manager"), done.ref, "ar")).lines[0]!.codes[0]!.id;
    // the whole cash back from the drawer: the order is refunded in full, its codes go with it (the core's batch)
    expect((await ask(as("manager"), done.ref, shiftId, paymentId, 15_000)).status).toBe("paid");
    expect((await t.db.select().from(digitalCodes).where(eq(digitalCodes.id, codeId)).get())?.status).toBe("revoked");
    expect((await failureOf(revealSaleCode(t.db, TEST_VARS.DATA_KEY, as("manager"), { ref: done.ref, codeId }, NOW + 1))).code).toBe("code_not_revealable");
    expect((await saleCodes(t.db, as("manager"), done.ref, "ar")).lines[0]!.codes[0]!.status).toBe("revoked");
  });
});

// ───────────────────────────────────────────────────────────────── review 2026-11-17: adversarial

describe("till refunds: adversarial (review 2026-11-17)", () => {
  test("the form's decision is approve or reject; anything else is refused, never read as a rejection", () => {
    expect(tillDecisionOf("approve")).toBe(true);
    expect(tillDecisionOf("reject")).toBe(false);
    for (const junk of ["", "Approve", "yes", "1", null, undefined, ["approve"]]) expect(tillDecisionOf(junk)).toBeNull();
  });

  test("two approvals of a waiting till refund at once, and a late drawer record racing them: the cash leaves the drawer once", async () => {
    await threshold(0);
    const shiftId = await shiftOf(as("manager"), 0);
    const item = await stocked(70_000);
    const done = await createSale(t.db, as("manager"), sale(shiftId, item.variantId, 70_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    const asked = await ask(as("manager"), done.ref, shiftId, paymentId, 70_000);
    await Promise.allSettled([
      decideTillRefund(t.db, as("manager2"), { ref: done.ref, refundId: asked.refundId, approve: true }, NOW + 1),
      decideTillRefund(t.db, as("manager2"), { ref: done.ref, refundId: asked.refundId, approve: true }, NOW + 1),
      payTillRefundFromDrawer(t.db, as("manager"), { ref: done.ref, refundId: asked.refundId }, NOW + 2),
    ]);
    expect(await t.db.select().from(cashMovements).where(and(eq(cashMovements.shiftId, shiftId), eq(cashMovements.kind, "refund")))).toHaveLength(1);
    expect((await shiftReport(t.db, as("finance"), shiftId, "ar")).cash).toMatchObject({ expectedIqd: 0, refundsIqd: -70_000 });
  });

  test("refund forms racing for the whole payment: never more back than the payment, the drawer moves exactly what was paid", async () => {
    await threshold(1_000_000);
    const shiftId = await shiftOf(as("manager"), 0);
    const item = await stocked(45_000);
    const done = await createSale(t.db, as("manager"), sale(shiftId, item.variantId, 45_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    await Promise.allSettled([ask(as("manager"), done.ref, shiftId, paymentId, 45_000), ask(as("manager"), done.ref, shiftId, paymentId, 45_000), ask(as("manager2"), done.ref, shiftId, paymentId, 30_000)]);
    const paid = await t.db.select().from(refunds).where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, "paid")));
    const paidIqd = paid.reduce((sum, row) => sum + row.amountIqd, 0);
    expect(paidIqd).toBeGreaterThan(0);
    expect(paidIqd).toBeLessThanOrEqual(45_000);
    const out = await t.db.select().from(cashMovements).where(and(eq(cashMovements.shiftId, shiftId), eq(cashMovements.kind, "refund")));
    expect(out.reduce((sum, row) => sum - row.amountIqd, 0)).toBe(paidIqd);
  });

  test("a drawer that is not yours, an unknown or forged shift id: nothing is issued", async () => {
    await threshold(1_000_000);
    const shiftId = await shiftOf(as("manager"), 0);
    const item = await stocked(12_000);
    const done = await createSale(t.db, as("manager"), sale(shiftId, item.variantId, 12_000), live, NOW);
    const { paymentId } = await cashPaymentOf(done.ref);
    // a cashier granted the refund rights still cannot pay out of the manager's drawer (not theirs, no pos.shift.review)
    const granted: EmployeeActor = { ...as("cashier2"), permissions: [...as("cashier2").permissions, "pos.sale.refund", "orders.refund.create"] as EmployeeActor["permissions"] };
    expect((await failureOf(ask(granted, done.ref, shiftId, paymentId, 5_000))).code).toBe("till_refund_drawer");
    expect((await failureOf(ask(as("manager"), done.ref, "shf_doesnotexist", paymentId, 5_000))).code).toBe("till_refund_drawer");
    expect((await failureOf(ask(as("manager"), done.ref, "x'; DROP TABLE refunds; --", paymentId, 5_000))).status).toBe(400);
    expect(await t.db.select().from(refunds).where(eq(refunds.paymentId, paymentId))).toHaveLength(0);
  });
});
