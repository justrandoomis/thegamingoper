/**
 * Admin module 04 (inventory) — what every route of the module does on the server: open the request (session,
 * permission, database, language), turn expected failures into translated `{ ok: false }` results, and read form
 * values. Route modules import it from their loaders and actions only.
 *
 *   export async function loader({ context, request }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openInventory(context, "inventory.stock.read");
 *     …
 *   }
 *   export async function action({ context, request }: Route.ActionArgs) {
 *     const { db, actor, locale, now } = await openInventory(context, "inventory.stock.adjust");
 *     try { await adjustStock(db, actor, input, now); return ok({ message: … }); }
 *     catch (error) { return failed(error, locale); }
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import { randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, type ActionFailure } from "~/server/errors";
import type { Permission } from "~/server/permissions";

export type InventoryRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/** Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). */
export async function openInventory(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<InventoryRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, permission);
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

/** A translator over the module's strings first, then the shared "errors" namespace — never a missing-key warning. */
export function inventoryT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace("admin-inventory")?.[locale] as MessageTree | undefined;
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
 * rethrown to the error boundary. `{codes}` in a message is filled from the error's detail (unknown SKU codes).
 */
export function failed(error: unknown, locale: Locale, intent?: string) {
  const t = inventoryT(locale);
  const detail = (error as { detail?: unknown } | null)?.detail;
  const vars = typeof detail === "string" ? { codes: detail } : undefined;
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

export function optionalText(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === "" ? undefined : value;
}

/** A whole number typed in a field (Arabic-Indic digits accepted); undefined when empty, NaN when not a number. */
export function int(form: FormData, name: string): number | undefined {
  return toInt(text(form, name));
}

/** `int()` for one value (a field repeated per line, read with form.getAll). */
export function toInt(value: string): number | undefined {
  const raw = value
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[,٬\s]/g, "");
  if (raw === "") return undefined;
  return /^-?\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

/** One value per non-empty line of a textarea (scanned serial numbers, SKU lists). */
export function lines(form: FormData, name: string): string[] {
  return text(form, name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
