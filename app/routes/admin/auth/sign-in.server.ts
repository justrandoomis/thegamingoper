/**
 * /admin/login — staff sign-in, on top of the server core (~/server/auth/admin.server: lockout, rate limits, TOTP
 * replay guard, recovery codes, session cookie). This module only turns requests into service calls and results into
 * what the page shows; it is separate from the route module so tests can drive it with a hand-made request context.
 *
 *   step "password"   email + password. Unknown email, wrong password, no password and a disabled account all read
 *                     the same; five failures pause the EMAIL for 15 minutes whether or not it exists, so neither the
 *                     wording nor the timing tells an attacker which emails are staff
 *   step "code"       the authenticator code, or a recovery code ("use a recovery code instead" only changes the
 *                     field — the server tells the two apart). Six wrong codes end the half-open session
 *
 * `next`: only a same-origin path under /admin (shell/next.server.ts); anything else becomes /admin.
 *
 * SameSite=Strict side effect: a link from another site (an email, a chat) arrives without the session cookie, so an
 * employee who IS signed in lands here. The loader sees `Sec-Fetch-Site: cross-site` and answers with a one-time
 * same-site hop (the page re-requests itself from its own origin, `hop=1`): that request carries the cookie, and a
 * signed-in employee goes straight to `next`.
 */
import { redirect } from "react-router";
import { serverT } from "~/i18n/i18n.server";
import { ADMIN_COOKIE, getEmployee, getPendingMfa, signInEmployee, signOutEmployee, verifyEmployeeMfa, type AuthCtx, type AuthSecrets } from "~/server/auth/admin.server";
import type { Db } from "~/server/db.server";
import { actionError, toAppError, type FieldErrors } from "~/server/errors";
import { adminNextPath } from "../shell/next.server";

export type LoginNotice = "signed_out" | "signed_out_all" | "setup_done";
export type LoginStep = "password" | "code";

export type LoginData = {
  step: LoginStep;
  /** Validated destination after signing in. */
  next: string;
  /** The account whose code is owed (step "code"). */
  email: string | null;
  /** Same-site URL to re-request when the session cookie may have been withheld (see header). */
  hop: string | null;
  notice: LoginNotice | null;
};

export type LoginFailure = { ok: false; step: LoginStep; code: string; message: string; fields?: FieldErrors; email?: string; status: number };
export type LoginResult = { ok: true; step: LoginStep } | LoginFailure;

function noticeOf(url: URL): LoginNotice | null {
  if (url.searchParams.get("setup") === "done") return "setup_done";
  const signedOut = url.searchParams.get("signed_out");
  if (signedOut === "all") return "signed_out_all";
  if (signedOut === "one") return "signed_out";
  return null;
}

/** The login URL for `next` (+ the notice), marked as the hop so it is never repeated. */
function hopUrl(url: URL, next: string): string {
  const params = new URLSearchParams();
  if (next !== "/admin") params.set("next", next);
  for (const key of ["setup", "signed_out"]) {
    const value = url.searchParams.get(key);
    if (value) params.set(key, value);
  }
  params.set("hop", "1");
  return `/admin/login?${params.toString()}`;
}

/** Throws a redirect to `next` when the employee is already signed in. */
export async function loginLoader(ctx: AuthCtx, db: Db, request: Request, url: URL): Promise<LoginData> {
  const next = adminNextPath(url.searchParams.get("next"));
  if (await getEmployee(ctx, db)) throw redirect(next);
  const pending = await getPendingMfa(ctx, db);
  const crossSite = request.headers.get("Sec-Fetch-Site") === "cross-site";
  const hop = !pending && crossSite && !url.searchParams.has("hop") && !ctx.cookie(ADMIN_COOKIE) ? hopUrl(url, next) : null;
  return { step: pending ? "code" : "password", next, email: pending?.email ?? null, hop, notice: noticeOf(url) };
}

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const minutes = (seconds: number | undefined) => Math.max(1, Math.ceil((seconds ?? 60) / 60));

/**
 * Handles the three intents of the page: "password", "code" and "restart" (back to the password step).
 * Returns a redirect Response to `next` when the employee is fully signed in.
 */
export async function loginAction(ctx: AuthCtx, db: Db, secrets: Pick<AuthSecrets, "DATA_KEY">, url: URL, form: FormData): Promise<LoginResult | Response> {
  const intent = field(form, "intent");
  const next = adminNextPath(field(form, "next") || url.searchParams.get("next"));
  const auth = serverT(ctx.locale, "admin-auth");
  const errors = serverT(ctx.locale, "errors");

  if (intent === "restart") {
    await signOutEmployee(ctx, db);
    return { ok: true, step: "password" };
  }

  if (intent === "code") {
    try {
      await verifyEmployeeMfa(ctx, db, { code: field(form, "code") }, secrets);
      return redirect(next);
    } catch (error) {
      const appError = toAppError(error);
      if (appError?.code === "rate_limited") return { ok: false, step: "password", code: "mfa_locked", message: auth("login.errors.mfa_locked"), status: 429 };
      if (appError?.code === "unauthorized") return { ok: false, step: "password", code: "mfa_expired", message: auth("login.errors.mfa_expired"), status: 401 };
      const failure = actionError(error, errors);
      return { ok: false, step: "code", code: failure.code, message: failure.fields?.code ?? failure.message ?? failure.code, fields: failure.fields, status: failure.status };
    }
  }

  const email = field(form, "email").trim();
  try {
    const result = await signInEmployee(ctx, db, { email, password: field(form, "password") });
    if (result.status === "signed_in") return redirect(next);
    return { ok: true, step: "code" };
  } catch (error) {
    const appError = toAppError(error);
    if (appError?.code === "locked_out") {
      return { ok: false, step: "password", code: "locked_out", message: auth("login.errors.locked_out", { count: minutes(appError.retryAfterSec) }), email, status: 429 };
    }
    if (appError?.code === "rate_limited") {
      return { ok: false, step: "password", code: "rate_limited", message: auth("login.errors.rate_limited", { count: minutes(appError.retryAfterSec) }), email, status: 429 };
    }
    const failure = actionError(error, errors);
    const message = failure.code === "invalid_credentials" ? (failure.message ?? failure.code) : (failure.message ?? errors("errors.invalid"));
    return { ok: false, step: "password", code: failure.code, message, fields: failure.fields, email, status: failure.status };
  }
}
