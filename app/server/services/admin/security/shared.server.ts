/**
 * Admin module 20 "security" — what its services share: which parts an employee may open (the pages and the services
 * use the same answer), employee names, the masking of what was typed at a sign-in (full phone numbers only with
 * customer.phone.read_full — docs/STATUS.md §4 asked this of the module), and how audit snapshots are cut for
 * employees without cost.read / profit.read (blueprint acceptance #5: supplier cost never reaches them, not even
 * through the audit trail).
 */
import { eq, inArray } from "drizzle-orm";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import { summarizeUserAgent } from "~/routes/admin/shell/ua";
import { can, canAny, type Actor } from "~/server/actor";
import { maskPhonesIn } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { employeeRoles, employees, rolePermissions } from "~/server/db/schema";
import { forbidden } from "~/server/errors";
import { WILDCARD_PERMISSION, isPermission, type Permission } from "~/server/permissions";

export type SecurityAccess = {
  staff: boolean;
  revoke: boolean;
  resetTwoStep: boolean;
  roles: boolean;
  manageRoles: boolean;
  audit: boolean;
  verify: boolean;
  signins: boolean;
  refunds: boolean;
  backups: boolean;
  retention: boolean;
  reviews: boolean;
};

export function securityAccess(actor: Actor): SecurityAccess {
  return {
    staff: can(actor, "security.session.read"),
    revoke: can(actor, "security.session.revoke"),
    resetTwoStep: can(actor, "security.mfa.manage"),
    roles: canAny(actor, ["staff.manage", "security.access_review.perform", "security.session.read"]),
    manageRoles: can(actor, "staff.manage"),
    audit: can(actor, "audit.read"),
    verify: can(actor, "security.audit.verify"),
    signins: can(actor, "security.auth_event.read"),
    refunds: can(actor, "security.fraud.review"),
    backups: can(actor, "security.backup.manage"),
    retention: canAny(actor, ["security.retention.manage", "security.access_review.perform", "audit.read"]),
    reviews: can(actor, "security.access_review.perform"),
  };
}

/** Throws 403 (naming the first permission) unless the actor holds one of them. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

export const actorIdOf = (actor: Actor): string | null => (actor.kind === "employee" ? actor.id : null);

/**
 * True when the actor holds every permission of `stored` — what giving or taking away those permissions, or acting
 * against the second factor or the reach of someone who holds them, requires. The wildcard is held only by the wildcard
 * (the owner); strings that are no permission (any more) grant nothing and are ignored.
 */
export function holdsAll(actor: Actor, stored: readonly string[]): boolean {
  if (actor.kind === "system") return true;
  if (actor.kind !== "employee") return false;
  const held = new Set<string>(actor.permissions as Iterable<string>);
  if (held.has(WILDCARD_PERMISSION)) return true;
  return stored.every((permission) => (permission === WILDCARD_PERMISSION ? false : !isPermission(permission) || held.has(permission)));
}

/** The stored permissions of all of an employee's roles ("*" for an owner), each once. */
export async function storedPermissionsOf(db: Db, employeeId: string): Promise<string[]> {
  const rows = await db.select({ permission: rolePermissions.permission }).from(employeeRoles).innerJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId)).where(eq(employeeRoles.employeeId, employeeId));
  return [...new Set(rows.map((row) => row.permission))];
}

/** id → name of employees (missing ids are left out). */
export async function employeeNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (wanted.length === 0) return new Map();
  const rows: { id: string; name: string }[] = [];
  for (let at = 0; at < wanted.length; at += 90) rows.push(...(await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, wanted.slice(at, at + 90)))));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * What a person typed at a sign-in, as this employee may see it: e-mails as typed (staff sign in with an e-mail), phone
 * numbers in full only with customer.phone.read_full, otherwise "0771 ••• ••52" (also inside longer text).
 */
export function identifierFor(actor: Actor, identifier: string | null): { text: string | null; masked: boolean } {
  if (!identifier) return { text: null, masked: false };
  if (can(actor, "customer.phone.read_full")) return { text: identifier, masked: false };
  const e164 = normalizeIraqPhone(identifier);
  if (e164) return { text: maskPhone(e164), masked: true };
  const masked = maskPhonesIn(identifier);
  return { text: masked, masked: masked !== identifier };
}

export function deviceOf(userAgent: string | null | undefined): { browser: string | null; system: string | null } {
  return summarizeUserAgent(userAgent);
}

// ───────────────────────────────────────────────────────────────── cost in the audit trail

/** Families whose snapshots ARE cost data (supplier prices, landed costs, the books): withheld whole without cost.read. */
const COST_ACTION_PREFIXES = ["pricing.cost", "pricing.landed", "pricing.margin", "purchasing.", "finance."] as const;
const COST_KEY = /cost|landed|cogs|supplier_?price|unit_?price_?minor|margin|profit/i;
const PROFIT_KEY = /margin|profit/i;

/**
 * Families whose snapshots are people's pay (salaries, payroll runs and their items, advances — admin 15): withheld
 * whole without staff.payroll.read, the permission the staff module itself asks before it shows any of it (follow-up
 * 2026-11-12: an audit reader saw every salary change and payroll item through the trail).
 */
const PAY_ACTION_PREFIXES = ["staff.payroll."] as const;

export function snapshotWithheld(actor: Actor, action: string): boolean {
  if (!can(actor, "staff.payroll.read") && PAY_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix))) return true;
  return !can(actor, "cost.read") && COST_ACTION_PREFIXES.some((prefix) => action.startsWith(prefix));
}

/** A snapshot without the keys this employee may not see (cost without cost.read, margins without profit.read). */
export function cutSnapshot(actor: Actor, value: unknown): unknown {
  const noCost = !can(actor, "cost.read");
  const noProfit = !can(actor, "profit.read");
  if (!noCost && !noProfit) return value;
  const walk = (node: unknown, depth: number): unknown => {
    if (depth > 10 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if ((noCost && COST_KEY.test(key)) || (noProfit && PROFIT_KEY.test(key))) continue;
      out[key] = walk(item, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}
