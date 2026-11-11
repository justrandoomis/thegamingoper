/**
 * Admin module 11 (shipping) — what every route of the module does on the server: open the request (session,
 * permission, database, language), send the module's strings, turn an expected failure into a translated
 * `{ ok: false }` result with its status, read form values (Arabic-Indic and Persian digits accepted in numbers), and
 * count uploads. Route modules import it from their loaders and actions only.
 *
 *   export async function loader({ context }: Route.LoaderArgs) {
 *     const { db, actor, locale, now } = await openShipping(context, "shipping.shipment.read");
 *   }
 *   export async function action({ context, request }: Route.ActionArgs) {
 *     const req = await openShipping(context, "shipping.shipment.update");
 *     try { …; return ok({ intent }); } catch (error) { return failed(error, req.locale, intent); }
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
import { actionError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { parseIqd } from "~/server/services/admin/shipping/rules";

export const SHIPPING_NS = "admin-shipping";

export type ShippingRequest = { ctx: RequestCtx; db: ReturnType<typeof getDb>; session: EmployeeSession; actor: EmployeeSession["actor"]; locale: Locale; now: number };

/** Signs the request in (redirect to sign-in otherwise) and checks the permission (403 otherwise). */
export async function openShipping(context: Readonly<RouterContextProvider>, permission?: Permission): Promise<ShippingRequest> {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, permission);
  return { ctx, db, session, actor: session.actor, locale: ctx.locale, now: ctx.now };
}

/** The module's strings and the shared error texts, sent once by the module's layout. */
export function shippingI18n(locale: Locale) {
  return messagesFor(locale, SHIPPING_NS, "errors");
}

/** A translator over the module's strings first, then the shared "errors" namespace. */
export function shippingT(locale: Locale): (key: string, vars?: Vars) => string {
  const mine = getNamespace(SHIPPING_NS)?.[locale] as MessageTree | undefined;
  const shared = getNamespace("errors")?.[locale] as MessageTree | undefined;
  return (key, vars) => translate(mine, locale, key, vars) ?? translate(shared, locale, key, vars) ?? key;
}

export type ActionResult = { ok: true; intent: string; message?: string; [key: string]: unknown } | { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string>; status: number };

export function ok<T extends Record<string, unknown>>(intent: string, value: T = {} as T) {
  return { ok: true as const, intent, ...value };
}

/** An expected failure as a translated result with its HTTP status; anything unexpected goes to the error boundary. */
export function failed(error: unknown, locale: Locale, intent: string | null) {
  if (error instanceof Response) throw error;
  const t = shippingT(locale);
  const detail = (error as { detail?: unknown } | null)?.detail;
  const vars = typeof detail === "string" ? { detail } : undefined;
  const failure = actionError(error, (key, extra) => t(key, { ...(vars ?? {}), ...(extra ?? {}) }));
  return data({ ok: false as const, intent, code: failure.code, message: failure.message, fields: failure.fields, status: failure.status }, { status: failure.status });
}

/** One fresh idempotency key per form render: a resubmission of the same render is a replay. */
export function newKey(): string {
  return randomToken(18);
}

/** Counts one upload of this employee against RATE_LIMITS.upload (SECURITY §9) before a file is read or stored. */
export async function enforceUploadLimit(req: ShippingRequest): Promise<void> {
  await enforceRateLimit(req.db, await limitKey("upload", "employee", req.actor.id), RATE_LIMITS.upload, req.now);
}

// ───────────────────────────────────────────────────────────────── form values

export function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === "" ? undefined : value;
}

/** A whole number of dinars typed by a person ("754,000", Arabic or Persian digits); undefined when empty, NaN when not a number. */
export function amount(form: FormData, name: string): number | undefined {
  return parseIqd(text(form, name));
}

/** A signed whole number (a remittance may be negative); undefined when empty, NaN when not a number. */
export function signedAmount(form: FormData, name: string): number | undefined {
  const raw = text(form, name).replace(/[−–]/g, "-");
  const negative = raw.startsWith("-");
  const value = parseIqd(negative ? raw.slice(1) : raw);
  return value === undefined ? undefined : negative ? -value : value;
}

/** A small whole number (days); null when empty. */
export function days(form: FormData, name: string): number | null {
  const value = parseIqd(text(form, name));
  return value === undefined ? null : value;
}

export function checked(form: FormData, name: string): boolean {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
}

/**
 * The carrier form (components/CarrierForm) → the service's input; the cash fee typed as a percentage becomes basis
 * points. The percentage accepts Arabic-Indic and Persian digits and the Arabic decimal separator "٫" (or a comma):
 * "١٫٥" is 1.5 % (150 bps) — it used to be refused here and read as 15 % by the form.
 */
export function carrierFromForm(form: FormData) {
  const pct = text(form, "codFeePct")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٫,،]/g, ".")
    .replace(/\s+/g, "");
  const flat = amount(form, "codFeeIqd");
  return {
    carrierId: optional(form, "carrierId"),
    code: text(form, "code"),
    name: text(form, "name"),
    kind: text(form, "kind") as "in_house" | "third_party",
    contactName: optional(form, "contactName"),
    phone: optional(form, "phone"),
    trackingUrlTemplate: optional(form, "trackingUrlTemplate"),
    codSupported: checked(form, "codSupported"),
    codFeeIqd: flat === undefined ? null : flat,
    codFeeBps: pct === "" ? null : /^\d{1,3}(\.\d{1,2})?$/.test(pct) ? Math.round(Number(pct) * 100) : Number.NaN,
    notes: optional(form, "notes"),
  };
}

export function all(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean);
}
