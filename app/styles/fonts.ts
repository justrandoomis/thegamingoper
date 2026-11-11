/**
 * Font files the shell preloads — app/styles/fonts.css declares every face; this list says which two files are on
 * the critical path (docs/DESIGN.md §5.5: "Preload exactly two"). Client- and server-safe, no DOM.
 *
 *   // a layout or root route module (app/root.tsx does this)
 *   import { fontPreloadLinks } from "~/styles/fonts";
 *   export const links: Route.LinksFunction = () => fontPreloadLinks("Arab");   // or LOCALES[locale].script
 *
 *   // or from a component (React 19 hoists it into <head>)
 *   import { preload } from "react-dom";
 *   for (const f of criticalFonts("Latn")) preload(f.href, { as: "font", type: f.type, crossOrigin: "anonymous" });
 *
 * Arabic-script pages (ar, ckb) preload Plex 400 Arabic + Noto Kufi 700 Arabic (86.7 KB together); Latin pages (en)
 * preload the Latin cuts of the same two (29.5 KB). Everything else (Plex 600, the other script, latin-ext) loads on
 * first use through `unicode-range`. Worst case on an Arabic page: six files, 182.5 KB (plus latin-ext on demand).
 * Font preloads must be CORS requests (`crossOrigin: "anonymous"`) even on the same origin, or the browser downloads
 * the file twice.
 */

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

/** `<link rel="preload">` descriptors for a route's `links` export. */
export function fontPreloadLinks(script: FontScript) {
  return criticalFonts(script).map((f) => ({ rel: "preload", as: "font", href: f.href, type: f.type, crossOrigin: "anonymous" as const }));
}
