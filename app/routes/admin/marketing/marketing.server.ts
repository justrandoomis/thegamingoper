/**
 * Route glue shared by the pages of module 16 (marketing): open a request (session, permission, database, language),
 * the strings every page needs, how an expected failure becomes `{ ok: false, intent, code, message, fields }` in the
 * employee's language (status kept), the intent runner every action uses (the intent's permissions are checked first
 * — 403 before anything is read — then the service checks again with assertCan), and form readers.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openMarketing(context, SECTION_READ.campaigns);
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { canAll, canAny } from "~/server/actor";
import { requireEmployee, type AuthCtx, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { MARKETING_NS } from "~/server/services/admin/marketing/types";
import { marketingOrigin } from "./env.server";

export type MarketingRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number; origin: string };

/** Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise); a list = any of them. */
export async function openMarketing(context: Readonly<RouterContextProvider>, permission: Permission | readonly Permission[]): Promise<MarketingRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const single = typeof permission === "string" ? permission : undefined;
  const session = await requireEmployee(ctx, db, single);
  if (typeof permission !== "string" && !canAny(session.actor, permission)) throw data({ error: "forbidden", permission: permission[0] }, { status: 403 });
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now, origin: marketingOrigin(ctx.origin) };
}

export function marketingI18n(locale: Locale) {
  return messagesFor(locale, MARKETING_NS, "errors");
}

/** `t()` over the module's strings first, then the shared "errors" namespace (server side: CSV headers, failures). */
export function marketingT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(MARKETING_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type Failure = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };
export type ActionOk = { ok: true; intent: string; replayed?: boolean; [key: string]: unknown };
export type ActionResult = ActionOk | Failure;

/** An expected failure as data (status kept for the response); anything else is rethrown to the error boundary. */
export function failure(error: unknown, locale: Locale, intent: string | null): Failure {
  const result = actionError(error, marketingT(locale));
  return { ok: false, intent, code: result.code, message: result.message, fields: result.fields, status: result.status };
}

/** A result as a response: failures carry their HTTP status. */
export function respond<T extends { ok: boolean; status?: number }>(result: T) {
  return result.ok ? result : data(result, { status: (result as { status?: number }).status ?? 400 });
}

type Ctx = Pick<AuthCtx, "locale" | "now">;

/**
 * Runs one intent of a page's action: unknown intents are 400, the intent's permissions (all of them) are checked
 * before the handler reads anything, expected failures come back as data in the employee's language.
 */
export async function runIntent<T extends string>(ctx: Ctx, session: EmployeeSession, form: FormData, intents: Record<T, readonly Permission[]>, handle: (intent: T) => Promise<ActionOk>): Promise<ActionResult> {
  const raw = text(form, "intent");
  const intent = Object.prototype.hasOwnProperty.call(intents, raw) ? (raw as T) : null;
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    const needs = intents[intent];
    if (!canAll(session.actor, needs)) throw forbidden(needs.find((permission) => !canAll(session.actor, [permission])));
    return await handle(intent);
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function list(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

/** Every text field of a form as an object (the services validate it). Repeated names in `multi` become lists. */
export function fields(form: FormData, multi: readonly string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value !== "string" || name === "intent") continue;
    if (multi.includes(name)) out[name] = [...((out[name] as string[] | undefined) ?? []), value.trim()];
    else out[name] = value.trim();
  }
  for (const name of multi) out[name] ??= [];
  return out;
}
