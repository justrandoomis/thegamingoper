/**
 * Admin module 23 "ops" — what its services share: who may see and do what (one place, from the permission
 * catalogue), names of employees, the employees who may own an incident or be given a finding, the cost / profit cut of
 * free-form counters, and the readable label and link of a record another module owns (a SKU at a location, an order,
 * a customer's wallet, a journal entry) — a link only when the employee may open that page.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { can, canAll, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { consistencyFindings, customers, employees, inventoryLocations, orders, payments, refunds, variants } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import type { Permission } from "~/server/permissions";
import { COST_KEY, PROFIT_KEY, type ActorView, type EntityView, type Person } from "./types";

export const OPS_PERMISSIONS = [
  "ops.error.read",
  "ops.error.resolve",
  "ops.performance.read",
  "ops.job.read",
  "ops.job.run",
  "ops.backup.read",
  "ops.incident.read",
  "ops.incident.manage",
  "ops.consistency.read",
  "ops.consistency.resolve",
] as const satisfies readonly Permission[];

export type OpsAccess = {
  errors: boolean;
  resolveErrors: boolean;
  performance: boolean;
  jobs: boolean;
  runJobs: boolean;
  backups: boolean;
  incidents: boolean;
  manageIncidents: boolean;
  consistency: boolean;
  resolveFindings: boolean;
  cost: boolean;
  profit: boolean;
  /** Wallet money (a customer's balance, the wallet liability): customers.wallet.read or finance.wallet.read. */
  wallet: boolean;
  /** Module 20's page where restore tests are recorded (security.backup.manage). */
  securityBackups: boolean;
};

/** What this employee may see and do in the module (the services check each permission again). */
export function opsAccess(actor: Actor): OpsAccess {
  return {
    errors: can(actor, "ops.error.read"),
    resolveErrors: canAll(actor, ["ops.error.read", "ops.error.resolve"]),
    performance: can(actor, "ops.performance.read"),
    jobs: can(actor, "ops.job.read"),
    runJobs: canAll(actor, ["ops.job.read", "ops.job.run"]),
    backups: can(actor, "ops.backup.read"),
    incidents: can(actor, "ops.incident.read"),
    manageIncidents: canAll(actor, ["ops.incident.read", "ops.incident.manage"]),
    consistency: can(actor, "ops.consistency.read"),
    resolveFindings: canAll(actor, ["ops.consistency.read", "ops.consistency.resolve"]),
    cost: can(actor, "cost.read"),
    profit: canAll(actor, ["cost.read", "profit.read"]),
    wallet: canAny(actor, ["customers.wallet.read", "finance.wallet.read"]),
    securityBackups: can(actor, "security.backup.manage"),
  };
}

// ───────────────────────────────────────────────────────────────── branch limits (findings)

/**
 * The branch of the record a consistency finding is about: a stock level's location, an order's (also a payment's or a
 * refund's order); NULL for what belongs to the whole company (the books, the wallets, the company's warehouse, a web
 * order). Read inside the statement, so it is the record's branch now.
 */
export const findingBranchSql: SQL = sql`(CASE ${consistencyFindings.entityType}
  WHEN 'stock_level' THEN (SELECT l.branch_id FROM inventory_locations AS l WHERE l.id = substr(${consistencyFindings.entityId}, instr(${consistencyFindings.entityId}, '@') + 1))
  WHEN 'order' THEN (SELECT o.branch_id FROM orders AS o WHERE o.id = ${consistencyFindings.entityId})
  WHEN 'payment' THEN (SELECT o.branch_id FROM payments AS p JOIN orders AS o ON o.id = p.order_id WHERE p.id = ${consistencyFindings.entityId})
  WHEN 'refund' THEN (SELECT o.branch_id FROM refunds AS r JOIN orders AS o ON o.id = r.order_id WHERE r.id = ${consistencyFindings.entityId})
  ELSE NULL END)`;

/**
 * Which findings this employee may see and act on (SECURITY.md §7, `canAccessBranch`): everything without a branch
 * limit; with one, only findings about that branch's records — never another branch's, nor the company-wide ones.
 * Undefined when there is no limit (no condition).
 */
export function findingScope(actor: Actor): SQL | undefined {
  if (actor.kind !== "employee" || actor.branchId == null) return undefined;
  return sql`coalesce(${findingBranchSql} = ${actor.branchId}, 0)`;
}

export function hasAnyOpsPermission(actor: Actor): boolean {
  return canAny(actor, OPS_PERMISSIONS);
}

/** Employee id → name (ids that are not employees — "system:…" — are left out). */
export async function employeeNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== "" && !id.startsWith("system:")))];
  const out = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, wanted.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row.name);
  }
  return out;
}

/** Active employees whose roles grant `permission` (or everything), by name — who may own an incident or take a finding. */
export async function staffHolding(db: Db, permission: Permission, options: { branchOf?: string | null } = {}): Promise<Person[]> {
  // with `branchOf` (a record's branch, null = the whole company): only people who may open that record — no branch
  // limit, or limited to exactly that branch
  const branch = options.branchOf === undefined ? sql`` : options.branchOf === null ? sql` AND e.branch_id IS NULL` : sql` AND (e.branch_id IS NULL OR e.branch_id = ${options.branchOf})`;
  return db.all<Person>(sql`
    SELECT DISTINCT e.id AS id, e.name AS name FROM employees AS e
    JOIN employee_roles AS er ON er.employee_id = e.id
    JOIN role_permissions AS rp ON rp.role_id = er.role_id
    WHERE e.status = 'active' AND rp.permission IN (${permission}, '*')${branch}
    ORDER BY e.name, e.id`);
}

/** True when the employee is active and one of their roles grants `permission` (or everything). */
export async function employeeHolds(db: Db, employeeId: string, permission: Permission): Promise<boolean> {
  const rows = await db.all<{ n: number }>(sql`
    SELECT count(*) AS n FROM employees AS e
    JOIN employee_roles AS er ON er.employee_id = e.id
    JOIN role_permissions AS rp ON rp.role_id = er.role_id
    WHERE e.id = ${employeeId} AND e.status = 'active' AND rp.permission IN (${permission}, '*')`);
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Free-form counters or details without what this employee may not see: keys that name cost (cost, COGS, landed,
 * valuation…) need cost.read, keys that name margin or profit need cost.read and profit.read. Nested objects are cut
 * the same way. `withheld` says whether anything was removed (the page says so instead of showing a made-up zero).
 */
export function cutProtected(value: Record<string, unknown> | null | undefined, access: { cost: boolean; profit: boolean }): { value: Record<string, unknown> | null; withheld: boolean } {
  if (!value || typeof value !== "object") return { value: null, withheld: false };
  let withheld = false;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 6 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.slice(0, 50).map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if ((PROFIT_KEY.test(key) && !access.profit) || (COST_KEY.test(key) && !access.cost)) {
        withheld = true;
        continue;
      }
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return { value: walk(value, 0) as Record<string, unknown>, withheld };
}

/** "system:consistency.daily" / an employee id / null → who it was. */
export function actorOf(by: string | null | undefined, names: Map<string, string>): ActorView {
  if (!by) return null;
  if (by.startsWith("system:")) return { kind: "system", job: by.slice("system:".length) };
  return { kind: "employee", name: names.get(by) ?? by };
}

/** An audit event's actor as the history shows it. */
export function auditActorOf(row: { actorKind: string; actorId: string | null; actorLabel: string | null }): ActorView {
  if (row.actorKind === "system") return { kind: "system", job: row.actorId ?? row.actorLabel ?? "" };
  if (row.actorKind === "employee") return { kind: "employee", name: row.actorLabel ?? row.actorId ?? "" };
  return null;
}

// ───────────────────────────────────────────────────────────────── records owned by other modules

type EntityRef = { type: string | null; id: string | null };

/**
 * The readable label and link of records named by type + id (consistency findings, incident links): a SKU and a
 * location for a stock level ("variant@location"), an order's reference for an order, payment or refund, a customer's
 * name, an account's system key, a journal entry's id. A link is given only when this employee may open the page it
 * leads to; a record that no longer exists keeps its id as the label.
 */
export async function entityViews(db: Db, actor: Actor, refs: readonly EntityRef[]): Promise<Map<string, EntityView>> {
  const key = (ref: EntityRef) => `${ref.type ?? ""}|${ref.id ?? ""}`;
  const stock = refs.filter((ref) => ref.type === "stock_level" && ref.id?.includes("@"));
  const variantIds = [...new Set(stock.map((ref) => ref.id!.split("@")[0]))];
  const locationIds = [...new Set(stock.map((ref) => ref.id!.split("@")[1]))];
  const orderIds = [...new Set(refs.filter((ref) => ref.type === "order" && ref.id).map((ref) => ref.id!))];
  const paymentIds = [...new Set(refs.filter((ref) => ref.type === "payment" && ref.id).map((ref) => ref.id!))];
  const refundIds = [...new Set(refs.filter((ref) => ref.type === "refund" && ref.id).map((ref) => ref.id!))];
  const customerIds = [...new Set(refs.filter((ref) => ref.type === "customer" && ref.id).map((ref) => ref.id!))];

  const chunks = <T>(list: T[]) => {
    const out: T[][] = [];
    for (let i = 0; i < list.length; i += 90) out.push(list.slice(i, i + 90));
    return out;
  };
  const [variantRows, locationRows, orderRows, paymentRows, refundRows, customerRows] = await Promise.all([
    Promise.all(chunks(variantIds).map((ids) => db.select({ id: variants.id, sku: variants.sku }).from(variants).where(inArray(variants.id, ids)))).then((parts) => parts.flat()),
    Promise.all(chunks(locationIds).map((ids) => db.select({ id: inventoryLocations.id, code: inventoryLocations.code }).from(inventoryLocations).where(inArray(inventoryLocations.id, ids)))).then((parts) => parts.flat()),
    Promise.all(chunks(orderIds).map((ids) => db.select({ id: orders.id, ref: orders.ref }).from(orders).where(inArray(orders.id, ids)))).then((parts) => parts.flat()),
    Promise.all(chunks(paymentIds).map((ids) => db.select({ id: payments.id, ref: orders.ref }).from(payments).innerJoin(orders, eq(orders.id, payments.orderId)).where(inArray(payments.id, ids)))).then((parts) => parts.flat()),
    Promise.all(chunks(refundIds).map((ids) => db.select({ id: refunds.id, ref: orders.ref }).from(refunds).innerJoin(orders, eq(orders.id, refunds.orderId)).where(inArray(refunds.id, ids)))).then((parts) => parts.flat()),
    Promise.all(chunks(customerIds).map((ids) => db.select({ id: customers.id, name: customers.name }).from(customers).where(and(inArray(customers.id, ids))))).then((parts) => parts.flat()),
  ]);
  const sku = new Map(variantRows.map((row) => [row.id, row.sku]));
  const location = new Map(locationRows.map((row) => [row.id, row.code]));
  const orderRef = new Map<string, string>([...orderRows, ...paymentRows, ...refundRows].map((row) => [row.id, row.ref]));
  const customerName = new Map(customerRows.map((row) => [row.id, row.name]));

  const orderPage = can(actor, "orders.order.read");
  const stockPage = can(actor, "inventory.stock.read");
  const walletPage = can(actor, "finance.wallet.read");
  // A customer appears in the wallet checks only: who has a wallet problem is wallet information — the name only with a
  // wallet permission, the opaque id otherwise (follow-up 2026-11-12: the amount was hidden, the name was not).
  const walletReader = canAny(actor, ["customers.wallet.read", "finance.wallet.read"]);
  const booksPage = canAny(actor, ["finance.journal.read", "finance.report.read"]) && can(actor, "cost.read");

  const out = new Map<string, EntityView>();
  for (const ref of refs) {
    const k = key(ref);
    if (out.has(k)) continue;
    const id = ref.id;
    let label: string | null = id;
    let href: string | null = null;
    switch (ref.type) {
      case "stock_level": {
        const [variantId, locationId] = (id ?? "").split("@");
        label = `${sku.get(variantId) ?? variantId} @ ${location.get(locationId) ?? locationId}`;
        href = stockPage && variantId ? `/admin/inventory/stock/${encodeURIComponent(variantId)}` : null;
        break;
      }
      case "order":
      case "payment":
      case "refund": {
        const ref_ = id ? orderRef.get(id) : undefined;
        label = ref_ ?? id;
        href = orderPage && ref_ ? `/admin/orders/${encodeURIComponent(ref_)}` : null;
        break;
      }
      case "customer":
        label = walletReader ? (id && customerName.get(id)) || id : id;
        href = walletPage && id ? `/admin/finance/wallets/${encodeURIComponent(id)}` : null;
        break;
      case "account":
        href = booksPage && id && /^[a-z_]+$/.test(id) ? `/admin/finance/accounts/${encodeURIComponent(accountId(id as Parameters<typeof accountId>[0]))}` : null;
        break;
      case "journal_entry":
        href = booksPage && id ? `/admin/finance/journal/${encodeURIComponent(id)}` : null;
        break;
      default:
        break;
    }
    out.set(k, { type: ref.type, id, label, href });
  }
  return out;
}

export const entityKey = (type: string | null, id: string | null) => `${type ?? ""}|${id ?? ""}`;
