/**
 * Admin module 15 "staff" — money: the payroll postings (app/server/services/accounting/payroll.server.ts, a
 * commerce-core file), commissions (15.03) and payroll runs and advances (15.04), against a real local D1:
 *
 *   · the core builders: balanced lines, a net clawback on the credit side, inconsistent totals refused before the
 *     database, one posting per key
 *   · commission plans are versioned and a profit plan needs profit.read; a sale is paid by the version in force when
 *     it was delivered; computing twice writes nothing; a return lands as a clawback; a profit plan pays on realised
 *     profit and counts a line of unknown cost as uncosted; web orders (no seller) and demo orders of real staff earn
 *     nothing; the base and rate of a profit row are absent without profit.read
 *   · payroll: the base pro-rated by days employed and unpaid leave, commissions and advances counted once (two runs
 *     can never share them), the preparer — or whoever edited the run or changed a salary in it — never approves it,
 *     the approver approves what they saw, paying posts Dr payroll / Dr commissions / Cr cash in the same batch as
 *     the status change, a replayed payment does not post twice, a void frees the commissions and advances
 *   · advances: never decided by the requester or the employee it is for; approving posts Dr payroll / Cr cash
 *   · salaries: never one's own, a stale form refused, absent from the profile without payroll permissions
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { commissions, employeeAdvances, employeeRoles, employees, journalEntries, journalLines, leaveRequests, orderItems, orders, payrollItems, payrollRuns, refundItems, refunds, rolePermissions, roles } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { advancePostingKey, PayrollPostingError, payrollRunLines, payrollRunPostingKey, postEmployeeAdvance, postPayrollRun } from "~/server/services/accounting/payroll.server";
import { mapPostingError } from "~/server/services/accounting/post.server";
import { commissionLedger, commissionOf, listPlans, profitBaseOf, salesBaseOf, saveRuleVersion, syncCommissions, endPlan } from "~/server/services/admin/staff/commissions.server";
import { staffDecisions } from "~/server/services/admin/staff/approvals.server";
import { getEmployeeProfile, setBaseSalary } from "~/server/services/admin/staff/employees.server";
import { approveRun, decideAdvance, deferAdvance, getRun, listAdvances, payRun, prepareRun, recomputeRun, requestAdvance, updateItem, voidRun, withdrawAdvance } from "~/server/services/admin/staff/payroll.server";
import { dayStart, periodOf } from "~/server/services/admin/staff/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW; // 10 Nov 2026, 09:00 Baghdad
const DAY = 24 * 60 * 60 * 1000;
const PERIOD = periodOf(NOW);

let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor };
const people: Record<string, Person> = {};
let keyCounter = 0;
const key = () => `test-key-${String(++keyCounter).padStart(10, "0")}`;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "cashier"] as const) people[role] = await person(role);
  people.owner2 = await person("owner");
  // a commission administrator without profit.read, and a payroll reader who sees pay but not profit
  people.commissionClerk = await person(["staff.commission.manage", "staff.payroll.read"]);
  people.directoryOnly = await person(["staff.employee.read"]);
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], overrides: Partial<typeof employees.$inferInsert> = {}): Promise<Person> {
  const id = await make.employee({ name: Array.isArray(role) ? "custom" : role, ...overrides });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("custom").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, actor: { kind: "employee", id, permissions, label: role } };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.code ?? "unexpected";

/** A counter sale (POS, delivered) rung up by `sellerId`: one line per entry, optional unit cost [P]. */
async function counterSale(sellerId: string, lines: { priceIqd: number; qty?: number; costIqd?: number | null }[], options: { at?: number; discountIqd?: number; isDemo?: boolean; channel?: "pos" | "web" } = {}) {
  const made = [];
  for (const line of lines) made.push({ ...(await make.product({ priceIqd: line.priceIqd })), qty: line.qty ?? 1, costIqd: line.costIqd });
  const at = options.at ?? NOW - 2 * DAY;
  const order = await make.order(
    made.map((line) => ({ variantId: line.variantId, sku: line.sku, qty: line.qty, unitPriceIqd: line.priceIqd })),
    { channel: options.channel ?? "pos", status: "delivered", deliveredAt: at, placedAt: at, cashierId: options.channel === "web" ? null : sellerId, shippingIqd: 0, discountIqd: options.discountIqd ?? 0, isDemo: options.isDemo ?? false },
  );
  await t.db.update(orders).set({ paidIqd: order.totalIqd, paymentStatus: "paid" }).where(eq(orders.id, order.orderId));
  for (const [index, line] of made.entries()) {
    if (line.costIqd !== undefined) await t.db.update(orderItems).set({ costSnapshotIqd: line.costIqd }).where(eq(orderItems.id, order.itemIds[index]));
  }
  return order;
}

/** A refund paid for `qty` units of an order line (what the core's refund issue leaves behind). */
async function refundUnits(orderId: string, orderItemId: string, qty: number, amountIqd: number, at: number) {
  const paymentId = await make.payment(orderId, amountIqd * 10, { method: "pos_cash", status: "paid" });
  const refundId = newId("rfd");
  await runBatch(t.db, [
    t.db.insert(refunds).values({ id: refundId, orderId, paymentId, amountIqd, method: "cash", status: "paid", createdAt: at, paidAt: at, approvedAt: at }),
    t.db.insert(refundItems).values({ refundId, orderItemId, qty }),
    t.db.update(orderItems).set({ refundedQty: sql`${orderItems.refundedQty} + ${qty}` }).where(eq(orderItems.id, orderItemId)),
    t.db.update(orders).set({ refundedIqd: sql`${orders.refundedIqd} + ${amountIqd}` }).where(eq(orders.id, orderId)),
  ]);
}

async function linesOf(entryId: string) {
  const rows = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entryId));
  const by = (account: string) => rows.filter((row) => row.accountId === accountId(account as never));
  return {
    rows,
    debit: (account: string) => by(account).reduce((sum, row) => sum + (row.debitIqd ?? 0), 0),
    credit: (account: string) => by(account).reduce((sum, row) => sum + (row.creditIqd ?? 0), 0),
  };
}

// ───────────────────────────────────────────────────────────────── the core builders

describe("payroll postings (accounting/payroll.server.ts)", () => {
  test("a run's lines balance; a net clawback goes to the credit side; inconsistent totals are refused before the database", () => {
    const lines = payrollRunLines({ baseIqd: 1_000_000, bonusIqd: 50_000, commissionIqd: 30_000, advanceDeductionIqd: 200_000, otherDeductionIqd: 10_000, netIqd: 870_000 }, "cash");
    expect(lines).toEqual([
      { accountCode: "payroll", debitIqd: 840_000 },
      { accountCode: "commissions", debitIqd: 30_000 },
      { accountCode: "cash", creditIqd: 870_000 },
    ]);
    const clawback = payrollRunLines({ baseIqd: 500_000, bonusIqd: 0, commissionIqd: -20_000, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 480_000 }, "bank_clearing");
    expect(clawback).toEqual([
      { accountCode: "payroll", debitIqd: 500_000 },
      { accountCode: "commissions", creditIqd: 20_000 },
      { accountCode: "bank_clearing", creditIqd: 480_000 },
    ]);
    expect(() => payrollRunLines({ baseIqd: 100, bonusIqd: 0, commissionIqd: 0, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 99 }, "cash")).toThrow(PayrollPostingError);
    expect(() => payrollRunLines({ baseIqd: 100.5, bonusIqd: 0, commissionIqd: 0, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 100.5 }, "cash")).toThrow(PayrollPostingError);
    expect(() => payrollRunLines({ baseIqd: -1, bonusIqd: 0, commissionIqd: 1, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 0 }, "cash")).toThrow(PayrollPostingError);
    expect(() => payrollRunLines({ baseIqd: 1, bonusIqd: 0, commissionIqd: 0, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 1 }, "wallet_liability" as never)).toThrow(PayrollPostingError);
  });

  test("postings are one per business event: the same run or advance cannot be booked twice", async () => {
    const runId = `pyr_${"a".repeat(26)}`;
    const totals = { baseIqd: 300_000, bonusIqd: 0, commissionIqd: 0, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 300_000 };
    await runBatch(t.db, postPayrollRun(t.db, { runId, ref: "PR-TEST", period: PERIOD, paidFrom: "cash", totals, at: NOW, createdBy: people.owner.id, isDemo: false }));
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, payrollRunPostingKey(runId))).get();
    expect(entry?.refType).toBe("payroll_run");
    const twice = await thrown(() => runBatch(t.db, postPayrollRun(t.db, { runId, ref: "PR-TEST", period: PERIOD, paidFrom: "cash", totals, at: NOW, createdBy: people.owner.id, isDemo: false })));
    expect(mapPostingError(twice)?.code).toBe("already_posted");
    const advanceId = `adv_${"b".repeat(26)}`;
    await runBatch(t.db, postEmployeeAdvance(t.db, { advanceId, amountIqd: 100_000, paidFrom: "cash", at: NOW, createdBy: people.owner.id, isDemo: false }));
    const advance = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, advancePostingKey(advanceId))).get();
    const lines = await linesOf(advance!.id);
    expect(lines.debit("payroll")).toBe(100_000);
    expect(lines.credit("cash")).toBe(100_000);
    expect(() => postEmployeeAdvance(t.db, { advanceId, amountIqd: 0, paidFrom: "cash", at: NOW, createdBy: null, isDemo: false })).toThrow(PayrollPostingError);
    // an all-zero run writes nothing
    expect(postPayrollRun(t.db, { runId: `pyr_${"c".repeat(26)}`, ref: "PR-ZERO", period: PERIOD, paidFrom: "cash", totals: { baseIqd: 0, bonusIqd: 0, commissionIqd: 0, advanceDeductionIqd: 0, otherDeductionIqd: 0, netIqd: 0 }, at: NOW, createdBy: null, isDemo: false })).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── commissions

describe("commissions (15.03)", () => {
  test("the base: discount share, returned units and refunds without items come off; profit needs a known cost", () => {
    const line = { orderItemId: "x", orderId: "o", orderRef: "R", channel: "pos", sellerId: "s", at: NOW, kind: "game", categoryId: null, qty: 4, refundedQty: 1, totalIqd: 400_000, discountShareIqd: 40_000, amountRefundShareIqd: 10_000, unitCostIqd: 50_000 };
    expect(salesBaseOf(line)).toBe(260_000); // (400k − 40k) × 3/4 − 10k
    expect(profitBaseOf(line)).toBe(110_000); // 260k − 3 × 50k
    expect(profitBaseOf({ ...line, unitCostIqd: null })).toBeNull();
    expect(commissionOf(260_000, 250)).toBe(6_500);
    expect(commissionOf(-5, 250)).toBe(0);
    expect(salesBaseOf({ ...line, refundedQty: 4 })).toBe(0);
  });

  test("plans are versioned; a profit plan needs profit.read; the version in force at delivery pays", async () => {
    const seller = await person("cashier");
    expect(await code(() => saveRuleVersion(t.db, people.commissionClerk.actor, { name: "ربح البائع", basis: "profit", rateBps: 500, scope: "employee", employeeId: seller.id, reason: "خطة تجربة" }, NOW))).toBe("profit_basis_needs_permission");
    expect(await code(() => saveRuleVersion(t.db, people.cashier.actor, { name: "خطة", basis: "sales", rateBps: 100, scope: "everyone", reason: "خطة تجربة" }, NOW))).toBe("forbidden");
    const first = await saveRuleVersion(t.db, people.commissionClerk.actor, { name: "مبيعات البائع", basis: "sales", rateBps: 200, scope: "employee", employeeId: seller.id, reason: "خطة تجربة" }, NOW - 10 * DAY);
    expect(first.version).toBe(1);
    const second = await saveRuleVersion(t.db, people.commissionClerk.actor, { planId: first.planId, name: "مبيعات البائع", basis: "sales", rateBps: 300, scope: "employee", employeeId: seller.id, reason: "رفع النسبة" }, NOW - 3 * DAY);
    expect(second).toMatchObject({ planId: first.planId, version: 2, ruleId: `${first.planId}.v2` });
    // a sale delivered under v1 and one under v2
    const early = await counterSale(seller.id, [{ priceIqd: 100_000 }], { at: NOW - 5 * DAY });
    const late = await counterSale(seller.id, [{ priceIqd: 100_000 }], { at: NOW - 1 * DAY });
    const result = await syncCommissions(t.db, people.finance.actor, { period: PERIOD }, NOW);
    expect(result.earned).toBeGreaterThanOrEqual(2);
    const rows = await t.db.select().from(commissions).where(eq(commissions.employeeId, seller.id));
    expect(rows.find((row) => row.orderId === early.orderId)?.amountIqd).toBe(2_000);
    expect(rows.find((row) => row.orderId === late.orderId)?.amountIqd).toBe(3_000);
    expect(rows.find((row) => row.orderId === late.orderId)?.ruleId).toBe(second.ruleId);
    // computing again writes nothing
    const again = await syncCommissions(t.db, people.finance.actor, { period: PERIOD }, NOW);
    expect(again.earned + again.clawbacks).toBe(0);
    // the plan list shows both versions, the newest first
    const plans = await listPlans(t.db, people.finance.actor, "ar", NOW);
    const plan = plans.plans.find((item) => item.planId === first.planId)!;
    expect(plan.versions.map((version) => version.version)).toEqual([2, 1]);
    expect(plan.current.rateBps).toBe(300);
    // ending the plan: no later sale earns
    await endPlan(t.db, people.commissionClerk.actor, { planId: first.planId, reason: "انتهت الخطة" }, NOW - DAY / 2);
    expect(await code(() => endPlan(t.db, people.commissionClerk.actor, { planId: first.planId, reason: "مرة ثانية" }, NOW))).toBe("rule_ended");
  });

  test("a return that lands later is clawed back; web orders and a real seller's demo orders earn nothing", async () => {
    const seller = await person("cashier");
    await saveRuleVersion(t.db, people.manager.actor, { name: "عمولة الكاشير", basis: "sales", rateBps: 1_000, scope: "employee", employeeId: seller.id, reason: "خطة تجربة" }, NOW - 20 * DAY);
    const sale = await counterSale(seller.id, [{ priceIqd: 50_000, qty: 2 }], { at: NOW - 4 * DAY });
    await counterSale(seller.id, [{ priceIqd: 70_000 }], { at: NOW - 4 * DAY, channel: "web" });
    await counterSale(seller.id, [{ priceIqd: 90_000 }], { at: NOW - 4 * DAY, isDemo: true });
    await syncCommissions(t.db, people.finance.actor, { period: PERIOD }, NOW - 3 * DAY);
    let rows = await t.db.select().from(commissions).where(eq(commissions.employeeId, seller.id));
    expect(rows.map((row) => [row.kind, row.amountIqd])).toEqual([["earn", 10_000]]);
    // one unit comes back and is refunded two days later
    await refundUnits(sale.orderId, sale.itemIds[0], 1, 50_000, NOW - 2 * DAY);
    const result = await syncCommissions(t.db, people.finance.actor, { period: PERIOD }, NOW - DAY);
    expect(result.clawbacks).toBe(1);
    rows = await t.db.select().from(commissions).where(eq(commissions.employeeId, seller.id));
    expect(rows.map((row) => [row.kind, row.amountIqd]).sort()).toEqual([
      ["clawback", -5_000],
      ["earn", 10_000],
    ]);
    expect(rows.find((row) => row.kind === "clawback")?.id).toBe(`com_${sale.itemIds[0]}_2`);
  });

  test("a profit plan pays on realised profit, counts unknown costs, and hides its base and rate without profit.read", async () => {
    const seller = await person("cashier");
    await saveRuleVersion(t.db, people.manager.actor, { name: "ربح الكاشير", basis: "profit", rateBps: 1_000, scope: "employee", employeeId: seller.id, reason: "خطة تجربة" }, NOW - 20 * DAY);
    await counterSale(seller.id, [{ priceIqd: 200_000, costIqd: 150_000 }, { priceIqd: 80_000, costIqd: null }], { at: NOW - 3 * DAY });
    const result = await syncCommissions(t.db, people.manager.actor, { period: PERIOD }, NOW);
    expect(result.uncosted).toBeGreaterThanOrEqual(1);
    const rows = await t.db.select().from(commissions).where(eq(commissions.employeeId, seller.id));
    expect(rows.map((row) => row.amountIqd)).toEqual([5_000]); // 10 % of 50,000 realised profit
    const hidden = await commissionLedger(t.db, people.commissionClerk.actor, { period: PERIOD, employee: seller.id, page: 1 });
    expect(hidden.lines[0]).toMatchObject({ basis: "profit", baseIqd: null, rateBps: null, amountIqd: 5_000 });
    const shown = await commissionLedger(t.db, people.manager.actor, { period: PERIOD, employee: seller.id, page: 1 });
    expect(shown.lines[0]).toMatchObject({ baseIqd: 50_000, rateBps: 1_000 });
    // the plan's rate is absent for the same clerk
    const plans = await listPlans(t.db, people.commissionClerk.actor, "ar", NOW);
    expect(plans.plans.find((plan) => plan.current.basis === "profit")?.current.rateBps).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── salaries

describe("salaries", () => {
  test("never one's own; a stale form is refused; absent from the profile without payroll permissions", async () => {
    const target = await person("cashier");
    expect(await code(() => setBaseSalary(t.db, people.finance.actor, { employeeId: people.finance.id, baseSalaryIqd: 2_000_000, expectedIqd: null, reason: "زيادة" }, NOW))).toBe("salary_self_change");
    expect(await code(() => setBaseSalary(t.db, people.cashier.actor, { employeeId: target.id, baseSalaryIqd: 2_000_000, expectedIqd: null, reason: "زيادة" }, NOW))).toBe("forbidden");
    await setBaseSalary(t.db, people.finance.actor, { employeeId: target.id, baseSalaryIqd: 900_000, expectedIqd: null, reason: "راتب البداية" }, NOW);
    expect(await code(() => setBaseSalary(t.db, people.finance.actor, { employeeId: target.id, baseSalaryIqd: 950_000, expectedIqd: null, reason: "زيادة" }, NOW))).toBe("employee_changed");
    expect(await code(() => setBaseSalary(t.db, people.finance.actor, { employeeId: target.id, baseSalaryIqd: Number.NaN, expectedIqd: 900_000, reason: "زيادة" }, NOW))).toBe("invalid");
    const withPay = await getEmployeeProfile(t.db, people.finance.actor, target.id, "ar", NOW);
    expect(withPay.salary?.baseSalaryIqd).toBe(900_000);
    const without = await getEmployeeProfile(t.db, people.directoryOnly.actor, target.id, "ar", NOW);
    expect(without.salary).toBeNull();
    expect(JSON.stringify(without)).not.toContain("900000");
  });
});

// ───────────────────────────────────────────────────────────────── payroll runs

describe("payroll runs (15.04)", () => {
  test("prepare, two people, pay through the books, and nothing counted twice", async () => {
    // a fresh month so earlier tests' rows stay out of it: October 2026
    const at = Date.UTC(2026, 9, 31, 9, 0, 0);
    const october = periodOf(at - DAY);
    const full = await person("cashier", { isDemo: true, createdAt: Date.UTC(2026, 0, 1) });
    const half = await person("cashier", { isDemo: true, createdAt: dayStart(`${october}-16`) });
    await setBaseSalary(t.db, people.finance.actor, { employeeId: full.id, baseSalaryIqd: 1_000_000, expectedIqd: null, reason: "راتب" }, at - 20 * DAY);
    await setBaseSalary(t.db, people.finance.actor, { employeeId: half.id, baseSalaryIqd: 930_000, expectedIqd: null, reason: "راتب" }, at - 20 * DAY);
    // two unpaid leave days for `full`, a commission for `full`
    await t.db.insert(leaveRequests).values({ id: newId("lvr"), employeeId: full.id, kind: "unpaid", startsOn: `${october}-05`, endsOn: `${october}-06`, status: "approved", createdAt: at - 30 * DAY });
    await saveRuleVersion(t.db, people.manager.actor, { name: "عمولة أكتوبر", basis: "sales", rateBps: 500, scope: "employee", employeeId: full.id, reason: "خطة" }, Date.UTC(2026, 8, 1));
    await counterSale(full.id, [{ priceIqd: 400_000 }], { at: dayStart(`${october}-20`) + 3_600_000, isDemo: true });
    // an advance asked by finance, decided by the owner
    const asked = await requestAdvance(t.db, people.finance.actor, { employeeId: full.id, amountIqd: 150_000, paidFrom: "cash", reason: "سلفة طارئة", idempotencyKey: key() }, at - 10 * DAY);
    expect(await code(() => decideAdvance(t.db, people.finance.actor, { approvalId: asked.approvalId, decision: "approve" }, at - 9 * DAY))).toBe("forbidden");
    const fullAdmin = await person("owner", { isDemo: true });
    expect(await code(() => decideAdvance(t.db, { ...people.owner.actor, id: full.id }, { approvalId: asked.approvalId, decision: "approve" }, at - 9 * DAY))).toBe("advance_beneficiary");
    const given = await decideAdvance(t.db, fullAdmin.actor, { approvalId: asked.approvalId, decision: "approve", note: "موافق" }, at - 9 * DAY);
    expect(given.status).toBe("approved");
    const advanceLines = await linesOf(given.journalEntryId!);
    expect(advanceLines.debit("payroll")).toBe(150_000);
    expect(advanceLines.credit("cash")).toBe(150_000);

    const prepareKey = key();
    const prepared = await prepareRun(t.db, people.finance.actor, { period: october, demo: true, idempotencyKey: prepareKey }, at);
    const replay = await prepareRun(t.db, people.finance.actor, { period: october, demo: true, idempotencyKey: prepareKey }, at);
    expect(replay).toMatchObject({ runId: prepared.runId, replayed: true });
    expect(await code(() => prepareRun(t.db, people.manager.actor, { period: october, demo: true, idempotencyKey: key() }, at))).toBe("run_open_exists");
    const detail = await getRun(t.db, people.finance.actor, prepared.runId, at);
    const fullItem = detail.items.find((item) => item.employee.id === full.id)!;
    const halfItem = detail.items.find((item) => item.employee.id === half.id)!;
    expect(fullItem).toMatchObject({ baseIqd: Math.floor((1_000_000 * 29) / 31), commissionIqd: 20_000, advanceDeductionIqd: 150_000 });
    expect(fullItem.netIqd).toBe(fullItem.baseIqd + 20_000 - 150_000);
    expect(halfItem.baseIqd).toBe(Math.floor((930_000 * 16) / 31));
    expect(detail.run.isDemo).toBe(true);

    // a bonus needs a note; a deduction never takes the pay below zero
    expect(await code(() => updateItem(t.db, people.finance.actor, { runId: prepared.runId, employeeId: half.id, bonusIqd: 25_000, otherDeductionIqd: 0, expectedNetIqd: halfItem.netIqd }, at))).toBe("invalid");
    expect(await code(() => updateItem(t.db, people.finance.actor, { runId: prepared.runId, employeeId: half.id, bonusIqd: 0, otherDeductionIqd: 10_000_000, notes: "خصم", expectedNetIqd: halfItem.netIqd }, at))).toBe("invalid");
    await updateItem(t.db, people.manager.actor, { runId: prepared.runId, employeeId: half.id, bonusIqd: 25_000, otherDeductionIqd: 0, notes: "مكافأة الجرد", expectedNetIqd: halfItem.netIqd }, at);

    // the preparer and the editor never approve; the approver approves what they saw
    const after = await getRun(t.db, people.owner.actor, prepared.runId, at);
    expect(await code(() => approveRun(t.db, people.finance.actor, { runId: prepared.runId, expectedNetIqd: after.totals.netIqd, expectedItems: after.items.length }, at))).toBe("forbidden");
    const financeApprover = { ...people.finance.actor, permissions: new Set<string>([...people.finance.actor.permissions, "staff.payroll.approve"]) };
    expect(await code(() => approveRun(t.db, financeApprover, { runId: prepared.runId, expectedNetIqd: after.totals.netIqd, expectedItems: after.items.length }, at))).toBe("run_self_approval");
    const managerApprover = { ...people.manager.actor, permissions: new Set<string>([...people.manager.actor.permissions, "staff.payroll.approve"]) };
    expect(await code(() => approveRun(t.db, managerApprover, { runId: prepared.runId, expectedNetIqd: after.totals.netIqd, expectedItems: after.items.length }, at))).toBe("run_self_approval");
    expect(await code(() => approveRun(t.db, people.owner.actor, { runId: prepared.runId, expectedNetIqd: after.totals.netIqd + 1, expectedItems: after.items.length }, at))).toBe("run_changed");
    await approveRun(t.db, people.owner.actor, { runId: prepared.runId, expectedNetIqd: after.totals.netIqd, expectedItems: after.items.length }, at);
    expect(await code(() => updateItem(t.db, people.finance.actor, { runId: prepared.runId, employeeId: half.id, bonusIqd: 0, otherDeductionIqd: 0, expectedNetIqd: 0 }, at))).toBe("run_not_draft");

    // paying: one batch with the posting; a replay does not post twice
    const paid = await payRun(t.db, people.owner2.actor, { runId: prepared.runId, paidFrom: "cash" }, at + 60_000);
    expect(paid.replayed).toBe(false);
    const again = await payRun(t.db, people.owner2.actor, { runId: prepared.runId, paidFrom: "cash" }, at + 120_000);
    expect(again).toMatchObject({ replayed: true, journalEntryId: paid.journalEntryId });
    // the run says who paid it
    expect((await getRun(t.db, people.owner.actor, prepared.runId, at + 120_000)).run.paidBy).toEqual({ kind: "employee", name: "owner" });
    const posted = await linesOf(paid.journalEntryId!);
    const totals = after.totals;
    expect(posted.debit("commissions")).toBe(totals.commissionIqd);
    expect(totals.bonusIqd).toBe(25_000);
    expect(posted.debit("payroll") - posted.credit("payroll")).toBe(totals.baseIqd + totals.bonusIqd - totals.advanceDeductionIqd - totals.otherDeductionIqd);
    expect(posted.credit("cash")).toBe(totals.netIqd);
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.id, paid.journalEntryId!)).get();
    expect(entry).toMatchObject({ refType: "payroll_run", refId: prepared.runId, isDemo: true, idempotencyKey: payrollRunPostingKey(prepared.runId) });
    const linked = await t.db.select().from(commissions).where(eq(commissions.payrollRunId, prepared.runId));
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.every((row) => row.status === "paid")).toBe(true);
    const advance = await t.db.select().from(employeeAdvances).where(eq(employeeAdvances.id, given.advanceId!)).get();
    expect(advance).toMatchObject({ status: "settled", settledRunId: prepared.runId });

    // a second run of the same month pays no base twice and finds no commission or advance left
    const second = await prepareRun(t.db, people.finance.actor, { period: october, demo: true, idempotencyKey: key() }, at + DAY).catch((error) => error);
    expect(toAppError(second)?.code).toBe("run_empty");
  });

  test("a salary changer never approves; a void frees the commissions and advances; a deferred advance waits", async () => {
    const at = Date.UTC(2026, 8, 30, 9, 0, 0);
    const september = periodOf(at - DAY);
    const worker = await person("cashier", { isDemo: true, createdAt: Date.UTC(2026, 0, 1) });
    const ownerChanger = await person("owner", { isDemo: true });
    await setBaseSalary(t.db, ownerChanger.actor, { employeeId: worker.id, baseSalaryIqd: 600_000, expectedIqd: null, reason: "راتب" }, at - 5 * DAY);
    const asked = await requestAdvance(t.db, people.finance.actor, { employeeId: worker.id, amountIqd: 50_000, paidFrom: "bank_clearing", reason: "سلفة", idempotencyKey: key() }, at - 4 * DAY);
    expect(await code(() => withdrawAdvance(t.db, people.manager.actor, { approvalId: asked.approvalId }, at))).toBe("advance_not_yours");
    const given = await decideAdvance(t.db, people.owner.actor, { approvalId: asked.approvalId, decision: "approve" }, at - 4 * DAY);
    const run = await prepareRun(t.db, people.finance.actor, { period: september, demo: true, idempotencyKey: key() }, at);
    const detail = await getRun(t.db, people.owner.actor, run.runId, at);
    expect(await code(() => approveRun(t.db, ownerChanger.actor, { runId: run.runId, expectedNetIqd: detail.totals.netIqd, expectedItems: detail.items.length }, at))).toBe("run_self_approval");
    // nor someone the run pays, whatever they hold
    const beneficiary = { ...people.owner.actor, id: worker.id };
    expect(await code(() => approveRun(t.db, beneficiary, { runId: run.runId, expectedNetIqd: detail.totals.netIqd, expectedItems: detail.items.length }, at))).toBe("run_self_approval");
    // the approvals view lists the run only for whom may approve it
    const listed = async (actor: EmployeeActor) => (await staffDecisions(t.db, actor)).some((row) => row.kind === "payroll_run" && row.id === run.runId);
    expect(await listed(people.owner.actor)).toBe(true);
    expect(await listed(ownerChanger.actor)).toBe(false);
    expect(await listed(beneficiary)).toBe(false);
    expect(await listed(people.finance.actor)).toBe(false);
    // defer the advance: the line's pay goes up by it, and a recompute keeps it deferred
    const item = detail.items.find((row) => row.employee.id === worker.id)!;
    await deferAdvance(t.db, people.finance.actor, { runId: run.runId, advanceId: given.advanceId!, reason: "يخصم الشهر القادم" }, at);
    await recomputeRun(t.db, people.finance.actor, { runId: run.runId }, at + 1000);
    const recomputed = await getRun(t.db, people.owner.actor, run.runId, at + 1000);
    expect(recomputed.items.find((row) => row.employee.id === worker.id)?.netIqd).toBe(item.netIqd + 50_000);
    // void: the advance and the commissions are free again
    await voidRun(t.db, people.finance.actor, { runId: run.runId, reason: "خطأ في الإعداد" }, at + 2000);
    const status = await t.db.select({ status: payrollRuns.status }).from(payrollRuns).where(eq(payrollRuns.id, run.runId)).get();
    expect(status?.status).toBe("void");
    const advance = await t.db.select().from(employeeAdvances).where(eq(employeeAdvances.id, given.advanceId!)).get();
    expect(advance).toMatchObject({ status: "open", settledRunId: null });
    const items = await t.db.select().from(payrollItems).where(and(eq(payrollItems.runId, run.runId), eq(payrollItems.employeeId, worker.id)));
    expect(items.length).toBe(1);
    // the advance list shows it open; finance cannot decide, only ask
    const list = await listAdvances(t.db, people.finance.actor, { status: "open", employee: worker.id, page: 1 });
    expect(list.rows.map((row) => row.status)).toEqual(["open"]);
    expect(list.can).toMatchObject({ request: true, decide: false });
  });

  test("every payroll service refuses a role without its permission, before reading the input", async () => {
    const cashier = people.cashier.actor;
    expect(await code(() => prepareRun(t.db, cashier, {} as never, NOW))).toBe("forbidden");
    expect(await code(() => approveRun(t.db, people.finance.actor, {} as never, NOW))).toBe("forbidden");
    expect(await code(() => payRun(t.db, people.manager.actor, {} as never, NOW))).toBe("forbidden");
    expect(await code(() => requestAdvance(t.db, cashier, {} as never, NOW))).toBe("forbidden");
    expect(await code(() => decideAdvance(t.db, people.manager.actor, {} as never, NOW))).toBe("forbidden");
    expect(await code(() => syncCommissions(t.db, cashier, { period: PERIOD }, NOW))).toBe("forbidden");
    expect(await code(() => getRun(t.db, people.directoryOnly.actor, `pyr_${"0".repeat(26)}`, NOW))).toBe("forbidden");
  });
});

