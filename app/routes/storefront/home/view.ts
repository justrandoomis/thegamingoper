/**
 * Pure rules of the home page (client-safe, unit-tested in tests/home.test.ts): which product the hero features and
 * which banners the hero carousel shows in which order, which platform the new-arrivals chips start on, how a banner's
 * headline is split and sized, which picture each surface uses, which departments the icon strip offers. Nothing here
 * reads the DOM or the clock.
 */
import { artAspect, parsePhotoKey, productPhotos } from "~/art";
import type { IconName } from "~/art/Icon";
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

/**
 * The hero banners' form of a name: only its short last word is kept with the word before it («Switch 2», «5 Pro»,
 * «Series X», «Deck OLED»), so the compact phone banner may set the name on two lines at a good break —
 * «PlayStation» / «5 Pro», «Nintendo» / «Switch 2» — where keepTogether's name (one unbreakable piece, «PlayStation
 * 5 Pro») broke inside a word ("PlayStation 5 Pr" / "o"). From 768 the size is chosen so the name stays on one line.
 */
export function keepLastWord(name: string): string {
  return name.replace(/\s+(\S{1,4})$/u, " $1");
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
 * The headline faces: Kufam Variable 600 (v2.1 G1 — the before's display face, in every language: it has every Sorani
 * letter) and IBM Plex Sans Arabic 600 (kept for a caller that sets a headline in the text face).
 */
export type HeadlineFace = "kufam" | "plex";

type FaceMetrics = { chars: Record<string, number>; words: Record<string, number>; digit: number; arabic: number; upper: number; other: number };

/**
 * Advance widths of the headline faces in em — measured in Edge on the running site (2026-11-12, scratch scripts
 * measure-em.mjs, measure-arabic.mjs and measure-words.mjs, …/fb1/work/home/tools): every Latin letter, digits and
 * punctuation; the page's OWN headline words exactly (`words`: the hero's lead words and the trade-in and used banners'
 * titles in Arabic and Sorani — a line measures the sum of its words and spaces); and for any other Arabic or Kurdish
 * word (a staff pin) a width per letter that no measured word exceeds (Kufam: «گەیشت» 0.87 with its wide گ; the
 * letters of longer words measure 0.52–0.73).
 */
const FACES: Record<HeadlineFace, FaceMetrics> = {
  kufam: {
    chars: {
      A: 0.692, B: 0.666, C: 0.648, D: 0.744, E: 0.614, F: 0.578, G: 0.702, H: 0.755, I: 0.312, J: 0.441, K: 0.68, L: 0.548,
      M: 0.85, N: 0.755, O: 0.803, P: 0.657, Q: 0.803, R: 0.694, S: 0.61, T: 0.611, U: 0.731, V: 0.671, W: 1.076, X: 0.683,
      Y: 0.638, Z: 0.617,
      a: 0.6, b: 0.644, c: 0.514, d: 0.644, e: 0.613, f: 0.387, g: 0.644, h: 0.661, i: 0.31, j: 0.308, k: 0.591, l: 0.31,
      m: 0.985, n: 0.661, o: 0.631, p: 0.644, q: 0.644, r: 0.408, s: 0.527, t: 0.442, u: 0.656, v: 0.578, w: 0.849,
      x: 0.583, y: 0.571, z: 0.549,
      " ": 0.245, " ": 0.245, "-": 0.5, "–": 0.5, ":": 0.282, ".": 0.282, ",": 0.282, "'": 0.204, "’": 0.288,
      "+": 0.616, "&": 0.668, "|": 0.308, "(": 0.37, ")": 0.37, "/": 0.545, "!": 0.323, "?": 0.503,
    },
    words: {
      العب: 2.508, على: 1.77, وصل: 2.434, استبدل: 3.372, جهازك: 3.436, مستعمل: 4.021, ومفحوص: 4.717,
      یاری: 1.879, بکە: 2.278, لەسەر: 3.09, گەیشت: 4.349, ئامێرەکەت: 5.895, بگۆڕەوە: 4.494, بەکارهاتوو: 5.797, و: 0.64, پشکنراو: 4.414,
    },
    digit: 0.616,
    arabic: 0.87,
    upper: 0.85,
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
      "+": 0.6, "&": 0.713, "|": 0.376, "(": 0.337, ")": 0.337, "/": 0.437, "!": 0.309, "?": 0.493,
    },
    words: {
      العب: 1.968, على: 1.586, وصل: 2.073, استبدل: 2.891, جهازك: 2.509, مستعمل: 3.472, ومفحوص: 3.891,
      یاری: 1.617, بکە: 1.278, لەسەر: 2.349, گەیشت: 2.951, ئامێرەکەت: 3.94, بگۆڕەوە: 2.928, بەکارهاتوو: 3.906, و: 0.475, پشکنراو: 2.927,
    },
    digit: 0.6,
    arabic: 0.74,
    upper: 0.75,
    other: 0.65,
  },
};

/** Marks and direction isolates take no room. */
const ZERO_WIDTH = /[\p{Mn}\p{Cf}]/gu;

/**
 * How wide a line of the headline is, in em of its face, with 4% to spare. Over-estimating only makes the headline one
 * step smaller; under-estimating would wrap the product's name.
 */
export function headlineEm(text: string, face: HeadlineFace = "kufam"): number {
  const metrics = FACES[face];
  let em = 0;
  for (const part of text.replace(ZERO_WIDTH, "").split(/(\s)/u)) {
    if (part === "") continue;
    const known = metrics.words[part];
    if (known !== undefined) {
      em += known;
      continue;
    }
    for (const char of part) {
      em +=
        metrics.chars[char] ??
        (/\d/.test(char) ? metrics.digit : /\s/.test(char) ? metrics.chars[" "] : /\p{Script=Arabic}/u.test(char) ? metrics.arabic : /\p{Lu}/u.test(char) ? metrics.upper : metrics.other);
    }
  }
  return Math.max(1, Math.round(em * 1.04 * 1000) / 1000);
}

/**
 * How wide a headline is when it may take two lines: the narrower of the line itself and its best break at a space —
 * as the browser's balanced wrapping chooses it. A no-break space never breaks («Switch 2», «5 Pro» stay whole).
 */
export function twoLineEm(text: string, face: HeadlineFace = "kufam"): number {
  const words = text.trim().split(/[ \t\n]+/u);
  let best = headlineEm(text, face);
  for (let at = 1; at < words.length; at++) {
    best = Math.min(best, Math.max(headlineEm(words.slice(0, at).join(" "), face), headlineEm(words.slice(at).join(" "), face)));
  }
  return best;
}

export type HeroBreakpoint = "sm" | "md" | "lg" | "xl";

/**
 * The narrowest the banner's copy column gets in each range (px) — read off home.css (`.home-slide__body`): phones from
 * 360 (the compact banner, 88% of the 328px column so the next one peeks; padding 16, copy 11/20 beside the product,
 * gap 8), 768 (copy 3/5, padding 28, gap 16 — wide enough for «Nintendo Switch 2» at 40px), 1024 (7/12, padding 40,
 * gap 32) and 1280 (1/2 of the 1216px band, padding 48, gap 32). Change both together.
 */
export const HERO_COPY_MIN: Record<HeroBreakpoint, number> = { sm: 136, md: 388, lg: 494, xl: 544 };

/**
 * The sizes a headline may take in each range, largest first: on phones the compact banner's two (h2 22, then tile 18
 * — the range's own Kufam sizes); from 768 the display size (v2 §2.6: 40 → 48 → 56), then the Kufam sizes the same
 * range already draws — price xl, h1, and the range's h2 last. A size from another range's scale would be one more
 * size on the page (QA 2026-11-12: 36px at 768, where the scale has 40, 32 and 30).
 */
const HEADLINE_STEPS: Record<HeroBreakpoint, readonly number[]> = {
  sm: [22, 18],
  md: [40, 32, 30, 24],
  lg: [48, 34, 32, 26],
  xl: [56, 36, 28],
};

export type HeroTitleOptions = {
  /** Each line may take two lines of its own (a staff pin's headline, a service banner's title): sized by its best break. */
  wrap?: boolean;
  /** What the compact phone banner shows instead (the product's name alone, in up to two lines). Default: the lines. */
  phone?: string;
};

/**
 * A banner headline's size in each range: the largest step of the range's scale (integer sizes only — never a fluid
 * size) at which its longest line fits the copy column — on one line, or on two where it may wrap (`wrap`; the phone
 * text) — else the range's smallest step, where a very long headline wraps (balanced; two lines at most in CSS). The
 * same on the server and in the browser.
 */
export function heroTitleSizes(lines: readonly string[], face: HeadlineFace = "kufam", options: HeroTitleOptions = {}): Record<HeroBreakpoint, number> {
  const measure = (line: string) => (options.wrap ? twoLineEm(line, face) : headlineEm(line, face));
  const em = Math.max(0, ...lines.filter(Boolean).map(measure));
  const phoneEm = options.phone !== undefined ? twoLineEm(options.phone, face) : em;
  const fit = (range: HeroBreakpoint, width: number) => {
    const steps = HEADLINE_STEPS[range];
    return steps.find((step) => width * step <= HERO_COPY_MIN[range]) ?? steps[steps.length - 1];
  };
  return { sm: fit("sm", phoneEm), md: fit("md", em), lg: fit("lg", em), xl: fit("xl", em) };
}

// ───────────────────────────────────────────────────────────────── the hero carousel

/** The banners move on by themselves every 6.5 s while nothing holds them (client note 1; ~/ui/Carousel). */
export const HERO_AUTOPLAY_MS = 6500;

/**
 * The banner whose photo the hero fetches ahead while one is shown: the next one. The markup keeps every photo but the
 * first lazy (the page's own load stays lean: one eager photo), and a lazy photo inside the sideways track waits until
 * it scrolls in — every banner used to arrive as a blurred miniature with its product popping in a moment later
 * (review 2026-11-13). Null when there is nothing to fetch: one banner or none, the next one is the first (its photo
 * came with the page), or the shopper asked the browser to save data.
 */
export function photoToWarm(index: number, count: number, saveData = false): number | null {
  if (saveData || count < 2) return null;
  const next = (index + 1) % count;
  return next === 0 ? null : next;
}

/** A platform's banner: its hero (a staff pin, else the lead device), in the platform's colour. */
export type PlatformSlidePlan<P> = { kind: "platform"; key: string; platform: P };
/** The store's two service banners: trade-in (always) and used (only while used units are listed). */
export type ServiceSlidePlan = { kind: "tradeIn" | "used"; key: "trade-in" | "used"; art: string | null };
export type HeroSlidePlan<P> = PlatformSlidePlan<P> | ServiceSlidePlan;

/** A picture this wide (width ÷ height) or wider stands small in a banner's product column: service banners pass it over. */
export const WIDE_PICTURE = 1.5;

/**
 * The hero carousel's banners, in order (client note 1): every platform with a hero (a staff pin or its lead device)
 * in the key bank's order, the FEATURED one first — Nintendo's, or while staff pin one, the pinned platform
 * (`featuredHero`: what staff chose for this period leads, as the single hero did) — then the trade-in banner, then the
 * used banner while used units are listed. The service banners show a console that no platform banner shows, an
 * upright one first (a wide picture stands small in the product column): the trade-in banner the first such picture
 * among the listed used units and `fallbackArt` (the PlayStation lead device, the trade-in door's), the used banner the
 * next one among the used units; else the first candidate, shown elsewhere or not; else none (the banner draws its
 * icon).
 */
export function heroSlides<P extends FocusablePlatform>(
  platforms: readonly P[],
  heroArt: (platform: P) => string | null | undefined,
  options: { usedArt: readonly (string | null | undefined)[]; fallbackArt?: string | null; preferred?: string },
): HeroSlidePlan<P>[] {
  const withHero = platforms.filter((platform) => platform.hero && isPlatform(platform.slug));
  const featured = featuredHero(withHero, options.preferred);
  const ordered = featured ? [featured, ...withHero.filter((platform) => platform !== featured)] : withHero;
  const slides: HeroSlidePlan<P>[] = ordered.map((platform) => ({ kind: "platform", key: platform.slug, platform }));
  const shown = new Set(ordered.map((platform) => heroArt(platform)).filter((key): key is string => Boolean(key)));
  const used = [...new Set(options.usedArt.filter((key): key is string => Boolean(key)))];
  const pick = (candidates: readonly string[], taken: ReadonlySet<string>): string | null => {
    const fresh = candidates.filter((key) => !taken.has(key));
    return fresh.find((key) => (artAspect(key) ?? 1) < WIDE_PICTURE) ?? fresh[0] ?? candidates[0] ?? null;
  };
  const tradeIn = pick([...new Set([...used, ...(options.fallbackArt ? [options.fallbackArt] : [])])], shown);
  slides.push({ kind: "tradeIn", key: "trade-in", art: tradeIn });
  if (options.usedArt.length > 0) slides.push({ kind: "used", key: "used", art: pick(used, new Set([...shown, ...(tradeIn ? [tradeIn] : [])])) });
  return slides;
}

// ───────────────────────────────────────────────────────────────── the department strip

export type StripKey = "devices" | "games" | "controllers" | "headsets" | "accessories" | "topup" | "used" | "repair";
/** One door of the icon strip under the hero: a real listing and its kind icon. */
export type StripItem = { key: StripKey; href: string; icon: IconName };

/** The strip's doors in order (the client's reference: glass icon tiles), with the catalogue kind each one opens. */
const STRIP: readonly { key: StripKey; kind: string | null; icon: IconName; href?: string }[] = [
  { key: "devices", kind: "consoles", icon: "kind-console" },
  { key: "games", kind: "games", icon: "kind-game" },
  { key: "controllers", kind: "controllers", icon: "kind-controller" },
  { key: "headsets", kind: "headsets", icon: "kind-headset" },
  { key: "accessories", kind: "accessories", icon: "kind-accessory" },
  { key: "topup", kind: "digital", icon: "kind-topup" },
  { key: "used", kind: null, icon: "kind-used", href: "/used" },
  { key: "repair", kind: null, icon: "kind-repair", href: "/support/repair" },
];

/**
 * The icon strip's doors (client note 4): only departments that exist — a catalogue category of that kind with
 * products (its own listing), the used devices while units are listed, and the repair booking (a service: always).
 */
export function stripItems(categories: readonly { kind: string; href: string; count: number }[], usedCount: number): StripItem[] {
  return STRIP.flatMap((entry): StripItem[] => {
    if (entry.key === "used") return usedCount > 0 ? [{ key: entry.key, href: "/used", icon: entry.icon }] : [];
    if (entry.href) return [{ key: entry.key, href: entry.href, icon: entry.icon }];
    const category = categories.find((candidate) => candidate.kind === entry.kind && candidate.count > 0);
    return category ? [{ key: entry.key, href: category.href, icon: entry.icon }] : [];
  });
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
