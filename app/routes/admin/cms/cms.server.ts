/**
 * Route glue of admin module 17 (content): open a request (session, permission — "any of" for pages several
 * permissions open —, database, language), the module's strings sent once by its layout, an expected failure as a
 * translated `{ ok: false, intent, code, message, fields }` with its HTTP status, and form readers (Arabic-Indic and
 * Persian digits are read by the services' parsers).
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openCms(context, "cms.banner.manage");
 *     return { list: await orRespond(() => listBanners(db, actor, filters, locale, now)) };
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { canAny } from "~/server/actor";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, throwAsResponse } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { CMS_NS } from "~/server/services/admin/cms/rules";

export type CmsRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/** Signs the request in (redirect to sign-in otherwise) and checks the permission; a list means "any of them" (403). */
export async function openCms(context: Readonly<RouterContextProvider>, permission?: Permission | readonly Permission[]): Promise<CmsRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const single = typeof permission === "string" ? permission : undefined;
  const session = await requireEmployee(ctx, db, single);
  if (Array.isArray(permission) && !canAny(session.actor, permission)) throw data({ error: "forbidden", permission: permission[0] }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function cmsI18n(locale: Locale) {
  return messagesFor(locale, CMS_NS, "errors");
}

/** The module's strings first, then the shared "errors" namespace. */
export function cmsT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(CMS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type CmsFailure = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };

/** An expected failure as data with its status; anything unexpected goes to the error boundary. */
export function failed(error: unknown, locale: Locale, intent: string | null) {
  if (error instanceof Response) throw error;
  const result = actionError(error, cmsT(locale));
  return data({ ok: false as const, intent, code: result.code, message: result.message, fields: result.fields, status: result.status } satisfies CmsFailure, { status: result.status });
}

/** For loaders: an expected failure (a missing permission, a missing row) answers with its status. */
export async function orRespond<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwAsResponse(error);
  }
}

export function ok<T extends Record<string, unknown>>(intent: string, value: T = {} as T) {
  return { ok: true as const, intent, ...value };
}

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** The raw value (multi-line text keeps its line breaks). */
export function raw(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === "" ? undefined : value;
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

export function all(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

/** A localized text from fields `<name>.ar`, `<name>.en`, `<name>.ckb`. */
export function l10n(form: FormData, name: string): { ar: string; en: string; ckb: string } {
  return { ar: text(form, `${name}.ar`), en: text(form, `${name}.en`), ckb: text(form, `${name}.ckb`) };
}

export function json(form: FormData, name: string): unknown {
  const value = form.get(name);
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
