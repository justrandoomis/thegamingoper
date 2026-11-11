/**
 * Financial statements read from the journal — the one implementation of docs/metrics.md §3–§5 that the finance
 * module (10), dashboards (01) and reports (18) call, so a figure means the same thing on every screen.
 * Added by admin 10 finance on 2026-11-11 as a commerce-core file (CONTRACTS.md §1); tests: tests/admin-finance-core.test.ts.
 *
 *   const pnl = await profitAndLoss(db, actor, { from, to, includeDemo: false });   // revenue, cost [P], profit [P]
 *   const tb = await trialBalance(db, actor, { to, includeDemo: false });            // cost.read
 *   const cash = await cashFlow(db, actor, { from, to, includeDemo: false });         // cost.read
 *   const stock = await inventoryAsset(db, actor);                                    // cost.read
 *
 * RULES
 *   · Only lines whose entry header exists are part of the books: every query joins journal_lines to journal_entries.
 *   · Demo postings (`is_demo = 1`) are excluded unless `includeDemo` (metrics §1).
 *   · Accounts are grouped by the nearest SYSTEM key up their parent chain, so an accountant's sub-account ("6410
 *     Facebook ads" under marketing) counts where its parent counts; accounts outside the system tree stand alone.
 *   · Field permissions are applied HERE: cost figures (COGS, inventory, adjustments, stock value) exist only for
 *     cost.read; profit figures only for cost.read AND profit.read (profit minus revenue would reveal cost). A figure
 *     that is not allowed is absent (null), never 0. The screen's own permission (finance.report.read,
 *     dashboard.sales.read, reports.*) is checked by the caller.
 *   · Trial balance, cash flow and the inventory asset require cost.read outright: purchases paid in cash and the
 *     inventory account would otherwise be derivable from the other balances.
 *   · Closed months (10.09): a closed month is final for every month before it too — `isLockedPeriod` and the batch
 *     guard `openPeriodGuard` keep anything dated on or before the last closed month out of the books (the database
 *     trigger refuses only the closed month's own dates), so a closed month's closing balances never move.
 *
 * Must not import "cloudflare:workers".
 */
import { sql, type SQL } from "drizzle-orm";
import type { L10n } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import type { AccountType, SystemAccountKey } from "~/server/db/schema";
import { expectThat } from "~/server/db/tx.server";

export type JournalScope = {
  /** Inclusive start, epoch ms (null = from the beginning). */
  from?: number | null;
  /** Exclusive end, epoch ms (null = up to now). */
  to?: number | null;
  includeDemo?: boolean;
};

export type ChartAccount = {
  id: string;
  code: string;
  name: L10n;
  type: AccountType;
  systemKey: SystemAccountKey | null;
  isContra: boolean;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
  description: string | null;
};

export type AccountSums = { debit: number; credit: number };

const num = (value: unknown) => Number(value ?? 0);

// ───────────────────────────────────────────────────────────────── closed months

/** The last closed month ("YYYY-MM"), or null. Nothing may be dated on or before it. */
export async function lastClosedPeriod(db: Db): Promise<string | null> {
  const rows = await db.all<{ period: string | null }>(sql`SELECT max(period) AS period FROM fiscal_periods WHERE status = 'closed'`);
  return rows[0]?.period ?? null;
}

/** True when a posting dated in `period` would change a closed month: the month itself or any month before the last close. */
export async function isLockedPeriod(db: Db, period: string): Promise<boolean> {
  const last = await lastClosedPeriod(db);
  return last !== null && period <= last;
}

/**
 * A batch guard for a posting dated in `period`: aborts with TT:PERIOD_CLOSED when that month or a later one is closed
 * (a close landing between the service's check and its batch). mapPostingError turns it into period_closed (409).
 */
export function openPeriodGuard(db: Db, period: string): BatchStatement {
  return expectThat(db, sql`NOT EXISTS (SELECT 1 FROM fiscal_periods WHERE status = 'closed' AND period >= ${period})`, { code: "PERIOD_CLOSED", detail: period });
}

// ───────────────────────────────────────────────────────────────── chart

export async function chartOfAccounts(db: Db): Promise<ChartAccount[]> {
  const rows = await db.all<{
    id: string;
    code: string;
    name: string;
    type: AccountType;
    systemKey: SystemAccountKey | null;
    isContra: number;
    parentId: string | null;
    isActive: number;
    isSystem: number;
    description: string | null;
  }>(sql`SELECT id, code, name, type, system_key AS systemKey, is_contra AS isContra, parent_id AS parentId, is_active AS isActive, is_system AS isSystem, description FROM accounts ORDER BY code, id`);
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: parseL10n(row.name),
    type: row.type,
    systemKey: row.systemKey,
    isContra: Boolean(row.isContra),
    parentId: row.parentId,
    isActive: Boolean(row.isActive),
    isSystem: Boolean(row.isSystem),
    description: row.description,
  }));
}

function parseL10n(value: unknown): L10n {
  if (value && typeof value === "object") return value as L10n;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as L10n).ar === "string") return parsed as L10n;
    } catch {
      // a plain string name
    }
    return { ar: value };
  }
  return { ar: "" };
}

/** True when the account's balance is normally a debit (assets, expenses; contra accounts flip it). */
export function isDebitNormal(type: AccountType, isContra: boolean): boolean {
  const base = type === "asset" || type === "expense";
  return isContra ? !base : base;
}

/** The balance on the account's normal side (positive = normal, negative = the unusual side). */
export function naturalBalance(account: Pick<ChartAccount, "type" | "isContra">, sums: AccountSums): number {
  return isDebitNormal(account.type, account.isContra) ? sums.debit - sums.credit : sums.credit - sums.debit;
}

/** account id → the nearest system key up its parent chain (itself first); null outside the system tree. */
export function systemRoots(chart: readonly ChartAccount[]): Map<string, SystemAccountKey | null> {
  const byId = new Map(chart.map((account) => [account.id, account]));
  const out = new Map<string, SystemAccountKey | null>();
  for (const account of chart) {
    let current: ChartAccount | undefined = account;
    let key: SystemAccountKey | null = null;
    for (let depth = 0; current && depth < 12; depth++) {
      if (current.systemKey) {
        key = current.systemKey;
        break;
      }
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    out.set(account.id, key);
  }
  return out;
}

/** The ids of an account family: the system account with this key and every account below it. */
export function familyIds(chart: readonly ChartAccount[], key: SystemAccountKey): string[] {
  const roots = systemRoots(chart);
  return chart.filter((account) => roots.get(account.id) === key).map((account) => account.id);
}

function scopeConditions(scope: JournalScope): SQL {
  const parts: SQL[] = [sql`1 = 1`];
  if (scope.from !== null && scope.from !== undefined) parts.push(sql`e.at >= ${scope.from}`);
  if (scope.to !== null && scope.to !== undefined) parts.push(sql`e.at < ${scope.to}`);
  if (!scope.includeDemo) parts.push(sql`e.is_demo = 0`);
  return sql.join(parts, sql` AND `);
}

/** Σ debit and Σ credit per account over the entries in scope. */
export async function accountSums(db: Db, scope: JournalScope): Promise<Map<string, AccountSums>> {
  const rows = await db.all<{ accountId: string; debit: number; credit: number }>(sql`
    SELECT l.account_id AS accountId, coalesce(sum(l.debit_iqd), 0) AS debit, coalesce(sum(l.credit_iqd), 0) AS credit
    FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
    WHERE ${scopeConditions(scope)}
    GROUP BY l.account_id`);
  return new Map(rows.map((row) => [row.accountId, { debit: num(row.debit), credit: num(row.credit) }]));
}

function sumOf(sums: Map<string, AccountSums>, ids: readonly string[]): AccountSums {
  let debit = 0;
  let credit = 0;
  for (const id of ids) {
    const s = sums.get(id);
    if (!s) continue;
    debit += s.debit;
    credit += s.credit;
  }
  return { debit, credit };
}

// ───────────────────────────────────────────────────────────────── trial balance

export type TrialBalanceRow = {
  account: ChartAccount;
  /** Movement in the scope. */
  debit: number;
  credit: number;
  /** The closing balance, shown on its side. */
  balanceDebit: number;
  balanceCredit: number;
};

export type TrialBalance = { rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean; entries: number };

/**
 * Every account's balance at `to` (entries before it), on the side it falls (cost.read). `balanced` is the books'
 * first check: Σ debit balances = Σ credit balances.
 */
export async function trialBalance(db: Db, actor: Actor, scope: { to?: number | null; includeDemo?: boolean }): Promise<TrialBalance> {
  assertCan(actor, "cost.read");
  const [chart, sums, count] = await Promise.all([
    chartOfAccounts(db),
    accountSums(db, { to: scope.to, includeDemo: scope.includeDemo }),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_entries AS e WHERE ${scopeConditions({ to: scope.to, includeDemo: scope.includeDemo })}`),
  ]);
  let totalDebit = 0;
  let totalCredit = 0;
  const rows = chart.map((account) => {
    const s = sums.get(account.id) ?? { debit: 0, credit: 0 };
    const net = s.debit - s.credit;
    const row: TrialBalanceRow = { account, debit: s.debit, credit: s.credit, balanceDebit: net > 0 ? net : 0, balanceCredit: net < 0 ? -net : 0 };
    totalDebit += row.balanceDebit;
    totalCredit += row.balanceCredit;
    return row;
  });
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit, entries: num(count[0]?.n) };
}

// ───────────────────────────────────────────────────────────────── revenue and profit (metrics §3–§4)

export type AccountLine = { accountId: string; code: string; name: L10n; amountIqd: number };

export type RevenueSection = {
  /** Credits to sales revenue [4000] (net of debits). */
  grossIqd: number;
  shippingIncomeIqd: number;
  discountsIqd: number;
  refundsIqd: number;
  /** Revenue − discounts − refunds (shipping is handled by the shipping subsidy). */
  netIqd: number;
  /** Revenue accounts outside the system ones (other income), each on its own line. */
  otherIncome: AccountLine[];
  /** Orders whose sale was recognised in the scope ("order:<id>:sale" postings). */
  ordersRecognised: number;
};

export type ProfitAndLoss = {
  scope: { from: number | null; to: number | null; includeDemo: boolean };
  revenue: RevenueSection;
  /** cost.read: COGS and inventory adjustments; null without it. */
  cost: { cogsIqd: number; inventoryAdjustmentsIqd: number; uncostedUnits: number } | null;
  expenses: {
    commissionsIqd: number;
    shippingCostsIqd: number;
    /** Shipping costs − shipping income (positive = delivery costs more than it earns). */
    shippingSubsidyIqd: number;
    cashOverShortIqd: number;
    /** The other operating expense accounts (operating expenses, payroll, marketing, the accountant's own). */
    operating: AccountLine[];
    operatingTotalIqd: number;
  };
  /** cost.read AND profit.read; null otherwise. Margins in basis points, null when net revenue is 0. */
  profit: { grossIqd: number; grossMarginBps: number | null; netIqd: number; netMarginBps: number | null; operatingIqd: number } | null;
};

const REVENUE_KEYS: readonly SystemAccountKey[] = ["sales_revenue", "shipping_income", "sales_discounts", "sales_refunds"];
const NAMED_EXPENSE_KEYS: readonly SystemAccountKey[] = ["cogs", "inventory_adjustments", "commissions", "shipping_costs", "cash_over_short"];

/** The revenue section only (no cost involved) — what 10.03 and the dashboards read. */
export async function revenueRecognised(db: Db, scope: JournalScope): Promise<RevenueSection> {
  const [chart, sums] = await Promise.all([chartOfAccounts(db), accountSums(db, scope)]);
  return revenueFrom(db, chart, sums, scope);
}

async function revenueFrom(db: Db, chart: readonly ChartAccount[], sums: Map<string, AccountSums>, scope: JournalScope): Promise<RevenueSection> {
  const roots = systemRoots(chart);
  const fam = (key: SystemAccountKey) => sumOf(sums, chart.filter((account) => roots.get(account.id) === key).map((account) => account.id));
  const gross = fam("sales_revenue");
  const shipping = fam("shipping_income");
  const discounts = fam("sales_discounts");
  const refunds = fam("sales_refunds");
  const grossIqd = gross.credit - gross.debit;
  const discountsIqd = discounts.debit - discounts.credit;
  const refundsIqd = refunds.debit - refunds.credit;
  const otherIncome: AccountLine[] = chart
    .filter((account) => account.type === "revenue" && !REVENUE_KEYS.includes(roots.get(account.id) as SystemAccountKey))
    .map((account) => ({ accountId: account.id, code: account.code, name: account.name, amountIqd: naturalBalance(account, sums.get(account.id) ?? { debit: 0, credit: 0 }) }))
    .filter((line) => line.amountIqd !== 0);
  const recognised = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM journal_entries AS e WHERE ${scopeConditions(scope)} AND e.ref_type = 'order' AND e.idempotency_key LIKE 'order:%:sale'`);
  return {
    grossIqd,
    shippingIncomeIqd: shipping.credit - shipping.debit,
    discountsIqd,
    refundsIqd,
    netIqd: grossIqd - discountsIqd - refundsIqd,
    otherIncome,
    ordersRecognised: num(recognised[0]?.n),
  };
}

function marginBps(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return Math.round((part * 10_000) / whole);
}

/** Profit and loss for the scope (metrics §4), with the field permissions applied. */
export async function profitAndLoss(db: Db, actor: Actor, scope: JournalScope): Promise<ProfitAndLoss> {
  const withCost = can(actor, "cost.read");
  const withProfit = withCost && can(actor, "profit.read");
  const [chart, sums] = await Promise.all([chartOfAccounts(db), accountSums(db, scope)]);
  const roots = systemRoots(chart);
  const fam = (key: SystemAccountKey) => sumOf(sums, chart.filter((account) => roots.get(account.id) === key).map((account) => account.id));
  const net = (s: AccountSums) => s.debit - s.credit;

  const revenue = await revenueFrom(db, chart, sums, scope);
  const commissionsIqd = net(fam("commissions"));
  const shippingCostsIqd = net(fam("shipping_costs"));
  const cashOverShortIqd = net(fam("cash_over_short"));
  const operating: AccountLine[] = chart
    .filter((account) => account.type === "expense" && !NAMED_EXPENSE_KEYS.includes(roots.get(account.id) as SystemAccountKey))
    .map((account) => ({ accountId: account.id, code: account.code, name: account.name, amountIqd: naturalBalance(account, sums.get(account.id) ?? { debit: 0, credit: 0 }) }))
    .filter((line) => line.amountIqd !== 0);
  const operatingTotalIqd = operating.reduce((total, line) => total + line.amountIqd, 0);
  const shippingSubsidyIqd = shippingCostsIqd - revenue.shippingIncomeIqd;

  let cost: ProfitAndLoss["cost"] = null;
  let profit: ProfitAndLoss["profit"] = null;
  if (withCost) {
    const cogsIqd = net(fam("cogs"));
    const inventoryAdjustmentsIqd = net(fam("inventory_adjustments"));
    const uncosted = await db.all<{ units: number }>(sql`
      SELECT coalesce(sum(-m.qty_delta), 0) AS units FROM stock_movements AS m
      LEFT JOIN orders AS o ON o.id = m.ref_id AND m.ref_type = 'order'
      WHERE m.kind = 'sale' AND m.unit_cost_iqd IS NULL
        ${scope.from !== null && scope.from !== undefined ? sql`AND m.at >= ${scope.from}` : sql``}
        ${scope.to !== null && scope.to !== undefined ? sql`AND m.at < ${scope.to}` : sql``}
        ${scope.includeDemo ? sql`` : sql`AND coalesce(o.is_demo, 0) = 0`}`);
    cost = { cogsIqd, inventoryAdjustmentsIqd, uncostedUnits: num(uncosted[0]?.units) };
    if (withProfit) {
      const grossIqd = revenue.netIqd - cogsIqd;
      const netIqd = revenue.netIqd - cogsIqd - commissionsIqd - shippingSubsidyIqd;
      const otherIncomeIqd = revenue.otherIncome.reduce((total, line) => total + line.amountIqd, 0);
      const operatingIqd = netIqd - inventoryAdjustmentsIqd - cashOverShortIqd - operatingTotalIqd + otherIncomeIqd;
      profit = { grossIqd, grossMarginBps: marginBps(grossIqd, revenue.netIqd), netIqd, netMarginBps: marginBps(netIqd, revenue.netIqd), operatingIqd };
    }
  }
  return {
    scope: { from: scope.from ?? null, to: scope.to ?? null, includeDemo: Boolean(scope.includeDemo) },
    revenue,
    cost,
    expenses: { commissionsIqd, shippingCostsIqd, shippingSubsidyIqd, cashOverShortIqd, operating, operatingTotalIqd },
    profit,
  };
}

// ───────────────────────────────────────────────────────────────── cash flow (direct method)

export const CASH_FLOW_CATEGORIES = [
  "customers",
  "wallet_topups",
  "refunds",
  "payroll",
  "marketing",
  "shipping",
  "commissions",
  "operating",
  "suppliers",
  "point_of_sale",
  "manual",
  "other",
] as const;
export type CashFlowCategory = (typeof CASH_FLOW_CATEGORIES)[number];

export type CashFlow = {
  scope: { from: number | null; to: number | null; includeDemo: boolean };
  /** The cash and bank accounts counted (cash, bank clearing and their sub-accounts). */
  accounts: { id: string; code: string; name: L10n; openingIqd: number; closingIqd: number }[];
  openingIqd: number;
  closingIqd: number;
  rows: { category: CashFlowCategory; inflowIqd: number; outflowIqd: number; entries: number }[];
  inflowIqd: number;
  outflowIqd: number;
};

function cashCategory(refType: string | null, counterKey: SystemAccountKey | null): CashFlowCategory {
  switch (refType) {
    case "payment":
      return "customers";
    case "wallet_ledger":
      return "wallet_topups";
    case "refund":
      return "refunds";
    case "manual":
      return "manual";
    case "receipt":
    case "purchase_order":
    case "supplier_invoice":
    case "supplier_payment":
      return "suppliers";
    case "pos_shift":
    case "pos_sale":
    case "cash_movement":
      return "point_of_sale";
    default:
      break;
  }
  // expenses, carriers' settlements and anything newer: by the account on the other side of the cash
  switch (counterKey) {
    case "payroll":
      return "payroll";
    case "marketing":
      return "marketing";
    case "shipping_costs":
      return "shipping";
    case "commissions":
      return "commissions";
    case "inventory":
    case "accounts_payable":
      return "suppliers";
    case "cod_receivable":
      return "customers";
    case "wallet_liability":
      return "wallet_topups";
    case "operating_expenses":
    case "cash_over_short":
      return "operating";
    default:
      return refType === "expense" ? "operating" : "other";
  }
}

/**
 * Money in and out of the cash and bank accounts in the scope, by what caused it (cost.read): opening balance, each
 * category's inflow and outflow, closing balance. Moves between two cash accounts net to zero and are left out.
 */
export async function cashFlow(db: Db, actor: Actor, scope: JournalScope): Promise<CashFlow> {
  assertCan(actor, "cost.read");
  const chart = await chartOfAccounts(db);
  const roots = systemRoots(chart);
  const cashAccounts = chart.filter((account) => {
    const key = roots.get(account.id);
    return key === "cash" || key === "bank_clearing";
  });
  const ids = cashAccounts.map((account) => account.id);
  const inList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  if (ids.length === 0) throw new Error("cashFlow: the chart has no cash or bank account (reference seed missing)");
  const [before, during, flows] = await Promise.all([
    accountSums(db, { to: scope.from ?? 0, includeDemo: scope.includeDemo }),
    accountSums(db, scope),
    db.all<{ refType: string | null; counterAccount: string | null; inflow: number; outflow: number; entries: number }>(sql`
      WITH cash_entries AS (
        SELECT e.id AS id, e.ref_type AS ref_type, sum(l.debit_iqd - l.credit_iqd) AS net
        FROM journal_entries AS e JOIN journal_lines AS l ON l.entry_id = e.id
        WHERE ${scopeConditions(scope)} AND l.account_id IN (${inList})
        GROUP BY e.id HAVING sum(l.debit_iqd - l.credit_iqd) <> 0
      )
      SELECT c.ref_type AS refType,
             (SELECT l2.account_id FROM journal_lines AS l2 WHERE l2.entry_id = c.id AND l2.account_id NOT IN (${inList})
               ORDER BY (l2.debit_iqd + l2.credit_iqd) DESC, l2.id LIMIT 1) AS counterAccount,
             coalesce(sum(CASE WHEN c.net > 0 THEN c.net ELSE 0 END), 0) AS inflow,
             coalesce(sum(CASE WHEN c.net < 0 THEN -c.net ELSE 0 END), 0) AS outflow,
             count(*) AS entries
      FROM cash_entries AS c
      GROUP BY c.ref_type, counterAccount`),
  ]);
  // With no start the opening balance is zero (nothing came before the books began).
  const opening = scope.from === null || scope.from === undefined ? new Map<string, AccountSums>() : before;
  const accounts = cashAccounts.map((account) => {
    const o = opening.get(account.id) ?? { debit: 0, credit: 0 };
    const d = during.get(account.id) ?? { debit: 0, credit: 0 };
    return { id: account.id, code: account.code, name: account.name, openingIqd: o.debit - o.credit, closingIqd: o.debit - o.credit + d.debit - d.credit };
  });
  const byCategory = new Map<CashFlowCategory, { inflowIqd: number; outflowIqd: number; entries: number }>();
  for (const flow of flows) {
    const category = cashCategory(flow.refType, flow.counterAccount ? (roots.get(flow.counterAccount) ?? null) : null);
    const current = byCategory.get(category) ?? { inflowIqd: 0, outflowIqd: 0, entries: 0 };
    current.inflowIqd += num(flow.inflow);
    current.outflowIqd += num(flow.outflow);
    current.entries += num(flow.entries);
    byCategory.set(category, current);
  }
  const rows = CASH_FLOW_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => ({ category, ...byCategory.get(category)! }));
  return {
    scope: { from: scope.from ?? null, to: scope.to ?? null, includeDemo: Boolean(scope.includeDemo) },
    accounts,
    openingIqd: accounts.reduce((total, account) => total + account.openingIqd, 0),
    closingIqd: accounts.reduce((total, account) => total + account.closingIqd, 0),
    rows,
    inflowIqd: rows.reduce((total, row) => total + row.inflowIqd, 0),
    outflowIqd: rows.reduce((total, row) => total + row.outflowIqd, 0),
  };
}

// ───────────────────────────────────────────────────────────────── inventory as an asset (metrics §5)

export type InventoryAsset = {
  /** Balance of the inventory account family (journal; demo postings included — stock is physical). */
  accountIqd: number;
  /** Σ qty_remaining × unit cost of the FIFO cost layers. */
  layersIqd: number;
  layerUnits: number;
  /** Used devices on hand (intake … reserved, returned) at acquisition cost; units without a cost are counted apart. */
  usedIqd: number;
  usedUnits: number;
  usedUncosted: number;
  /** Units shipped to customers and not delivered yet: out of the layers, still in the account until delivery. */
  shippedNotDeliveredIqd: number;
  shippedNotDeliveredUncosted: number;
  /** Units travelling between locations (out of the source's layers, not in the destination's yet). */
  inTransitIqd: number;
  /** account − (layers + used + shipped-not-delivered + in transit): receipts not posted (purchasing posts them),
   *  demo opening stock never posted, trade-ins paid in cash… */
  unexplainedIqd: number;
};

/** The inventory account against the stock it stands for (cost.read). */
export async function inventoryAsset(db: Db, actor: Actor): Promise<InventoryAsset> {
  assertCan(actor, "cost.read");
  const chart = await chartOfAccounts(db);
  const ids = familyIds(chart, "inventory");
  const sums = await accountSums(db, { includeDemo: true });
  const account = sumOf(sums, ids);
  const [layers, used, shipped, transit] = await Promise.all([
    db.all<{ value: number; units: number }>(sql`SELECT coalesce(sum(qty_remaining * unit_cost_iqd), 0) AS value, coalesce(sum(qty_remaining), 0) AS units FROM cost_layers WHERE qty_remaining > 0`),
    db.all<{ value: number; units: number; uncosted: number }>(sql`
      SELECT coalesce(sum(acquisition_cost_iqd), 0) AS value, count(*) AS units, coalesce(sum(CASE WHEN acquisition_cost_iqd IS NULL THEN 1 ELSE 0 END), 0) AS uncosted
      FROM used_units WHERE status IN ('intake', 'testing', 'ready', 'listed', 'reserved', 'returned')`),
    db.all<{ value: number; uncosted: number }>(sql`
      SELECT coalesce(sum(-m.qty_delta * m.unit_cost_iqd), 0) AS value, coalesce(sum(CASE WHEN m.unit_cost_iqd IS NULL THEN -m.qty_delta ELSE 0 END), 0) AS uncosted
      FROM stock_movements AS m JOIN orders AS o ON o.id = m.ref_id
      WHERE m.kind = 'sale' AND m.ref_type = 'order' AND o.status = 'shipped'`),
    db.all<{ value: number }>(sql`
      -- out (qty_delta < 0) adds its value, what already arrived (qty_delta > 0) takes it away
      SELECT coalesce(sum(-m.qty_delta * coalesce(m.unit_cost_iqd, 0)), 0) AS value
      FROM stock_movements AS m JOIN stock_transfers AS t ON t.id = m.ref_id
      WHERE m.ref_type = 'transfer' AND t.status = 'in_transit' AND m.kind IN ('transfer_out', 'transfer_in')`),
  ]);
  const accountIqd = account.debit - account.credit;
  const layersIqd = num(layers[0]?.value);
  const usedIqd = num(used[0]?.value);
  const shippedNotDeliveredIqd = num(shipped[0]?.value);
  const inTransitIqd = num(transit[0]?.value);
  return {
    accountIqd,
    layersIqd,
    layerUnits: num(layers[0]?.units),
    usedIqd,
    usedUnits: num(used[0]?.units),
    usedUncosted: num(used[0]?.uncosted),
    shippedNotDeliveredIqd,
    shippedNotDeliveredUncosted: num(shipped[0]?.uncosted),
    inTransitIqd,
    unexplainedIqd: accountIqd - (layersIqd + usedIqd + shippedNotDeliveredIqd + inTransitIqd),
  };
}
