/**
 * Admin module 12 "returns" (owner: admin returns) — the services under app/server/services/admin/returns and the route
 * glue of app/routes/admin/returns, on a real local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · authorization per role (manager, finance, support, inventory, cashier, content) and field rules (phones masked,
 *     no cost data in any result), the cashier who may only open RMAs sees the ones they opened
 *   · eligibility (12.02): the general window from settings, rule precedence category › kind › catch-all, new/used,
 *     not returnable, the seal rule (store-fault reasons exempt), units already in returns or refunded
 *   · opening an RMA (12.01): idempotent, serials from the line only, override only with the right and a reason, two
 *     RMAs racing for one unit, photos limit
 *   · decisions: the opener never decides (two people), rejection needs a reason
 *   · inspection (12.03): a swapped serial is refused and recorded, goods move through the core, quarantine needs a
 *     non-sellable location, warranties of returned units end, replays are harmless
 *   · refunds (12.04, 12.05): only inspected units, never above their value or getRefundableAmount, two people, never
 *     twice for the same unit (here, through the orders module, or by a double submit), wallet needs an account
 *   · fraud signals explained; quarantine exits; repairs with SLA (12.07); warranties (12.06); rules screen
 *   · the route action checks the intent's permission before anything is read; loaders answer 403
 */
import { and, eq, inArray } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as indexLoader } from "~/routes/admin/returns/index";
import { loader as rmaLoader } from "~/routes/admin/returns/rma";
import { rmaAction } from "~/routes/admin/returns/rma.server";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import {
  auditEvents,
  categories,
  employeeRoles,
  files,
  inventoryLocations,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  products,
  refunds,
  repairEvents,
  repairTickets,
  returnItems,
  returns,
  serials,
  settings,
  stockLevels,
  supplierClaims,
  suppliers,
  usedUnits,
  variantCosts,
  warranties,
  type ProductKind,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { inspectItem, listQuarantine, resolveQuarantine } from "~/server/services/admin/returns/inspect.server";
import { listPolicies, savePolicy } from "~/server/services/admin/returns/policy.server";
import { decideReturnRefund, requestReturnRefund } from "~/server/services/admin/returns/refund.server";
import { addPart, changeRepairStatus, getRepair, listRepairs, openCounterRepair, openReturnRepair, recordQuoteDecision, setDiagnosis, setRepairSla } from "~/server/services/admin/returns/repair.server";
import { assertPhotoSlot, closeReturn, decideReturn, findOrderForReturn, getReturnDetail, listReturns, MAX_RETURN_PHOTOS, openReturn, queueCounts } from "~/server/services/admin/returns/rma.server";
import { parseRepairFilters, parseRmaFilters, parseWarrantyFilters, parseWhole } from "~/server/services/admin/returns/types";
import { extendWarranty, getWarranty, listWarranties, voidWarranty } from "~/server/services/admin/returns/warranty.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { assignSerialsStatements, getAvailability, receiveStock } from "~/server/services/inventory/stock.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { recordCodCollection } from "~/server/services/payments/payments.server";
import { createRefund } from "~/server/services/refunds.server";
import { createRepairTicket } from "~/server/services/support/repairs.server";
import { creditWallet } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const system = systemActor("test.admin-returns");
const urls = { photo: (id: string) => `/admin/returns/files/${id}` };

let t: TestDb;
let make: Fixtures;
let quarantineId: string;
const staff: Partial<Record<DefaultRoleKey | "manager2" | "finance2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "fulfillment", "support", "inventory", "cashier", "content"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
  staff.finance2 = await employee("finance");
  quarantineId = newId("loc");
  await t.db.insert(inventoryLocations).values({ id: quarantineId, code: `RQ-${randomToken(4)}`, name: "Returns quarantine", kind: "warehouse", isSellable: false });
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}

const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const custom = (permissions: Permission[], id = as("manager").id): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

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

async function stocked(priceIqd: number, qty: number, unitCostIqd: number, options: { trackSerials?: boolean; kind?: ProductKind; warrantyMonths?: number; categoryId?: string } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials, kind: options.kind });
  if (options.warrantyMonths || options.categoryId) await t.db.update(products).set({ warrantyMonths: options.warrantyMonths ?? null, categoryId: options.categoryId ?? null, specs: { warranty: { ar: "ضمان الشركة سنة", en: "Maker's warranty, 1 year" } } }).where(eq(products.id, product.productId));
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `SN-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: unitCostIqd, landedCostIqd: unitCostIqd, updatedAt: NOW }).onConflictDoNothing();
  return { ...product, serials: serialNumbers ?? [] };
}

type Delivered = Awaited<ReturnType<typeof placeOrder>> & { items: (typeof orderItems.$inferSelect)[]; phone: string };

/** A COD order taken to delivery through the core at `at` (serials attached at packing). */
async function delivered(lines: ({ variantId: string; qty: number } | { usedUnitId: string; qty: number })[], options: { at?: number; customerId?: string | null; phone?: string; method?: "cod" | "wallet" } = {}): Promise<Delivered> {
  const at = options.at ?? NOW;
  const customerId = options.customerId ?? null;
  const phone = options.phone ?? make.phone();
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "ar" }, line, at)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "ar", governorateId: governorateId("baghdad") }, at);
  const order = await placeOrder(
    t.db,
    { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: randomToken(), phone: `0${phone.slice(4)}`, governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة", addressText: "شارع 62، عمارة 4", marketingConsent: false, paymentMethod: options.method ?? "cod", expectedTotalIqd: view.totalIqd },
    at,
  );
  if ((options.method ?? "cod") === "cod") await transitionOrder(t.db, system, order.orderId, "confirmed", {}, at);
  await transitionOrder(t.db, system, order.orderId, "preparing", {}, at);
  const items = await t.db.select().from(orderItems).where(eq(orderItems.orderId, order.orderId));
  for (const item of items) {
    // a used device's line takes that unit's own serial
    const own = item.usedUnitId ? (await t.db.select({ id: usedUnits.serialId }).from(usedUnits).where(eq(usedUnits.id, item.usedUnitId)).get())?.id : null;
    const free = own ? [{ id: own }] : await t.db.select({ id: serials.id }).from(serials).where(and(eq(serials.variantId, item.variantId), eq(serials.status, "in_stock"))).limit(item.qty);
    if (free.length) await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: item.id, serialIds: free.map((row) => row.id), actor: system, now: at }));
  }
  await transitionOrder(t.db, system, order.orderId, "shipped", {}, at);
  if ((options.method ?? "cod") === "cod") await recordCodCollection(t.db, system, order.orderId, order.totalIqd, at);
  await transitionOrder(t.db, system, order.orderId, "delivered", {}, at);
  return { ...order, items, phone };
}

const serialOf = async (orderItemId: string) => (await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, orderItemId)).get())!.serialId;
const serialText = async (serialId: string) => (await t.db.select().from(serials).where(eq(serials.id, serialId)).get())!.serial;
const paymentOf = async (orderId: string) => (await t.db.select().from(payments).where(and(eq(payments.orderId, orderId), eq(payments.status, "paid"))).get())!;

/** An RMA opened by support for every unit of one line, approved by a manager. */
async function approvedReturn(order: Delivered, options: { line?: number; reasonCode?: "defective" | "changed_mind"; approve?: boolean; opener?: EmployeeActor; at?: number } = {}) {
  const item = order.items[options.line ?? 0];
  const serialIds = (await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, item.id)).all()).map((row) => row.serialId);
  const opened = await openReturn(
    t.db,
    options.opener ?? as("support"),
    { orderRef: order.ref, items: [{ orderItemId: item.id, qty: item.qty, serialIds: serialIds.length ? serialIds : undefined, sealed: true }], reasonCode: options.reasonCode ?? "defective", reason: "لا يعمل بعد التشغيل", requestedResolution: "refund", idempotencyKey: randomToken() },
    options.at ?? NOW + DAY,
  );
  if (options.approve !== false) await decideReturn(t.db, as("manager"), opened.returnId, { approve: true }, (options.at ?? NOW + DAY) + HOUR);
  return { ...opened, item, serialIds };
}

const itemsOf = async (returnId: string) => t.db.select().from(returnItems).where(eq(returnItems.returnId, returnId)).all();

// ───────────────────────────────────────────────────────────────── authorization and field rules

describe("authorization per role", () => {
  test("the list: every returns reader reads; the cashier (may only open RMAs) sees the ones they opened; content is refused", async () => {
    const pad = await stocked(80_000, 10, 50_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const mine = await openReturn(t.db, as("cashier"), { orderRef: order.ref, items: [{ orderItemId: order.items[0].id, qty: 1 }], reasonCode: "changed_mind", reason: "غيّر رأيه بعد يوم", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY);
    for (const key of ["manager", "finance", "support", "inventory", "fulfillment"] as const) {
      const page = await listReturns(t.db, as(key), parseRmaFilters(new URLSearchParams(`q=${mine.rma}`)), "ar", NOW + DAY);
      expect(page.rows.map((row) => row.rma), key).toContain(mine.rma);
    }
    expect((await listReturns(t.db, as("cashier"), parseRmaFilters(new URLSearchParams()), "ar", NOW + DAY)).rows.map((row) => row.rma)).toEqual([mine.rma]);
    const other = await approvedReturn(await delivered([{ variantId: pad.variantId, qty: 1 }]), { approve: false });
    expect((await listReturns(t.db, as("cashier"), parseRmaFilters(new URLSearchParams()), "ar", NOW + DAY)).rows.map((row) => row.rma)).not.toContain(other.rma);
    expect(await failureOf(getReturnDetail(t.db, as("cashier"), other.rma, "ar", NOW + DAY, urls))).toMatchObject({ code: "not_found" });
    expect((await getReturnDetail(t.db, as("cashier"), mine.rma, "ar", NOW + DAY, urls)).rma).toBe(mine.rma);
    expect(await failureOf(listReturns(t.db, as("content"), parseRmaFilters(new URLSearchParams()), "ar", NOW))).toMatchObject({ code: "forbidden", status: 403 });
  });

  test("phones are masked without customer.phone.read_full; no cost data in any view", async () => {
    const console5 = await stocked(700_000, 3, 512_345, { trackSerials: true });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const rma = await approvedReturn(order);
    const finance = await getReturnDetail(t.db, as("finance"), rma.rma, "ar", NOW + DAY, urls);
    expect(finance.customer.phone).toMatchObject({ full: false });
    expect(JSON.stringify(finance)).not.toContain(order.phone.slice(-6));
    expect((await getReturnDetail(t.db, as("support"), rma.rma, "ar", NOW + DAY, urls)).customer.phone?.full).toBe(true);
    for (const key of ["manager", "finance", "support", "inventory"] as const) {
      const json = JSON.stringify(await getReturnDetail(t.db, as(key), rma.rma, "ar", NOW + DAY, urls)) + JSON.stringify(await listReturns(t.db, as(key), parseRmaFilters(new URLSearchParams(`q=${rma.rma}`)), "ar", NOW + DAY));
      expect(json, key).not.toMatch(/512345|costIqd|unitCost/);
    }
    // partial phone digits would reveal masked numbers: only with the full-phone permission
    const digits = order.phone.slice(-6);
    expect((await listReturns(t.db, as("finance"), parseRmaFilters(new URLSearchParams(`q=${digits}`)), "ar", NOW + DAY)).rows).toEqual([]);
    expect((await listReturns(t.db, as("support"), parseRmaFilters(new URLSearchParams(`q=${digits}`)), "ar", NOW + DAY)).rows.map((row) => row.rma)).toContain(rma.rma);
  });
});

// ───────────────────────────────────────────────────────────────── eligibility (12.02)

describe("eligibility rules", () => {
  test("the general window from settings; a category rule beats a kind rule beats the catch-all; new vs used", async () => {
    await t.db.insert(settings).values({ key: "returns.window_days", value: 7, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value: 7 } });
    const parent = newId("cat");
    const child = newId("cat");
    await t.db.insert(categories).values([
      { id: parent, slug: `games-${randomToken(4).toLowerCase()}`, name: { ar: "ألعاب" } },
      { id: child, parentId: parent, slug: `sealed-${randomToken(4).toLowerCase()}`, name: { ar: "ألعاب مغلقة" } },
    ]);
    const game = await stocked(60_000, 10, 40_000, { kind: "game", categoryId: child });
    const pad = await stocked(40_000, 10, 25_000, { kind: "accessory" });
    const order = await delivered([
      { variantId: game.variantId, qty: 1 },
      { variantId: pad.variantId, qty: 1 },
    ]);
    const row = await t.db.select().from(orders).where(eq(orders.id, order.orderId)).get();
    let lines = (await findOrderForReturn(t.db, as("support"), order.ref, "ar", NOW + 3 * DAY)).lines;
    expect(lines.every((line) => line.eligibility.eligible && line.eligibility.rule.source === "setting" && line.eligibility.windowDays === 7)).toBe(true);
    // 8 days after delivery: the window closed
    lines = (await findOrderForReturn(t.db, as("support"), order.ref, "ar", (row?.deliveredAt ?? NOW) + 8 * DAY)).lines;
    expect(lines[0].eligibility.problems).toContain("window_closed");

    await savePolicy(t.db, as("manager"), { productKind: "*", itemCondition: "*", isReturnable: true, windowDays: 14, requiresSealed: false, restockingFeeBps: 0, note: { ar: "أربعة عشر يوماً" }, sort: 0, isActive: true, reason: "قاعدة عامة" }, NOW);
    await savePolicy(t.db, as("manager"), { productKind: "game", itemCondition: "new", isReturnable: true, windowDays: 3, requiresSealed: true, restockingFeeBps: 1000, note: {}, sort: 0, isActive: true, reason: "الألعاب" }, NOW);
    await savePolicy(t.db, as("manager"), { productKind: "*", categoryId: parent, itemCondition: "*", isReturnable: false, windowDays: null, requiresSealed: false, restockingFeeBps: 0, note: {}, sort: 0, isActive: true, reason: "فئة الألعاب المغلقة" }, NOW);
    lines = (await findOrderForReturn(t.db, as("support"), order.ref, "ar", (row?.deliveredAt ?? NOW) + 2 * DAY)).lines;
    const gameLine = lines.find((line) => line.orderItemId === order.items.find((item) => item.variantId === game.variantId)?.id)!;
    const padLine = lines.find((line) => line.orderItemId === order.items.find((item) => item.variantId === pad.variantId)?.id)!;
    // the parent category's rule reaches the subcategory and wins over the kind rule
    expect(gameLine.eligibility.rule.source).toBe("category");
    expect(gameLine.eligibility.problems).toEqual(["not_returnable"]);
    expect(padLine.eligibility).toMatchObject({ eligible: true, windowDays: 14, rule: { source: "catch_all", note: "أربعة عشر يوماً" } });
    // switching the category rule off: the kind rule decides (3 days, sealed, 10 % fee)
    const { rules } = await listPolicies(t.db, as("support"), "ar");
    const categoryRule = rules.find((rule) => rule.categoryId === parent)!;
    await savePolicy(t.db, as("manager"), { ...categoryRule, categoryId: categoryRule.categoryId ?? undefined, itemCondition: categoryRule.itemCondition, productKind: categoryRule.productKind as never, note: {}, isActive: false, reason: "إيقاف القاعدة" }, NOW);
    lines = (await findOrderForReturn(t.db, as("support"), order.ref, "ar", (row?.deliveredAt ?? NOW) + 2 * DAY)).lines;
    expect(lines.find((line) => line.orderItemId === gameLine.orderItemId)?.eligibility).toMatchObject({ eligible: true, windowDays: 3, requiresSealed: true, restockingFeeBps: 1000, rule: { source: "kind" } });
    // the seal rule: an unsealed game returned for a change of mind is outside the rules; a defect is not
    const unsealed = await failureOf(openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: gameLine.orderItemId, qty: 1, sealed: false }], reasonCode: "changed_mind", reason: "فتحها ولم تعجبه", requestedResolution: "refund", idempotencyKey: randomToken() }, (row?.deliveredAt ?? NOW) + DAY));
    expect(unsealed).toMatchObject({ code: "not_eligible" });
    const defect = await openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: gameLine.orderItemId, qty: 1, sealed: false }], reasonCode: "defective", reason: "القرص لا يعمل", requestedResolution: "exchange", idempotencyKey: randomToken() }, (row?.deliveredAt ?? NOW) + DAY);
    expect(defect.rma).toMatch(/^RMA-/);
    // every rule change is audited with its reason
    expect((await t.db.select().from(auditEvents).where(inArray(auditEvents.action, ["returns.policy.create", "returns.policy.update"])).all()).length).toBeGreaterThanOrEqual(4);
    // rules are managed by returns.policy.manage only
    expect(await failureOf(savePolicy(t.db, as("support"), { productKind: "*", itemCondition: "*", isReturnable: true, windowDays: 1, requiresSealed: false, restockingFeeBps: 0, note: {}, sort: 0, isActive: true, reason: "x-test" }, NOW))).toMatchObject({ code: "forbidden" });
    // leave the catch-all wide open for the rest of the file
    const all = (await listPolicies(t.db, as("manager"), "ar")).rules;
    for (const rule of all) await savePolicy(t.db, as("manager"), { id: rule.id, productKind: rule.productKind as never, categoryId: rule.categoryId ?? undefined, itemCondition: rule.itemCondition, isReturnable: rule.isReturnable, windowDays: rule.windowDays, requiresSealed: rule.requiresSealed, restockingFeeBps: rule.restockingFeeBps, note: {}, sort: rule.sort, isActive: false, reason: "تنظيف بعد الاختبار" }, NOW);
  });

  test("units already in another return, or refunded outside a return, cannot be returned again", async () => {
    const cable = await stocked(20_000, 10, 8_000);
    const order = await delivered([{ variantId: cable.variantId, qty: 3 }]);
    const item = order.items[0];
    await openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: item.id, qty: 1 }], reasonCode: "defective", reason: "واحد لا يشحن", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY);
    const payment = await paymentOf(order.orderId);
    await createRefund(t.db, as("support"), { orderId: order.orderId, paymentId: payment.id, items: [{ orderItemId: item.id, qty: 1 }], amountIqd: 20_000, method: "cash", reason: "استرداد من صفحة الطلب", idempotencyKey: randomToken() }, NOW + DAY);
    const line = (await findOrderForReturn(t.db, as("support"), order.ref, "ar", NOW + DAY)).lines[0];
    expect(line.returnableQty).toBe(1);
    expect(await failureOf(openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: item.id, qty: 2 }], reasonCode: "defective", reason: "اثنان لا يعملان", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY))).toMatchObject({ code: "return_qty_exceeds" });
  });
});

// ───────────────────────────────────────────────────────────────── opening and deciding (12.01)

describe("opening an RMA and deciding it", () => {
  test("idempotent on the form's key; serials only from the line; outside the rules only with the right and a reason", async () => {
    const console5 = await stocked(650_000, 4, 480_000, { trackSerials: true });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const item = order.items[0];
    const serialId = await serialOf(item.id);
    const key = randomToken();
    const input = { orderRef: order.ref, items: [{ orderItemId: item.id, qty: 1, serialIds: [serialId] }], reasonCode: "defective" as const, reason: "لا يعطي صورة", requestedResolution: "repair" as const, idempotencyKey: key };
    const first = await openReturn(t.db, as("support"), input, NOW + DAY);
    const again = await openReturn(t.db, as("support"), input, NOW + DAY);
    expect(again).toMatchObject({ returnId: first.returnId, rma: first.rma, replayed: true });
    expect((await t.db.select().from(returns).where(eq(returns.orderId, order.orderId)).all()).length).toBe(1);
    // nothing chosen: the field says what is missing
    expect(await failureOf(openReturn(t.db, as("support"), { ...input, items: [], idempotencyKey: randomToken() }, NOW + DAY))).toMatchObject({ code: "invalid", fields: { items: "items_required" } });
    // a serial of another unit is refused
    const order2 = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const other = (await t.db.select({ id: serials.id }).from(serials).where(and(eq(serials.variantId, console5.variantId), eq(serials.status, "in_stock"))).get())!.id;
    expect(await failureOf(openReturn(t.db, as("support"), { ...input, orderRef: order2.ref, items: [{ orderItemId: order2.items[0].id, qty: 1, serialIds: [other] }], idempotencyKey: randomToken() }, NOW + DAY))).toMatchObject({ code: "invalid", fields: { items: "serial_not_on_line" } });
    // past the window: support cannot; a manager can with a reason, and the signal says so
    const late = NOW + 30 * DAY;
    const lateInput = { ...input, orderRef: order2.ref, items: [{ orderItemId: order2.items[0].id, qty: 1, serialIds: [await serialOf(order2.items[0].id)] }], idempotencyKey: randomToken() };
    expect(await failureOf(openReturn(t.db, as("support"), lateInput, late))).toMatchObject({ code: "not_eligible" });
    expect(await failureOf(openReturn(t.db, as("support"), { ...lateInput, override: true, overrideReason: "عميل دائم" }, late))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(openReturn(t.db, as("manager"), { ...lateInput, override: true }, late))).toMatchObject({ code: "invalid", fields: { overrideReason: "override_reason_required" } });
    const overridden = await openReturn(t.db, as("manager"), { ...lateInput, override: true, overrideReason: "عميل دائم، موافقة المدير" }, late);
    const detail = await getReturnDetail(t.db, as("manager2"), overridden.rma, "ar", late, urls);
    expect(detail.flags.map((flag) => flag.id)).toContain("policy_override");
    expect(detail.items[0].eligibility?.problems).toContain("window_closed");
  });

  test("two RMAs racing for the same unit: one wins", async () => {
    const pad = await stocked(45_000, 5, 30_000, { trackSerials: true });
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const item = order.items[0];
    const serialId = await serialOf(item.id);
    const attempt = () => openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: item.id, qty: 1, serialIds: [serialId] }], reasonCode: "defective", reason: "زر لا يعمل", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + DAY);
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    expect(results.filter((result) => result.status === "fulfilled").length).toBe(1);
    expect((await t.db.select().from(returnItems).where(eq(returnItems.orderItemId, item.id)).all()).length).toBe(1);
  });

  test("the employee who opened it never decides it; rejecting needs a reason the customer sees; queues never show one's own", async () => {
    const pad = await stocked(35_000, 5, 20_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const before = { mine: (await queueCounts(t.db, as("manager"), NOW + DAY)).decide!, other: (await queueCounts(t.db, as("manager2"), NOW + DAY)).decide! };
    const opened = await approvedReturn(order, { opener: as("manager"), approve: false });
    expect((await queueCounts(t.db, as("manager"), NOW + DAY)).decide).toBe(before.mine);
    expect((await queueCounts(t.db, as("manager2"), NOW + DAY)).decide).toBe(before.other + 1);
    expect(await failureOf(decideReturn(t.db, as("manager"), opened.returnId, { approve: true }, NOW + DAY))).toMatchObject({ code: "approver_is_requester", status: 403 });
    expect(await failureOf(decideReturn(t.db, as("support"), opened.returnId, { approve: true }, NOW + DAY))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(decideReturn(t.db, as("manager2"), opened.returnId, { approve: false }, NOW + DAY))).toMatchObject({ code: "invalid", fields: { note: "required" } });
    expect(await decideReturn(t.db, as("manager2"), opened.returnId, { approve: false, note: "خارج الضمان" }, NOW + DAY)).toEqual({ status: "rejected", replayed: false });
    expect((await t.db.select().from(returns).where(eq(returns.id, opened.returnId)).get())?.rejectReason).toBe("خارج الضمان");
    // a rejected RMA no longer holds its unit
    expect((await findOrderForReturn(t.db, as("support"), order.ref, "ar", NOW + DAY)).lines[0].returnableQty).toBe(1);
  });

  test("photos: a full RMA refuses another before anything is stored", async () => {
    const pad = await stocked(30_000, 5, 15_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const opened = await approvedReturn(order, { approve: false });
    for (let i = 0; i < MAX_RETURN_PHOTOS; i++) {
      await t.db.insert(files).values({ id: newId("fil"), storageKey: `prv_${randomToken(8)}`, visibility: "private", kind: "return_photo", mime: "image/png", bytes: 10, sha256: randomToken(8), ownerType: "return", ownerId: opened.returnId, createdAt: NOW });
    }
    expect(await failureOf(assertPhotoSlot(t.db, as("support"), opened.returnId))).toMatchObject({ code: "photo_limit" });
    expect(await failureOf(assertPhotoSlot(t.db, as("finance"), opened.returnId))).toMatchObject({ code: "forbidden" });
  });
});

// ───────────────────────────────────────────────────────────────── inspection (12.03)

describe("inspection", () => {
  test("a swapped serial is refused and recorded; the right one restocks through the core; the warranty of the returned unit ends", async () => {
    const console5 = await stocked(720_000, 3, 500_000, { trackSerials: true, warrantyMonths: 12 });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const rma = await approvedReturn(order);
    const [item] = await itemsOf(rma.returnId);
    const warranty = await t.db.select().from(warranties).where(eq(warranties.serialId, rma.serialIds[0])).get();
    expect(warranty?.status).toBe("active");
    const wrong = await failureOf(inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "sellable", decision: "restock", serial: "NOT-THE-ONE" }, NOW + 2 * DAY));
    expect(wrong).toMatchObject({ code: "serial_mismatch", fields: { serial: "serial_mismatch" } });
    expect((await getReturnDetail(t.db, as("manager"), rma.rma, "ar", NOW + 2 * DAY, urls)).flags.map((flag) => flag.id)).toContain("serial_mismatch");
    expect(await failureOf(inspectItem(t.db, as("support"), { returnId: rma.returnId, itemId: item.id, condition: "sellable", decision: "restock", serial: "x" }, NOW + 2 * DAY))).toMatchObject({ code: "forbidden" });
    const before = (await getAvailability(t.db, [console5.variantId])).get(console5.variantId)!.available;
    const serial = await serialText(rma.serialIds[0]);
    const done = await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "sellable", decision: "restock", serial: ` ${serial.toLowerCase()} ` }, NOW + 2 * DAY);
    expect(done).toEqual({ replayed: false, status: "inspected" });
    expect((await getAvailability(t.db, [console5.variantId])).get(console5.variantId)!.available).toBe(before + 1);
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, rma.serialIds[0])).get())?.releasedAt).not.toBeNull();
    expect((await t.db.select().from(warranties).where(eq(warranties.id, warranty!.id)).get())).toMatchObject({ status: "void", voidReason: `returned: ${rma.rma}` });
    // the same inspection again is harmless; a different one is refused
    expect(await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "sellable", decision: "restock", serial }, NOW + 2 * DAY)).toMatchObject({ replayed: true });
    expect(await failureOf(inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "damaged", decision: "scrap", serial }, NOW + 2 * DAY))).toMatchObject({ code: "item_inspected" });
    const row = await t.db.select().from(returns).where(eq(returns.id, rma.returnId)).get();
    expect(row).toMatchObject({ status: "inspected", receivedAt: NOW + 2 * DAY, inspectedAt: NOW + 2 * DAY });
  });

  test("quarantine needs a non-sellable location; 'keep' moves no goods; a requested RMA cannot be inspected", async () => {
    const pad = await stocked(55_000, 6, 35_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 2 }]);
    const pending = await approvedReturn(order, { approve: false });
    const [pendingItem] = await itemsOf(pending.returnId);
    expect(await failureOf(inspectItem(t.db, as("inventory"), { returnId: pending.returnId, itemId: pendingItem.id, condition: "defective", decision: "keep" }, NOW + DAY))).toMatchObject({ code: "rma_changed" });
    await decideReturn(t.db, as("manager"), pending.returnId, { approve: true }, NOW + DAY);
    expect(await failureOf(inspectItem(t.db, as("inventory"), { returnId: pending.returnId, itemId: pendingItem.id, condition: "defective", decision: "refurbish" }, NOW + DAY))).toMatchObject({ code: "invalid", fields: { locationId: "required" } });
    expect(await failureOf(inspectItem(t.db, as("inventory"), { returnId: pending.returnId, itemId: pendingItem.id, condition: "defective", decision: "refurbish", locationId: DEFAULT_LOCATION_ID }, NOW + DAY))).toMatchObject({ code: "invalid", fields: { locationId: "location_not_quarantine" } });
    const levelBefore = (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, pad.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get())!.onHand;
    await inspectItem(t.db, as("inventory"), { returnId: pending.returnId, itemId: pendingItem.id, condition: "defective", decision: "keep", notes: "يُصلح للعميل" }, NOW + DAY);
    expect((await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, pad.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get())!.onHand).toBe(levelBefore);
    expect((await itemsOf(pending.returnId))[0]).toMatchObject({ restockAction: null, restockedAt: null, condition: "defective" });
  });

  test("a used device goes back to the devices team or is written off — never into quarantine", async () => {
    const model = await stocked(600_000, 1, 450_000, { trackSerials: true });
    const serialId = newId("ser");
    const usedSerial = `USED-${model.sku}`;
    await t.db.insert(serials).values({ id: serialId, serial: usedSerial, variantId: model.variantId, status: "in_stock", locationId: DEFAULT_LOCATION_ID, source: "trade_in", createdAt: NOW, updatedAt: NOW });
    const unitId = newId("usd");
    await t.db.insert(usedUnits).values({ id: unitId, slug: make.next("used"), variantId: model.variantId, serialId, grade: "A", priceIqd: 420_000, acquisitionCostIqd: 300_000, status: "listed", isDemo: true, createdAt: NOW, updatedAt: NOW });
    const order = await delivered([{ usedUnitId: unitId, qty: 1 }]);
    const rma = await approvedReturn(order);
    expect(rma.serialIds).toEqual([serialId]);
    const [item] = await itemsOf(rma.returnId);
    // the page knows: the inspection dialog offers no quarantine decision for it
    expect((await getReturnDetail(t.db, as("inventory"), rma.rma, "ar", NOW + 2 * DAY, urls)).items.map((entry) => entry.used)).toEqual([true]);
    for (const decision of ["refurbish", "return_to_supplier"] as const) {
      const refused = await failureOf(inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "opened", decision, locationId: quarantineId, serial: usedSerial }, NOW + 2 * DAY));
      expect(refused, decision).toMatchObject({ code: "invalid", fields: { decision: "used_unit_decision" } });
    }
    await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "opened", decision: "restock", serial: usedSerial }, NOW + 2 * DAY);
    // the core's used-device path: the unit is "returned" for module 13 to re-inspect and list; its serial is free again
    expect((await t.db.select({ status: usedUnits.status }).from(usedUnits).where(eq(usedUnits.id, unitId)).get())?.status).toBe("returned");
    expect((await t.db.select({ status: serials.status }).from(serials).where(eq(serials.id, serialId)).get())?.status).toBe("in_stock");
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, serialId)).get())?.releasedAt).toBe(NOW + 2 * DAY);
  });
});

// ───────────────────────────────────────────────────────────────── refunds (12.04, 12.05)

describe("refunds of a return", () => {
  async function inspectedReturn(priceIqd = 120_000, qty = 1) {
    const pad = await stocked(priceIqd, 10, Math.floor(priceIqd * 0.6));
    const customerId = await make.customer();
    const order = await delivered([{ variantId: pad.variantId, qty }], { customerId });
    const rma = await approvedReturn(order);
    for (const item of await itemsOf(rma.returnId)) await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "sellable", decision: "restock" }, NOW + 2 * DAY);
    return { order, rma, items: await itemsOf(rma.returnId), payment: await paymentOf(order.orderId) };
  }

  test("only inspected units; never above their value; two people; the money and the RMA follow; never twice", async () => {
    const { order, rma, items, payment } = await inspectedReturn(120_000, 2);
    const base = { returnId: rma.returnId, paymentId: payment.id, itemIds: items.map((item) => item.id), method: "original" as const, reason: "قطعتان معيبتان" };
    expect(await failureOf(requestReturnRefund(t.db, as("support"), { ...base, amountIqd: 245_000, idempotencyKey: randomToken() }, NOW + 3 * DAY))).toMatchObject({ code: "refund_exceeds_items", fields: { amountIqd: "refund_exceeds_items" } });
    expect(await failureOf(requestReturnRefund(t.db, as("inventory"), { ...base, amountIqd: 240_000, idempotencyKey: randomToken() }, NOW + 3 * DAY))).toMatchObject({ code: "forbidden" });
    const key = randomToken();
    const requested = await requestReturnRefund(t.db, as("support"), { ...base, amountIqd: 240_000, idempotencyKey: key }, NOW + 3 * DAY);
    expect(requested).toMatchObject({ status: "pending", replayed: false });
    // a double submit is the same refund
    expect(await requestReturnRefund(t.db, as("support"), { ...base, amountIqd: 240_000, idempotencyKey: key }, NOW + 3 * DAY)).toMatchObject({ refundId: requested.refundId, replayed: true });
    expect((await t.db.select().from(refunds).where(eq(refunds.orderId, order.orderId)).all()).length).toBe(1);
    expect((await t.db.select().from(refunds).where(eq(refunds.id, requested.refundId)).get())?.returnId).toBe(rma.returnId);
    // while it waits, the same units cannot be asked for again — and the page says they wait, not that they were refunded
    expect(await failureOf(requestReturnRefund(t.db, as("support"), { ...base, amountIqd: 1_000, idempotencyKey: randomToken() }, NOW + 3 * DAY))).toMatchObject({ code: "refund_qty_exceeds" });
    expect((await getReturnDetail(t.db, as("finance"), rma.rma, "ar", NOW + 3 * DAY, urls)).items.map((item) => [item.refundedQty, item.refundPaidQty])).toEqual([[2, 0]]);
    // the requester never approves; support may not approve at all; the second person issues it
    expect(await failureOf(decideReturnRefund(t.db, as("support"), { returnId: rma.returnId, refundId: requested.refundId, approve: true }, NOW + 3 * DAY))).toMatchObject({ code: "forbidden" });
    const selfApprove = await failureOf(decideReturnRefund(t.db, custom(["orders.refund.approve", "orders.refund.create", "returns.rma.read"], as("support").id), { returnId: rma.returnId, refundId: requested.refundId, approve: true }, NOW + 3 * DAY));
    expect(selfApprove).toMatchObject({ code: "approver_is_requester", status: 403 });
    expect(await decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: requested.refundId, approve: true }, NOW + 3 * DAY)).toEqual({ status: "paid" });
    expect(await t.db.select().from(returns).where(eq(returns.id, rma.returnId)).get()).toMatchObject({ status: "refunded", resolution: "refund" });
    expect((await t.db.select().from(orders).where(eq(orders.id, order.orderId)).get())?.refundedIqd).toBe(240_000);
    const paidView = await getReturnDetail(t.db, as("finance"), rma.rma, "ar", NOW + 3 * DAY, urls);
    expect(paidView.items.map((item) => [item.refundedQty, item.refundPaidQty])).toEqual([[2, 2]]);
    // the history shows each act once: the core's refund events, not this module's copies; no "RMA-…: " on its own page
    const actions = paidView.timeline.map((entry) => entry.action);
    expect(actions.filter((action) => action.startsWith("returns.rma.refund"))).toEqual([]);
    expect(actions.filter((action) => action === "orders.refund.create" || action === "orders.refund.approve")).toEqual(["orders.refund.create", "orders.refund.approve"]);
    expect(paidView.timeline.find((entry) => entry.action === "orders.refund.create")?.reason).toBe("قطعتان معيبتان");
    // never twice for the same units: here, through the orders module, or as an amount only for these units
    expect(await failureOf(requestReturnRefund(t.db, as("support"), { ...base, amountIqd: 1_000, idempotencyKey: randomToken() }, NOW + 4 * DAY))).toMatchObject({ code: expect.stringMatching(/refund_qty_exceeds|refund_not_ready/) });
    expect(await failureOf(createRefund(t.db, as("support"), { orderId: order.orderId, paymentId: payment.id, items: [{ orderItemId: items[0].orderItemId, qty: 1 }], amountIqd: 1_000, method: "cash", reason: "مرة ثانية", idempotencyKey: randomToken() }, NOW + 4 * DAY))).toMatchObject({ code: "refund_qty_exceeds" });
    // and a new RMA for the same units is refused
    expect(await failureOf(openReturn(t.db, as("support"), { orderRef: order.ref, items: [{ orderItemId: items[0].orderItemId, qty: 1 }], reasonCode: "defective", reason: "مرة ثانية للقطعة", requestedResolution: "refund", idempotencyKey: randomToken() }, NOW + 4 * DAY))).toMatchObject({ code: "return_qty_exceeds" });
    // another RMA's refund decision through this RMA is not found
    const other = await inspectedReturn(50_000);
    const otherRefund = await requestReturnRefund(t.db, as("support"), { returnId: other.rma.returnId, paymentId: other.payment.id, itemIds: other.items.map((item) => item.id), amountIqd: 50_000, method: "cash", reason: "نقداً", idempotencyKey: randomToken() }, NOW + 4 * DAY);
    expect(await failureOf(decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: otherRefund.refundId, approve: true }, NOW + 4 * DAY))).toMatchObject({ code: "not_found" });
    // cash for a cash-on-delivery payment is no signal; cash for a wallet payment is
    expect((await getReturnDetail(t.db, as("manager"), other.rma.rma, "ar", NOW + 4 * DAY, urls)).flags.map((flag) => flag.id)).not.toContain("refund_method_differs");
    const walletCustomer = await make.customer();
    await creditWallet(t.db, system, { customerId: walletCustomer, amountIqd: 500_000, kind: "topup", reason: "رصيد للاختبار", idempotencyKey: randomToken(), fundedBy: "cash" }, NOW);
    const pad = await stocked(70_000, 4, 40_000);
    const paidByWallet = await delivered([{ variantId: pad.variantId, qty: 1 }], { customerId: walletCustomer, method: "wallet" });
    const walletRma = await approvedReturn(paidByWallet);
    const [walletItem] = await itemsOf(walletRma.returnId);
    await inspectItem(t.db, as("inventory"), { returnId: walletRma.returnId, itemId: walletItem.id, condition: "sellable", decision: "restock" }, NOW + 2 * DAY);
    await requestReturnRefund(t.db, as("support"), { returnId: walletRma.returnId, paymentId: (await paymentOf(paidByWallet.orderId)).id, itemIds: [walletItem.id], amountIqd: 70_000, method: "cash", reason: "طلب نقداً", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    expect((await getReturnDetail(t.db, as("manager"), walletRma.rma, "ar", NOW + 3 * DAY, urls)).flags.map((flag) => flag.id)).toContain("refund_method_differs");
  });

  test("store credit needs an account; the ceiling is what the payment can still refund; a restocking fee is suggested for a change of mind", async () => {
    const pad = await stocked(100_000, 5, 60_000);
    const guest = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const rma = await approvedReturn(guest);
    const [item] = await itemsOf(rma.returnId);
    await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "sellable", decision: "restock" }, NOW + 2 * DAY);
    const payment = await paymentOf(guest.orderId);
    expect(await failureOf(requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: payment.id, itemIds: [item.id], amountIqd: 100_000, method: "wallet", reason: "رصيد", idempotencyKey: randomToken() }, NOW + 3 * DAY))).toMatchObject({ code: "wallet_requires_account" });
    // a refund outside the return took most of the payment: the core's ceiling applies
    await createRefund(t.db, system, { orderId: guest.orderId, paymentId: payment.id, amountIqd: 90_000, method: "cash", reason: "تعويض", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    expect(await failureOf(requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: payment.id, itemIds: [item.id], amountIqd: 100_000, method: "cash", reason: "الباقي", idempotencyKey: randomToken() }, NOW + 3 * DAY))).toMatchObject({ code: "refund_exceeds_payment" });
    // the change-of-mind fee from the rule shows in the suggestion
    await savePolicy(t.db, as("manager"), { productKind: "*", itemCondition: "*", isReturnable: true, windowDays: 30, requiresSealed: false, restockingFeeBps: 1500, note: {}, sort: 0, isActive: true, reason: "رسوم إعادة التخزين" }, NOW);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }], { customerId: await make.customer() });
    const mind = await approvedReturn(order, { reasonCode: "changed_mind" });
    await inspectItem(t.db, as("inventory"), { returnId: mind.returnId, itemId: (await itemsOf(mind.returnId))[0].id, condition: "sellable", decision: "restock" }, NOW + 2 * DAY);
    const detail = await getReturnDetail(t.db, as("support"), mind.rma, "ar", NOW + 2 * DAY, urls);
    expect(detail.refundSuggestion).toMatchObject({ itemsValueIqd: 100_000, feeIqd: 15_000, amountIqd: 85_000 });
    const credit = await requestReturnRefund(t.db, as("support"), { returnId: mind.returnId, paymentId: (await paymentOf(order.orderId)).id, itemIds: detail.items.map((entry) => entry.id), amountIqd: 85_000, method: "wallet", reason: "رصيد بعد الرسوم", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    await decideReturnRefund(t.db, as("finance"), { returnId: mind.returnId, refundId: credit.refundId, approve: true }, NOW + 3 * DAY);
    expect(await t.db.select().from(returns).where(eq(returns.id, mind.returnId)).get()).toMatchObject({ status: "refunded", resolution: "store_credit" });
    for (const rule of (await listPolicies(t.db, as("manager"), "ar")).rules) await savePolicy(t.db, as("manager"), { id: rule.id, productKind: rule.productKind as never, itemCondition: rule.itemCondition, isReturnable: rule.isReturnable, windowDays: rule.windowDays, requiresSealed: rule.requiresSealed, restockingFeeBps: rule.restockingFeeBps, note: {}, sort: rule.sort, isActive: false, reason: "تنظيف بعد الاختبار" }, NOW);
  });

  test("closing: every unit inspected, no refund waiting; the resolution decides the final status", async () => {
    const { rma, items, payment } = await inspectedReturn(60_000);
    const refund = await requestReturnRefund(t.db, as("support"), { returnId: rma.returnId, paymentId: payment.id, itemIds: items.map((item) => item.id), amountIqd: 60_000, method: "cash", reason: "نقداً للعميل", idempotencyKey: randomToken() }, NOW + 3 * DAY);
    expect(await failureOf(closeReturn(t.db, as("manager"), rma.returnId, { resolution: "refund", note: "انتهى" }, NOW + 3 * DAY))).toMatchObject({ code: "rma_changed", fields: { resolution: "refund_waiting" } });
    await decideReturnRefund(t.db, as("finance"), { returnId: rma.returnId, refundId: refund.refundId, approve: true }, NOW + 3 * DAY);
    expect(await closeReturn(t.db, as("manager"), rma.returnId, { resolution: "refund", note: "سُلم المبلغ" }, NOW + 4 * DAY)).toEqual({ status: "refunded", replayed: false });
    expect(await closeReturn(t.db, as("manager"), rma.returnId, { resolution: "refund", note: "سُلم المبلغ" }, NOW + 4 * DAY)).toMatchObject({ replayed: true });
  });
});

// ───────────────────────────────────────────────────────────────── fraud signals (12.05)

test("fraud signals: repeat returns by one phone, high value, a quick change of mind, no photos for a defect — each explained", async () => {
  const phone = make.phone();
  const tv = await stocked(1_200_000, 6, 900_000);
  const first = await delivered([{ variantId: tv.variantId, qty: 1 }], { phone });
  const second = await delivered([{ variantId: tv.variantId, qty: 1 }], { phone });
  const third = await delivered([{ variantId: tv.variantId, qty: 1 }], { phone });
  const deliveredAt = (await t.db.select().from(orders).where(eq(orders.id, third.orderId)).get())!.deliveredAt!;
  await approvedReturn(first, { approve: false, at: deliveredAt + 2 * HOUR });
  await approvedReturn(second, { approve: false, at: deliveredAt + 3 * HOUR });
  const latest = await approvedReturn(third, { approve: false, reasonCode: "changed_mind", at: deliveredAt + 4 * HOUR });
  const detail = await getReturnDetail(t.db, as("manager"), latest.rma, "ar", deliveredAt + 5 * HOUR, urls);
  const ids = detail.flags.map((flag) => flag.id);
  expect(ids).toEqual(expect.arrayContaining(["repeat_returner", "high_value", "quick_return"]));
  expect(detail.flags.find((flag) => flag.id === "repeat_returner")?.vars).toMatchObject({ count: 3, days: 90 });
  const defect = await getReturnDetail(t.db, as("manager"), (await t.db.select().from(returns).where(eq(returns.orderId, first.orderId)).get())!.rma, "ar", deliveredAt + 5 * HOUR, urls);
  expect(defect.flags.map((flag) => flag.id)).toContain("no_photos");
  const flagged = await listReturns(t.db, as("manager"), parseRmaFilters(new URLSearchParams("view=flagged")), "ar", deliveredAt + 5 * HOUR);
  expect(flagged.rows.map((row) => row.rma)).toContain(latest.rma);
});

// ───────────────────────────────────────────────────────────────── quarantine (12.07)

describe("quarantine", () => {
  test("a refurbished unit goes back on sale once; a write-off needs the stock right; the supplier needs a supplier", async () => {
    const pad = await stocked(85_000, 6, 55_000, { trackSerials: true });
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const rma = await approvedReturn(order);
    const [item] = await itemsOf(rma.returnId);
    await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "opened", decision: "refurbish", locationId: quarantineId, serial: await serialText(rma.serialIds[0]) }, NOW + 2 * DAY);
    const list = await listQuarantine(t.db, as("inventory"), "ar", NOW + 20 * DAY);
    const row = list.rows.find((entry) => entry.itemId === item.id)!;
    expect(row).toMatchObject({ decision: "refurbish", late: true, location: { id: quarantineId } });
    expect(list.can).toEqual({ release: true, scrap: true, supplier: false });
    expect(await failureOf(resolveQuarantine(t.db, as("inventory"), { itemId: item.id, to: "supplier", reason: "للمورد" }, NOW + 3 * DAY))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(resolveQuarantine(t.db, as("manager"), { itemId: item.id, to: "supplier", reason: "للمورد" }, NOW + 3 * DAY))).toMatchObject({ code: "no_suppliers" });
    await resolveQuarantine(t.db, as("inventory"), { itemId: item.id, to: "stock", locationId: DEFAULT_LOCATION_ID, reason: "جُدد وفُحص" }, NOW + 3 * DAY);
    expect(await resolveQuarantine(t.db, as("inventory"), { itemId: item.id, to: "stock", locationId: DEFAULT_LOCATION_ID, reason: "جُدد وفُحص" }, NOW + 3 * DAY)).toMatchObject({ replayed: true });
    expect(await failureOf(resolveQuarantine(t.db, as("manager"), { itemId: item.id, to: "scrap", reason: "شطب" }, NOW + 3 * DAY))).toMatchObject({ code: "quarantine_resolved" });
    expect((await listQuarantine(t.db, as("inventory"), "ar", NOW + 3 * DAY)).rows.some((entry) => entry.itemId === item.id)).toBe(false);
    expect((await t.db.select().from(serials).where(eq(serials.id, rma.serialIds[0])).get())).toMatchObject({ status: "in_stock", locationId: DEFAULT_LOCATION_ID });
    expect((await getReturnDetail(t.db, as("manager"), rma.rma, "ar", NOW + 3 * DAY, urls)).items[0].quarantineExit).toBe("stock");
  });

  test("to the supplier: a return claim with the units, the serial with the supplier", async () => {
    const supplierId = newId("sup");
    await t.db.insert(suppliers).values({ id: supplierId, code: `SUP-${randomToken(4)}`, name: "Demo supplier", createdAt: NOW, updatedAt: NOW });
    const pad = await stocked(95_000, 4, 70_000, { trackSerials: true });
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const rma = await approvedReturn(order);
    const [item] = await itemsOf(rma.returnId);
    await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "defective", decision: "return_to_supplier", locationId: quarantineId, serial: await serialText(rma.serialIds[0]) }, NOW + 2 * DAY);
    const sent = await resolveQuarantine(t.db, as("manager"), { itemId: item.id, to: "supplier", supplierId, reason: "عيب مصنعي" }, NOW + 3 * DAY);
    expect(sent.claimRef).toMatch(/^RTV-/);
    const claim = await t.db.select().from(supplierClaims).where(eq(supplierClaims.ref, sent.claimRef!)).get();
    expect(claim).toMatchObject({ supplierId, kind: "return", status: "submitted", items: [{ variantId: pad.variantId, qty: 1, serialId: rma.serialIds[0] }] });
    expect((await t.db.select().from(serials).where(eq(serials.id, rma.serialIds[0])).get())).toMatchObject({ status: "in_repair", locationId: null });
  });
});

// ───────────────────────────────────────────────────────────────── repairs (12.07)

describe("repairs with SLA", () => {
  test("a device at the counter: received at once with its due time; a quote is approved before paid work; delivered records the price", async () => {
    const opened = await openCounterRepair(t.db, as("support"), { phone: "07701234567", contactName: "علي", deviceText: "PS4 Pro", issue: "يطفئ بعد عشر دقائق من اللعب", idempotencyKey: randomToken() }, NOW);
    const repair = await getRepair(t.db, as("support"), opened.ref, "ar", NOW, { file: (id) => id });
    expect(repair).toMatchObject({ status: "received", source: "store", slaDueAt: NOW + 7 * DAY, transitions: ["diagnosing", "cancelled"] });
    expect(await failureOf(changeRepairStatus(t.db, as("inventory"), { ticketId: repair.id, from: "received", to: "diagnosing" }, NOW))).toMatchObject({ code: "forbidden" });
    await changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "received", to: "diagnosing" }, NOW + HOUR);
    expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "received", to: "awaiting_approval" }, NOW + HOUR))).toMatchObject({ code: "repair_changed" });
    expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "diagnosing", to: "delivered" }, NOW + HOUR))).toMatchObject({ code: "transition_not_allowed" });
    await setDiagnosis(t.db, as("support"), { ticketId: repair.id, diagnosis: "مروحة التبريد تالفة", quoteIqd: 45_000 }, NOW + 2 * HOUR);
    await changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "diagnosing", to: "awaiting_approval" }, NOW + 2 * HOUR);
    expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "awaiting_approval", to: "repairing" }, NOW + 3 * HOUR))).toMatchObject({ code: "quote_not_approved" });
    await recordQuoteDecision(t.db, as("support"), { ticketId: repair.id, approved: true, note: "وافق هاتفياً" }, NOW + 3 * HOUR);
    await changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "awaiting_approval", to: "repairing" }, NOW + 3 * HOUR);
    await addPart(t.db, as("support"), { ticketId: repair.id, name: "مروحة تبريد", qty: 1, priceIqd: 30_000 }, NOW + 4 * HOUR);
    await changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "repairing", to: "ready" }, NOW + 5 * HOUR);
    await changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from: "ready", to: "delivered" }, NOW + 6 * HOUR);
    const done = await getRepair(t.db, as("support"), opened.ref, "ar", NOW + 6 * HOUR, { file: (id) => id });
    expect(done).toMatchObject({ status: "delivered", costIqd: 45_000, completedAt: NOW + 5 * HOUR, deliveredAt: NOW + 6 * HOUR, partsTotalIqd: 30_000 });
    // the storefront's status page reads "status" events with a `to`
    const statusEvents = await t.db.select().from(repairEvents).where(and(eq(repairEvents.ticketId, repair.id), eq(repairEvents.kind, "status"))).all();
    expect(statusEvents.map((event) => (event.data as { to?: string }).to)).toEqual(["received", "diagnosing", "awaiting_approval", "repairing", "ready", "delivered"]);
    // unrepairable / cancelled need a reason
    const other = await openCounterRepair(t.db, as("support"), { phone: "07701234568", deviceText: "Switch", issue: "الشاشة لا تعمل نهائياً", idempotencyKey: randomToken() }, NOW);
    const otherId = (await t.db.select().from(repairTickets).where(eq(repairTickets.ref, other.ref)).get())!.id;
    expect(await failureOf(changeRepairStatus(t.db, as("support"), { ticketId: otherId, from: "received", to: "cancelled" }, NOW))).toMatchObject({ code: "invalid", fields: { note: "required" } });
  });

  test("late tickets are listed as late; the due date moves later only, with a reason", async () => {
    const opened = await openCounterRepair(t.db, as("support"), { phone: "07701234569", deviceText: "Xbox", issue: "لا يقرأ الأقراص أبداً", idempotencyKey: randomToken() }, NOW);
    const late = await listRepairs(t.db, as("support"), parseRepairFilters(new URLSearchParams("view=late")), "ar", NOW + 8 * DAY);
    expect(late.rows.find((row) => row.ref === opened.ref)).toMatchObject({ late: true });
    const id = (await t.db.select().from(repairTickets).where(eq(repairTickets.ref, opened.ref)).get())!.id;
    expect(await failureOf(setRepairSla(t.db, as("support"), { ticketId: id, dueOn: "2026-02-30", reason: "انتظار قطعة" }, NOW))).toMatchObject({ code: "invalid", fields: { dueOn: "invalid" } });
    const moved = await setRepairSla(t.db, as("support"), { ticketId: id, dueOn: "٢٠٢٦-١٢-٠١", reason: "انتظار قطعة من المورد" }, NOW);
    expect(moved.slaDueAt).toBe(Date.UTC(2026, 11, 1) - 3 * HOUR + DAY - 1);
    expect((await queueCounts(t.db, as("support"), NOW + 8 * DAY)).repairsLate).toBeGreaterThanOrEqual(0);
  });

  test("a kept unit of a return under warranty is repaired free; handing it back resolves the RMA", async () => {
    const console5 = await stocked(800_000, 3, 600_000, { trackSerials: true, warrantyMonths: 12 });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const rma = await approvedReturn(order);
    const [item] = await itemsOf(rma.returnId);
    await inspectItem(t.db, as("inventory"), { returnId: rma.returnId, itemId: item.id, condition: "defective", decision: "keep", serial: await serialText(rma.serialIds[0]) }, NOW + 2 * DAY);
    const ticket = await openReturnRepair(t.db, as("support"), { returnId: rma.returnId, itemId: item.id, issue: "لا يعطي صورة عبر HDMI" }, NOW + 2 * DAY);
    expect(await openReturnRepair(t.db, as("support"), { returnId: rma.returnId, itemId: item.id, issue: "لا يعطي صورة عبر HDMI" }, NOW + 2 * DAY)).toMatchObject({ ref: ticket.ref, replayed: true });
    const repair = await getRepair(t.db, as("support"), ticket.ref, "ar", NOW + 2 * DAY, { file: (id) => id });
    expect(repair).toMatchObject({ isWarranty: true, quoteIqd: 0, source: "return", rma: { rma: rma.rma }, warranty: { state: "active" } });
    for (const [from, to] of [["received", "diagnosing"], ["diagnosing", "repairing"], ["repairing", "ready"], ["ready", "delivered"]] as const) await changeRepairStatus(t.db, as("support"), { ticketId: repair.id, from, to }, NOW + 3 * DAY);
    expect((await t.db.select().from(repairTickets).where(eq(repairTickets.id, repair.id)).get())?.costIqd).toBe(0);
    expect(await t.db.select().from(returns).where(eq(returns.id, rma.returnId)).get()).toMatchObject({ status: "repaired", resolution: "repair" });
    // the unit's warranty shows the service and the parts
    const warranty = await t.db.select().from(warranties).where(eq(warranties.serialId, rma.serialIds[0])).get();
    expect(warranty?.status).toBe("active");
  });

  test("a storefront request is in the staff list", async () => {
    const created = await createRepairTicket(t.db, { customerId: null, ip: null, storeMode: "live" }, { idempotencyKey: randomToken(), device: "other", deviceText: "Steam Deck", issue: "البطارية تنفد بسرعة كبيرة", phone: "07701112233" }, NOW);
    const page = await listRepairs(t.db, as("support"), parseRepairFilters(new URLSearchParams(`q=${created.ref}`)), "ar", NOW);
    expect(page.rows.map((row) => row.ref)).toEqual([created.ref]);
    expect(page.rows[0]).toMatchObject({ status: "submitted", source: "storefront" });
  });
});

// ───────────────────────────────────────────────────────────────── warranties (12.06)

describe("warranties", () => {
  test("only a delivered order's recorded warranty; the maker's apart; service history and replaced parts; extend later only; void with a reason", async () => {
    const console5 = await stocked(900_000, 3, 700_000, { trackSerials: true, warrantyMonths: 12 });
    const order = await delivered([{ variantId: console5.variantId, qty: 1 }]);
    const serialId = await serialOf(order.items[0].id);
    const row = (await t.db.select().from(warranties).where(eq(warranties.serialId, serialId)).get())!;
    expect(row.status).toBe("active");
    const plain = await stocked(30_000, 3, 15_000);
    const noWarranty = await delivered([{ variantId: plain.variantId, qty: 1 }]);
    expect((await t.db.select().from(warranties).where(eq(warranties.orderItemId, noWarranty.items[0].id)).all()).length).toBe(0);

    const repair = await openCounterRepair(t.db, as("support"), { phone: "07701230000", deviceText: "PS5", serial: await serialText(serialId), issue: "يصدر صوتاً عالياً من المروحة", idempotencyKey: randomToken() }, NOW + DAY);
    const ticket = await getRepair(t.db, as("support"), repair.ref, "ar", NOW + DAY, { file: (id) => id });
    expect(ticket).toMatchObject({ isWarranty: true, warranty: { id: row.id } });
    await addPart(t.db, as("support"), { ticketId: ticket.id, name: "مروحة", qty: 1, priceIqd: 50_000 }, NOW + DAY);
    const detail = await getWarranty(t.db, as("cashier"), row.id, "ar", NOW + DAY);
    expect(detail).toMatchObject({ state: "active", makerWarranty: "ضمان الشركة سنة", repairs: 1, can: { manage: false } });
    expect(detail.replacedParts).toEqual([expect.objectContaining({ name: "مروحة", qty: 1, ticketRef: repair.ref })]);
    // warranty repairs are free: the part costs the customer nothing
    expect(detail.service[0].parts[0].priceIqd).toBe(0);
    const list = await listWarranties(t.db, as("support"), parseWarrantyFilters(new URLSearchParams(`q=${order.ref}`)), "ar", NOW + DAY);
    expect(list.rows.map((entry) => entry.id)).toEqual([row.id]);
    expect(await failureOf(extendWarranty(t.db, as("support"), { warrantyId: row.id, endsOn: "2030-01-01", reason: "ضمان إضافي" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(extendWarranty(t.db, as("manager"), { warrantyId: row.id, endsOn: "2026-12-01", reason: "أقصر" }, NOW))).toMatchObject({ code: "invalid", fields: { endsOn: "not_later" } });
    const extended = await extendWarranty(t.db, as("manager"), { warrantyId: row.id, endsOn: "2028-06-30", reason: "تعويض عن تأخر الصيانة" }, NOW + DAY);
    expect(extended.endsAt).toBe(Date.UTC(2028, 5, 30) - 3 * HOUR + DAY - 1);
    await voidWarranty(t.db, as("manager"), { warrantyId: row.id, reason: "فتح الجهاز خارج المتجر" }, NOW + 2 * DAY);
    expect(await failureOf(extendWarranty(t.db, as("manager"), { warrantyId: row.id, endsOn: "2029-01-01", reason: "x-test" }, NOW + 2 * DAY))).toMatchObject({ code: "warranty_void" });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityType, "warranty"), eq(auditEvents.entityId, row.id))).all();
    expect(audit.map((event) => event.action)).toEqual(["returns.warranty.extend", "returns.warranty.void"]);
    expect(await failureOf(listWarranties(t.db, as("content"), parseWarrantyFilters(new URLSearchParams()), "ar", NOW))).toMatchObject({ code: "forbidden" });
  });
});

// ───────────────────────────────────────────────────────────────── helpers and route glue

test("numbers typed with Arabic-Indic or Persian digits are read", () => {
  expect(parseWhole("٢٤٠٬٠٠٠")).toBe(240_000);
  expect(parseWhole("۸۵۰۰۰")).toBe(85_000);
  expect(parseWhole("12.5")).toBeNaN();
  expect(parseWhole("")).toBeUndefined();
});

describe("routes", () => {
  const session = (actor: EmployeeActor): EmployeeSession =>
    ({
      employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
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

  test("rmaAction: each intent's permission is checked before anything is read; failures answer in the employee's language", async () => {
    const pad = await stocked(40_000, 10, 25_000);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const rma = await approvedReturn(order, { approve: false });
    const ctx = { locale: "en" as const, now: NOW + DAY };
    expect(await rmaAction(ctx, t.db, session(as("inventory")), rma.rma, form({ intent: "decide", approve: "1" }), store)).toMatchObject({ ok: false, code: "forbidden", status: 403 });
    expect(await rmaAction(ctx, t.db, session(as("finance")), "RMA-NOPE1234", form({ intent: "refund-decision", refundId: "rfd_x", approve: "1" }), store)).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(await rmaAction(ctx, t.db, session(as("support")), rma.rma, form({ intent: "decide", approve: "1" }), store)).toMatchObject({ ok: false, code: "forbidden" });
    const rejected = await rmaAction(ctx, t.db, session(as("manager")), rma.rma, form({ intent: "decide", approve: "0" }), store);
    expect(rejected).toMatchObject({ ok: false, code: "invalid", status: 400, fields: { note: expect.any(String) } });
    expect(await rmaAction(ctx, t.db, session(as("manager")), rma.rma, form({ intent: "decide", approve: "1" }), store)).toMatchObject({ ok: true, status: "approved" });
    expect(await rmaAction(ctx, t.db, session(as("support")), rma.rma, form({ intent: "note", text: "اتصلنا بالعميل" }), store)).toMatchObject({ ok: true });
    expect(await rmaAction(ctx, t.db, session(as("manager")), rma.rma, form({ intent: "drop-table" }), store)).toMatchObject({ ok: false, code: "invalid" });
    const [item] = await itemsOf(rma.returnId);
    expect(await rmaAction(ctx, t.db, session(as("inventory")), rma.rma, form({ intent: "inspect", itemId: item.id, condition: "sellable", decision: "restock" }), store)).toMatchObject({ ok: true, status: "inspected" });
    const refund = await rmaAction(ctx, t.db, session(as("support")), rma.rma, form({ intent: "refund", paymentId: (await paymentOf(order.orderId)).id, itemId: [item.id], amountIqd: "٤٠٬٠٠٠", method: "cash", reason: "نقداً", idempotencyKey: randomToken() }), store);
    expect(refund).toMatchObject({ ok: true, status: "pending" });
    // a photo of a role that may not add one is refused before anything is stored
    expect(await rmaAction(ctx, t.db, session(as("finance")), rma.rma, form({ intent: "photo" }), store)).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("loaders: 403 for a role without the permission, no cost data for the others", async () => {
    const pad = await stocked(42_000, 10, 26_789);
    const order = await delivered([{ variantId: pad.variantId, qty: 1 }]);
    const rma = await approvedReturn(order, { approve: false });
    const signedIn = async (key: DefaultRoleKey) => {
      const password = "returns-staff-password-1";
      const hashed = await hashPassword(password, 1000);
      const email = `${make.next(key)}@returns.test`;
      const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
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
    const detail = (await call(support, `/admin/returns/${rma.rma}`, (context, req) => rmaLoader({ request: req, context, params: { rma: rma.rma }, url: new URL(req.url), pattern: "admin/returns/:rma" } as never))) as { rma: { rma: string } };
    expect(detail.rma.rma).toBe(rma.rma);
    expect(JSON.stringify(detail)).not.toMatch(/26789|costIqd|unitCost/);
    const fulfillment = await signedIn("fulfillment");
    const index = (await call(fulfillment, "/admin/returns", (context, req) => indexLoader({ request: req, context, params: {}, url: new URL(req.url), pattern: "admin/returns" } as never))) as { page: { rows: unknown[] } | null };
    expect(index.page?.rows.length).toBeGreaterThan(0);
    const content = await signedIn("content");
    const refused = (await call(content, `/admin/returns/${rma.rma}`, (context, req) => rmaLoader({ request: req, context, params: { rma: rma.rma }, url: new URL(req.url), pattern: "admin/returns/:rma" } as never))) as { init?: { status?: number } };
    expect(refused?.init?.status).toBe(403);
    const missing = (await call(support, "/admin/returns/RMA-NOPE1234", (context, req) => rmaLoader({ request: req, context, params: { rma: "RMA-NOPE1234" }, url: new URL(req.url), pattern: "admin/returns/:rma" } as never))) as { init?: { status?: number } };
    expect(missing?.init?.status).toBe(404);
  });
});

function request(): { ctx: RequestCtx; setCookies: string[] } {
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `returns-${randomToken(6)}`,
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
