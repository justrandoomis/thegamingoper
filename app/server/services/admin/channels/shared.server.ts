/**
 * Admin module 21 "channels" — what every service of the module shares: who may do what (channelsAccess), ids derived
 * from a form's idempotency key, fingerprints that refuse a stale form, the reason rule, and names of employees.
 *
 * Authorization lives in the services (assertCan / assertAny before the input is read); the pages only decide what
 * to offer. Must not import "cloudflare:workers".
 */
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employees } from "~/server/db/schema";
import { mapDbError } from "~/server/db/tx.server";
import { AppError, forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { latinDigits, type ChannelsAccess } from "./types";

export const CHANNELS_PERMISSIONS = [
  "channels.branch.manage",
  "channels.channel.manage",
  "channels.api_key.manage",
  "channels.webhook.manage",
  "channels.integration.read",
  "channels.integration.manage",
  "channels.report.read",
] as const satisfies readonly Permission[];

export function hasAnyChannelsPermission(actor: Actor): boolean {
  return canAny(actor, CHANNELS_PERMISSIONS);
}

/**
 * False for an employee limited to one branch. The module's store-wide figures (orders and profitability of every
 * channel and branch, the store's net profit) and its connections (an API key or a webhook reads every branch) are
 * not theirs — as the reports (18) refuse them and the dashboard (01) keeps them to their branch.
 */
export function isWholeStore(actor: Actor): boolean {
  return actor.kind !== "employee" || actor.branchId === null || actor.branchId === undefined;
}

/** Throws forbidden("branch") (403) for an employee limited to one branch. */
export function assertWholeStore(actor: Actor): void {
  if (!isWholeStore(actor)) throw forbidden("branch");
}

/** What the employee may open in this module (the pages show only what is true here; the services check again). */
export function channelsAccess(actor: Actor): ChannelsAccess {
  const wholeStore = isWholeStore(actor);
  return {
    branches: can(actor, "channels.branch.manage"),
    channels: canAny(actor, ["channels.channel.manage", "channels.report.read"]),
    apiKeys: can(actor, "channels.api_key.manage"),
    webhooks: can(actor, "channels.webhook.manage"),
    monitor: canAny(actor, ["channels.integration.read", "channels.webhook.manage", "channels.integration.manage"]),
    providers: canAny(actor, ["channels.integration.read", "channels.integration.manage"]),
    profit: can(actor, "channels.report.read") && wholeStore,
    orders: can(actor, "orders.order.read") && wholeStore,
    cost: can(actor, "cost.read"),
    profitFields: can(actor, "cost.read") && can(actor, "profit.read"),
  };
}

export function assertAny(actor: Actor, permissions: readonly Permission[]): void {
  if (!canAny(actor, permissions)) throw forbidden(permissions.join("|"));
}

/** A link to another module's page, or null when the employee may not open it. */
export function linkIf(actor: Actor, permissions: readonly Permission[], href: string): string | null {
  return canAny(actor, permissions) ? href : null;
}

/** A record id derived from the form's idempotency key: the same form sent twice names the same record. */
export async function keyedId(prefix: string, actor: Actor, key: string): Promise<string> {
  const who = actor.kind === "employee" ? actor.id : actor.kind === "system" ? actor.job : actor.kind;
  return `${prefix}_${(await sha256Hex(`tamtam.channels.v1|${prefix}|${who}|${key}`)).slice(0, 26)}`;
}

/** A short, stable digest of the values a form was built from: a save must still match it. */
export async function fingerprintOf(value: unknown): Promise<string> {
  return (await sha256Hex(JSON.stringify(value))).slice(0, 24);
}

export const IdempotencyKey = z.string({ error: "required" }).trim().min(8, "required").max(128, "too_long");
export const Reason = z.string({ error: "reason_required" }).trim().min(3, "reason_required").max(500, "too_long");
export const OptionalReason = z.string().trim().max(500, "too_long").optional();
export const IdSchema = z.string({ error: "required" }).trim().min(1, "required").max(100, "too_long").regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "not_found");

/** A whole number typed with Latin, Arabic-Indic or Persian digits (and separators); undefined when empty. */
export function wholeNumber(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : Number.NaN;
  if (typeof raw !== "string") return undefined;
  const text = latinDigits(raw).replace(/[\s,٬،_]/g, "");
  if (text === "") return undefined;
  return /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
}

/** A guard of this module's batches failed: its code becomes the module's AppError; anything else is returned as is. */
export function guardError(error: unknown, codes: Record<string, [string, number]>): unknown {
  const info = mapDbError(error);
  if (!info) return error;
  const known = codes[info.code];
  return known ? new AppError(known[0], known[1], { detail: info.detail }) : error;
}

/** Employee id → name (ids of the system or of a job are left out). */
export async function employeeNames(db: Db, ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes(":")))];
  const out = new Map<string, string>();
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, unique.slice(i, i + 90)));
    for (const row of rows) out.set(row.id, row.name);
  }
  return out;
}

export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The Baghdad day of an instant, "YYYY-MM-DD". */
export function baghdadDay(at: number): string {
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}
