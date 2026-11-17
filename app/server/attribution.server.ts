/**
 * Campaign attribution (admin 16.04): which of the store's campaign links brought a shopper — kept WITHOUT a cookie.
 *
 *   // the root middleware (context.server.ts), after each response — never awaited, never a reason to fail a request:
 *   const visit = campaignVisit(request, url, ctx, queuedCookies, response.status);   // pure; null for nearly every request
 *   if (visit) waitUntil(recordCampaignVisit(getDb(), env.KV, visit));                // the link's click, the cart's campaign
 *
 *   // the checkout, when it places the order (orders.attribution, orders.utm_link_id):
 *   await placeOrder(db, { ...who, attribution: await cartAttribution(env.KV, cartToken) }, input, now);
 *
 * WHY NO COOKIE. The privacy policy names every cookie the store sets and says none of them is for advertising or
 * analytics; the home page says nothing is kept on the device before the shopper agrees, and the one consent the store
 * asks (personalised suggestions) is limited to arranging the page. Campaign attribution is none of these and no consent
 * question covers it, so it stores nothing on the device and reads nothing new from it:
 *
 *   · the link's CLICK — a browser opening a store page through a tracked link (`tt_l` = utm_links.code) adds 1 to
 *     `utm_links.clicks` (links.server, recordLinkClick): a count, nothing about the person. Not bots or link previews,
 *     not prefetches, not React Router's data requests (they repeat the page's URL at every revalidation), only a
 *     response that was a page (2xx), and at most CLICK_LIMIT per address and window (the rate-limit counters, which
 *     the privacy policy already names and the daily job deletes after a day).
 *   · the CART's campaign — when such a visit comes from a shopper who HAS a cart (the cart cookie the store sets for
 *     the cart itself), or who STARTS one from that page (the request that creates the cart — adding to it — comes from
 *     the landing page, whose same-origin Referer still carries the parameters), the campaign is kept ON THE SERVER with
 *     that cart: KV `attribution/cart/<hash of the cart token>`, CART_ATTRIBUTION_DAYS, the newest campaign wins (a
 *     reload writes nothing; at most KEEP_LIMIT writes per address and hour, KEEP_STORE_LIMIT a day for the whole store). The order placed from that cart carries
 *     it. A shopper who browses on before starting a cart, or signs in after starting it (the cart then joins their
 *     account's under a new key), is not attributed: the honest cost of keeping nothing on the device.
 *   · only the campaign parameters, cleaned, never trusted: utm_source, utm_medium, utm_campaign, utm_content and
 *     utm_term — lower case, letters / digits / "_" "." "-", at most 60; a value with anything else (an e-mail, a web
 *     address, markup, control characters) or a run of 9+ digits (a phone number) is DROPPED, never repaired — and tt_l
 *     ([a-z0-9]{4,24}). A visit without a source or a link code is no campaign. Never the page, the referrer, the
 *     address, the browser or anything typed.
 *
 * Nothing here can break a page or a checkout: every step catches its own failure (logged), and placeOrder places the
 * order without a source it cannot read (orderSource). Must not import "cloudflare:workers" (placeOrder imports it):
 * the database, the KV namespace and the request are passed in.
 */
import { eq } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import { toLatinDigits } from "~/lib/phone";
import type { Db } from "./db/drizzle.server";
import { utmLinks, type OrderAttribution } from "./db/schema";
import { limitKey, rateLimit, type RateLimitRule } from "./ratelimit.server";
import { recordLinkClick } from "./services/admin/marketing/links.server";

/** A campaign as a link names it, cleaned (each value null when absent or refused). */
export type Campaign = { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null; link: string | null };

/** The query parameters read, and nothing else. */
export const CAMPAIGN_PARAMS = { source: "utm_source", medium: "utm_medium", campaign: "utm_campaign", content: "utm_content", term: "utm_term", link: "tt_l" } as const;

/** At most this many clicks are counted per address and window (an IPv6 caller by its /64). Generous: mobile networks put many people behind one address. */
export const CLICK_LIMIT: RateLimitRule = { limit: 60, windowSec: 10 * 60 };

/**
 * At most this many campaigns kept (KV writes) per address and hour. KV writes are few and the file store (payment
 * proofs) shares them: crafted landings must not spend them. A reload of the same campaign writes nothing at all.
 */
export const KEEP_LIMIT: RateLimitRule = { limit: 30, windowSec: 60 * 60 };

/**
 * At most this many campaigns kept (KV writes) a day by the WHOLE store, whatever the addresses. The Workers free plan
 * allows 1,000 KV writes a day for the namespace, and the file store (payment proofs, trade-in photos) needs them: a
 * popular campaign, or crafted landings from many addresses, must never leave a shopper unable to upload a proof. Past
 * it a cart simply keeps the campaign it had (or none) until the next day — attribution is lost, never a checkout.
 */
export const KEEP_STORE_LIMIT: RateLimitRule = { limit: 250, windowSec: 24 * 60 * 60 };

/** How long a cart keeps the campaign it came through (the KV entry expires on its own). */
export const CART_ATTRIBUTION_DAYS = 7;

/** = CART_COOKIE of ~/server/shell.server (tests/attribution.test.ts keeps them equal; that module reads the database binding). */
export const ATTRIBUTION_CART_COOKIE = "tt_cart";

const KV_PREFIX = "attribution/cart/";
const RAW_MAX = 200;
const VALUE_MAX = 60;
const VALUE = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}_.-]*$/u;
const PHONE_LIKE = /\d{9,}/;
const LINK_CODE = /^[a-z0-9]{4,24}$/;
const CART_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

// ───────────────────────────────────────────────────────────────── cleaning (pure)

/** One UTM value, cleaned: NFKC, Latin digits, trimmed, lower case, spaces → "-"; null when anything else is in it. */
export function campaignValue(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > RAW_MAX) return null;
  const text = toLatinDigits(raw.normalize("NFKC")).trim().toLowerCase().replace(/\s+/g, "-");
  if (!text || text.length > VALUE_MAX || !VALUE.test(text) || PHONE_LIKE.test(text)) return null;
  return text;
}

/** A link code (utm_links.code), or null. */
export function linkCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  const code = raw.trim().toLowerCase();
  return LINK_CODE.test(code) ? code : null;
}

function campaignOf(read: (name: keyof typeof CAMPAIGN_PARAMS) => unknown): Campaign | null {
  const campaign: Campaign = {
    source: campaignValue(read("source")),
    medium: campaignValue(read("medium")),
    campaign: campaignValue(read("campaign")),
    content: campaignValue(read("content")),
    term: campaignValue(read("term")),
    link: linkCode(read("link")),
  };
  return campaign.source || campaign.link ? campaign : null;
}

/** The campaign a URL's query names (the first value of each parameter), or null: no source and no link code is no campaign. */
export function campaignFromParams(params: URLSearchParams): Campaign | null {
  return campaignOf((name) => params.get(CAMPAIGN_PARAMS[name]));
}

/** A campaign read back (the KV entry, placeOrder's `who.attribution`), cleaned again exactly the same way. */
export function cleanCampaign(value: unknown): Campaign | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return campaignOf((name) => record[name]);
}

/** What `orders.attribution` keeps: the UTM values given (the link itself is `orders.utm_link_id`); null when there are none. */
export function orderAttributionOf(campaign: Campaign | null): OrderAttribution | null {
  if (!campaign) return null;
  const out: OrderAttribution = {};
  if (campaign.source) out.source = campaign.source;
  if (campaign.medium) out.medium = campaign.medium;
  if (campaign.campaign) out.campaign = campaign.campaign;
  if (campaign.content) out.content = campaign.content;
  if (campaign.term) out.term = campaign.term;
  return Object.keys(out).length > 0 ? out : null;
}

// ───────────────────────────────────────────────────────────────── a request (pure)

/** What one request said about a campaign. */
export type CampaignVisit = {
  campaign: Campaign;
  /** A browser opened a page through a tracked link: the link's click counts. */
  click: boolean;
  /** The cart the campaign is kept with: the shopper's own (their cart cookie), or the one this request started. */
  cartToken: string | null;
  ip: string | null;
  now: number;
};

const mentionsCampaign = (text: string) => text.includes("utm_") || text.includes("tt_l=");
const tokenOf = (value: string | null | undefined) => (typeof value === "string" && CART_TOKEN.test(value) ? value : null);
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|meta-externalagent|whatsapp|embedly|curl|wget|python|okhttp|go-http-client|java\/|headless|lighthouse|pingdom|uptime/i;

/**
 * True when a person's browser opened the page: a top-level navigation (Sec-Fetch-Dest "document" / mode "navigate"
 * when the browser sends them), with a browser's User-Agent — not a crawler, a link preview (WhatsApp, Telegram,
 * Facebook… fetch a link to draw its card), a monitor or a script — and not a prefetch or prerender.
 */
export function isBrowserOpen(request: Request): boolean {
  const agent = request.headers.get("User-Agent") ?? "";
  if (!agent || BOT.test(agent)) return false;
  const purpose = ["Sec-Purpose", "Purpose", "X-Purpose", "X-Moz"].map((name) => request.headers.get(name) ?? "").join(" ").toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender") || purpose.includes("preview")) return false;
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest && dest !== "document") return false;
  const mode = request.headers.get("Sec-Fetch-Mode");
  return !mode || mode === "navigate";
}

/** The cart token a response sets for the FIRST time (the cart was started by this request), or null. */
function startedCart(queued: readonly string[]): string | null {
  for (let index = queued.length - 1; index >= 0; index--) {
    const cookie = queued[index];
    if (!cookie.startsWith(`${ATTRIBUTION_CART_COOKIE}=`)) continue;
    if (/;\s*Max-Age=0\s*(?:;|$)/i.test(cookie)) return null;
    try {
      return tokenOf(decodeURIComponent(cookie.slice(ATTRIBUTION_CART_COOKIE.length + 1).split(";")[0]));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * What a request says about a campaign — no I/O, null for nearly every request:
 *   · a LANDING: a GET of a store page (never React Router's `.data` requests, /api or /admin) whose URL carries campaign
 *     parameters and whose answer was a page (2xx). Its click counts when a person's browser opened it (isBrowserOpen)
 *     and it names a link; its campaign is kept with the cart the shopper already has.
 *   · a CART STARTED on a landing page: any other request that sets a new cart cookie (adding to the cart) and whose
 *     same-origin Referer carries campaign parameters. Never counted as a click.
 * `queued` are the Set-Cookie values the middleware is about to send; `status` is the response's.
 */
export function campaignVisit(request: Request, url: URL, ctx: { cookie(name: string): string | null; ip: string | null; now: number }, queued: readonly string[], status: number): CampaignVisit | null {
  const path = url.pathname;
  if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin.")) return null;
  if (request.method === "GET") {
    if (!mentionsCampaign(url.search) || path.endsWith(".data") || path.startsWith("/api/") || status < 200 || status >= 300) return null;
    const campaign = campaignFromParams(url.searchParams);
    if (!campaign) return null;
    const click = campaign.link !== null && isBrowserOpen(request);
    const cartToken = tokenOf(ctx.cookie(ATTRIBUTION_CART_COOKIE));
    return click || cartToken ? { campaign, click, cartToken, ip: ctx.ip, now: ctx.now } : null;
  }
  if (request.method === "HEAD" || request.method === "OPTIONS") return null;
  const cartToken = startedCart(queued);
  const referer = request.headers.get("Referer");
  if (!cartToken || !referer || !mentionsCampaign(referer)) return null;
  let from: URL;
  try {
    from = new URL(referer);
  } catch {
    return null;
  }
  if (from.origin !== url.origin) return null;
  const campaign = campaignFromParams(from.searchParams);
  return campaign ? { campaign, click: false, cartToken, ip: ctx.ip, now: ctx.now } : null;
}

// ───────────────────────────────────────────────────────────────── the writes and the read

const cartKey = async (cartToken: string) => `${KV_PREFIX}${await sha256Hex(`tamtam.attribution.cart|${cartToken}`)}`;

/**
 * Records one visit: the link's click (within CLICK_LIMIT) and the campaign kept with the cart (KV, the newest wins).
 * Each part on its own; a failure is logged and never thrown — the request it came from is long answered.
 */
export async function recordCampaignVisit(db: Db, kv: KVNamespace | null | undefined, visit: CampaignVisit): Promise<{ clicked: boolean; kept: boolean }> {
  let clicked = false;
  let kept = false;
  if (visit.click && visit.campaign.link) {
    try {
      const verdict = await rateLimit(db, await limitKey("utm-click", "ip", visit.ip), CLICK_LIMIT, visit.now);
      if (verdict.ok) clicked = await recordLinkClick(db, visit.campaign.link);
    } catch (error) {
      console.error("[attribution] the link's click was not counted", error);
    }
  }
  if (visit.cartToken && kv) {
    try {
      const { source, medium, campaign, content, term, link } = visit.campaign;
      const key = await cartKey(visit.cartToken);
      const value = JSON.stringify({ source, medium, campaign, content, term, link });
      // a reload of the landing page writes nothing (KV writes are few, and slow per key); another campaign replaces it
      if ((await kv.get(key)) === value) kept = true;
      else if (
        (await rateLimit(db, await limitKey("attribution", "ip", visit.ip), KEEP_LIMIT, visit.now)).ok &&
        (await rateLimit(db, await limitKey("attribution", "store", "kv-writes"), KEEP_STORE_LIMIT, visit.now)).ok
      ) {
        await kv.put(key, value, { expirationTtl: CART_ATTRIBUTION_DAYS * 86_400 });
        kept = true;
      }
    } catch (error) {
      console.error("[attribution] the campaign was not kept with the cart", error);
    }
  }
  return { clicked, kept };
}

/** The campaign kept with this cart, cleaned again — what the checkout hands placeOrder as `who.attribution`. Null when none; never throws. */
export async function cartAttribution(kv: KVNamespace | null | undefined, cartToken: string | null | undefined): Promise<Campaign | null> {
  const token = tokenOf(cartToken);
  if (!kv || !token) return null;
  try {
    return cleanCampaign(await kv.get(await cartKey(token), "json"));
  } catch (error) {
    console.error("[attribution] the cart's campaign was not read", error);
    return null;
  }
}

/**
 * What placeOrder writes: `orders.attribution` (the UTM values) and `orders.utm_link_id` (the link with that code, when
 * it exists). The campaign is cleaned again here — `who` is built by a route —, and nothing about it can refuse or break
 * the order: a source that cannot be read is no source.
 */
export async function orderSource(db: Db, raw: unknown): Promise<{ attribution: OrderAttribution | null; utmLinkId: string | null }> {
  let campaign: Campaign | null = null;
  try {
    campaign = cleanCampaign(raw);
  } catch {
    campaign = null;
  }
  if (!campaign) return { attribution: null, utmLinkId: null };
  let utmLinkId: string | null = null;
  if (campaign.link) {
    try {
      utmLinkId = (await db.select({ id: utmLinks.id }).from(utmLinks).where(eq(utmLinks.code, campaign.link)).get())?.id ?? null;
    } catch (error) {
      console.error("[attribution] the order's link was not looked up", error);
    }
  }
  return { attribution: orderAttributionOf(campaign), utmLinkId };
}
