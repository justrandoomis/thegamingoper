/**
 * Admin module 10 "finance" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · a draft whose posting month is closed was still offered "approve" (the page, its list): approving it can only
 *     be refused (period_closed). It is now marked — `monthClosed`, canApprove false — and voiding stays possible
 *   · the expenses page told staff to record payroll here as an expense (`expenses.payrollNote`), although the staff
 *     module's payroll runs post it: it counted twice. The note is retired, the form no longer offers the payroll
 *     families and recordExpense refuses them (expense_account_payroll)
 *   · countDecidableExpenses, asked by the bell on every admin page, read the limit and the 24-hour total first and
 *     counted after them: two round trips. Now one, with the same answer
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import messages from "~/i18n/messages/admin-finance";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { createDb } from "~/server/db/drizzle.server";
import { employeeRoles, fiscalPeriods } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { createExpense } from "~/server/services/accounting/expenses.server";
import { countDecidableExpenses, expenseFormOptions, getExpense, listExpenses, recordExpense } from "~/server/services/admin/finance/expense-views.server";
import { parseRange } from "~/server/services/admin/finance/types";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<"financeA" | "financeB", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  staff.financeA = await employee("finance");
  staff.financeB = await employee("finance");
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
async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return (toAppError(error) ?? error) as AppError;
  }
  throw new Error("expected a failure");
}

/** A D1 binding that records when each statement starts and finishes, on one counter. */
function recordingD1(real: D1Database): { d1: D1Database; log: { startedAt: number; finishedAt: number | null }[] } {
  const log: { startedAt: number; finishedAt: number | null }[] = [];
  let tick = 0;
  const timed = async <T,>(call: () => Promise<T>): Promise<T> => {
    const entry = { startedAt: ++tick, finishedAt: null as number | null };
    log.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const value = await call();
    entry.finishedAt = ++tick;
    return value;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: () => timed(() => statement.all()),
      raw: () => timed(() => statement.raw()),
      first: (column?: string) => timed(() => (column === undefined ? statement.first() : statement.first(column))),
      run: () => timed(() => statement.run()),
    }) as unknown as D1PreparedStatement;
  const d1 = { prepare: (sql: string) => wrap(real.prepare(sql)), batch: (statements: D1PreparedStatement[]) => real.batch(statements), exec: (sql: string) => real.exec(sql) };
  return { d1: d1 as unknown as D1Database, log };
}

const expense = (key: string, incurredOn: string, amountIqd = 20_000, account = "marketing") => ({
  accountId: accountId(account as "marketing"),
  paidFromAccountId: accountId("cash"),
  amountIqd,
  description: `${key} expense`,
  incurredOn,
  idempotencyKey: `followup-${key}-${make.next("exp")}`,
});

describe("admin 10 finance — follow-up", () => {
  test("a draft whose posting month is closed is never offered approve, on its page or in the list; voiding still is", async () => {
    const { expenseId } = await createExpense(t.db, as("financeA"), expense("closed-month", "2026-09-14"), NOW);
    const open = await createExpense(t.db, as("financeA"), expense("open-month", "2026-11-02"), NOW);
    await t.db.insert(fiscalPeriods).values({ period: "2026-09", status: "closed", closedBy: as("financeB").id, closedAt: NOW });

    const detail = await getExpense(t.db, as("financeB"), expenseId, "ar", NOW);
    expect(detail).toMatchObject({ status: "draft", monthClosed: true, canApprove: false, canVoid: true });
    expect(await getExpense(t.db, as("financeB"), open.expenseId, "ar", NOW)).toMatchObject({ monthClosed: false, canApprove: true });

    const page = await listExpenses(t.db, as("financeB"), { ...parseRange(new URLSearchParams("from=2026-09-01&to=2026-11-30"), NOW), status: "draft", account: null, center: null, page: 1, demo: true }, "ar", NOW);
    expect(page.rows.find((row) => row.id === expenseId)?.monthClosed).toBe(true);
    expect(page.rows.find((row) => row.id === open.expenseId)?.monthClosed).toBe(false);
    await t.db.delete(fiscalPeriods).where(eq(fiscalPeriods.period, "2026-09"));
  });

  test("payroll is never recorded as an expense too: the note says so, the form leaves it out, recordExpense refuses it", async () => {
    expect(messages.ar.expenses.payrollNote).not.toMatch(/تُسجَّل هنا مصروفاً بحساب الرواتب/);
    expect(messages.en.expenses.payrollNote).toMatch(/never record them here/);
    const options = await expenseFormOptions(t.db, as("financeA"), "ar");
    expect(options.accounts.map((account) => account.id)).not.toContain(accountId("payroll"));
    expect(options.accounts.map((account) => account.id)).not.toContain(accountId("commissions"));
    expect(options.accounts.map((account) => account.id)).toContain(accountId("marketing"));
    const refused = await failureOf(recordExpense(t.db, as("financeA"), expense("salaries", "2026-11-05", 300_000, "payroll"), NOW));
    expect(refused).toMatchObject({ code: "expense_account_payroll", status: 409, fields: { accountId: "expense_account_payroll" } });
    expect((await recordExpense(t.db, as("financeA"), expense("ads", "2026-11-05", 5_000), NOW)).replayed).toBe(false);
  });

  test("countDecidableExpenses: one round trip, same answer (own drafts above what one may approve alone excluded)", async () => {
    await createExpense(t.db, as("financeA"), expense("big-own", "2026-11-03", 900_000), NOW);
    const recording = recordingD1(t.d1);
    const counted = await countDecidableExpenses(createDb(recording.d1), as("financeA"), NOW);
    const firstBack = Math.min(...recording.log.map((entry) => entry.finishedAt ?? Infinity));
    expect(recording.log.every((entry) => entry.startedAt < firstBack)).toBe(true);
    // the same answer as the rule: every open-month draft except financeA's own above the limit
    const drafts = await listExpenses(t.db, as("financeA"), { ...parseRange(new URLSearchParams("from=2020-01-01&to=2026-11-30"), NOW), status: "draft", account: null, center: null, page: 1, demo: true }, "ar", NOW);
    expect(counted).toBe(drafts.rows.filter((row) => !row.needsOther && !row.monthClosed).length);
    expect(await countDecidableExpenses(t.db, as("financeB"), NOW)).toBe(drafts.rows.filter((row) => !row.monthClosed).length);
  });
});
