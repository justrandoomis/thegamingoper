/**
 * Admin module 09 "purchasing" — module follow-up (2026-11-12). The test failed on the code before the follow-up:
 *
 *   · the "invoice mismatches" count (the bell, the purchasing home) included the invoices the employee recorded
 *     themselves, whose variances only someone else may accept (approveInvoice: approver_is_requester) — the bell
 *     asked them for a decision they cannot take
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, poItems, purchaseOrders } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { purchasingQueueCounts } from "~/server/services/admin/purchasing/alerts.server";
import { approveInvoice, listInvoices, parseInvoiceFilters, recordInvoice } from "~/server/services/admin/purchasing/invoices.server";
import { decidePurchaseOrder, savePurchaseOrder, submitPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { createReceipt, postReceipt } from "~/server/services/admin/purchasing/receipts.server";
import { createSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;
const staff: Record<string, EmployeeActor> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const [name, role] of [["managerA", "manager"], ["managerB", "manager"], ["clerk", "inventory"], ["financeA", "finance"], ["financeB", "finance"]] as const) staff[name] = await employee(role);
}, 60_000);
afterAll(async () => {
  await t?.dispose();
});

async function employee(role: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ email: `${make.next(role)}@purchasing-followup.test`, name: `${role} follow-up` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { kind: "employee", id, permissions: defaultRolePermissions(role), label: role };
}
const key = () => `k_${newId("idem").slice(4)}`;

/** An approved, fully received order of one SKU (2 × 5.00 USD at 1300). */
async function receivedOrder(): Promise<{ poId: string; lineId: string }> {
  const code = make.next("SUP").toUpperCase();
  const { supplierId } = await createSupplier(t.db, staff.managerA, { code, name: `Supplier ${code}`, currency: "USD", leadTimeDays: "10", paymentTerms: "net 30" }, NOW);
  const product = await make.product();
  const { poId } = await savePurchaseOrder(t.db, staff.managerA, { supplierId, locationId: DEFAULT_LOCATION_ID, currency: "USD", fxRate: "1300", expectedOn: "2026-11-15", lines: [{ code: product.sku, qty: "2", unitCost: "5.00" }], idempotencyKey: key() }, NOW);
  const version = (await t.db.select({ updatedAt: purchaseOrders.updatedAt }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.updatedAt;
  const submitted = await submitPurchaseOrder(t.db, staff.managerA, { poId, version }, NOW);
  if (submitted.status === "pending_approval") await decidePurchaseOrder(t.db, staff.managerB, { poId, decision: "approve" }, NOW);
  const [line] = await t.db.select().from(poItems).where(eq(poItems.poId, poId));
  const { receiptId } = await createReceipt(t.db, staff.clerk, { poId, lines: [{ poItemId: line.id, received: String(line.qtyOrdered) }], idempotencyKey: key() }, NOW);
  await postReceipt(t.db, staff.clerk, { receiptId }, NOW);
  return { poId, lineId: line.id };
}

describe("admin 09 purchasing — follow-up", () => {
  test("the mismatch count never asks the invoice's recorder: only someone else may accept its variances", async () => {
    const before = { a: (await purchasingQueueCounts(t.db, staff.financeA, NOW)).mismatch, b: (await purchasingQueueCounts(t.db, staff.financeB, NOW)).mismatch };
    const { poId, lineId } = await receivedOrder();
    // billed at 6.00 instead of 5.00: a variance
    const billed = await recordInvoice(t.db, staff.financeA, { poId, invoiceNo: `INV-${newId("f").slice(-6)}`, lines: [{ poItemId: lineId, qty: "2", unitCost: "6.00" }], idempotencyKey: key() }, NOW);
    expect(billed.status).toBe("mismatch");
    // the recorder cannot accept it …
    const refused = await approveInvoice(t.db, staff.financeA, { invoiceId: billed.invoiceId, reason: "agreed by phone" }, NOW).catch((error: unknown) => toAppError(error)?.code);
    expect(refused).toBe("approver_is_requester");
    // … so it is not in their count; it is in everyone else's
    expect((await purchasingQueueCounts(t.db, staff.financeA, NOW)).mismatch).toBe(before.a);
    expect((await purchasingQueueCounts(t.db, staff.financeB, NOW)).mismatch).toBe((before.b ?? 0) + 1);
  });

  test("review 2026-11-12: the card's count is the list it opens — ?status=to_accept holds the mismatches this person may accept", async () => {
    const { poId, lineId } = await receivedOrder();
    const billed = await recordInvoice(t.db, staff.financeA, { poId, invoiceNo: `INV-${newId("g").slice(-6)}`, lines: [{ poItemId: lineId, qty: "2", unitCost: "7.00" }], idempotencyKey: key() }, NOW);
    expect(billed.status).toBe("mismatch");
    const filters = parseInvoiceFilters(new URLSearchParams("status=to_accept"));
    expect(filters.status).toBe("to_accept");
    for (const who of [staff.financeA, staff.financeB]) {
      const counted = (await purchasingQueueCounts(t.db, who, NOW)).mismatch;
      const listed = await listInvoices(t.db, who, filters);
      expect(listed.total, who.id).toBe(counted);
      expect(listed.counts.to_accept).toBe(counted);
    }
    // the recorder's own mismatch is not in their list; it is in someone else's
    expect((await listInvoices(t.db, staff.financeA, filters)).rows.map((row) => row.id)).not.toContain(billed.invoiceId);
    expect((await listInvoices(t.db, staff.financeB, filters)).rows.map((row) => row.id)).toContain(billed.invoiceId);
  });
});
