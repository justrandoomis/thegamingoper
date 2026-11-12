/**
 * Admin module 18 "reports" — who may open what, and the small lookups every report shares.
 *
 *   const access = reportsAccess(actor);          // which reports, saving, exporting, cost, profit — for the screens
 *   assertReport(actor, "margin");                // the report's permission + the whole-company rule (services)
 *
 * The whole-company rule: every report here sums the whole store (the journal, every order, every customer). An
 * employee limited to one branch would read other branches' figures through them, so a branch-limited employee is
 * refused (403 "branch") — reports never widen what an account may see. Sections built on another module's service
 * (inventory 04, staff 15, support 14) also need that module's own read permission, which its service checks.
 */
import { sql } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { sha256Hex } from "~/lib/ids";
import { actorRef, assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { REPORT_KEYS, REPORT_PERMISSION, type ReportKey } from "./types";

/** Every permission of the module (the shell's gate opens /admin/reports for any of them). */
export const REPORTS_PERMISSIONS = [
  "reports.sales.read",
  "reports.margin.read",
  "reports.inventory.read",
  "reports.customer.read",
  "reports.performance.read",
  "reports.saved.manage",
  "reports.export.create",
  "reports.dictionary.manage",
] as const satisfies readonly Permission[];

export function hasAnyReportsPermission(actor: Actor): boolean {
  return canAny(actor, REPORTS_PERMISSIONS);
}

export type ReportsAccess = {
  /**
   * The reports this employee may OPEN: the report's permission and the whole-company rule — an employee limited to
   * a branch is refused every report, so no menu entry, card or link leads them to a 403 (review 2026-11-12).
   */
  reports: Record<ReportKey, boolean>;
  /** Save a report's view, rename, share and delete one's own (18.06) — never for a branch-limited employee. */
  saved: boolean;
  /** Download a report as CSV / XLSX (18.06) — never for a branch-limited employee. */
  export: boolean;
  /** cost.read: cost of goods, carrier costs, landed cost. */
  cost: boolean;
  /** cost.read AND profit.read: profit and margins (profit minus revenue would reveal cost — docs/metrics.md §1). */
  profit: boolean;
  /** False for an employee limited to one branch: the reports cover the whole company. */
  wholeCompany: boolean;
};

export function isWholeCompany(actor: Actor): boolean {
  return actor.kind !== "employee" || actor.branchId === null || actor.branchId === undefined;
}

export function reportsAccess(actor: Actor): ReportsAccess {
  const wholeCompany = isWholeCompany(actor);
  const reports = Object.fromEntries(REPORT_KEYS.map((key) => [key, wholeCompany && can(actor, REPORT_PERMISSION[key])])) as Record<ReportKey, boolean>;
  const cost = can(actor, "cost.read");
  return { reports, saved: wholeCompany && can(actor, "reports.saved.manage"), export: wholeCompany && can(actor, "reports.export.create"), cost, profit: cost && can(actor, "profit.read"), wholeCompany };
}

/** True when the employee may open this report (its permission and the whole-company rule) — what assertReport checks. */
export function mayOpenReport(actor: Actor, key: ReportKey): boolean {
  return isWholeCompany(actor) && can(actor, REPORT_PERMISSION[key]);
}

/** Refuses an employee limited to a branch (403 "branch"): the reports sum the whole company. */
export function assertWholeCompany(actor: Actor): void {
  if (!isWholeCompany(actor)) throw forbidden("branch");
}

/** The report's own permission, then the whole-company rule. */
export function assertReport(actor: Actor, key: ReportKey): void {
  assertCan(actor, REPORT_PERMISSION[key]);
  assertWholeCompany(actor);
}

export const num = (value: unknown): number => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** A stored L10n (JSON text or object) in the admin's language. */
export function l10nText(value: unknown, locale: Locale): string {
  if (value && typeof value === "object") return pick(value as L10n, locale);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") return pick(parsed as L10n, locale);
    } catch {
      return value;
    }
    return value;
  }
  return "";
}

/** Platform id → name, in the admin's language. */
export async function platformNames(db: Db, locale: Locale): Promise<Map<string, string>> {
  const rows = await db.all<{ id: string; name: string }>(sql`SELECT id, name FROM platforms`);
  return new Map(rows.map((row) => [row.id, l10nText(row.name, locale)]));
}

/** Branch id → name, in the admin's language. */
export async function branchNames(db: Db, locale: Locale): Promise<Map<string, string>> {
  const rows = await db.all<{ id: string; name: string }>(sql`SELECT id, name FROM branches`);
  return new Map(rows.map((row) => [row.id, l10nText(row.name, locale)]));
}

/** A record id derived from the form's idempotency key: a double submit finds the first record instead of a second. */
export async function idFromKey(prefix: string, actor: Actor, key: string): Promise<string> {
  const who = actorRef(actor).actorId ?? "anonymous";
  return `${prefix}_${(await sha256Hex(`tamtam.reports.v1|${prefix}|${who}|${key}`)).slice(0, 26)}`;
}

export const actorIdOf = (actor: Actor): string | null => actorRef(actor).actorId;
