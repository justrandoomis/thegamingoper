/**
 * Admin module 23 (ops) — what every route of the module does on the server: open the request (session, permission,
 * database, language), send the module's strings once from its layout, turn an expected failure into a translated
 * `{ ok: false }` result with its HTTP status, record an UNEXPECTED one (23.01: one upsert in error_reports, scrubbed)
 * before it reaches the error boundary, and read form values. Imported from loaders and actions only.
 *
 *   export async function action(args: Route.ActionArgs) {
 *     const req = await ops.open(args, "ops.job.run");
 *     try { …; return ok(intent); } catch (error) { return ops.failed(error, req, intent); }
 *   }
 *
 * The scheduled jobs' bindings (the KV file store the retention job's purges need) are read here from
 * "cloudflare:workers", so route modules never import it.
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
import type { ScheduledJobsEnv } from "~/server/jobs.server";
import type { Permission } from "~/server/permissions";
import { hasAnyOpsPermission } from "~/server/services/admin/ops/shared.server";
import { deviceOf, recordError } from "~/server/services/admin/ops/telemetry.server";
import { OPS_NS } from "~/server/services/admin/ops/types";
import { isolateVars } from "./components/isolate";

export type OpsRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number; pattern: string | null };

type Args = { context: Readonly<RouterContextProvider>; pattern?: string };

const translator = (locale: Locale): ((key: string, vars?: Vars) => string) => {
  const mine = getNamespace(OPS_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, raw) => {
    const vars = isolateVars(raw);
    return translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
  };
};

/** Records an error that is not an expected failure (never a Response, never an AppError) — and never throws itself. */
async function recordUnexpected(req: Pick<OpsRequest, "db" | "ctx" | "now" | "pattern">, error: unknown): Promise<void> {
  if (error instanceof Response || toAppError(error)) return;
  try {
    const value = error instanceof Error ? error : new Error(String(error));
    await recordError(
      req.db,
      { source: "server", level: "error", message: `${value.name}: ${value.message}`, stack: value.stack, route: req.pattern ?? undefined, sample: { requestId: req.ctx.requestId, device: deviceOf(req.ctx.userAgent), actorKind: "employee" } },
      req.now,
    );
  } catch (failure) {
    console.error("[ops] could not record an error", failure);
  }
}

export const ops = {
  /**
   * Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). Without a
   * permission the employee must still hold one of the module's permissions (the shell's gate checks that too).
   */
  async open(args: Args, permission?: Permission): Promise<OpsRequest> {
    const ctx = getCtx(args.context);
    const db = getDb();
    const session = await requireEmployee(ctx, db, permission);
    if (!permission && !hasAnyOpsPermission(session.actor)) throw data({ error: "forbidden" }, { status: 403 });
    return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now, pattern: args.pattern ?? null };
  },
  /** The request's form. A body that is not one (JSON, a broken upload) is an expected 400 (`invalid`), never a 500. */
  async form(request: Request): Promise<FormData> {
    try {
      return await request.formData();
    } catch {
      throw invalid({ _: "invalid" });
    }
  },
  /** The module's strings and the shared error texts, sent once by the module's layout. */
  i18n(locale: Locale) {
    return messagesFor(locale, OPS_NS, "errors");
  },
  t: translator,
  /** An expected failure as a translated result with its HTTP status; anything unexpected is recorded, then rethrown. */
  async failed(error: unknown, req: OpsRequest, intent: string | null) {
    if (error instanceof Response) throw error;
    if (!toAppError(error)) {
      await recordUnexpected(req, error);
      throw error;
    }
    const t = translator(req.locale);
    const failure = actionError(error, (key, extra) => t(key, extra));
    return data({ ok: false as const, intent, code: failure.code, message: failure.message, fields: failure.fields, status: failure.status }, { status: failure.status });
  },
  /** For loaders: an expected failure (a missing permission, a missing record) as its status; unexpected ones recorded. */
  async orRespond<T>(req: OpsRequest, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      await recordUnexpected(req, error);
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

/** What the module passes when it runs a job by hand: the Worker's file store, as the cron does. No message providers exist. */
export function jobsEnv(): ScheduledJobsEnv {
  return { KV: (env as { KV?: KVNamespace }).KV };
}
