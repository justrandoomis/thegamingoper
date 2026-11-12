/**
 * Admin module 16 "marketing" — what every service of the module shares: which sections an employee may open, the
 * permissions behind them, small readers (employee names, a record's audit history) and the error keys.
 *
 * Authorization lives in the services (assertCan before the input is read); the routes check again with
 * requireEmployee, and the shell's gate refuses the module to anyone holding no marketing.* permission.
 */
import { sql } from "drizzle-orm";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { type HistoryRow } from "./types";

export { MARKETING_ERROR_KEYS } from "./types";

/** Every permission of the module (the layout opens for any of them). */
export const MARKETING_PERMISSIONS: readonly Permission[] = [
  "marketing.campaign.manage",
  "marketing.campaign.send",
  "marketing.cart_recovery.manage",
  "marketing.utm.manage",
  "marketing.recommendation.manage",
  "marketing.review.moderate",
  "marketing.experiment.manage",
  "marketing.report.read",
];

/** What opens each section of the module (any of the listed permissions). */
export const SECTION_READ = {
  campaigns: ["marketing.campaign.manage", "marketing.campaign.send"],
  segments: ["marketing.campaign.manage", "marketing.campaign.send"],
  carts: ["marketing.cart_recovery.manage"],
  links: ["marketing.utm.manage", "marketing.report.read"],
  crossSell: ["marketing.recommendation.manage"],
  reviews: ["marketing.review.moderate"],
  performance: ["marketing.report.read"],
} as const satisfies Record<string, readonly Permission[]>;
export type MarketingSection = keyof typeof SECTION_READ;

export type MarketingAccess = Record<MarketingSection, boolean> & {
  campaignsManage: boolean;
  campaignsSend: boolean;
  linksManage: boolean;
  spend: boolean;
  phoneFull: boolean;
  customerRead: boolean;
};

export function marketingAccess(actor: Actor): MarketingAccess {
  const section = (name: MarketingSection) => canAny(actor, SECTION_READ[name]);
  return {
    campaigns: section("campaigns"),
    segments: section("segments"),
    carts: section("carts"),
    links: section("links"),
    crossSell: section("crossSell"),
    reviews: section("reviews"),
    performance: section("performance"),
    campaignsManage: can(actor, "marketing.campaign.manage"),
    campaignsSend: can(actor, "marketing.campaign.send"),
    linksManage: can(actor, "marketing.utm.manage"),
    spend: can(actor, "marketing.campaign.manage"),
    phoneFull: can(actor, "customer.phone.read_full"),
    customerRead: can(actor, "customers.customer.read"),
  };
}

/** Throws 403 unless the actor holds one of the permissions. */
export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions[0]);
}

export function actorId(actor: Actor): string | null {
  return actor.kind === "employee" ? actor.id : null;
}

export const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const rows = async <T>(db: Db, query: ReturnType<typeof sql>): Promise<T[]> => db.all<T>(query);

/** Employee display names by id (unknown ids are left out). */
export async function employeeNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (list.length === 0) return new Map();
  const found = await rows<{ id: string; name: string | null; email: string }>(db, sql`SELECT id, name, email FROM employees WHERE id IN (SELECT value FROM json_each(${JSON.stringify(list)}))`);
  return new Map(found.map((row) => [row.id, row.name?.trim() || row.email]));
}

/** The audit history of one record, newest first. */
export async function historyOf(db: Db, entityType: string, entityId: string, limit = 50): Promise<HistoryRow[]> {
  const found = await rows<{ id: string; action: string; actor_label: string | null; actor_kind: string; at: number; reason: string | null }>(
    db,
    sql`SELECT id, action, actor_label, actor_kind, at, reason FROM audit_events WHERE entity_type = ${entityType} AND entity_id = ${entityId} ORDER BY seq DESC LIMIT ${limit}`,
  );
  return found.map((row) => ({ id: row.id, action: row.action, actor: row.actor_label ?? (row.actor_kind === "system" ? null : null), at: num(row.at), reason: row.reason }));
}

/** `(SELECT value FROM json_each(?))` over a list — one bound parameter however long the list is. */
export const jsonList = (values: Iterable<string>) => sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(values)])}))`;
