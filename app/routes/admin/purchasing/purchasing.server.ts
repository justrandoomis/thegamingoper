/**
 * Admin module 09 (purchasing) — what every route of the module does on the server: open the request (session,
 * permission, database, language), turn expected failures into translated `{ ok: false }` results, and read form
 * values. Route modules import it from their loaders and actions only.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.read");
 *   }
 *   export async function action({ context, request }: Route.ActionArgs) {
 *     const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.create");
 *     try { …; return ok({ intent }); } catch (error) { return failed(error, locale, intent); }
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import { randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { canAny } from "~/server/actor";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, type ActionFailure } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { PURCHASING_PERMISSIONS } from "~/server/services/admin/purchasing/shared.server";

export type PurchasingRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/**
 * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). With a list, any one
 * of them; without one, any permission of the purchasing group (the module's own pages).
 */
export async function openPurchasing(context: Readonly<RouterContextProvider>, permission?: Permission | readonly Permission[]): Promise<PurchasingRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  let session: EmployeeSession;
  if (typeof permission === "string") session = await requireEmployee(ctx, db, permission);
  else {
    session = await requireEmployee(ctx, db);
    const list = permission ?? PURCHASING_PERMISSIONS;
    if (!canAny(session.actor, list)) throw data({ error: "forbidden", permission: list[0] }, { status: 403 });
  }
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

/** A translator over the module's strings first, then the shared "errors" namespace — never a missing-key warning. */
export function purchasingT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace("admin-purchasing")?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type ActionOk<T extends Record<string, unknown> = Record<string, unknown>> = { ok: true; intent?: string; message?: string } & T;
export type ActionResult<T extends Record<string, unknown> = Record<string, unknown>> = ActionOk<T> | (ActionFailure & { intent?: string });

export function ok<T extends Record<string, unknown>>(value: T & { intent?: string; message?: string }) {
  return { ok: true as const, ...value };
}

/**
 * An expected failure as a translated result with its HTTP status (400 / 403 / 404 / 409); anything unexpected is
 * rethrown to the error boundary. `{detail}` in a message is filled from the error's detail (unknown codes, SKUs).
 */
export function failed(error: unknown, locale: Locale, intent?: string) {
  const t = purchasingT(locale);
  const detail = (error as { detail?: unknown } | null)?.detail;
  const vars = typeof detail === "string" ? { detail } : undefined;
  const failure = actionError(error, (key, extra) => t(key, { ...(vars ?? {}), ...(extra ?? {}) }));
  return data({ ...failure, intent }, { status: failure.status });
}

/** A fresh idempotency key for a form (one per render; a resubmission of the same render is a replay). */
export function newKey(): string {
  return randomToken(18);
}

// ───────────────────────────────────────────────────────────────── form values

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === "" ? undefined : value;
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

/** One value per non-empty line of a textarea (scanned serial numbers). */
export function linesOf(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Repeated row fields named `<prefix>.<i>.<field>` (form rows), in row order:
 *   rows(form, "lines", ["code", "qty", "unitCost"]) → [{ code, qty, unitCost }, …]
 */
export function rows<F extends string>(form: FormData, prefix: string, names: readonly F[]): Record<F, string>[] {
  const indexes = new Set<number>();
  for (const key of form.keys()) {
    const match = new RegExp(`^${prefix}\\.(\\d{1,3})\\.`).exec(key);
    if (match) indexes.add(Number(match[1]));
  }
  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => Object.fromEntries(names.map((name) => [name, text(form, `${prefix}.${index}.${name}`)])) as Record<F, string>);
}

/** Fields keyed by a record id: `<prefix>:<id>:<field>` → [{ id, …fields }]. */
export function keyed<F extends string>(form: FormData, prefix: string, names: readonly F[]): ({ id: string } & Record<F, string>)[] {
  const ids = new Set<string>();
  for (const key of form.keys()) {
    const match = new RegExp(`^${prefix}:([A-Za-z0-9_.:-]{1,128}):[a-zA-Z]+$`).exec(key);
    if (match) ids.add(match[1]);
  }
  return [...ids].map((id) => ({ id, ...(Object.fromEntries(names.map((name) => [name, text(form, `${prefix}:${id}:${name}`)])) as Record<F, string>) }));
}
