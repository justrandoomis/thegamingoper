/**
 * Admin module 02 (catalogue) — what every route of the module shares on the server: the employee and their actor
 * (requireEmployee with the route's permission — the shell's gate is only the coarse check), the request's language,
 * the private blob store, form data turned into the nested objects the services validate, and failures turned into
 * translated `{ ok: false, code, message, fields }` answers (module strings first, then the shared `errors` ones).
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.read");
 *     …
 *   }
 *   export async function action({ request, context }: Route.ActionArgs) {
 *     const req = await catalogRequest(context);            // the permission is checked per intent below
 *     const form = formObject(await request.formData());
 *     return runIntent(req, form.intent, { save: … });
 *   }
 *
 * Route modules never import "cloudflare:workers": the blob store comes from here.
 */
import { env } from "cloudflare:workers";
import { data, type RouterContextProvider } from "react-router";
import { serverT } from "~/i18n/i18n.server";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx, type RequestCtx } from "~/server/context.server";
import { getDb, type Db } from "~/server/db.server";
import { actionError, throwAsResponse, type ActionFailure } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";

export type CatalogRequest = {
  ctx: RequestCtx;
  db: Db;
  session: EmployeeSession;
  actor: EmployeeSession["actor"];
  locale: Locale;
  now: number;
};

/** The signed-in employee for a catalogue route; 403 without `permission` (redirect to sign-in without a session). */
export async function catalogRequest(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<CatalogRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, permission);
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

export function blobStore(): BlobStore {
  return kvBlobStore(env.KV);
}

/**
 * A loader's read whose expected failure is an HTTP answer, not a crash: a product that does not exist answers 404
 * (the editor's tabs load beside its frame, so each of them must say "not found" too, never log a server error), a
 * missing permission 403. Anything unexpected is rethrown to the error boundary.
 *   const gallery = await answered(getGallery(db, actor, params.id, locale));
 */
export async function answered<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    return throwAsResponse(error);
  }
}

/**
 * Counts one file upload of the employee against RATE_LIMITS.upload (SECURITY §9) and throws `rate_limited` (429)
 * once the window's budget is spent. Gallery pictures and CSV files share one budget per employee; a colleague has
 * their own. Call it after the permission check and before the file is read or stored.
 */
export async function enforceUploadLimit(req: CatalogRequest): Promise<void> {
  await enforceRateLimit(req.db, await limitKey("upload", "employee", req.actor.id), RATE_LIMITS.upload, req.now);
}

/**
 * FormData → a nested object the services' zod schemas read: "name.ar" → { name: { ar } }, "specs.0.key" →
 * { specs: [{ key }] }, a key given several times ("ids") → an array. Files are kept as they are.
 */
export function formObject(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const counts = new Map<string, number>();
  for (const key of form.keys()) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const [key, count] of counts) {
    const values = form.getAll(key);
    const value = count > 1 || key.endsWith("[]") ? values : values[0];
    const path = key.replace(/\[\]$/, "").split(".");
    if (path.some((part) => part === "__proto__" || part === "constructor" || part === "prototype")) continue;
    let node: Record<string, unknown> | unknown[] = out;
    path.forEach((part, index) => {
      const last = index === path.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(path[index + 1]);
      const slot = Array.isArray(node) ? Number(part) : part;
      if (last) {
        (node as Record<string | number, unknown>)[slot] = value;
        return;
      }
      const existing = (node as Record<string | number, unknown>)[slot];
      const child = existing && typeof existing === "object" ? existing : nextIsIndex ? [] : {};
      (node as Record<string | number, unknown>)[slot] = child;
      node = child as Record<string, unknown> | unknown[];
    });
  }
  // Arrays built from "specs.3.key" may have holes: keep them dense, in order.
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.filter((entry) => entry !== undefined).map(compact);
    if (value && typeof value === "object" && !(value instanceof Blob)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v)]));
    return value;
  };
  return compact(out) as Record<string, unknown>;
}

/** A translator for failures: the module's own `errors.<code>` first, then the shared `errors` namespace. */
function failureT(locale: Locale) {
  const mine = serverT(locale, "admin-catalog");
  const shared = serverT(locale, "errors");
  return (key: string, vars?: Record<string, string | number>) => {
    const own = mine(key, vars);
    if (own !== key) return own;
    return shared(key, vars);
  };
}

export type CatalogFailure = ActionFailure & { intent?: string; detail?: string };

/** An expected failure as the action's answer (unexpected errors are rethrown to the error boundary). */
export function failed(error: unknown, locale: Locale, intent?: string) {
  const failure: CatalogFailure = { ...actionError(error, failureT(locale)), intent };
  // Which requirements are missing (incomplete / regression) is safe to show: it is the product's own checklist.
  const detail = (error as { detail?: unknown })?.detail;
  if ((failure.code === "incomplete" || failure.code === "regression") && typeof detail === "string") failure.detail = detail;
  const headers = failure.retryAfterSec !== undefined ? { "Retry-After": String(failure.retryAfterSec) } : undefined;
  return data(failure, { status: failure.status, headers });
}

export type Handlers = Record<string, () => Promise<Record<string, unknown> | Response>>;

/** Runs the handler of the form's `intent` and turns expected failures into answers. Unknown intents are a 400. */
export async function runIntent(req: CatalogRequest, intent: unknown, handlers: Handlers) {
  const name = typeof intent === "string" ? intent : "";
  const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
  if (!handler) return data({ ok: false as const, code: "invalid", intent: name, status: 400 }, { status: 400 });
  try {
    const result = await handler();
    if (result instanceof Response) return result;
    return { ok: true as const, intent: name, ...result };
  } catch (error) {
    return failed(error, req.locale, name);
  }
}

/** Baghdad wall-clock time from a datetime-local field ("2026-11-12T10:30") → epoch ms. Iraq has no daylight saving. */
export function baghdadInputToEpoch(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const [date, time] = value.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh - 3, mm);
}
