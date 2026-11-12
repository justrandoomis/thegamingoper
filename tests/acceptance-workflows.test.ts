/**
 * ACCEPTANCE — the five end-to-end workflows of docs/admin-blueprint.json ("workflows"), each walked step by step with
 * the services the admin pages call, by employees holding exactly the default permissions of the built-in role that
 * owns the step (defaultRolePermissions). Every step is named after the blueprint's own step. Real local D1 with the
 * demo catalogue (the trade-in workflow needs its device models, inspection templates and price guides).
 *
 *   new-device-purchase     Order → Payment verification → Reserve SKU → Assign Serial → Scan-verified fulfillment →
 *                           Shipping → Delivery → Warranty start → Profit entry
 *   used-device-trade-in    Preliminary valuation → Inspection and ownership check → Price offer → Approval →
 *                           Receipt and data wipe → Cost entry → Relisting for sale
 *   game-or-device-return   RMA request → Policy check → Approval → Receipt and inspection → Stock update →
 *                           Matching refund → Warranty update
 *   stock-repurchase        Minimum-level alert → Demand forecast → Supplier comparison → PO approval → Partial receipt
 *                           → Invoice matching → Landed cost
 *   daily-close             POS/COD/gateway settlements → Variance check → Review of discounts and refunds →
 *                           Daily report → Shift lock
 *
 * docs/ACCEPTANCE.md maps each test here to the blueprint and to the brief.
 */
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import {
  employeeRoles,
  files,
  inventoryLocations,
  journalEntries,
  journalLines,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  poItems,
  posShifts,
  products,
  purchaseOrders,
  refunds,
  returnItems,
  returns,
  serials,
  shipments,
  stockLevels,
  stockReservations,
  usedUnits,
  variantCosts,
  variants,
  walletLedger,
  warranties,
} from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { changeOrderStatus, verifyProof } from "~/server/services/admin/orders/actions.server";
import { markPacked, packProgress, scanCode } from "~/server/services/admin/orders/fulfillment.server";
import { activeTemplates } from "~/server/services/admin/devices/shared.server";
import { confirmWipe, getTradeInDetail, makeOffer, payOut, payoutJournalKey, payoutWalletKey, recordInspection, scheduleInspection } from "~/server/services/admin/devices/tradeins.server";
import { assertUnitPhotoSlot, getUsedUnitDetail, listUnit, recordUnitPhoto, saveUnitGrading, setPhotoReal, UNIT_PHOTO_KIND } from "~/server/services/admin/devices/used.server";
import type { TemplateOption } from "~/server/services/admin/devices/types";
import { decideUsedPrice, setUsedUnitPrice } from "~/server/services/admin/pricing/special.server";
import { addLandedCost, allocateLandedCost } from "~/server/services/admin/pricing/landed.server";
import { listReorder } from "~/server/services/admin/inventory/analytics.server";
import { getVariantStock, setReorderPoint } from "~/server/services/admin/inventory/stock.server";
import { approveInvoice, recordInvoice } from "~/server/services/admin/purchasing/invoices.server";
import { decidePurchaseOrder, submitPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { createReceipt, postReceipt } from "~/server/services/admin/purchasing/receipts.server";
import { awardQuote, createRfq, getRfq, recordQuote } from "~/server/services/admin/purchasing/rfqs.server";
import { createSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { inspectItem } from "~/server/services/admin/returns/inspect.server";
import { decideReturnRefund, requestReturnRefund } from "~/server/services/admin/returns/refund.server";
import { decideReturn, getReturnDetail, openReturn } from "~/server/services/admin/returns/rma.server";
import { saveRegister } from "~/server/services/admin/pos/registers.server";
import { createSale, type SaleRequestInput } from "~/server/services/admin/pos/sale.server";
import { closeShift, openShift, reviewShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { saveCarrier } from "~/server/services/admin/shipping/carriers.server";
import { createSettlement, eligibleParcels, getSettlement } from "~/server/services/admin/shipping/cod.server";
import { deliverShipment, pickupParcels, saveWaybill } from "~/server/services/admin/shipping/shipments.server";
import { listRefundReviews, reviewRefund } from "~/server/services/admin/security/refund-reviews.server";
import { salesReport } from "~/server/services/admin/reports/sales.server";
import { parseSalesParams } from "~/server/services/admin/reports/types";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { commitOrderReservations, getAvailability, receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { runBatch } from "~/server/db/tx.server";
import { recordCodCollection } from "~/server/services/payments/payments.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { reconcileCodSettlement, submitCodSettlement } from "~/server/services/orders/shipments.server";
import { submitPaymentProof } from "~/server/services/payments/payments.server";
import { createTradeIn, getTradeInByRef, listTradeInDevices, respondToOffer, type TradeInDevice } from "~/server/services/tradein.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const system = systemActor("acceptance.workflows");
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

let t: TestDb;
let make: Fixtures;
let store: BlobStore;
const staff: Partial<Record<DefaultRoleKey | "manager2" | "finance2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  store = kvBlobStore(t.kv);
  await seedDemo(t.db, NOW - 120 * DAY);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "inventory", "fulfillment", "support", "cashier", "content"] as const) staff[role] = await employee(role);
  staff.manager2 = await employee("manager");
  staff.finance2 = await employee("finance");
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

async function employee(role: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${role} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { kind: "employee", id, permissions: defaultRolePermissions(role), label: role };
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

type Workflow = { id: string; steps: { ar: string; en: string }[] };
const blueprint = JSON.parse(readFileSync(new URL("../docs/admin-blueprint.json", import.meta.url), "utf8")) as { workflows: Workflow[] };
const stepsOf = (id: string) => (blueprint.workflows.find((w) => w.id === id)?.steps ?? []).map((s) => s.en);

async function orderRow(id: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, id)).get();
  if (!row) throw new Error("order missing");
  return row;
}

async function level(variantId: string, locationId = DEFAULT_LOCATION_ID) {
  return (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get()) ?? { onHand: 0, reserved: 0 };
}

async function placed(lines: { variantId: string; qty: number }[], method: CheckoutInput["paymentMethod"], customerId: string | null = null) {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return placeOrder(
    t.db,
    { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة داخل", addressText: "شارع 62، قرب الجسر المعلق، عمارة 4", marketingConsent: false, paymentMethod: method, expectedTotalIqd: view.totalIqd },
    NOW,
  );
}

async function journal(key: string) {
  const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, key)).get();
  if (!entry) return null;
  const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).all();
  const debit = lines.reduce((sum, line) => sum + line.debitIqd, 0);
  const credit = lines.reduce((sum, line) => sum + line.creditIqd, 0);
  return { entry, lines, debit, credit };
}

// ───────────────────────────────────────────────────────────────── 1. new device purchase

describe("blueprint workflow 1 — new-device-purchase", () => {
  test("acceptance W1: Order → Payment verification → Reserve SKU → Assign Serial → Scan-verified fulfillment → Shipping → Delivery → Warranty start → Profit entry", async () => {
    expect(stepsOf("new-device-purchase")).toEqual(["Order", "Payment verification", "Reserve SKU", "Assign Serial", "Scan-verified fulfillment", "Shipping", "Delivery", "Warranty start", "Profit entry"]);
    // stock arrives (inventory receives two serial-numbered consoles at a known cost)
    const product = await make.product({ priceIqd: 700_000, trackSerials: true });
    await t.db.update(products).set({ warrantyMonths: 12 }).where(eq(products.id, product.productId));
    const serialNumbers = [`ACC-W1-${randomToken(4)}-1`, `ACC-W1-${randomToken(4)}-2`];
    expect((await failureOf(receiveStock(t.db, as("cashier"), { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 520_000, serials: serialNumbers, ref: "acc-w1" }, NOW))).status).toBe(403);
    await receiveStock(t.db, as("inventory"), { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 2, unitCostIqd: 520_000, serials: serialNumbers, ref: "acc-w1" }, NOW);
    await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: 520_000, landedCostIqd: 520_000, updatedAt: NOW }).onConflictDoNothing();

    // 1 Order (a guest pays by bank card transfer)
    const order = await placed([{ variantId: product.variantId, qty: 1 }], "bank_transfer");
    expect(await orderRow(order.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid" });

    // 3 Reserve SKU (the order's batch reserved the unit: never sold to anyone else meanwhile)
    expect((await level(product.variantId)).reserved).toBe(1);
    expect(await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order.orderId)).all()).toHaveLength(1);
    expect((await getAvailability(t.db, [product.variantId])).get(product.variantId)?.available).toBe(1);

    // 2 Payment verification (proof → finance; fulfillment cannot)
    const fileId = newId("fil");
    await t.db.insert(files).values({ id: fileId, storageKey: `prv_${fileId}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 40_000, sha256: randomToken().toLowerCase(), createdAt: NOW });
    await submitPaymentProof(t.db, { orderRef: order.ref, accessToken: order.accessToken }, { fileId, declaredAmountIqd: order.totalIqd, reference: "ACC-W1" }, NOW);
    const payment = (await t.db.select().from(payments).where(eq(payments.orderId, order.orderId)).get())!;
    expect((await failureOf(verifyProof(t.db, as("fulfillment"), payment.id, { approve: true }, NOW + MIN))).code).toBe("forbidden");
    expect((await verifyProof(t.db, as("finance"), payment.id, { approve: true }, NOW + MIN)).status).toBe("paid");
    expect(await orderRow(order.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: order.totalIqd });

    // 4 Assign Serial + 5 Scan-verified fulfillment (the packer scans; a SKU instead of the serial is refused)
    const fulfil = as("fulfillment");
    expect(await scanCode(t.db, fulfil, order.orderId, { code: product.sku, scanId: randomToken(12) }, NOW + 2 * MIN)).toMatchObject({ ok: false, code: "scan_serial_instead" });
    expect(await scanCode(t.db, fulfil, order.orderId, { code: serialNumbers[0], scanId: randomToken(12) }, NOW + 2 * MIN)).toMatchObject({ ok: true, kind: "serial", serial: serialNumbers[0] });
    const sold = await t.db.select().from(serials).where(eq(serials.serial, serialNumbers[0])).get();
    expect(sold?.status).toBe("sold");
    expect((await packProgress(t.db, order.orderId)).complete).toBe(true);
    expect((await markPacked(t.db, fulfil, order.orderId, NOW + 3 * MIN)).parcels).toBe(1);

    // the same serial can never be sold to a second order
    const second = await placed([{ variantId: product.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), second.orderId, { to: "confirmed", from: "new" }, NOW + 3 * MIN);
    const again = await scanCode(t.db, fulfil, second.orderId, { code: serialNumbers[0], scanId: randomToken(12) }, NOW + 4 * MIN);
    expect(again.ok).toBe(false);
    expect(await t.db.select().from(orderItemSerials).where(and(eq(orderItemSerials.serialId, sold!.id), sql`${orderItemSerials.releasedAt} IS NULL`)).all()).toHaveLength(1);

    // 6 Shipping (the core commits the stock) → 7 Delivery
    const before = await level(product.variantId);
    await changeOrderStatus(t.db, fulfil, order.orderId, { to: "shipped", from: "preparing", trackingNo: "ACC-TRK-1" }, NOW + HOUR);
    const after = await level(product.variantId);
    expect(after.onHand).toBe(before.onHand - 1);
    expect(after.reserved).toBe(before.reserved - 1);
    await changeOrderStatus(t.db, fulfil, order.orderId, { to: "delivered", from: "shipped" }, NOW + 2 * HOUR);
    expect((await orderRow(order.orderId)).status).toBe("delivered");

    // 8 Warranty start (one per delivered serial, from the delivery, 12 months)
    const warranty = await t.db.select().from(warranties).where(eq(warranties.serialId, sold!.id)).get();
    expect(warranty).toMatchObject({ status: "active", startsAt: NOW + 2 * HOUR });
    expect(warranty!.endsAt).toBeGreaterThan(NOW + 360 * DAY);

    // 9 Profit entry (revenue and the cost of goods, each posted once and balanced; cost = the serial's landed cost)
    const sale = await journal(`order:${order.orderId}:sale`);
    const cogs = await journal(`order:${order.orderId}:cogs`);
    expect(sale && sale.debit === sale.credit && sale.debit > 0).toBe(true);
    expect(cogs && cogs.debit === cogs.credit).toBe(true);
    expect(cogs!.debit).toBe(520_000);
    expect(Number.isFinite(sale!.debit) && Number.isFinite(cogs!.debit)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── 2. used device trade-in

describe("blueprint workflow 2 — used-device-trade-in", () => {
  test("acceptance W2: Preliminary valuation → Inspection and ownership check → Price offer → Approval → Receipt and data wipe → Cost entry → Relisting for sale", async () => {
    expect(stepsOf("used-device-trade-in")).toEqual(["Preliminary valuation", "Inspection and ownership check", "Price offer", "Approval", "Receipt and data wipe", "Cost entry", "Relisting for sale"]);
    const devices = await listTradeInDevices(t.db, "ar");
    const templates = await activeTemplates(t.db, "ar");
    let device: TradeInDevice | undefined;
    let template: TemplateOption | undefined;
    let variantId = "";
    for (const candidate of devices) {
      const tracked = await t.db
        .select({ id: variants.id })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(and(eq(products.deviceModelId, candidate.id), eq(variants.trackSerials, true)))
        .get();
      const tpl = templates.find((entry) => entry.kind === candidate.kind);
      if (tracked && tpl) {
        device = candidate;
        template = tpl;
        variantId = tracked.id;
        break;
      }
    }
    if (!device || !template) throw new Error("the demo seed has no trade-in device with a template and a serial-tracked variant");
    const customerId = await make.customer();

    // 1 Preliminary valuation: an estimate RANGE that expires — never an offer
    const made = await createTradeIn(t.db, { customerId, ip: null, locale: "ar", storeMode: "live" }, { idempotencyKey: randomToken(), device: device.slug, answers: { power: "works", body: "like_new", ...(device.hasScreen ? { screen: "perfect" as const } : {}), included: [...device.accessories], account: "yes" }, phone: "07721234599", ownershipConfirmed: true }, NOW);
    const submitted = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW);
    expect(submitted?.estimate).toBeTruthy();
    expect(submitted?.offer ?? null).toBeNull();
    // the shopper cannot accept an estimate: there is no offer yet
    expect(await failureOf(respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "store_credit" }, NOW + MIN))).toBeTruthy();

    // 2 Inspection and ownership check (no offer before it; support may read but not inspect)
    expect((await failureOf(makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 100_000 }, NOW + MIN))).status).toBeGreaterThanOrEqual(400);
    const day = new Date(NOW + DAY + 3 * HOUR).toISOString().slice(0, 10);
    await scheduleInspection(t.db, as("manager"), { tradeInId: made.tradeInId, day, time: "11:00" }, NOW + MIN);
    const answers = Object.fromEntries(template.items.map((item) => [item.key, item.input === "percent" ? { value: "90" } : item.input === "text" ? { value: "ok" } : { result: "pass" }]));
    const inspection = { tradeInId: made.tradeInId, templateId: template.id, variantId, serial: `ACC-TI-${randomToken(5)}`, grade: "A" as const, answers, included: [...device.accessories], ownershipOk: true, accountLockOk: true };
    expect((await failureOf(recordInspection(t.db, as("support"), inspection, NOW + 2 * MIN))).code).toBe("forbidden");
    await recordInspection(t.db, as("manager"), inspection, NOW + 2 * MIN);
    const detail = await getTradeInDetail(t.db, as("manager"), made.ref, "ar", NOW + 2 * MIN, { file: (id: string) => `/admin/devices/files/${id}` });
    expect(detail.offerBlockers).toEqual([]);
    const amount = detail.valuation?.suggestedIqd as number;
    expect(amount).toBeGreaterThan(0);

    // 3 Price offer (a person makes it, after the inspection)
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 5 }, NOW + 3 * MIN);
    // 4 Approval (the customer accepts on the tracking page)
    await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "store_credit" }, NOW + 4 * MIN);
    // 5 Receipt and data wipe (no payout before the wipe)
    expect((await failureOf(payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN))).code).toBe("payout_wipe_required");
    await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId, note: "أعدنا ضبط المصنع وسجّل العميل خروجه" }, NOW + 5 * MIN);
    // 6 Cost entry (store credit: the unit's acquisition cost = the offer; Dr inventory, booked once)
    const paid = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN);
    expect((await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 7 * MIN)).replayed).toBe(true);
    const unit = await t.db.select().from(usedUnits).where(eq(usedUnits.id, paid.usedUnitId)).get();
    expect(unit).toMatchObject({ acquisitionCostIqd: amount, status: "ready", source: "trade_in" });
    expect(unit?.ownershipCheckedAt).not.toBeNull();
    expect(unit?.dataWipedAt).toBe(NOW + 5 * MIN);
    // store credit: the customer's wallet holds the offer, the books Dr inventory / Cr wallet liability, once
    const credit = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, payoutWalletKey(made.tradeInId))).all();
    expect(credit).toHaveLength(1);
    expect(credit[0]).toMatchObject({ customerId, amountIqd: amount, kind: "trade_in_credit" });
    const cost = await journal(`wallet:${credit[0].id}`);
    expect(cost && cost.debit === cost.credit && cost.debit === amount).toBe(true);
    expect(cost!.lines.find((line) => line.accountId === "acc_inventory")?.debitIqd).toBe(amount);
    expect(await journal(payoutJournalKey(made.tradeInId))).toBeNull();

    // 7 Relisting for sale (price approved by a second person, real photo, grading; then listed)
    const priced = await setUsedUnitPrice(t.db, as("manager"), { usedUnitId: paid.usedUnitId, price: amount + 150_000, expectedPriceIqd: 0, reason: "سعر أول للجهاز" }, NOW + 8 * MIN);
    if (priced.status === "pending" && priced.requestId) await decideUsedPrice(t.db, as("manager2"), { approvalId: priced.requestId, decision: "approve", note: "مناسب" }, NOW + 9 * MIN);
    await saveUnitGrading(t.db, as("manager"), { usedUnitId: paid.usedUnitId, grade: "A", cosmeticNotes: { ar: "خدوش خفيفة جداً على الظهر.", en: "Very light scratches on the back." }, warrantyDays: 30 }, NOW + 9 * MIN, () => undefined);
    expect((await failureOf(listUnit(t.db, store, as("manager"), { usedUnitId: paid.usedUnitId }, NOW + 10 * MIN))).code).toBe("not_listable");
    const slot = await assertUnitPhotoSlot(t.db, as("manager"), paid.usedUnitId);
    const { file } = await saveImageUpload(t.db, store, PNG, { visibility: "private", kind: UNIT_PHOTO_KIND, ownerType: "used_unit", ownerId: paid.usedUnitId, createdBy: as("manager"), now: NOW });
    const { mediaId } = await recordUnitPhoto(t.db, as("manager"), slot, file.id, NOW + 10 * MIN, "الواجهة الأمامية");
    await setPhotoReal(t.db, store, as("manager"), { usedUnitId: paid.usedUnitId, mediaId, real: true }, NOW + 11 * MIN);
    expect((await getUsedUnitDetail(t.db, as("manager"), paid.usedUnitId, "ar", { file: (id: string) => id })).listBlockers).toEqual([]);
    expect((await failureOf(listUnit(t.db, store, as("inventory"), { usedUnitId: paid.usedUnitId }, NOW + 12 * MIN))).code).toBe("forbidden");
    await listUnit(t.db, store, as("manager"), { usedUnitId: paid.usedUnitId }, NOW + 12 * MIN);
    expect((await t.db.select().from(usedUnits).where(eq(usedUnits.id, paid.usedUnitId)).get())?.status).toBe("listed");
  });
});

// ───────────────────────────────────────────────────────────────── 3. return

describe("blueprint workflow 3 — game-or-device-return", () => {
  test("acceptance W3: RMA request → Policy check → Approval → Receipt and inspection → Stock update → Matching refund → Warranty update", async () => {
    expect(stepsOf("game-or-device-return")).toEqual(["RMA request", "Policy check", "Approval", "Receipt and inspection", "Stock update", "Matching refund", "Warranty update"]);
    // a delivered, paid (COD) console with its serial and warranty
    const product = await make.product({ priceIqd: 400_000, trackSerials: true });
    await t.db.update(products).set({ warrantyMonths: 12 }).where(eq(products.id, product.productId));
    const sn = `ACC-W3-${randomToken(5)}`;
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 300_000, serials: [sn], ref: "acc-w3" }, NOW);
    const order = await placed([{ variantId: product.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
    await scanCode(t.db, as("fulfillment"), order.orderId, { code: sn, scanId: randomToken(12) }, NOW);
    await markPacked(t.db, as("fulfillment"), order.orderId, NOW);
    await changeOrderStatus(t.db, as("fulfillment"), order.orderId, { to: "shipped", from: "preparing" }, NOW);
    await changeOrderStatus(t.db, as("fulfillment"), order.orderId, { to: "delivered", from: "shipped" }, NOW + HOUR);
    await recordCodCollection(t.db, as("finance"), order.orderId, order.totalIqd, NOW + HOUR);
    const item = (await t.db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId)).get())!;
    const serialId = (await t.db.select().from(serials).where(eq(serials.serial, sn)).get())!.id;
    const warranty = (await t.db.select().from(warranties).where(eq(warranties.serialId, serialId)).get())!;
    expect(warranty.status).toBe("active");
    const availableBefore = (await getAvailability(t.db, [product.variantId])).get(product.variantId)?.available ?? 0;

    // 1 RMA request (support opens it; the cashier's role cannot decide)
    const opened = await openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: item.id, qty: 1, serialIds: [serialId] }], reasonCode: "defective", reason: "لا يعطي صورة بعد التشغيل", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY);
    // 2 Policy check (inside the window: eligible; the same unit cannot be asked for twice)
    const detail = await getReturnDetail(t.db, as("manager"), opened.rma, "ar", NOW + DAY, { photo: (id: string) => id });
    expect(detail.items[0].eligibility?.problems ?? []).toEqual([]);
    expect((await failureOf(openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: item.id, qty: 1, serialIds: [serialId] }], reasonCode: "defective", reason: "مرة ثانية", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY))).code).toMatch(/return_qty_exceeds|unit_in_return|already/);
    // 3 Approval (never by who opened it)
    expect((await failureOf(decideReturn(t.db, as("support"), opened.returnId, { approve: true }, NOW + DAY + HOUR))).status).toBe(403);
    await decideReturn(t.db, as("manager"), opened.returnId, { approve: true }, NOW + DAY + HOUR);
    // 4 Receipt and inspection (inventory; the serial must be the one sold) → 5 Stock update
    const [returnItem] = await t.db.select().from(returnItems).where(eq(returnItems.returnId, opened.returnId)).all();
    expect((await failureOf(inspectItem(t.db, as("inventory"), { returnId: opened.returnId, itemId: returnItem.id, condition: "sellable", decision: "restock", serial: "NOT-THE-ONE" }, NOW + 2 * DAY))).code).toBe("serial_mismatch");
    await inspectItem(t.db, as("inventory"), { returnId: opened.returnId, itemId: returnItem.id, condition: "sellable", decision: "restock", serial: sn }, NOW + 2 * DAY);
    expect((await getAvailability(t.db, [product.variantId])).get(product.variantId)?.available).toBe(availableBefore + 1);
    expect((await t.db.select().from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("in_stock");
    // 6 Matching refund (≤ the item's value, requested by support, approved by finance — a second person, once)
    const payment = (await t.db.select().from(payments).where(and(eq(payments.orderId, order.orderId), eq(payments.status, "paid"))).get())!;
    expect((await failureOf(requestReturnRefund(t.db, as("support"), { returnId: opened.returnId, paymentId: payment.id, itemIds: [returnItem.id], amountIqd: 400_001, method: "original", reason: "قطعة معيبة", idempotencyKey: randomToken() }, NOW + 3 * DAY))).code).toBe("refund_exceeds_items");
    const requested = await requestReturnRefund(t.db, as("support"), { returnId: opened.returnId, paymentId: payment.id, itemIds: [returnItem.id], amountIqd: 400_000, method: "original", reason: "قطعة معيبة", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    expect((await failureOf(decideReturnRefund(t.db, as("support"), { returnId: opened.returnId, refundId: requested.refundId, approve: true }, NOW + 3 * DAY))).status).toBe(403);
    expect(await decideReturnRefund(t.db, as("finance"), { returnId: opened.returnId, refundId: requested.refundId, approve: true }, NOW + 3 * DAY)).toEqual({ status: "paid" });
    expect((await orderRow(order.orderId)).refundedIqd).toBe(400_000);
    expect((await failureOf(requestReturnRefund(t.db, as("support"), { returnId: opened.returnId, paymentId: payment.id, itemIds: [returnItem.id], amountIqd: 1_000, method: "original", reason: "مرة ثانية", idempotencyKey: randomToken() }, NOW + 4 * DAY))).code).toMatch(/refund_qty_exceeds|refund_not_ready/);
    expect(await t.db.select().from(refunds).where(eq(refunds.orderId, order.orderId)).all()).toHaveLength(1);
    expect((await t.db.select().from(returns).where(eq(returns.id, opened.returnId)).get())?.status).toBe("refunded");
    // 7 Warranty update (the returned unit's warranty ends with the return)
    expect(await t.db.select().from(warranties).where(eq(warranties.id, warranty.id)).get()).toMatchObject({ status: "void" });
  });
});

// ───────────────────────────────────────────────────────────────── 4. stock repurchase

describe("blueprint workflow 4 — stock-repurchase", () => {
  test("acceptance W4: Minimum-level alert → Demand forecast → Supplier comparison → PO approval → Partial receipt → Invoice matching → Landed cost", async () => {
    expect(stepsOf("stock-repurchase")).toEqual(["Minimum-level alert", "Demand forecast", "Supplier comparison", "PO approval", "Partial receipt", "Invoice matching", "Landed cost"]);
    const product = await make.product({ priceIqd: 60_000 });
    await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 20, unitCostIqd: 30_000, ref: "acc-w4-opening" }, NOW - 60 * DAY);
    // 15 units sold (shipped) ten days ago
    const sold = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 15 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: sold.orderId, lines: [{ variantId: product.variantId, qty: 15 }], expiresAt: null, actor: system, now: NOW - 10 * DAY }));
    await commitOrderReservations(t.db, system, sold.orderId, NOW - 10 * DAY);

    // 1 Minimum-level alert (inventory sets the reorder point; the cashier may not)
    expect((await failureOf(setReorderPoint(t.db, as("cashier"), { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, reorderPoint: 8, reorderQty: 30 }, NOW))).code).toBe("forbidden");
    await setReorderPoint(t.db, as("inventory"), { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, reorderPoint: 8, reorderQty: 30 }, NOW);
    const reorder = await listReorder(t.db, as("inventory"), { show: "all", q: product.sku, page: 1 }, "ar", NOW);
    expect(reorder.rows[0]?.plan.status).toBe("below_reorder");
    // 2 Demand forecast (sales rate and days of cover from the movements)
    const stock = await getVariantStock(t.db, as("inventory"), product.variantId, "ar", NOW);
    expect(stock.forecast.rate30).toMatchObject({ basis: "sales" });
    expect(stock.forecast.plan).toMatchObject({ belowReorder: true, suggestedQty: 30 });
    expect(Number.isFinite(stock.forecast.plan.daysOfCover ?? 0)).toBe(true);

    // 3 Supplier comparison (an RFQ, two quotes compared in IQD, the award drafts ONE order)
    const supplierA = (await createSupplier(t.db, as("manager"), { code: make.next("SUPA").toUpperCase(), name: "Supplier A", currency: "IQD", leadTimeDays: "10", paymentTerms: "net 30" }, NOW)).supplierId;
    const supplierB = (await createSupplier(t.db, as("manager"), { code: make.next("SUPB").toUpperCase(), name: "Supplier B", currency: "IQD", leadTimeDays: "4", paymentTerms: "net 30" }, NOW)).supplierId;
    // 40 × 29,000 = 1,160,000 IQD: above the 1,000,000 spending limit, so the order needs a second person
    const { rfqId } = await createRfq(t.db, as("manager"), { title: "Restock", neededBy: "2026-12-01", lines: [{ code: product.sku, qty: "40" }], idempotencyKey: `k_${randomToken(10)}` }, NOW);
    const [rfqItem] = (await getRfq(t.db, as("manager"), rfqId, "ar", NOW)).items;
    await recordQuote(t.db, as("manager"), { rfqId, supplierId: supplierA, currency: "IQD", leadTimeDays: "10", lines: [{ rfqItemId: rfqItem.id, unitCost: "29000" }] }, NOW);
    await recordQuote(t.db, as("manager"), { rfqId, supplierId: supplierB, currency: "IQD", leadTimeDays: "4", lines: [{ rfqItemId: rfqItem.id, unitCost: "31000" }] }, NOW);
    const compared = await getRfq(t.db, as("manager"), rfqId, "ar", NOW);
    const cheapest = compared.quotes.find((quote) => quote.best?.price)!;
    expect(cheapest.supplier.id).toBe(supplierA);
    const award = await awardQuote(t.db, as("manager"), { rfqId, quoteId: cheapest.id, locationId: DEFAULT_LOCATION_ID, idempotencyKey: `k_${randomToken(10)}` }, NOW);

    // 4 PO approval (above the spending limit a second person decides — never the submitter)
    const version = async () => (await t.db.select({ updatedAt: purchaseOrders.updatedAt }).from(purchaseOrders).where(eq(purchaseOrders.id, award.poId)).get())!.updatedAt;
    const submitted = await submitPurchaseOrder(t.db, as("manager"), { poId: award.poId, version: await version() }, NOW);
    expect(submitted.status).toBe("pending_approval");
    expect((await failureOf(decidePurchaseOrder(t.db, as("manager"), { poId: award.poId, decision: "approve" }, NOW))).code).toBe("approver_is_requester");
    expect((await failureOf(decidePurchaseOrder(t.db, as("inventory"), { poId: award.poId, decision: "approve" }, NOW))).code).toBe("forbidden");
    await decidePurchaseOrder(t.db, as("manager2"), { poId: award.poId, decision: "approve" }, NOW);
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, award.poId)).get())?.status).toBe("approved");

    // 5 Partial receipt (inventory receives 20 of 40, with a landed freight bill spread first) + 7 Landed cost
    const [line] = await t.db.select().from(poItems).where(eq(poItems.poId, award.poId)).all();
    const receipt = await createReceipt(t.db, as("inventory"), { poId: award.poId, lines: [{ poItemId: line.id, received: "20" }], idempotencyKey: `k_${randomToken(10)}` }, NOW);
    const bill = await addLandedCost(t.db, as("manager"), { receiptId: receipt.receiptId, kind: "freight", currency: "IQD", amount: "40000", method: "by_qty", reason: "شحن من المورد", idempotencyKey: `k_${randomToken(10)}` }, NOW);
    expect((await failureOf(postReceipt(t.db, as("inventory"), { receiptId: receipt.receiptId }, NOW))).code).toBe("landed_unallocated");
    await allocateLandedCost(t.db, as("manager"), { landedCostId: bill.landedCostId, receiptId: receipt.receiptId }, NOW);
    expect(await postReceipt(t.db, as("inventory"), { receiptId: receipt.receiptId }, NOW)).toMatchObject({ units: 20 });
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, award.poId)).get())?.status).toBe("partially_received");
    const layer = await t.d1.prepare("SELECT cl.unit_cost_iqd AS cost FROM cost_layers cl JOIN receipt_items ri ON ri.id = cl.receipt_item_id WHERE ri.receipt_id = ?1").bind(receipt.receiptId).first<{ cost: number }>();
    expect(layer?.cost).toBe(29_000 + 2_000);

    // 6 Invoice matching (three-way: billed 40 while 20 arrived → a variance that needs a reason and a second person)
    const invoice = await recordInvoice(t.db, as("finance"), { poId: award.poId, invoiceNo: `INV-${randomToken(5)}`, lines: [{ poItemId: line.id, qty: "40", unitCost: "29000" }], idempotencyKey: `k_${randomToken(10)}` }, NOW);
    expect(invoice.status).toBe("mismatch");
    expect((await failureOf(approveInvoice(t.db, as("finance"), { invoiceId: invoice.invoiceId, reason: "متفق عليه" }, NOW))).code).toBe("approver_is_requester");
    expect((await approveInvoice(t.db, as("manager"), { invoiceId: invoice.invoiceId, reason: "الباقي في الطريق، متفق عليه كتابياً" }, NOW)).variances).toBeGreaterThan(0);
  });
});

// ───────────────────────────────────────────────────────────────── 5. daily close

describe("blueprint workflow 5 — daily-close", () => {
  test("acceptance W5: POS/COD/gateway settlements → Variance check → Review of discounts and refunds → Daily report → Shift lock", async () => {
    expect(stepsOf("daily-close")).toEqual(["POS/COD/gateway settlements", "Variance check", "Review of discounts and refunds", "Daily report", "Shift lock"]);
    // a shop with a till; the cashier sells during the day
    const shopId = newId("loc");
    await t.db.insert(inventoryLocations).values({ id: shopId, code: `ACC-SHOP-${randomToken(3)}`, name: "Shop", kind: "store", isSellable: true });
    const registerId = (await saveRegister(t.db, as("manager"), { code: `ACC-${randomToken(3).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`, name: "Till", locationId: shopId, isActive: true }, NOW)).registerId;
    const item = await make.product({ priceIqd: 30_000 });
    await receiveStock(t.db, system, { variantId: item.variantId, locationId: shopId, qty: 5, unitCostIqd: 18_000, ref: "acc-w5" }, NOW);
    const shift = await openShift(t.db, as("cashier"), { registerId, openingFloatIqd: 50_000, idempotencyKey: randomToken(16) }, NOW);
    const saleInput: SaleRequestInput = { idempotencyKey: randomToken(18), shiftId: shift.shiftId, customer: null, lines: [{ variantId: item.variantId, qty: 1, unitPriceIqd: 30_000, discountIqd: 0, serials: [] }], payments: [{ method: "pos_cash", amountIqd: 30_000, tenderedIqd: 50_000 }] };
    await createSale(t.db, as("cashier"), saleInput, { locale: "ar", storeMode: "live" }, NOW);

    // 1 Settlements — POS: a blind count (the cashier never sees what was expected) …
    const blind = await shiftReport(t.db, as("cashier"), shift.shiftId, "ar");
    expect(blind.cash.expectedIqd).toBeNull();
    expect(await closeShift(t.db, as("cashier"), { shiftId: shift.shiftId, countedCashIqd: 75_000 }, NOW + 8 * HOUR)).toMatchObject({ needsReview: true });
    // … COD: the carrier's statement settles each delivered parcel once
    const carrierId = (await saveCarrier(t.db, as("manager"), { code: `acc${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")}`, name: "شركة توصيل", kind: "third_party", codSupported: true, codFeeIqd: 0, codFeeBps: 0 }, NOW)).carrierId;
    const goods = await make.product({ priceIqd: 90_000, kind: "game" });
    await receiveStock(t.db, system, { variantId: goods.variantId, locationId: DEFAULT_LOCATION_ID, qty: 3, unitCostIqd: 60_000, ref: "acc-w5-cod" }, NOW);
    const cod = await placed([{ variantId: goods.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), cod.orderId, { to: "confirmed", from: "new" }, NOW);
    await scanCode(t.db, as("fulfillment"), cod.orderId, { code: goods.sku, scanId: randomToken(12) }, NOW);
    await markPacked(t.db, as("fulfillment"), cod.orderId, NOW);
    const parcel = (await t.db.select().from(shipments).where(eq(shipments.orderId, cod.orderId)).get())!;
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: parcel.id, carrierId, serviceLevel: "standard" }, NOW);
    expect((await pickupParcels(t.db, as("fulfillment"), { shipmentIds: [parcel.id] }, NOW + HOUR)).shipped).toEqual([cod.ref]);
    await deliverShipment(t.db, as("fulfillment"), { shipmentId: parcel.id, receivedByName: "علي حسن" }, NOW + 2 * HOUR);
    expect((await failureOf(eligibleParcels(t.db, as("fulfillment"), carrierId, "ar"))).code).toBe("forbidden");
    const draft = await createSettlement(t.db, as("finance"), { carrierId, shipmentIds: [parcel.id], idempotencyKey: randomToken(12) }, NOW + 9 * HOUR);
    expect((await failureOf(createSettlement(t.db, as("finance2"), { carrierId, shipmentIds: [parcel.id], idempotencyKey: randomToken(12) }, NOW + 9 * HOUR))).code).toBe("parcel_not_eligible");
    const net = (await getSettlement(t.db, as("finance"), draft.settlementId, "ar")).totals.netDueIqd;
    await submitCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedIqd: net }, NOW + 9 * HOUR);
    const reconciled = await reconcileCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "مطابق للكشف" }, NOW + 9 * HOUR);
    expect(reconciled.journalEntryId).toBeTruthy();
    expect((await t.db.select().from(payments).where(and(eq(payments.orderId, cod.orderId), eq(payments.method, "cod"))).get())?.status).toBe("paid");

    // 2 Variance check (the supervisor sees expected vs counted; two people approve a difference)
    const review = await shiftReport(t.db, as("finance"), shift.shiftId, "ar");
    expect(review).toMatchObject({ expectedCashIqd: 80_000, countedCashIqd: 75_000, varianceIqd: -5_000, state: "review" });
    expect((await failureOf(reviewShift(t.db, as("cashier"), { shiftId: shift.shiftId, expectedVarianceIqd: -5_000, note: "عد ناقص" }, NOW))).status).toBe(403);

    // 3 Review of discounts and refunds (a refund is reviewed by someone who neither asked for nor approved it)
    const refunded = await make.order([{ variantId: goods.variantId, sku: goods.sku, qty: 1, unitPriceIqd: 90_000 }], { status: "delivered", paymentStatus: "paid" });
    const paymentId = await make.payment(refunded.orderId, refunded.totalIqd, { method: "cod", status: "paid" });
    await t.db.update(orders).set({ paidIqd: refunded.totalIqd }).where(eq(orders.id, refunded.orderId));
    const refundId = newId("rfd");
    await t.db.insert(refunds).values({ id: refundId, orderId: refunded.orderId, paymentId, amountIqd: 90_000, method: "cash", reason: "استرداد اليوم", status: "paid", createdBy: as("manager").id, approvedBy: as("manager").id, createdAt: NOW + 3 * HOUR });
    const reviews = await listRefundReviews(t.db, as("finance"), { view: "all", page: 1 }, NOW + 10 * HOUR);
    expect(reviews.rows.some((row) => row.id === refundId)).toBe(true);
    expect((await failureOf(reviewRefund(t.db, as("manager"), { refundId, outcome: "cleared", note: "راجعته" }, NOW + 10 * HOUR))).code).toBe("reviewer_involved");
    await reviewRefund(t.db, as("finance"), { refundId, outcome: "cleared", note: "مطابق للإيصال" }, NOW + 10 * HOUR);

    // 4 Daily report (the day's sales, finite numbers, the journal and the operations agree)
    const day = new Date(NOW + 3 * HOUR).toISOString().slice(0, 10);
    const report = await salesReport(t.db, as("finance"), parseSalesParams(new URLSearchParams(`from=${day}&to=${day}&by=day`), NOW), "ar", NOW + 10 * HOUR);
    expect(Object.values(report.totals).every((value) => Number.isFinite(value))).toBe(true);
    expect(report.consistent).toBe(true);
    expect((await failureOf(salesReport(t.db, as("fulfillment"), parseSalesParams(new URLSearchParams(`from=${day}&to=${day}`), NOW), "ar", NOW))).status).toBe(403);

    // 5 Shift lock (approved once by the second person; then final — no new review, no cash moves)
    await reviewShift(t.db, as("finance"), { shiftId: shift.shiftId, expectedVarianceIqd: -5_000, note: "ورقة 5,000 مفقودة" }, NOW + 11 * HOUR);
    expect((await failureOf(reviewShift(t.db, as("manager"), { shiftId: shift.shiftId, expectedVarianceIqd: -5_000, note: "مرة ثانية" }, NOW + 12 * HOUR))).code).toBe("shift_not_in_review");
    const locked = await t.db.select().from(posShifts).where(eq(posShifts.id, shift.shiftId)).get();
    expect(locked?.status).not.toBe("open");
    const variance = await journal(`pos_shift:${shift.shiftId}:variance`);
    expect(variance && variance.debit === variance.credit && variance.debit === 5_000).toBe(true);
    expect(await t.db.select().from(journalEntries).where(inArray(journalEntries.idempotencyKey, [`pos_shift:${shift.shiftId}:variance`])).all()).toHaveLength(1);
  });
});
