/**
 * /api/recently-viewed — the ONE recently-viewed list of a shopper (docs/areas/home.md "Recently viewed"):
 * a guest's list lives on the device (./personal.ts, `tt:recent`, only with consent — the server stores nothing);
 * a signed-in customer's list lives in the account (services/account/recently-viewed.server, only with consent).
 * The product page writes exactly one of them; nothing is kept twice.
 *
 *   GET  ?ids=prd_a,prd_b&locale=en      → 200 { ok: true, cards }   a guest's device list: cards in the order asked;
 *                                           unknown or unpublished ids are left out; 400 for more than 12 ids or a
 *                                           malformed one
 *   GET  ?scope=account&locale=en        → 200 { ok: true, cards, scope }   a signed-in customer's list (scope
 *                                           "account"), or `scope: "none"` and no cards (guest, or no consent)
 *   POST productId=prd_x                 → 200 { ok: true, kept, merged }   a signed-in customer viewed a product (the
 *        [device=[{"id":…,"at":…}]]         product page, once it is on screen); `device` hands this device's guest
 *                                           list to the account — the browser empties it when `merged` is a number.
 *                                           A guest, or no consent: nothing is stored (`kept: false`, `merged: null`)
 *   POST intent=clear                    → 200 { ok: true, cleared }      "clear the list" for a signed-in customer
 *   400 { ok: false, code: "invalid", fields } · 429 { ok: false, code: "rate_limited", retryAfterSec } (Retry-After)
 *
 * Consent is the signed-in customer's latest answer, else the device's `tt_consent` (personalizationFor). Cross-site
 * POSTs get 403 from the root middleware; POSTs are rate-limited per IP. `no-store`: the lists are personal.
 */
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/api.recently-viewed";
import { isLocale } from "~/lib/locales";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, invalid } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { clearRecentlyViewed, listRecentlyViewed, mergeDeviceRecentlyViewed, recordRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import { getRecentlyViewedCards, RECENT_MAX } from "~/server/services/home.server";
import { personalizationFor } from "~/server/services/recommendations.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** Far above what a person produces (one view per product page), low enough to make flooding pointless. */
const WRITES_PER_MINUTE: RateLimitRule = { limit: 60, windowSec: 60 };
const MAX_BODY_BYTES = 4 * 1024;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

const DeviceList = z.array(z.object({ id: z.string().regex(PRODUCT_ID), at: z.number().int().nonnegative() })).max(RECENT_MAX);

function failure(error: unknown) {
  const { status, retryAfterSec, ...rest } = actionError(error);
  const headers = new Headers(NO_STORE);
  if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
  return data({ ...rest, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const asked = url.searchParams.get("locale");
  const locale = isLocale(asked) ? asked : ctx.locale;
  try {
    const db = getDb();
    if (url.searchParams.get("scope") === "account") {
      const customer = await getCustomer(ctx, db);
      const customerId = customer?.customer.id ?? null;
      const who = customerId ? await personalizationFor(db, { cookie: ctx.cookie, customerId }) : null;
      if (!customerId || !who?.consent) return data({ ok: true as const, cards: [], scope: "none" as const }, { headers: NO_STORE });
      const cards = await listRecentlyViewed(db, { customerId, cartToken: null }, locale, ctx.now, RECENT_MAX);
      return data({ ok: true as const, cards, scope: "account" as const }, { headers: NO_STORE });
    }
    const raw = url.searchParams.get("ids") ?? "";
    const ids = raw === "" ? [] : raw.split(",");
    const cards = ids.length === 0 ? [] : await getRecentlyViewedCards(db, locale, ids, ctx.now);
    return data({ ok: true as const, cards, scope: "device" as const }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}

async function readForm(request: Request): Promise<Record<string, string>> {
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw invalid({ form: "too_big" }, "home.recent");
  try {
    const out: Record<string, string> = {};
    for (const [key, value] of await request.formData()) if (typeof value === "string" && !(key in out)) out[key] = value;
    return out;
  } catch {
    return {};
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "GET, POST" } });
  try {
    const db = getDb();
    await enforceRateLimit(db, await limitKey("recent", "ip", ctx.ip), WRITES_PER_MINUTE, ctx.now);
    const form = await readForm(request);
    const customer = await getCustomer(ctx, db);
    const customerId = customer?.customer.id ?? null;

    if (form.intent === "clear") {
      const cleared = customerId ? await clearRecentlyViewed(db, { customerId, cartToken: null }) : 0;
      return data({ ok: true as const, cleared }, { headers: NO_STORE });
    }

    const productId = form.productId ? form.productId.trim() : "";
    if (productId !== "" && !PRODUCT_ID.test(productId)) throw invalid({ productId: "invalid" }, "home.recent");
    let device: z.infer<typeof DeviceList> | null = null;
    if (form.device) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(form.device);
      } catch {
        throw invalid({ device: "invalid" }, "home.recent");
      }
      const result = DeviceList.safeParse(parsed);
      if (!result.success) throw invalid({ device: "invalid" }, "home.recent");
      device = result.data;
    }
    if (productId === "" && device === null) throw invalid({ productId: "required" }, "home.recent");

    // A guest's list never leaves the device; without consent nothing is kept for anyone.
    if (!customerId) return data({ ok: true as const, kept: false, merged: null }, { headers: NO_STORE });
    const who = await personalizationFor(db, { cookie: ctx.cookie, customerId });
    if (!who.consent) return data({ ok: true as const, kept: false, merged: null }, { headers: NO_STORE });

    // The device's older views first, then this view: the newest time wins for a product on both lists.
    const merged = device ? await mergeDeviceRecentlyViewed(db, customerId, device, ctx.now, { consent: true }) : null;
    const kept = productId ? await recordRecentlyViewed(db, { customerId, cartToken: null }, productId, ctx.now, { consent: true }) : false;
    return data({ ok: true as const, kept, merged }, { headers: NO_STORE });
  } catch (error) {
    return failure(error);
  }
}
