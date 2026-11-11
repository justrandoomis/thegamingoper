/**
 * Font files the shell preloads — app/styles/fonts.css declares every face; this list says which two files are on
 * the critical path (docs/DESIGN.md §5.5: "Preload exactly two files"). Client- and server-safe, no DOM.
 *
 *   // a layout or root route module
 *   import { fontPreloadLinks } from "~/styles/fonts";
 *   export const links: Route.LinksFunction = () => fontPreloadLinks("Arab");   // or LOCALES[locale].script
 *
 *   // or from a component (React 19 hoists it into <head>)
 *   import { preload } from "react-dom";
 *   for (const f of criticalFonts("Latn")) preload(f.href, { as: "font", type: f.type, crossOrigin: "anonymous" });
 *
 * Arabic-script pages (ar, ckb) preload Plex 400 Arabic + Kufam Arabic (≈ 96 KB together); Latin pages (en) preload
 * the Latin cuts of the same two (≈ 54 KB). Everything else (500 / 600 weights, the other script) loads on first
 * use through `unicode-range`. Font preloads must be CORS requests (`crossOrigin: "anonymous"`) even on the same
 * origin, or the browser downloads the file twice.
 */

export type FontScript = "Arab" | "Latn";

export type FontFile = {
  /** Public URL (content-hashed; cached immutable by public/_headers). */
  href: string;
  type: "font/woff2";
  family: "Kufam Variable" | "IBM Plex Sans Arabic";
  weight: string;
  script: FontScript;
  /** Transfer size in bytes, for budgets. */
  bytes: number;
};

/** Every shipped file, for budgets and checks. Keep in step with fonts.css. */
export const FONT_FILES: readonly FontFile[] = [
  { href: "/fonts/kufam-arabic-wght.70d76d8d.woff2", type: "font/woff2", family: "Kufam Variable", weight: "400 900", script: "Arab", bytes: 55800 },
  { href: "/fonts/kufam-latin-wght.7073ba7c.woff2", type: "font/woff2", family: "Kufam Variable", weight: "400 900", script: "Latn", bytes: 36348 },
  { href: "/fonts/plex-arabic-400.6010e7fd.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "400", script: "Arab", bytes: 42848 },
  { href: "/fonts/plex-latin-400.9ed8dcb0.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "400", script: "Latn", bytes: 19164 },
  { href: "/fonts/plex-arabic-500.90aef64f.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "500", script: "Arab", bytes: 45296 },
  { href: "/fonts/plex-latin-500.be6a3b2e.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "500", script: "Latn", bytes: 20088 },
  { href: "/fonts/plex-arabic-600.16734a5a.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "600", script: "Arab", bytes: 45688 },
  { href: "/fonts/plex-latin-600.63f47572.woff2", type: "font/woff2", family: "IBM Plex Sans Arabic", weight: "600", script: "Latn", bytes: 20500 },
];

/** The two files on the critical path for a page written in `script` (Plex 400 + Kufam, that script's cut). */
export function criticalFonts(script: FontScript): FontFile[] {
  return FONT_FILES.filter((f) => f.script === script && (f.family === "Kufam Variable" || f.weight === "400"));
}

/** `<link rel="preload">` descriptors for a route's `links` export. */
export function fontPreloadLinks(script: FontScript) {
  return criticalFonts(script).map((f) => ({ rel: "preload", as: "font", href: f.href, type: f.type, crossOrigin: "anonymous" as const }));
}
