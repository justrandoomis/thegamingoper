/**
 * Admin module 18 (reports) — what every route of the module does on the server: open the request (session,
 * permission, database, language), translate expected failures into `{ ok: false }` results with their status, and
 * read form values. Route modules import it from their loaders and actions only.
 *
 *   export async function loader({ context, request }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openReports(context, "reports.sales.read");
 *     …
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, throwAsResponse } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { hasAnyReportsPermission } from "~/server/services/admin/reports/shared.server";
import { REPORTS_NS } from "~/server/services/admin/reports/types";

export type ReportsRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/**
 * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). Without a permission
 * the employee must still hold one of the module's permissions (the shell's gate checks that too).
 */
export async function openReports(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<ReportsRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, permission);
  if (!permission && !hasAnyReportsPermission(session.actor)) throw data({ error: "forbidden" }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function reportsI18n(locale: Locale) {
  return messagesFor(locale, REPORTS_NS, "errors");
}

/** A translator over the module's strings first, then the shared "errors" namespace (exports, actions). */
export function reportsT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(REPORTS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export function ok<T extends Record<string, unknown>>(value: T & { intent?: string; message?: string }) {
  return { ok: true as const, ...value };
}

/** An expected failure as a translated result with its HTTP status (400 / 403 / 404 / 409); anything else is rethrown. */
export function failed(error: unknown, locale: Locale, intent?: string) {
  const t = reportsT(locale);
  const failure = actionError(error, (key, vars) => t(key, vars));
  return data({ ...failure, intent }, { status: failure.status });
}

/** For loaders: an expected failure becomes its HTTP status (403, 404…), anything else bubbles. */
export async function orRespond<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throwAsResponse(error);
  }
}

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

/** A whole number from a form (Arabic-Indic and Persian digits too); NaN when it is not one (zod then refuses it). */
export function whole(form: FormData, name: string): number {
  const raw = text(form, name)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return /^-?\d{1,16}$/.test(raw) ? Number(raw) : Number.NaN;
}
