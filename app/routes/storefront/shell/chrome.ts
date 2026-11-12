/**
 * Pure decisions behind the shell's chrome (client-safe, unit-tested in tests/shell.test.ts):
 *
 *   shellChrome(matches, { errored, path })  which shell a page gets (store · checkout · task), its bars and the
 *                                             offline banner's words
 *   backFallback(path)                        where the task header's back key leads when there is no page to go back to
 *   canonicalSearch(search)                   a query string exactly as the server renders it (hydration-safe hrefs)
 *   tabOf(path)                               which tab of the tab bar a page belongs to
 *   checkoutRail(search)                      the checkout bar's step rail from `?step=`
 *   searchMode(path, { errored })             the header's search FIELD, or only the round search KEY (v2.1 §2.7)
 *   megaPlan(platform) / megaFeature(platform)  what a platform's mega menu lists, and the product it features
 *   megaWords(t, slug, name)                  the menu's «كل أجهزة …» / «… المستعملة» words, one string per platform
 *   suggestionKind(href)                      what a search suggestion points at (its row's icon and words)
 *   suggestionMeta(item)                      a product suggestion's meta line: its qualifier, then its kind
 *   sheetCategories(categories)               the departments of the categories sheet, in order
 *   errorKind(error, online)                  which error panel a failure gets (offline is never a 500)
 *   missingProduct(error)                     the words of a product address that led nowhere (the product 404)
 *   platformForQuery(query, platforms)        the platform those words name, if any
 *   focusNudge(field, edges)                  how far to scroll so a focused field is not under a bar (WCAG 2.4.11)
 *   clampWords(text, fits)                    a title cut between words, «…» at its logical end (the task header)
 *   rateText(figure, symbol)                  «1 USD = 1,310 د.ع» with only the foreign side isolated
 */
import { isRouteErrorResponse } from "react-router";

import type { TFunction } from "~/i18n/translate";
import type { StockState } from "~/lib/dto";
import { STEPS, stepIndex, stepOf, type Step } from "~/routes/storefront/checkout/checkout-form";
import type { PolicySlug } from "~/routes/storefront/content/content-model";
import { isPlatform } from "~/ui/PlatformLed";
import { LAYOUT_ROUTE_ID } from "./meta";
import type { NavCategory, NavLink, NavPlatform, ShellChromeKind, ShellHandle } from "./types";

/** What the offline banner says: what was typed stays (forms) · the cart is kept (everywhere else). */
export type OfflineWords = "form" | "store";

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

/**
 * Each one-line footer link's words (keys of the shell's strings). Support is named with the NAVIGATION term «الدعم»
 * / "Support" (v2 §9 glossary): «مركز الدعم» is the title of the page it opens, not a link's name.
 */
export const TASK_FOOTER_LABELS = {
  "/policies/returns": "footer.returns",
  "/policies/privacy": "footer.privacy",
  "/policies/terms": "footer.terms",
  "/support": "nav.support",
} as const satisfies Record<(typeof TASK_FOOTER_LINKS)[number], string>;

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
  /**
   * The offline banner's words: the deepest `handle.shell.offline`; else "form" in checkout, task flows and under
   * /account (sign-in, sign-up and the account's forms), "store" elsewhere — and on an error page (no form on screen).
   */
  offline: OfflineWords;
};

const CHECKOUT_PATH = /^\/checkout(\/|$)/;
const ACCOUNT_PATH = /^\/account(\/|$)/;
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
  let offline: OfflineWords | null = null;
  for (const match of considered) {
    const shell = (match.handle as ShellHandle | null | undefined)?.shell;
    if (shell?.chrome === "checkout" || shell?.chrome === "task") declared = shell.chrome;
    if (shell?.tabBar === false) ownBar = true;
    if (typeof shell?.back === "string" && SITE_PATH.test(shell.back)) back = shell.back;
    if (shell?.offline === "form" || shell?.offline === "store") offline = shell.offline;
  }
  const chrome: ShellChromeKind = declared ?? (!options.errored && options.path !== undefined && CHECKOUT_PATH.test(options.path) ? "checkout" : "store");
  const forms = chrome !== "store" || (!options.errored && options.path !== undefined && ACCOUNT_PATH.test(options.path));
  return { chrome, tabBar: chrome === "store", task: chrome === "task" || (chrome === "store" && ownBar), back, offline: offline ?? (forms ? "form" : "store") };
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

/** The header's search: the field itself, or a round key that opens the same search (the search sheet). */
export type SearchMode = "field" | "key";

/**
 * Pages whose job is not finding products (Design v2.1 §2.7, client note 9): the cart and checkout, an order and its
 * tracking, support (all of /support), trade-in and its status, the account and its favourites, the store's own
 * pages (about, contact, policies, accessibility) and the internal ones (design system, motion lab).
 */
const SEARCH_KEY_PATH = /^\/(cart|checkout|order|track|support|trade-in|account|wishlist|about|contact|policies|accessibility|design-system|motion)(\/|$)/;

/**
 * Which search the header shows on a page (locale-less path), decided here for every width: the FIELD on pages for
 * finding products — home, platform / category / search listings, compare, products, device hubs, the used list and its
 * units, landing pages — and on every error page (`errored`: the 404's one search field is the header's); only the
 * round search KEY on the pages above (SEARCH_KEY_PATH), which opens the same search, so it stays one tap away.
 */
export function searchMode(path: string, options: { errored?: boolean } = {}): SearchMode {
  if (options.errored) return "field";
  return SEARCH_KEY_PATH.test(path) ? "key" : "field";
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

/**
 * One link of a mega-menu column as the menu shows it: the SHORT name (a device model's `short`, «PS5 Digital (2020)»,
 * never the SKU title), the read layer's count (null when the data has none — never invented) and, when the short
 * name differs, the `full` name for the pointer's tooltip.
 */
export type MegaLink = {
  label: string;
  href: string;
  count: number | null;
  full?: string;
  /**
   * The words a product link's Latin title leaves out («نسخة الأقراص», the read layer's `qualifier`): the menu prints
   * them on the link's own meta line, never inside the Latin name.
   */
  qualifier?: string;
  /** A device model's photo ("<product-slug>--<n>") when the read layer sends one with the link (`artKey`). */
  art?: string;
};

export type MegaPlan = {
  /** The platform's device models (their device hubs), and the platform's consoles category. */
  devices: MegaLink[];
  allDevices: string | null;
  /** The platform's own games categories; "all" = every game for the platform (multi-platform ones included). */
  games: MegaLink[];
  allGames: string | null;
  /** Controllers, headsets, storage, accessories … (filtered to the platform). */
  accessories: MegaLink[];
  /** Gift cards and subscriptions; the platform's used units come last (their words are the menu's, `megaWords`). */
  cards: MegaLink[];
  used: { href: string; count: number | null } | null;
};

const countOf = (link: Pick<NavLink, "count">): number | null =>
  typeof link.count === "number" && Number.isSafeInteger(link.count) && link.count >= 0 ? link.count : null;

/** A catalogue photo key ("<slug>--<n>"), as `media.art_key` stores it. */
const ART_KEY = /^[a-z0-9][a-z0-9-]*--\d+$/;

/**
 * A device link's photo, when the read layer sends one: `artKey` (device_models.art_key) is not part of NavLink yet —
 * the catalog area adds it (shell README "Contracts") — so it is read defensively and only a well-formed key is used.
 */
function artOf(link: NavLink): string | undefined {
  const value = (link as NavLink & { artKey?: unknown }).artKey;
  return typeof value === "string" && ART_KEY.test(value) ? value : undefined;
}

function megaLink(link: NavLink): MegaLink {
  const short = link.short?.trim();
  const shown: MegaLink = { label: short || link.label, href: link.href, count: countOf(link) };
  if (short && short !== link.label) shown.full = link.label;
  const qualifier = link.qualifier?.trim();
  if (qualifier) shown.qualifier = qualifier;
  const art = artOf(link);
  if (art) shown.art = art;
  return shown;
}

/** What a platform's mega menu lists (§5.4), from the navigation taxonomy. Empty columns are left out by the menu. */
export function megaPlan(platform: NavPlatform): MegaPlan {
  const games = platform.games.filter((link) => !CROSS_PLATFORM_GAMES.test(link.href));
  return {
    devices: platform.devices.slice(0, MEGA_LINKS).map(megaLink),
    allDevices: platform.allConsoles?.href ?? null,
    games: games.slice(0, MEGA_LINKS).map(megaLink),
    allGames: platform.games.length > 0 ? `/c/games?platform=${encodeURIComponent(platform.slug)}` : null,
    accessories: platform.accessories.filter((link) => !DIGITAL_CATEGORY.test(link.href)).slice(0, MEGA_LINKS).map(megaLink),
    cards: platform.accessories.filter((link) => DIGITAL_CATEGORY.test(link.href)).slice(0, MEGA_LINKS - 1).map(megaLink),
    used: platform.used ? { href: platform.used.href, count: countOf(platform.used) } : null,
  };
}

/** The mega menu's featured tile (§5.4): a 1:1 well with the product's photo, its name and its price. */
export type MegaFeature = {
  href: string;
  label: string;
  /** The words the Latin title leaves out («نسخة الأقراص»): the tile's meta line under the name; null when none. */
  qualifier: string | null;
  /** A catalogue photo ("<slug>--<n>"); null with no `mediaKey` either draws the glyph. */
  artKey: string | null;
  /** An uploaded photo (/media/<key>) when the product has no catalogue photo. */
  mediaKey: string | null;
  /** Integer IQD — the card's price (the version on sale); null when the navigation data carries none. */
  priceIqd: number | null;
  /** The card's state (a price that cannot be paid today is never shown without saying so); null without data. */
  stock: StockState | null;
  /** A demo row (the tile marks its price the way a product card does). */
  isDemo: boolean;
};

const slugOfProduct = (href: string) => /^\/p\/([^/?#]+)/.exec(href)?.[1] ?? null;

/**
 * The mega menu's featured product. The read layer picks it (`featured`: the platform's lead device when it can be
 * bought now, else its newest console that can — with its price, state and demo flag); null there means nothing to
 * feature. Without that pick (hand-written data): the console whose photo leads the platform (`artKey`, "<slug>--<n>"),
 * else the first console that HAS a photo, else the newest console. Never the glyph for a product that has a photo:
 * `photoOf(slug)` is the catalogue's first photo of a product (MegaMenu passes ~/art's productPhotos).
 */
export function megaFeature(platform: NavPlatform, photoOf: (slug: string) => string | null): MegaFeature | null {
  const featured = platform.featured;
  if (featured === null) return null;
  if (featured) {
    const slug = slugOfProduct(featured.href);
    const artKey = featured.image.artKey ?? (featured.image.mediaKey || !slug ? null : photoOf(slug));
    return {
      href: featured.href,
      label: featured.label,
      qualifier: featured.qualifier?.trim() || null,
      artKey,
      mediaKey: featured.image.artKey ? null : featured.image.mediaKey,
      priceIqd: featured.priceIqd,
      stock: featured.stock,
      isDemo: featured.isDemo,
    };
  }
  const bare = (link: NavLink, artKey: string | null): MegaFeature => ({
    href: link.href,
    label: link.label,
    qualifier: link.qualifier?.trim() || null,
    artKey,
    mediaKey: null,
    priceIqd: null,
    stock: null,
    isDemo: false,
  });
  const leadSlug = platform.artKey ? platform.artKey.replace(/--\d+$/, "") : null;
  const lead = leadSlug ? platform.consoles.find((link) => link.href === `/p/${leadSlug}`) : undefined;
  if (lead) return bare(lead, platform.artKey);
  for (const link of platform.consoles) {
    const slug = slugOfProduct(link.href);
    const photo = slug ? photoOf(slug) : null;
    if (photo) return bare(link, photo);
  }
  const first = platform.consoles[0];
  return first ? bare(first, null) : null;
}

/**
 * The mega menu's «كل أجهزة …» and «أجهزة … المستعملة» words: one string per platform the design system names (v2 §9 —
 * the handheld platform's name is itself a noun phrase, «الأجهزة المحمولة», so a template doubled it: «كل أجهزة
 * الأجهزة المحمولة», "All Handheld PCs consoles"); the `{name}` templates only for a platform it does not know.
 */
export function megaWords(t: TFunction, slug: string, name: string): { allDevices: string; usedOf: string } {
  if (isPlatform(slug)) return { allDevices: t(`nav.allDevicesOf.${slug}`), usedOf: t(`nav.usedOfPlatform.${slug}`) };
  return { allDevices: t("nav.allDevices", { name }), usedOf: t("nav.usedOf", { name }) };
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

/**
 * A fetch that never got an answer: the BROWSER's network failure, not a status from the store — Chromium "Failed to
 * fetch" (also "… dynamically imported module"), Firefox "NetworkError when attempting to fetch resource.", Safari "Load
 * failed" / "The network connection was lost." The same words app/root.tsx tests; never Node's server-side "fetch
 * failed" (a store failure, which reaches the browser as itself in development and must stay a 500 there too).
 */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch|networkerror|network error|load failed|network connection was lost/i.test(error.message);
}

/**
 * Which error panel a failure gets (v2 §6.16). `online` is the browser's belief (always true on the server and while
 * hydrating). A request that never reached the store is "offline" — never a 500, never "an error on our side" — the
 * same rule and the same words (`errors.offline`) as the root boundary (app/root.tsx). Only in the browser
 * (`inBrowser`): on the server a fetch TypeError is the store's own failure (an upstream it called) and stays a 500.
 */
export function errorKind(error: unknown, online: boolean, inBrowser = typeof window !== "undefined"): { kind: ErrorKind; status: number } {
  if (isRouteErrorResponse(error)) {
    const status = error.status;
    return { status, kind: status === 404 ? "notFound" : status === 403 || status === 401 ? "forbidden" : status === 503 ? "unavailable" : "error" };
  }
  return { status: 500, kind: inBrowser && (isNetworkFailure(error) || !online) ? "offline" : "error" };
}

/**
 * The words of a product address that led nowhere: the product page throws its 404 with
 * `{ error: "not_found", what: "product", query }` (the slug's words) — the panel then says the product is gone or its
 * link changed and searches those words (v2 §6.16 "missing product"). Null for any other failure.
 */
export function missingProduct(error: unknown): string | null {
  if (!isRouteErrorResponse(error) || error.status !== 404) return null;
  const data = error.data as { what?: unknown; query?: unknown } | null;
  if (!data || data.what !== "product") return null;
  const query = typeof data.query === "string" ? data.query.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return query;
}

const words = (text: string) => ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * The platform a missing product's words name — by the platform's slug or one of its device hubs or consoles (whole
 * words: "ps5 pro 2tb" → PlayStation, "nintendo switch 2 …" → Nintendo, "steam deck oled …" → the handhelds) — or null
 * (a game title alone names no platform; the panel then offers all four).
 */
export function platformForQuery(query: string, platforms: readonly NavPlatform[]): NavPlatform | null {
  const text = words(query);
  if (text.trim() === "") return null;
  const slugOf = (href: string) => href.replace(/^\/(device|p)\//, "").split(/[/?#]/)[0];
  return (
    platforms.find((platform) =>
      [platform.slug, ...platform.devices.map((link) => slugOf(link.href)), ...platform.consoles.map((link) => slugOf(link.href))]
        .map((token) => words(token))
        .some((token) => token.trim() !== "" && text.includes(token)),
    ) ?? null
  );
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

/**
 * A product suggestion's meta line (v2 §5.5 and the catalogue's qualifier): the words its Latin title leaves out
 * («نسخة الأقراص»), then its kind («جهاز PS5») — else its department. Its own line under the name, never glued into
 * the Latin title; "" when there is nothing to say.
 */
export function suggestionMeta(item: { qualifier?: string; kindLabel?: string; hint?: string }): string {
  const kind = item.kindLabel?.trim() || item.hint?.trim() || "";
  return [item.qualifier?.trim() ?? "", kind].filter((part) => part !== "").join(" · ");
}

/** The room a focused control must stay in, in viewport pixels: under the sticky top, above the fixed bottom bar. */
export type FocusEdges = { top: number; bottom: number };

/**
 * How far to scroll (px, positive = down) so a focused field is not under the sticky header or a bottom bar (WCAG
 * 2.4.11). The global `scroll-padding-block` covers a field the browser scrolls to; but a browser does not scroll a
 * field that is already partly in view, so «ملاحظات للمندوب» stayed with its lower 29px under the checkout task bar.
 * `field` is the control's rect, `edges` the room (viewport coordinates); `margin` the space kept from a bar. A field
 * taller than the room keeps its top in view (it is never pushed under the header).
 */
export function focusNudge(field: { top: number; bottom: number }, edges: FocusEdges, margin = 12): number {
  if (field.top < edges.top) return field.top - edges.top - margin;
  if (field.bottom > edges.bottom) {
    const down = field.bottom - edges.bottom + margin;
    const room = field.top - edges.top - margin;
    return Math.max(0, Math.min(down, room));
  }
  return 0;
}

/**
 * The longest start of `text` that fits, cut BETWEEN words with «…» at its logical end — the task header's one-line
 * title (§5.2). CSS `text-overflow` cuts at a visual edge: an Arabic title that ends in a Latin name («قاعدة الشحن
 * DualSense Charging Station») lost the START of the name («…lSense Charging Station»). `fits(candidate)` measures a
 * candidate in place. It never stops inside brackets («… Station (وێستگەی…» read as a broken bracket): the words a
 * bracket opens go together. A first word that alone does not fit is left whole (the CSS ellipsis then cuts it).
 */
export function clampWords(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const words = text.split(/\s+/).filter(Boolean);
  let low = 1;
  let high = words.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(`${words.slice(0, middle).join(" ")}…`)) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  // never inside brackets, never on a joiner («–…», «+…»); fewer words are narrower, so a shorter start still fits
  while (best > 0 && (openBrackets(words.slice(0, best).join(" ")) > 0 || !WORDLIKE.test(words[best - 1]))) best--;
  if (best === 0) return text;
  // nor on a colon or a comma: «Pokémon Legends…», not «Pokémon Legends:…»
  return `${words.slice(0, best).join(" ").replace(/[,،:;]+$/u, "")}…`;
}

const WORDLIKE = /[\p{L}\p{N}]/u;

/** How many brackets the text opens and does not close. */
function openBrackets(text: string): number {
  let open = 0;
  for (const char of text) {
    if (char === "(" || char === "[") open++;
    else if ((char === ")" || char === "]") && open > 0) open--;
  }
  return open;
}

const LRI = "⁦";
const FSI = "⁨";
const PDI = "⁩";

/**
 * The exchange rate in the footer's and the sheet's currency panel: «1 USD = 1,310 د.ع» inside the page's sentence
 * («سعر الصرف: …»). Only the foreign side is a left-to-right isolate; the dinar amount is a first-strong isolate with its
 * figure first and a no-break space before the currency (v2 §2.6) — the whole line in one left-to-right isolate put
 * «د.ع» before the figure in Arabic and Sorani, the opposite of every other price on the page.
 */
export function rateText(figure: string, symbol: string): string {
  return `${LRI}1 USD${PDI} = ${FSI}${figure} ${symbol}${PDI}`;
}
