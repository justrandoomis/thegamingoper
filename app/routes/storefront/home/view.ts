/**
 * Pure rules of the home page (client-safe, unit-tested in tests/home.test.ts): which product the hero features, which
 * platform the new-arrivals chips start on, how the hero headline is split and sized, which picture each surface
 * uses. Nothing here reads the DOM or the clock.
 */
import { parsePhotoKey, productPhotos } from "~/art";
import type { ComingSoonItem } from "~/server/services/home.server";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import type { ReleaseItem } from "~/ui/ReleaseBand";

/** The part of a home platform these rules read (HomePlatform in ~/server/services/home.server). */
export type FocusablePlatform = { slug: string; hero: { productId: string; pin?: unknown } | null; newArrivals: readonly string[] };

/**
 * The platform whose lead device the hero features while staff pin nothing in the content module (Design System v2
 * §13 #13: "Nintendo Switch 2, «العب على / Nintendo Switch 2»"). When that platform has nothing buyable to feature,
 * the next platform in the store's order that has does.
 */
export const FEATURED_PLATFORM: Platform = "nintendo";

/**
 * The hero's product. A PINNED hero first (admin 17.01 — staff chose it for this period; the service keeps a pin only
 * while its product can be bought and has a photo): the featured platform's pin, else the first pinned platform in
 * the store's order. Without a standing pin: the featured platform's automatic hero, else the first platform's that
 * has one.
 */
export function featuredHero<P extends FocusablePlatform>(platforms: readonly P[], preferred: string = FEATURED_PLATFORM): P | null {
  const pinned = platforms.filter((platform) => Boolean(platform.hero?.pin));
  if (pinned.length > 0) return pinned.find((platform) => platform.slug === preferred) ?? pinned[0];
  return platforms.find((platform) => platform.slug === preferred && platform.hero) ?? platforms.find((platform) => platform.hero) ?? null;
}

/**
 * The picture of a platform's console wherever the page shows one outside the hero band — the trade-in door, the
 * intro's corner objects: its LEAD device (HomePlatform.lead, the store's automatic pick), never the hero. A staff pin
 * puts a campaign product on the stage (a game, a headset), and a game is no "trade in your device" (review
 * 2026-11-12). Null when the platform has no lead device or its card is missing.
 */
export function leadArt(platform: { hero?: { productId: string } | null; lead?: { productId: string } | null } | null | undefined, cards: Readonly<Record<string, { image: { artKey: string | null } } | undefined>>): string | null {
  const lead = platform?.lead;
  return lead ? (cards[lead.productId]?.image.artKey ?? null) : null;
}

/** A shelf below this many items is not drawn (v2 §4.22) — the new arrivals, the used units and the personal shelves. */
export const MIN_SHELF = 3;

/** The platform has enough new arrivals for the page to draw its shelf (and so to offer its chip). */
export function hasShelf(platform: Pick<FocusablePlatform, "newArrivals">): boolean {
  return platform.newArrivals.length >= MIN_SHELF;
}

/**
 * The platform the new-arrivals chips start on: `?platform=` when it names a platform whose shelf is drawn, else the
 * first of the shopper's saved platforms that has one, else the featured platform, else the first platform that has
 * one. Null when no platform has a shelf. A platform with fewer than MIN_SHELF new arrivals is never chosen: its shelf
 * would not be drawn, and the whole section — the other platforms' chips included — would vanish with it.
 */
export function resolveFocus(requested: string | null | undefined, platforms: readonly FocusablePlatform[], saved: readonly Platform[], preferred: string = FEATURED_PLATFORM): Platform | null {
  const stocked = platforms.filter((platform): platform is FocusablePlatform & { slug: Platform } => isPlatform(platform.slug) && hasShelf(platform));
  const has = (slug: string | null | undefined) => (slug ? stocked.find((platform) => platform.slug === slug)?.slug : undefined);
  return has(requested) ?? saved.map(has).find(Boolean) ?? has(preferred) ?? stocked[0]?.slug ?? null;
}

/**
 * A name dropped into a sentence, isolated (U+2068 … U+2069) so a Latin name keeps its place inside Arabic or Kurdish
 * text and the punctuation after it stays where it belongs (docs/UI.md §4). Harmless in English.
 */
export const isolate = (text: string): string => `⁨${text}⁩`;

/**
 * A picture the browser has already given up on: finished (`complete`) without an image. A photo that fails before
 * the page is hydrated never reaches React's onError, so the hero checks its photo once it is on screen and then shows
 * its failed state (the band keeps its size, the copy and the key) instead of the broken-image frame.
 */
export function pictureFailed(img: { complete: boolean; naturalWidth: number } | null | undefined): boolean {
  return Boolean(img && img.complete && img.naturalWidth === 0);
}

/**
 * A final «ى» (U+0649) or Sorani «ی» (U+06CC) after a beh- or feh-shaped letter (ب ت ث ن ي ئ پ ی ف ڤ), with a zero-width
 * joiner between them. IBM Plex Sans Arabic draws those pairs as required ligatures (rlig) that curl the yeh into a
 * bowl under the tooth: «حتى» reads «حق», «کاتی» reads «کاق» (QA 2026-11-12: «حق 4K على التلفاز» in the hero — the
 * text was right). The joiner keeps both letters joined and stops the ligature; turning rlig off would also break «لا».
 * For display text only (the hero's lines) until the font is fixed for the whole store (requested of the design-system
 * owner). Removing every U+200D gives the text back.
 */
export function plainFinalYeh(text: string): string {
  return text.replace(/([بتثنيئپیفڤ])(?=[ىی](?![\p{L}\p{M}]))/gu, "$1‍");
}

/** "2026-11-19" → epoch ms of midnight in Baghdad that day (UTC+3, no DST); null for anything else. */
export function baghdadDay(day: string | null | undefined): number | null {
  const match = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 3 * 60 * 60 * 1000;
  return Number.isFinite(ms) ? ms : null;
}

// ───────────────────────────────────────────────────────────────── the hero headline

/**
 * A product name whose short last word never goes to a line of its own (v2 §4.18: «Switch 2», «PS5 Pro», «Go 2» never
 * break): a no-break space before a last word of up to four characters, and before a number that precedes it
 * ("PlayStation 5 Pro" keeps "5 Pro" together with "PlayStation").
 */
export function keepTogether(name: string): string {
  return name.replace(/\s+(\S{1,4})$/u, " $1").replace(/\s+(\d{1,2})(?= \S{1,4}$)/u, " $1");
}

/** Stands in for the name while a message is split around it (never typed by anyone). */
const NAME_TOKEN = "\u0000";

/**
 * The hero headline in its two lines (v2 §4.18): the words before the product's name are the first line; the name —
 * with any words after it, as Sorani puts the verb last — is the second. A message with nothing before the name is
 * one line. `fill` is the page's t() bound to the message, called with a stand-in for {name}.
 */
export function splitHeadline(fill: (name: string) => string, name: string): { lead: string; after: string; name: string } {
  const text = fill(NAME_TOKEN);
  const at = text.indexOf(NAME_TOKEN);
  if (at < 0) return { lead: text.trim(), after: "", name };
  return { lead: text.slice(0, at).trim(), after: text.slice(at + NAME_TOKEN.length).trim(), name };
}

/**
 * The headline faces: Noto Kufi Arabic 700 (Arabic and English) and IBM Plex Sans Arabic 600 (Sorani headings, until
 * a native reader approves Kufi's ە and ڵا — v2 §2.6).
 */
export type HeadlineFace = "kufi" | "plex";

type FaceMetrics = { chars: Record<string, number>; digit: number; arabic: number; upper: number; other: number };

/**
 * Advance widths of the headline faces in em — measured in Edge on the running site (2026-11-11, scratch script
 * measure-em.mjs): every Latin letter, digits and punctuation, and a conservative width for an Arabic or Kurdish letter
 * (joined forms measure about 0.54–0.76 in Kufi; Sorani words 0.41–0.59 in Plex).
 */
const FACES: Record<HeadlineFace, FaceMetrics> = {
  kufi: {
    chars: {
      A: 0.69, B: 0.672, C: 0.637, D: 0.74, E: 0.56, F: 0.549, G: 0.724, H: 0.765, I: 0.389, J: 0.331, K: 0.664, L: 0.565,
      M: 0.943, N: 0.813, O: 0.796, P: 0.628, Q: 0.796, R: 0.66, S: 0.551, T: 0.579, U: 0.756, V: 0.65, W: 0.967, X: 0.667,
      Y: 0.624, Z: 0.579,
      a: 0.604, b: 0.633, c: 0.514, d: 0.633, e: 0.591, f: 0.387, g: 0.633, h: 0.657, i: 0.305, j: 0.305, k: 0.62, l: 0.305,
      m: 0.982, n: 0.657, o: 0.619, p: 0.633, q: 0.633, r: 0.454, s: 0.497, t: 0.434, u: 0.657, v: 0.569, w: 0.856,
      x: 0.578, y: 0.569, z: 0.488,
      " ": 0.34, " ": 0.34, "-": 0.322, "–": 0.5, ":": 0.285, ".": 0.285, ",": 0.285, "'": 0.266, "’": 0.217,
      "+": 0.572, "&": 0.75, "|": 0.551, "(": 0.339, ")": 0.339, "/": 0.413,
    },
    digit: 0.572,
    arabic: 0.78,
    upper: 0.8,
    other: 0.7,
  },
  plex: {
    chars: {
      A: 0.672, B: 0.663, C: 0.642, D: 0.689, E: 0.6, F: 0.577, G: 0.712, H: 0.719, I: 0.423, J: 0.545, K: 0.678, L: 0.521,
      M: 0.816, N: 0.719, O: 0.712, P: 0.641, Q: 0.712, R: 0.664, S: 0.611, T: 0.58, U: 0.69, V: 0.638, W: 0.949, X: 0.655,
      Y: 0.632, Z: 0.599,
      a: 0.559, b: 0.6, c: 0.513, d: 0.6, e: 0.558, f: 0.35, g: 0.545, h: 0.588, i: 0.276, j: 0.276, k: 0.562, l: 0.294,
      m: 0.888, n: 0.588, o: 0.563, p: 0.6, q: 0.6, r: 0.393, s: 0.499, t: 0.374, u: 0.588, v: 0.524, w: 0.819, x: 0.544,
      y: 0.524, z: 0.502,
      " ": 0.236, " ": 0.236, "-": 0.402, "–": 0.588, ":": 0.318, ".": 0.298, ",": 0.298, "'": 0.26, "’": 0.292,
      "+": 0.6, "&": 0.713, "|": 0.376, "(": 0.337, ")": 0.337, "/": 0.437,
    },
    digit: 0.6,
    arabic: 0.62,
    upper: 0.75,
    other: 0.65,
  },
};

/**
 * How wide a line of the headline is, in em of its face, with 4% to spare. Over-estimating only makes the headline one
 * step smaller; under-estimating would wrap the product's name.
 */
export function headlineEm(text: string, face: HeadlineFace = "kufi"): number {
  const metrics = FACES[face];
  let em = 0;
  for (const char of text) {
    if (/[\p{Mn}\p{Cf}]/u.test(char)) continue; // marks and direction isolates take no room
    em +=
      metrics.chars[char] ??
      (/\d/.test(char) ? metrics.digit : /\s/.test(char) ? metrics.chars[" "] : /\p{Script=Arabic}/u.test(char) ? metrics.arabic : /\p{Lu}/u.test(char) ? metrics.upper : metrics.other);
  }
  return Math.max(1, Math.round(em * 1.04 * 1000) / 1000);
}

export type HeroBreakpoint = "sm" | "md" | "lg" | "xl";

/**
 * The narrowest the hero's copy column gets in each range (px) — read off home.css (`.home-hero__body`): phones from
 * 360 (the band inside the 16px gutter, padding 20), 768 (copy 3/5 beside the product, padding 28, gap 16 — wide
 * enough for «Nintendo Switch 2» at 40px), 1024 (7/12, padding 40, gap 32), 1280 (6/12, padding 48, gap 32). Change
 * both together.
 */
export const HERO_COPY_MIN: Record<HeroBreakpoint, number> = { sm: 288, md: 388, lg: 494, xl: 544 };

/**
 * The sizes a headline may take in each range, largest first: the display size (v2 §2.6: 28 → 40 → 48 → 56), then the
 * Kufi sizes the same range already draws — price xl, h1, and the range's h2 last. A size from another range's scale
 * would be one more size on the page (QA 2026-11-12: 36px at 768, where the scale has 40, 32 and 30).
 */
const HEADLINE_STEPS: Record<HeroBreakpoint, readonly number[]> = {
  sm: [28, 26, 22],
  md: [40, 32, 30, 24],
  lg: [48, 34, 32, 26],
  xl: [56, 36, 28],
};

/**
 * The hero headline's size in each range: the display size when its longest line fits the copy column on one line,
 * else the next step of that range's scale that does (integer sizes only — never a fluid size), else the range's
 * smallest step (its h2), where a very long name wraps (balanced). Same on the server and in the browser.
 */
export function heroTitleSizes(lines: readonly string[], face: HeadlineFace = "kufi"): Record<HeroBreakpoint, number> {
  const em = Math.max(0, ...lines.filter(Boolean).map((line) => headlineEm(line, face)));
  const fit = (range: HeroBreakpoint) => {
    const steps = HEADLINE_STEPS[range];
    return steps.find((step) => em * step <= HERO_COPY_MIN[range]) ?? steps[steps.length - 1];
  };
  return { sm: fit("sm"), md: fit("md"), lg: fit("lg"), xl: fit("xl") };
}

// ───────────────────────────────────────────────────────────────── pictures and links

/**
 * One view per surface (v2 §7.6: the hero shows the screen-on three-quarter, the Nintendo tile the console with its
 * dock): when a platform tile would repeat the hero's picture, it takes the product's next cut-out (an angle or an
 * in-box view, transparent) instead — or keeps the same picture when the product has no other. Any other key is
 * returned as it is.
 */
export function otherView(artKey: string | null | undefined, avoid: string | null | undefined): string | null {
  if (!artKey) return null;
  if (artKey !== avoid) return artKey;
  const parsed = parsePhotoKey(artKey);
  if (!parsed) return artKey;
  // never a picture of the back (the catalogue marks them: view "back")
  const next = productPhotos(parsed.slug).find((photo) => photo.key !== artKey && photo.transparent && photo.view !== "back" && (photo.kind === "angle" || photo.kind === "in-box"));
  return next?.key ?? artKey;
}

/**
 * The picture a platform tile shows — on the page and in the intro alike: the platform's own tile picture, or another
 * view of it when the hero already shows that picture (the Nintendo tile: Switch 2 in its dock). Nothing else makes a
 * tile step away from its picture: the next "angle" of a device can be its back (Xbox Series X --2 is the back with the
 * ports), so the intro's corner objects — the lead devices, often the same picture — may repeat it.
 */
export function tileArt(artKey: string | null | undefined, heroArt: string | null | undefined): string | null {
  return otherView(artKey, heroArt);
}

/** The release band shows the soonest four (one row of four columns from 768; v2 §4.21). */
export const RELEASE_LIMIT = 4;

/** A release's platform line on the band: one platform's dot and words, or several platforms' dots and names. */
export type ReleaseLine = { platform: Platform | null; platforms: Platform[] | null; label: string | null };

/**
 * The platform line of a coming-soon item (v2 §4.21: every item has one), from the facts its card carries: ONE
 * platform → its dot and the card's own kind label («جهاز Xbox Series X|S», «سماعة · PS5», «لعبة PlayStation»);
 * SEVERAL → a dot for each (the band draws two) and no label, so the band names them all («PlayStation · Xbox») — never
 * one platform's colour beside «لعبة متعددة المنصات», which names none.
 */
export function releasePlatformOf(card: { platformSlug: string | null; forPlatforms?: readonly string[]; kindLabel?: string | null }): ReleaseLine {
  const platforms = [...new Set((card.forPlatforms?.length ? card.forPlatforms : card.platformSlug ? [card.platformSlug] : []).filter(isPlatform))];
  if (platforms.length === 0) return { platform: null, platforms: null, label: null };
  if (platforms.length === 1) return { platform: platforms[0], platforms: null, label: card.kindLabel ?? null };
  return { platform: platforms[0], platforms, label: null };
}

/** What the release band reads of a coming-soon item (ComingSoonItem in ~/server/services/home.server). */
export type ComingFacts = Pick<ComingSoonItem, "key" | "slug" | "name" | "variantCount" | "releaseAt" | "priceIqd" | "image" | "platformSlug" | "forPlatforms" | "kindLabel">;

/**
 * A coming-soon item as the release band draws it: the product's name; for a later version of a product that is out
 * already, «نسخة جديدة» on the line under the name (the catalogue's version titles are not shown — they can say «طلب
 * مسبق»); and the platform line of EVERY item — a dated version's from the platform that version is for (the PS5
 * version of a game out on Xbox reads «لعبة PlayStation»). QA 2026-11-12: versions had no platform line at all.
 * `versions` words the count («نسخة جديدة», «نسختان جديدتان»).
 */
export function releaseItemOf(item: ComingFacts, versions: (count: number) => string): ReleaseItem {
  const line = releasePlatformOf(item);
  return {
    id: item.key,
    to: `/p/${item.slug}`,
    name: item.name,
    detail: item.variantCount > 0 ? versions(item.variantCount) : null,
    releaseAt: item.releaseAt,
    platform: line.platform,
    platforms: line.platforms,
    platformLabel: line.label ?? undefined,
    priceIqd: item.priceIqd,
    image: item.image,
  };
}

/**
 * Where the focus goes once the intro has left, when it has nowhere to be (on <body>, or still on the leaving overlay):
 * back to the key that opened it («شاهد المقدّمة مرة أخرى»), else — a first landing has no opener — to the page's main
 * landmark (QA 2026-11-12: after Escape a keyboard or screen-reader user started again from the top of the document).
 * Null when something on the page holds the focus already, or there is nowhere to go. Generic: testable without a DOM.
 */
export function focusAfterIntro<E>(active: E | null, body: E, inOverlay: (element: E) => boolean, opener: E | null, main: E | null): E | null {
  if (active !== null && active !== body && !inOverlay(active)) return null;
  return opener ?? main;
}

const normalizeName = (text: string) => text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** The device hub ("/device/<slug>") whose model is named like the product, among a platform's hubs; else null. */
export function deviceHubFor(productName: string, devices: readonly { label: string; href: string }[]): string | null {
  const name = normalizeName(productName);
  return devices.find((device) => normalizeName(device.label) === name)?.href ?? null;
}
