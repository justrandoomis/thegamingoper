/**
 * Admin module 19 (automation) — what every route of the module does on the server: open the request (session,
 * permission, database, language), send the module's strings once from its layout, turn an expected failure into a
 * translated `{ ok: false }` result with its HTTP status, and read form values. Imported from loaders and actions only.
 *
 *   export async function action(args: Route.ActionArgs) {
 *     const req = await automation.open(args, "automation.workflow.manage");
 *     try { …; return ok(intent); } catch (error) { return automation.failed(error, req, intent); }
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
import { actionError, invalid, throwAsResponse } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { AUTOMATION_NS } from "~/server/services/admin/automation/catalog";
import { hasAnyAutomationPermission } from "~/server/services/admin/automation/shared.server";

export type AutomationRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

type Args = { context: Readonly<RouterContextProvider> };

/** Values typed into a sentence keep their own direction (an Arabic name inside English, a code inside Arabic). */
export function isolateVars(vars?: Vars): Vars | undefined {
  if (!vars) return vars;
  const out: Vars = {};
  for (const [name, value] of Object.entries(vars)) out[name] = typeof value === "string" && value !== "" && name !== "count" ? `⁨${value}⁩` : value;
  return out;
}

const translator = (locale: Locale): ((key: string, vars?: Vars) => string) => {
  const mine = getNamespace(AUTOMATION_NS)?.[locale] as MessageTree | undefined;
  // a draft purchase order fails with module 09's codes; their sentences are 09's
  const purchasing = getNamespace("admin-purchasing")?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, raw) => {
    const vars = isolateVars(raw);
    return translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? (translate(purchasing, locale, key, vars) ?? translate(shared, locale, key, vars)) : undefined) ?? key;
  };
};

export const automation = {
  /**
   * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). Without one, the
   * employee must still hold a permission of the module (the shell's gate checks that too).
   */
  async open(args: Args, permission?: Permission): Promise<AutomationRequest> {
    const ctx = getCtx(args.context);
    const db = getDb();
    const session = await requireEmployee(ctx, db, permission);
    if (!permission && !hasAnyAutomationPermission(session.actor)) throw data({ error: "forbidden" }, { status: 403 });
    return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
  },
  /** The request's form. A body that is not one is an expected 400 (`invalid`), never a 500. */
  async form(request: Request): Promise<FormData> {
    try {
      return await request.formData();
    } catch {
      throw invalid({ _: "invalid" });
    }
  },
  /** The module's strings and the shared error texts, sent once by the module's layout. */
  i18n(locale: Locale) {
    return messagesFor(locale, AUTOMATION_NS, "errors");
  },
  t: translator,
  /** An expected failure as a translated result with its HTTP status (plus `extra`, e.g. the form's values); anything else is rethrown. */
  failed<E extends Record<string, unknown> = Record<never, never>>(error: unknown, req: AutomationRequest, intent: string | null, extra?: E) {
    if (error instanceof Response) throw error;
    const t = translator(req.locale);
    const failure = actionError(error, (key, vars) => t(key, vars));
    return data({ ok: false as const, intent, code: failure.code, message: failure.message, fields: failure.fields, status: failure.status, ...(extra ?? ({} as E)) }, { status: failure.status });
  },
  /** For loaders: an expected failure (a missing permission, a missing record) as its status. */
  async orRespond<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throwAsResponse(error);
    }
  },
};

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

export function all(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}
