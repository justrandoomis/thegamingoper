/**
 * Admin 10.10 — anomalous values: deterministic checks run when the page opens (the same SQL every time, no
 * statistics, no guessing), next to what the daily consistency job (`consistency.daily`, 23.06) recorded in
 * `consistency_findings` (finance.anomaly.read).
 *
 *   not a number      money stored as anything but a whole number of dinars ("NaN", decimals, text) in the journal,
 *                     the wallet ledger, payments, refunds, orders, expenses and statement lines
 *   unexplained −     an account on the side it should never be on (negative cash, a debit balance on the wallet
 *                     liability, a revenue account in debit…), a negative customer wallet
 *   mismatched totals the trial balance, unbalanced entries, lines without a header, the wallet ledger against its
 *                     account, orders against their lines and payments, paid money without its posting, statement
 *                     lines matched to a different amount, top-ups and adjustments approved but not credited,
 *                     posted expenses without their entry
 *
 * The journal's own figures are cost data (cost.read): checks that would show an inventory or cost balance are run
 * only for employees who hold it; the others see that those checks exist and need it. Stock findings of the daily job
 * are the operations module's (ops.consistency.read).
 */
import { sql } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { CONSISTENCY_CHECKS, listOpenFindings } from "~/server/jobs.server";
import { accountSums, chartOfAccounts, isDebitNormal, systemRoots } from "~/server/services/accounting/reports.server";

const num = (value: unknown) => Number(value ?? 0);

export type Severity = "critical" | "warning" | "info";

export type AnomalyFinding = {
  check: string;
  severity: Severity;
  /** What it is about, for the link and the sentence. */
  entityType: string | null;
  entityId: string | null;
  /** Numbers and labels the sentence needs (amounts in IQD). */
  values: Record<string, string | number | null>;
  href: string | null;
};

export type CheckResult = { check: string; group: "nan" | "negative" | "totals"; status: "ok" | "found" | "needs_cost"; findings: AnomalyFinding[] };

export type StoredFinding = {
  id: string;
  checkKey: string;
  severity: Severity;
  entityType: string | null;
  entityId: string | null;
  message: string;
  status: string;
  occurrences: number;
  detectedAt: number;
  lastSeenAt: number;
};

export type AnomalyReport = { checks: CheckResult[]; stored: StoredFinding[]; storedHidden: number; lastRun: { at: number; status: string } | null; ranAt: number };

const MONEY_COLUMNS: readonly { table: string; columns: readonly string[]; nullable?: readonly string[] }[] = [
  { table: "journal_lines", columns: ["debit_iqd", "credit_iqd"] },
  { table: "wallet_ledger", columns: ["amount_iqd"] },
  { table: "payments", columns: ["amount_iqd"], nullable: ["declared_amount_iqd"] },
  { table: "refunds", columns: ["amount_iqd"] },
  { table: "orders", columns: ["subtotal_iqd", "discount_iqd", "shipping_iqd", "total_iqd", "paid_iqd", "refunded_iqd"] },
  { table: "expenses", columns: ["amount_iqd"] },
  { table: "statement_lines", columns: ["amount_iqd"] },
];

/** The daily job's checks that concern money (stock checks belong to operations). */
const MONEY_CHECK_KEYS = ["wallet.ledger_vs_journal", "wallet.negative_balance", "journal.unbalanced_entries", "journal.orphan_lines", "orders.totals_vs_items", "orders.paid_vs_payments", "money.missing_postings"] as const;

function hrefOf(entityType: string | null, entityId: string | null, extra: { ref?: string | null } = {}): string | null {
  if (!entityId) return null;
  switch (entityType) {
    case "journal_entry":
      return `/admin/finance/journal/${entityId}`;
    case "customer":
      return `/admin/finance/wallets/${entityId}`;
    case "order":
      return extra.ref ? `/admin/orders/${extra.ref}` : null;
    case "account":
      return entityId.startsWith("acc_") ? `/admin/finance/accounts/${entityId}` : null;
    case "wallet_topup":
      return `/admin/finance/wallets/topups/${entityId}`;
    case "expense":
      return `/admin/finance/expenses/${entityId}`;
    case "statement_line":
      return `/admin/finance/settlements/${entityId}`;
    default:
      return null;
  }
}

/** Runs every finance check now (finance.anomaly.read) and reads the daily job's open money findings. */
export async function financeAnomalies(db: Db, actor: Actor, now: number): Promise<AnomalyReport> {
  assertCan(actor, "finance.anomaly.read");
  const withCost = can(actor, "cost.read");
  const checks: CheckResult[] = [];

  // ── not a number: money that is not a whole number of dinars
  const nanFindings: AnomalyFinding[] = [];
  for (const spec of MONEY_COLUMNS) {
    const conditions = [
      ...spec.columns.map((column) => `typeof(${column}) <> 'integer'`),
      ...(spec.nullable ?? []).map((column) => `(${column} IS NOT NULL AND typeof(${column}) <> 'integer')`),
    ].join(" OR ");
    const rows = await db.all<{ id: string; n: number }>(sql.raw(`SELECT id, count(*) OVER () AS n FROM ${spec.table} WHERE ${conditions} LIMIT 20`));
    for (const row of rows) nanFindings.push({ check: "money.not_integer", severity: "critical", entityType: spec.table, entityId: row.id, values: { table: spec.table, count: num(row.n) }, href: null });
  }
  checks.push({ check: "money.not_integer", group: "nan", status: nanFindings.length ? "found" : "ok", findings: nanFindings });

  // ── unexplained negatives
  const negatives: AnomalyFinding[] = [];
  if (withCost) {
    const [chart, sums] = await Promise.all([chartOfAccounts(db), accountSums(db, { includeDemo: true })]);
    const roots = systemRoots(chart);
    for (const account of chart) {
      const s = sums.get(account.id);
      if (!s) continue;
      const natural = isDebitNormal(account.type, account.isContra) ? s.debit - s.credit : s.credit - s.debit;
      if (natural >= 0) continue;
      const root = roots.get(account.id);
      // customer control is a two-sided account by design (advances vs receivables), and cash over/short may go either way
      if (root === "cod_receivable" || root === "cash_over_short") continue;
      const severity: Severity = root === "wallet_liability" || root === "cash" || root === "bank_clearing" ? "critical" : "warning";
      negatives.push({ check: "accounts.wrong_side", severity, entityType: "account", entityId: account.id, values: { code: account.code, accountKey: root ?? null, balanceIqd: natural }, href: hrefOf("account", account.id) });
    }
    checks.push({ check: "accounts.wrong_side", group: "negative", status: negatives.length ? "found" : "ok", findings: negatives });
  } else {
    checks.push({ check: "accounts.wrong_side", group: "negative", status: "needs_cost", findings: [] });
  }

  // the daily job's money checks, run live
  for (const key of MONEY_CHECK_KEYS) {
    const check = CONSISTENCY_CHECKS.find((item) => item.key === key);
    if (!check) continue;
    const group: CheckResult["group"] = key === "wallet.negative_balance" ? "negative" : "totals";
    const needsCost = key === "journal.unbalanced_entries" || key === "journal.orphan_lines";
    if (needsCost && !withCost) {
      checks.push({ check: key, group, status: "needs_cost", findings: [] });
      continue;
    }
    const found = await check.run(db);
    const orderIds = found.filter((finding) => finding.entityType === "order" && finding.entityId).map((finding) => finding.entityId as string);
    const refs = orderIds.length
      ? new Map(
          (
            await db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM orders WHERE id IN (${sql.join(
              orderIds.slice(0, 90).map((id) => sql`${id}`),
              sql`, `,
            )})`)
          ).map((row) => [row.id, row.ref]),
        )
      : new Map<string, string>();
    checks.push({
      check: key,
      group,
      status: found.length ? "found" : "ok",
      findings: found.slice(0, 50).map((finding) => ({
        check: key,
        severity: finding.severity as Severity,
        entityType: finding.entityType,
        entityId: finding.entityId,
        values: Object.fromEntries(Object.entries(finding.details).filter(([, value]) => typeof value === "number" || typeof value === "string" || value === null)) as Record<string, string | number | null>,
        href: hrefOf(finding.entityType, finding.entityId, { ref: finding.entityType === "order" && finding.entityId ? (refs.get(finding.entityId) ?? null) : null }),
      })),
    });
  }

  // ── mismatched totals specific to this module
  if (withCost) {
    const tb = await db.all<{ debit: number; credit: number }>(sql`SELECT coalesce(sum(l.debit_iqd), 0) AS debit, coalesce(sum(l.credit_iqd), 0) AS credit FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id`);
    const debit = num(tb[0]?.debit);
    const credit = num(tb[0]?.credit);
    checks.push({ check: "journal.trial_balance", group: "totals", status: debit === credit ? "ok" : "found", findings: debit === credit ? [] : [{ check: "journal.trial_balance", severity: "critical", entityType: null, entityId: null, values: { debitIqd: debit, creditIqd: credit }, href: "/admin/finance/accounts" }] });
  } else {
    checks.push({ check: "journal.trial_balance", group: "totals", status: "needs_cost", findings: [] });
  }

  const [differs, topups, adjustments, expenses] = await Promise.all([
    db.all<{ id: string; line: number; payment: number }>(sql`
      SELECT sl.id, sl.amount_iqd AS line, p.amount_iqd AS payment FROM statement_lines AS sl JOIN payments AS p ON p.id = sl.matched_payment_id
      WHERE sl.status = 'matched' AND sl.amount_iqd <> p.amount_iqd LIMIT 50`),
    db.all<{ id: string; ref: string; amount: number }>(sql`
      SELECT t.id, t.ref, t.amount_iqd AS amount FROM wallet_topups AS t
      WHERE t.status = 'approved' AND NOT EXISTS (SELECT 1 FROM wallet_ledger AS w WHERE w.idempotency_key = 'topup:' || t.id) LIMIT 50`),
    db.all<{ id: string; customerId: string; amount: number }>(sql`
      SELECT a.id, a.entity_id AS customerId, CAST(json_extract(a.payload, '$.amountIqd') AS INTEGER) AS amount FROM approvals AS a
      WHERE a.kind = 'wallet_adjustment' AND a.status = 'approved' AND NOT EXISTS (SELECT 1 FROM wallet_ledger AS w WHERE w.idempotency_key = 'adjustment:' || a.id) LIMIT 50`),
    // A posted expense has its entry of its amount; a voided one that WAS posted (it keeps the entry id) also has
    // the reversal. A draft that was voided never had an entry, which is right.
    db.all<{ id: string; amount: number; entry: number | null }>(sql`
      SELECT x.id, x.amount_iqd AS amount, (SELECT sum(l.debit_iqd) FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id WHERE e.id = x.journal_entry_id) AS entry
      FROM expenses AS x
      WHERE (x.status = 'posted' OR (x.status = 'void' AND x.journal_entry_id IS NOT NULL))
        AND (x.journal_entry_id IS NULL OR NOT EXISTS (SELECT 1 FROM journal_entries AS e WHERE e.id = x.journal_entry_id)
          OR (SELECT sum(l.debit_iqd) FROM journal_lines AS l WHERE l.entry_id = x.journal_entry_id) <> x.amount_iqd
          OR (x.status = 'void' AND NOT EXISTS (SELECT 1 FROM journal_entries AS r WHERE r.reverses_id = x.journal_entry_id))) LIMIT 50`),
  ]);
  checks.push({
    check: "statements.matched_differs",
    group: "totals",
    status: differs.length ? "found" : "ok",
    findings: differs.map((row) => ({ check: "statements.matched_differs", severity: "warning" as const, entityType: "statement_line", entityId: row.id, values: { lineIqd: num(row.line), paymentIqd: num(row.payment) }, href: hrefOf("statement_line", row.id) })),
  });
  checks.push({
    check: "wallet.topup_not_credited",
    group: "totals",
    status: topups.length ? "found" : "ok",
    findings: topups.map((row) => ({ check: "wallet.topup_not_credited", severity: "critical" as const, entityType: "wallet_topup", entityId: row.id, values: { ref: row.ref, amountIqd: num(row.amount) }, href: hrefOf("wallet_topup", row.id) })),
  });
  checks.push({
    check: "wallet.adjustment_not_credited",
    group: "totals",
    status: adjustments.length ? "found" : "ok",
    findings: adjustments.map((row) => ({ check: "wallet.adjustment_not_credited", severity: "critical" as const, entityType: "customer", entityId: row.customerId, values: { amountIqd: num(row.amount) }, href: hrefOf("customer", row.customerId) })),
  });
  checks.push({
    check: "expenses.entry_missing",
    group: "totals",
    status: expenses.length ? "found" : "ok",
    findings: expenses.map((row) => ({ check: "expenses.entry_missing", severity: "critical" as const, entityType: "expense", entityId: row.id, values: { amountIqd: num(row.amount), entryIqd: row.entry === null ? null : num(row.entry) }, href: hrefOf("expense", row.id) })),
  });

  // ── what the daily job recorded
  const [stored, lastRun] = await Promise.all([
    listOpenFindings(db, 300),
    db.all<{ at: number; status: string }>(sql`SELECT started_at AS at, status FROM job_runs WHERE job = 'consistency.daily' ORDER BY started_at DESC LIMIT 1`),
  ]);
  const opsRead = can(actor, "ops.consistency.read");
  const visible = stored.filter((row) => opsRead || (MONEY_CHECK_KEYS as readonly string[]).includes(row.checkKey));
  const costHidden = withCost ? visible : visible.filter((row) => row.checkKey !== "journal.unbalanced_entries" && row.checkKey !== "journal.orphan_lines");
  return {
    checks,
    stored: costHidden.slice(0, 100).map((row) => ({
      id: row.id,
      checkKey: row.checkKey,
      severity: row.severity as Severity,
      entityType: row.entityType,
      entityId: row.entityId,
      message: row.message,
      status: row.status,
      occurrences: row.occurrences,
      detectedAt: row.detectedAt,
      lastSeenAt: row.lastSeenAt,
    })),
    storedHidden: stored.length - costHidden.length,
    lastRun: lastRun[0] ? { at: num(lastRun[0].at), status: lastRun[0].status } : null,
    ranAt: now,
  };
}

/** Critical problems found right now (for the module's home), or null without finance.anomaly.read. */
export async function countCritical(db: Db, actor: Actor, now: number): Promise<number | null> {
  if (!can(actor, "finance.anomaly.read")) return null;
  const report = await financeAnomalies(db, actor, now);
  return report.checks.reduce((total, check) => total + check.findings.filter((finding) => finding.severity === "critical").length, 0);
}
