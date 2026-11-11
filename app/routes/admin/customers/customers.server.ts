/**
 * Route glue shared by the pages of module 07 (customers): open a request (session, permission, database, language),
 * the strings every page needs, how an expected failure becomes `{ ok: false, intent, code, message, fields }` in the
 * employee's language (status kept), and form readers.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openCustomers(context, "customers.customer.read");
 *     …
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
import { actionError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { CUSTOMERS_NS } from "~/server/services/admin/customers/types";

export type CustomersRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/** Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise); a list = any of them. */
export async function openCustomers(context: Readonly<RouterContextProvider>, permission?: Permission | readonly Permission[]): Promise<CustomersRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const single = typeof permission === "string" ? permission : undefined;
  const session = await requireEmployee(ctx, db, single);
  if (Array.isArray(permission) && !canAny(session.actor, permission)) throw data({ error: "forbidden", permission: permission[0] }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function customersI18n(locale: Locale) {
  return messagesFor(locale, CUSTOMERS_NS, "errors");
}

/** `t()` over the module's strings first, then the shared "errors" namespace. */
export function customersT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(CUSTOMERS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type Failure = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };
export type Success<I extends string = string> = { ok: true; intent: I; replayed?: boolean; [key: string]: unknown };

/** An expected failure as data (status kept for the response); anything else is rethrown to the error boundary. */
export function failure(error: unknown, locale: Locale, intent: string | null): Failure {
  const result = actionError(error, customersT(locale));
  return { ok: false, intent, code: result.code, message: result.message, fields: result.fields, status: result.status };
}

/** A result as a response: failures carry their HTTP status. */
export function respond<T extends { ok: boolean; status?: number }>(result: T) {
  return result.ok ? result : data(result, { status: (result as { status?: number }).status ?? 400 });
}

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

/** A 404 Response for a resource route (same answer as a file that does not exist). */
export function notFoundResponse() {
  return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
