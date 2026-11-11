/**
 * Pure rules of the home page (client-safe, unit-tested in tests/home.test.ts): which platform the stage is lit for,
 * what the "for your devices" shelf holds, and how long the hero headline is.
 */
import { isPlatform, type Platform } from "~/ui/PlatformLed";

/** The part of a home platform these rules read (HomePlatform in ~/server/services/home.server). */
export type FocusablePlatform = { slug: string; hero: unknown | null; newArrivals: readonly string[]; gear: readonly string[] };

/**
 * The platform the stage is lit for: `?platform=` when it names one of the page's platforms, else the first of the
 * shopper's saved platforms that has a hero, else the first platform that has a hero, else the first platform.
 */
export function resolveFocus(requested: string | null | undefined, platforms: readonly FocusablePlatform[], saved: readonly Platform[]): Platform | null {
  const known = platforms.filter((platform): platform is FocusablePlatform & { slug: Platform } => isPlatform(platform.slug));
  if (requested && known.some((platform) => platform.slug === requested)) return requested as Platform;
  const lit = known.filter((platform) => platform.hero);
  const savedLit = saved.find((slug) => lit.some((platform) => platform.slug === slug));
  return savedLit ?? lit[0]?.slug ?? known[0]?.slug ?? null;
}

/**
 * "Accessories for your devices": the gear of every platform the shopper picked (taking turns, so each platform is
 * represented), or of the platform in focus when none was picked — without what the new-arrivals shelf above shows.
 */
export function gearFor(platforms: readonly FocusablePlatform[], chosen: readonly Platform[], focus: Platform | null, limit: number): string[] {
  const sources = (chosen.length > 0 ? chosen : focus ? [focus] : [])
    .map((slug) => platforms.find((platform) => platform.slug === slug))
    .filter((platform): platform is FocusablePlatform => platform !== undefined);
  const exclude = new Set(platforms.find((platform) => platform.slug === focus)?.newArrivals ?? []);
  const out: string[] = [];
  const longest = Math.max(0, ...sources.map((platform) => platform.gear.length));
  for (let index = 0; index < longest && out.length < limit; index++) {
    for (const platform of sources) {
      const id = platform.gear[index];
      if (id && !exclude.has(id) && !out.includes(id)) out.push(id);
      if (out.length === limit) break;
    }
  }
  return out;
}

/**
 * A name dropped into a sentence, isolated (U+2068 … U+2069) so a Latin name keeps its place inside Arabic or Kurdish
 * text and the punctuation after it stays where it belongs (docs/UI.md §4). Harmless in English.
 */
export const isolate = (text: string): string => `\u2068${text}\u2069`;

/** "2026-11-19" → epoch ms of midnight in Baghdad that day (UTC+3, no DST); null for anything else. */
export function baghdadDay(day: string | null | undefined): number | null {
  const match = typeof day === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(day) : null;
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - 3 * 60 * 60 * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Advance widths of the headline face (Kufam 600) in em — measured in Chromium on the running site (2026-11-11,
 * scratch script): every Latin letter, digits, and a conservative 0.72 for an Arabic letter (its joined forms measure
 * 0.53–0.81). Sorani headlines use IBM Plex, which is narrower everywhere, so the estimate stays on the safe side.
 */
const LATIN_EM: Record<string, number> = {
  A: 0.69, B: 0.67, C: 0.63, D: 0.74, E: 0.61, F: 0.58, G: 0.7, H: 0.76, I: 0.31, J: 0.42, K: 0.68, L: 0.55, M: 0.85,
  N: 0.76, O: 0.81, P: 0.66, Q: 0.81, R: 0.69, S: 0.61, T: 0.62, U: 0.73, V: 0.67, W: 1.08, X: 0.69, Y: 0.66, Z: 0.62,
  a: 0.6, b: 0.64, c: 0.52, d: 0.64, e: 0.62, f: 0.38, g: 0.64, h: 0.66, i: 0.31, j: 0.31, k: 0.59, l: 0.31, m: 0.99,
  n: 0.66, o: 0.63, p: 0.64, q: 0.64, r: 0.41, s: 0.53, t: 0.44, u: 0.65, v: 0.6, w: 0.87, x: 0.59, y: 0.59, z: 0.55,
  " ": 0.25, "-": 0.5, "–": 0.5, ":": 0.28, ".": 0.28, ",": 0.28, "'": 0.2, "’": 0.2, "+": 0.62, "&": 0.67, "|": 0.31,
  "(": 0.37, ")": 0.37, "/": 0.55,
};

/**
 * How wide a headline is, in em of the headline face, with 4% to spare: the page sizes the hero headline to fit its
 * column on one line (`--em`, home.css). Over-estimating only makes the line a little smaller; under-estimating
 * would wrap it.
 */
export function headlineEm(text: string): number {
  let em = 0;
  for (const char of text) {
    if (/[\p{Mn}\p{Cf}]/u.test(char)) continue; // marks and direction isolates take no room
    em += LATIN_EM[char] ?? (/\d/.test(char) ? 0.62 : /\s/.test(char) ? 0.25 : /\p{Script=Arabic}/u.test(char) ? 0.72 : /\p{Lu}/u.test(char) ? 0.75 : 0.65);
  }
  return Math.max(4, Math.round(em * 1.04 * 100) / 100);
}
