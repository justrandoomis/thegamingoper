/**
 * Pure decisions behind the shell's chrome (client-safe, unit-tested in tests/shell.test.ts):
 *
 *   shellChrome(matches, { errored, path })  which shell a page gets (store · checkout · task) and its bars
 *   backFallback(path)                        where the task header's back key leads when there is no page to go back to
 *   canonicalSearch(search)                   a query string exactly as the server renders it (hydration-safe hrefs)
 *   tabOf(path)                               which tab of the tab bar a page belongs to
 *   checkoutRail(search)                      the checkout bar's step rail from `?step=`
 *   megaPlan(platform) / megaFeature(platform)  what a platform's mega menu lists
 *   suggestionKind(href)                      what a search suggestion points at (its row's icon and words)
 *   sheetCategories(categories)               the departments of the categories sheet, in order
 *   errorKind(error, online)                  which error panel a failure gets (offline is never a 500)
 */
import { isRouteErrorResponse } from "react-router";

import { STEPS, stepIndex, stepOf, type Step } from "~/routes/storefront/checkout/checkout-form";
import type { PolicySlug } from "~/routes/storefront/content/content-model";
import { LAYOUT_ROUTE_ID } from "./meta";
import type { NavCategory, NavLink, NavPlatform, ShellChromeKind, ShellHandle } from "./types";

/**
 * The policy pages the footer links (`/policies/<slug>`, content area), by column (Design System v2 §5.9): الدعم —
 * shipping, returns, warranty; عن طمطم — privacy, terms; طرق الدفع — payment. Every slug of the content area's
 * POLICY_SLUGS is here exactly once (tests/shell.test.ts). Each label is `footer.<slug>` in the shell's strings.
 */
export const FOOTER_POLICIES = {
  support: ["shipping", "returns", "warranty"],
  about: ["privacy", "terms"],
  payments: ["payment"],
} as const satisfies Record<"support" | "about" | "payments", readonly PolicySlug[]>;

/** The one-line footer of checkout and task flows (§5.8): الإرجاع · الخصوصية · الشروط · الدعم. */
export const TASK_FOOTER_LINKS = ["/policies/returns", "/policies/privacy", "/policies/terms", "/support"] as const;

/** The part of a route match the shell reads (`useMatches()` items). */
export type ShellMatch = { id: string; handle?: unknown };

export type ShellChrome = {
  /** The shell: store (strip, header, tab bar, full footer) · checkout (one bar, one-line footer) · task. */
  chrome: ShellChromeKind;
  /**
   * The tab bar is drawn (below 1024px): store pages only. It still gives way to a page's own <TaskBar> by CSS, so a
   * page that declares `tabBar: false` but draws no task bar (an empty cart) keeps the tab bar.
   */
  tabBar: boolean;
  /** The page has its own bottom bar (`tabBar: false`, or a task flow): below 1024 the header becomes the task header. */
  task: boolean;
  /** The deepest `handle.shell.back`, if a page declared one (locale-less path). */
  back: string | null;
};

const CHECKOUT_PATH = /^\/checkout(\/|$)/;
/** A path on this site: "/x", never "//host" (protocol-relative) or a full URL. */
const SITE_PATH = /^\/(?!\/)/;

/**
 * The chrome the matched routes ask for. `errored`: the storefront layout's ErrorBoundary is rendering (a page below it
 * threw, or the layout's own loader did) — the pages' handles no longer apply, because their components (and their
 * task bars) are not on screen: an unknown product URL gets the store shell with its tab bar. `path` (locale-less):
 * `/checkout` is the checkout shell even before its route declares `chrome: "checkout"`.
 */
export function shellChrome(matches: readonly ShellMatch[], options: { errored?: boolean; path?: string } = {}): ShellChrome {
  const considered = options.errored ? matches.slice(0, matches.findIndex((match) => match.id === LAYOUT_ROUTE_ID) + 1) : matches;
  let declared: Exclude<ShellChromeKind, "store"> | null = null;
  let ownBar = false;
  let back: string | null = null;
  for (const match of considered) {
    const shell = (match.handle as ShellHandle | null | undefined)?.shell;
    if (shell?.chrome === "checkout" || shell?.chrome === "task") declared = shell.chrome;
    if (shell?.tabBar === false) ownBar = true;
    if (typeof shell?.back === "string" && SITE_PATH.test(shell.back)) back = shell.back;
  }
  const chrome: ShellChromeKind = declared ?? (!options.errored && options.path !== undefined && CHECKOUT_PATH.test(options.path) ? "checkout" : "store");
  return { chrome, tabBar: chrome === "store", task: chrome === "task" || (chrome === "store" && ownBar), back };
}

/**
 * Where "back" leads on a task screen opened directly (no earlier page of this site in the tab's history): the
 * section the page belongs to. With history, the back key is real history Back instead (Header.tsx).
 *   /checkout → /cart · /used/<unit> → /used · /trade-in/<ref> → /trade-in · /support/<page> → /support
 *   /account/<section> → /account · anything else (a product, the cart) → /
 */
export function backFallback(path: string): string {
  if (CHECKOUT_PATH.test(path)) return "/cart";
  const section = /^\/(used|trade-in|support|account)\/[^?#]+/.exec(path);
  return section ? `/${section[1]}` : "/";
}

/**
 * The query string as React Router's server renders it. The server rebuilds the request's query through
 * URLSearchParams (react-router lib/server-runtime/urls.ts getNormalizedPath: "%20" → "+", "," → "%2C",
 * "?flag" → "?flag=", and the internal `_routes` parameter dropped), while the browser's `location.search` keeps the
 * address bar's raw text. Anything rendered from `location.search` must go through this, or the server's HTML and
 * the first client render differ and React reports a hydration mismatch. Idempotent: canonical in, same out.
 */
export function canonicalSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("_routes");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export type TabId = "home" | "categories" | "cart" | "wishlist" | "account";

const CATALOGUE = /^\/(c|platform|device|used|support|search|compare|trade-in|p)(\/|$)/;

/** Which tab the current page belongs to (locale-less path), or null (content pages). */
export function tabOf(path: string): TabId | null {
  if (path === "/") return "home";
  if (/^\/(cart|checkout)(\/|$)/.test(path)) return "cart";
  if (/^\/wishlist(\/|$)/.test(path)) return "wishlist";
  if (/^\/account(\/|$)/.test(path)) return "account";
  if (CATALOGUE.test(path)) return "categories";
  return null;
}

export type CheckoutRail = {
  /** 0-based index of the step on screen. */
  current: number;
  /** Every step in order; a step before the current one links back to itself (locale-less), the others do not. */
  steps: { id: Step; href: string | null }[];
};

/** The checkout bar's step rail (§5.8): the step comes from `?step=` (anything unknown is the first step). */
export function checkoutRail(search: string): CheckoutRail {
  const current = stepIndex(stepOf(search));
  return { current, steps: STEPS.map((id, index) => ({ id, href: index < current ? `/checkout?step=${id}` : null })) };
}

/** At most this many links per mega-menu column (§5.4: short model names, never a list of SKUs). */
export const MEGA_LINKS = 5;
const DIGITAL_CATEGORY = /^\/c\/(gift-cards|subscriptions|digital-cards)(\?|$)/;
/** The cross-platform games category leaves navigation: each platform lists its own games, multi-platform ones included. */
const CROSS_PLATFORM_GAMES = /^\/c\/multiplatform-games(\?|$)/;

export type MegaPlan = {
  /** The platform's device models (their device hubs), and the platform's consoles category. */
  devices: NavLink[];
  allDevices: string | null;
  /** The platform's own games categories; "all" = every game for the platform (multi-platform ones included). */
  games: NavLink[];
  allGames: string | null;
  /** Controllers, headsets, storage, accessories … (filtered to the platform). */
  accessories: NavLink[];
  /** Gift cards and subscriptions, and the platform's used units. */
  cards: NavLink[];
  used: string | null;
};

/** What a platform's mega menu lists (§5.4), from the navigation taxonomy. Empty columns are left out by the menu. */
export function megaPlan(platform: NavPlatform): MegaPlan {
  const games = platform.games.filter((link) => !CROSS_PLATFORM_GAMES.test(link.href));
  return {
    devices: platform.devices.slice(0, MEGA_LINKS),
    allDevices: platform.allConsoles?.href ?? null,
    games: games.slice(0, MEGA_LINKS),
    allGames: platform.games.length > 0 ? `/c/games?platform=${encodeURIComponent(platform.slug)}` : null,
    accessories: platform.accessories.filter((link) => !DIGITAL_CATEGORY.test(link.href)).slice(0, MEGA_LINKS),
    cards: platform.accessories.filter((link) => DIGITAL_CATEGORY.test(link.href)).slice(0, MEGA_LINKS - 1),
    used: platform.used?.href ?? null,
  };
}

/**
 * The mega menu's featured tile: the product whose official photo leads the platform (`artKey`, "<slug>--<n>"), when
 * it is one of the platform's listed consoles; else the newest console. Null when the platform lists none. Its price
 * is not in the navigation data yet, so the tile shows the photo and the name only.
 */
export function megaFeature(platform: NavPlatform): { href: string; label: string; artKey: string | null } | null {
  const slug = platform.artKey ? platform.artKey.replace(/--\d+$/, "") : null;
  const lead = slug ? platform.consoles.find((link) => link.href === `/p/${slug}`) : undefined;
  if (lead) return { href: lead.href, label: lead.label, artKey: platform.artKey };
  const first = platform.consoles[0];
  return first ? { href: first.href, label: first.label, artKey: null } : null;
}

/**
 * The departments the categories sheet shows (v2 §5.10), in this order: controllers, headsets, storage, VR, gift cards,
 * accessories, games. Consoles and handheld PCs live inside their platforms (the platform tiles above them).
 */
export const SHEET_CATEGORY_KINDS = ["controllers", "headsets", "storage", "vr", "digital", "accessories", "games"] as const;

export function sheetCategories(categories: readonly NavCategory[]): NavCategory[] {
  const order: readonly string[] = SHEET_CATEGORY_KINDS;
  return categories.filter((category) => order.includes(category.kind) && category.count > 0).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}

export type ErrorKind = "notFound" | "forbidden" | "unavailable" | "offline" | "error";

/** A fetch that never got an answer: the browser's network failure, not a status from the store. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && /fetch|network|load failed/i.test(error.message);
}

/**
 * Which error panel a failure gets (v2 §6.16). `online` is the browser's belief (always true on the server and while
 * hydrating). A request that never reached the store is "offline" — never a 500, never "an error on our side".
 */
export function errorKind(error: unknown, online: boolean): { kind: ErrorKind; status: number } {
  if (isRouteErrorResponse(error)) {
    const status = error.status;
    return { status, kind: status === 404 ? "notFound" : status === 403 || status === 401 ? "forbidden" : status === 503 ? "unavailable" : "error" };
  }
  return { status: 500, kind: isNetworkFailure(error) || !online ? "offline" : "error" };
}

export type SuggestionKind = "product" | "platform" | "category" | "device" | "used" | "correction" | "other";

/** What a suggestion (`{ label, href }` from GET /api/search/suggest) points at, from its locale-less href. */
export function suggestionKind(href: string): SuggestionKind {
  if (/^\/p\//.test(href)) return "product";
  if (/^\/platform\//.test(href)) return "platform";
  if (/^\/c\//.test(href)) return "category";
  if (/^\/device\//.test(href)) return "device";
  if (/^\/used(\/|\?|$)/.test(href)) return "used";
  if (/^\/search\?/.test(href)) return "correction";
  return "other";
}
