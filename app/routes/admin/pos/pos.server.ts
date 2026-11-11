/**
 * Route glue shared by the pages of module 06 (point of sale): open a request (session, permission, database, language),
 * the strings every page needs, how an expected failure becomes `{ ok: false, intent, code, message, fields }` in the
 * employee's language (status kept), and form readers that accept Arabic-Indic and Persian digits.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openPos(context, "pos.sale.create");
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
import { parseWhole } from "~/server/services/admin/pos/types";

export const POS_NS = "admin-pos";

export type PosRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/**
 * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). A list of
 * permissions means "any of them".
 */
export async function openPos(context: Readonly<RouterContextProvider>, permission?: Permission | readonly Permission[]): Promise<PosRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const single = typeof permission === "string" ? permission : undefined;
  const session = await requireEmployee(ctx, db, single);
  if (Array.isArray(permission) && !canAny(session.actor, permission)) throw data({ error: "forbidden", permission: permission[0] }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function posI18n(locale: Locale) {
  return messagesFor(locale, POS_NS, "errors");
}

/** `t()` over the module's strings first, then the shared "errors" namespace. */
export function posT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(POS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type Failure = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };

/** An expected failure as data (status kept for the response); anything else is rethrown to the error boundary. */
export function failure(error: unknown, locale: Locale, intent: string | null): Failure {
  const result = actionError(error, posT(locale));
  return { ok: false, intent, code: result.code, message: result.message, fields: result.fields, status: result.status };
}

export function failed(error: unknown, locale: Locale, intent: string | null) {
  const result = failure(error, locale, intent);
  return data(result, { status: result.status });
}

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** A whole number typed by a person (Arabic-Indic / Persian digits, thousands separators); undefined when empty, NaN when not a whole number. */
export function whole(form: FormData, name: string): number | undefined {
  const value = parseWhole(text(form, name));
  return value === null ? undefined : value;
}

/** The note counts of a cash count form ("note_25000" = 4 …); empty fields count 0, a bad entry is NaN. */
export function denominations(form: FormData, notes: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const note of notes) {
    const value = parseWhole(text(form, `note_${note}`));
    out[String(note)] = value === null ? 0 : value;
  }
  return out;
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}
