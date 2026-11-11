/**
 * The two commerce-core files added by admin 10 finance (docs/CONTRACTS.md §1) on a real local D1:
 *
 *   · accounting/reports.server.ts — profit and loss exactly as docs/metrics.md §4 defines it, the trial balance,
 *     the cash flow by cause and the inventory asset; demo postings left out unless asked; the field permissions
 *     (cost figures only for cost.read, profit figures only for cost.read + profit.read — absent, never zero)
 *   · accounting/expenses.server.ts — expenses through the journal: validation, idempotent creation, the four-eyes
 *     limit, one posting per expense (double clicks and two approvers at once), voiding by reversal, closed months
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { expenses, fiscalPeriods, journalEntries, journalLines } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, type Permission } from "~/server/permissions";
import { approveExpense, createExpense, EXPENSE_SECOND_APPROVAL_ABOVE_IQD, expenseIdFor, voidExpense } from "~/server/services/accounting/expenses.server";
import { postCogs, postPaymentReceived, postRefund, postSale, journalStatements } from "~/server/services/accounting/post.server";
import { accountSums, cashFlow, inventoryAsset, profitAndLoss, trialBalance } from "~/server/services/accounting/reports.server";
import { saveCostCenter } from "~/server/services/admin/finance/expense-views.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
/** Noon in Baghdad of a day of 2026. */
const at = (month: number, day: number) => Date.UTC(2026, month - 1, day, 9, 0, 0);
const JUNE = { from: Date.UTC(2026, 5, 1) - 3 * 3600_000, to: Date.UTC(2026, 6, 1) - 3 * 3600_000 };

let t: TestDb;
let make: Fixtures;
const role = (key: "owner" | "manager" | "finance" | "cashier" | "support", id = newId("emp")): EmployeeActor => ({ kind: "employee", id, permissions: defaultRolePermissions(key), label: key });
const custom = (permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: newId("emp"), permissions: new Set(permissions) });

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

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

describe("reports: profit and loss, trial balance, cash flow (docs/metrics.md)", () => {
  let financeA: EmployeeActor;
  let financeB: EmployeeActor;

  beforeAll(async () => {
    financeA = role("finance", await make.employee());
    financeB = role("finance", await make.employee());
    const db = t.db;
    const base = { createdBy: "system:test", isDemo: false };
    // a sale of 100,000 with a 10,000 discount and the 5,000 delivery fee, paid in cash, cost 60,000, 20,000 refunded
    const orderId = newId("ord");
    await runBatch(db, [
      ...postPaymentReceived(db, { ...base, at: at(6, 10), paymentId: newId("pay"), orderId, ref: "TT-JUNE1", method: "cod", receivedIqd: 95_000, dueIqd: 95_000 }),
      ...postSale(db, { ...base, at: at(6, 11), orderId, ref: "TT-JUNE1", subtotalIqd: 100_000, discountIqd: 10_000, shippingIqd: 5_000, totalIqd: 95_000 }),
      ...postCogs(db, { ...base, at: at(6, 11), orderId, ref: "TT-JUNE1", cogsIqd: 60_000 }),
      ...postRefund(db, { ...base, at: at(6, 15), refundId: newId("ref"), orderId, ref: "TT-JUNE1", amountIqd: 20_000, paidFrom: "cash", revenueRecognized: true }),
    ]);
    // a demo sale that real figures leave out
    const demoOrder = newId("ord");
    await runBatch(db, postSale(db, { createdBy: "system:test", isDemo: true, at: at(6, 12), orderId: demoOrder, ref: "TT-DEMO1", subtotalIqd: 999_000, discountIqd: 0, shippingIqd: 0, totalIqd: 999_000 }));
    // expenses: payroll 30,000 from cash, marketing 5,000 from cash, carrier costs 8,000 from cash
    for (const [key, account, amount] of [
      ["payroll-june", "payroll", 30_000],
      ["ads-june", "marketing", 5_000],
      ["carrier-june", "shipping_costs", 8_000],
    ] as const) {
      const { expenseId } = await createExpense(db, financeA, { accountId: accountId(account), paidFromAccountId: accountId("cash"), amountIqd: amount, description: `${key} expense`, incurredOn: "2026-06-20", idempotencyKey: `core-${key}` }, NOW);
      await approveExpense(db, financeB, { expenseId }, NOW);
    }
  });

  test("P&L follows metrics §4 to the dinar; demo postings only when asked", async () => {
    const pl = await profitAndLoss(t.db, role("owner"), { from: JUNE.from, to: JUNE.to });
    expect(pl.revenue).toMatchObject({ grossIqd: 100_000, discountsIqd: 10_000, refundsIqd: 20_000, netIqd: 70_000, shippingIncomeIqd: 5_000, ordersRecognised: 1 });
    expect(pl.cost).toMatchObject({ cogsIqd: 60_000, inventoryAdjustmentsIqd: 0 });
    expect(pl.expenses).toMatchObject({ commissionsIqd: 0, shippingCostsIqd: 8_000, shippingSubsidyIqd: 3_000, cashOverShortIqd: 0, operatingTotalIqd: 35_000 });
    // net profit = net revenue − COGS − commissions − shipping subsidy; operating result takes the other expenses off
    expect(pl.profit).toMatchObject({ grossIqd: 10_000, netIqd: 7_000, operatingIqd: -28_000 });
    expect(pl.profit?.grossMarginBps).toBe(Math.round((10_000 * 10_000) / 70_000));
    const withDemo = await profitAndLoss(t.db, role("owner"), { from: JUNE.from, to: JUNE.to, includeDemo: true });
    expect(withDemo.revenue.grossIqd).toBe(100_000 + 999_000);
  });

  test("cost and profit figures are absent (null), not zero, without their permissions — and no number reveals them", async () => {
    const reportOnly = custom(["finance.report.read"]);
    const pl = await profitAndLoss(t.db, reportOnly, { from: JUNE.from, to: JUNE.to });
    expect(pl.cost).toBeNull();
    expect(pl.profit).toBeNull();
    expect(JSON.stringify(pl)).not.toMatch(/"cogsIqd"|"netIqd":7000[^\d]|[^\d]60000[^\d]/);
    const costNoProfit = custom(["finance.report.read", "cost.read"]);
    const second = await profitAndLoss(t.db, costNoProfit, { from: JUNE.from, to: JUNE.to });
    expect(second.cost?.cogsIqd).toBe(60_000);
    expect(second.profit).toBeNull();
    // profit.read alone (without cost.read) would reveal cost through profit: refused as well
    const profitNoCost = custom(["finance.report.read", "profit.read"]);
    expect((await profitAndLoss(t.db, profitNoCost, { from: JUNE.from, to: JUNE.to })).profit).toBeNull();
    expect(await failureOf(trialBalance(t.db, reportOnly, {}))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(cashFlow(t.db, reportOnly, { from: JUNE.from, to: JUNE.to }))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(inventoryAsset(t.db, reportOnly))).toMatchObject({ code: "forbidden" });
  });

  test("the trial balance balances and each account sits on its side", async () => {
    const tb = await trialBalance(t.db, role("finance"), { to: JUNE.to });
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);
    const cash = tb.rows.find((row) => row.account.systemKey === "cash");
    // 95,000 in, 20,000 refunded, 43,000 of expenses
    expect(cash).toMatchObject({ balanceDebit: 95_000 - 20_000 - 43_000, balanceCredit: 0 });
    const revenue = tb.rows.find((row) => row.account.systemKey === "sales_revenue");
    expect(revenue?.balanceCredit).toBe(100_000);
  });

  test("cash flow: opening + in − out = closing, by cause", async () => {
    const flow = await cashFlow(t.db, role("finance"), { from: JUNE.from, to: JUNE.to });
    expect(flow.openingIqd).toBe(0);
    const by = (category: string) => flow.rows.find((row) => row.category === category);
    expect(by("customers")).toMatchObject({ inflowIqd: 95_000, outflowIqd: 0 });
    expect(by("refunds")).toMatchObject({ inflowIqd: 0, outflowIqd: 20_000 });
    expect(by("payroll")).toMatchObject({ outflowIqd: 30_000 });
    expect(by("marketing")).toMatchObject({ outflowIqd: 5_000 });
    expect(by("shipping")).toMatchObject({ outflowIqd: 8_000 });
    expect(flow.closingIqd).toBe(flow.openingIqd + flow.inflowIqd - flow.outflowIqd);
    expect(flow.closingIqd).toBe(32_000);
    // the next month opens where June closed
    const july = await cashFlow(t.db, role("finance"), { from: JUNE.to, to: JUNE.to + 31 * DAY });
    expect(july.openingIqd).toBe(32_000);
  });

  test("inventory asset: the identity account = layers + used + shipped + in transit + unexplained holds", async () => {
    const asset = await inventoryAsset(t.db, role("finance"));
    expect(asset.accountIqd).toBe(asset.layersIqd + asset.usedIqd + asset.shippedNotDeliveredIqd + asset.inTransitIqd + asset.unexplainedIqd);
    // June's COGS took 60,000 out of the inventory account without any receipt being posted
    expect(asset.accountIqd).toBe(-60_000);
  });
});

describe("expenses through the accounting core", () => {
  const today = "2026-11-10";
  let a: EmployeeActor;
  let b: EmployeeActor;
  const input = (key: string, overrides: Record<string, unknown> = {}) => ({
    accountId: accountId("operating_expenses"),
    paidFromAccountId: accountId("cash"),
    amountIqd: 50_000,
    description: "مواد تنظيف",
    incurredOn: today,
    idempotencyKey: `exp-test-${key}`,
    ...overrides,
  });

  beforeAll(async () => {
    a = role("finance", await make.employee());
    b = role("finance", await make.employee());
  });

  test("permission first: cashier and support are refused; manager and finance may record", async () => {
    expect(await failureOf(createExpense(t.db, role("cashier"), input("cashier"), NOW))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(createExpense(t.db, role("support"), input("support"), NOW))).toMatchObject({ code: "forbidden" });
    const manager = role("manager", await make.employee());
    expect((await createExpense(t.db, manager, input("manager"), NOW)).replayed).toBe(false);
  });

  test("validation: future date, accounts posted by other flows, unknown centre, payment accounts that cannot pay", async () => {
    expect(await failureOf(createExpense(t.db, a, input("future", { incurredOn: "2026-11-11" }), NOW))).toMatchObject({ code: "invalid", fields: { incurredOn: "expense_date_future" } });
    expect(await failureOf(createExpense(t.db, a, input("bad-date", { incurredOn: "2026-02-30" }), NOW))).toMatchObject({ code: "invalid" });
    expect(await failureOf(createExpense(t.db, a, input("cogs", { accountId: accountId("cogs") }), NOW))).toMatchObject({ code: "expense_account_invalid" });
    expect(await failureOf(createExpense(t.db, a, input("revenue", { accountId: accountId("sales_revenue") }), NOW))).toMatchObject({ code: "expense_account_invalid" });
    expect(await failureOf(createExpense(t.db, a, input("wallet", { paidFromAccountId: accountId("wallet_liability") }), NOW))).toMatchObject({ code: "expense_paid_from_invalid" });
    expect(await failureOf(createExpense(t.db, a, input("inventory", { paidFromAccountId: accountId("inventory") }), NOW))).toMatchObject({ code: "expense_paid_from_invalid" });
    expect(await failureOf(createExpense(t.db, a, input("center", { costCenter: "NOPE" }), NOW))).toMatchObject({ code: "cost_center_invalid" });
    expect(await failureOf(createExpense(t.db, a, input("zero", { amountIqd: 0 }), NOW))).toMatchObject({ code: "invalid" });
    expect(await failureOf(createExpense(t.db, a, input("fraction", { amountIqd: 10.5 }), NOW))).toMatchObject({ code: "invalid" });
  });

  test("creation is idempotent: the key decides the id; the same key with another amount is a mismatch", async () => {
    const first = await createExpense(t.db, a, input("idem"), NOW);
    const again = await createExpense(t.db, a, input("idem"), NOW);
    expect(again).toEqual({ expenseId: first.expenseId, replayed: true });
    expect(first.expenseId).toBe(await expenseIdFor("exp-test-idem"));
    expect(await failureOf(createExpense(t.db, a, input("idem", { amountIqd: 51_000 }), NOW))).toMatchObject({ code: "idempotency_mismatch", status: 409 });
    expect((await t.db.select().from(expenses).where(eq(expenses.id, first.expenseId)).get())?.status).toBe("draft");
  });

  test("a draft is not in the books; approving posts ONE balanced entry with the cost centre; a repeat replays", async () => {
    await saveCostCenter(t.db, a, { code: "BGD-SHOP", nameAr: "فرع بغداد", isActive: true }, NOW);
    const { expenseId } = await createExpense(t.db, a, input("post", { costCenter: "bgd-shop", amountIqd: 120_000 }), NOW);
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.refId, expenseId))).toHaveLength(0);
    const posted = await approveExpense(t.db, a, { expenseId }, NOW);
    expect(posted).toMatchObject({ status: "posted", replayed: false });
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, posted.entryId));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: accountId("operating_expenses"), debitIqd: 120_000, costCenter: "BGD-SHOP" }),
        expect.objectContaining({ accountId: accountId("cash"), creditIqd: 120_000 }),
      ]),
    );
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.id, posted.entryId)).get();
    expect(entry).toMatchObject({ refType: "expense", refId: expenseId, idempotencyKey: `expense:${expenseId}:posted`, period: "2026-11" });
    expect(await approveExpense(t.db, b, { expenseId }, NOW)).toMatchObject({ status: "posted", entryId: posted.entryId, replayed: true });
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.refId, expenseId))).toHaveLength(1);
  });

  test("four eyes above the limit: whoever recorded it cannot approve it; at or below the limit they may", async () => {
    const big = await createExpense(t.db, a, input("big", { amountIqd: EXPENSE_SECOND_APPROVAL_ABOVE_IQD + 1 }), NOW);
    expect(await failureOf(approveExpense(t.db, a, { expenseId: big.expenseId }, NOW))).toMatchObject({ code: "expense_self_approval", status: 403 });
    expect((await approveExpense(t.db, b, { expenseId: big.expenseId }, NOW)).status).toBe("posted");
    // someone who approved nothing of their own today may approve exactly the limit alone
    const c = role("finance", await make.employee());
    const limit = await createExpense(t.db, c, input("limit", { amountIqd: EXPENSE_SECOND_APPROVAL_ABOVE_IQD }), NOW);
    expect((await approveExpense(t.db, c, { expenseId: limit.expenseId }, NOW)).status).toBe("posted");
    // `a` already approved one of their own today (120,000): the same limit now counts that too (no splitting)
    const split = await createExpense(t.db, a, input("split", { amountIqd: EXPENSE_SECOND_APPROVAL_ABOVE_IQD }), NOW);
    expect(await failureOf(approveExpense(t.db, a, { expenseId: split.expenseId }, NOW))).toMatchObject({ code: "expense_self_approval", status: 403 });
    expect((await approveExpense(t.db, b, { expenseId: split.expenseId }, NOW)).status).toBe("posted");
  });

  test("two approvers at the same moment post once", async () => {
    const { expenseId } = await createExpense(t.db, a, input("race", { amountIqd: 70_000 }), NOW);
    const results = await Promise.allSettled([approveExpense(t.db, a, { expenseId }, NOW), approveExpense(t.db, b, { expenseId }, NOW)]);
    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.refId, expenseId))).toHaveLength(1);
  });

  test("void: a draft is dropped without an entry; a posted one is reversed (reverses_id) and nets to zero", async () => {
    const draft = await createExpense(t.db, a, input("void-draft"), NOW);
    expect(await voidExpense(t.db, a, { expenseId: draft.expenseId, reason: "سُجل مرتين" }, NOW)).toEqual({ status: "void", reversalId: null, replayed: false });
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.refId, draft.expenseId))).toHaveLength(0);
    const posted = await createExpense(t.db, a, input("void-posted", { amountIqd: 33_000 }), NOW);
    const { entryId } = await approveExpense(t.db, a, { expenseId: posted.expenseId }, NOW);
    expect(await failureOf(voidExpense(t.db, a, { expenseId: posted.expenseId, reason: "" }, NOW))).toMatchObject({ code: "invalid" });
    const voided = await voidExpense(t.db, b, { expenseId: posted.expenseId, reason: "فاتورة مرتجعة" }, NOW);
    expect(voided.reversalId).toBeTruthy();
    const reversal = await t.db.select().from(journalEntries).where(eq(journalEntries.id, voided.reversalId as string)).get();
    expect(reversal).toMatchObject({ reversesId: entryId, idempotencyKey: `expense:${posted.expenseId}:void` });
    const sums = await accountSums(t.db, {});
    const entries = await t.db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.refId, posted.expenseId));
    expect(entries).toHaveLength(2);
    const both = await t.db.all<{ debit: number; credit: number }>(sql`SELECT sum(debit_iqd) AS debit, sum(credit_iqd) AS credit FROM journal_lines WHERE entry_id IN (${entryId}, ${voided.reversalId}) AND account_id = ${accountId("operating_expenses")}`);
    expect(Number(both[0].debit)).toBe(Number(both[0].credit));
    expect(sums.size).toBeGreaterThan(0);
    expect(await voidExpense(t.db, a, { expenseId: posted.expenseId, reason: "مرة ثانية" }, NOW)).toMatchObject({ status: "void", replayed: true });
    expect(await failureOf(approveExpense(t.db, a, { expenseId: posted.expenseId }, NOW))).toMatchObject({ code: "expense_not_draft" });
  });

  test("a closed month: no new expense dated in it, and a draft from it cannot be posted", async () => {
    const { expenseId } = await createExpense(t.db, a, input("closed", { incurredOn: "2026-05-20" }), NOW);
    await t.db.insert(fiscalPeriods).values({ period: "2026-05", status: "closed", closedBy: a.id, closedAt: NOW });
    expect(await failureOf(createExpense(t.db, a, input("closed-2", { incurredOn: "2026-05-21" }), NOW))).toMatchObject({ code: "period_closed", fields: { incurredOn: "period_closed" } });
    expect(await failureOf(approveExpense(t.db, a, { expenseId }, NOW))).toMatchObject({ code: "period_closed", status: 409 });
    expect((await t.db.select().from(expenses).where(eq(expenses.id, expenseId)).get())?.status).toBe("draft");
  });

  test("the journal builders refuse an unbalanced entry before the database", () => {
    expect(() => journalStatements(t.db, { at: NOW, lines: [{ accountCode: "cash", debitIqd: 10 }, { accountCode: "sales_revenue", creditIqd: 9 }] })).toThrow(/does not balance/);
  });
});
