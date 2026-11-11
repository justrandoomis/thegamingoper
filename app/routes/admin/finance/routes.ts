import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 10 — Finance and accounting (docs/areas/admin-finance.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/finance/. Static segments outrank the dynamic ones,
 * so /admin/finance/journal/new never reaches the entry page.
 *
 *   /admin/finance                                  overview: what waits, this month's figures, sections          (all)
 *   /admin/finance/journal                          the journal (+ /export CSV)                                   10.01
 *   /admin/finance/journal/new                      a manual entry                                                10.01
 *   /admin/finance/journal/:entryId                 one entry; reverse a manual entry                             10.01 10.09
 *   /admin/finance/accounts                         chart of accounts + trial balance (print), manage accounts    10.01
 *   /admin/finance/accounts/:accountId              one account's ledger with running balance                     10.01
 *   /admin/finance/settlements                      by payment method, statement lines, unproven payments         10.02
 *   /admin/finance/settlements/import               statement CSV: preview → import                               10.02
 *   /admin/finance/settlements/:lineId              one statement line: match, set aside, undo                    10.02
 *   /admin/finance/revenue                          realised vs pending; COGS, discounts, coupons, returns        10.03 10.04
 *   /admin/finance/expenses[/new|/:expenseId]       expenses: list, record, approve and post, void (+ receipt)    10.05
 *   /admin/finance/cost-centers                     cost centres                                                  10.05
 *   /admin/finance/reports                          P&L, cash flow, inventory as an asset (+ /export CSV)         10.06
 *   /admin/finance/wallets                          wallet ledger, top-up requests, adjustments                   10.07
 *   /admin/finance/wallets/topups/:topupId[/proof]  one top-up request (mobile-first) and its private proof       10.07
 *   /admin/finance/wallets/:customerId              one customer's wallet; request an adjustment                  10.07
 *   /admin/finance/tax                              tax configuration and report                                  10.08
 *   /admin/finance/close                            the monthly close                                             10.09
 *   /admin/finance/anomalies                        anomalous values and mismatched totals                        10.10
 */
export const financeAdminRoutes: RouteConfigEntry[] = [
  route("finance", "routes/admin/finance/layout.tsx", [
    index("routes/admin/finance/index.tsx"),
    route("journal", "routes/admin/finance/journal.tsx"),
    route("journal/new", "routes/admin/finance/journal-new.tsx"),
    route("journal/export", "routes/admin/finance/journal-export.ts"),
    route("journal/:entryId", "routes/admin/finance/entry.tsx"),
    route("accounts", "routes/admin/finance/accounts.tsx"),
    route("accounts/:accountId", "routes/admin/finance/account.tsx"),
    route("settlements", "routes/admin/finance/settlements.tsx"),
    route("settlements/import", "routes/admin/finance/statement-import.tsx"),
    route("settlements/:lineId", "routes/admin/finance/statement-line.tsx"),
    route("revenue", "routes/admin/finance/revenue.tsx"),
    route("expenses", "routes/admin/finance/expenses.tsx"),
    route("expenses/new", "routes/admin/finance/expense-new.tsx"),
    route("expenses/:expenseId", "routes/admin/finance/expense.tsx"),
    route("expenses/:expenseId/receipt", "routes/admin/finance/expense-receipt.ts"),
    route("cost-centers", "routes/admin/finance/cost-centers.tsx"),
    route("reports", "routes/admin/finance/reports.tsx"),
    route("reports/export", "routes/admin/finance/reports-export.ts"),
    route("wallets", "routes/admin/finance/wallets.tsx"),
    route("wallets/topups/:topupId", "routes/admin/finance/topup.tsx"),
    route("wallets/topups/:topupId/proof", "routes/admin/finance/topup-proof.ts"),
    route("wallets/:customerId", "routes/admin/finance/wallet.tsx"),
    route("tax", "routes/admin/finance/tax.tsx"),
    route("close", "routes/admin/finance/close.tsx"),
    route("anomalies", "routes/admin/finance/anomalies.tsx"),
  ]),
];
