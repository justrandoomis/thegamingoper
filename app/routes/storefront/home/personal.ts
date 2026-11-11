/**
 * Personalisation on this device — the cookies and the local storage the home area owns. Client-safe: nothing touches
 * the DOM when the module loads, every browser helper is a no-op on the server.
 *
 *   tt_intro       "1" once the intro was finished or skipped (the root loader reads it: `introSeen`)
 *   tt_consent     "1" / "0" — the shopper's answer to "remember my platforms and what I view" (root:
 *                  `personalizationConsent`; null = never asked). Other areas gate personal features on it.
 *   tt_platforms   "playstation.xbox" — the platforms the shopper picked; written only while tt_consent is "1",
 *                  removed when it becomes "0". The home loader reads it to light the stage for them.
 *   localStorage "tt:recent"   recently viewed products [{ id, at }], newest first, at most RECENT_MAX, kept
 *                  RECENT_DAYS — written only while tt_consent is "1", wiped when consent is withdrawn.
 *
 * Read consent on the client with readConsent() (the cookie itself): root loader data is only refreshed on a
 * document load or after a form POST, so it can be a visit behind.
 *
 * RECENTLY VIEWED — ONE STORE PER SHOPPER (integration pass; docs/areas/home.md, account.md):
 *   signed out   this device's list above (`tt:recent`), never sent anywhere;
 *   signed in    the account's list on the server (services/account/recently-viewed.server) — and nothing on the device.
 * The product page calls recordProductView(id, { signedIn }) once it is on screen, which writes exactly one of the
 * two. The first time a signed-in customer opens a product, the home page or the account overview, this device's
 * guest list is handed to the account (handDeviceListToAccount) and removed from the device — so a view is never
 * kept twice and a shared device keeps nothing of a customer after they sign out. Nothing at all without consent.
 */
import { PLATFORMS, isPlatform, type Platform } from "~/ui/PlatformLed";

export const INTRO_COOKIE = "tt_intro";
export const CONSENT_COOKIE = "tt_consent";
export const PLATFORMS_COOKIE = "tt_platforms";
export const RECENT_KEY = "tt:recent";
/** Same as RECENT_MAX in ~/server/services/home.server (the endpoint refuses more). */
export const RECENT_MAX = 12;
/** Retention of the recently-viewed list on the device. */
export const RECENT_DAYS = 90;
/** One year, like the preferences cookie. */
export const PREF_MAX_AGE_SEC = 365 * 24 * 60 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

// ───────────────────────────────────────────────────────────────── pure

/** "playstation.xbox" → ["playstation", "xbox"]: known platforms only, once each, in the order given (max four). */
export function parsePlatformList(value: string | null | undefined): Platform[] {
  if (!value) return [];
  const out: Platform[] = [];
  for (const part of value.split(/[.,\s]+/)) if (isPlatform(part) && !out.includes(part)) out.push(part);
  return out.slice(0, PLATFORMS.length);
}

export function serializePlatformList(list: readonly Platform[]): string {
  return parsePlatformList(list.join(".")).join(".");
}

/** "1" → true, "0" → false, anything else → null (not asked). */
export function parseConsent(value: string | null | undefined): boolean | null {
  return value === "1" ? true : value === "0" ? false : null;
}

export type RecentEntry = { id: string; at: number };

/** The stored list, cleaned: well-formed entries only, newest first, unique, within RECENT_DAYS, at most RECENT_MAX. */
export function cleanRecent(value: unknown, now: number): RecentEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const entry of [...value].sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0))) {
    const id = entry?.id;
    const at = Number(entry?.at);
    if (typeof id !== "string" || !RECENT_ID.test(id) || !Number.isFinite(at) || seen.has(id)) continue;
    if (at > now + DAY_MS || now - at > RECENT_DAYS * DAY_MS) continue;
    seen.add(id);
    out.push({ id, at });
    if (out.length === RECENT_MAX) break;
  }
  return out;
}

/** The list after viewing `id` at `now`: it moves to the front. */
export function pushRecent(list: readonly RecentEntry[], id: string, now: number): RecentEntry[] {
  if (!RECENT_ID.test(id)) return cleanRecent(list, now);
  return cleanRecent([{ id, at: now }, ...list.filter((entry) => entry.id !== id)], now);
}

// ───────────────────────────────────────────────────────────────── browser

const inBrowser = () => typeof document !== "undefined";

export function readCookieValue(name: string): string | null {
  if (!inBrowser()) return null;
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function writeCookie(name: string, value: string | null): void {
  if (!inBrowser()) return;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    value === null
      ? `${name}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${PREF_MAX_AGE_SEC}; SameSite=Lax${secure}`;
}

export const readConsent = (): boolean | null => parseConsent(readCookieValue(CONSENT_COOKIE));
export const readIntroSeen = (): boolean => readCookieValue(INTRO_COOKIE) === "1";
export const readSavedPlatforms = (): Platform[] => (readConsent() ? parsePlatformList(readCookieValue(PLATFORMS_COOKIE)) : []);

function storage(): Storage | null {
  try {
    return inBrowser() ? window.localStorage : null;
  } catch {
    return null; // storage switched off (private mode, policy)
  }
}

export function readRecentlyViewed(now = Date.now()): RecentEntry[] {
  if (readConsent() !== true) return [];
  try {
    return cleanRecent(JSON.parse(storage()?.getItem(RECENT_KEY) ?? "[]"), now);
  } catch {
    return [];
  }
}

/** Remember that the shopper looked at a product — only with their consent. Never throws. */
export function rememberViewed(productId: string, now = Date.now()): void {
  if (readConsent() !== true) return;
  try {
    storage()?.setItem(RECENT_KEY, JSON.stringify(pushRecent(readRecentlyViewed(now), productId, now)));
  } catch {
    /* full or blocked storage: nothing is remembered */
  }
}

export function forgetRecentlyViewed(productId?: string): void {
  try {
    const store = storage();
    if (!store) return;
    if (!productId) store.removeItem(RECENT_KEY);
    else store.setItem(RECENT_KEY, JSON.stringify(readRecentlyViewed().filter((entry) => entry.id !== productId)));
  } catch {
    /* nothing to forget */
  }
}

/** Removes some entries (the ones the account took over) and keeps the rest. Never throws. */
function forgetRecentEntries(ids: ReadonlySet<string>): void {
  try {
    const store = storage();
    if (!store || ids.size === 0) return;
    const left = readRecentlyViewed().filter((entry) => !ids.has(entry.id));
    if (left.length === 0) store.removeItem(RECENT_KEY);
    else store.setItem(RECENT_KEY, JSON.stringify(left));
  } catch {
    /* nothing to forget */
  }
}

export type AccountRecentAnswer = { ok: boolean; kept: boolean; merged: number | null };

/**
 * POST /api/recently-viewed for a signed-in customer: this view (when given) and this device's guest list. When the
 * account took the list over (`merged` is a number), the sent entries leave the device. Resolves to null on a network
 * failure (the device list then simply stays for the next try). Never throws.
 */
async function sendToAccount(productId: string | null): Promise<AccountRecentAnswer | null> {
  if (!inBrowser() || readConsent() !== true) return null;
  const entries = readRecentlyViewed();
  const body = new URLSearchParams();
  if (productId) body.set("productId", productId);
  if (entries.length > 0) body.set("device", JSON.stringify(entries));
  if (!productId && entries.length === 0) return null;
  try {
    const response = await fetch("/api/recently-viewed", { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { Accept: "application/json" } });
    const answer = (await response.json().catch(() => null)) as AccountRecentAnswer | null;
    if (!response.ok || !answer?.ok) return null;
    if (typeof answer.merged === "number" && entries.length > 0) forgetRecentEntries(new Set(entries.map((entry) => entry.id)));
    return answer;
  } catch {
    return null;
  }
}

/**
 * A product page is on screen (call it once per product, after the page rendered): the view goes to the ONE store
 * that applies — this device's list for a guest, the account for a signed-in customer (with this device's guest list,
 * which the account takes over). Nothing without consent. Fire and forget; never throws.
 */
export function recordProductView(productId: string, options: { signedIn: boolean }): void {
  if (readConsent() !== true || !RECENT_ID.test(productId)) return;
  if (options.signedIn) void sendToAccount(productId);
  else rememberViewed(productId);
}

/**
 * Signed in: hands this device's guest list to the account once (then it leaves the device). Resolves to true when
 * the account took something over — a page showing the account's list should then read it again.
 */
export async function handDeviceListToAccount(): Promise<boolean> {
  if (readRecentlyViewed().length === 0) return false;
  const answer = await sendToAccount(null);
  return typeof answer?.merged === "number" && answer.merged > 0;
}

/** The intro was finished or skipped: never shown again on this device (it can be replayed from the home page). */
export function saveIntroSeen(): void {
  writeCookie(INTRO_COOKIE, "1");
}

/**
 * The shopper's answer. true: remember `platforms` (when given). false: remember nothing — the platforms cookie and
 * the recently-viewed list are deleted on this device.
 */
export function saveConsent(granted: boolean, platforms?: readonly Platform[]): void {
  writeCookie(CONSENT_COOKIE, granted ? "1" : "0");
  if (!granted) {
    writeCookie(PLATFORMS_COOKIE, null);
    forgetRecentlyViewed();
    return;
  }
  if (platforms) writeCookie(PLATFORMS_COOKIE, platforms.length > 0 ? serializePlatformList(platforms) : null);
}

/**
 * Tells the server what changed (POST /api/onboarding): it sets the same cookies and, for a signed-in customer,
 * records the consent answer. Fire and forget — the device already has the answer; a failure changes nothing
 * the shopper sees. Resolves to whether the server confirmed it.
 */
export async function sendOnboarding(fields: { intro?: boolean; consent?: boolean; platforms?: readonly Platform[] }): Promise<boolean> {
  if (!inBrowser()) return false;
  const body = new URLSearchParams();
  if (fields.intro) body.set("intro", "seen");
  if (fields.consent !== undefined) body.set("consent", fields.consent ? "1" : "0");
  if (fields.platforms) body.set("platforms", serializePlatformList(fields.platforms));
  try {
    const response = await fetch("/api/onboarding", { method: "POST", body, keepalive: true, credentials: "same-origin", headers: { Accept: "application/json" } });
    return response.ok;
  } catch {
    return false;
  }
}
