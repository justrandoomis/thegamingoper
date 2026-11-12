/**
 * accounting — chart of accounts, the double-entry journal, fiscal periods, expenses, exchange
 * rates, tax rates and statement reconciliation (admin module 10).
 *
 * HOW TO POST A JOURNAL ENTRY (enforced by triggers in drizzle/0001_invariants.sql):
 *   In ONE db.batch, insert the `journal_lines` FIRST and the `journal_entries` header LAST.
 *   The header is the commit record — inserting it validates and seals the entry:
 *     · the period must be open                       → TT:PERIOD_CLOSED:<period>
 *     · there must be at least two lines and
 *       Σ debit_iqd = Σ credit_iqd                     → TT:JOURNAL_UNBALANCED:<entry_id>
 *     · once the header exists, no line can be added   → TT:JOURNAL_SEALED:<entry_id>
 *   Both tables are [A] append-only                    → TT:IMMUTABLE:<table>
 *   Use journalEntryStatements() from ~/server/db/journal.server — it builds the statements in the right
 *   order. Corrections are new entries with `reverses_id` set; an entry can be reversed once.
 *   Insert the header with a plain INSERT (never ON CONFLICT DO NOTHING): a duplicate
 *   `idempotency_key` must fail the batch, otherwise the lines written before it would be committed
 *   without a header.
 *
 *   `journal_lines.entry_id` deliberately has no FOREIGN KEY: the lines are written before their
 *   header. Reports must read lines through a join on `journal_entries` (lines without a header
 *   are not part of the books; the daily consistency check reports any).
 *
 * `period` is the Asia/Baghdad calendar month, "YYYY-MM".
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { NOW_MS, at, flag, id, iqd, json, l10n, type Ref } from "../columns";
import { payments } from "./commerce";
import { files } from "./core";

// ───────────────────────────────────────────────────────────────── chart of accounts

export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * Stable keys of the accounts that services post to automatically (seeded by seedReference).
 * Look accounts up by `system_key`, never by code or name — an accountant may renumber the chart.
 */
export const SYSTEM_ACCOUNT_KEYS = [
  "cash",
  "bank_clearing",
  "cod_receivable",
  "inventory",
  "accounts_payable",
  "wallet_liability",
  "owner_equity",
  "sales_revenue",
  "shipping_income",
  "sales_discounts",
  "sales_refunds",
  "cogs",
  "inventory_adjustments",
  "operating_expenses",
  "shipping_costs",
  "commissions",
  "payroll",
  "marketing",
  "cash_over_short",
  // migration 0004 (added to databases whose chart was already seeded; seedReference installs them on a new one)
  /** Gift cards sold or issued and not redeemed yet (admin 08.07). */
  "gift_card_liability",
  /** Pay owed to employees between a payroll run's approval and its payment (admin 15.04). */
  "salaries_payable",
  /** Salary advances handed out and not yet deducted from a payroll run (admin 15.04). */
  "employee_advances",
] as const;
export type SystemAccountKey = (typeof SYSTEM_ACCOUNT_KEYS)[number];

export const accounts = sqliteTable(
  "accounts",
  {
    id: id(),
    code: text("code").notNull(),
    name: l10n("name").notNull(),
    type: text("type", { enum: ACCOUNT_TYPES }).notNull(),
    systemKey: text("system_key", { enum: SYSTEM_ACCOUNT_KEYS }),
    /** Contra accounts carry the opposite balance of their type (sales discounts, sales refunds). */
    isContra: flag("is_contra").notNull().default(false),
    parentId: text("parent_id").references((): Ref => accounts.id),
    description: text("description"),
    /** System accounts cannot be deleted or re-typed. */
    isSystem: flag("is_system").notNull().default(false),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("accounts_code_uq").on(t.code),
    uniqueIndex("accounts_system_key_uq").on(t.systemKey),
    index("accounts_parent_idx").on(t.parentId),
    index("accounts_type_idx").on(t.type),
  ],
);
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export const costCenters = sqliteTable(
  "cost_centers",
  {
    id: id(),
    code: text("code").notNull(),
    name: l10n("name").notNull(),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("cost_centers_code_uq").on(t.code)],
);
export type CostCenter = typeof costCenters.$inferSelect;
export type NewCostCenter = typeof costCenters.$inferInsert;

// ───────────────────────────────────────────────────────────────── journal [A]

/** [A] Journal entry header. Insert it AFTER its lines (see the file header). */
export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: id(),
    at: at("at").notNull(),
    /** "YYYY-MM" in Asia/Baghdad. */
    period: text("period").notNull(),
    memo: text("memo"),
    /** The business event behind the entry: "order", "payment", "refund", "receipt", "expense", "pos_shift", … */
    refType: text("ref_type"),
    refId: text("ref_id"),
    createdBy: text("created_by"),
    /** The entry this one reverses. An entry can be reversed at most once. */
    reversesId: text("reverses_id").references((): Ref => journalEntries.id),
    /** One posting per business event: e.g. "order:<id>:delivered". A retry or re-delivered webhook cannot double-post. */
    idempotencyKey: text("idempotency_key"),
    /** Posted for demo data; excluded from real reports. */
    isDemo: flag("is_demo").notNull().default(false),
  },
  (t) => [
    uniqueIndex("journal_entries_idempotency_key_uq").on(t.idempotencyKey),
    uniqueIndex("journal_entries_reverses_uq").on(t.reversesId),
    index("journal_entries_period_idx").on(t.period, t.at),
    index("journal_entries_ref_idx").on(t.refType, t.refId),
    index("journal_entries_at_idx").on(t.at),
    check("journal_entries_period_check", sql`${t.period} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
  ],
);
export type JournalEntry = typeof journalEntries.$inferSelect;
export type NewJournalEntry = typeof journalEntries.$inferInsert;

/** [A] One side of an entry: exactly one of debit_iqd / credit_iqd is positive. */
export const journalLines = sqliteTable(
  "journal_lines",
  {
    id: id(),
    /** journal_entries.id — no FK on purpose, see the file header. */
    entryId: text("entry_id").notNull(),
    accountId: text("account_id")
      .notNull()
      .references((): Ref => accounts.id),
    debitIqd: iqd("debit_iqd").notNull().default(0),
    creditIqd: iqd("credit_iqd").notNull().default(0),
    /** cost_centers.code */
    costCenter: text("cost_center"),
    memo: text("memo"),
  },
  (t) => [
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_account_idx").on(t.accountId),
    index("journal_lines_cost_center_idx").on(t.costCenter),
    check("journal_lines_side_check", sql`(${t.debitIqd} > 0 AND ${t.creditIqd} = 0) OR (${t.debitIqd} = 0 AND ${t.creditIqd} > 0)`),
  ],
);
export type JournalLine = typeof journalLines.$inferSelect;
export type NewJournalLine = typeof journalLines.$inferInsert;

export const FISCAL_PERIOD_STATUSES = ["open", "closed"] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

/**
 * Month-end close (10.09). A period without a row is open. Once `closed`, no journal entry can be
 * dated into it — corrections are reversal entries in an open period.
 */
export const fiscalPeriods = sqliteTable("fiscal_periods", {
  period: text("period").primaryKey(),
  status: text("status", { enum: FISCAL_PERIOD_STATUSES }).notNull().default("open"),
  closedBy: text("closed_by"),
  closedAt: at("closed_at"),
  note: text("note"),
});
export type FiscalPeriod = typeof fiscalPeriods.$inferSelect;
export type NewFiscalPeriod = typeof fiscalPeriods.$inferInsert;

// ───────────────────────────────────────────────────────────────── expenses, FX, tax

export const EXPENSE_STATUSES = ["draft", "approved", "posted", "void"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** Operating expenses with cost centres (10.05). Posting creates the journal entry referenced here. */
export const expenses = sqliteTable(
  "expenses",
  {
    id: id(),
    /** Expense account debited. */
    accountId: text("account_id")
      .notNull()
      .references((): Ref => accounts.id),
    /** Cash / bank account credited. */
    paidFromAccountId: text("paid_from_account_id").references((): Ref => accounts.id),
    costCenter: text("cost_center"),
    amountIqd: iqd("amount_iqd").notNull(),
    vendor: text("vendor"),
    description: text("description").notNull(),
    /** "YYYY-MM-DD" (Asia/Baghdad). */
    incurredOn: text("incurred_on").notNull(),
    period: text("period").notNull(),
    /** Receipt / bill — private file. */
    receiptFileId: text("receipt_file_id").references((): Ref => files.id),
    status: text("status", { enum: EXPENSE_STATUSES }).notNull().default("draft"),
    approvedBy: text("approved_by"),
    approvedAt: at("approved_at"),
    journalEntryId: text("journal_entry_id"),
    /** What the expense was for, e.g. a campaign or a shipment. */
    refType: text("ref_type"),
    refId: text("ref_id"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("expenses_account_idx").on(t.accountId),
    index("expenses_paid_from_idx").on(t.paidFromAccountId),
    index("expenses_period_idx").on(t.period, t.status),
    index("expenses_cost_center_idx").on(t.costCenter),
    index("expenses_ref_idx").on(t.refType, t.refId),
    index("expenses_receipt_file_idx").on(t.receiptFileId),
    index("expenses_created_at_idx").on(t.createdAt),
    check("expenses_amount_check", sql`${t.amountIqd} > 0`),
  ],
);
export type Expense = typeof expenses.$inferSelect;
export type NewExpense = typeof expenses.$inferInsert;

/**
 * Exchange rates, newest `effective_at` wins (22.01). `iqd_per_unit` is how many IQD one unit of
 * `quote` costs. The storefront always shows the source and the time the rate was set; converted
 * prices are approximations and the payable currency is always IQD.
 */
export const fxRates = sqliteTable(
  "fx_rates",
  {
    id: id(),
    /** ISO 4217 code of the foreign currency, e.g. "USD". */
    quote: text("quote").notNull(),
    iqdPerUnit: integer("iqd_per_unit").notNull(),
    /** Human-readable source label, e.g. "TamTam store rate". */
    source: text("source").notNull(),
    /** Placeholder rate (ARCHITECTURE §11). */
    isDemo: flag("is_demo").notNull().default(false),
    effectiveAt: at("effective_at").notNull(),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [index("fx_rates_quote_idx").on(t.quote, t.effectiveAt), check("fx_rates_rate_check", sql`${t.iqdPerUnit} > 0`)],
);
export type FxRate = typeof fxRates.$inferSelect;
export type NewFxRate = typeof fxRates.$inferInsert;

/** Configurable tax rates (10.08, 22.02). None is seeded: the owner decides what applies. */
export const taxRates = sqliteTable(
  "tax_rates",
  {
    id: id(),
    code: text("code").notNull(),
    name: l10n("name").notNull(),
    rateBps: integer("rate_bps").notNull(),
    /** Prices already include this tax (it is reported, not added at checkout). */
    isInclusive: flag("is_inclusive").notNull().default(true),
    /** Scope, e.g. `{ productKinds: ["console"], channels: ["web"] }`; null = everything. */
    appliesTo: json<Record<string, unknown>>("applies_to"),
    isActive: flag("is_active").notNull().default(false),
    effectiveAt: at("effective_at"),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex("tax_rates_code_uq").on(t.code), check("tax_rates_rate_check", sql`${t.rateBps} >= 0 AND ${t.rateBps} <= 10000`)],
);
export type TaxRate = typeof taxRates.$inferSelect;
export type NewTaxRate = typeof taxRates.$inferInsert;

// ───────────────────────────────────────────────────────────────── statement reconciliation (10.02)

export const STATEMENT_LINE_STATUSES = ["unmatched", "matched", "ignored"] as const;
export type StatementLineStatus = (typeof STATEMENT_LINE_STATUSES)[number];

/**
 * Lines of the bank-card / Zain Cash / carrier statements, entered or imported by staff, to be
 * matched against `payments`. This is how manual transfers are reconciled with what actually arrived.
 */
export const statementLines = sqliteTable(
  "statement_lines",
  {
    id: id(),
    /** "bank_card" | "zaincash" | "carrier" | … */
    source: text("source").notNull(),
    occurredAt: at("occurred_at").notNull(),
    /** Positive = money in, negative = money out. */
    amountIqd: iqd("amount_iqd").notNull(),
    reference: text("reference"),
    counterparty: text("counterparty"),
    description: text("description"),
    raw: json<Record<string, unknown>>("raw"),
    /** sha256 of source + date + amount + reference: the same line is never imported twice. */
    dedupeHash: text("dedupe_hash").notNull(),
    status: text("status", { enum: STATEMENT_LINE_STATUSES }).notNull().default("unmatched"),
    matchedPaymentId: text("matched_payment_id").references((): Ref => payments.id),
    matchedBy: text("matched_by"),
    matchedAt: at("matched_at"),
    importJobId: text("import_job_id"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("statement_lines_dedupe_uq").on(t.dedupeHash),
    index("statement_lines_status_idx").on(t.status, t.occurredAt),
    index("statement_lines_reference_idx").on(t.reference),
    index("statement_lines_payment_idx").on(t.matchedPaymentId),
  ],
);
export type StatementLine = typeof statementLines.$inferSelect;
export type NewStatementLine = typeof statementLines.$inferInsert;
