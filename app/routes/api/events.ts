/**
 * /api/events — recommendation signals from the browser (docs/areas/devices.md; services/recommendations.server.ts).
 *
 *   POST /api/events   kind=view|click|add  productId=prd_…  [source=device_hub:setup:switch-2]
 *        → 200 { ok: true, recorded: boolean }      recorded=false without personalization consent: NOTHING is stored
 *                                                    and no cookie is set (also: a repeat inside its window, a product
 *                                                    that is not published)
 *   POST /api/events   intent=forget
 *        → 200 { ok: true, forgotten: n }           deletes this device's signals (and a signed-in customer's) and
 *                                                    clears the `tt_rs` cookie — always allowed, with or without consent
 *   400 { ok: false, code: "invalid", fields }       e.g. kind=purchase: purchases are recorded by server code only
 *   429 { ok: false, code: "rate_limited", retryAfterSec } (Retry-After)    ·    GET → 405
 *
 * Consent is the signed-in customer's latest `consents` answer, else this device's `tt_consent` cookie. A consenting
 * guest is keyed by a random first-party httpOnly cookie (`tt_rs`, 90 days, only its SHA-256 is stored) created on the
 * first recorded signal; a customer by their id. No IP address, user agent or other fingerprint is stored. The body
 * may be form data (navigator.sendBeacon with URLSearchParams, fetchers) or JSON. Cross-site posts get 403 from the
 * root middleware; per-IP rate limit.
 */
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/events";
import { sha256Hex } from "~/lib/ids";
import { getCustomer } from "~/server/auth/customer.server";
import { clearCookie, getCtx, serializeCookie } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, invalid, zodFieldErrors } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import {
  forgetEvents,
  isRecSessionToken,
  newRecSessionToken,
  personalizationFor,
  PUBLIC_EVENT_KINDS,
  REC_SESSION_COOKIE,
  REC_SESSION_MAX_AGE_SEC,
  recordEvent,
} from "~/server/services/recommendations.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** Signals per IP per minute: far above what a person produces, low enough to make flooding pointless. */
const EVENTS_PER_MINUTE: RateLimitRule = { limit: 120, windowSec: 60 };
const MAX_BODY_BYTES = 4 * 1024;

const blank = (value: unknown) => (value === "" || value === null ? undefined : value);
const PublicEvent = z.object({
  kind: z.enum(PUBLIC_EVENT_KINDS),
  productId: z.string().max(128, "too_long"),
  source: z.preprocess(blank, z.string().max(64, "too_long").optional()),
});

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return {};
  const type = request.headers.get("Content-Type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body: unknown = await request.json();
      return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    }
    const form = await request.formData();
    const out: Record<string, unknown> = {};
    for (const [key, value] of form) if (typeof value === "string" && !(key in out)) out[key] = value;
    return out;
  } catch {
    // an unreadable body is an empty one: validation then says what is missing
    return {};
  }
}

export async function loader(_: Route.LoaderArgs) {
  return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  const db = getDb();
  try {
    await enforceRateLimit(db, await limitKey("events", "ip", ctx.ip), EVENTS_PER_MINUTE, ctx.now);
    const body = await readBody(request);
    const customer = await getCustomer(ctx, db);
    const customerId = customer?.customer.id ?? null;

    if (body.intent === "forget") {
      const token = ctx.cookie(REC_SESSION_COOKIE);
      const sessionHash = isRecSessionToken(token) ? await sha256Hex(token) : null;
      const forgotten = await forgetEvents(db, { sessionHash, customerId });
      if (token !== null) ctx.setCookie(clearCookie(ctx, REC_SESSION_COOKIE));
      return data({ ok: true as const, forgotten }, { headers: NO_STORE });
    }

    const parsed = PublicEvent.safeParse(body);
    if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "api.events");
    const who = await personalizationFor(db, { cookie: ctx.cookie, customerId });
    if (!who.consent) return data({ ok: true as const, recorded: false }, { headers: NO_STORE });

    let subject = who;
    if (!customerId && !who.sessionHash) {
      // the first consented signal of this guest: a fresh random key, never derived from the device
      const token = newRecSessionToken();
      ctx.setCookie(serializeCookie(ctx, REC_SESSION_COOKIE, token, { maxAge: REC_SESSION_MAX_AGE_SEC, httpOnly: true, sameSite: "Lax" }));
      subject = { ...who, sessionHash: await sha256Hex(token) };
    }
    const result = await recordEvent(db, subject, parsed.data, ctx.now);
    return data({ ok: true as const, recorded: result.recorded }, { headers: NO_STORE });
  } catch (error) {
    // expected failures become { ok: false, code, fields }; anything else is a bug and goes to the error handler
    const { status, retryAfterSec, ...failure } = actionError(error);
    const headers = new Headers(NO_STORE);
    if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
    return data({ ...failure, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
