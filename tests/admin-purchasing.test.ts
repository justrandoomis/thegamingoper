/**
 * Admin module 09 — Suppliers and purchasing (owner: admin purchasing). The pure rules and the services under
 * app/server/services/admin/purchasing against a real local D1 with the demo catalogue (createTestDb + seedDemo) and
 * fixtures of their own (chosen by their properties, never a hard-coded slug):
 *   · rules: IQD conversion, totals, the spending limit, the three-way match, the supplier rating, Arabic digits
 *   · authorization per built-in role and field-level cost hiding (views, lists, the print document, route loaders)
 *   · suppliers (profile, stale edits, status, contacts), RFQs (quotes compared, award → draft PO, idempotent award)
 *   · purchase orders: drafts, idempotent creation, stale edits, the spending limit and four eyes, cancel / close
 *   · receiving through the stock core: partial receipts, inspection, serials, over-receipt, landed costs through
 *     pricing's allocation, the journal entry through the core, double posting, a crash resumed, two posters at once
 *   · invoices: the three-way match, variances accepted by a second person with a reason, re-match after receiving
 *   · claims: transitions, goods back to the supplier through adjustStock (once), serial-tracked refusal, permissions
 *   · variance alerts and branch limits
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import { loader as invoicesLoader } from "~/routes/admin/purchasing/invoices";
import { loader as ordersLoader } from "~/routes/admin/purchasing/orders";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { approvals, branches, costLayers, employeeRoles, inventoryLocations, poItems, purchaseOrders, receiptItems, receipts, stockLevels, stockMovements, supplierClaims } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { addLandedCost, allocateLandedCost } from "~/server/services/admin/pricing/landed.server";
import { listAlerts } from "~/server/services/admin/purchasing/alerts.server";
import { claimPrefill, createClaim, getClaim, moveClaim, returnClaimGoods } from "~/server/services/admin/purchasing/claims.server";
import { approveInvoice, getInvoice, recordInvoice } from "~/server/services/admin/purchasing/invoices.server";
import { cancelPurchaseOrder, closePurchaseOrder, decidePurchaseOrder, getPurchaseOrder, listPurchaseOrders, markOrderSent, parsePoFilters, purchaseOrderDocument, savePurchaseOrder, submitPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { supplierRatings } from "~/server/services/admin/purchasing/rating.server";
import { createReceipt, getReceipt, postReceipt } from "~/server/services/admin/purchasing/receipts.server";
import { awardQuote, createRfq, getRfq, recordQuote } from "~/server/services/admin/purchasing/rfqs.server";
import { PO_SPENDING_LIMIT_IQD, endOfBaghdadDay, isLate, needsApproval, parseCount, poTotals, rateSupplier, receiptStateOf, threeWayMatch, toIqd } from "~/server/services/admin/purchasing/rules";
import { createSupplier, getSupplier, listSuppliers, parseSupplierFilters, saveContact, setSupplierStatus, updateSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  await seedDemo(t.db, NOW - 120 * DAY);
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

type Staff = { id: string; email: string; password: string; actor: EmployeeActor };
async function staff(role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): Promise<Staff> {
  const password = "purchasing-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(role)}@purchasing.test`;
  const id = await make.employee({ email, name: `${role} tester`, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password, actor: { kind: "employee", id, permissions: defaultRolePermissions(role), label: `${role} tester`, ...extra } };
}
async function custom(permissions: Permission[], extra: Partial<EmployeeActor> = {}): Promise<EmployeeActor> {
  const id = await make.employee({ email: `${make.next("custom")}@purchasing.test` });
  return { kind: "employee", id, permissions: new Set<string>(permissions), label: "custom", ...extra };
}
const key = () => `k_${newId("idem").slice(4)}`;

async function thrown(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.code ?? "unexpected";
const fieldsOf = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.fields ?? {};
/** Deep search for protected keys anywhere in a result. */
const leaksCost = (value: unknown) => /"(unitCostMinor|lineTotalMinor|totalMinor|subtotalMinor|shippingMinor|otherMinor|totalIqd|fxRateMicros|limitIqd|unitCostIqd|landedUnitCostIqd|money|bills|amountMinor|amountIqd|openValueIqd)"/.test(JSON.stringify(value));

let owner: Staff;
let managerA: Staff;
let managerB: Staff;
let clerk: Staff;
let finance: Staff;
let cashier: Staff;

beforeAll(async () => {
  owner = await staff("owner");
  managerA = await staff("manager");
  managerB = await staff("manager");
  clerk = await staff("inventory");
  finance = await staff("finance");
  cashier = await staff("cashier");
}, 60_000);

async function supplier(options: { currency?: string; leadTimeDays?: string } = {}) {
  const codeValue = make.next("SUP").toUpperCase();
  const { supplierId } = await createSupplier(t.db, managerA.actor, { code: codeValue, name: `Supplier ${codeValue}`, currency: options.currency ?? "USD", leadTimeDays: options.leadTimeDays ?? "10", paymentTerms: "net 30" }, NOW);
  return supplierId;
}

/** A draft order of `lines` [sku, qty, unit cost] — USD at 1300 IQD by default. */
async function draftOrder(supplierId: string, lines: [string, number, string][], options: { currency?: string; fxRate?: string; expectedOn?: string; locationId?: string; actor?: EmployeeActor } = {}) {
  const result = await savePurchaseOrder(
    t.db,
    options.actor ?? managerA.actor,
    {
      supplierId,
      locationId: options.locationId ?? DEFAULT_LOCATION_ID,
      currency: options.currency ?? "USD",
      fxRate: options.fxRate ?? "1300",
      expectedOn: options.expectedOn ?? "2026-11-15",
      lines: lines.map(([sku, qty, unitCost]) => ({ code: sku, qty: String(qty), unitCost })),
      idempotencyKey: key(),
    },
    NOW,
  );
  return result.poId;
}

async function version(poId: string) {
  return (await t.db.select({ updatedAt: purchaseOrders.updatedAt }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.updatedAt;
}

/** An approved order (within the limit) — the submitter is managerA. */
async function approvedOrder(supplierId: string, lines: [string, number, string][], options: Parameters<typeof draftOrder>[2] = {}) {
  const poId = await draftOrder(supplierId, lines, options);
  const result = await submitPurchaseOrder(t.db, options.actor ?? managerA.actor, { poId, version: await version(poId) }, NOW);
  if (result.status === "pending_approval") await decidePurchaseOrder(t.db, managerB.actor, { poId, decision: "approve" }, NOW);
  return poId;
}

async function orderLines(poId: string) {
  return t.db.select().from(poItems).where(eq(poItems.poId, poId));
}

async function level(variantId: string, locationId = DEFAULT_LOCATION_ID) {
  return (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get()) ?? { onHand: 0, reserved: 0 };
}

async function journalOf(receiptId: string) {
  return t.d1
    .prepare(
      `SELECT je.idempotency_key AS key, je.is_demo AS isDemo, jl.account_id AS account, jl.debit_iqd AS debit, jl.credit_iqd AS credit
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id WHERE je.idempotency_key = ?1 ORDER BY jl.id`,
    )
    .bind(`receipt:${receiptId}:receipt`)
    .all<{ key: string; isDemo: number; account: string; debit: number; credit: number }>()
    .then((result) => result.results);
}

// ───────────────────────────────────────────────────────────────── pure rules

describe("rules", () => {
  test("IQD at a dated rate is exact, totals add up, the spending limit is strict", () => {
    expect(toIqd(1000, "USD", 1_300_000_000)).toBe(13_000);
    expect(toIqd(45_599, "USD", 1_310_500_000)).toBe(597_575);
    expect(toIqd(75_000, "IQD", null)).toBe(75_000);
    expect(toIqd(1000, "USD", null)).toBeNull();
    expect(poTotals([{ qty: 3, unitCostMinor: 1999 }, { qty: 2, unitCostMinor: 500 }], 1500, 250)).toEqual({ subtotalMinor: 6997, totalMinor: 8747 });
    expect(needsApproval(PO_SPENDING_LIMIT_IQD)).toBe(false);
    expect(needsApproval(PO_SPENDING_LIMIT_IQD + 1)).toBe(true);
  });

  test("Arabic-Indic and Persian digits are numbers; anything else is refused", () => {
    expect(parseCount("١٢")).toBe(12);
    expect(parseCount("۱۲")).toBe(12);
    expect(parseCount("1,200")).toBe(1200);
    expect(parseCount("")).toBeUndefined();
    expect(parseCount("2.5")).toBeNaN();
    expect(parseCount("-3")).toBeNaN();
  });

  test("late means the expected Baghdad day has ended and goods are still expected", () => {
    const day = Date.UTC(2026, 10, 9, 21, 0, 0); // 2026-11-10 00:00 Baghdad
    expect(endOfBaghdadDay(day)).toBe(day + DAY);
    expect(isLate({ status: "sent", expectedAt: day }, day + DAY - 1)).toBe(false);
    expect(isLate({ status: "sent", expectedAt: day }, day + DAY)).toBe(true);
    expect(isLate({ status: "received", expectedAt: day }, day + 5 * DAY)).toBe(false);
    expect(receiptStateOf({ status: "posted", receivedBy: "posting:abc" })).toBe("posting");
    expect(receiptStateOf({ status: "posted", receivedBy: "emp_1" })).toBe("posted");
  });

  test("three-way match: billed beyond received, a price change, a line not ordered", () => {
    const po = [
      { poItemId: "a", variantId: "va", qtyOrdered: 10, qtyReceived: 6, unitCostMinor: 1000 },
      { poItemId: "b", variantId: "vb", qtyOrdered: 4, qtyReceived: 4, unitCostMinor: 500 },
    ];
    expect(threeWayMatch(po, [{ poItemId: "a", variantId: "va", qty: 6, unitCostMinor: 1000 }])).toEqual([]);
    expect(threeWayMatch(po, [{ poItemId: "a", variantId: "va", qty: 7, unitCostMinor: 1000 }])).toEqual([{ variantId: "va", field: "qty", po: 10, received: 6, invoiced: 7 }]);
    // units already billed on another invoice count
    expect(threeWayMatch(po, [{ poItemId: "b", variantId: "vb", qty: 2, unitCostMinor: 500 }], new Map([["b", 3]]))).toEqual([{ variantId: "vb", field: "qty", po: 4, received: 4, invoiced: 5 }]);
    expect(threeWayMatch(po, [{ poItemId: "b", variantId: "vb", qty: 4, unitCostMinor: 550 }])).toEqual([{ variantId: "vb", field: "unit_cost", po: 500, received: null, invoiced: 550 }]);
    expect(threeWayMatch(po, [{ poItemId: null, variantId: "vx", qty: 1, unitCostMinor: 1 }])).toEqual([{ variantId: "vx", field: "qty", po: null, received: 0, invoiced: 1 }]);
  });

  test("the rating: weights, grades, and no score without enough history", () => {
    const base = { leadDays: [10, 12], promisedLeadDays: 10 };
    const good = rateSupplier({ ...base, receipts: 4, unitsReceived: 100, unitsOnTime: 90, unitsLate: 10, unitsOverdue: 0, defectUnits: 2 });
    expect(good.onTimeRate).toBe(0.9);
    expect(good.defectRate).toBe(0.02);
    expect(good.score).toBe(Math.round(60 * 0.9 + 40 * 0.98));
    expect(good.grade).toBe("A");
    expect(good.avgLeadDays).toBe(11);
    const thin = rateSupplier({ ...base, receipts: 2, unitsReceived: 10, unitsOnTime: 10, unitsLate: 0, unitsOverdue: 0, defectUnits: 0 });
    expect(thin.enough).toBe(false);
    expect(thin.score).toBeNull();
    expect(thin.onTimeRate).toBe(1);
    const none = rateSupplier({ receipts: 0, unitsReceived: 0, unitsOnTime: 0, unitsLate: 0, unitsOverdue: 0, defectUnits: 0, leadDays: [], promisedLeadDays: null });
    expect([none.onTimeRate, none.defectRate, none.score, none.avgLeadDays]).toEqual([null, null, null, null]);
  });
});

// ───────────────────────────────────────────────────────────────── authorization and cost privacy

describe("authorization and cost privacy", () => {
  test("each role gets exactly its permissions", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    expect(await code(() => savePurchaseOrder(t.db, clerk.actor, { supplierId, locationId: DEFAULT_LOCATION_ID, currency: "IQD", lines: [{ code: product.sku, qty: "1", unitCost: "1000" }], idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => savePurchaseOrder(t.db, finance.actor, { supplierId, locationId: DEFAULT_LOCATION_ID, currency: "IQD", lines: [{ code: product.sku, qty: "1", unitCost: "1000" }], idempotencyKey: key() }, NOW))).toBe("forbidden");
    // purchasing.po.create without cost.read cannot write prices
    const noCost = await custom(["purchasing.po.create", "purchasing.po.read", "purchasing.supplier.read"]);
    expect(await code(() => savePurchaseOrder(t.db, noCost, { supplierId, locationId: DEFAULT_LOCATION_ID, currency: "IQD", lines: [{ code: product.sku, qty: "1", unitCost: "1000" }], idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => listPurchaseOrders(t.db, cashier.actor, parsePoFilters(new URLSearchParams()), NOW))).toBe("forbidden");
    expect(await code(() => listSuppliers(t.db, cashier.actor, parseSupplierFilters(new URLSearchParams()), NOW))).toBe("forbidden");
    expect(await code(() => createSupplier(t.db, finance.actor, { code: "SUP-FIN", name: "Finance cannot", currency: "USD" }, NOW))).toBe("forbidden");
    const poId = await approvedOrder(supplierId, [[product.sku, 1, "5.00"]]);
    expect(await code(() => recordInvoice(t.db, clerk.actor, { poId, invoiceNo: "INV-X", lines: [], idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect((await listPurchaseOrders(t.db, finance.actor, parsePoFilters(new URLSearchParams("view=all")), NOW)).rows.length).toBeGreaterThan(0);
  });

  test("without cost.read an order, a list, a receipt and the print document carry no amounts at all", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 4, "12.50"]]);
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "4" }], idempotencyKey: key() }, NOW);
    for (const value of [
      await getPurchaseOrder(t.db, clerk.actor, poId, "ar", NOW),
      await listPurchaseOrders(t.db, clerk.actor, parsePoFilters(new URLSearchParams("view=all")), NOW),
      await getReceipt(t.db, clerk.actor, receiptId, "ar", NOW),
      await purchaseOrderDocument(t.db, clerk.actor, poId, "ar", NOW),
    ]) {
      expect(leaksCost(value)).toBe(false);
    }
    // …while the manager sees them
    const managerView = await getPurchaseOrder(t.db, managerA.actor, poId, "ar", NOW);
    expect(managerView.order.totalMinor).toBe(5000);
    expect(managerView.lines[0].unitCostMinor).toBe(1250);
    // the clerk still posts the receipt: the server costs it from the order without showing it
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const layer = await t.db.select().from(costLayers).where(eq(costLayers.receiptItemId, (await t.db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId)).get())!.id)).get();
    expect(layer?.unitCostIqd).toBe(16_250);
  });
});

// ───────────────────────────────────────────────────────────────── suppliers

describe("suppliers", () => {
  test("a profile is created, edited with its version, its code stays unique, status changes need a reason", async () => {
    const supplierId = await supplier();
    const detail = await getSupplier(t.db, managerA.actor, supplierId, NOW);
    expect(detail.supplier.status).toBe("active");
    expect(await code(() => createSupplier(t.db, managerA.actor, { code: detail.supplier.code.toLowerCase(), name: "Same code", currency: "USD" }, NOW))).toBe("code_taken");
    const fields = { code: detail.supplier.code, name: "Renamed supplier", currency: "EUR", leadTimeDays: "١٤", phone: "+971 4 555 0101", email: "Sales@Example.com" };
    expect(await updateSupplier(t.db, managerA.actor, { supplierId, version: detail.supplier.updatedAt, ...fields }, NOW + 1)).toEqual({ changed: true });
    // the same stale version again → refused, never overwritten
    expect(await code(() => updateSupplier(t.db, managerB.actor, { supplierId, version: detail.supplier.updatedAt, ...fields, name: "Other" }, NOW + 2))).toBe("supplier_changed");
    const after = await getSupplier(t.db, managerA.actor, supplierId, NOW);
    expect(after.supplier).toMatchObject({ name: "Renamed supplier", currency: "EUR", leadTimeDays: 14, email: "sales@example.com" });
    expect(await fieldsOf(() => setSupplierStatus(t.db, managerA.actor, { supplierId, status: "blocked", reason: "" }, NOW))).toMatchObject({ reason: "reason_short" });
    await setSupplierStatus(t.db, managerA.actor, { supplierId, status: "blocked", reason: "late twice and short" }, NOW);
    const product = await make.product();
    expect(await fieldsOf(() => draftOrder(supplierId, [[product.sku, 1, "1.00"]]))).toMatchObject({ supplierId: "supplier_not_active" });
    await saveContact(t.db, managerA.actor, { supplierId, name: "Rana", role: "Sales", phone: "+971 50 111 2222", isPrimary: true }, NOW);
    await saveContact(t.db, managerA.actor, { supplierId, name: "Omar", isPrimary: true }, NOW);
    const contacts = (await getSupplier(t.db, managerA.actor, supplierId, NOW)).contacts;
    expect(contacts.filter((contact) => contact.isPrimary).map((contact) => contact.name)).toEqual(["Omar"]);
    expect((await getSupplier(t.db, managerA.actor, supplierId, NOW)).history.map((entry) => entry.action)).toContain("purchasing.supplier.status");
  });

  test("the rating counts on-time units, late ones and refused ones from posted receipts", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    // three orders due today: two arrive today, one three days late with 2 of 10 refused
    for (const [when, rejected] of [
      [NOW, 0],
      [NOW, 0],
      [NOW + 3 * DAY, 2],
    ] as const) {
      const poId = await approvedOrder(supplierId, [[product.sku, 10, "1.00"]], { expectedOn: "2026-11-10" });
      const [line] = await orderLines(poId);
      const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "10", rejected: String(rejected), rejectReason: rejected ? "crushed boxes" : undefined }], idempotencyKey: key() }, when);
      await postReceipt(t.db, clerk.actor, { receiptId }, when);
    }
    const rating = (await supplierRatings(t.db, [supplierId], NOW + 4 * DAY)).get(supplierId)!;
    // the 2 refused units are still owed by the late order: they count as overdue as well as defective
    expect(rating).toMatchObject({ receipts: 3, unitsReceived: 30, unitsOnTime: 20, unitsLate: 10, unitsOverdue: 2, defectUnits: 2, enough: true });
    expect(rating.onTimeRate).toBeCloseTo(20 / 32);
    expect(rating.defectRate).toBeCloseTo(2 / 30);
    expect(rating.score).toBe(Math.round(60 * (20 / 32) + 40 * (1 - 2 / 30)));
    expect(rating.grade).toBe("B");
  });
});

// ───────────────────────────────────────────────────────────────── purchase orders

describe("purchase orders", () => {
  test("a draft is created once per form key, validated line by line, and edited only with its version", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const idempotencyKey = key();
    const input = { supplierId, locationId: DEFAULT_LOCATION_ID, currency: "USD", fxRate: "1300", lines: [{ code: product.sku.toLowerCase(), qty: "٣", unitCost: "10.5" }], idempotencyKey };
    const first = await savePurchaseOrder(t.db, managerA.actor, input, NOW);
    const again = await savePurchaseOrder(t.db, managerA.actor, input, NOW);
    expect(again).toMatchObject({ poId: first.poId, replayed: true });
    const lines = await orderLines(first.poId);
    expect(lines.map((line) => [line.qtyOrdered, line.unitCostMinor])).toEqual([[3, 1050]]);
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, first.poId)).get())!.totalIqd).toBe(40_950);
    // field errors for each bad line at once
    const bundle = await t.d1.prepare("SELECT v.sku AS sku FROM bundle_items b JOIN variants v ON v.id = b.bundle_variant_id LIMIT 1").first<{ sku: string }>();
    const fields = await fieldsOf(() =>
      savePurchaseOrder(t.db, managerA.actor, { ...input, idempotencyKey: key(), expectedOn: "2020-01-01", lines: [{ code: "NO-SUCH-SKU", qty: "1", unitCost: "1" }, { code: product.sku, qty: "0", unitCost: "x" }, { code: product.sku, qty: "1", unitCost: "1" }, ...(bundle ? [{ code: bundle.sku, qty: "1", unitCost: "1" }] : [])] }, NOW),
    );
    expect(fields).toMatchObject({ expectedOn: "expected_past", "lines.0.code": "unknown_code", "lines.1.qty": "invalid", "lines.1.unitCost": "invalid", "lines.2.code": "duplicate_line" });
    if (bundle) expect(fields["lines.3.code"]).toBe("bundle_not_purchasable");
    const stale = await version(first.poId);
    await savePurchaseOrder(t.db, managerA.actor, { ...input, poId: first.poId, version: stale, lines: [{ code: product.sku, qty: "4", unitCost: "10.50" }] }, NOW + 1);
    expect(await code(() => savePurchaseOrder(t.db, managerB.actor, { ...input, poId: first.poId, version: stale, lines: [{ code: product.sku, qty: "9", unitCost: "1" }] }, NOW + 2))).toBe("po_changed");
    expect((await orderLines(first.poId))[0].qtyOrdered).toBe(4);
  });

  test("within the limit the submission approves; above it a second person decides — never the requester or creator", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const small = await draftOrder(supplierId, [[product.sku, 5, "10.00"]]);
    expect(await submitPurchaseOrder(t.db, managerA.actor, { poId: small, version: await version(small) }, NOW)).toEqual({ status: "approved", replayed: false });
    const big = await draftOrder(supplierId, [[product.sku, 10, "100.00"]], { actor: managerA.actor });
    const submitted = await submitPurchaseOrder(t.db, owner.actor, { poId: big, version: await version(big), note: "launch stock" }, NOW);
    expect(submitted.status).toBe("pending_approval");
    const approval = await t.db.select().from(approvals).where(and(eq(approvals.entityType, "purchase_order"), eq(approvals.entityId, big))).get();
    expect(approval).toMatchObject({ kind: "purchase_order", status: "pending", requestedBy: owner.id, requiredPermission: "purchasing.po.approve" });
    // the submitter (owner, who holds every permission) and the creator (managerA) cannot approve
    expect(await code(() => decidePurchaseOrder(t.db, owner.actor, { poId: big, decision: "approve" }, NOW))).toBe("approver_is_requester");
    expect(await code(() => decidePurchaseOrder(t.db, managerA.actor, { poId: big, decision: "approve" }, NOW))).toBe("approver_is_requester");
    expect(await code(() => decidePurchaseOrder(t.db, clerk.actor, { poId: big, decision: "approve" }, NOW))).toBe("forbidden");
    expect(await fieldsOf(() => decidePurchaseOrder(t.db, managerB.actor, { poId: big, decision: "reject" }, NOW))).toMatchObject({ note: "reason_short" });
    await decidePurchaseOrder(t.db, managerB.actor, { poId: big, decision: "reject", note: "split it into two orders" }, NOW);
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, big)).get())!.status).toBe("draft");
    // resubmitted → a new request; another manager approves
    await submitPurchaseOrder(t.db, managerA.actor, { poId: big, version: await version(big) }, NOW + 1);
    expect(await decidePurchaseOrder(t.db, managerB.actor, { poId: big, decision: "approve" }, NOW + 2)).toEqual({ status: "approved", replayed: false });
    expect(await decidePurchaseOrder(t.db, managerB.actor, { poId: big, decision: "approve" }, NOW + 3)).toMatchObject({ replayed: true });
    const rows = await t.db.select().from(approvals).where(eq(approvals.entityId, big));
    expect(rows.map((row) => row.status).sort()).toEqual(["approved", "rejected"]);
    // inventory's "incoming" reads approved orders
    const incoming = await t.d1
      .prepare("SELECT SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS n FROM po_items pi JOIN purchase_orders o ON o.id = pi.po_id WHERE pi.variant_id = ?1 AND o.status IN ('approved','sent','partially_received')")
      .bind(product.variantId)
      .first<{ n: number }>();
    expect(incoming?.n).toBe(15);
  });

  test("cancel only while nothing was received; close short needs a reason and leaves the incoming column", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 6, "2.00"]]);
    await markOrderSent(t.db, managerA.actor, { poId }, NOW);
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "4" }], idempotencyKey: key() }, NOW);
    expect(await code(() => cancelPurchaseOrder(t.db, managerA.actor, { poId, reason: "changed my mind" }, NOW))).toBe("po_has_receipts");
    expect(await code(() => closePurchaseOrder(t.db, managerA.actor, { poId, reason: "supplier out of stock" }, NOW))).toBe("po_not_open");
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.status).toBe("partially_received");
    expect(await fieldsOf(() => closePurchaseOrder(t.db, managerA.actor, { poId }, NOW))).toMatchObject({ reason: "reason_short" });
    expect(await closePurchaseOrder(t.db, managerA.actor, { poId, reason: "supplier out of stock" }, NOW)).toEqual({ outstanding: 2, replayed: false });
    const alerts = await listAlerts(t.db, managerA.actor, { kind: "short_closed", page: 1 }, "ar", NOW);
    expect(alerts.rows.some((alert) => alert.po?.id === poId && alert.missing === 2)).toBe(true);
    const other = await draftOrder(supplierId, [[product.sku, 1, "1.00"]]);
    await cancelPurchaseOrder(t.db, managerA.actor, { poId: other, reason: "entered twice" }, NOW);
    expect(await cancelPurchaseOrder(t.db, managerA.actor, { poId: other, reason: "entered twice" }, NOW)).toEqual({ replayed: true });
  });
});

// ───────────────────────────────────────────────────────────────── receiving

describe("receiving through the stock core", () => {
  test("a partial receipt with inspection posts accepted units, layers, movements, the order and the books once", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 10, "10.00"]]);
    const [line] = await orderLines(poId);
    expect(await fieldsOf(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "11" }], idempotencyKey: key() }, NOW))).toMatchObject({ [`lines.${line.id}.received`]: "over_receipt" });
    expect(await fieldsOf(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "6", rejected: "1" }], idempotencyKey: key() }, NOW))).toMatchObject({ [`lines.${line.id}.rejectReason`]: "reject_reason_required" });
    const idempotencyKey = key();
    const draft = await createReceipt(t.db, clerk.actor, { poId, supplierDocNo: "DN-77", lines: [{ poItemId: line.id, received: "6", rejected: "1", rejectReason: "crushed box" }], idempotencyKey }, NOW);
    expect(await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "6" }], idempotencyKey }, NOW)).toMatchObject({ receiptId: draft.receiptId, replayed: true });
    expect((await level(product.variantId)).onHand).toBe(0);
    // only 4 more can be drafted while 5 wait in this draft
    expect(await fieldsOf(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "6" }], idempotencyKey: key() }, NOW))).toMatchObject({ [`lines.${line.id}.received`]: "over_receipt" });

    expect(await postReceipt(t.db, clerk.actor, { receiptId: draft.receiptId }, NOW)).toEqual({ units: 5, resumed: false, replayed: false });
    expect(await postReceipt(t.db, clerk.actor, { receiptId: draft.receiptId }, NOW)).toMatchObject({ replayed: true });
    expect((await level(product.variantId)).onHand).toBe(5);
    const item = (await t.db.select().from(receiptItems).where(eq(receiptItems.receiptId, draft.receiptId)).get())!;
    const movements = await t.db.select().from(stockMovements).where(and(eq(stockMovements.refType, "receipt_item"), eq(stockMovements.refId, item.id)));
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ kind: "receive", qtyDelta: 5, unitCostIqd: 13_000, actorId: clerk.id });
    expect(movements[0].reason).toContain("DN-77");
    expect((await orderLines(poId))[0].qtyReceived).toBe(5);
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.status).toBe("partially_received");
    const journal = await journalOf(draft.receiptId);
    expect(journal.map((row) => [row.account, row.debit, row.credit])).toEqual([
      ["acc_inventory", 65_000, 0],
      ["acc_accounts_payable", 0, 65_000],
    ]);
    // the rest arrives: the order is received
    const rest = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "5" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId: rest.receiptId }, NOW);
    expect((await t.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.status).toBe("received");
    const view = await getReceipt(t.db, managerA.actor, draft.receiptId, "ar", NOW);
    expect(view.receipt.state).toBe("posted");
    expect(view.money?.postedIqd).toBe(65_000);
    expect(view.units).toMatchObject({ received: 6, accepted: 5, rejected: 1, inStock: 5 });
  });

  test("serial-tracked lines need one serial per accepted unit, never one already registered (any letter case)", async () => {
    const supplierId = await supplier();
    const product = await make.product({ trackSerials: true });
    const poId = await approvedOrder(supplierId, [[product.sku, 3, "300.00"]]);
    const [line] = await orderLines(poId);
    expect(await fieldsOf(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "2" }], idempotencyKey: key() }, NOW))).toMatchObject({ [`lines.${line.id}.serials`]: "serials_required" });
    expect(await fieldsOf(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "2", serials: ["SN-A1"] }], idempotencyKey: key() }, NOW))).toMatchObject({ [`lines.${line.id}.serials`]: "serials_count" });
    const serial = `SN-${newId("x").slice(-8)}`;
    await receiveStock(t.db, owner.actor, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 1, unitCostIqd: 1, serials: [serial], ref: "fixture" }, NOW);
    expect(await code(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "1", serials: [serial.toLowerCase()] }], idempotencyKey: key() }, NOW))).toBe("serial_duplicate");
    const serials = [`SN-${newId("a").slice(-8)}`, `SN-${newId("b").slice(-8)}`];
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "2", serials }], idempotencyKey: key() }, NOW);
    // a second draft cannot scan the same serials
    expect(await code(() => createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "1", serials: [serials[0]] }], idempotencyKey: key() }, NOW))).toBe("serial_duplicate");
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const rows = await t.d1.prepare("SELECT serial, status, source_ref AS sourceRef FROM serials WHERE variant_id = ?1 AND serial IN (?2, ?3)").bind(product.variantId, serials[0], serials[1]).all<{ serial: string; status: string; sourceRef: string }>();
    expect(rows.results.map((row) => row.status)).toEqual(["in_stock", "in_stock"]);
  });

  test("landed costs are spread on the draft through pricing; posting waits for unspread bills and carries the landed cost", async () => {
    const supplierId = await supplier({ currency: "IQD" });
    const a = await make.product();
    const b = await make.product();
    const poId = await approvedOrder(supplierId, [[a.sku, 4, "10000"], [b.sku, 2, "30000"]], { currency: "IQD", fxRate: "" });
    const lines = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: lines.map((line) => ({ poItemId: line.id, received: String(line.qtyOrdered) })), idempotencyKey: key() }, NOW);
    const bill = await addLandedCost(t.db, managerA.actor, { receiptId, kind: "freight", currency: "IQD", amount: "12000", method: "by_qty", reason: "forwarder invoice 812", idempotencyKey: key() }, NOW);
    expect(await code(() => postReceipt(t.db, clerk.actor, { receiptId }, NOW))).toBe("landed_unallocated");
    await allocateLandedCost(t.db, managerA.actor, { landedCostId: bill.landedCostId, receiptId }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const layers = await t.d1.prepare("SELECT cl.variant_id AS variantId, cl.unit_cost_iqd AS cost FROM cost_layers cl JOIN receipt_items ri ON ri.id = cl.receipt_item_id WHERE ri.receipt_id = ?1").bind(receiptId).all<{ variantId: string; cost: number }>();
    expect(Object.fromEntries(layers.results.map((row) => [row.variantId, row.cost]))).toEqual({ [a.variantId]: 12_000, [b.variantId]: 32_000 });
    const journal = await journalOf(receiptId);
    expect(journal[0]).toMatchObject({ account: "acc_inventory", debit: 4 * 12_000 + 2 * 32_000 });
    // a posted receipt's bills are frozen (pricing refuses), so its landed cost cannot drift from the layers
    expect(await code(() => addLandedCost(t.db, managerA.actor, { receiptId, kind: "customs", currency: "IQD", amount: "500", method: "by_qty", reason: "late customs", idempotencyKey: key() }, NOW))).toBe("receipt_posted");
  });

  test("a posting that stopped half way is resumed after its lease without receiving a line twice", async () => {
    const supplierId = await supplier();
    const a = await make.product();
    const b = await make.product();
    const poId = await approvedOrder(supplierId, [[a.sku, 3, "1.00"], [b.sku, 2, "2.00"]]);
    const lines = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: lines.map((line) => ({ poItemId: line.id, received: String(line.qtyOrdered) })), idempotencyKey: key() }, NOW);
    const items = await t.db.select().from(receiptItems).where(eq(receiptItems.receiptId, receiptId));
    // a crash after the claim and the first line: the receipt says "posting", one line is in stock
    await t.db.update(receipts).set({ status: "posted", receivedBy: "posting:crashed", postedAt: NOW - 10 * 60_000 }).where(eq(receipts.id, receiptId));
    const first = items.find((item) => item.variantId === a.variantId)!;
    await receiveStock(t.db, clerk.actor, { variantId: a.variantId, locationId: DEFAULT_LOCATION_ID, qty: 3, unitCostIqd: first.unitCostIqd!, ref: { type: "receipt_item", id: first.id } }, NOW - 9 * 60_000);
    expect((await getReceipt(t.db, clerk.actor, receiptId, "ar", NOW)).receipt.posting?.resumable).toBe(true);
    // inside the lease nobody else may take over
    expect(await code(() => postReceipt(t.db, clerk.actor, { receiptId }, NOW - 6 * 60_000))).toBe("posting_in_progress");
    expect(await postReceipt(t.db, clerk.actor, { receiptId }, NOW)).toMatchObject({ units: 5, resumed: true });
    expect((await level(a.variantId)).onHand).toBe(3);
    expect((await level(b.variantId)).onHand).toBe(2);
    expect((await orderLines(poId)).map((line) => line.qtyReceived).sort()).toEqual([2, 3]);
    expect((await journalOf(receiptId))[0]).toMatchObject({ debit: 3 * 1300 + 2 * 2600 });
  });

  test("two people posting the same receipt at once move its stock once", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 7, "1.00"]]);
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "7" }], idempotencyKey: key() }, NOW);
    const results = await Promise.allSettled([postReceipt(t.db, clerk.actor, { receiptId }, NOW), postReceipt(t.db, managerA.actor, { receiptId }, NOW)]);
    expect(results.filter((result) => result.status === "fulfilled" && !result.value.replayed)).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(toAppError(result.reason)?.code).toBe("posting_in_progress");
    expect((await level(product.variantId)).onHand).toBe(7);
    expect((await orderLines(poId))[0].qtyReceived).toBe(7);
    expect(await journalOf(receiptId)).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────── invoices

describe("supplier invoices and the three-way match", () => {
  test("an invoice billing more than arrived is a variance; accepting it needs a reason and a second person", async () => {
    const supplierId = await supplier();
    const a = await make.product();
    const b = await make.product();
    const poId = await approvedOrder(supplierId, [[a.sku, 5, "10.00"], [b.sku, 4, "20.00"]]);
    const lines = await orderLines(poId);
    const lineA = lines.find((line) => line.variantId === a.variantId)!;
    const lineB = lines.find((line) => line.variantId === b.variantId)!;
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: lineA.id, received: "5" }, { poItemId: lineB.id, received: "2" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const recorded = await recordInvoice(t.db, finance.actor, { poId, invoiceNo: "INV-1001", issuedOn: "2026-11-09", lines: [{ poItemId: lineA.id, qty: "5", unitCost: "10.00" }, { poItemId: lineB.id, qty: "4", unitCost: "21.00" }], idempotencyKey: key() }, NOW);
    expect(recorded).toMatchObject({ status: "mismatch", discrepancies: 2 });
    expect(await fieldsOf(() => recordInvoice(t.db, finance.actor, { poId, invoiceNo: "INV-1001", lines: [{ poItemId: lineA.id, qty: "1", unitCost: "10.00" }], idempotencyKey: key() }, NOW))).toMatchObject({ invoiceNo: "invoice_no_taken" });
    const detail = await getInvoice(t.db, finance.actor, recorded.invoiceId, "ar");
    expect(detail.discrepancies.map((item) => item.field).sort()).toEqual(["qty", "unit_cost"]);
    expect(detail.can.approveNeedsSecondPerson).toBe(true);
    expect(await code(() => approveInvoice(t.db, finance.actor, { invoiceId: recorded.invoiceId, reason: "agreed by phone" }, NOW))).toBe("approver_is_requester");
    expect(await fieldsOf(() => approveInvoice(t.db, managerA.actor, { invoiceId: recorded.invoiceId }, NOW))).toMatchObject({ reason: "variance_reason_required" });
    // the rest of B arrives: the quantity variance is gone after the posting re-matches open invoices
    const more = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: lineB.id, received: "2" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId: more.receiptId }, NOW);
    const after = await getInvoice(t.db, finance.actor, recorded.invoiceId, "ar");
    expect(after.stored.map((item) => item.field)).toEqual(["unit_cost"]);
    expect(await approveInvoice(t.db, managerA.actor, { invoiceId: recorded.invoiceId, reason: "price rise agreed in writing" }, NOW)).toEqual({ replayed: false, variances: 1 });
    expect((await getInvoice(t.db, finance.actor, recorded.invoiceId, "ar")).invoice.status).toBe("approved");
  });

  test("a matched invoice is approved by the person who recorded it; leaks nothing to the wrong roles", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 2, "5.00"]]);
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "2" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const { invoiceId, status } = await recordInvoice(t.db, finance.actor, { poId, invoiceNo: "INV-2002", lines: [{ poItemId: line.id, qty: "٢", unitCost: "5" }], idempotencyKey: key() }, NOW);
    expect(status).toBe("matched");
    expect(await approveInvoice(t.db, finance.actor, { invoiceId }, NOW)).toEqual({ replayed: false, variances: 0 });
    expect(await code(() => getInvoice(t.db, clerk.actor, invoiceId, "ar"))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── claims

describe("supplier claims", () => {
  test("a claim starts from refused units, follows its path and refuses a jump", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 8, "3.00"]]);
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "8", rejected: "3", rejectReason: "water damage" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const prefill = await claimPrefill(t.db, managerA.actor, { receiptId }, "ar");
    expect(prefill).toMatchObject({ supplierId, poId, receiptId, kind: "damage", lines: [{ code: product.sku, qty: 3 }] });
    const { claimId } = await createClaim(t.db, managerA.actor, { receiptId, kind: "damage", description: "3 wet boxes", lines: prefill.lines.map((entry) => ({ code: entry.code, qty: String(entry.qty) })), idempotencyKey: key() }, NOW);
    const detail = await getClaim(t.db, managerA.actor, claimId, "ar", NOW);
    expect(detail.claim).toMatchObject({ status: "open", amountMinor: 900, currency: "USD", amountIqd: 11_700 });
    expect(await code(() => moveClaim(t.db, managerA.actor, { claimId, to: "credited" }, NOW))).toBe("claim_transition");
    await moveClaim(t.db, managerA.actor, { claimId, to: "submitted" }, NOW);
    await moveClaim(t.db, managerA.actor, { claimId, to: "accepted" }, NOW);
    expect(await fieldsOf(() => moveClaim(t.db, managerA.actor, { claimId, to: "credited" }, NOW))).toMatchObject({ creditReference: "required" });
    await moveClaim(t.db, managerA.actor, { claimId, to: "credited", creditReference: "CN-55", creditAmount: "9.00" }, NOW);
    expect(await fieldsOf(() => moveClaim(t.db, managerA.actor, { claimId, to: "closed" }, NOW))).toMatchObject({ note: "reason_short" });
    await moveClaim(t.db, managerA.actor, { claimId, to: "closed", note: "settled by credit note" }, NOW);
    const closed = await getClaim(t.db, managerA.actor, claimId, "ar", NOW);
    expect(closed.claim.status).toBe("closed");
    expect(closed.claim.resolution).toContain("settled");
    // the claim's units were refused at inspection: the rating counts them once
    const rating = (await supplierRatings(t.db, [supplierId], NOW)).get(supplierId)!;
    expect(rating.defectUnits).toBe(3);
  });

  test("goods go back to the supplier through the core once, with the claim in the movement's reason", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 6, "4.00"]]);
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "6" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const { claimId, ref } = await createClaim(t.db, managerA.actor, { poId, kind: "defect", lines: [{ code: product.sku, qty: "2" }], idempotencyKey: key() }, NOW);
    const onlyClaims = await custom(["purchasing.claim.manage"]);
    expect(await code(() => returnClaimGoods(t.db, onlyClaims, { claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW))).toBe("forbidden");
    const [first, second] = await Promise.allSettled([returnClaimGoods(t.db, managerA.actor, { claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW), returnClaimGoods(t.db, managerB.actor, { claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW)]);
    const moved = [first, second].filter((result) => result.status === "fulfilled" && result.value.returned === 2);
    expect(moved).toHaveLength(1);
    expect((await level(product.variantId)).onHand).toBe(4);
    const movements = await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, product.variantId), eq(stockMovements.kind, "adjust")));
    expect(movements).toHaveLength(1);
    expect(movements[0].qtyDelta).toBe(-2);
    expect(movements[0].reason?.startsWith(`${ref} [`)).toBe(true);
    expect(await returnClaimGoods(t.db, managerA.actor, { claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW)).toEqual({ returned: 0, fromStock: 0, replayed: true });
    expect((await getClaim(t.db, managerA.actor, claimId, "ar", NOW)).returnState).toBe("done");
  });

  test("serial-tracked units are refused before anything moves; a stock shortage is said before anything moves", async () => {
    const supplierId = await supplier();
    const tracked = await make.product({ trackSerials: true });
    const loose = await make.product();
    const trackedClaim = await createClaim(t.db, managerA.actor, { supplierId, kind: "return", lines: [{ code: tracked.sku, qty: "1" }], idempotencyKey: key() }, NOW);
    expect(await code(() => returnClaimGoods(t.db, managerA.actor, { claimId: trackedClaim.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW))).toBe("serial_tracked");
    const shortClaim = await createClaim(t.db, managerA.actor, { supplierId, kind: "return", lines: [{ code: loose.sku, qty: "5" }], idempotencyKey: key() }, NOW);
    expect(await code(() => returnClaimGoods(t.db, managerA.actor, { claimId: shortClaim.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW))).toBe("insufficient_stock");
    const items = (await t.db.select().from(supplierClaims).where(eq(supplierClaims.id, shortClaim.claimId)).get())!.items as Array<Record<string, unknown>>;
    expect(items.every((item) => !("returned" in item))).toBe(true);
    expect(await code(() => createClaim(t.db, managerA.actor, { supplierId, kind: "price", lines: [{ code: loose.sku, qty: "1" }], idempotencyKey: key() }, NOW))).toBe("invalid");
  });
});

// ───────────────────────────────────────────────────────────────── RFQs

describe("requests for quotation", () => {
  test("quotes are compared in IQD, the cheapest complete one is marked, the award makes one draft order", async () => {
    const a = await make.product();
    const b = await make.product();
    const cheap = await supplier({ currency: "USD" });
    const partial = await supplier({ currency: "IQD" });
    const { rfqId } = await createRfq(t.db, managerA.actor, { title: "Restock controllers", neededBy: "2026-12-01", lines: [{ code: a.sku, qty: "10" }, { code: b.sku, qty: "4" }], idempotencyKey: key() }, NOW);
    const items = (await getRfq(t.db, managerA.actor, rfqId, "ar", NOW)).items;
    const itemA = items.find((item) => item.variant.id === a.variantId)!;
    const itemB = items.find((item) => item.variant.id === b.variantId)!;
    await recordQuote(t.db, managerA.actor, { rfqId, supplierId: cheap, currency: "USD", leadTimeDays: "20", warrantyMonths: "12", lines: [{ rfqItemId: itemA.id, unitCost: "40" }, { rfqItemId: itemB.id, unitCost: "15.50" }] }, NOW);
    await recordQuote(t.db, managerA.actor, { rfqId, supplierId: partial, currency: "IQD", leadTimeDays: "5", warrantyMonths: "6", lines: [{ rfqItemId: itemA.id, unitCost: "50000", qtyAvailable: "6" }] }, NOW);
    expect(await code(() => recordQuote(t.db, clerk.actor, { rfqId, supplierId: cheap, currency: "USD", lines: [] }, NOW))).toBe("forbidden");
    const detail = await getRfq(t.db, managerA.actor, rfqId, "ar", NOW);
    expect(detail.rfq.status).toBe("quoted");
    const quoteCheap = detail.quotes.find((quote) => quote.supplier.id === cheap)!;
    const quotePartial = detail.quotes.find((quote) => quote.supplier.id === partial)!;
    expect(quoteCheap).toMatchObject({ totalMinor: 46_200, coverage: { complete: true }, lead: 20, warranty: 12, best: { price: true, lead: false, warranty: true } });
    expect(quotePartial).toMatchObject({ totalMinor: 300_000, totalIqd: 300_000, coverage: { complete: false }, best: { price: false, lead: true } });
    const idempotencyKey = key();
    const award = await awardQuote(t.db, managerA.actor, { rfqId, quoteId: quoteCheap.id, locationId: DEFAULT_LOCATION_ID, fxRate: "1310", idempotencyKey }, NOW);
    expect(await awardQuote(t.db, managerA.actor, { rfqId, quoteId: quoteCheap.id, locationId: DEFAULT_LOCATION_ID, idempotencyKey }, NOW)).toEqual({ poId: award.poId, replayed: true });
    expect(await code(() => awardQuote(t.db, managerA.actor, { rfqId, quoteId: quotePartial.id, locationId: DEFAULT_LOCATION_ID, idempotencyKey: key() }, NOW))).toBe("rfq_closed");
    const order = await getPurchaseOrder(t.db, managerA.actor, award.poId, "ar", NOW);
    expect(order.order).toMatchObject({ status: "draft", currency: "USD", fxRateMicros: 1_310_000_000, rfq: { id: rfqId } });
    expect(order.lines.map((line) => [line.variant.id, line.qtyOrdered, line.unitCostMinor]).sort()).toEqual(
      [
        [a.variantId, 10, 4000],
        [b.variantId, 4, 1550],
      ].sort(),
    );
    const after = await getRfq(t.db, managerA.actor, rfqId, "ar", NOW);
    expect(after.rfq).toMatchObject({ status: "awarded", poId: award.poId });
    expect(after.quotes.find((quote) => quote.id === quotePartial.id)?.status).toBe("rejected");
  });
});

// ───────────────────────────────────────────────────────────────── alerts and branches

describe("variance alerts and branch limits", () => {
  test("refused units and late orders show up for the roles that may see them, prices only with cost.read", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const late = await approvedOrder(supplierId, [[product.sku, 3, "1.00"]], { expectedOn: "2026-11-10" });
    const priced = await approvedOrder(supplierId, [[product.sku, 1, "1.00"]]);
    const [pricedLine] = await orderLines(priced);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId: priced, lines: [{ poItemId: pricedLine.id, received: "1" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    await recordInvoice(t.db, finance.actor, { poId: priced, invoiceNo: `INV-${newId("n").slice(-6)}`, lines: [{ poItemId: pricedLine.id, qty: "1", unitCost: "1.25" }], idempotencyKey: key() }, NOW);
    const later = NOW + 2 * DAY;
    const managerAlerts = await listAlerts(t.db, managerA.actor, { kind: "all", page: 1 }, "ar", later);
    expect(managerAlerts.rows.some((alert) => alert.kind === "late" && alert.po?.id === late && alert.missing === 3)).toBe(true);
    expect(managerAlerts.rows.some((alert) => alert.kind === "invoice_price" && alert.po?.id === priced && alert.poUnitCostMinor === 100 && alert.invoiceUnitCostMinor === 125)).toBe(true);
    const clerkAlerts = await listAlerts(t.db, clerk.actor, { kind: "all", page: 1 }, "ar", later);
    expect(clerkAlerts.rows.some((alert) => alert.kind === "invoice_price")).toBe(false);
    expect(leaksCost(clerkAlerts)).toBe(false);
    expect(await code(() => listAlerts(t.db, cashier.actor, { kind: "all", page: 1 }, "ar", later))).toBe("forbidden");
  });

  test("an employee limited to a branch sees and receives only that branch's orders", async () => {
    const branchId = newId("brn");
    await t.db.insert(branches).values({ id: branchId, code: make.next("BR"), name: { ar: "فرع الاختبار" }, createdAt: NOW });
    const otherBranch = newId("brn");
    await t.db.insert(branches).values({ id: otherBranch, code: make.next("BR"), name: { ar: "فرع آخر" }, createdAt: NOW });
    const locationId = newId("loc");
    await t.db.insert(inventoryLocations).values({ id: locationId, code: make.next("BRLOC"), name: "Branch store", kind: "store", branchId });
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 2, "1.00"]], { locationId });
    const local = await staff("inventory", { branchId });
    const elsewhere = await staff("inventory", { branchId: otherBranch });
    expect((await getPurchaseOrder(t.db, local.actor, poId, "ar", NOW)).order.id).toBe(poId);
    expect(await code(() => getPurchaseOrder(t.db, elsewhere.actor, poId, "ar", NOW))).toBe("forbidden");
    const [line] = await orderLines(poId);
    expect(await code(() => createReceipt(t.db, elsewhere.actor, { poId, lines: [{ poItemId: line.id, received: "2" }], idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect((await listPurchaseOrders(t.db, elsewhere.actor, parsePoFilters(new URLSearchParams("view=all")), NOW)).rows.some((row) => row.id === poId)).toBe(false);
    await createReceipt(t.db, local.actor, { poId, lines: [{ poItemId: line.id, received: "2" }], idempotencyKey: key() }, NOW);
  });
});

// ───────────────────────────────────────────────────────────────── route loaders

describe("route loaders", () => {
  function request(path: string, cookies: Record<string, string> = {}) {
    return new Request(`http://localhost:5173${path}`, { headers: Object.keys(cookies).length ? { Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ") } : {} });
  }
  async function signedIn(person: Staff): Promise<Record<string, string>> {
    const jar: Record<string, string> = {};
    const ctx = {
      requestId: "pur-test",
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
      setCookie: (serialized: string) => {
        const [pair] = serialized.split("; ");
        const at = pair.indexOf("=");
        jar[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
      },
    } as unknown as RequestCtx;
    const result = await signInEmployee(ctx, t.db, { email: person.email, password: person.password });
    if (result.status !== "signed_in") throw new Error(`sign-in: ${result.status}`);
    return jar;
  }
  async function run(req: Request, loader: (args: never) => Promise<unknown>, pattern: string, params: Record<string, string> = {}) {
    const context = new RouterContextProvider();
    const url = new URL(req.url);
    try {
      return await requestContextMiddleware({ request: req, context, url, pattern, params }, async () => {
        const result = await loader({ request: req, context, url, pattern, params } as never);
        return result instanceof Response ? result : Response.json(result);
      });
    } catch (error) {
      return error;
    }
  }
  const statusOf = (value: unknown) => (value instanceof Response ? value.status : ((value as { init?: { status?: number } })?.init?.status ?? 0));

  test("the order list answers per role and never sends amounts without cost.read", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    await approvedOrder(supplierId, [[product.sku, 2, "3.00"]]);
    const clerkPage = (await run(request("/admin/purchasing/orders?view=all", await signedIn(clerk)), ordersLoader as never, "admin/purchasing/orders")) as Response;
    expect(clerkPage.status).toBe(200);
    const body = (await clerkPage.json()) as { page: { rows: unknown[] }; filters: { view: string } };
    expect(body.filters.view).toBe("all");
    expect(body.page.rows.length).toBeGreaterThan(0);
    expect(leaksCost(body)).toBe(false);
    const managerBody = await ((await run(request("/admin/purchasing/orders?view=all", await signedIn(managerA)), ordersLoader as never, "admin/purchasing/orders")) as Response).json();
    expect(leaksCost(managerBody)).toBe(true);
    expect(statusOf(await run(request("/admin/purchasing/orders", await signedIn(cashier)), ordersLoader as never, "admin/purchasing/orders"))).toBe(403);
    expect(statusOf(await run(request("/admin/purchasing/invoices", await signedIn(clerk)), invoicesLoader as never, "admin/purchasing/invoices"))).toBe(403);
    const anonymous = await run(request("/admin/purchasing/orders"), ordersLoader as never, "admin/purchasing/orders");
    expect(anonymous instanceof Response && anonymous.headers.get("Location")).toContain("/admin/login");
  });
});
