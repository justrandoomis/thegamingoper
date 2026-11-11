/**
 * /admin/setup — the one-time first-owner bootstrap (createFirstOwner in ~/server/auth/admin.server: SETUP_TOKEN
 * compared in constant time, 5 attempts per IP per hour, reference data and roles installed, the "employees is
 * empty" rule checked twice, audited). This module adds the page's rules:
 *
 *   · once any employee exists the page is a plain 404 — for GET and POST alike, nothing tells that it ever existed
 *   · while SETUP_TOKEN is missing or shorter than 16 characters the page says setup is switched off
 *   · the password is typed twice (a typo here would lock the only owner out); the owner is NOT signed in — they go
 *     to /admin/login, behind the edge challenge, with a document redirect
 */
import { data, redirectDocument } from "react-router";
import { serverT } from "~/i18n/i18n.server";
import { MIN_SETUP_TOKEN_LENGTH, createFirstOwner, isSetupAvailable, type AuthCtx, type AuthSecrets } from "~/server/auth/admin.server";
import type { Db } from "~/server/db.server";
import { actionError, type FieldErrors } from "~/server/errors";

export type SetupState = "ready" | "disabled";
export type SetupFailure = { ok: false; code: string; message: string | null; fields?: FieldErrors; values: { name: string; email: string }; status: number };

const notFound = () => data({ error: "not_found" }, { status: 404 });

export function setupState(secrets: Pick<AuthSecrets, "SETUP_TOKEN">): SetupState {
  return (secrets.SETUP_TOKEN ?? "").trim().length >= MIN_SETUP_TOKEN_LENGTH ? "ready" : "disabled";
}

/** Throws a 404 once an employee exists. */
export async function setupLoader(db: Db, secrets: Pick<AuthSecrets, "SETUP_TOKEN">): Promise<{ state: SetupState }> {
  if (!(await isSetupAvailable(db))) throw notFound();
  return { state: setupState(secrets) };
}

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function setupAction(ctx: AuthCtx, db: Db, secrets: Pick<AuthSecrets, "SETUP_TOKEN">, form: FormData): Promise<SetupFailure | Response> {
  if (!(await isSetupAvailable(db))) throw notFound();
  const values = { name: field(form, "name").trim(), email: field(form, "email").trim() };
  const password = field(form, "password");
  if (password && password !== field(form, "confirm")) {
    return { ok: false, code: "invalid", message: null, fields: { confirm: serverT(ctx.locale, "admin-auth")("setup.errors.passwords_differ") }, values, status: 400 };
  }
  try {
    await createFirstOwner(db, { setupToken: field(form, "setupToken"), email: values.email, name: values.name, password }, ctx.now, secrets, { ip: ctx.ip, requestId: ctx.requestId });
  } catch (error) {
    const failure = actionError(error, serverT(ctx.locale, "errors"));
    // Someone else finished setup a moment ago: the page no longer exists.
    if (failure.code === "setup_done") throw notFound();
    const message =
      failure.code === "rate_limited"
        ? serverT(ctx.locale, "admin-auth")("setup.errors.rate_limited", { count: Math.max(1, Math.ceil((failure.retryAfterSec ?? 60) / 60)) })
        : failure.fields
          ? null
          : (failure.message ?? null);
    return { ok: false, code: failure.code, message, fields: failure.fields, values, status: failure.status };
  }
  return redirectDocument("/admin/login?setup=done");
}
