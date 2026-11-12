/**
 * Font files the shell preloads — app/styles/fonts.css declares every face; this list says which two files are on
 * the critical path (docs/DESIGN.md §5.5: "Preload exactly two"). Client- and server-safe, no DOM.
 *
 *   // the document's layout (app/root.tsx): while rendering, through React's resource API
 *   import { preloadFonts } from "~/styles/fonts";
 *   preloadFonts(LOCALES[locale].script);       // "Arab" (ar, ckb) or "Latn" (en)
 *
 * preloadFonts() calls react-dom's preload() for the two files: React writes the two <link rel="preload"> tags at the
 * top of the server's <head> and, on the client, finds them there and leaves them alone. Do not render the links as
 * <link> elements instead (fontPreloadLinks() mapped to JSX, or a route `links` export): React manages those as
 * hoistable elements, and in development <StrictMode> unmounts and remounts them right after hydration — each
 * re-inserted link fetches its font again after the page already has it, and Chrome reports "preloaded but not used"
 * on every page (measured 2026-11-12: …/scratchpad/work/polish-S-styles/fonts-exp.mjs).
 *
 * Arabic-script pages (ar, ckb) preload Plex 400 Arabic + Noto Kufi 700 Arabic (86.7 KB together); Latin pages (en)
 * preload the Latin cuts of the same two (29.5 KB). Both are drawn on the first screen (a Kufi heading or price,
 * Plex body text). Everything else (Plex 600, the other script, latin-ext) loads on first use through
 * `unicode-range`. Worst case on an Arabic page: six files, 182.5 KB (plus latin-ext on demand). Font preloads must
 * be CORS requests (`crossOrigin: "anonymous"`) even on the same origin, or the browser downloads the file twice.
 */
import { preload } from "react-dom";

export type FontScript = "Arab" | "Latn";
/** "Latn-ext": accented Latin beyond Latin-1 (ō, ş, ł …) — never preloaded. */
export type FontSubset = FontScript | "Latn-ext";

export type FontFile = {
  /** Public URL (content-hashed; cached immutable by public/_headers). */
  href: string;
  type: "font/woff2";
  family: "Noto Kufi Arabic" | "IBM Plex Sans Arabic";
  weight: "400" | "600" | "700";
  script: FontSubset;
  /** Transfer size in bytes, for budgets. */
  bytes: number;
};

/** Every shipped file, for budgets and checks. Keep in step with fonts.css. */
export const FONT_FILES: readonly FontFile[] = [
  { href: "/fonts/kufi-arabic-700.c964525f.woff2", type: "font/woff2", family: "Noto Kufi Arabic", weight: "700", script: "Arab", bytes: 43872 },
  { href: "/fonts/kufi-latin-700.d096450f.woff2", type: "font/woff2", family: "Noto Kufi Arabic", weight: "700", script: "Latn", bytes: 10384 },
  { href: "/fonts/kufi-latin-ext-wght.29036133.woff2", type: "font/woff2", family: "Noto Kufi Arabic", weight: "700", script: "Latn-ext", bytes: 16500 },
  { href: "/fonts/plex-arabic-400.6010e7fd.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "400", script: "Arab", bytes: 42848 },
  { href: "/fonts/plex-latin-400.9ed8dcb0.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "400", script: "Latn", bytes: 19164 },
  { href: "/fonts/plex-latin-ext-400.1935fa1a.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "400", script: "Latn-ext", bytes: 6656 },
  { href: "/fonts/plex-arabic-600.16734a5a.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "600", script: "Arab", bytes: 45688 },
  { href: "/fonts/plex-latin-600.63f47572.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "600", script: "Latn", bytes: 20500 },
  { href: "/fonts/plex-latin-ext-600.0f7c03bb.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "600", script: "Latn-ext", bytes: 6680 },
];

/** The two files on the critical path for a page written in `script`: Plex 400 + Noto Kufi 700, that script's cut. */
export function criticalFonts(script: FontScript): FontFile[] {
  return FONT_FILES.filter((f) => f.script === script && (f.family === "Noto Kufi Arabic" || f.weight === "400"));
}

/**
 * Preloads the two critical files of a page written in `script` (call it while rendering the document, on the server
 * and the client alike). React dedupes repeated calls.
 */
export function preloadFonts(script: FontScript): void {
  for (const f of criticalFonts(script)) preload(f.href, { as: "font", type: f.type, crossOrigin: "anonymous" });
}

/**
 * `<link rel="preload">` descriptors of the same two files — for budgets and checks. Rendered as `<link>` elements
 * they are fetched twice in development (see the note at the top); pages call preloadFonts().
 */
export function fontPreloadLinks(script: FontScript) {
  return criticalFonts(script).map((f) => ({ rel: "preload", as: "font", href: f.href, type: f.type, crossOrigin: "anonymous" as const }));
}
