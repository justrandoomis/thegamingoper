/**
 * Server helpers for the pricing module's route modules: the permission gate every loader and action starts with,
 * form reading, and the one way an expected failure becomes a response (translated through the module's
 * `errors.*` strings; unexpected errors are rethrown to the error boundary).
 */
import { data } from "react-router";

import { serverT } from "~/i18n/i18n.server";
import type { Locale } from "~/lib/locales";
import { requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import type { RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db.server";
import { actionError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { canAny, PRICING_PERMISSIONS } from "~/server/services/admin/pricing/access";

/**
 * requireEmployee with the permission the request needs; with a list, any one of them (403 naming the first).
 * Without a permission: any permission of the pricing group (the module's own pages).
 */
export async function requirePricing(ctx: RequestCtx, db: Db, permission?: Permission | readonly Permission[]): Promise<EmployeeSession> {
  if (typeof permission === "string") return requireEmployee(ctx, db, permission);
  const session = await requireEmployee(ctx, db);
  const list = permission ?? PRICING_PERMISSIONS;
  if (!canAny(session.actor, list)) throw data({ error: "forbidden", permission: list[0] }, { status: 403 });
  return session;
}

/** A form as a plain object of its text values (files are ignored). Repeated names keep the last value. */
export function formObject(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of form.entries()) if (typeof value === "string") out[key] = value;
  return out;
}

export type ActionFail = { ok: false; intent: string | null; code: string; message?: string; fields?: Record<string, string> };

/** An expected failure as `data({ ok: false, … }, status)`; anything else is rethrown. */
export function failure(error: unknown, locale: Locale, intent: string | null) {
  const result = actionError(error, serverT(locale, "admin-pricing"));
  const body: ActionFail = { ok: false, intent, code: result.code };
  if (result.message) body.message = result.message;
  if (result.fields) body.fields = result.fields;
  return data(body, { status: result.status });
}

/** A fresh key for one attempt of a form (double submits of the same attempt are recognised by the server). */
export function formKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
