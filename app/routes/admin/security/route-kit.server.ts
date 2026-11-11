/**
 * What every route of admin modules 20 (security) and 22 (settings) does on the server: open the request (session,
 * permission, database, language), send the module's strings once from its layout, turn an expected failure into a
 * translated `{ ok: false }` result with its HTTP status, and read form values (Arabic-Indic and Persian digits
 * accepted). Imported from loaders and actions only.
 *
 *   const sec = routeKit("admin-security");
 *   export async function action({ context, request }: Route.ActionArgs) {
 *     const req = await sec.open(context);
 *     try { …; return ok(intent); } catch (error) { return sec.failed(error, req.locale, intent); }
 *   }
 */
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import { randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, throwAsResponse } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { isolateVars } from "./components/isolate";

export type ModuleRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

export type ActionOk = { ok: true; intent: string; [key: string]: unknown };
export type ActionFail = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };

export function routeKit(namespace: string) {
  /** A translator over the module's strings first, then the shared "errors" namespace. */
  const translator = (locale: Locale): ((key: string, vars?: Vars) => string) => {
    const mine = getNamespace(namespace)?.[locale] as MessageTree | undefined;
    const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
    return (key, raw) => {
      const vars = isolateVars(raw);
      return translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
    };
  };
  return {
    /** Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). */
    async open(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<ModuleRequest> {
      const ctx = getCtx(context);
      const db = getDb();
      const session = await requireEmployee(ctx, db, permission);
      return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
    },
    /** The module's strings and the shared error texts, sent once by the module's layout. */
    i18n(locale: Locale) {
      return messagesFor(locale, namespace, "errors");
    },
    t: translator,
    /** An expected failure as a translated result with its HTTP status; anything unexpected goes to the error boundary. */
    failed(error: unknown, locale: Locale, intent: string | null) {
      if (error instanceof Response) throw error;
      const t = translator(locale);
      const detail = (error as { detail?: unknown } | null)?.detail;
      const vars = typeof detail === "string" ? { detail } : undefined;
      const failure = actionError(error, (key, extra) => t(key, { ...(vars ?? {}), ...(extra ?? {}) }));
      return data({ ok: false as const, intent, code: failure.code, message: failure.message, fields: failure.fields, status: failure.status }, { status: failure.status });
    },
    /** For loaders: an expected failure (a missing permission) as its status — 403 renders in the shell, not a crash. */
    async orRespond<T>(run: () => Promise<T>): Promise<T> {
      try {
        return await run();
      } catch (error) {
        throwAsResponse(error);
      }
    },
  };
}

export function ok<T extends Record<string, unknown>>(intent: string, value: T = {} as T) {
  return { ok: true as const, intent, ...value };
}

/** One fresh idempotency key per form render: a resubmission of the same render is a replay. */
export function newKey(): string {
  return randomToken(18);
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

export function all(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}

/** A JSON value posted in a hidden field (what the form showed); undefined when absent or unreadable. */
export function json(form: FormData, name: string): unknown {
  const raw = form.get(name);
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
