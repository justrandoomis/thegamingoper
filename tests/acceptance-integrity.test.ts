/**
 * ACCEPTANCE — business integrity (brief §9, §14):
 *
 *   §14.12  no serial is sold twice, no negative available stock without authorization, no double refund, no
 *           duplicated order or payment on retries — through the services AND, as a backstop, against direct writes
 *   §14.13  all financial numbers reconcile without NaN/Infinity (the daily consistency job finds nothing; the trial
 *           balance balances; profit and loss and cash flow are finite) and audit trails are immutable (append-only
 *           tables refuse UPDATE / DELETE / REPLACE; the hash chain seals and verifies)
 *
 * Everything below goes through the services the store and the admin call — no business row is written by hand — so
 * a consistency finding would be the application's, not the fixture's. Real local D1.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { sealAudit, verifyAuditChain } from "~/server/audit.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, files, orderItemSerials, orderItems, orders, payments, refunds, serials, stockLevels } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { mapDbError } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { listOpenFindings, runJob } from "~/server/jobs.server";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { changeOrderStatus, collectCod, decideRefund, requestRefund, verifyProof } from "~/server/services/admin/orders/actions.server";
import { markPacked, scanCode } from "~/server/services/admin/orders/fulfillment.server";
import { cashFlow, profitAndLoss, trialBalance } from "~/server/services/accounting/reports.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { submitPaymentProof } from "~/server/services/payments/payments.server";
import { creditWallet } from "~/server/services/wallet.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;
const system = systemActor("acceptance.integrity");

let t: TestDb;
let make: Fixtures;
const staff = {} as Record<DefaultRoleKey | "manager2" | "finance2", EmployeeActor>;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "inventory", "fulfillment", "support"] as const) staff[role] = await employee(role);
  staff.manager2 = await employee("manager");
  staff.finance2 = await employee("finance");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(role: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${role} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { kind: "employee", id, permissions: defaultRolePermissions(role), label: role };
}

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

/** The error code a direct database write is refused with (trigger / constraint), or null when it went through. */
async function refusal(write: () => Promise<unknown>): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (error) {
    return mapDbError(error)?.code ?? String((error as Error)?.message ?? error);
  }
}

async function stocked(priceIqd: number, qty: number, unitCostIqd: number, trackSerials = false) {
  const product = await make.product({ priceIqd, trackSerials, kind: trackSerials ? "console" : "game" });
  const numbers = trackSerials ? Array.from({ length: qty }, (_, i) => `INT-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, staff.inventory, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: numbers, ref: `int-${product.sku}` }, NOW);
  return { ...product, serials: numbers ?? [] };
}

async function placed(lines: { variantId: string; qty: number }[], method: CheckoutInput["paymentMethod"], customerId: string | null = null, key = randomToken()) {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return placeOrder(
    t.db,
    { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: key, phone: make.phone(), governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة", addressText: "شارع 62، عمارة 4", marketingConsent: false, paymentMethod: method, expectedTotalIqd: view.totalIqd },
    NOW,
  );
}

/** confirm (COD) → scan every unit → packed → shipped → delivered, by the roles that do it. */
async function fulfil(order: { orderId: string }, codes: string[], cod: boolean) {
  if (cod) await changeOrderStatus(t.db, staff.manager, order.orderId, { to: "confirmed", from: "new" }, NOW + MIN);
  for (const code of codes) expect((await scanCode(t.db, staff.fulfillment, order.orderId, { code, scanId: randomToken(12) }, NOW + 2 * MIN)).ok, code).toBe(true);
  await markPacked(t.db, staff.fulfillment, order.orderId, NOW + 3 * MIN);
  await changeOrderStatus(t.db, staff.fulfillment, order.orderId, { to: "shipped", from: "preparing" }, NOW + HOUR);
  await changeOrderStatus(t.db, staff.fulfillment, order.orderId, { to: "delivered", from: "shipped" }, NOW + 2 * HOUR);
}

const finite = (value: unknown): boolean => {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite);
  if (value && typeof value === "object") return Object.values(value).every(finite);
  return true;
};

let consoleProduct: Awaited<ReturnType<typeof stocked>>;
let soldSerialId = "";

describe("§14.12 no serial sold twice, no negative stock without authorization, no double refund, no duplicates on retry", () => {
  test("acceptance I1: a serial-numbered console is sold once; a second order can neither scan it nor have it written to its line", async () => {
    consoleProduct = await stocked(650_000, 2, 480_000, true);
    const first = await placed([{ variantId: consoleProduct.variantId, qty: 1 }], "cod");
    await fulfil(first, [consoleProduct.serials[0]], true);
    await collectCod(t.db, staff.finance, first.orderId, { amountIqd: first.totalIqd }, NOW + 3 * HOUR);
    soldSerialId = (await t.db.select().from(serials).where(eq(serials.serial, consoleProduct.serials[0])).get())!.id;
    const second = await placed([{ variantId: consoleProduct.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, staff.manager, second.orderId, { to: "confirmed", from: "new" }, NOW + MIN);
    expect((await scanCode(t.db, staff.fulfillment, second.orderId, { code: consoleProduct.serials[0], scanId: randomToken(12) }, NOW + 2 * MIN)).ok).toBe(false);
    // a direct write of the sold serial onto the second order's line is refused by the database
    const line = (await t.db.select().from(orderItems).where(eq(orderItems.orderId, second.orderId)).get())!;
    const code = await refusal(() => t.db.insert(orderItemSerials).values({ orderItemId: line.id, serialId: soldSerialId, attachedAt: NOW }));
    expect(code).toMatch(/SERIAL|UNIQUE|constraint/i);
    expect(await t.db.select().from(orderItemSerials).where(and(eq(orderItemSerials.serialId, soldSerialId), sql`${orderItemSerials.releasedAt} IS NULL`)).all()).toHaveLength(1);
    await changeOrderStatus(t.db, staff.manager, second.orderId, { to: "cancelled", reason: "اختبار القبول" }, NOW + 3 * MIN);
  });

  test("acceptance I2: available stock never goes negative without the oversell authorization — even by a direct write", async () => {
    const game = await stocked(60_000, 1, 40_000);
    const winner = await placed([{ variantId: game.variantId, qty: 1 }], "cod");
    expect(winner.ref).toBeTruthy();
    // the last unit is held: a second shopper cannot even put it in a cart
    expect((await failureOf(addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: game.variantId, qty: 1 }, NOW))).code).toBe("out_of_stock");
    const code = await refusal(() => t.db.update(stockLevels).set({ reserved: 2 }).where(and(eq(stockLevels.variantId, game.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))));
    expect(code).toMatch(/INSUFFICIENT_STOCK/);
    await changeOrderStatus(t.db, staff.manager, winner.orderId, { to: "cancelled", reason: "اختبار القبول" }, NOW + MIN);
  });

  test("acceptance I3: a refund never exceeds what was paid and is never issued twice — through the service and the database", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, staff.finance, { customerId, amountIqd: 500_000, kind: "adjustment", reason: "رصيد فحص القبول", idempotencyKey: `int-${randomToken()}` }, NOW);
    const pad = await stocked(80_000, 5, 50_000);
    const order = await placed([{ variantId: pad.variantId, qty: 2 }], "wallet", customerId);
    await fulfil(order, [pad.sku, pad.sku], false);
    const payment = (await t.db.select().from(payments).where(eq(payments.orderId, order.orderId)).get())!;
    expect((await failureOf(requestRefund(t.db, staff.support, { orderId: order.orderId, paymentId: payment.id, amountIqd: payment.amountIqd + 1, method: "original", reason: "أكثر من المدفوع", idempotencyKey: randomToken(12) }, NOW + 3 * HOUR))).code).toBe("refund_exceeds_payment");
    const key = randomToken(12);
    const asked = await requestRefund(t.db, staff.support, { orderId: order.orderId, paymentId: payment.id, amountIqd: 50_000, method: "original", reason: "خدش في العلبة", idempotencyKey: key }, NOW + 3 * HOUR);
    expect((await requestRefund(t.db, staff.support, { orderId: order.orderId, paymentId: payment.id, amountIqd: 50_000, method: "original", reason: "خدش في العلبة", idempotencyKey: key }, NOW + 3 * HOUR)).replayed).toBe(true);
    expect((await decideRefund(t.db, staff.finance, asked.refundId, { approve: true }, NOW + 4 * HOUR)).status).toBe("paid");
    // deciding it again (a double tap, a second approver) pays nothing more
    await decideRefund(t.db, staff.finance2, asked.refundId, { approve: true }, NOW + 4 * HOUR).catch((error) => toAppError(error));
    expect(await t.db.select().from(refunds).where(eq(refunds.orderId, order.orderId)).all()).toHaveLength(1);
    expect((await t.db.select().from(orders).where(eq(orders.id, order.orderId)).get())!.refundedIqd).toBe(50_000);
    // the rest, and one dinar more: refused
    const left = payment.amountIqd - 50_000;
    expect((await failureOf(requestRefund(t.db, staff.support, { orderId: order.orderId, paymentId: payment.id, amountIqd: left + 1, method: "original", reason: "باقي المبلغ", idempotencyKey: randomToken(12) }, NOW + 5 * HOUR))).code).toBe("refund_exceeds_payment");
    // a refund row written by hand beyond the payment is refused by the trigger
    const code = await refusal(() =>
      t.db.insert(refunds).values({ id: newId("rfd"), orderId: order.orderId, paymentId: payment.id, amountIqd: left + 1, method: "cash", reason: "يدوي", status: "paid", createdBy: staff.owner.id, approvedBy: staff.owner.id, createdAt: NOW + 5 * HOUR, paidAt: NOW + 5 * HOUR } as never),
    );
    expect(code).toMatch(/REFUND_EXCEEDS|ORDER_REFUND_EXCEEDS/);
  });

  test("acceptance I4: the same checkout submitted twice at once is ONE order with ONE payment; a verified transfer is verified once", async () => {
    const pad = await stocked(70_000, 5, 40_000);
    const key = randomToken();
    const [a, b] = await Promise.allSettled([placed([{ variantId: pad.variantId, qty: 1 }], "bank_transfer", null, key), placed([{ variantId: pad.variantId, qty: 1 }], "bank_transfer", null, key)]);
    const refs = new Set([a, b].filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ ref: string }>).value.ref));
    expect(refs.size).toBe(1);
    const order = (await t.db.select().from(orders).where(eq(orders.ref, [...refs][0])).get())!;
    expect(await t.db.select().from(payments).where(eq(payments.orderId, order.id)).all()).toHaveLength(1);
    const fileId = newId("fil");
    await t.db.insert(files).values({ id: fileId, storageKey: `prv_${fileId}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 30_000, sha256: randomToken().toLowerCase(), createdAt: NOW });
    const placedRow = (await t.db.select().from(orders).where(eq(orders.id, order.id)).get())!;
    const token = (a.status === "fulfilled" ? a.value : (b as PromiseFulfilledResult<{ accessToken: string }>).value).accessToken;
    await submitPaymentProof(t.db, { orderRef: placedRow.ref, accessToken: token }, { fileId, declaredAmountIqd: placedRow.totalIqd }, NOW);
    const payment = (await t.db.select().from(payments).where(eq(payments.orderId, order.id)).get())!;
    const [v1, v2] = await Promise.all([verifyProof(t.db, staff.finance, payment.id, { approve: true }, NOW + MIN), verifyProof(t.db, staff.finance, payment.id, { approve: true }, NOW + MIN)].map((p) => p.catch((error) => toAppError(error))));
    expect([v1, v2].filter((v) => v && "status" in (v as object) && (v as { status: string }).status === "paid").length).toBeGreaterThanOrEqual(1);
    expect((await t.db.select().from(orders).where(eq(orders.id, order.id)).get())!.paidIqd).toBe(placedRow.totalIqd);
  });
});

describe("§14.13 financial numbers reconcile without NaN/Infinity; audit trails are immutable", () => {
  test("acceptance I5: after the sales, refunds and cancellations above, the daily consistency check finds nothing", async () => {
    const outcome = await runJob(t.db, "consistency.daily", NOW + 6 * HOUR);
    expect(JSON.stringify(outcome)).not.toMatch(/NaN|Infinity/);
    const findings = await listOpenFindings(t.db, 200);
    expect(findings.map((finding) => `${finding.checkKey}: ${finding.message}`)).toEqual([]);
  });

  test("acceptance I6: the trial balance balances and every report figure is a finite whole number", async () => {
    const tb = await trialBalance(t.db, staff.finance, {});
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    expect(finite(tb)).toBe(true);
    const pl = await profitAndLoss(t.db, staff.finance, {});
    const cf = await cashFlow(t.db, staff.finance, {});
    for (const report of [tb, pl, cf]) {
      expect(finite(report)).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/NaN|Infinity|"\d+\.\d+"/);
    }
    // no fraction of a dinar anywhere in the money tables
    const fractions = await t.d1
      .prepare("SELECT (SELECT count(*) FROM orders WHERE total_iqd <> CAST(total_iqd AS INTEGER)) + (SELECT count(*) FROM journal_lines WHERE debit_iqd <> CAST(debit_iqd AS INTEGER) OR credit_iqd <> CAST(credit_iqd AS INTEGER)) + (SELECT count(*) FROM wallet_ledger WHERE amount_iqd <> CAST(amount_iqd AS INTEGER)) AS n")
      .first<{ n: number }>();
    expect(fractions?.n).toBe(0);
  });

  test("acceptance I7: the audit trail and every append-only ledger refuse UPDATE, DELETE and REPLACE; the hash chain seals and verifies", async () => {
    const [event] = (await t.d1.prepare("SELECT id, seq FROM audit_events ORDER BY seq LIMIT 1").all<{ id: string; seq: number }>()).results;
    expect(event).toBeTruthy();
    for (const statement of [
      `UPDATE audit_events SET summary = 'tampered' WHERE id = '${event.id}'`,
      `DELETE FROM audit_events WHERE id = '${event.id}'`,
      `INSERT OR REPLACE INTO audit_events (seq, id, at, actor_kind, action, entity_type) SELECT seq, id, at, actor_kind, 'x', entity_type FROM audit_events WHERE id = '${event.id}'`,
      "UPDATE journal_lines SET debit_iqd = debit_iqd + 1 WHERE rowid = (SELECT min(rowid) FROM journal_lines)",
      "DELETE FROM wallet_ledger WHERE rowid = (SELECT min(rowid) FROM wallet_ledger)",
      "UPDATE stock_movements SET qty_delta = 99 WHERE rowid = (SELECT min(rowid) FROM stock_movements)",
      "DELETE FROM order_events WHERE rowid = (SELECT min(rowid) FROM order_events)",
    ]) {
      const code = await refusal(() => t.d1.prepare(statement).run());
      expect(code, statement).toMatch(/IMMUTABLE/);
    }
    const sealed = await sealAudit(t.db, NOW + 7 * HOUR);
    expect(sealed.headHash).toBeTruthy();
    const report = await verifyAuditChain(t.db);
    expect(report.ok).toBe(true);
    void system;
  });
});
