/**
 * app/server/services/orders/edit.server.ts — editing an order before it ships (admin 05.05), a commerce-core file
 * built for the orders module. Real local D1 (tests/helpers/db.ts). What must hold:
 *
 *   · the preview (planOrderEdit) writes nothing and says exactly what editOrder then does
 *   · stock: the hold follows the new quantities per stocked variant (bundles = components), newest holds released
 *     first with 'release' movements; more units need free stock (a shortage aborts everything); a removed used
 *     device is listed again
 *   · money: totals satisfy the CHECKs, the open payment (COD / awaited transfer) asks for the new total, a coupon is
 *     recomputed by its own rule and voided when it no longer applies; a PAID order's lines and total never change
 *   · refusals: payment under review, refunds, scanned serials, packed parcels, nothing changed, nothing left, a
 *     role without orders.order.update; a stale preview (totals_changed); every refusal writes nothing
 *   · idempotency: the same key twice (also in parallel) edits once; history: an order event and an audit event
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import {
  auditEvents,
  bundleItems,
  couponRedemptions,
  coupons,
  files,
  invoices,
  orderEvents,
  orderItems,
  orders,
  payments,
  stockLevels,
  stockMovements,
  stockReservations,
  usedUnits,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions } from "~/server/permissions";
import { issueInvoices } from "~/server/services/admin/orders/documents.server";
import { scanCode } from "~/server/services/admin/orders/fulfillment.server";
import { addToCart, applyCoupon, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { editLineFloors, editOrder, orderEditBlockers, planOrderEdit } from "~/server/services/orders/edit.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { submitPaymentProof } from "~/server/services/payments/payments.server";
import { creditWallet } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const system = systemActor("test.orders-edit");
let t: TestDb;
let make: Fixtures;
let manager: EmployeeActor;
let support: EmployeeActor;
let fulfillment: EmployeeActor;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  manager = { kind: "employee", id: await make.employee(), permissions: defaultRolePermissions("manager") };
  support = { kind: "employee", id: await make.employee(), permissions: defaultRolePermissions("support") };
  fulfillment = { kind: "employee", id: await make.employee(), permissions: defaultRolePermissions("fulfillment") };
});
afterAll(async () => {
  await t?.dispose();
});

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

async function stocked(priceIqd: number, qty: number, options: { trackSerials?: boolean } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials });
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `ED-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd: Math.round(priceIqd * 0.6), serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  return { ...product, serials: serialNumbers ?? [] };
}

async function placed(lines: ({ variantId: string; qty: number } | { usedUnitId: string; qty: number })[], method: CheckoutInput["paymentMethod"], options: { customerId?: string | null; coupon?: string } = {}) {
  const customerId = options.customerId ?? null;
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "ar" }, line, NOW)).cartToken;
  if (options.coupon) await applyCoupon(t.db, { cartToken: token, customerId, locale: "ar" }, options.coupon, NOW);
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return placeOrder(
    t.db,
    { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" },
    {
      idempotencyKey: randomToken(),
      phone: make.phone(),
      governorateId: governorateId("baghdad"),
      districtId: districtId("baghdad", "karrada"),
      areaText: "الكرادة",
      addressText: "شارع 62، قرب الجسر، عمارة 4",
      marketingConsent: false,
      paymentMethod: method,
      expectedTotalIqd: view.totalIqd,
    },
    NOW,
  );
}

const level = (variantId: string) =>
  t.db
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)))
    .get();
const items = (orderId: string) => t.db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).all();
const order = async (orderId: string) => (await t.db.select().from(orders).where(eq(orders.id, orderId)).get())!;
const heldFor = async (orderId: string, variantId: string) =>
  Number(
    (
      await t.db
        .select({ n: sql<number>`coalesce(sum(${stockReservations.qty}), 0)` })
        .from(stockReservations)
        .where(and(eq(stockReservations.orderId, orderId), eq(stockReservations.variantId, variantId), eq(stockReservations.status, "active")))
        .get()
    )?.n ?? 0,
  );
const key = () => randomToken(18);

describe("quantities before shipping", () => {
  test("down: the preview writes nothing; the edit updates lines, totals, the COD amount due and releases the stock — once", async () => {
    const pad = await stocked(60_000, 10);
    const game = await stocked(40_000, 10);
    const placedOrder = await placed(
      [
        { variantId: pad.variantId, qty: 3 },
        { variantId: game.variantId, qty: 1 },
      ],
      "cod",
    );
    const [padLine, gameLine] = (await items(placedOrder.orderId)).sort((a, b) => (a.variantId === pad.variantId ? -1 : b.variantId === pad.variantId ? 1 : 0));
    const before = await level(pad.variantId);
    const edit = { lines: [{ orderItemId: padLine.id, qty: 1 }], reason: "العميل يريد قطعة واحدة" };

    const plan = await planOrderEdit(t.db, manager, placedOrder.orderId, edit);
    expect(plan.before.totalIqd).toBe(3 * 60_000 + 40_000 + 5000);
    expect(plan.after).toEqual({ subtotalIqd: 60_000 + 40_000, discountIqd: 0, shippingIqd: 5000, taxIqd: 0, totalIqd: 105_000 });
    expect(plan.stock).toEqual([{ variantId: pad.variantId, sku: pad.sku, deltaQty: -2 }]);
    expect(plan.payment).toMatchObject({ method: "cod", fromIqd: 225_000, toIqd: 105_000 });
    expect((await level(pad.variantId))?.reserved).toBe(before?.reserved); // the preview wrote nothing

    const k = key();
    const done = await editOrder(t.db, manager, placedOrder.orderId, { ...edit, idempotencyKey: k, expectedTotalIqd: plan.after.totalIqd }, NOW);
    expect(done).toMatchObject({ replayed: false, totalIqd: 105_000 });
    expect((await editOrder(t.db, manager, placedOrder.orderId, { ...edit, idempotencyKey: k, expectedTotalIqd: plan.after.totalIqd }, NOW)).replayed).toBe(true);

    const row = await order(placedOrder.orderId);
    expect([row.subtotalIqd, row.totalIqd]).toEqual([100_000, 105_000]);
    expect((await items(placedOrder.orderId)).find((item) => item.id === padLine.id)).toMatchObject({ qty: 1, totalIqd: 60_000 });
    expect((await items(placedOrder.orderId)).find((item) => item.id === gameLine.id)).toMatchObject({ qty: 1 });
    const payment = await t.db.select().from(payments).where(eq(payments.orderId, placedOrder.orderId)).get();
    expect(payment).toMatchObject({ status: "pending", amountIqd: 105_000 });
    expect((await level(pad.variantId))?.reserved).toBe(before!.reserved - 2);
    expect(await heldFor(placedOrder.orderId, pad.variantId)).toBe(1);
    const releases = await t.db
      .select()
      .from(stockMovements)
      .where(and(eq(stockMovements.refId, placedOrder.orderId), eq(stockMovements.kind, "release")))
      .all();
    expect(releases.reduce((sum, row) => sum + row.reservedDelta, 0)).toBe(-2);
    expect(releases[0].reason).toContain("order_edited");
    const events = await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, placedOrder.orderId), eq(orderEvents.kind, "edited"))).all();
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ totalBefore: 225_000, totalAfter: 105_000, reason: edit.reason });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "orders.order.edit"), eq(auditEvents.entityId, placedOrder.orderId))).all();
    expect(audit).toHaveLength(1);
  });

  test("up: more units are held from free stock; a shortage aborts the whole edit and writes nothing", async () => {
    const pad = await stocked(50_000, 3);
    const placedOrder = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const [line] = await items(placedOrder.orderId);
    await editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 2 }], reason: "أضاف قطعة هاتفياً", idempotencyKey: key() }, NOW);
    expect(await heldFor(placedOrder.orderId, pad.variantId)).toBe(2);
    expect((await order(placedOrder.orderId)).totalIqd).toBe(105_000);
    const snapshot = { level: await level(pad.variantId), total: (await order(placedOrder.orderId)).totalIqd };
    expect(await failureOf(editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 4 }], reason: "أكثر مما في المخزن", idempotencyKey: key() }, NOW))).toMatchObject({ code: "insufficient_stock" });
    expect(await level(pad.variantId)).toEqual(snapshot.level);
    expect((await order(placedOrder.orderId)).totalIqd).toBe(snapshot.total);
  });

  test("a removed line is deleted and its hold released; a bundle's components follow; nothing left → refused", async () => {
    const a = await stocked(30_000, 10);
    const b = await stocked(20_000, 10);
    const bundle = await make.product({ priceIqd: 45_000 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: a.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: b.variantId, qty: 2 },
    ]);
    const placedOrder = await placed(
      [
        { variantId: bundle.variantId, qty: 2 },
        { variantId: a.variantId, qty: 1 },
      ],
      "cod",
    );
    expect(await heldFor(placedOrder.orderId, a.variantId)).toBe(3);
    expect(await heldFor(placedOrder.orderId, b.variantId)).toBe(4);
    const lines = await items(placedOrder.orderId);
    const bundleLine = lines.find((line) => line.variantId === bundle.variantId)!;
    const plainLine = lines.find((line) => line.variantId === a.variantId)!;
    const plan = await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: bundleLine.id, qty: 1 }, { orderItemId: plainLine.id, qty: 0 }], reason: "تعديل الحزمة" });
    expect(plan.stock.sort((x, y) => x.sku.localeCompare(y.sku))).toEqual([
      { variantId: a.variantId, sku: a.sku, deltaQty: -2 },
      { variantId: b.variantId, sku: b.sku, deltaQty: -2 },
    ]);
    await editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: bundleLine.id, qty: 1 }, { orderItemId: plainLine.id, qty: 0 }], reason: "تعديل الحزمة", idempotencyKey: key() }, NOW);
    expect((await items(placedOrder.orderId)).map((line) => [line.variantId, line.qty])).toEqual([[bundle.variantId, 1]]);
    expect(await heldFor(placedOrder.orderId, a.variantId)).toBe(1);
    expect(await heldFor(placedOrder.orderId, b.variantId)).toBe(2);
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: bundleLine.id, qty: 0 }], reason: "احذف كل شيء" }))).toMatchObject({ code: "edit_empty_order" });
  });

  test("a removed used device goes back on sale; its quantity is 1 or 0", async () => {
    const base = await make.product({ priceIqd: 400_000, kind: "console" });
    const unitId = newId("usd");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used"), variantId: base.variantId, grade: "A", priceIqd: 350_000, acquisitionCostIqd: 250_000, status: "listed", isDemo: true, createdAt: NOW, updatedAt: NOW });
    const pad = await stocked(25_000, 5);
    const placedOrder = await placed(
      [
        { usedUnitId: unitId, qty: 1 },
        { variantId: pad.variantId, qty: 1 },
      ],
      "cod",
    );
    expect((await t.db.select({ status: usedUnits.status }).from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("reserved");
    const usedLine = (await items(placedOrder.orderId)).find((line) => line.usedUnitId === unitId)!;
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: usedLine.id, qty: 2 }], reason: "قطعتان" }))).toMatchObject({ code: "edit_used_unit_qty" });
    const plan = await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: usedLine.id, qty: 0 }], reason: "لم يعد يريده" });
    expect(plan.usedUnitsReleased).toEqual([unitId]);
    await editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: usedLine.id, qty: 0 }], reason: "لم يعد يريده", idempotencyKey: key() }, NOW);
    expect((await t.db.select({ status: usedUnits.status }).from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("listed");
    expect((await order(placedOrder.orderId)).totalIqd).toBe(25_000 + 5000);
  });

  test("a coupon is recomputed by its own rule, and voided when the order falls below its minimum", async () => {
    const pad = await stocked(100_000, 10);
    const code = `TEN${make.next("c").replace(/\W/g, "")}`.toUpperCase();
    const couponId = newId("cpn");
    await t.db.insert(coupons).values({ id: couponId, code, kind: "percent", value: 1000, minSubtotalIqd: 150_000, isActive: true, createdAt: NOW });
    const placedOrder = await placed([{ variantId: pad.variantId, qty: 3 }], "cod", { coupon: code });
    expect((await order(placedOrder.orderId)).discountIqd).toBe(30_000);
    const [line] = await items(placedOrder.orderId);
    const two = await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 2 }], reason: "قطعتان" });
    expect(two.coupon).toEqual({ code, beforeIqd: 30_000, afterIqd: 20_000, lost: false });
    expect(two.after.totalIqd).toBe(200_000 - 20_000 + 5000);
    const one = await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 1 }], reason: "قطعة" });
    expect(one.coupon).toMatchObject({ afterIqd: 0, lost: true });
    await editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 1 }], reason: "قطعة", idempotencyKey: key(), expectedTotalIqd: one.after.totalIqd }, NOW);
    const redemption = await t.db.select().from(couponRedemptions).where(eq(couponRedemptions.orderId, placedOrder.orderId)).get();
    expect(redemption?.voidedAt).toBe(NOW);
    const row = await order(placedOrder.orderId);
    expect([row.discountIqd, row.totalIqd]).toEqual([0, 105_000]);
  });
});

describe("refusals write nothing", () => {
  test("a paid order's lines and total never change; its address may, when the fee stays the same", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 500_000, kind: "topup", reason: "شحن", idempotencyKey: `topup:${customerId}`, fundedBy: "cash" }, NOW);
    const pad = await stocked(70_000, 10);
    const paid = await placed([{ variantId: pad.variantId, qty: 2 }], "wallet", { customerId });
    const [line] = await items(paid.orderId);
    expect(await failureOf(planOrderEdit(t.db, manager, paid.orderId, { lines: [{ orderItemId: line.id, qty: 1 }], reason: "أقل" }))).toMatchObject({ code: "edit_paid_order" });
    const address = { contactName: "سارة", phone: "0771 234 5678", governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة خارج", addressText: "شارع 52، بيت 7، قرب الصيدلية" };
    await editOrder(t.db, manager, paid.orderId, { address, reason: "عنوان أدق", idempotencyKey: key() }, NOW);
    const row = await order(paid.orderId);
    expect(row).toMatchObject({ contactName: "سارة", contactPhoneE164: "+9647712345678", areaText: "الكرادة خارج", totalIqd: 145_000 });
    expect(await failureOf(editOrder(t.db, manager, paid.orderId, { address: { ...address, districtId: districtId("basra", "zubair") }, reason: "قضاء خطأ", idempotencyKey: key() }, NOW))).toMatchObject({
      code: "invalid",
      fields: { districtId: "district_invalid" },
    });
    expect(await failureOf(editOrder(t.db, manager, paid.orderId, { address: { ...address, phone: "12" }, reason: "رقم خطأ", idempotencyKey: key() }, NOW))).toMatchObject({ fields: { phone: "phone_invalid" } });
    expect(await failureOf(editOrder(t.db, manager, paid.orderId, { address, reason: "لا شيء", idempotencyKey: key() }, NOW))).toMatchObject({ code: "edit_no_change" });
  });

  test("a transfer awaiting a proof can change (the amount due follows); once the proof is in review it cannot", async () => {
    const pad = await stocked(80_000, 10);
    const transfer = await placed([{ variantId: pad.variantId, qty: 2 }], "bank_transfer");
    const [line] = await items(transfer.orderId);
    await editOrder(t.db, manager, transfer.orderId, { lines: [{ orderItemId: line.id, qty: 1 }], reason: "قطعة واحدة", idempotencyKey: key() }, NOW);
    const payment = await t.db.select().from(payments).where(eq(payments.orderId, transfer.orderId)).get();
    expect(payment).toMatchObject({ status: "pending", amountIqd: 85_000 });
    // the hold keeps the transfer's proof window
    const holds = await t.db.select({ expiresAt: stockReservations.expiresAt }).from(stockReservations).where(and(eq(stockReservations.orderId, transfer.orderId), eq(stockReservations.status, "active"))).all();
    expect(holds.every((row) => row.expiresAt !== null)).toBe(true);
    const fileId = newId("fil");
    await t.db.insert(files).values({ id: fileId, storageKey: `prv_${fileId}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 100, sha256: randomToken(), createdAt: NOW });
    await submitPaymentProof(t.db, { orderRef: transfer.ref, accessToken: transfer.accessToken }, { fileId, declaredAmountIqd: 85_000 }, NOW);
    expect(await failureOf(planOrderEdit(t.db, manager, transfer.orderId, { lines: [{ orderItemId: line.id, qty: 2 }], reason: "رجع لقطعتين" }))).toMatchObject({ code: "edit_payment_in_review" });
  });

  test("scanned serials, packed parcels, roles, a stale preview", async () => {
    const console5 = await stocked(500_000, 3, { trackSerials: true });
    const pad = await stocked(20_000, 10);
    const placedOrder = await placed(
      [
        { variantId: console5.variantId, qty: 2 },
        { variantId: pad.variantId, qty: 2 },
      ],
      "cod",
    );
    const lines = await items(placedOrder.orderId);
    const consoleLine = lines.find((line) => line.variantId === console5.variantId)!;
    const padLine = lines.find((line) => line.variantId === pad.variantId)!;
    expect(await failureOf(planOrderEdit(t.db, support, placedOrder.orderId, { lines: [{ orderItemId: padLine.id, qty: 1 }], reason: "أقل" }))).toMatchObject({ code: "forbidden" });
    // stale preview: the employee saw a total, someone changed the order since
    expect(await failureOf(editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: padLine.id, qty: 1 }], reason: "أقل", idempotencyKey: key(), expectedTotalIqd: 1 }, NOW))).toMatchObject({ code: "totals_changed" });
    await t.db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, placedOrder.orderId));
    expect((await scanCode(t.db, fulfillment, placedOrder.orderId, { code: console5.serials[0], scanId: randomToken(12) }, NOW)).ok).toBe(true);
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: consoleLine.id, qty: 1 }], reason: "جهاز واحد" }))).toMatchObject({ code: "edit_serials_attached" });
    // the pad line may still change while nothing is packed
    const plan = await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: padLine.id, qty: 1 }], reason: "قطعة" });
    expect(plan.after.totalIqd).toBe(2 * 500_000 + 20_000 + 5000);
    await t.db.run(sql`UPDATE shipments SET status = 'packed' WHERE order_id = ${placedOrder.orderId}`);
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: padLine.id, qty: 1 }], reason: "قطعة" }))).toMatchObject({ code: "edit_parcel_packed" });
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: newId("oit"), qty: 1 }], reason: "سطر غريب" }))).toMatchObject({ code: "invalid" });
  });

  test("the same edit sent twice at once edits once", async () => {
    const pad = await stocked(10_000, 20);
    const placedOrder = await placed([{ variantId: pad.variantId, qty: 5 }], "cod");
    const [line] = await items(placedOrder.orderId);
    const k = key();
    const results = await Promise.all([1, 2].map(() => editOrder(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 3 }], reason: "مرتان", idempotencyKey: k }, NOW)));
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await heldFor(placedOrder.orderId, pad.variantId)).toBe(3);
    const events = await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, placedOrder.orderId), eq(orderEvents.kind, "edited"))).all();
    expect(events).toHaveLength(1);
  });

  test("once an invoice is issued its lines and total stay as invoiced; the address (same fee) may still change", async () => {
    const pad = await stocked(60_000, 10);
    const placedOrder = await placed([{ variantId: pad.variantId, qty: 2 }], "cod");
    await t.db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, placedOrder.orderId));
    expect((await issueInvoices(t.db, manager, [placedOrder.orderId], NOW)).issued).toBe(1);
    const [line] = await items(placedOrder.orderId);
    // the courier would collect 65,000 against an invoice of 125,000
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 1 }], reason: "قطعة واحدة" }))).toMatchObject({ code: "edit_invoiced", status: 409 });
    expect(await orderEditBlockers(t.db, await order(placedOrder.orderId))).toEqual({ lines: "edit_invoiced", address: null });
    const address = { contactName: "حيدر", phone: "0772 345 6789", governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة خارج", addressText: "شارع 52، بيت 7، قرب الصيدلية" };
    await editOrder(t.db, manager, placedOrder.orderId, { address, reason: "عنوان أدق", idempotencyKey: key() }, NOW);
    const invoice = await t.db.select().from(invoices).where(eq(invoices.orderId, placedOrder.orderId)).get();
    expect(invoice?.totalIqd).toBe((await order(placedOrder.orderId)).totalIqd);
  });

  test("units already verified at the packing station are not edited away (the parcel holds them)", async () => {
    const pad = await stocked(20_000, 10);
    const game = await stocked(9_000, 10);
    const placedOrder = await placed(
      [
        { variantId: pad.variantId, qty: 3 },
        { variantId: game.variantId, qty: 1 },
      ],
      "cod",
    );
    await t.db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, placedOrder.orderId));
    for (let i = 0; i < 2; i++) expect((await scanCode(t.db, fulfillment, placedOrder.orderId, { code: pad.sku, scanId: randomToken(12) }, NOW)).ok).toBe(true);
    const lines = await items(placedOrder.orderId);
    const line = lines.find((entry) => entry.variantId === pad.variantId)!;
    const other = lines.find((entry) => entry.variantId === game.variantId)!;
    // two units are scanned into the parcel: 1 would leave the station "complete" with an unpaid unit in the box
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 1 }], reason: "قطعة واحدة" }))).toMatchObject({ code: "edit_units_scanned", status: 409 });
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 0 }], reason: "احذف" }))).toMatchObject({ code: "edit_units_scanned" });
    expect((await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 2 }], reason: "قطعتان" })).after.subtotalIqd).toBe(40_000 + 9_000);
    expect((await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 4 }], reason: "أربع" })).after.subtotalIqd).toBe(80_000 + 9_000);
    // a line nobody scanned yet still goes down or away
    expect((await planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: other.id, qty: 0 }], reason: "بلا اللعبة" })).after.subtotalIqd).toBe(60_000);
    expect(await editLineFloors(t.db, placedOrder.orderId)).toEqual(new Map([[line.id, 2]]));
  });

  test("an address saved without a phone keeps the customer's number (employees who see it masked leave it empty)", async () => {
    const pad = await stocked(18_000, 10);
    const placedOrder = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const phone = (await order(placedOrder.orderId)).contactPhoneE164;
    const address = { governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة خارج", addressText: "شارع 40، بيت 3، قرب الجامع" };
    const plan = await planOrderEdit(t.db, manager, placedOrder.orderId, { address, reason: "عنوان أدق" });
    expect(plan.address.changed).toBe(true);
    await editOrder(t.db, manager, placedOrder.orderId, { address: { ...address, phone: "" }, reason: "عنوان أدق", idempotencyKey: key() }, NOW);
    expect(await order(placedOrder.orderId)).toMatchObject({ contactPhoneE164: phone, areaText: "الكرادة خارج" });
  });

  test("shipped, cancelled and POS orders are not edited", async () => {
    const pad = await stocked(15_000, 10);
    const placedOrder = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const [line] = await items(placedOrder.orderId);
    for (const status of ["shipped", "cancelled", "delivered"] as const) {
      await t.db.update(orders).set({ status }).where(eq(orders.id, placedOrder.orderId));
      expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 2 }], reason: "متأخر" })), status).toMatchObject({ code: "edit_not_allowed" });
    }
    await t.db.update(orders).set({ status: "payment_review" }).where(eq(orders.id, placedOrder.orderId));
    expect(await failureOf(planOrderEdit(t.db, manager, placedOrder.orderId, { lines: [{ orderItemId: line.id, qty: 2 }], reason: "متأخر" }))).toMatchObject({ code: "edit_payment_in_review" });
  });
});
