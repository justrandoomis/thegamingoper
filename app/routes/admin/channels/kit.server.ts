/**
 * Admin module 21 (channels) — what every route of the module does on the server: open the request (session,
 * permission, database, language), send the module's strings once from its layout, turn an expected failure into a
 * translated `{ ok: false }` result with its HTTP status, and read form values. DATA_KEY (webhook and provider
 * secrets) is read here from "cloudflare:workers", so route modules never import it. Imported from loaders and
 * actions only.
 *
 *   export async function action(args: Route.ActionArgs) {
 *     const req = await ch.open(args, "channels.branch.manage");
 *     try { …; return ok(intent); } catch (error) { return ch.failed(error, req, intent); }
 *   }
 */
import { env } from "cloudflare:workers";
import { data, type RouterContextProvider } from "react-router";
import { getNamespace, messagesFor } from "~/i18n/i18n.server";
import { translate, type MessageTree, type Vars } from "~/i18n/translate";
import { randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, invalid, throwAsResponse, toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { hasAnyChannelsPermission } from "~/server/services/admin/channels/shared.server";
import { CHANNELS_NS } from "~/server/services/admin/channels/types";

export type ChRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

type Args = { context: Readonly<RouterContextProvider> };

const translator = (locale: Locale): ((key: string, vars?: Vars) => string) => {
  const mine = getNamespace(CHANNELS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
};

export const ch = {
  /**
   * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). Without one the
   * employee must still hold a permission of the module (the shell's gate checks that too).
   */
  async open(args: Args, permission?: Permission): Promise<ChRequest> {
    const ctx = getCtx(args.context);
    const db = getDb();
    const session = await requireEmployee(ctx, db, permission);
    if (!permission && !hasAnyChannelsPermission(session.actor)) throw data({ error: "forbidden" }, { status: 403 });
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
    return messagesFor(locale, CHANNELS_NS, "errors");
  },
  t: translator,
  /** An expected failure as a translated result with its HTTP status; anything unexpected is rethrown. */
  failed<E extends Record<string, unknown> = Record<never, never>>(error: unknown, req: ChRequest, intent: string | null, extra?: E) {
    if (error instanceof Response) throw error;
    const appError = toAppError(error);
    if (!appError) throw error;
    const t = translator(req.locale);
    const failure = actionError(appError, (key, extra) => t(key, extra));
    // a field key gets this module's sentence for it (field.*), else the shared one (errors.*)
    const fields = appError.fields ? Object.fromEntries(Object.entries(appError.fields).map(([name, code]) => [name, fieldText(t, code)])) : undefined;
    return data({ ...(extra ?? ({} as E)), ok: false as const, intent, code: failure.code, message: failure.message, fields, status: failure.status }, { status: failure.status });
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

function fieldText(t: (key: string, vars?: Vars) => string, code: string): string {
  const own = t(`field.${code}`);
  if (own !== `field.${code}`) return own;
  const shared = t(`errors.${code}`);
  return shared !== `errors.${code}` ? shared : code;
}

export function dataKey(): string | undefined {
  return (env as { DATA_KEY?: string }).DATA_KEY || undefined;
}

export function ok<const I extends string, T extends Record<string, unknown> = Record<never, never>>(intent: I, value: T = {} as T) {
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

export function all(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}
