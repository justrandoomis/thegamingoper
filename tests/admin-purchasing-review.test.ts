/**
 * Admin module 09 — adversarial review (owner: admin purchasing). Each test here failed on the module as it was first
 * built and passes with its fix; the module's own suite stays in tests/admin-purchasing.test.ts.
 *
 *   · branch limits on every write (invoices voided or re-matched, claims moved or sent back from another branch)
 *     and on the supplier profile's order list
 *   · four eyes: the decision is bound to the request the approver saw; whoever edited the draft does not approve it;
 *     an order split into pieces below the limit still meets a second person; a supplier blocked meanwhile is not
 *     approved
 *   · stock: units refused at inspection never leave stock when a claim sends them back, and a claim tied to a receipt
 *     or an order sends back at most what it put into stock
 *   · races (the competing request runs just before the service's write batch): a landed-cost bill spread while the
 *     receipt is being posted, two receipts drafted at once for the same units
 *   · the three-way match covers the invoice's charges, not only its lines
 *   · amounts too big for an exact total are a field error, never a crash (500)
 *   · the rating counts units of an order closed short after its day against on-time delivery
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, branches, employeeRoles, inventoryLocations, poItems, purchaseOrders, receiptItems, receipts, stockLevels, stockMovements, supplierClaims, supplierInvoices } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { addLandedCost, allocateLandedCost } from "~/server/services/admin/pricing/landed.server";
import { purchasingOverview } from "~/server/services/admin/purchasing/alerts.server";
import { claimPrefill, createClaim, getClaim, moveClaim, returnClaimGoods } from "~/server/services/admin/purchasing/claims.server";
import { approveInvoice, getInvoice, recordInvoice, rematchInvoice, voidInvoice } from "~/server/services/admin/purchasing/invoices.server";
import { cancelPurchaseOrder, closePurchaseOrder, decidePurchaseOrder, getPurchaseOrder, savePurchaseOrder, submitPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { supplierRatings } from "~/server/services/admin/purchasing/rating.server";
import { createReceipt, getReceipt, postReceipt } from "~/server/services/admin/purchasing/receipts.server";
import { createRfq, getRfq, recordQuote } from "~/server/services/admin/purchasing/rfqs.server";
import { createSupplier, getSupplier, setSupplierStatus } from "~/server/services/admin/purchasing/suppliers.server";
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

type Staff = { id: string; actor: EmployeeActor };
async function staff(role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): Promise<Staff> {
  const id = await make.employee({ email: `${make.next(role)}@purchasing-review.test`, name: `${role} reviewer` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, actor: { kind: "employee", id, permissions: defaultRolePermissions(role), label: `${role} reviewer`, ...extra } };
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

type Batch = (statements: unknown) => Promise<unknown>;

/**
 * The same database, except that `hook` runs once, just before the `nth` call of db.batch — another request that
 * lands between the service's reads and its write batch.
 */
function beforeBatch(db: Db, nth: number, hook: () => PromiseLike<unknown>): Db {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: unknown) => {
          calls += 1;
          if (calls === nth) await hook();
          return (target.batch as unknown as Batch).call(target, statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let owner: Staff;
let managerA: Staff;
let managerB: Staff;
let clerk: Staff;
let finance: Staff;

beforeAll(async () => {
  owner = await staff("owner");
  managerA = await staff("manager");
  managerB = await staff("manager");
  clerk = await staff("inventory");
  finance = await staff("finance");
}, 60_000);

async function supplier(options: { currency?: string } = {}) {
  const codeValue = make.next("SUP").toUpperCase();
  const { supplierId } = await createSupplier(t.db, managerA.actor, { code: codeValue, name: `Supplier ${codeValue}`, currency: options.currency ?? "USD", leadTimeDays: "10", paymentTerms: "net 30" }, NOW);
  return supplierId;
}

type OrderOptions = { currency?: string; fxRate?: string; expectedOn?: string; locationId?: string; actor?: EmployeeActor; shipping?: string; other?: string; at?: number };

function orderInput(supplierId: string, lines: [string, number, string][], options: OrderOptions = {}) {
  return {
    supplierId,
    locationId: options.locationId ?? DEFAULT_LOCATION_ID,
    currency: options.currency ?? "USD",
    fxRate: options.fxRate ?? (options.currency === "IQD" ? "" : "1300"),
    expectedOn: options.expectedOn ?? "2026-11-15",
    shipping: options.shipping,
    other: options.other,
    lines: lines.map(([sku, qty, unitCost]) => ({ code: sku, qty: String(qty), unitCost })),
  };
}

/** A draft order of `lines` [sku, qty, unit cost] — USD at 1300 IQD by default. */
async function draftOrder(supplierId: string, lines: [string, number, string][], options: OrderOptions = {}) {
  const result = await savePurchaseOrder(t.db, options.actor ?? managerA.actor, { ...orderInput(supplierId, lines, options), idempotencyKey: key() }, options.at ?? NOW);
  return result.poId;
}

async function version(poId: string) {
  return (await t.db.select({ updatedAt: purchaseOrders.updatedAt }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.updatedAt;
}

async function statusOf(poId: string) {
  return (await t.db.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.status;
}

/** An approved order: within the limit its submitter (managerA) approves it, above it managerB does. */
async function approvedOrder(supplierId: string, lines: [string, number, string][], options: OrderOptions = {}) {
  const poId = await draftOrder(supplierId, lines, options);
  const result = await submitPurchaseOrder(t.db, options.actor ?? managerA.actor, { poId, version: await version(poId) }, options.at ?? NOW);
  if (result.status === "pending_approval") await decidePurchaseOrder(t.db, managerB.actor, { poId, decision: "approve" }, options.at ?? NOW);
  return poId;
}

async function orderLines(poId: string) {
  return t.db.select().from(poItems).where(eq(poItems.poId, poId));
}

async function level(variantId: string, locationId = DEFAULT_LOCATION_ID) {
  return (await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, locationId))).get()) ?? { onHand: 0, reserved: 0 };
}

/** Receives the whole order in one posted receipt (optionally refusing some units of the first line). */
async function receiveAll(poId: string, options: { rejected?: number; at?: number } = {}) {
  const lines = await orderLines(poId);
  const { receiptId } = await createReceipt(
    t.db,
    clerk.actor,
    {
      poId,
      lines: lines.map((line, index) => ({ poItemId: line.id, received: String(line.qtyOrdered), ...(index === 0 && options.rejected ? { rejected: String(options.rejected), rejectReason: "water damage" } : {}) })),
      idempotencyKey: key(),
    },
    options.at ?? NOW,
  );
  await postReceipt(t.db, clerk.actor, { receiptId }, options.at ?? NOW);
  return receiptId;
}

async function branchWithLocation() {
  const branchId = newId("brn");
  await t.db.insert(branches).values({ id: branchId, code: make.next("BR"), name: { ar: "فرع المراجعة" }, createdAt: NOW });
  const locationId = newId("loc");
  await t.db.insert(inventoryLocations).values({ id: locationId, code: make.next("BRLOC"), name: "Review branch store", kind: "store", branchId });
  return { branchId, locationId };
}

// ───────────────────────────────────────────────────────────────── branch limits

describe("branch limits on every write", () => {
  test("an employee of another branch cannot void or re-match its invoices, move its claims or send their goods back", async () => {
    const home = await branchWithLocation();
    const away = await branchWithLocation();
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 4, "2.00"]], { locationId: home.locationId });
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "4" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    const { invoiceId } = await recordInvoice(t.db, finance.actor, { poId, invoiceNo: `INV-${newId("n").slice(-6)}`, lines: [{ poItemId: line.id, qty: "4", unitCost: "2.00" }], idempotencyKey: key() }, NOW);
    const { claimId } = await createClaim(t.db, managerA.actor, { poId, kind: "defect", lines: [{ code: product.sku, qty: "1" }], idempotencyKey: key() }, NOW);
    // the other branch keeps the same SKU in its own store
    await receiveStock(t.db, owner.actor, { variantId: product.variantId, locationId: away.locationId, qty: 5, unitCostIqd: 2600, ref: "fixture" }, NOW);
    const outsider = await staff("manager", { branchId: away.branchId });

    expect(await code(() => voidInvoice(t.db, outsider.actor, { invoiceId, reason: "not ours to keep" }, NOW))).toBe("forbidden");
    expect(await code(() => rematchInvoice(t.db, outsider.actor, { invoiceId }, NOW))).toBe("forbidden");
    expect(await code(() => moveClaim(t.db, outsider.actor, { claimId, to: "submitted" }, NOW))).toBe("forbidden");
    expect(await code(() => returnClaimGoods(t.db, outsider.actor, { claimId, locationId: away.locationId, reason: "handed to the courier" }, NOW))).toBe("forbidden");
    // nothing changed
    expect((await t.db.select({ status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, invoiceId)).get())!.status).toBe("matched");
    expect((await t.db.select({ status: supplierClaims.status }).from(supplierClaims).where(eq(supplierClaims.id, claimId)).get())!.status).toBe("open");
    expect((await level(product.variantId, away.locationId)).onHand).toBe(5);
    // the supplier's profile lists the outsider no order of the other branch
    const profile = await getSupplier(t.db, outsider.actor, supplierId, NOW);
    expect(profile.orders.some((order) => order.id === poId)).toBe(false);
    expect((await getSupplier(t.db, managerA.actor, supplierId, NOW)).orders.some((order) => order.id === poId)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── four eyes

describe("four eyes on purchase orders", () => {
  test("an approval is bound to the request the approver saw: a newer request is not approved by an old page", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await draftOrder(supplierId, [[product.sku, 10, "100.00"]]); // 1,300,000 IQD
    expect((await submitPurchaseOrder(t.db, managerA.actor, { poId, version: await version(poId) }, NOW)).status).toBe("pending_approval");
    const seen = (await t.db.select().from(approvals).where(and(eq(approvals.entityType, "purchase_order"), eq(approvals.entityId, poId))).get())!;
    // the owner opens the order while the first request waits… meanwhile it is sent back, made five times bigger and asked again
    await decidePurchaseOrder(t.db, managerB.actor, { poId, decision: "reject", note: "add the other colours" }, NOW + 1);
    await savePurchaseOrder(t.db, managerA.actor, { ...orderInput(supplierId, [[product.sku, 50, "100.00"]]), poId, version: await version(poId) }, NOW + 2);
    await submitPurchaseOrder(t.db, managerA.actor, { poId, version: await version(poId) }, NOW + 3);
    // …and the owner's "approve" from the old page arrives
    expect(await code(() => decidePurchaseOrder(t.db, owner.actor, { poId, decision: "approve", approvalId: seen.id }, NOW + 4))).toBe("po_changed");
    expect(await statusOf(poId)).toBe("pending_approval");
    // the request on the page now is approved with its own id
    const current = (await getPurchaseOrder(t.db, owner.actor, poId, "ar", NOW + 5)).approvals.find((row) => row.status === "pending")!;
    expect(current.id).not.toBe(seen.id);
    expect(await decidePurchaseOrder(t.db, owner.actor, { poId, decision: "approve", approvalId: current.id }, NOW + 5)).toEqual({ status: "approved", replayed: false });
  });

  test("whoever edited the draft does not approve it", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await draftOrder(supplierId, [[product.sku, 1, "1.00"]]);
    // managerB rewrites managerA's small draft into a big order; managerA submits it
    await savePurchaseOrder(t.db, managerB.actor, { ...orderInput(supplierId, [[product.sku, 40, "100.00"]]), poId, version: await version(poId) }, NOW + 1);
    expect((await submitPurchaseOrder(t.db, managerA.actor, { poId, version: await version(poId) }, NOW + 2)).status).toBe("pending_approval");
    expect(await code(() => decidePurchaseOrder(t.db, managerB.actor, { poId, decision: "approve" }, NOW + 3))).toBe("approver_is_requester");
    const view = await getPurchaseOrder(t.db, managerB.actor, poId, "ar", NOW + 3);
    expect(view.can.decide).toBe(false);
    expect(view.can.ownRequest).toBe(true);
    // the home page does not count it as waiting for managerB
    const before = (await purchasingOverview(t.db, owner.actor, NOW + 3)).waiting.approvals ?? 0;
    const mine = (await purchasingOverview(t.db, managerB.actor, NOW + 3)).waiting.approvals ?? 0;
    expect(before - mine).toBeGreaterThanOrEqual(1);
    expect(await decidePurchaseOrder(t.db, owner.actor, { poId, decision: "approve" }, NOW + 4)).toMatchObject({ status: "approved" });
  });

  test("an order split into pieces below the limit still meets a second person", async () => {
    const supplierId = await supplier({ currency: "IQD" });
    const product = await make.product();
    const first = await draftOrder(supplierId, [[product.sku, 8, "100000"]], { currency: "IQD" }); // 800,000 IQD
    expect((await submitPurchaseOrder(t.db, managerA.actor, { poId: first, version: await version(first) }, NOW)).status).toBe("approved");
    // the second piece alone is within the limit, but this person approved 800,000 IQD with this supplier this week
    const second = await draftOrder(supplierId, [[product.sku, 8, "100000"]], { currency: "IQD" });
    const view = await getPurchaseOrder(t.db, managerA.actor, second, "ar", NOW + 1000);
    expect((await submitPurchaseOrder(t.db, managerA.actor, { poId: second, version: await version(second) }, NOW + 1000)).status).toBe("pending_approval");
    // the order page said so before the submission
    expect(view.limitUsedIqd).toBe(800_000);
    const request = (await t.db.select().from(approvals).where(and(eq(approvals.entityType, "purchase_order"), eq(approvals.entityId, second))).get())!;
    expect(request.payload).toMatchObject({ totalIqd: 800_000, windowIqd: 800_000 });
    // another person's own small order to the supplier is still theirs to approve
    const other = await draftOrder(supplierId, [[product.sku, 1, "100000"]], { currency: "IQD", actor: managerB.actor });
    expect((await submitPurchaseOrder(t.db, managerB.actor, { poId: other, version: await version(other) }, NOW + 2000)).status).toBe("approved");
    // a week later the first piece no longer counts
    const later = await draftOrder(supplierId, [[product.sku, 8, "100000"]], { currency: "IQD", expectedOn: "2026-11-30" });
    expect((await submitPurchaseOrder(t.db, managerA.actor, { poId: later, version: await version(later) }, NOW + 8 * DAY)).status).toBe("approved");
  });

  test("an exchange rate typed far below the store's does not bring an order under the limit", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    // 1,000 USD typed at 1 IQD per dollar: 1,000 IQD on paper, well above the limit at the store's rate of the day
    const poId = await draftOrder(supplierId, [[product.sku, 10, "100.00"]], { fxRate: "1" });
    expect((await submitPurchaseOrder(t.db, managerA.actor, { poId, version: await version(poId) }, NOW)).status).toBe("pending_approval");
    const request = (await t.db.select().from(approvals).where(and(eq(approvals.entityType, "purchase_order"), eq(approvals.entityId, poId))).get())!;
    expect(request.payload).toMatchObject({ totalIqd: 1_000 });
    expect(Number((request.payload as { storeRateIqd?: number }).storeRateIqd)).toBeGreaterThan(1_000_000);
    // the approver sees what it weighs at the store's rate
    const view = await getPurchaseOrder(t.db, owner.actor, poId, "ar", NOW);
    expect(view.approvals[0].storeRateIqd).toBeGreaterThan(1_000_000);
  });

  test("a supplier blocked while its order waited is not approved", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await draftOrder(supplierId, [[product.sku, 10, "100.00"]]);
    await submitPurchaseOrder(t.db, managerA.actor, { poId, version: await version(poId) }, NOW);
    await setSupplierStatus(t.db, owner.actor, { supplierId, status: "blocked", reason: "forged delivery notes" }, NOW + 1);
    expect(await code(() => decidePurchaseOrder(t.db, managerB.actor, { poId, decision: "approve" }, NOW + 2))).toBe("supplier_not_active");
    expect(await statusOf(poId)).toBe("pending_approval");
    expect(await decidePurchaseOrder(t.db, managerB.actor, { poId, decision: "reject", note: "supplier blocked" }, NOW + 3)).toMatchObject({ status: "draft" });
  });
});

describe("cancelling an order", () => {
  test("an order with a live supplier invoice (an advance bill) is not cancelled until the invoice is voided", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 3, "20.00"]]);
    // the supplier bills in advance; then cannot deliver
    const { invoiceId } = await recordInvoice(t.db, finance.actor, { poId, invoiceNo: `ADV-${newId("a").slice(-6)}`, lines: [{ poItemId: (await orderLines(poId))[0].id, qty: "3", unitCost: "20.00" }], idempotencyKey: key() }, NOW);
    expect(await code(() => cancelPurchaseOrder(t.db, managerA.actor, { poId, reason: "supplier cannot deliver" }, NOW))).toBe("po_has_invoices");
    expect(await statusOf(poId)).toBe("approved");
    expect((await getPurchaseOrder(t.db, managerA.actor, poId, "ar", NOW)).can).toMatchObject({ cancel: false, cancelBlockedByInvoice: true });
    await voidInvoice(t.db, finance.actor, { invoiceId, reason: "order cancelled, advance refunded" }, NOW);
    expect(await cancelPurchaseOrder(t.db, managerA.actor, { poId, reason: "supplier cannot deliver" }, NOW)).toEqual({ replayed: false });
  });
});

// ───────────────────────────────────────────────────────────────── goods back to the supplier

describe("claims send back only what is in stock", () => {
  test("units refused at inspection never leave stock; a claim tied to a receipt or an order returns at most what it put into stock", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 8, "3.00"]]);
    const receiptId = await receiveAll(poId, { rejected: 3 });
    expect((await level(product.variantId)).onHand).toBe(5);
    // the receipt page's "claim for the refused units" → goods back to the supplier
    const prefill = await claimPrefill(t.db, managerA.actor, { receiptId }, "ar");
    const refused = await createClaim(t.db, managerA.actor, { receiptId, kind: prefill.kind, lines: prefill.lines.map((entry) => ({ code: entry.code, qty: String(entry.qty) })), idempotencyKey: key() }, NOW);
    // sending goods back is a stock action: it says why and how (uxRules: a reason)
    expect(await fieldsOf(() => returnClaimGoods(t.db, managerA.actor, { claimId: refused.claimId, locationId: DEFAULT_LOCATION_ID }, NOW))).toMatchObject({ reason: "required" });
    const result = await returnClaimGoods(t.db, managerA.actor, { claimId: refused.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW);
    expect((await level(product.variantId)).onHand).toBe(5);
    expect(await t.db.select().from(stockMovements).where(and(eq(stockMovements.variantId, product.variantId), eq(stockMovements.kind, "adjust")))).toHaveLength(0);
    expect(result).toMatchObject({ returned: 3, fromStock: 0 });
    const view = await getClaim(t.db, managerA.actor, refused.claimId, "ar", NOW);
    expect(view.returnState).toBe("done");
    expect(view.lines[0]).toMatchObject({ qty: 3, refused: 3, fromStock: 0 });

    // plenty of the SKU in stock from elsewhere: the limit is the documents, not the shelf
    await receiveStock(t.db, owner.actor, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 20, unitCostIqd: 3900, ref: "fixture" }, NOW);
    const tooMany = await createClaim(t.db, managerA.actor, { receiptId, kind: "defect", lines: [{ code: product.sku, qty: "6" }], idempotencyKey: key() }, NOW);
    expect(await code(() => returnClaimGoods(t.db, managerA.actor, { claimId: tooMany.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW))).toBe("return_exceeds_received");
    const orderWide = await createClaim(t.db, managerA.actor, { poId, kind: "return", lines: [{ code: product.sku, qty: "6" }], idempotencyKey: key() }, NOW);
    expect(await code(() => returnClaimGoods(t.db, managerA.actor, { claimId: orderWide.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW))).toBe("return_exceeds_received");
    expect((await level(product.variantId)).onHand).toBe(25);
    // the five accepted units can go back, once
    const accepted = await createClaim(t.db, managerA.actor, { receiptId, kind: "defect", lines: [{ code: product.sku, qty: "5" }], idempotencyKey: key() }, NOW);
    expect(await returnClaimGoods(t.db, managerA.actor, { claimId: accepted.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW)).toMatchObject({ returned: 5, fromStock: 5 });
    expect((await level(product.variantId)).onHand).toBe(20);
    const again = await createClaim(t.db, managerA.actor, { poId, kind: "return", lines: [{ code: product.sku, qty: "1" }], idempotencyKey: key() }, NOW);
    expect(await code(() => returnClaimGoods(t.db, managerA.actor, { claimId: again.claimId, locationId: DEFAULT_LOCATION_ID, reason: "handed to the courier" }, NOW))).toBe("return_exceeds_received");
  });
});

// ───────────────────────────────────────────────────────────────── races

describe("races just before the write batch", () => {
  test("a landed-cost bill spread while the receipt is being posted is carried into the layers and the books", async () => {
    const supplierId = await supplier({ currency: "IQD" });
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 4, "10000"]], { currency: "IQD" });
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "4" }], idempotencyKey: key() }, NOW);
    // the poster has read the receipt; a colleague adds and spreads the freight bill before the posting claims it
    const racing = beforeBatch(t.db, 1, async () => {
      const bill = await addLandedCost(t.db, managerA.actor, { receiptId, kind: "freight", currency: "IQD", amount: "8000", method: "by_qty", reason: "forwarder bill 77", idempotencyKey: key() }, NOW);
      await allocateLandedCost(t.db, managerA.actor, { landedCostId: bill.landedCostId, receiptId }, NOW);
    });
    await postReceipt(racing, clerk.actor, { receiptId }, NOW);
    const layers = await t.d1.prepare("SELECT cl.unit_cost_iqd AS cost FROM cost_layers cl JOIN receipt_items ri ON ri.id = cl.receipt_item_id WHERE ri.receipt_id = ?1").bind(receiptId).all<{ cost: number }>();
    expect(layers.results.map((row) => row.cost)).toEqual([12_000]);
    const journal = await t.d1.prepare("SELECT jl.debit_iqd AS debit FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id WHERE je.idempotency_key = ?1 AND jl.debit_iqd > 0").bind(`receipt:${receiptId}:receipt`).all<{ debit: number }>();
    expect(journal.results.map((row) => row.debit)).toEqual([48_000]);
  });

  test("two receipts drafted at once cannot receive more than was ordered", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 10, "1.00"]]);
    const [line] = await orderLines(poId);
    // a colleague's draft of 6 lands just before this one's write
    const racing = beforeBatch(t.db, 1, () => createReceipt(t.db, managerA.actor, { poId, lines: [{ poItemId: line.id, received: "6" }], idempotencyKey: key() }, NOW));
    const fields = await fieldsOf(() => createReceipt(racing, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "6" }], idempotencyKey: key() }, NOW));
    expect(fields).toMatchObject({ [`lines.${line.id}.received`]: "over_receipt" });
    const drafts = await t.db.select().from(receipts).where(eq(receipts.poId, poId));
    expect(drafts).toHaveLength(1);
    const accepted = await t.db.select({ qty: receiptItems.qtyAccepted }).from(receiptItems).where(eq(receiptItems.receiptId, drafts[0].id));
    expect(accepted.map((row) => row.qty)).toEqual([6]);
  });
});

describe("money shown on a receipt", () => {
  test("someone who sees cost but not the bills still sees the landed cost in the receipt's value, never a zero", async () => {
    const supplierId = await supplier({ currency: "IQD" });
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 2, "10000"]], { currency: "IQD" });
    const [line] = await orderLines(poId);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId, lines: [{ poItemId: line.id, received: "2" }], idempotencyKey: key() }, NOW);
    const bill = await addLandedCost(t.db, managerA.actor, { receiptId, kind: "customs", currency: "IQD", amount: "3000", method: "by_qty", reason: "customs at the border", idempotencyKey: key() }, NOW);
    await allocateLandedCost(t.db, managerA.actor, { landedCostId: bill.landedCostId, receiptId }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    // cost.read ("purchase cost and landed cost") without the landed-cost permissions
    const auditorId = await make.employee({ email: `${make.next("auditor")}@purchasing-review.test` });
    const auditor: EmployeeActor = { kind: "employee", id: auditorId, permissions: new Set(["purchasing.po.read", "cost.read"]), label: "auditor" };
    const view = await getReceipt(t.db, auditor, receiptId, "ar", NOW);
    expect(view.bills).toBeUndefined();
    expect(view.money).toEqual({ goodsIqd: 20_000, landedIqd: 3_000, postedIqd: 23_000 });
  });
});

// ───────────────────────────────────────────────────────────────── the three-way match

describe("the three-way match covers the invoice's charges", () => {
  test("charges billed beyond the order's are a variance a second person accepts; charges within it match", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    const poId = await approvedOrder(supplierId, [[product.sku, 2, "5.00"]]);
    await receiveAll(poId);
    const [line] = await orderLines(poId);
    const billed = await recordInvoice(t.db, finance.actor, { poId, invoiceNo: `INV-${newId("c").slice(-6)}`, other: "150.00", lines: [{ poItemId: line.id, qty: "2", unitCost: "5.00" }], idempotencyKey: key() }, NOW);
    expect(billed).toMatchObject({ status: "mismatch", discrepancies: 1 });
    const detail = await getInvoice(t.db, finance.actor, billed.invoiceId, "ar");
    expect(detail.discrepancies).toEqual([{ variantId: "", field: "charges", po: 0, received: null, invoiced: 15_000 }]);
    expect(detail.can.approveNeedsSecondPerson).toBe(true);
    expect(await code(() => approveInvoice(t.db, finance.actor, { invoiceId: billed.invoiceId, reason: "agreed by phone" }, NOW))).toBe("approver_is_requester");
    expect(await fieldsOf(() => approveInvoice(t.db, managerA.actor, { invoiceId: billed.invoiceId }, NOW))).toMatchObject({ reason: "variance_reason_required" });

    // an order that agreed 20.00 of shipping: billed as 12.00 shipping + 8.00 other, it matches
    const shipped = await approvedOrder(supplierId, [[product.sku, 1, "5.00"]], { shipping: "20.00" });
    await receiveAll(shipped);
    const [shippedLine] = await orderLines(shipped);
    const fair = await recordInvoice(t.db, finance.actor, { poId: shipped, invoiceNo: `INV-${newId("d").slice(-6)}`, shipping: "12.00", other: "8.00", lines: [{ poItemId: shippedLine.id, qty: "1", unitCost: "5.00" }], idempotencyKey: key() }, NOW);
    expect(fair).toMatchObject({ status: "matched", discrepancies: 0 });
    // a second invoice billing the same shipping again is a variance
    const twice = await recordInvoice(t.db, finance.actor, { poId: shipped, invoiceNo: `INV-${newId("e").slice(-6)}`, shipping: "20.00", lines: [], idempotencyKey: key() }, NOW);
    expect(twice).toMatchObject({ status: "mismatch" });
  });
});

// ───────────────────────────────────────────────────────────────── amounts too big

describe("amounts too big for an exact total", () => {
  test("are field errors on orders, invoices and quotes, never a crash", async () => {
    const supplierId = await supplier({ currency: "IQD" });
    const product = await make.product();
    const huge = "9000000000000000";
    expect(await fieldsOf(() => savePurchaseOrder(t.db, managerA.actor, { ...orderInput(supplierId, [[product.sku, 2, huge]], { currency: "IQD" }), idempotencyKey: key() }, NOW))).toMatchObject({ lines: "too_big" });
    const poId = await approvedOrder(supplierId, [[product.sku, 2, "1000"]], { currency: "IQD" });
    const [line] = await orderLines(poId);
    expect(await fieldsOf(() => recordInvoice(t.db, finance.actor, { poId, invoiceNo: `INV-${newId("h").slice(-6)}`, lines: [{ poItemId: line.id, qty: "2", unitCost: huge }], idempotencyKey: key() }, NOW))).toMatchObject({ lines: "too_big" });
    const { rfqId } = await createRfq(t.db, managerA.actor, { title: "Big request", lines: [{ code: product.sku, qty: "10" }], idempotencyKey: key() }, NOW);
    const [item] = (await getRfq(t.db, managerA.actor, rfqId, "ar", NOW)).items;
    expect(await fieldsOf(() => recordQuote(t.db, managerA.actor, { rfqId, supplierId, currency: "IQD", lines: [{ rfqItemId: item.id, unitCost: huge }] }, NOW))).toMatchObject({ lines: "too_big" });
  });
});

// ───────────────────────────────────────────────────────────────── the rating

describe("the supplier rating", () => {
  test("units of an order closed short after its day count against on-time delivery", async () => {
    const supplierId = await supplier();
    const product = await make.product();
    for (let index = 0; index < 2; index++) {
      const poId = await approvedOrder(supplierId, [[product.sku, 10, "1.00"]], { expectedOn: "2026-11-10" });
      await receiveAll(poId);
    }
    const short = await approvedOrder(supplierId, [[product.sku, 10, "1.00"]], { expectedOn: "2026-11-10" });
    const [line] = await orderLines(short);
    const { receiptId } = await createReceipt(t.db, clerk.actor, { poId: short, lines: [{ poItemId: line.id, received: "1" }], idempotencyKey: key() }, NOW);
    await postReceipt(t.db, clerk.actor, { receiptId }, NOW);
    // the other nine never come; two days after the expected day the order is closed short
    await closePurchaseOrder(t.db, managerA.actor, { poId: short, reason: "supplier stopped answering" }, NOW + 2 * DAY);
    const rating = (await supplierRatings(t.db, [supplierId], NOW + 3 * DAY)).get(supplierId)!;
    expect(rating.onTimeRate).toBeCloseTo(21 / 30);
    expect(rating).toMatchObject({ receipts: 3, unitsReceived: 21, unitsOnTime: 21, unitsLate: 0, unitsOverdue: 0, unitsShortClosed: 9 });
  });
});
