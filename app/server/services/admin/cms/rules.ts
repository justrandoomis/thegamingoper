/**
 * Admin module 17 — content and storefront experience: the rules every screen and service of the module shares.
 * Pure and client-safe (no database, no server-only imports): routes use it for forms and previews, services for the
 * same checks again on the server, and the storefront may use the arrangement helpers on data from the read services.
 *
 *   normalizeStorePath("/en/P/Old-Name/?x=1#a", { query: true })   → { ok: true, path: "/p/old-name", query: "?x=1" }
 *   redirectConflict(activeRows, { fromPath, toPath })            → "redirect_chain_target" | … | null
 *   arrangeBySlug(taxonomy.platforms, arrangement.platforms)      → the staff order, hidden ones left out, `featured`
 *   arrangeHomeSections(layout)                                   → the home sections to render, in order
 *   parseBaghdadLocal("2026-11-20T09:00")                         → epoch ms (Iraq time, UTC+3, no daylight saving)
 */
import type { L10n } from "~/lib/locales";

export const CMS_NS = "admin-cms";

// ───────────────────────────────────────────────────────────────── Iraq time

/** Asia/Baghdad is UTC+3 all year. */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Arabic-Indic and Persian digits → 0–9 (staff type either). */
export function latinDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-11-20T09:00" (a datetime-local value, Iraq time; Arabic digits accepted) → epoch ms; null when malformed. */
export function parseBaghdadLocal(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_RE.exec(latinDigits(value.trim()));
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi) - BAGHDAD_OFFSET_MS;
  // 31 February rolls over in Date.UTC: refuse it instead of moving the date
  const check = new Date(ms + BAGHDAD_OFFSET_MS);
  return check.getUTCDate() === d && check.getUTCMonth() === mo - 1 ? ms : null;
}

/** Epoch ms → "2026-11-20T09:00" in Iraq time (for a datetime-local input); "" for null. */
export function baghdadLocal(at: number | null | undefined): string {
  if (typeof at !== "number" || !Number.isFinite(at)) return "";
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 16);
}

/** The Iraq calendar day of an instant, "YYYY-MM-DD". */
export function baghdadDay(at: number): string {
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-11-20" → epoch ms of 00:00 that day in Iraq; null when malformed. */
export function parseBaghdadDay(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const match = DAY_RE.exec(latinDigits(value.trim()));
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - BAGHDAD_OFFSET_MS;
  return baghdadDay(ms) === `${match[1]}-${match[2]}-${match[3]}` ? ms : null;
}

/** Two windows overlap (null start = from the beginning, null end = open-ended). Touching ends do not overlap. */
export function windowsOverlap(a: { startsAt: number | null; endsAt: number | null }, b: { startsAt: number | null; endsAt: number | null }): boolean {
  const aStart = a.startsAt ?? Number.NEGATIVE_INFINITY;
  const bStart = b.startsAt ?? Number.NEGATIVE_INFINITY;
  const aEnd = a.endsAt ?? Number.POSITIVE_INFINITY;
  const bEnd = b.endsAt ?? Number.POSITIVE_INFINITY;
  return aStart < bEnd && bStart < aEnd;
}

/** Live at `now`: inside the window (start inclusive, end exclusive). */
export function inWindow(row: { startsAt: number | null; endsAt: number | null }, now: number): boolean {
  return (row.startsAt === null || row.startsAt <= now) && (row.endsAt === null || row.endsAt > now);
}

// ───────────────────────────────────────────────────────────────── storefront paths

/** Locale prefixes of the storefront (Arabic has none). Redirects and links are stored without them. */
export const LOCALE_PREFIXES = ["en", "ckb"] as const;

/**
 * Paths that are never a redirect's source or target and never a content link: the admin, the API, built assets, and
 * the files search engines and browsers ask for by name.
 */
export const RESERVED_PREFIXES = ["/admin", "/api", "/assets", "/build", "/fonts", "/icons", "/products", "/.well-known", "/cdn-cgi"] as const;
export const RESERVED_PATHS = ["/sitemap.xml", "/robots.txt", "/favicon.ico", "/favicon.svg", "/site.webmanifest", "/icons.svg", "/apple-touch-icon.png"] as const;

export const PATH_MAX = 300;

export type PathCheck = { ok: true; path: string; query: string } | { ok: false; code: "path_invalid" | "path_reserved" | "path_external" | "path_query" };

/** True for /admin…, /api…, assets and the named files (RESERVED_*). Expects a normalized, locale-less path. */
export function isReservedPath(path: string): boolean {
  const lower = path.toLowerCase();
  if ((RESERVED_PATHS as readonly string[]).includes(lower)) return true;
  return RESERVED_PREFIXES.some((prefix) => lower === prefix || lower.startsWith(`${prefix}/`));
}

/**
 * A locale-less storefront path from what staff typed or a shopper requested: trimmed, the hash dropped, the locale
 * prefix (/en, /ckb) removed, percent-escapes decoded, lower case, repeated and trailing slashes removed. The query
 * is kept apart (`query: false` refuses one). `http(s)://` input is `path_external` — the caller decides whether an
 * external URL is allowed. Reserved paths (the admin, the API…) are `path_reserved`.
 */
export function normalizeStorePath(raw: string, options: { query: boolean }): PathCheck {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (/^https?:\/\//i.test(value)) return { ok: false, code: "path_external" };
  if (value === "" || value.length > PATH_MAX || !value.startsWith("/") || value.startsWith("//") || /[\s\\<>"`]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, code: "path_invalid" };
  }
  const withoutHash = value.split("#", 1)[0];
  const at = withoutHash.indexOf("?");
  const rawPath = at === -1 ? withoutHash : withoutHash.slice(0, at);
  const query = at === -1 ? "" : withoutHash.slice(at);
  if (query !== "" && query !== "?" && !options.query) return { ok: false, code: "path_query" };
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { ok: false, code: "path_invalid" };
  }
  if (/[\u0000-\u001f\u007f\\]/.test(decoded)) return { ok: false, code: "path_invalid" };
  const segments = decoded.normalize("NFC").toLowerCase().split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return { ok: false, code: "path_invalid" };
  const isLocale = (segment: string | undefined) => segment !== undefined && (LOCALE_PREFIXES as readonly string[]).includes(segment);
  if (isLocale(segments[0])) {
    segments.shift();
    // one language prefix at most: "/ckb/en/admin" is no store path (read as "/en/admin" it slipped past the reserved
    // paths, review 2026-11-12)
    if (isLocale(segments[0])) return { ok: false, code: "path_invalid" };
  }
  const path = `/${segments.join("/")}`;
  if (isReservedPath(path)) return { ok: false, code: "path_reserved" };
  return { ok: true, path, query: query === "?" ? "" : query };
}

/** The store's own hosts. A full address on one of them is a store path: ownStorePath. */
export const STORE_HOSTS = ["tamtamgames.com", "www.tamtamgames.com"] as const;

/**
 * The path (and query) of a full http(s) address on the store's own host — tamtamgames.com, its www name, or the host
 * of one of `origins` (the request's own origin: a preview deployment, a local server) — else null:
 *
 *   ownStorePath("https://www.tamtamgames.com/en/p/x?y=1#a")   → "/en/p/x?y=1"
 *   ownStorePath("https://example.com/x")                      → null
 *
 * Redirect targets and banner links pass through it BEFORE they are told apart as paths or external URLs, so a full
 * address of the store is checked as the path it is: never the admin or the API, no loop, no chain (review
 * 2026-11-12: "/a → https://tamtamgames.com/b" with "/b → https://tamtamgames.com/a" was an endless loop).
 */
export function ownStorePath(raw: string, origins: readonly string[] = []): string | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!/^https?:\/\//i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const hosts = new Set<string>(STORE_HOSTS);
  for (const origin of origins) {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      hosts.add(host);
      hosts.add(host.startsWith("www.") ? host.slice(4) : `www.${host}`);
    } catch {
      // not an origin
    }
  }
  if (!hosts.has(url.hostname.toLowerCase())) return null;
  return `${url.pathname || "/"}${url.search}`;
}

/**
 * An external link staff may use: https only, a real host, no credentials. Full addresses of the store itself never
 * reach this check: callers turn them into paths first (ownStorePath), so the path rules hold for them.
 */
export function isSafeExternalUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length > 500) return false;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && url.hostname.includes(".") && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

// ───────────────────────────────────────────────────────────────── redirects

export const REDIRECT_CODES = [301, 302] as const;
export type RedirectCode = (typeof REDIRECT_CODES)[number];

export type RedirectRuleRow = { id: string; fromPath: string; toPath: string; isActive: boolean };

/** The path part of a stored target ("/c/x?platform=y" → "/c/x"); null for an external URL. */
export function targetPathOf(toPath: string): string | null {
  if (/^https?:\/\//i.test(toPath)) return null;
  return toPath.split(/[?#]/, 1)[0] || "/";
}

export type RedirectConflict = "redirect_self" | "redirect_from_taken" | "redirect_loop" | "redirect_chain_target" | "redirect_chain_source";

/**
 * What would break if this redirect were active next to the others (only ACTIVE rows chain; the source is unique
 * among all rows): it points at itself, its source is another rule's, its target is itself redirected (A → B while
 * B → C: a chain; B → A: a loop), or another active rule points at its source (C → A while A → B: a chain).
 */
export function redirectConflict(rows: readonly RedirectRuleRow[], candidate: { id?: string | null; fromPath: string; toPath: string; isActive?: boolean }): RedirectConflict | null {
  const target = targetPathOf(candidate.toPath);
  if (target !== null && target === candidate.fromPath) return "redirect_self";
  const others = rows.filter((row) => row.id !== candidate.id);
  if (others.some((row) => row.fromPath === candidate.fromPath)) return "redirect_from_taken";
  if (candidate.isActive === false) return null;
  const active = others.filter((row) => row.isActive);
  if (target !== null) {
    const next = active.find((row) => row.fromPath === target);
    if (next) return targetPathOf(next.toPath) === candidate.fromPath ? "redirect_loop" : "redirect_chain_target";
  }
  if (active.some((row) => targetPathOf(row.toPath) === candidate.fromPath)) return "redirect_chain_source";
  return null;
}

// ───────────────────────────────────────────────────────────────── banners

/** Where a banner can stand. "category:<id>" scopes a category banner to one category (by id, never by name). */
export const BANNER_PLACEMENTS = ["home_strip", "category_top", "cart"] as const;
export type BannerPlacementKey = (typeof BANNER_PLACEMENTS)[number];
export const CATEGORY_PLACEMENT_PREFIX = "category:";
export const BANNER_ACCENTS = ["brand", "nintendo", "playstation", "xbox", "handheld"] as const;
export type BannerAccent = (typeof BANNER_ACCENTS)[number];
export const BANNER_STATUSES = ["draft", "scheduled", "published", "archived"] as const;
export type BannerStatus = (typeof BANNER_STATUSES)[number];
export const BANNER_TEXT = { title: 80, subtitle: 160, cta: 30 } as const;

/** The banner list's views (URL `view`). */
export const BANNER_VIEWS = ["all", "live", "upcoming", "draft", "ended", "archived"] as const;
export type BannerView = (typeof BANNER_VIEWS)[number];
/** The schedule's spans in days (URL `days`). */
export const SCHEDULE_SPANS = [14, 30, 60, 90] as const;
/** The redirect and synonym lists' states (URL `state`). */
export const ACTIVE_STATES = ["all", "active", "inactive"] as const;

export function isBannerPlacement(value: string): boolean {
  if ((BANNER_PLACEMENTS as readonly string[]).includes(value)) return true;
  return value.startsWith(CATEGORY_PLACEMENT_PREFIX) && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.slice(CATEGORY_PLACEMENT_PREFIX.length));
}

/** What a published or scheduled row shows at `now`: live, waiting for its start, or over. */
export type LiveState = "live" | "upcoming" | "ended" | "draft" | "archived";
export function liveStateOf(row: { status: string; startsAt: number | null; endsAt: number | null }, now: number): LiveState {
  if (row.status === "archived") return "archived";
  if (row.status !== "published" && row.status !== "scheduled") return "draft";
  // a scheduled row without a start never runs (the storefront's reads skip it): it is not on the store
  if (row.status === "scheduled" && row.startsAt === null) return "draft";
  if (row.endsAt !== null && row.endsAt <= now) return "ended";
  if (row.startsAt !== null && row.startsAt > now) return "upcoming";
  return "live";
}

// ───────────────────────────────────────────────────────────────── the home page

/** The four platform stages of the home page (= home.server's HOME_PLATFORMS; a test keeps them equal). */
export const HERO_PLATFORMS = ["nintendo", "playstation", "xbox", "handheld"] as const;
export type HeroPlatform = (typeof HERO_PLATFORMS)[number];
export const isHeroPlatform = (value: unknown): value is HeroPlatform => typeof value === "string" && (HERO_PLATFORMS as readonly string[]).includes(value);

/** `home_sections.kind` of a pinned hero. */
export const HERO_PIN_KIND = "hero_pin";
export const HERO_TEXT = { headline: 60, deck: 140 } as const;
/** Longest window of one pin. */
export const HERO_PIN_MAX_DAYS = 120;

export type HeroPinConfig = { platform: HeroPlatform; productId: string; headline: L10n; deck: L10n | null };

const isL10nWithAr = (value: unknown): value is L10n => typeof value === "object" && value !== null && typeof (value as { ar?: unknown }).ar === "string" && (value as { ar: string }).ar.trim() !== "";

/** A pin's config read defensively (a JSON column): null when it is not a complete pin. */
export function readPinConfig(value: unknown): HeroPinConfig | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (!isHeroPlatform(raw.platform) || typeof raw.productId !== "string" || raw.productId === "" || !isL10nWithAr(raw.headline)) return null;
  return { platform: raw.platform, productId: raw.productId, headline: raw.headline, deck: isL10nWithAr(raw.deck) ? raw.deck : null };
}

/**
 * The home page's sections below the hero, in the order the page draws them today (home area, docs/areas/home.md).
 * The hero always comes first and is not arranged here; "personal" (what is remembered, stop and delete) holds the
 * shopper's privacy controls and can never be hidden.
 */
export const HOME_SECTIONS = ["new_arrivals", "used_repairs", "games", "deals", "used", "accessories", "coming_soon", "platforms", "recently_viewed", "recommendations", "personal"] as const;
export type HomeSectionKind = (typeof HOME_SECTIONS)[number];
export const LOCKED_HOME_SECTIONS: ReadonlySet<HomeSectionKind> = new Set<HomeSectionKind>(["personal"]);
export const isHomeSection = (value: unknown): value is HomeSectionKind => typeof value === "string" && (HOME_SECTIONS as readonly string[]).includes(value);

export type HomeSectionPlacement = { kind: HomeSectionKind; visible: boolean };

/**
 * The sections to draw, in order: the arranged ones first (hidden ones left out, never a locked one), then any
 * section the arrangement does not name, in the page's own order. Unknown kinds are ignored.
 */
export function arrangeHomeSections(placements: readonly { kind: string; visible: boolean }[] | null | undefined): HomeSectionKind[] {
  const out: HomeSectionKind[] = [];
  const seen = new Set<string>();
  for (const placement of placements ?? []) {
    if (!isHomeSection(placement.kind) || seen.has(placement.kind)) continue;
    seen.add(placement.kind);
    if (placement.visible || LOCKED_HOME_SECTIONS.has(placement.kind)) out.push(placement.kind);
  }
  for (const kind of HOME_SECTIONS) if (!seen.has(kind)) out.push(kind);
  return out;
}

// ───────────────────────────────────────────────────────────────── navigation and filters

/** `nav_menus.key` of the staff arrangement of the generated catalogue navigation. */
export const NAV_MENU_KEY = "catalog";
export const NAV_FEATURED_MAX = 3;

/** One generated entry as staff placed it: by its catalogue id ("platform:<id>" / "category:<id>"), never its name. */
export type NavEntryState = { ref: string; hidden: boolean; featured: boolean };
/** What the read service hands the storefront: the same placements, resolved to today's slugs. */
export type NavPlacement = { slug: string; hidden: boolean; featured: boolean };
export type NavArrangement = { platforms: NavPlacement[]; categories: NavPlacement[]; updatedAt: number | null };

/**
 * A generated list in the staff's order: the placed entries first (hidden ones left out), then everything the
 * arrangement does not name yet (a new category) in the catalogue's order. `featured` marks what staff featured.
 */
export function arrangeBySlug<T extends { slug: string }>(items: readonly T[], placements: readonly NavPlacement[] | null | undefined): Array<T & { featured: boolean }> {
  const bySlug = new Map(items.map((item) => [item.slug, item]));
  const out: Array<T & { featured: boolean }> = [];
  const seen = new Set<string>();
  for (const placement of placements ?? []) {
    const item = bySlug.get(placement.slug);
    if (!item || seen.has(placement.slug)) continue;
    seen.add(placement.slug);
    if (!placement.hidden) out.push({ ...item, featured: placement.featured });
  }
  for (const item of items) if (!seen.has(item.slug)) out.push({ ...item, featured: false });
  return out;
}

/** The storefront listing's filter groups (= catalog listing-model FILTER_GROUPS; a test keeps them equal). */
export const LISTING_FILTER_GROUPS = ["platforms", "category", "device", "price", "inStock", "deals", "arabic", "formats"] as const;
export type ListingFilterGroup = (typeof LISTING_FILTER_GROUPS)[number];
export const isListingFilterGroup = (value: unknown): value is ListingFilterGroup => typeof value === "string" && (LISTING_FILTER_GROUPS as readonly string[]).includes(value);
/** The widget each group uses on the storefront (catalog_filters.widget). */
export const FILTER_WIDGET: Record<ListingFilterGroup, "checkbox" | "range" | "toggle"> = {
  platforms: "checkbox",
  category: "checkbox",
  device: "checkbox",
  price: "range",
  inStock: "toggle",
  deals: "toggle",
  arabic: "checkbox",
  formats: "checkbox",
};

export type FilterPlacement = { group: ListingFilterGroup; visible: boolean };

/** The filter groups a listing offers, in order: the arranged visible ones, then the groups not named, in default order. */
export function arrangeFilterGroups(placements: readonly { group: string; visible: boolean }[] | null | undefined): ListingFilterGroup[] {
  const out: ListingFilterGroup[] = [];
  const seen = new Set<string>();
  for (const placement of placements ?? []) {
    if (!isListingFilterGroup(placement.group) || seen.has(placement.group)) continue;
    seen.add(placement.group);
    if (placement.visible) out.push(placement.group);
  }
  for (const group of LISTING_FILTER_GROUPS) if (!seen.has(group)) out.push(group);
  return out;
}

// ───────────────────────────────────────────────────────────────── pages and policies

/** Policies this module edits and approves; returns and warranty are module 22's (/admin/settings/policies/:slug). */
export const POLICIES_HERE = ["shipping", "payment", "privacy", "terms"] as const;
export const POLICIES_IN_SETTINGS = ["returns", "warranty"] as const;
export const FIXED_PAGES = ["about", "contact"] as const;
/** Landing pages live under this storefront path (the storefront route is requested from the storefront team). */
export const LANDING_PATH_PREFIX = "/pages";
export const LANDING_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+){0,9}$/;
export const LANDING_SLUG_MAX = 60;
export const PAGE_TEXT = { title: 90, description: 200, body: 20_000 } as const;
/** Slugs a landing page may not take (the fixed pages, the policies, words a route might use). */
export const RESERVED_PAGE_SLUGS: ReadonlySet<string> = new Set(["shipping", "returns", "warranty", "payment", "privacy", "terms", "about", "contact", "policies", "new", "preview", "edit"]);

export type EditablePageKind = "policy" | "about" | "contact" | "landing";

export function storePathOfPage(kind: string, slug: string): string {
  if (kind === "policy") return `/policies/${slug}`;
  if (kind === "about") return "/about";
  if (kind === "contact") return "/contact";
  return `${LANDING_PATH_PREFIX}/${slug}`;
}

/** Which page an editor URL slug names: a policy here, a policy of module 22, about/contact, or a landing page. */
export function pageRefOf(slug: string): { kind: EditablePageKind; slug: string; inSettings: boolean } | null {
  if ((POLICIES_HERE as readonly string[]).includes(slug)) return { kind: "policy", slug, inSettings: false };
  if ((POLICIES_IN_SETTINGS as readonly string[]).includes(slug)) return { kind: "policy", slug, inSettings: true };
  if (slug === "about" || slug === "contact") return { kind: slug, slug, inSettings: false };
  if (slug.length <= LANDING_SLUG_MAX && LANDING_SLUG_RE.test(slug) && !RESERVED_PAGE_SLUGS.has(slug)) return { kind: "landing", slug, inSettings: false };
  return null;
}

// ───────────────────────────────────────────────────────────────── SEO

/** Character budgets: a search result shows ~60 characters of a title and ~160 of a description. */
export const SEO_LIMITS = { titleIdeal: 60, titleMax: 70, descriptionMin: 50, descriptionIdeal: 160, descriptionMax: 200 } as const;
export const SEO_ISSUES = ["title_missing", "title_long", "description_missing", "description_short", "description_long", "duplicate_title", "noindex"] as const;
export type SeoIssue = (typeof SEO_ISSUES)[number];
export const SEO_ENTITY_TYPES = ["product", "category", "page"] as const;
export type SeoEntityType = (typeof SEO_ENTITY_TYPES)[number];

const length = (text: string) => [...text].length;

/** What a search engine would be given: the issues of one entry's Arabic SEO text (duplicates are found across rows). */
export function seoIssues(input: { title: string | null; description: string | null; noindex: boolean }): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const title = input.title?.trim() ?? "";
  const description = input.description?.trim() ?? "";
  if (title === "") issues.push("title_missing");
  else if (length(title) > SEO_LIMITS.titleIdeal) issues.push("title_long");
  if (description === "") issues.push("description_missing");
  else if (length(description) < SEO_LIMITS.descriptionMin) issues.push("description_short");
  else if (length(description) > SEO_LIMITS.descriptionIdeal) issues.push("description_long");
  if (input.noindex) issues.push("noindex");
  return issues;
}

/** A search-result line as an engine might cut it: at most `max` characters, an ellipsis when cut. */
export function clipText(text: string, max: number): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// ───────────────────────────────────────────────────────────────── search synonyms

export const SEARCH_LOCALES = ["ar", "en", "ckb"] as const;
export type SearchLocale = (typeof SEARCH_LOCALES)[number];
export const SYNONYM_LIMITS = { form: 60, forms: 20 } as const;

/** The spellings typed into one field: separated by new lines, commas (, ،) or semicolons; empty ones dropped. */
export function splitForms(text: string): string[] {
  return String(text ?? "")
    .split(/[\n,،;؛]+/)
    .map((form) => form.trim())
    .filter(Boolean);
}

export const ZERO_RESULT_DAYS = [7, 30, 90] as const;

// ───────────────────────────────────────────────────────────────── list URL state

export const PAGE_SIZE = 30;

export function pageOf(value: string | null): number {
  const n = Number(latinDigits(value ?? ""));
  return Number.isSafeInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

/** A query parameter from a closed list, else the fallback. */
export function oneOf<T extends string>(value: string | null, list: readonly T[], fallback: T): T;
export function oneOf<T extends string>(value: string | null, list: readonly T[], fallback: null): T | null;
export function oneOf<T extends string>(value: string | null, list: readonly T[], fallback: T | null): T | null {
  return value !== null && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** A search box value from the URL: trimmed, at most 80 characters. */
export function queryText(value: string | null): string {
  return (value ?? "").trim().slice(0, 80);
}

/** A URL query string from parameters, without empty or default values. */
export function queryString(params: Record<string, string | number | null | undefined>, defaults: Record<string, string | number> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "" || String(value) === String(defaults[key] ?? "\u0000")) continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

// ───────────────────────────────────────────────────────────────── preview

/** How long a signed preview link opens (staff only, inside the admin). */
export const PREVIEW_TTL_MS = 7 * DAY_MS;
export const PREVIEW_KINDS = ["banner", "page", "pin"] as const;
export type PreviewKind = (typeof PREVIEW_KINDS)[number];
/** The widths the preview draws: a common phone and a desktop window. */
export const PREVIEW_WIDTHS = { phone: 390, desktop: 1280 } as const;
