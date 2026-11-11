/**
 * Admin module 10's home: the figures each employee may see and what waits for their decision — raised clay only for
 * what a person must decide (DESIGN.md §10). Each part is computed only for the permission that opens it; a part the
 * employee may not see is null (never 0).
 */
import { sql } from "drizzle-orm";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { accountSums, chartOfAccounts, familyIds, revenueRecognised } from "~/server/services/accounting/reports.server";
import { countCritical } from "./anomalies.server";
import { countDecidableExpenses } from "./expense-views.server";
import { financeAccess, type FinanceAccess } from "./shared.server";
import { periodOf, periodRange } from "./types";
import { walletQueue } from "./wallets.server";

const num = (value: unknown) => Number(value ?? 0);

export type FinanceOverview = {
  access: FinanceAccess;
  period: string;
  /** finance.report.read: this month's net revenue (real orders only) and the orders not delivered yet. */
  revenue: { netIqd: number; ordersRecognised: number; openOrders: number; openIqd: number } | null;
  /** finance.report.read + cost.read: cash and bank balances (real postings). They are the books: purchases paid in
   *  cash would be derivable from them, so like the cash flow they need cost.read (reports.server.ts). */
  cash: { cashIqd: number; bankIqd: number } | null;
  /** finance.wallet.read: what the store owes in wallets. */
  wallet: { liabilityIqd: number } | null;
  waiting: {
    topups: number | null;
    adjustments: number | null;
    expenses: number | null;
    statements: number | null;
    critical: number | null;
    /** The last month not closed yet (finance.period.close), when it is over. */
    closeDue: string | null;
  };
  demo: { entries: number };
};

export async function financeOverview(db: Db, actor: Actor, now: number): Promise<FinanceOverview> {
  const access = financeAccess(actor);
  const period = periodOf(now);
  const { from, to } = periodRange(period);
  const withCash = access.reports && access.cost;
  const chart = withCash ? await chartOfAccounts(db) : [];
  const [revenue, open, sums, wallet, queue, expenses, statements, critical, lastOpen, demo] = await Promise.all([
    access.reports ? revenueRecognised(db, { from, to, includeDemo: false }) : Promise.resolve(null),
    access.reports
      ? db.all<{ n: number; total: number }>(sql`
          SELECT count(*) AS n, coalesce(sum(total_iqd), 0) AS total FROM orders
          WHERE status IN ('new', 'awaiting_payment', 'payment_review', 'confirmed', 'preparing', 'shipped') AND is_demo = 0`)
      : Promise.resolve(null),
    withCash ? accountSums(db, { includeDemo: false }) : Promise.resolve(null),
    access.wallet ? db.all<{ total: number }>(sql`SELECT coalesce(sum(amount_iqd), 0) AS total FROM wallet_ledger`) : Promise.resolve(null),
    walletQueue(db, actor),
    countDecidableExpenses(db, actor, now),
    access.reconcile ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM statement_lines WHERE status = 'unmatched'`) : Promise.resolve(null),
    countCritical(db, actor, now),
    access.close
      ? db.all<{ period: string }>(sql`
          SELECT e.period AS period FROM journal_entries AS e WHERE e.period < ${period}
            AND NOT EXISTS (SELECT 1 FROM fiscal_periods AS f WHERE f.period = e.period AND f.status = 'closed')
          ORDER BY e.period LIMIT 1`)
      : Promise.resolve(null),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_entries WHERE is_demo = 1`),
  ]);
  const balance = (key: "cash" | "bank_clearing") => {
    if (!sums) return 0;
    let total = 0;
    for (const id of familyIds(chart, key)) {
      const s = sums.get(id);
      if (s) total += s.debit - s.credit;
    }
    return total;
  };
  return {
    access,
    period,
    revenue: revenue && open ? { netIqd: revenue.netIqd, ordersRecognised: revenue.ordersRecognised, openOrders: num(open[0]?.n), openIqd: num(open[0]?.total) } : null,
    cash: sums ? { cashIqd: balance("cash"), bankIqd: balance("bank_clearing") } : null,
    wallet: wallet ? { liabilityIqd: num(wallet[0]?.total) } : null,
    waiting: {
      topups: queue?.topups ?? null,
      adjustments: queue?.adjustments ?? null,
      expenses,
      statements: statements ? num(statements[0]?.n) : null,
      critical,
      closeDue: lastOpen?.[0]?.period ?? null,
    },
    demo: { entries: num(demo[0]?.n) },
  };
}

