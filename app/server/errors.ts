/**
 * Expected failures.
 *
 * Services throw `AppError(code, status, { fields?, detail? })` for anything a person can cause or
 * fix: invalid input, a missing record, a missing permission, a state conflict, a rate limit.
 * Everything else (bugs, an unreachable database) is NOT an AppError and must bubble to the error
 * boundary — never swallow it and never show a zero in place of a failed number.
 *
 *   // service
 *   if (!order) throw notFound("order");
 *   if (!phone) throw invalid({ phone: "phone_invalid" });
 *
 *   // action: field errors come back as data, with the right status
 *   try {
 *     const result = await placeOrder(getDb(), actor, input, ctx.now);
 *     return redirect(…);
 *   } catch (error) {
 *     const failure = actionError(error, serverT(ctx.locale, "checkout"));   // rethrows unexpected errors
 *     return data(failure, { status: failure.status });
 *   }
 *
 *   // loader: turn an expected failure into a proper 403 / 404 / 429 response
 *   try { … } catch (error) { throwAsResponse(error); }
 *
 * Codes are lower_snake_case. Database rules keep their name: the trigger message
 * `TT:INSUFFICIENT_STOCK:<variantId>` becomes `AppError("insufficient_stock", 409, { detail: "<variantId>" })`,
 * a UNIQUE violation becomes `AppError("unique", 409, { detail: "orders.idempotency_key" })`.
 *
 * Field errors are message KEYS, not sentences (`{ phone: "phone_invalid" }`). `actionError(error, t)`
 * translates them with the `t()` you pass, looking up `errors.<key>`; without a translation the key
 * itself is returned so the client can translate it.
 */
import { data } from "react-router";
import { ZodError } from "zod";
import type { TFunction } from "~/i18n/translate";
import { mapDbError } from "./db/tx.server";

/** Field name (dot path for nested input, e.g. "address.governorateId") → error key. */
export type FieldErrors = Record<string, string>;

export type AppErrorOptions = {
  fields?: FieldErrors;
  /** Machine-readable context for logs and services (an id, "table.column"…). Never shown to shoppers. */
  detail?: string;
  /** For rate limits: seconds until the caller may try again. */
  retryAfterSec?: number;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields?: FieldErrors;
  readonly detail?: string;
  readonly retryAfterSec?: number;

  constructor(code: string, status = 400, options: AppErrorOptions = {}) {
    super(options.detail ? `${code}: ${options.detail}` : code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    if (options.fields && Object.keys(options.fields).length > 0) this.fields = options.fields;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.retryAfterSec !== undefined) this.retryAfterSec = Math.max(0, Math.ceil(options.retryAfterSec));
  }
}

/** True for an AppError (optionally: with this code). */
export function isAppError(error: unknown, code?: string): error is AppError {
  return error instanceof AppError && (code === undefined || error.code === code);
}

/**
 * Every code and field key the server core itself can produce (errors, auth, settings, uploads,
 * rate limits). Screens show them through `errors.<key>` translations, so whoever owns those
 * strings can check this list is covered in ar, en and ckb. Domain services add their own keys.
 */
export const CORE_ERROR_KEYS = [
  // generic, and the keys zodFieldErrors() derives from a failed validation
  "invalid",
  "required",
  "too_short",
  "too_long",
  "too_small",
  "too_big",
  "not_found",
  "unauthorized",
  "forbidden",
  "rate_limited",
  "unique",
  "check",
  // accounts and sign-in
  "invalid_credentials",
  "account_blocked",
  "phone_invalid",
  "phone_taken",
  "email_invalid",
  "password_too_short",
  "password_too_long",
  "otp_invalid",
  "mfa_invalid",
  "locked_out",
  "mfa_already_enabled",
  "mfa_not_pending",
  "mfa_not_enabled",
  "cannot_disable_self",
  "last_owner",
  "employee_not_active",
  "setup_disabled",
  "setup_token_invalid",
  "setup_done",
  // staff accounts and the hierarchy rule (auth/admin.server.ts, auth/employees.server.ts — SECURITY.md §6–7)
  "target_more_privileged",
  "grant_exceeds_own",
  "own_account_here",
  "email_taken",
  "employee_already_active",
  "password_link_invalid",
  "mfa_required_by_role",
  // settings values
  "account_number_invalid",
  "url_invalid",
  // uploads
  "upload_missing",
  "upload_too_large",
  "upload_type",
  "upload_corrupt",
  "upload_dimensions",
] as const;

export type CoreErrorKey = (typeof CORE_ERROR_KEYS)[number];

// ───────────────────────────────────────────────────────────────── constructors

/** 404 — the thing does not exist, or the caller may not know that it does. */
export function notFound(what?: string): AppError {
  return new AppError("not_found", 404, { detail: what });
}

/** 401 — nobody is signed in. */
export function unauthorized(detail?: string): AppError {
  return new AppError("unauthorized", 401, { detail });
}

/** 403 — signed in, but not allowed. `detail` is the missing permission. */
export function forbidden(permission?: string): AppError {
  return new AppError("forbidden", 403, { detail: permission });
}

/** 400 — input the person can correct. `fields` maps field names to error keys. */
export function invalid(fields: FieldErrors, detail?: string): AppError {
  return new AppError("invalid", 400, { fields, detail });
}

/** 409 — the request is fine but the current state refuses it. Pass a specific code ("phone_taken", "order_already_shipped"). */
export function conflict(code: string, detail?: string): AppError {
  return new AppError(code, 409, { detail });
}

/** 429 — too many attempts. */
export function rateLimited(retryAfterSec: number, detail?: string): AppError {
  return new AppError("rate_limited", 429, { retryAfterSec, detail });
}

// ───────────────────────────────────────────────────────────────── conversion

const KEY_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;

type Issue = ZodError["issues"][number];

/** A stable error key for a zod issue. A schema's own message wins when it is written as a key. */
function issueKey(issue: Issue): string {
  if (KEY_PATTERN.test(issue.message)) return issue.message;
  switch (issue.code) {
    case "invalid_type":
      return /received (undefined|null)/i.test(issue.message) ? "required" : "invalid";
    case "too_small": {
      const origin = (issue as { origin?: string }).origin;
      const minimum = Number((issue as { minimum?: number | bigint }).minimum);
      if (origin === "string" || origin === "array" || origin === "set") return minimum <= 1 ? "required" : "too_short";
      return "too_small";
    }
    case "too_big": {
      const origin = (issue as { origin?: string }).origin;
      return origin === "string" || origin === "array" || origin === "set" ? "too_long" : "too_big";
    }
    default:
      return "invalid";
  }
}

/** Field errors of a failed zod parse: the first problem of each field, as a key. Form-level problems use "_". */
export function zodFieldErrors(error: ZodError): FieldErrors {
  const fields: FieldErrors = {};
  for (const issue of error.issues) {
    const name = issue.path.length > 0 ? issue.path.map(String).join(".") : "_";
    if (!(name in fields)) fields[name] = issueKey(issue);
  }
  return fields;
}

/**
 * The AppError behind any thrown value, or null when it is not an expected failure (rethrow those).
 * Understands AppError, zod validation errors and the database rules reported by mapDbError().
 */
export function toAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) return new AppError("invalid", 400, { fields: zodFieldErrors(error), cause: error });
  const rule = mapDbError(error);
  if (rule) return new AppError(rule.code.toLowerCase(), rule.status, { detail: rule.detail || undefined, cause: error });
  return null;
}

/** What an action returns for a failed request (`ActionFail` from ~/lib/dto plus the HTTP status to send). */
export type ActionFailure = {
  ok: false;
  code: string;
  status: number;
  /** Translated sentence for the whole form, when `t` knows `errors.<code>`. */
  message?: string;
  fields?: FieldErrors;
  retryAfterSec?: number;
};

function translated(t: TFunction | undefined, key: string, vars?: Record<string, string | number>): string | undefined {
  if (!t) return undefined;
  const full = `errors.${key}`;
  const text = t(full, vars);
  return text === full ? undefined : text;
}

/**
 * Turns an expected failure into the `{ ok: false, code, fields }` shape routes return, and RETHROWS
 * anything that is not one. With `t`, the form message and every field error are translated through
 * `errors.<key>`; keys without a translation stay as keys.
 */
export function actionError(error: unknown, t?: TFunction): ActionFailure {
  const appError = toAppError(error);
  if (!appError) throw error;
  const failure: ActionFailure = { ok: false, code: appError.code, status: appError.status };
  const vars = appError.retryAfterSec !== undefined ? { seconds: appError.retryAfterSec, minutes: Math.ceil(appError.retryAfterSec / 60) } : undefined;
  const message = translated(t, appError.code, vars);
  if (message !== undefined) failure.message = message;
  if (appError.fields) {
    const fields: FieldErrors = {};
    for (const [name, key] of Object.entries(appError.fields)) fields[name] = translated(t, key) ?? key;
    failure.fields = fields;
  }
  if (appError.retryAfterSec !== undefined) failure.retryAfterSec = appError.retryAfterSec;
  return failure;
}

/**
 * For loaders and resource routes: rethrows an expected failure as an HTTP response with its status
 * (so a missing permission renders as 403, not as a crash), and rethrows everything else unchanged.
 * The body only carries the code — never `detail`.
 */
export function throwAsResponse(error: unknown): never {
  if (error instanceof Response) throw error;
  const appError = toAppError(error);
  if (!appError) throw error;
  const headers = new Headers();
  if (appError.retryAfterSec !== undefined) headers.set("Retry-After", String(appError.retryAfterSec));
  throw data({ error: appError.code }, { status: appError.status, headers });
}
