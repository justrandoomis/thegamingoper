/**
 * Pieces shared by customer and admin authentication: session tokens, cookies, the security log,
 * password rules and safe post-sign-in redirects.
 *
 * Sessions are random 256-bit tokens. The token lives only in an httpOnly cookie; the database
 * stores `sha256(token)` as the session's primary key, so a copy of the database cannot be used to
 * impersonate anyone, and a session ends the moment its row is revoked.
 *
 * Nothing here imports "cloudflare:workers" (the request context is used as a type only).
 */
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import type { RequestOrigin } from "../actor";
import type { RequestCtx } from "../context.server";
import type { BatchStatement, Db } from "../db/drizzle.server";
import { authEvents, type AuthSubjectKind } from "../db/schema";
import { MAX_PASSWORD_LENGTH } from "../crypto.server";

/** What the auth functions need from the request context — tests can pass a plain object of this shape. */
export type AuthCtx = Pick<RequestCtx, "now" | "ip" | "userAgent" | "requestId" | "isHttps" | "isDev" | "locale" | "cookie" | "setCookie">;

/** The secrets auth needs, named as in the Worker environment so `env` itself can be passed. */
export type AuthSecrets = { SESSION_SECRET?: string; DATA_KEY?: string; SETUP_TOKEN?: string };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/** The session token in a cookie, or null when the cookie is absent or not shaped like one of ours. */
export function readSessionToken(ctx: Pick<RequestCtx, "cookie">, cookieName: string): string | null {
  const value = ctx.cookie(cookieName);
  return value && TOKEN_PATTERN.test(value) ? value : null;
}

/** The value stored as a session's primary key. */
export function sessionIdHash(token: string): Promise<string> {
  return sha256Hex(token);
}

export type SessionCookieOptions = { maxAgeSec: number; path?: string; sameSite?: "Lax" | "Strict" };

/** `Set-Cookie` value for a session cookie: always HttpOnly, `Secure` on HTTPS. `maxAgeSec: 0` deletes it. */
export function sessionCookie(ctx: Pick<RequestCtx, "isHttps">, name: string, value: string, options: SessionCookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, `Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`, "HttpOnly", `SameSite=${options.sameSite ?? "Lax"}`];
  if (ctx.isHttps) parts.push("Secure");
  return parts.join("; ");
}

/** A live session as shown in "your devices" lists. `id` is the stored hash, never the cookie token. */
export type SessionSummary = { id: string; createdAt: number; lastSeenAt: number; expiresAt: number; ip: string | null; userAgent: string | null; current: boolean };

/** Where a request came from, for actors and audit events. */
export function originOf(ctx: Pick<RequestCtx, "ip" | "requestId">): Required<RequestOrigin> {
  return { ip: ctx.ip, requestId: ctx.requestId };
}

export type AuthEventInput = {
  subjectKind: AuthSubjectKind;
  /** Null when the identifier matched no account. */
  subjectId?: string | null;
  /** What was typed: normalized phone or lower-cased email. */
  identifier?: string | null;
  /** "login" | "logout" | "signup" | "mfa" | "mfa_enroll" | "otp_request" | "otp_verify" | "password_change" | "lockout" | "session_revoked" | "setup" */
  kind: string;
  success: boolean;
  /** Never put a password, a code or a token here. */
  details?: Record<string, unknown>;
};

/** A row for the security log (`auth_events`): sign-ins, failures, lockouts. Batch item. */
export function authEventStatement(db: Db, ctx: Pick<RequestCtx, "now" | "ip" | "userAgent">, event: AuthEventInput): BatchStatement {
  return db.insert(authEvents).values({
    id: newId("aev"),
    subjectKind: event.subjectKind,
    subjectId: event.subjectId ?? null,
    identifier: event.identifier ? event.identifier.slice(0, 200) : null,
    kind: event.kind,
    success: event.success,
    ip: ctx.ip,
    userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 300) : null,
    details: event.details ?? null,
    at: ctx.now,
  });
}

/** Password fields: error keys are `required`, `password_too_short`, `password_too_long`. */
export const passwordField = (minLength: number) =>
  z.string({ error: "required" }).min(1, "required").min(minLength, "password_too_short").max(MAX_PASSWORD_LENGTH, "password_too_long");

export const CUSTOMER_PASSWORD_MIN = 8;
export const EMPLOYEE_PASSWORD_MIN = 12;

/**
 * A path that is safe to redirect to after signing in: it must be a local absolute path
 * ("/account/orders"), never another site ("//evil.example", "https://…", "/\evil"). With
 * `prefix`, it must also stay inside that area ("/admin"). Anything else yields `fallback`.
 */
export function safeNextPath(next: unknown, fallback: string, prefix?: string): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(next)) return fallback;
  let pathname: string;
  try {
    // Resolved against a dummy origin: if the origin changes, it was not a local path.
    const url = new URL(next, "https://local.invalid");
    if (url.origin !== "https://local.invalid") return fallback;
    pathname = url.pathname;
  } catch {
    return fallback;
  }
  if (prefix && pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return fallback;
  return next;
}
