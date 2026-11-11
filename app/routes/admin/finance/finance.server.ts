/**
 * Admin module 10 (finance) — what every route of the module does on the server: open the request (session,
 * permission, database, language), turn expected failures into translated `{ ok: false }` results with their status,
 * and read form values (amounts typed with Arabic-Indic or Persian digits included). Route modules import it from
 * their loaders and actions only.
 *
 *   export async function loader({ context, request }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openFinance(context, "finance.journal.read");
 *     …
 *   }
 *   export async function action({ context, request }: Route.ActionArgs) {
 *     const req = await openFinance(context, "finance.journal.post");
 *     try { await reverseEntry(req.db, req.actor, input, req.now); return ok({ intent, message }); }
 *     catch (error) { return failed(error, req.locale, intent); }
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
import { hasAnyFinancePermission } from "~/server/services/admin/finance/shared.server";
import { FINANCE_NS, parseAmount } from "~/server/services/admin/finance/types";

export type FinanceRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/**
 * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). Without a permission
 * the employee must still hold one of the finance permissions (the shell's gate checks that too).
 */
export async function openFinance(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<FinanceRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, permission);
  if (!permission && !hasAnyFinancePermission(session.actor)) throw data({ error: "forbidden" }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function financeI18n(locale: Locale) {
  return messagesFor(locale, FINANCE_NS, "errors");
}

/** A translator over the module's strings first, then the shared "errors" namespace. */
export function financeT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(FINANCE_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type ActionOk = { ok: true; intent?: string; message?: string; [key: string]: unknown };

export function ok<T extends Record<string, unknown>>(value: T & { intent?: string; message?: string }) {
  return { ok: true as const, ...value };
}

/** An expected failure as a translated result with its HTTP status (400 / 403 / 404 / 409); anything else is rethrown. */
export function failed(error: unknown, locale: Locale, intent?: string) {
  const t = financeT(locale);
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

// ───────────────────────────────────────────────────────────────── form values

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optionalText(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === "" ? undefined : value;
}

/** A whole number of dinars typed in a field; undefined when empty, NaN when it is not one (zod then refuses it). */
export function amount(form: FormData, name: string, options: { signed?: boolean } = {}): number | undefined {
  return parseAmount(text(form, name), options);
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

export function all(form: FormData, name: string): string[] {
  return form.getAll(name).map((value) => (typeof value === "string" ? value.trim() : ""));
}
