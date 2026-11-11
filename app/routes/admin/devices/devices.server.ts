/**
 * Route glue shared by the pages of module 13 (devices, games & trade-in): open a request (session, permission,
 * database, language), the strings every page needs, how an expected failure becomes
 * `{ ok: false, intent, code, message, fields }` in the employee's language (status kept), and form readers that accept
 * Arabic-Indic and Persian digits.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openDevices(context, ["devices.tradein.read", "devices.tradein.inspect"]);
 *     …
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { L10n, Locale } from "~/lib/locales";
import { canAny } from "~/server/actor";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import type { Permission } from "~/server/permissions";

export const DEVICES_NS = "admin-devices";

export type DevicesRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/**
 * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). A list of
 * permissions means "any of them" (pages several roles use).
 */
export async function openDevices(context: Readonly<RouterContextProvider>, permission?: Permission | readonly Permission[]): Promise<DevicesRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const single = typeof permission === "string" ? permission : undefined;
  const session = await requireEmployee(ctx, db, single);
  if (Array.isArray(permission) && !canAny(session.actor, permission)) throw data({ error: "forbidden", permission: permission[0] }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function devicesI18n(locale: Locale) {
  return messagesFor(locale, DEVICES_NS, "errors");
}

/** `t()` over the module's strings first, then the shared "errors" namespace. */
export function devicesT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(DEVICES_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

/** An accessory's words in the three languages (stored on a used unit's `included`). */
export function accessoryWords(key: string): L10n | undefined {
  const ns = getNamespace(DEVICES_NS);
  if (!ns) return undefined;
  const ar = translate(ns.ar as MessageTree, "ar", `accessory.${key}`);
  if (!ar) return undefined;
  return { ar, en: translate(ns.en as MessageTree, "en", `accessory.${key}`) ?? ar, ckb: translate(ns.ckb as MessageTree, "ckb", `accessory.${key}`) ?? ar };
}

export type Failure = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };

/** An expected failure as data (status kept for the response); anything else is rethrown to the error boundary. */
export function failure(error: unknown, locale: Locale, intent: string | null): Failure {
  const result = actionError(error, devicesT(locale));
  return { ok: false, intent, code: result.code, message: result.message, fields: result.fields, status: result.status };
}

/** The failure as a response with its HTTP status. */
export function failed(error: unknown, locale: Locale, intent: string | null) {
  const result = failure(error, locale, intent);
  return data(result, { status: result.status });
}

export const urls = {
  file: (fileId: string) => `/admin/devices/files/${encodeURIComponent(fileId)}`,
};

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
  return value === "on" || value === "true" || value === "1" || value === "yes";
}
