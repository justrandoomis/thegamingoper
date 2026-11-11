import { Outlet } from "react-router";

import type { Route } from "./+types/layout";
import { getDb } from "~/server/db.server";
import { countDecidableExpenses } from "~/server/services/admin/finance/expense-views.server";
import { financeAccess } from "~/server/services/admin/finance/shared.server";
import { walletQueue } from "~/server/services/admin/finance/wallets.server";
import { sql } from "drizzle-orm";
import { financeI18n, openFinance } from "./finance.server";
import { FinanceNav, useFinT } from "./ui";

import "./finance.css";

/**
 * /admin/finance/* — admin module 10 "Finance & Accounting" (docs/areas/admin-finance.md). The shell's gate already let
 * through only employees who hold some finance.* permission; every page below checks its own permission again in its
 * loader and action, and the services check it once more (assertCan).
 *
 * This layout sends the module's strings, what this employee may open, and the number waiting in each queue (the
 * beads) to every page of the module.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { actor, locale, now, ctx } = await openFinance(context);
  const db = getDb();
  const access = financeAccess(actor);
  const [wallet, expenses, statements] = await Promise.all([
    walletQueue(db, actor),
    countDecidableExpenses(db, actor, now),
    access.reconcile ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM statement_lines WHERE status = 'unmatched'`) : Promise.resolve(null),
  ]);
  return {
    i18n: financeI18n(locale),
    access,
    counts: { topups: wallet?.topups ?? null, adjustments: wallet?.adjustments ?? null, expenses, statements: statements ? Number(statements[0]?.n ?? 0) : null },
    storeMode: ctx.storeMode,
    now,
  };
}

export default function FinanceLayout({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const { access, counts } = loaderData;
  const walletCount = (counts.topups ?? 0) + (counts.adjustments ?? 0);
  return (
    <>
      <FinanceNav
        items={[
          { to: "/admin/finance", label: t("nav.overview"), icon: "squares-four", show: true, exact: true },
          { to: "/admin/finance/journal", label: t("nav.journal"), icon: "book-open", show: access.books },
          { to: "/admin/finance/accounts", label: t("nav.accounts"), icon: "table", show: access.books },
          { to: "/admin/finance/settlements", label: t("nav.settlements"), icon: "bank", count: counts.statements, show: access.reconcile },
          { to: "/admin/finance/revenue", label: t("nav.revenue"), icon: "trend-up", show: access.reports },
          { to: "/admin/finance/expenses", label: t("nav.expenses"), icon: "receipt", count: counts.expenses, show: access.expenses },
          { to: "/admin/finance/reports", label: t("nav.reports"), icon: "chart-bar", show: access.reports },
          { to: "/admin/finance/wallets", label: t("nav.wallets"), icon: "wallet", count: walletCount || null, show: access.wallet },
          { to: "/admin/finance/tax", label: t("nav.tax"), icon: "percent", show: access.tax },
          { to: "/admin/finance/close", label: t("nav.close"), icon: "lock", show: access.closeView },
          { to: "/admin/finance/anomalies", label: t("nav.anomalies"), icon: "warning", show: access.anomalies },
        ]}
      />
      <Outlet />
    </>
  );
}
