/**
 * Admin module 19 — what every service of the module shares: who may do what (`automationAccess`), the actor the
 * scheduled run acts as, deterministic ids, names of people, and the links into other modules that an employee may
 * open (a link to a page that would answer 403 is never sent).
 */
import { inArray } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { lineName } from "../../orders/place.server";
import { can, canAny, systemActor, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employees } from "~/server/db/schema";
import { AppError } from "~/server/errors";
import { PERMISSIONS, PERMISSION_DEFS, type Permission } from "~/server/permissions";
import type { PersonView } from "./types";

/** Every permission of the automation group (the module opens with any of them). */
export const AUTOMATION_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((permission) => PERMISSION_DEFS[permission].group === "automation");

export const hasAnyAutomationPermission = (actor: Actor) => canAny(actor, AUTOMATION_PERMISSIONS);

/** The scheduled run (and a person's "run now") acts as this system actor; its stamp is "system:automation.run". */
export const RUNNER_JOB = "automation.run";
export const runnerActor = () => systemActor(RUNNER_JOB);

export type AutomationAccess = {
  rules: boolean;
  manage: boolean;
  activate: boolean;
  suggestions: boolean;
  approve: boolean;
  /** Turning a suggestion into a draft purchase order also needs purchasing 09's own permissions (and its suppliers to choose from). */
  draftOrders: boolean;
  anomalies: boolean;
  assistant: boolean;
  tickets: boolean;
  cost: boolean;
};

export function automationAccess(actor: Actor): AutomationAccess {
  return {
    rules: can(actor, "automation.workflow.read"),
    manage: can(actor, "automation.workflow.manage"),
    activate: can(actor, "automation.workflow.activate"),
    suggestions: can(actor, "automation.suggestion.read"),
    approve: can(actor, "automation.suggestion.approve"),
    draftOrders: can(actor, "automation.suggestion.approve") && can(actor, "purchasing.po.create") && can(actor, "cost.read") && can(actor, "purchasing.supplier.read"),
    anomalies: can(actor, "automation.anomaly.read"),
    assistant: can(actor, "automation.assistant.use"),
    tickets: can(actor, "automation.workflow.read") && can(actor, "support.ticket.read"),
    cost: can(actor, "cost.read"),
  };
}

/** Rules act on the whole store: a branch-limited employee reads them but neither writes nor switches them on. */
export function assertWholeStore(actor: Actor): void {
  if (actor.kind === "employee" && actor.branchId) throw new AppError("branch_limited", 403, { detail: actor.branchId });
}

export const branchLimited = (actor: Actor) => actor.kind === "employee" && Boolean(actor.branchId);

/** The id the actor is stored under ("system:automation.run" for the scheduler). */
export function stampOf(actor: Actor): string | null {
  if (actor.kind === "employee" || actor.kind === "customer") return actor.id;
  if (actor.kind === "system") return `system:${actor.job}`;
  return null;
}

/** A rule runs at most once per event: the run's id is derived from both. */
export async function runIdFor(ruleId: string, eventKey: string): Promise<string> {
  return `wfr_${(await sha256Hex(`automation.run|${ruleId}|${eventKey}`)).slice(0, 26)}`;
}

/** The sample rows of a dry run: one id per rule, version, window and event. */
export async function dryRunIdFor(ruleId: string, version: number, at: number, eventKey: string): Promise<string> {
  return `wfd_${(await sha256Hex(`automation.dry|${ruleId}|${version}|${at}|${eventKey}`)).slice(0, 26)}`;
}

/** One reorder suggestion per SKU and stock episode (the latest arrival of stock): never two for the same need. */
export async function suggestionIdFor(variantId: string, episode: string): Promise<string> {
  return `rsg_${(await sha256Hex(`automation.suggestion|${variantId}|${episode}`)).slice(0, 26)}`;
}

export async function idFromKey(prefix: string, actor: Actor, key: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(`${stampOf(actor) ?? "anonymous"}:automation.${prefix}:${key}`)).slice(0, 26)}`;
}

/** id → name of employees (missing ids left out). */
export async function employeeNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, { name: string; active: boolean; isDemo: boolean }>> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.startsWith("emp")))];
  const out = new Map<string, { name: string; active: boolean; isDemo: boolean }>();
  for (let at = 0; at < wanted.length; at += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name, status: employees.status, isDemo: employees.isDemo }).from(employees).where(inArray(employees.id, wanted.slice(at, at + 90)));
    for (const row of rows) out.set(row.id, { name: row.name, active: row.status === "active", isDemo: row.isDemo });
  }
  return out;
}

const l10nOf = (value: unknown): L10n | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as L10n;
    } catch {
      return { ar: value };
    }
  }
  return value as L10n;
};

/** A SKU's name as order lines name it (the core's `lineName`: no product name said twice), in the admin's language. */
export function skuName(productName: unknown, variantTitle: unknown, locale: Locale): string {
  const product = l10nOf(productName) ?? { ar: "" };
  return pick(lineName(product, l10nOf(variantTitle)), locale);
}

/** Who did something: a person's name, the scheduler, or nobody. */
export function personOf(names: Map<string, { name: string }>, stamp: string | null | undefined): PersonView {
  if (!stamp) return null;
  if (stamp.startsWith("system:")) return { system: stamp.slice("system:".length) };
  const known = names.get(stamp);
  return known ? { id: stamp, name: known.name } : { id: stamp, name: "—" };
}

/** Where a record opens, for this employee (null when its page would refuse them). */
export function recordHref(actor: Actor, kind: string | null | undefined, ref: { id?: string | null; ref?: string | null; variantId?: string | null }): string | null {
  switch (kind) {
    case "order":
      return ref.ref && can(actor, "orders.order.read") ? `/admin/orders/${encodeURIComponent(ref.ref)}` : null;
    case "support_ticket":
      return ref.ref && can(actor, "support.ticket.read") ? `/admin/support/tickets/${encodeURIComponent(ref.ref)}` : null;
    case "stock_level":
    case "variant":
      return ref.variantId && can(actor, "inventory.stock.read") ? `/admin/inventory/stock/${encodeURIComponent(ref.variantId)}` : null;
    case "price_change":
      return ref.variantId && canAny(actor, PERMISSIONS.filter((permission) => PERMISSION_DEFS[permission].group === "pricing")) ? `/admin/pricing/skus/${encodeURIComponent(ref.variantId)}` : null;
    case "purchase_order":
      return ref.id && can(actor, "purchasing.po.read") ? `/admin/purchasing/orders/${encodeURIComponent(ref.id)}` : null;
    case "staff_task":
      return can(actor, "staff.task.manage") ? "/admin/staff/tasks" : null;
    default:
      return null;
  }
}
