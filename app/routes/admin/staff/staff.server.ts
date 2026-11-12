/**
 * Admin module 15 (staff) — what every route of the module does on the server: open the request (session, permission,
 * database, language), send the module's strings once from its layout, turn an expected failure into a translated
 * `{ ok: false }` result with its HTTP status, and read form values (Arabic-Indic and Persian digits accepted). Route
 * modules import it from their loaders and actions only.
 *
 *   export async function action({ context, request }: Route.ActionArgs) {
 *     const req = await openStaff(context, "staff.schedule.manage");
 *     try { …; return ok(intent, { message }); } catch (error) { return failed(error, req.locale, intent); }
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, throwAsResponse, toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { parseWhole, STAFF_NS } from "~/server/services/admin/staff/types";

export type StaffRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/** Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). */
export async function openStaff(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<StaffRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, permission);
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

/** The module's strings and the shared error texts, sent once by the module's layout. */
export function staffI18n(locale: Locale) {
  return messagesFor(locale, STAFF_NS, "errors");
}

/** A translator over the module's strings first, then the shared "errors" namespace. */
export function staffT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(STAFF_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export function ok<T extends Record<string, unknown>>(intent: string, value: T = {} as T) {
  return { ok: true as const, intent, ...value };
}

/** An expected failure as a translated result with its HTTP status; anything unexpected goes to the error boundary. */
export function failed(error: unknown, locale: Locale, intent: string | null) {
  if (error instanceof Response) throw error;
  const t = staffT(locale);
  const failure = actionError(error, (key, vars) => t(key, vars));
  return data({ ok: false as const, intent, code: failure.code, message: failure.message, fields: failure.fields, status: failure.status }, { status: failure.status });
}

/** For loaders: an expected failure (a missing permission, an unknown id) becomes its HTTP status. */
export async function orRespond<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // a missing permission names itself, as requireEmployee's 403 does (the shell's error page shows it)
    const appError = toAppError(error);
    if (appError?.code === "forbidden" && appError.detail && /^[a-z_.|]+$/.test(appError.detail)) throw data({ error: "forbidden", permission: appError.detail.split("|").join(" · ") }, { status: 403 });
    throwAsResponse(error);
  }
}

// ───────────────────────────────────────────────────────────────── form values

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optional(form: FormData, name: string): string | null {
  const value = text(form, name);
  return value === "" ? null : value;
}

/** A whole number of dinars; 0 when the field is empty and `emptyIs` says so; NaN for a typo (zod refuses it). */
export function amount(form: FormData, name: string, emptyIs: number | null = null): number | null {
  const value = parseWhole(text(form, name));
  if (value === undefined) return emptyIs;
  return value;
}

/** An integer posted in a hidden field (a stamp the form showed). */
export function int(form: FormData, name: string): number {
  const value = Number(text(form, name));
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

export function intOrNull(form: FormData, name: string): number | null {
  const raw = text(form, name);
  if (raw === "" || raw === "null") return null;
  return int(form, name);
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
