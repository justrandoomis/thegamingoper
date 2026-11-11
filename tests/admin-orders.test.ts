/**
 * Admin module 05 "orders" (owner: admin orders) — the services under app/server/services/admin/orders and the route
 * glue of app/routes/admin/orders, on a real local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · authorization per role (owner, manager, finance, fulfillment, support, inventory, cashier) for every screen's
 *     service, and the field permissions: cost and margin exist only for cost.read / profit.read (objects, CSV)
 *   · status changes only through the core (transitionOrder) with the module's rules: hold, scan-verified shipping,
 *     a stale page refused; parcels, tasks and held notifications follow
 *   · transfer proofs (verifyPayment), cash on delivery, refunds (two people, never above what is refundable,
 *     idempotent), cancellation's pending refund
 *   · the packing station: serials attached through the core's statements, wrong items refused and recorded, scans
 *     idempotent, parcels split and packed
 *   · review rules (deterministic, explained), clear / hold, a new flag brings an order back
 *   · invoices numbered once, documents without cost, pre-orders and delay updates, proof of delivery
 *   · the route actions (orderAction, packAction) and loaders (403 for a role without the permission)
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as editLoader } from "~/routes/admin/orders/edit";
import { loader as orderLoader } from "~/routes/admin/orders/order";
import { orderAction } from "~/routes/admin/orders/order.server";
import { packAction } from "~/routes/admin/orders/pack.server";
import { loader as proofsLoader } from "~/routes/admin/orders/proofs";
import { code128Modules, code128Values, CODE128_PATTERNS } from "~/routes/admin/orders/code128";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import {
  auditEvents,
  bundleItems,
  employeeRoles,
  files,
  invoices,
  orderEvents,
  orders,
  outbox,
  payments,
  refunds,
  rolePermissions,
  roles,
  serials,
  shipmentEvents,
  shipments,
  staffTasks,
  stockLevels,
  usedUnits,
  variantCosts,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { addNote, changeOrderStatus, collectCod, decideRefund, requestRefund, setPreorder, verifyProof } from "~/server/services/admin/orders/actions.server";
import { getOrderDetail } from "~/server/services/admin/orders/detail.server";
import { csvCell, exportOrdersCsv } from "~/server/services/admin/orders/export.server";
import { issueInvoices, printDocuments } from "~/server/services/admin/orders/documents.server";
import { assignOrder, getPackView, listFulfillment, manualVerify, markPacked, packProgress, recordDeliveryProof, scanCode, splitParcel } from "~/server/services/admin/orders/fulfillment.server";
import { listOrders, orderCounts } from "~/server/services/admin/orders/list.server";
import { listPreorders } from "~/server/services/admin/orders/preorders.server";
import { getProofReview, listProofQueue, listRefundQueue, proofFileOf } from "~/server/services/admin/orders/queues.server";
import { decideReview, listReviewQueue, riskFlagsOf } from "~/server/services/admin/orders/risk.server";
import { listSearch, parseIqd, parseListFilters, RISK_THRESHOLDS } from "~/server/services/admin/orders/types";
import { amountOf } from "~/routes/admin/orders/common.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { editOrder } from "~/server/services/orders/edit.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { submitPaymentProof } from "~/server/services/payments/payments.server";
import { creditWallet } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const urls = { proofImage: (id: string) => `/admin/orders/proofs/image/${id}`, deliveryProof: (id: string) => `/admin/orders/files/${id}` };
const system = systemActor("test.admin-orders");

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "manager2" | "finance2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "fulfillment", "support", "inventory", "cashier"] as const) staff[role] = await employee(role);
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

const as = (role: keyof typeof staff): EmployeeActor => {
  const actor = staff[role];
  if (!actor) throw new Error(`no ${role}`);
  return actor;
};
/** An employee holding exactly these permissions (custom roles). */
const custom = (permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: as("manager").id, permissions: new Set(permissions) });

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

/** A costed, stocked product (received through the stock service: movements, cost layers, serials). */
async function stocked(priceIqd: number, qty: number, unitCostIqd: number, options: { trackSerials?: boolean } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials });
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `SN-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: unitCostIqd, landedCostIqd: unitCostIqd, updatedAt: NOW }).onConflictDoNothing();
  return { ...product, serials: serialNumbers ?? [] };
}

async function placed(lines: ({ variantId: string; qty: number } | { usedUnitId: string; qty: number })[], method: CheckoutInput["paymentMethod"], options: { customerId?: string | null; at?: number; phone?: string } = {}) {
  const customerId = options.customerId ?? null;
  const at = options.at ?? NOW;
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "ar" }, line, at)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "ar", governorateId: governorateId("baghdad") }, at);
  const result = await placeOrder(
    t.db,
    { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" },
    {
      idempotencyKey: randomToken(),
      phone: options.phone ?? make.phone(),
      governorateId: governorateId("baghdad"),
      districtId: districtId("baghdad", "karrada"),
      areaText: "الكرادة داخل",
      addressText: "شارع 62، قرب الجسر المعلق، عمارة 4",
      marketingConsent: false,
      paymentMethod: method,
      expectedTotalIqd: view.totalIqd,
    },
    at,
  );
  return result;
}

async function proofFile(sha256 = randomToken().toLowerCase()): Promise<string> {
  const id = newId("fil");
  await t.db.insert(files).values({ id, storageKey: `prv_${id}.jpg`, visibility: "private", kind: "payment_proof", mime: "image/jpeg", bytes: 40_000, sha256, createdAt: NOW });
  return id;
}

async function orderRow(id: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, id)).get();
  if (!row) throw new Error("order missing");
  return row;
}

/** Packs an order completely at the packing station: every serial, then every other unit. */
async function packAll(orderId: string, actor = as("fulfillment"), at = NOW) {
  const progress = await packProgress(t.db, orderId);
  for (const line of progress.lines) {
    if (line.serialUnits > line.serialsScanned.length) {
      const free = await t.db.select({ serial: serials.serial }).from(serials).where(and(eq(serials.variantId, line.trackedVariantIds[0]), eq(serials.status, "in_stock"))).limit(line.serialUnits - line.serialsScanned.length);
      for (const row of free) expect((await scanCode(t.db, actor, orderId, { code: row.serial, scanId: randomToken(12) }, at)).ok).toBe(true);
    }
    for (let i = line.scanned; i < line.scanUnits; i++) expect((await scanCode(t.db, actor, orderId, { code: line.sku, scanId: randomToken(12) }, at)).ok).toBe(true);
  }
}

// ───────────────────────────────────────────────────────────────── authorization and field permissions

describe("authorization per role", () => {
  test("the list and the order page: every orders role reads; the cashier (no orders permission) is refused", async () => {
    const plain = await stocked(80_000, 20, 50_000);
    const order = await placed([{ variantId: plain.variantId, qty: 1 }], "cod");
    for (const role of ["owner", "manager", "finance", "fulfillment", "support", "inventory"] as const) {
      const page = await listOrders(t.db, as(role), parseListFilters(new URLSearchParams(`q=${order.ref}`)), "ar", NOW);
      expect(page.rows.map((row) => row.ref), role).toContain(order.ref);
      expect((await getOrderDetail(t.db, as(role), order.ref, "ar", NOW, urls)).ref, role).toBe(order.ref);
    }
    expect(await failureOf(listOrders(t.db, as("cashier"), parseListFilters(new URLSearchParams()), "ar", NOW))).toMatchObject({ code: "forbidden", status: 403 });
    // D1 refuses LIKE patterns over 50 bytes: a long Arabic search is cut, never an error
    const long = await listOrders(t.db, as("manager"), parseListFilters(new URLSearchParams(`q=${encodeURIComponent("طلب تجريبي لشاشات الإدارة ".repeat(4))}`)), "ar", NOW);
    expect(long.rows).toEqual([]);
    const byPhone = await listOrders(t.db, as("manager"), parseListFilters(new URLSearchParams(`q=${(await orderRow(order.orderId)).contactPhoneE164!.slice(-7)}`)), "ar", NOW);
    expect(byPhone.rows.map((row) => row.ref)).toContain(order.ref);
    expect(await failureOf(getOrderDetail(t.db, as("cashier"), order.ref, "ar", NOW, urls))).toMatchObject({ code: "forbidden" });
  });

  test("cost and margin EXIST only for cost.read / profit.read — absent (not null) for everyone else, phones masked without the field permission", async () => {
    const plain = await stocked(120_000, 10, 70_000);
    const order = await placed([{ variantId: plain.variantId, qty: 2 }], "cod");
    const manager = await getOrderDetail(t.db, as("manager"), order.ref, "ar", NOW, urls);
    expect(manager.costIqd).toBe(140_000);
    expect(manager.marginIqd).toBe(240_000 - 140_000);
    expect(manager.lines[0].unitCostIqd).toBe(70_000);
    expect(manager.lines[0].marginIqd).toBe(100_000);
    for (const role of ["fulfillment", "support", "inventory"] as const) {
      const detail = await getOrderDetail(t.db, as(role), order.ref, "ar", NOW, urls);
      expect("costIqd" in detail, role).toBe(false);
      expect("marginIqd" in detail, role).toBe(false);
      expect("unitCostIqd" in detail.lines[0], role).toBe(false);
      expect(JSON.stringify(detail), role).not.toMatch(/70000|cost/i);
    }
    // cost.read without profit.read: the cost, not the margin
    const costOnly = await getOrderDetail(t.db, custom(["orders.order.read", "cost.read"]), order.ref, "ar", NOW, urls);
    expect(costOnly.costIqd).toBe(140_000);
    expect("marginIqd" in costOnly).toBe(false);
    // phones: fulfillment and support hold customer.phone.read_full, finance does not
    expect((await getOrderDetail(t.db, as("fulfillment"), order.ref, "ar", NOW, urls)).customer.phone?.full).toBe(true);
    const finance = await getOrderDetail(t.db, as("finance"), order.ref, "ar", NOW, urls);
    expect(finance.customer.phone).toMatchObject({ full: false });
    expect(finance.customer.phone?.display).toMatch(/•/);
    expect(JSON.stringify(finance)).not.toContain((await orderRow(order.orderId)).contactPhoneE164!.slice(-6));
  });

  test("CSV export: the cost and margin columns are in the file only for cost.read / profit.read; cells cannot start a formula; the export is audited", async () => {
    const plain = await stocked(95_000, 5, 60_000);
    const order = await placed([{ variantId: plain.variantId, qty: 1 }], "cod");
    const filters = parseListFilters(new URLSearchParams(`q=${order.ref}`));
    const headers = { costIqd: "COST", marginIqd: "MARGIN" };
    const withCost = await exportOrdersCsv(t.db, as("manager"), filters, headers, "en", NOW);
    expect(withCost.csv.split("\r\n")[0]).toContain("COST");
    expect(withCost.csv.split("\r\n")[0]).toContain("MARGIN");
    expect(withCost.csv).toContain("60000");
    const without = await exportOrdersCsv(t.db, custom(["orders.order.read", "orders.order.export"]), filters, headers, "en", NOW);
    expect(without.rows).toBe(1);
    expect(without.csv).not.toContain("COST");
    expect(without.csv).not.toContain("60000");
    expect(without.csv).toMatch(/•/);
    expect(await failureOf(exportOrdersCsv(t.db, as("support"), filters, headers, "en", NOW))).toMatchObject({ code: "forbidden" });
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "orders.order.export")).all();
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  test("each queue is for the people who act on it", async () => {
    expect(await failureOf(listProofQueue(t.db, as("fulfillment")))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(listProofQueue(t.db, as("support")))).toMatchObject({ code: "forbidden" });
    await expect(listProofQueue(t.db, as("finance"))).resolves.toBeInstanceOf(Array);
    expect(await failureOf(listRefundQueue(t.db, as("fulfillment")))).toMatchObject({ code: "forbidden" });
    expect((await listRefundQueue(t.db, as("support"))).canApprove).toBe(false);
    expect(await failureOf(listReviewQueue(t.db, as("fulfillment"), NOW))).toMatchObject({ code: "forbidden" });
    await expect(listReviewQueue(t.db, as("finance"), NOW)).resolves.toBeTruthy();
    expect(await failureOf(listFulfillment(t.db, as("support"), "ar"))).toMatchObject({ code: "forbidden" });
    expect((await listFulfillment(t.db, as("fulfillment"), "ar")).packers).toBeNull();
    expect((await listFulfillment(t.db, as("manager"), "ar")).packers?.length).toBeGreaterThan(0);
    expect(await failureOf(proofFileOf(t.db, as("support"), "prf_x"))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(printDocuments(t.db, as("support"), { kind: "invoice", orderIds: ["ord_x"] }, "ar"))).toMatchObject({ code: "forbidden" });
    const counts = await orderCounts(t.db, as("fulfillment"), NOW);
    expect(counts.proofs).toBeNull();
    expect(counts.refunds).toBeNull();
    expect(counts.toPack).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── statuses, packing, shipping

describe("statuses go through the core, packing is scan-verified", () => {
  test("cash on delivery: confirm → pack by scanning (serials attached, wrong items refused and written down) → ship → deliver → collect", async () => {
    const console5 = await stocked(750_000, 3, 600_000, { trackSerials: true });
    const pad = await stocked(65_000, 10, 40_000);
    const other = await stocked(300_000, 2, 200_000, { trackSerials: true });
    const order = await placed(
      [
        { variantId: console5.variantId, qty: 1 },
        { variantId: pad.variantId, qty: 2 },
      ],
      "cod",
    );
    // fulfillment cannot confirm a COD order (orders.order.update); the manager can
    expect(await failureOf(changeOrderStatus(t.db, as("fulfillment"), order.orderId, { to: "confirmed" }, NOW))).toMatchObject({ code: "forbidden" });
    // a page that still shows an older status changes nothing
    expect(await failureOf(changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "preparing" }, NOW))).toMatchObject({ code: "order_changed" });
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
    expect((await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW)).replayed).toBe(true);

    // shipping before packing is refused by the module
    expect(await failureOf(changeOrderStatus(t.db, as("fulfillment"), order.orderId, { to: "shipped" }, NOW))).toMatchObject({ code: "packing_incomplete" });

    const fulfil = as("fulfillment");
    const wrong = await scanCode(t.db, fulfil, order.orderId, { code: "NOT-A-CODE-123", scanId: randomToken(12) }, NOW);
    expect(wrong).toEqual({ ok: false, code: "not_in_order", orderItemId: undefined });
    expect((await orderRow(order.orderId)).status).toBe("preparing"); // the first scan started preparing
    expect(await scanCode(t.db, fulfil, order.orderId, { code: other.serials[0], scanId: randomToken(12) }, NOW)).toMatchObject({ ok: false, code: "serial_wrong_item" });
    expect(await scanCode(t.db, fulfil, order.orderId, { code: console5.sku, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: false, code: "scan_serial_instead" });
    const scanId = randomToken(12);
    const first = await scanCode(t.db, fulfil, order.orderId, { code: console5.serials[0].toLowerCase(), scanId }, NOW);
    expect(first).toMatchObject({ ok: true, kind: "serial", serial: console5.serials[0], scanned: 1, expected: 1 });
    expect(await scanCode(t.db, fulfil, order.orderId, { code: console5.serials[0], scanId }, NOW)).toMatchObject({ ok: true, replayed: true });
    expect(await scanCode(t.db, fulfil, order.orderId, { code: console5.serials[0], scanId: randomToken(12) }, NOW)).toMatchObject({ ok: true, kind: "already" });
    expect(await scanCode(t.db, fulfil, order.orderId, { code: console5.serials[1], scanId: randomToken(12) }, NOW)).toMatchObject({ ok: false, code: "line_complete" });
    const sold = await t.db.select({ status: serials.status }).from(serials).where(eq(serials.serial, console5.serials[0])).get();
    expect(sold?.status).toBe("sold");
    expect(await scanCode(t.db, fulfil, order.orderId, { code: pad.sku, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: true, kind: "unit", scanned: 1, expected: 2 });
    // the rest of the pad line confirmed by hand, with a reason (serial-tracked units cannot be)
    const padItem = (await packProgress(t.db, order.orderId)).lines.find((line) => line.sku === pad.sku)!.orderItemId;
    expect((await manualVerify(t.db, fulfil, order.orderId, { orderItemId: padItem, reason: "لا باركود على العلبة", scanId: randomToken(12) }, NOW)).units).toBe(1);
    const rejected = await t.db.select().from(shipmentEvents).where(eq(shipmentEvents.kind, "scan_rejected")).all();
    expect(rejected.length).toBeGreaterThanOrEqual(4);

    // fulfillment may not split someone else's? it may: pack permission; split the pad into parcel 2, then pack
    const progress = await packProgress(t.db, order.orderId);
    expect(progress.complete).toBe(true);
    const padLine = progress.lines.find((line) => line.sku === pad.sku)!;
    const split = await splitParcel(t.db, fulfil, order.orderId, { lines: [{ orderItemId: padLine.orderItemId, qty: 2 }] }, NOW);
    expect(split.number).toBe(2);
    expect((await markPacked(t.db, fulfil, order.orderId, NOW)).parcels).toBe(2);
    expect(await failureOf(splitParcel(t.db, fulfil, order.orderId, { lines: [{ orderItemId: padLine.orderItemId, qty: 1 }] }, NOW))).toMatchObject({ code: "parcel_packed" });
    const view = await getPackView(t.db, fulfil, order.ref, "ar", urls.deliveryProof);
    expect(view.parcels.filter((parcel) => parcel.status === "packed")).toHaveLength(2);

    // hand over: the core commits the stock; parcels and tasks follow; the customer gets a HELD message
    const before = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, pad.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
    await changeOrderStatus(t.db, fulfil, order.orderId, { to: "shipped", from: "preparing", trackingNo: "TRK-1" }, NOW + HOUR);
    const after = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, pad.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
    expect(after!.onHand).toBe(before!.onHand - 2);
    expect(after!.reserved).toBe(before!.reserved - 2);
    const parcels = await t.db.select().from(shipments).where(eq(shipments.orderId, order.orderId)).all();
    expect(parcels.filter((row) => row.status === "handed_over").map((row) => row.trackingNo)).toEqual(["TRK-1", "TRK-1"]);
    const held = await t.db.select().from(outbox).where(and(eq(outbox.refType, "order"), eq(outbox.refId, order.orderId))).all();
    expect(held.map((row) => [row.template, row.status])).toEqual(expect.arrayContaining([["order_confirmed", "held"], ["order_shipped", "held"]]));

    // proof of delivery: only once shipped, a private delivery_proof file
    const fileId = newId("fil");
    await t.db.insert(files).values({ id: fileId, storageKey: `prv_${fileId}.jpg`, visibility: "private", kind: "delivery_proof", mime: "image/jpeg", bytes: 1000, sha256: randomToken(), createdAt: NOW });
    expect(await failureOf(recordDeliveryProof(t.db, as("support"), order.orderId, { fileId, receivedByName: "علي" }, NOW))).toMatchObject({ code: "forbidden" });
    expect((await recordDeliveryProof(t.db, fulfil, order.orderId, { fileId, receivedByName: "علي حسن" }, NOW + 2 * HOUR)).parcels).toBe(2);

    await changeOrderStatus(t.db, fulfil, order.orderId, { to: "delivered", from: "shipped" }, NOW + 3 * HOUR);
    const due = (await orderRow(order.orderId)).totalIqd;
    expect(await failureOf(collectCod(t.db, fulfil, order.orderId, { amountIqd: due }, NOW + 3 * HOUR))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(collectCod(t.db, as("finance"), order.orderId, { amountIqd: due - 1000 }, NOW + 3 * HOUR))).toMatchObject({ code: "amount_mismatch" });
    expect((await collectCod(t.db, as("finance"), order.orderId, { amountIqd: due }, NOW + 3 * HOUR)).replayed).toBe(false);
    expect((await collectCod(t.db, as("finance"), order.orderId, { amountIqd: due }, NOW + 3 * HOUR)).replayed).toBe(true);
    const detail = await getOrderDetail(t.db, as("manager"), order.ref, "ar", NOW + 4 * HOUR, urls);
    expect(detail.status).toBe("delivered");
    expect(detail.paymentStatus).toBe("paid");
    expect(detail.parcels.every((parcel) => parcel.status === "delivered" && parcel.receivedByName === "علي حسن" && parcel.proofUrl?.startsWith("/admin/orders/files/"))).toBe(true);
    expect(detail.history.map((entry) => entry.kind)).toEqual(expect.arrayContaining(["placed", "status_confirmed", "serial_scanned", "verified_by_hand", "packed", "status_shipped", "delivery_proof", "status_delivered", "cod_collected"]));
    // the sale left at FIFO landed cost (manager sees it)
    expect(detail.costIqd).toBe(600_000 + 2 * 40_000);
  });

  test("a hold stops the order moving forward until it is cleared; cancelling stays possible and opens the refund path", async () => {
    const pad = await stocked(70_000, 10, 40_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    expect(await failureOf(decideReview(t.db, as("fulfillment"), order.orderId, { decision: "hold", reason: "اتصال مشبوه" }, NOW))).toMatchObject({ code: "forbidden" });
    await decideReview(t.db, as("finance"), order.orderId, { decision: "hold", reason: "اتصال مشبوه" }, NOW);
    expect(await failureOf(changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed" }, NOW))).toMatchObject({ code: "order_on_hold" });
    const detail = await getOrderDetail(t.db, as("manager"), order.ref, "ar", NOW, urls);
    expect(detail.transitions.find((option) => option.to === "confirmed")?.blocker).toBe("order_on_hold");
    expect(detail.transitions.find((option) => option.to === "cancelled")?.blocker).toBeNull();
    // the cancel dialog's impact: the held unit comes back
    expect(detail.transitions.find((option) => option.to === "cancelled")?.impact.units).toBe(1);
    expect(await failureOf(changeOrderStatus(t.db, as("manager"), order.orderId, { to: "cancelled" }, NOW))).toMatchObject({ code: "invalid" });
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "cancelled", reason: "العميل لا يرد" }, NOW);
    expect((await orderRow(order.orderId)).status).toBe("cancelled");
    const events = await t.db.select().from(orderEvents).where(eq(orderEvents.orderId, order.orderId)).all();
    expect(events.map((row) => row.kind)).toEqual(expect.arrayContaining(["review_hold", "status_changed"]));
  });

  test("assignment puts a task in the packer's list; reassigning cancels the old task; only packers can be chosen", async () => {
    const pad = await stocked(60_000, 10, 40_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    expect(await failureOf(assignOrder(t.db, as("fulfillment"), order.orderId, { employeeId: as("fulfillment").id }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(assignOrder(t.db, as("manager"), order.orderId, { employeeId: as("cashier").id }, NOW))).toMatchObject({ code: "invalid", fields: { employeeId: "assignee_not_packer" } });
    await assignOrder(t.db, as("manager"), order.orderId, { employeeId: as("fulfillment").id }, NOW);
    expect((await assignOrder(t.db, as("manager"), order.orderId, { employeeId: as("fulfillment").id }, NOW)).replayed).toBe(true);
    await assignOrder(t.db, as("manager"), order.orderId, { employeeId: as("inventory").id }, NOW);
    const tasks = await t.db.select().from(staffTasks).where(and(eq(staffTasks.refType, "order"), eq(staffTasks.refId, order.orderId))).all();
    expect(tasks.map((task) => [task.assignedTo, task.status]).sort()).toEqual(
      [
        [as("fulfillment").id, "cancelled"],
        [as("inventory").id, "open"],
      ].sort(),
    );
    const queue = await listFulfillment(t.db, as("inventory"), "ar");
    expect(queue.unassigned.concat(queue.others).map((row) => row.id)).not.toContain(order.orderId);
    expect(queue.mine.map((row) => row.id)).toEqual([]); // still "new": not packable yet
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed" }, NOW);
    expect((await listFulfillment(t.db, as("inventory"), "ar")).mine.map((row) => row.id)).toContain(order.orderId);
  });
});

// ───────────────────────────────────────────────────────────────── money: proofs, refunds

describe("money moves only through the core", () => {
  test("transfer proof: staff see the duplicate warning, amounts must match without the override, a decision is made once", async () => {
    const game = await stocked(70_000, 20, 45_000);
    const a = await placed([{ variantId: game.variantId, qty: 1 }], "bank_transfer");
    const b = await placed([{ variantId: game.variantId, qty: 1 }], "zaincash");
    const sha = randomToken().toLowerCase();
    await submitPaymentProof(t.db, { orderRef: a.ref, accessToken: a.accessToken }, { fileId: await proofFile(sha), declaredAmountIqd: a.totalIqd, reference: "TRX-1" }, NOW);
    await submitPaymentProof(t.db, { orderRef: b.ref, accessToken: b.accessToken }, { fileId: await proofFile(sha), declaredAmountIqd: b.totalIqd - 5000 }, NOW);
    const queue = await listProofQueue(t.db, as("finance"));
    const rowB = queue.find((row) => row.orderRef === b.ref)!;
    expect(rowB).toMatchObject({ duplicate: true, matches: false });
    const review = await getProofReview(t.db, as("finance"), rowB.paymentId, urls.proofImage);
    expect(review.current?.duplicateOf?.orderRef).toBe(a.ref);
    expect(review.current?.imageUrl).toMatch(/^\/admin\/orders\/proofs\/image\//);
    expect(review.canOverride).toBe(false);
    // without payment_proof.read: no image URL at all
    expect("imageUrl" in (await getProofReview(t.db, custom(["orders.payment.verify"]), rowB.paymentId, urls.proofImage)).current!).toBe(false);
    expect(await failureOf(verifyProof(t.db, as("finance"), rowB.paymentId, { approve: true }, NOW))).toMatchObject({ code: "amount_mismatch" });
    expect(await failureOf(verifyProof(t.db, as("manager"), rowB.paymentId, { approve: true }, NOW))).toMatchObject({ code: "invalid" });
    await verifyProof(t.db, as("finance"), rowB.paymentId, { approve: false, note: "المبلغ ناقص 5,000 د.ع" }, NOW);
    expect((await orderRow(b.orderId)).status).toBe("awaiting_payment");
    const rowA = queue.find((row) => row.orderRef === a.ref)!;
    expect(await failureOf(verifyProof(t.db, as("support"), rowA.paymentId, { approve: true }, NOW))).toMatchObject({ code: "forbidden" });
    expect((await verifyProof(t.db, as("finance"), rowA.paymentId, { approve: true }, NOW)).status).toBe("paid");
    expect((await verifyProof(t.db, as("finance"), rowA.paymentId, { approve: true }, NOW)).replayed).toBe(true);
    expect((await orderRow(a.orderId)).status).toBe("confirmed");
    const messages = await t.db.select({ template: outbox.template, status: outbox.status }).from(outbox).where(eq(outbox.refId, a.orderId)).all();
    expect(messages).toEqual(expect.arrayContaining([{ template: "payment_verified", status: "held" }]));
    // the proof image is served only through payment_proof.read
    expect(await proofFileOf(t.db, as("finance"), rowA.paymentId)).toBeNull(); // a payment id is not a proof id
    const proofId = (await getProofReview(t.db, as("finance"), rowA.paymentId, urls.proofImage)).history[0]?.id;
    expect(proofId).toBeTruthy();
    expect((await proofFileOf(t.db, as("finance"), proofId!))?.fileId).toBeTruthy();
  });

  test("refunds: two different people, never above what is refundable, idempotent; a cancelled paid order waits for the second person", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 1_000_000, kind: "topup", reason: "شحن تجريبي", idempotencyKey: `topup:${customerId}`, fundedBy: "cash" }, NOW);
    const item = await stocked(200_000, 10, 120_000);
    const order = await placed([{ variantId: item.variantId, qty: 2 }], "wallet", { customerId });
    const payment = (await t.db.select().from(payments).where(eq(payments.orderId, order.orderId)).get())!;
    const support = as("support");
    const key = randomToken(12);
    expect(await failureOf(requestRefund(t.db, support, { orderId: order.orderId, paymentId: payment.id, amountIqd: payment.amountIqd + 1, method: "original", reason: "طلب العميل", idempotencyKey: randomToken(12) }, NOW))).toMatchObject({
      code: "refund_exceeds_payment",
    });
    const asked = await requestRefund(t.db, support, { orderId: order.orderId, paymentId: payment.id, amountIqd: 50_000, method: "original", reason: "خدش في العلبة", idempotencyKey: key }, NOW);
    expect(asked.status).toBe("pending"); // the default approval threshold is 0: everything waits
    expect((await requestRefund(t.db, support, { orderId: order.orderId, paymentId: payment.id, amountIqd: 50_000, method: "original", reason: "خدش في العلبة", idempotencyKey: key }, NOW)).replayed).toBe(true);
    // support may follow their request but not approve it; nobody approves their own
    expect(await failureOf(decideRefund(t.db, support, asked.refundId, { approve: true }, NOW))).toMatchObject({ code: "forbidden" });
    const refundQueueForSupport = await listRefundQueue(t.db, support);
    expect(refundQueueForSupport.rows.map((row) => row.refundId)).toContain(asked.refundId);
    const financeQueue = await listRefundQueue(t.db, as("finance"));
    expect(financeQueue.rows.find((row) => row.refundId === asked.refundId)).toMatchObject({ mine: false, refundableIqd: payment.amountIqd - 50_000 });
    expect((await decideRefund(t.db, as("finance"), asked.refundId, { approve: true }, NOW)).status).toBe("paid");

    // a cancelled paid order: the canceller's pending refund needs another person
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "cancelled", reason: "العميل ألغى" }, NOW);
    const pending = await t.db.select().from(refunds).where(and(eq(refunds.orderId, order.orderId), eq(refunds.status, "pending"))).get();
    expect(pending?.amountIqd).toBe(payment.amountIqd - 50_000);
    expect(await failureOf(decideRefund(t.db, as("manager"), pending!.id, { approve: true }, NOW))).toMatchObject({ code: "approver_is_requester", status: 403 });
    const managerQueue = await listRefundQueue(t.db, as("manager"));
    expect(managerQueue.rows.find((row) => row.refundId === pending!.id)).toMatchObject({ mine: true, source: "order_cancelled" });
    expect(await failureOf(decideRefund(t.db, as("manager2"), pending!.id, { approve: false }, NOW))).toMatchObject({ code: "invalid" });
    expect((await decideRefund(t.db, as("manager2"), pending!.id, { approve: true }, NOW)).status).toBe("paid");
    const final = await orderRow(order.orderId);
    expect(final.refundedIqd).toBe(final.paidIqd);
    expect(final.paymentStatus).toBe("refunded");
  });
});

// ───────────────────────────────────────────────────────────────── review rules

describe("review rules are deterministic and explained", () => {
  test("rules flag at the same moment for everyone; clearing remembers the flags; a new flag brings the order back", async () => {
    const big = await stocked(1_600_000, 3, 1_300_000);
    const order = await placed([{ variantId: big.variantId, qty: 1 }], "cod");
    expect((await riskFlagsOf(t.db, [order.orderId], NOW)).get(order.orderId)).toEqual(["high_value_cod"]);
    const later = NOW + (RISK_THRESHOLDS.codUnconfirmedHours + 1) * HOUR;
    expect((await riskFlagsOf(t.db, [order.orderId], later)).get(order.orderId)).toEqual(["cod_unconfirmed", "high_value_cod"]);

    const queue = await listReviewQueue(t.db, as("finance"), NOW);
    expect(queue.needsReview.find((row) => row.id === order.orderId)?.flags).toEqual(["high_value_cod"]);
    await decideReview(t.db, as("finance"), order.orderId, { decision: "clear", reason: "اتصلنا بالعميل وأكد" }, NOW);
    expect((await listReviewQueue(t.db, as("finance"), NOW)).needsReview.map((row) => row.id)).not.toContain(order.orderId);
    // a day later a NEW rule applies → back in the queue with both flags
    expect((await listReviewQueue(t.db, as("finance"), later)).needsReview.find((row) => row.id === order.orderId)?.flags).toEqual(["cod_unconfirmed", "high_value_cod"]);
    // the list filters by the same rules
    const late = await listOrders(t.db, as("manager"), parseListFilters(new URLSearchParams("flag=late")), "ar", later);
    expect(late.rows.map((row) => row.id)).toContain(order.orderId);
    const suspicious = await listOrders(t.db, as("manager"), parseListFilters(new URLSearchParams(`flag=suspicious&q=${order.ref}`)), "ar", NOW);
    expect(suspicious.rows.map((row) => row.flags)).toEqual([["high_value_cod"]]);
    // support may ask for a review (orders.order.note), not decide one
    expect(await failureOf(decideReview(t.db, as("support"), order.orderId, { decision: "clear", reason: "لا أرى مشكلة" }, NOW))).toMatchObject({ code: "forbidden" });
  });

  test("phone history rules count the same phone only", async () => {
    const pad = await stocked(30_000, 30, 20_000);
    const phone = make.phone();
    const first = await placed([{ variantId: pad.variantId, qty: 1 }], "cod", { phone });
    const second = await placed([{ variantId: pad.variantId, qty: 1 }], "cod", { phone });
    await changeOrderStatus(t.db, as("manager"), first.orderId, { to: "cancelled", reason: "تجربة" }, NOW);
    await changeOrderStatus(t.db, as("manager"), second.orderId, { to: "cancelled", reason: "تجربة" }, NOW);
    const third = await placed([{ variantId: pad.variantId, qty: 6 }], "cod", { phone, at: NOW + HOUR });
    const flags = (await riskFlagsOf(t.db, [third.orderId], NOW + HOUR)).get(third.orderId);
    expect(flags).toEqual(["phone_cancellations", "bulk_quantity"]);
    const stranger = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    expect((await riskFlagsOf(t.db, [stranger.orderId], NOW + HOUR)).get(stranger.orderId)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── documents, pre-orders, notes

describe("documents, pre-orders and notes", () => {
  test("invoices are numbered once, gap-free, only for accepted orders; documents carry no cost", async () => {
    const pad = await stocked(45_000, 20, 30_000);
    const a = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const b = await placed([{ variantId: pad.variantId, qty: 2 }], "cod");
    await changeOrderStatus(t.db, as("manager"), a.orderId, { to: "confirmed" }, NOW);
    await changeOrderStatus(t.db, as("manager"), b.orderId, { to: "confirmed" }, NOW);
    const notYet = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const issued = await issueInvoices(t.db, as("fulfillment"), [a.orderId, b.orderId, notYet.orderId], NOW);
    expect(issued).toEqual({ issued: 2, skipped: 1 });
    expect((await issueInvoices(t.db, as("fulfillment"), [a.orderId, b.orderId], NOW + 1)).issued).toBe(0);
    const numbers = (await t.db.select({ number: invoices.number }).from(invoices).all()).map((row) => Number(row.number.slice(4))).sort((x, y) => x - y);
    expect(numbers).toEqual(numbers.map((_, index) => numbers[0] + index));
    const docs = await printDocuments(t.db, as("fulfillment"), { kind: "invoice", orderIds: [a.orderId, notYet.orderId] }, "ar");
    expect(docs.map((doc) => (doc.kind === "invoice" ? [doc.number !== null, doc.invoiceable] : null))).toEqual([
      [true, true],
      [false, false],
    ]);
    const labels = await printDocuments(t.db, as("fulfillment"), { kind: "label", orderIds: [b.orderId] }, "ar");
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ kind: "label", collectIqd: (await orderRow(b.orderId)).totalIqd });
    expect(labels[0].kind === "label" && labels[0].phone?.full).toBe(true);
    expect(JSON.stringify([docs, labels])).not.toMatch(/30000|cost/i);
  });

  test("pre-order: expected date, a later date is a delay update with a held message, the overdue rule follows", async () => {
    const pad = await stocked(55_000, 10, 30_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    expect(await failureOf(setPreorder(t.db, as("fulfillment"), order.orderId, { isPreorder: true, expectedDay: "2026-12-01", reason: "يصل الشهر القادم" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(setPreorder(t.db, as("manager"), order.orderId, { isPreorder: true, reason: "بلا تاريخ" }, NOW))).toMatchObject({ code: "invalid", fields: { expectedDay: "required" } });
    await setPreorder(t.db, as("manager"), order.orderId, { isPreorder: true, expectedDay: "2026-12-01", reason: "يصل الشهر القادم" }, NOW);
    const delayed = await setPreorder(t.db, as("manager"), order.orderId, { isPreorder: true, expectedDay: "2026-12-15", reason: "تأخر المورد" }, NOW + HOUR);
    expect(delayed.delayed).toBe(true);
    const events = await t.db.select({ kind: orderEvents.kind }).from(orderEvents).where(eq(orderEvents.orderId, order.orderId)).all();
    expect(events.map((row) => row.kind)).toEqual(expect.arrayContaining(["preorder_updated", "preorder_delayed"]));
    const held = await t.db.select().from(outbox).where(and(eq(outbox.refId, order.orderId), eq(outbox.template, "preorder_date_changed"))).all();
    expect(held).toHaveLength(2);
    expect(held.every((row) => row.status === "held")).toBe(true);
    expect((await listPreorders(t.db, as("support"), "ar", NOW)).rows.map((row) => row.id)).toContain(order.orderId);
    const afterDate = Date.UTC(2026, 11, 16);
    expect((await riskFlagsOf(t.db, [order.orderId], afterDate)).get(order.orderId)).toContain("preorder_overdue");
  });

  test("notes are staff-only history; the detail page's history carries actor and reason", async () => {
    const pad = await stocked(25_000, 10, 15_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    expect(await failureOf(addNote(t.db, as("inventory"), order.orderId, { text: "ملاحظة" }, NOW))).toMatchObject({ code: "forbidden" });
    await addNote(t.db, as("support"), order.orderId, { text: "العميل يفضل الاتصال بعد الخامسة" }, NOW);
    const detail = await getOrderDetail(t.db, as("fulfillment"), order.ref, "ar", NOW, urls);
    const note = detail.history.find((entry) => entry.kind === "note");
    expect(note).toMatchObject({ source: "order", actor: { kind: "employee", name: expect.stringContaining("support") }, data: { text: "العميل يفضل الاتصال بعد الخامسة" } });
    // the audit trail is only for audit.read
    expect(detail.history.some((entry) => entry.source === "audit")).toBe(false);
    expect((await getOrderDetail(t.db, as("finance"), order.ref, "ar", NOW, urls)).history.some((entry) => entry.source === "audit")).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── route glue

describe("routes", () => {
  const session = (actor: EmployeeActor): EmployeeSession =>
    ({
      employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
      actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
      roles: [],
      session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
    }) as EmployeeSession;
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.append(key, value);
    return data;
  };
  const store = () => ({ put: async () => {}, get: async () => null, delete: async () => {} });

  test("orderAction: each intent checks its own permission and answers in the employee's language", async () => {
    const pad = await stocked(40_000, 10, 25_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const ctx = { locale: "en" as const, now: NOW };
    const refused = await orderAction(ctx, t.db, session(as("fulfillment")), order.ref, form({ intent: "transition", to: "cancelled", reason: "test reason" }), store);
    expect(refused).toMatchObject({ ok: false, intent: "transition", code: "forbidden", status: 403 });
    const missingReason = await orderAction(ctx, t.db, session(as("manager")), order.ref, form({ intent: "transition", to: "cancelled", from: "new" }), store);
    expect(missingReason).toMatchObject({ ok: false, code: "invalid", status: 400, fields: { reason: expect.any(String) } });
    expect(await orderAction(ctx, t.db, session(as("support")), order.ref, form({ intent: "note", text: "call after 5pm" }), store)).toMatchObject({ ok: true, intent: "note" });
    expect(await orderAction(ctx, t.db, session(as("manager")), order.ref, form({ intent: "transition", to: "confirmed", from: "new" }), store)).toMatchObject({ ok: true, status: "confirmed" });
    const unknown = await orderAction(ctx, t.db, session(as("manager")), order.ref, form({ intent: "drop-table" }), store);
    expect(unknown).toMatchObject({ ok: false, code: "invalid" });
    const hold = await orderAction(ctx, t.db, session(as("finance")), order.ref, form({ intent: "review", decision: "hold", reason: "check the phone" }), store);
    expect(hold).toMatchObject({ ok: true, status: "blocked" });
    const blocked = await orderAction(ctx, t.db, session(as("manager")), order.ref, form({ intent: "transition", to: "preparing", from: "confirmed" }), store);
    expect(blocked).toMatchObject({ ok: false, code: "order_on_hold", message: expect.stringContaining("hold") });
    // a delivery proof is refused before anything is stored for a role that may not record one
    const upload = await orderAction(ctx, t.db, session(as("support")), order.ref, form({ intent: "delivery-proof", receivedByName: "Ali" }), store);
    expect(upload).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("packAction: scan → verify → packed → ship", async () => {
    const pad = await stocked(35_000, 10, 20_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed" }, NOW);
    const ctx = { locale: "ar" as const, now: NOW };
    const fulfil = session(as("fulfillment"));
    expect(await packAction(ctx, t.db, fulfil, order.ref, form({ intent: "ship", from: "confirmed" }))).toMatchObject({ ok: false, code: "packing_incomplete" });
    expect(await packAction(ctx, t.db, fulfil, order.ref, form({ intent: "scan", code: pad.sku, scanId: randomToken(12) }))).toMatchObject({ ok: true, outcome: { ok: true, kind: "unit" } });
    expect(await packAction(ctx, t.db, fulfil, order.ref, form({ intent: "packed" }))).toMatchObject({ ok: true });
    expect(await packAction(ctx, t.db, session(as("inventory")), order.ref, form({ intent: "ship", from: "preparing" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await packAction(ctx, t.db, fulfil, order.ref, form({ intent: "ship", from: "preparing", trackingNo: "X1" }))).toMatchObject({ ok: true });
    expect((await orderRow(order.orderId)).status).toBe("shipped");
  });

  test("loaders refuse a role without the page's permission (403) and send no cost data to the others", async () => {
    const pad = await stocked(42_000, 10, 26_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const signedIn = async (role: DefaultRoleKey) => {
      const password = "orders-staff-password-1";
      const hashed = await hashPassword(password, 1000);
      const email = `${make.next(role)}@orders.test`;
      const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
      const ctx = request();
      const result = await signInEmployee(ctx.ctx, t.db, { email, password });
      if (result.status !== "signed_in") throw new Error("sign-in failed");
      return cookieOf(ctx.setCookies);
    };
    const call = async <T,>(cookie: string, path: string, run: (context: RouterContextProvider, req: Request) => Promise<T>) => {
      const req = new Request(`http://localhost:5173${path}`, { headers: { cookie } });
      const context = new RouterContextProvider();
      try {
        let out: unknown;
        await requestContextMiddleware({ request: req, context, url: new URL(req.url), pattern: "/", params: {} }, async () => {
          out = await run(context, req);
          return new Response(null);
        });
        return out;
      } catch (error) {
        return error;
      }
    };
    const support = await signedIn("support");
    const proofs = (await call(support, "/admin/orders/proofs", (context, req) => proofsLoader({ request: req, context, params: {}, url: new URL(req.url), pattern: "admin/orders/proofs" } as never))) as { init?: { status?: number } };
    expect(proofs?.init?.status).toBe(403);
    const detail = (await call(support, `/admin/orders/${order.ref}`, (context, req) => orderLoader({ request: req, context, params: { ref: order.ref }, url: new URL(req.url), pattern: "admin/orders/:ref" } as never))) as { order: { ref: string } };
    expect(detail.order.ref).toBe(order.ref);
    expect(JSON.stringify(detail)).not.toMatch(/26000|costIqd|marginIqd|unitCostIqd/);
    const missing = (await call(support, "/admin/orders/TT-NOPE1234", (context, req) => orderLoader({ request: req, context, params: { ref: "TT-NOPE1234" }, url: new URL(req.url), pattern: "admin/orders/:ref" } as never))) as { init?: { status?: number } };
    expect(missing?.init?.status).toBe(404);
  });
});

// ───────────────────────────────────────────────────────────────── adversarial review (2026-11-11)

describe("adversarial review", () => {
  const session = (actor: EmployeeActor): EmployeeSession =>
    ({
      employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
      actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
      roles: [],
      session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
    }) as EmployeeSession;
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.append(key, value);
    return data;
  };
  const store = () => ({ put: async () => {}, get: async () => null, delete: async () => {} });

  test("a hold is lowered only by a reviewer's clear: asking for a review (flag) never lifts it", async () => {
    const pad = await stocked(52_000, 10, 30_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    await decideReview(t.db, as("finance"), order.orderId, { decision: "hold", reason: "رقم مشبوه" }, NOW);
    // support holds orders.order.note: it may ask for a review — but "flag" on a held order turned it into
    // needs_review, and the order could then be confirmed, packed and shipped
    expect(await failureOf(decideReview(t.db, as("support"), order.orderId, { decision: "flag", reason: "العميل اتصل" }, NOW))).toMatchObject({ code: "order_on_hold", status: 409 });
    expect(await failureOf(decideReview(t.db, as("finance"), order.orderId, { decision: "flag", reason: "مراجعة ثانية" }, NOW))).toMatchObject({ code: "order_on_hold" });
    expect((await orderRow(order.orderId)).reviewStatus).toBe("blocked");
    expect(await failureOf(changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW))).toMatchObject({ code: "order_on_hold" });
    // a reviewer's clear lifts it; asking for a review of an order that is not held still works for support
    await decideReview(t.db, as("finance"), order.orderId, { decision: "clear", reason: "تأكدنا من العميل" }, NOW);
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
    expect((await decideReview(t.db, as("support"), order.orderId, { decision: "flag", reason: "طلب العميل التحقق" }, NOW)).status).toBe("needs_review");
  });

  test("partial phone digits are searchable only with customer.phone.read_full — no digit-by-digit oracle behind the mask", async () => {
    const pad = await stocked(31_000, 10, 20_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const phone = (await orderRow(order.orderId)).contactPhoneE164!;
    const search = (q: string) => parseListFilters(new URLSearchParams({ q }));
    const ids = async (actor: EmployeeActor, q: string) => (await listOrders(t.db, actor, search(q), "ar", NOW)).rows.map((row) => row.id);
    // finance sees "0771 ••• ••52"; a search by some digits must not confirm the hidden ones (list and CSV)
    expect(await ids(as("finance"), phone.slice(-7))).not.toContain(order.orderId);
    expect(await ids(as("finance"), phone.slice(-9, -2))).not.toContain(order.orderId);
    expect((await exportOrdersCsv(t.db, as("finance"), search(phone.slice(-7)), {}, "ar", NOW)).csv).not.toContain(order.ref);
    // the whole number (already known to whoever types it) still finds the order; holders of the permission search by digits
    expect(await ids(as("finance"), `0${phone.slice(4)}`)).toContain(order.orderId);
    expect(await ids(as("support"), phone.slice(-7))).toContain(order.orderId);
  });

  test("an order's page acts only on that order's payments and refunds (no ids of another order through its URL)", async () => {
    const game = await stocked(66_000, 10, 40_000);
    const a = await placed([{ variantId: game.variantId, qty: 1 }], "bank_transfer");
    const b = await placed([{ variantId: game.variantId, qty: 1 }], "bank_transfer");
    await submitPaymentProof(t.db, { orderRef: b.ref, accessToken: b.accessToken }, { fileId: await proofFile(), declaredAmountIqd: b.totalIqd }, NOW);
    const paymentB = (await t.db.select().from(payments).where(eq(payments.orderId, b.orderId)).get())!;
    const ctx = { locale: "en" as const, now: NOW };
    const verified = await orderAction(ctx, t.db, session(as("finance")), a.ref, form({ intent: "verify", paymentId: paymentB.id, approve: "1" }), store);
    expect(verified).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect((await orderRow(b.orderId)).status).toBe("payment_review");

    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 300_000, kind: "topup", reason: "شحن تجريبي", idempotencyKey: `topup:${customerId}`, fundedBy: "cash" }, NOW);
    const c = await placed([{ variantId: game.variantId, qty: 1 }], "wallet", { customerId });
    const paymentC = (await t.db.select().from(payments).where(eq(payments.orderId, c.orderId)).get())!;
    const asked = await requestRefund(t.db, as("support"), { orderId: c.orderId, paymentId: paymentC.id, amountIqd: 10_000, method: "original", reason: "خدش", idempotencyKey: randomToken(12) }, NOW);
    const decided = await orderAction(ctx, t.db, session(as("finance")), a.ref, form({ intent: "refund-decision", refundId: asked.refundId, approve: "1" }), store);
    expect(decided).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect((await t.db.select({ status: refunds.status }).from(refunds).where(eq(refunds.id, asked.refundId)).get())?.status).toBe("pending");
    // through its own order's page it works
    expect(await orderAction(ctx, t.db, session(as("finance")), c.ref, form({ intent: "refund-decision", refundId: asked.refundId, approve: "1" }), store)).toMatchObject({ ok: true, status: "paid" });
  });

  test("a bundle is verified component by component: scanning one component again and again does not complete it", async () => {
    const a = await stocked(30_000, 10, 18_000);
    const b = await stocked(12_000, 10, 7_000);
    const bundle = await make.product({ priceIqd: 50_000 });
    await t.db.insert(bundleItems).values([
      { bundleVariantId: bundle.variantId, componentVariantId: a.variantId, qty: 1 },
      { bundleVariantId: bundle.variantId, componentVariantId: b.variantId, qty: 2 },
    ]);
    const order = await placed([{ variantId: bundle.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
    const fulfil = as("fulfillment");
    expect(await scanCode(t.db, fulfil, order.orderId, { code: a.sku, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: true, kind: "unit" });
    // the bundle holds ONE A: a second and a third A are refused — the box still needs two B
    expect(await scanCode(t.db, fulfil, order.orderId, { code: a.sku, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: false, code: "line_complete" });
    expect(await scanCode(t.db, fulfil, order.orderId, { code: a.sku, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: false, code: "line_complete" });
    expect((await packProgress(t.db, order.orderId)).complete).toBe(false);
    expect(await failureOf(changeOrderStatus(t.db, fulfil, order.orderId, { to: "shipped" }, NOW))).toMatchObject({ code: "packing_incomplete" });
    for (let i = 0; i < 2; i++) expect(await scanCode(t.db, fulfil, order.orderId, { code: b.sku, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: true, kind: "unit" });
    expect((await packProgress(t.db, order.orderId)).complete).toBe(true);
  });

  test("a used device's line takes that unit's own serial: a new unit of the same model is the wrong item", async () => {
    const model = await stocked(600_000, 2, 450_000, { trackSerials: true });
    const serialId = newId("ser");
    const usedSerial = `USED-${model.sku}`;
    await t.db.insert(serials).values({ id: serialId, serial: usedSerial, variantId: model.variantId, status: "in_stock", locationId: DEFAULT_LOCATION_ID, source: "trade_in", createdAt: NOW, updatedAt: NOW });
    const unitId = newId("usd");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used"), variantId: model.variantId, serialId, grade: "A", priceIqd: 420_000, acquisitionCostIqd: 300_000, status: "listed", isDemo: true, createdAt: NOW, updatedAt: NOW });
    const order = await placed([{ usedUnitId: unitId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
    const fulfil = as("fulfillment");
    // the shopper bought THIS used console at a used price: a new console's serial (same variant) must not be packed
    expect(await scanCode(t.db, fulfil, order.orderId, { code: model.serials[0], scanId: randomToken(12) }, NOW)).toMatchObject({ ok: false, code: "serial_wrong_item" });
    expect((await t.db.select({ status: serials.status }).from(serials).where(eq(serials.serial, model.serials[0])).get())?.status).toBe("in_stock");
    expect((await packProgress(t.db, order.orderId)).complete).toBe(false);
    expect(await scanCode(t.db, fulfil, order.orderId, { code: usedSerial, scanId: randomToken(12) }, NOW)).toMatchObject({ ok: true, kind: "serial", serial: usedSerial });
    expect((await packProgress(t.db, order.orderId)).complete).toBe(true);
  });

  test("amounts typed with Arabic-Indic or Persian (Kurdish keyboard) digits are read as the same whole dinars, on the server and in the dialogs", () => {
    const typed = (value: string) => {
      const data = new FormData();
      data.append("amountIqd", value);
      return amountOf(data, "amountIqd");
    };
    expect(typed("754,000")).toBe(754_000);
    expect(typed("٧٥٤٬٠٠٠")).toBe(754_000);
    expect(typed("۷۵۴٬۰۰۰")).toBe(754_000);
    expect(typed("")).toBeUndefined();
    expect(Number.isNaN(typed("75.5"))).toBe(true);
    // the dialogs decide "differs from what is due → reason needed" with the same reading
    expect(parseIqd("۷۵۴٬۰۰۰")).toBe(754_000);
    expect(parseIqd("٧٥٤ ٠٠٠")).toBe(754_000);
    expect(Number.isNaN(parseIqd("abc"))).toBe(true);
  });

  test("a cancelled order sold nothing: no margin on its page or in the CSV (not a profit, not a loss of its whole cost)", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 500_000, kind: "topup", reason: "شحن تجريبي", idempotencyKey: `topup:${customerId}`, fundedBy: "cash" }, NOW);
    const item = await stocked(120_000, 10, 70_000);
    const order = await placed([{ variantId: item.variantId, qty: 2 }], "wallet", { customerId });
    expect((await getOrderDetail(t.db, as("manager"), order.ref, "ar", NOW, urls)).marginIqd).toBe(240_000 - 140_000); // expected, before shipping
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "cancelled", reason: "العميل ألغى" }, NOW);
    const pending = (await t.db.select().from(refunds).where(and(eq(refunds.orderId, order.orderId), eq(refunds.status, "pending"))).get())!;
    await decideRefund(t.db, as("manager2"), pending.id, { approve: true }, NOW);
    const detail = await getOrderDetail(t.db, as("manager"), order.ref, "ar", NOW, urls);
    expect(detail.totals.refundedIqd).toBe(detail.totals.paidIqd);
    // before: 240,000 − 245,000 refunded − 140,000 = −145,000 shown as this order's margin
    expect(detail.marginIqd).toBeUndefined();
    expect(detail.lines[0].marginIqd).toBeUndefined();
    const csv = (await exportOrdersCsv(t.db, as("manager"), parseListFilters(new URLSearchParams({ q: order.ref })), { marginIqd: "MARGIN" }, "en", NOW)).csv.trim().split("\r\n");
    const header = csv[0].split(",");
    expect(csv[1].split(",")[header.indexOf("MARGIN")]).toBe("");
  });

  test("a shipping label says 'prepaid' only for an order paid in full; an unpaid or cancelled order's label says not to hand it over", async () => {
    const pad = await stocked(41_000, 20, 25_000);
    const transfer = await placed([{ variantId: pad.variantId, qty: 1 }], "bank_transfer"); // awaiting a proof: NOT paid
    const cod = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), cod.orderId, { to: "confirmed", from: "new" }, NOW);
    const cancelled = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    await changeOrderStatus(t.db, as("manager"), cancelled.orderId, { to: "cancelled", reason: "العميل ألغى" }, NOW);
    const customerId = await make.customer();
    await creditWallet(t.db, system, { customerId, amountIqd: 200_000, kind: "topup", reason: "شحن تجريبي", idempotencyKey: `topup:${customerId}`, fundedBy: "cash" }, NOW);
    const wallet = await placed([{ variantId: pad.variantId, qty: 1 }], "wallet", { customerId });
    const labels = await printDocuments(t.db, as("fulfillment"), { kind: "label", orderIds: [transfer.orderId, cod.orderId, cancelled.orderId, wallet.orderId] }, "ar");
    // before: the transfer and the cancelled order printed "Prepaid — collect nothing"
    expect(labels.map((doc) => (doc.kind === "label" ? [doc.payment, doc.collectIqd, doc.shippable] : null))).toEqual([
      ["unpaid", 0, false],
      ["collect", cod.totalIqd, true],
      ["unpaid", 0, false],
      ["prepaid", 0, true],
    ]);
    const slips = await printDocuments(t.db, as("fulfillment"), { kind: "packing", orderIds: [cancelled.orderId, cod.orderId] }, "ar");
    expect(slips.map((doc) => (doc.kind === "packing" ? doc.shippable : null))).toEqual([false, true]);
  });

  test("an impossible calendar day is not a pre-order date", async () => {
    const pad = await stocked(27_000, 10, 15_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    expect(await failureOf(setPreorder(t.db, as("manager"), order.orderId, { isPreorder: true, expectedDay: "2027-02-30", reason: "تاريخ خطأ" }, NOW))).toMatchObject({ code: "invalid", fields: { expectedDay: "invalid" } });
    expect((await orderRow(order.orderId)).isPreorder).toBe(false);
  });

  test("the edit page sends the full phone only with customer.phone.read_full; an address saved without it keeps the number", async () => {
    const pad = await stocked(33_000, 10, 20_000);
    const order = await placed([{ variantId: pad.variantId, qty: 1 }], "cod");
    const phone = (await orderRow(order.orderId)).contactPhoneE164!;
    // a custom role: may edit orders, may not see full phone numbers
    const editorRole = newId("rol");
    await t.db.insert(roles).values({ id: editorRole, key: `order_editor_${make.next("r")}`, name: { ar: "محرر طلبات", en: "Order editor" }, createdAt: NOW });
    await t.db.insert(rolePermissions).values([
      { roleId: editorRole, permission: "orders.order.read" },
      { roleId: editorRole, permission: "orders.order.update" },
    ]);
    const password = "orders-editor-password-1";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("editor")}@orders.test`;
    const editorId = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    await t.db.insert(employeeRoles).values({ employeeId: editorId, roleId: editorRole });
    const signIn = request();
    if ((await signInEmployee(signIn.ctx, t.db, { email, password })).status !== "signed_in") throw new Error("sign-in failed");
    const cookie = cookieOf(signIn.setCookies);
    const path = `/admin/orders/${order.ref}/edit`;
    const req = new Request(`http://localhost:5173${path}`, { headers: { cookie } });
    const context = new RouterContextProvider();
    let page: unknown;
    await requestContextMiddleware({ request: req, context, url: new URL(req.url), pattern: "/", params: {} }, async () => {
      page = await editLoader({ request: req, context, params: { ref: order.ref }, url: new URL(req.url), pattern: "admin/orders/:ref/edit" } as never);
      return new Response(null);
    });
    expect((page as { order: { ref: string } }).order.ref).toBe(order.ref);
    expect(JSON.stringify(page)).not.toContain(phone.slice(-7));
    expect(JSON.stringify(page)).not.toContain(phone.slice(-9, -2));
    // the form leaves the number empty for this employee: saving the address keeps the customer's number
    const editor: EmployeeActor = { kind: "employee", id: editorId, permissions: new Set<Permission>(["orders.order.read", "orders.order.update"]) };
    await editOrder(
      t.db,
      editor,
      order.orderId,
      { address: { governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة خارج", addressText: "شارع 52، بيت 9، قرب المخبز" }, reason: "عنوان أدق", idempotencyKey: randomToken(18) },
      NOW,
    );
    expect(await orderRow(order.orderId)).toMatchObject({ contactPhoneE164: phone, areaText: "الكرادة خارج" });
  });
});

// ───────────────────────────────────────────────────────────────── pure helpers

describe("pure helpers", () => {
  test("list filters come from the URL; unknown values are dropped, the query round-trips", () => {
    const filters = parseListFilters(new URLSearchParams("status=new&status=bogus&payment=paid&method=cod,zaincash&flag=late&flag=x&from=2026-11-31&to=2026-11-10&sort=total_desc&page=3&assigned=me&gov=gov_baghdad&q=%20TT-7K4M%20"));
    expect(filters).toMatchObject({ q: "TT-7K4M", status: ["new"], payment: ["paid"], method: ["cod", "zaincash"], flags: ["late"], from: null, to: "2026-11-10", sort: "total_desc", page: 3, assigned: "me", governorate: "gov_baghdad" });
    expect(parseListFilters(new URLSearchParams(listSearch(filters).slice(1)))).toEqual(filters);
    expect(parseListFilters(new URLSearchParams("from=2026-11-12&to=2026-11-01"))).toMatchObject({ from: "2026-11-01", to: "2026-11-12" });
  });

  test("Code 128: every symbol is 11 modules (stop 13), checksum per ISO/IEC 15417", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, value) => expect([...pattern].reduce((sum, digit) => sum + Number(digit), 0), String(value)).toBe(value === 106 ? 13 : 11));
    expect(new Set(CODE128_PATTERNS.slice(0, 106)).size).toBe(106);
    // "Wikipedia" in code set B: checksum 88
    expect(code128Values("Wikipedia")?.slice(-2)).toEqual([88, 106]);
    const modules = code128Modules("TT-7K4M2Q9X")!;
    expect(modules.reduce((sum, width) => sum + width, 0)).toBe(11 * (1 + 11 + 1) + 13);
    expect(code128Modules("طلب")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── request helpers (sign-in for the loader test)

function request(): { ctx: RequestCtx; setCookies: string[] } {
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `orders-${randomToken(6)}`,
    nonce: "n",
    origin: "http://localhost:5173",
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

function cookieOf(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

