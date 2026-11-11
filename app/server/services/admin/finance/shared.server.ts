/**
 * Admin module 10 "finance" — what its services share: who may see what (one place for the permission rules of the
 * screens), employee and customer labels, fiscal-period states and the link from a journal reference to its page.
 *
 * Cost privacy (blueprint acceptance #5, ARCHITECTURE §5.1): the books carry purchase cost — COGS, inventory, stock
 * received, supplier bills — so every view of the journal itself (entries, account ledgers, trial balance, cash flow,
 * the inventory asset) needs `cost.read` on top of its finance permission. Without it the service refuses
 * (forbidden "cost.read"), and nothing of the books leaves the server.
 */
import { inArray, sql } from "drizzle-orm";
import { maskPhone, formatIraqPhone } from "~/lib/phone";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { customers, employees, fiscalPeriods } from "~/server/db/schema";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";

/** Every permission of the finance group (the module page opens for any of them). */
export const FINANCE_PERMISSIONS = [
  "finance.journal.read",
  "finance.journal.post",
  "finance.account.manage",
  "finance.period.close",
  "finance.settlement.reconcile",
  "finance.expense.manage",
  "finance.report.read",
  "finance.wallet.read",
  "finance.tax.manage",
  "finance.anomaly.read",
] as const satisfies readonly Permission[];

export type FinanceAccess = {
  /** The books (journal, accounts, trial balance): finance.journal.read + cost.read. */
  books: boolean;
  post: boolean;
  manageAccounts: boolean;
  close: boolean;
  /** The close page opens with either the books or the close permission. */
  closeView: boolean;
  reconcile: boolean;
  expenses: boolean;
  reports: boolean;
  wallet: boolean;
  /** Approve or reject top-ups, request and decide adjustments (creditWallet's permission). */
  walletDecide: boolean;
  tax: boolean;
  anomalies: boolean;
  cost: boolean;
  profit: boolean;
  proof: boolean;
  phoneFull: boolean;
};

export function financeAccess(actor: Actor): FinanceAccess {
  const cost = can(actor, "cost.read");
  const books = can(actor, "finance.journal.read") && cost;
  return {
    books,
    post: can(actor, "finance.journal.post") && cost,
    manageAccounts: can(actor, "finance.account.manage"),
    close: can(actor, "finance.period.close"),
    closeView: books || can(actor, "finance.period.close"),
    reconcile: can(actor, "finance.settlement.reconcile"),
    expenses: can(actor, "finance.expense.manage"),
    reports: can(actor, "finance.report.read"),
    wallet: can(actor, "finance.wallet.read"),
    walletDecide: can(actor, "finance.wallet.read") && can(actor, "customers.wallet.adjust"),
    tax: can(actor, "finance.tax.manage"),
    anomalies: can(actor, "finance.anomaly.read"),
    cost,
    profit: cost && can(actor, "profit.read"),
    proof: can(actor, "payment_proof.read"),
    phoneFull: can(actor, "customer.phone.read_full"),
  };
}

export function hasAnyFinancePermission(actor: Actor): boolean {
  return canAny(actor, FINANCE_PERMISSIONS);
}

/** The journal itself: finance.journal.read AND cost.read (see the file header). */
export function assertBooks(actor: Actor): void {
  assertCan(actor, "finance.journal.read");
  if (!can(actor, "cost.read")) throw forbidden("cost.read");
}

// ───────────────────────────────────────────────────────────────── labels

/** Employee id → name (ids that are not employees are left out). */
export async function employeeNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes(":")))];
  if (unique.length === 0) return new Map();
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, unique.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row.name);
  }
  return out;
}

/**
 * Who made a posting, as a view: an employee's name, the server ("system:<job>"), a customer ("customer:<id>"), or
 * nobody known. `kind` lets the screen word it.
 */
export type ByView = { kind: "employee" | "system" | "customer" | "unknown"; name: string | null };

export function byView(createdBy: string | null | undefined, names: Map<string, string>): ByView {
  if (!createdBy) return { kind: "unknown", name: null };
  if (createdBy.startsWith("system:")) return { kind: "system", name: createdBy.slice("system:".length) };
  if (createdBy.startsWith("customer:")) return { kind: "customer", name: null };
  const name = names.get(createdBy);
  return name ? { kind: "employee", name } : { kind: "unknown", name: null };
}

/** A phone as this employee may see it. */
export type PhoneView = { display: string; full: boolean };

export function phoneView(e164: string | null | undefined, full: boolean): PhoneView | null {
  if (!e164) return null;
  return full ? { display: formatIraqPhone(e164), full: true } : { display: maskPhone(e164), full: false };
}

export type CustomerLabel = { id: string; name: string | null; phone: PhoneView | null; isDemo: boolean; status: string };

export async function customerLabels(db: Db, ids: Iterable<string | null | undefined>, fullPhone: boolean): Promise<Map<string, CustomerLabel>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0))];
  const out = new Map<string, CustomerLabel>();
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db
      .select({ id: customers.id, name: customers.name, phone: customers.phoneE164, isDemo: customers.isDemo, status: customers.status })
      .from(customers)
      .where(inArray(customers.id, unique.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, { id: row.id, name: row.name, phone: phoneView(row.phone, fullPhone), isDemo: row.isDemo, status: row.status });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── fiscal periods

export async function closedPeriods(db: Db): Promise<Set<string>> {
  const rows = await db.select({ period: fiscalPeriods.period, status: fiscalPeriods.status }).from(fiscalPeriods);
  return new Set(rows.filter((row) => row.status === "closed").map((row) => row.period));
}

export async function isPeriodClosed(db: Db, period: string): Promise<boolean> {
  const rows = await db.all<{ status: string }>(sql`SELECT status FROM fiscal_periods WHERE period = ${period}`);
  return rows[0]?.status === "closed";
}

// ───────────────────────────────────────────────────────────────── references

/** Where a journal reference leads in the admin (null when it has no page yet). */
export type RefLink = { kind: "order" | "wallet" | "expense" | "entry" | "topup" | "none"; href: string | null; label: string | null };

/**
 * Admin links for journal references: orders by their public reference (payments and refunds through their order),
 * wallet credits to the customer's wallet page, expenses and manual entries to their pages.
 */
export async function refLinks(db: Db, refs: readonly { refType: string | null; refId: string | null; entryId: string }[]): Promise<Map<string, RefLink>> {
  const out = new Map<string, RefLink>();
  const orderIds = new Set<string>();
  const paymentIds = new Set<string>();
  const refundIds = new Set<string>();
  const ledgerIds = new Set<string>();
  for (const ref of refs) {
    if (!ref.refId) continue;
    if (ref.refType === "order") orderIds.add(ref.refId);
    else if (ref.refType === "payment") paymentIds.add(ref.refId);
    else if (ref.refType === "refund") refundIds.add(ref.refId);
    else if (ref.refType === "wallet_ledger") ledgerIds.add(ref.refId);
  }
  const list = (ids: Set<string>) =>
    sql.join(
      [...ids].map((id) => sql`${id}`),
      sql`, `,
    );
  const [payments, refunds, ledger] = await Promise.all([
    paymentIds.size ? db.all<{ id: string; orderId: string }>(sql`SELECT id, order_id AS orderId FROM payments WHERE id IN (${list(paymentIds)})`) : [],
    refundIds.size ? db.all<{ id: string; orderId: string }>(sql`SELECT id, order_id AS orderId FROM refunds WHERE id IN (${list(refundIds)})`) : [],
    ledgerIds.size ? db.all<{ id: string; customerId: string; refType: string | null; refId: string | null }>(sql`SELECT id, customer_id AS customerId, ref_type AS refType, ref_id AS refId FROM wallet_ledger WHERE id IN (${list(ledgerIds)})`) : [],
  ]);
  for (const row of payments) orderIds.add(row.orderId);
  for (const row of refunds) orderIds.add(row.orderId);
  const orderRefs = orderIds.size ? await db.all<{ id: string; ref: string }>(sql`SELECT id, ref FROM orders WHERE id IN (${list(orderIds)})`) : [];
  const refOf = new Map(orderRefs.map((row) => [row.id, row.ref]));
  const paymentOrder = new Map(payments.map((row) => [row.id, row.orderId]));
  const refundOrder = new Map(refunds.map((row) => [row.id, row.orderId]));
  const ledgerRow = new Map(ledger.map((row) => [row.id, row]));
  const orderLink = (orderId: string | undefined): RefLink => {
    const ref = orderId ? refOf.get(orderId) : undefined;
    return ref ? { kind: "order", href: `/admin/orders/${ref}`, label: ref } : { kind: "none", href: null, label: null };
  };
  for (const ref of refs) {
    let link: RefLink = { kind: "none", href: null, label: null };
    if (ref.refId) {
      switch (ref.refType) {
        case "order":
          link = orderLink(ref.refId);
          break;
        case "payment":
          link = orderLink(paymentOrder.get(ref.refId));
          break;
        case "refund":
          link = orderLink(refundOrder.get(ref.refId));
          break;
        case "wallet_ledger": {
          const row = ledgerRow.get(ref.refId);
          link = row ? { kind: "wallet", href: `/admin/finance/wallets/${row.customerId}`, label: null } : link;
          break;
        }
        case "expense":
          link = { kind: "expense", href: `/admin/finance/expenses/${ref.refId}`, label: null };
          break;
        case "manual":
          link = { kind: "entry", href: `/admin/finance/journal/${ref.entryId}`, label: null };
          break;
        default:
          break;
      }
    }
    out.set(ref.entryId, link);
  }
  return out;
}
