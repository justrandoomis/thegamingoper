/**
 * POST /api/onboarding — the answers of the home page's intro and onboarding (docs/areas/home.md).
 *
 *   intro=seen        the intro was finished or skipped                → tt_intro=1
 *   consent=1 | 0     "remember my platforms and what I view"          → tt_consent (0 also deletes tt_platforms)
 *   platforms=a.b     the platforms picked: nintendo playstation xbox handheld — kept only with consent → tt_platforms
 *
 *   → 200 { ok: true, consent, platforms }      what is now in force on this device
 *   → 400 { ok: false, code: "invalid", fields } · 405 · 429 { ok: false, code: "rate_limited", retryAfterSec }
 *
 * The browser writes the same cookies itself first (./personal.ts), so the shopper never waits for this call and an
 * offline device still has its answer; the server repeats them (Secure on HTTPS) and, for a signed-in customer,
 * appends the answer to the consent history (recordPersonalizationConsent). Guests' answers are never stored on the
 * server. Same-origin POSTs only (the root middleware's CSRF check).
 */
import { data } from "react-router";
import type { Route } from "./+types/api.onboarding";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx, serializeCookie, type RequestCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { parseOnboarding, recordPersonalizationConsent } from "~/server/services/home.server";
import { CONSENT_COOKIE, INTRO_COOKIE, PLATFORMS_COOKIE, PREF_MAX_AGE_SEC, parseConsent, serializePlatformList } from "./personal";

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** A handful of short fields. */
const MAX_BODY_BYTES = 2 * 1024;
/** Consent rows a signed-in customer may add per minute (people answer once; scripts would not stop). */
const CONSENT_WRITES: RateLimitRule = { limit: 12, windowSec: 60 };

const setPref = (ctx: RequestCtx, name: string, value: string | null) =>
  ctx.setCookie(serializeCookie(ctx, name, value ?? "", { httpOnly: false, sameSite: "Lax", maxAge: value === null ? 0 : PREF_MAX_AGE_SEC }));

async function readForm(request: Request): Promise<Record<string, string>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return { form: "too_big" };
  try {
    const out: Record<string, string> = {};
    for (const [key, value] of await request.formData()) if (typeof value === "string" && !(key in out)) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

export function loader() {
  return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  try {
    const form = await readForm(request);
    if (form.form === "too_big") return data({ ok: false as const, code: "invalid", fields: { form: "too_big" } }, { status: 400, headers: NO_STORE });
    const answer = parseOnboarding(form);

    if (answer.introSeen) setPref(ctx, INTRO_COOKIE, "1");
    // The browser has usually written its cookie already, so the request cannot tell a change from a repeat: the
    // page sends `consent` only when the shopper answers, and every answer is recorded.
    const consent = answer.consent ?? parseConsent(ctx.cookie(CONSENT_COOKIE));
    if (answer.consent !== null) setPref(ctx, CONSENT_COOKIE, answer.consent ? "1" : "0");
    if (consent === false) setPref(ctx, PLATFORMS_COOKIE, null);
    else if (consent === true && answer.platforms !== null) setPref(ctx, PLATFORMS_COOKIE, answer.platforms.length > 0 ? serializePlatformList(answer.platforms) : null);

    if (answer.consent !== null) {
      const db = getDb();
      const customer = await getCustomer(ctx, db);
      if (customer) {
        await enforceRateLimit(db, await limitKey("onboarding", "customer", customer.customer.id), CONSENT_WRITES, ctx.now);
        await recordPersonalizationConsent(db, { customerId: customer.customer.id, granted: answer.consent, ip: ctx.ip, now: ctx.now });
      }
    }
    return data({ ok: true as const, consent, platforms: consent === true ? (answer.platforms ?? null) : [] }, { headers: NO_STORE });
  } catch (error) {
    const { status, retryAfterSec, ...failure } = actionError(error);
    const headers = new Headers(NO_STORE);
    if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
    return data({ ...failure, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
