/**
 * Admin module 15 "staff" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · whoever wrote a commission plan could approve the payroll run that pays commissions at the rate they set
 *   · storeApprovals ("across the store") and syncCommissions ignored branch limits: an employee limited to one
 *     branch saw every branch's pending requests and the store's payroll runs, and a sync wrote every branch's
 *     commissions
 *   · a branch-limited approver of advances reached /admin/staff/payroll/advances only by typing it: no section, no
 *     card on the module's home (both sat behind the store-wide payroll, a 403 for them)
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { branches, commissions, employeeRoles, employees, orders, rolePermissions, roles } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { storeApprovals } from "~/server/services/admin/staff/approvals.server";
import { saveRuleVersion, syncCommissions } from "~/server/services/admin/staff/commissions.server";
import { setBaseSalary } from "~/server/services/admin/staff/employees.server";
import { staffOverview } from "~/server/services/admin/staff/overview.server";
import { approveRun, getRun, prepareRun, requestAdvance } from "~/server/services/admin/staff/payroll.server";
import { staffAccess } from "~/server/services/admin/staff/shared.server";
import { periodOf } from "~/server/services/admin/staff/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor };
const people: Record<string, Person> = {};
let keyCounter = 0;
const key = () => `followup-key-${String(++keyCounter).padStart(10, "0")}`;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance"] as const) people[role] = await person(role);
  people.owner2 = await person("owner");
  people.owner3 = await person("owner");
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], overrides: Partial<typeof employees.$inferInsert> = {}, branchId: string | null = null): Promise<Person> {
  const id = await make.employee({ name: Array.isArray(role) ? "custom" : role, ...overrides, branchId });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("custom").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom", branchId } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, actor: { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role, branchId } };
}
const code = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return toAppError(error)?.code ?? "unexpected";
  }
  return "no error";
};
async function branch(): Promise<string> {
  const id = newId("brn");
  await t.db.insert(branches).values({ id, code: make.next("BR").toUpperCase(), name: { ar: "فرع", en: "Branch" }, isActive: true, createdAt: NOW });
  return id;
}
/** A delivered POS sale rung up by `sellerId` at `at`. */
async function counterSale(sellerId: string, priceIqd: number, at: number) {
  const product = await make.product({ priceIqd });
  const order = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1, unitPriceIqd: priceIqd }], { channel: "pos", status: "delivered", deliveredAt: at, placedAt: at, cashierId: sellerId, shippingIqd: 0, discountIqd: 0, isDemo: true });
  await t.db.update(orders).set({ paidIqd: order.totalIqd, paymentStatus: "paid" }).where(eq(orders.id, order.orderId));
  return order;
}

describe("admin 15 staff — follow-up", () => {
  test("a commission plan's author never approves the run that pays under it", async () => {
    // September 2026, a month of its own
    const at = Date.UTC(2026, 8, 30, 9, 0, 0);
    const september = periodOf(at - DAY);
    const seller = await person("cashier", { isDemo: true, createdAt: Date.UTC(2026, 0, 1) });
    await setBaseSalary(t.db, people.finance.actor, { employeeId: seller.id, baseSalaryIqd: 800_000, expectedIqd: null, reason: "راتب" }, at - 25 * DAY);
    // owner2 writes the plan; finance prepares the run
    await saveRuleVersion(t.db, people.owner2.actor, { name: "عمولة أيلول", basis: "sales", rateBps: 500, scope: "employee", employeeId: seller.id, reason: "خطة" }, Date.UTC(2026, 7, 1));
    await counterSale(seller.id, 400_000, Date.UTC(2026, 8, 20, 10));
    const prepared = await prepareRun(t.db, people.finance.actor, { period: september, demo: true, idempotencyKey: key() }, at);
    const detail = await getRun(t.db, people.owner2.actor, prepared.runId, at);
    expect(detail.items.find((item) => item.employee.id === seller.id)?.commissionIqd).toBe(20_000);
    expect(detail.involved.me).toBe(true);
    expect(detail.can.approve).toBe(false);
    expect(await code(() => approveRun(t.db, people.owner2.actor, { runId: prepared.runId, expectedNetIqd: detail.totals.netIqd, expectedItems: detail.items.length }, at))).toBe("run_self_approval");
    // someone who took no part approves
    expect(await approveRun(t.db, people.owner3.actor, { runId: prepared.runId, expectedNetIqd: detail.totals.netIqd, expectedItems: detail.items.length }, at)).toEqual({ status: "approved" });
  });

  test("a branch-limited employee: their branch's requests, their branch's commissions, and their branch's advances in the navigation", async () => {
    const north = await branch();
    const south = await branch();
    const northStaff = await person("cashier", { isDemo: true }, north);
    const southStaff = await person("cashier", { isDemo: true }, south);
    // an approver of advances and reader of approvals, limited to the north branch
    const limited = await person(["staff.approval.read", "staff.payroll.read", "staff.payroll.approve", "staff.commission.manage", "staff.employee.read"], {}, north);

    // advances asked (by HQ finance) for one employee of each branch
    await requestAdvance(t.db, people.finance.actor, { employeeId: northStaff.id, amountIqd: 50_000, paidFrom: "cash", reason: "سلفة الشمال", idempotencyKey: key() }, NOW);
    await requestAdvance(t.db, people.finance.actor, { employeeId: southStaff.id, amountIqd: 60_000, paidFrom: "cash", reason: "سلفة الجنوب", idempotencyKey: key() }, NOW);
    const mine = await storeApprovals(t.db, limited.actor, "ar");
    const all = await storeApprovals(t.db, people.owner.actor, "ar");
    expect(mine.rows.length).toBe(all.rows.length - 1);
    expect(mine.runsAwaiting).toBe(0);
    expect(all.rows.length).toBeGreaterThanOrEqual(2);

    // the navigation and the home: the branch's advances, never the store-wide payroll
    expect(staffAccess(limited.actor)).toMatchObject({ payrollView: false, advancesView: true });
    expect(staffAccess(people.owner.actor)).toMatchObject({ payrollView: true, advancesView: false });
    expect((await staffOverview(t.db, limited.actor, NOW)).payroll?.advancesPending).toBe(1);

    // a sync from the north branch writes the north branch's commissions only
    for (const seller of [northStaff, southStaff]) await saveRuleVersion(t.db, people.owner.actor, { name: "عمولة الفرع", basis: "sales", rateBps: 300, scope: "employee", employeeId: seller.id, reason: "خطة" }, NOW - 20 * DAY);
    await counterSale(northStaff.id, 100_000, NOW - 2 * DAY);
    await counterSale(southStaff.id, 100_000, NOW - 2 * DAY);
    await syncCommissions(t.db, limited.actor, { period: periodOf(NOW) }, NOW);
    expect(await t.db.select().from(commissions).where(eq(commissions.employeeId, northStaff.id))).toHaveLength(1);
    expect(await t.db.select().from(commissions).where(eq(commissions.employeeId, southStaff.id))).toHaveLength(0);
    // the whole store's sync then writes the other branch's
    await syncCommissions(t.db, people.owner.actor, { period: periodOf(NOW) }, NOW);
    expect(await t.db.select().from(commissions).where(eq(commissions.employeeId, southStaff.id))).toHaveLength(1);
  });
});
