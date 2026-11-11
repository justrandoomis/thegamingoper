/**
 * Pure decisions behind the shell's chrome (client-safe, unit-tested in tests/shell.test.ts):
 *
 *   shellChrome(matches, { errored })   which bars a page gets, from the route handles (ShellHandle)
 *   backFallback(path)                  where the task header's back key leads when there is no page to go back to
 *   canonicalSearch(search)             a query string exactly as the server renders it (hydration-safe hrefs)
 */
import type { PolicySlug } from "~/routes/storefront/content/content-model";
import { LAYOUT_ROUTE_ID } from "./meta";
import type { ShellHandle } from "./types";

/**
 * The policy pages the footer links (`/policies/<slug>`, content area), by column; each label is `footer.<slug>` in
 * the shell's strings. Every slug of the content area's POLICY_SLUGS is here (tests/shell.test.ts), and the footer
 * also links `/policies`, the list of them all.
 */
export const FOOTER_POLICIES = {
  help: ["shipping", "returns", "warranty", "payment"],
  store: ["privacy", "terms"],
} as const satisfies Record<"help" | "store", readonly PolicySlug[]>;

/** The part of a route match the shell reads (`useMatches()` items). */
export type ShellMatch = { id: string; handle?: unknown };

export type ShellChrome = {
  /** The tab bar shows below 1200px. false: the page has its own bottom task bar (<TaskBar>). */
  tabBar: boolean;
  /** The deepest `handle.shell.back`, if a page declared one (locale-less path). */
  back: string | null;
};

/**
 * The chrome the matched routes ask for. `errored`: the storefront layout's ErrorBoundary is rendering (a page below it
 * threw, or the layout's own loader did) — the pages' handles no longer apply, because their components (and their
 * task bars) are not on screen: an unknown product URL gets the tab bar, not a bottom edge with no bar at all.
 */
export function shellChrome(matches: readonly ShellMatch[], options: { errored?: boolean } = {}): ShellChrome {
  const considered = options.errored ? matches.slice(0, matches.findIndex((match) => match.id === LAYOUT_ROUTE_ID) + 1) : matches;
  let tabBar = true;
  let back: string | null = null;
  for (const match of considered) {
    const shell = (match.handle as ShellHandle | null | undefined)?.shell;
    if (shell?.tabBar === false) tabBar = false;
    if (typeof shell?.back === "string" && shell.back.startsWith("/")) back = shell.back;
  }
  return { tabBar, back };
}

/**
 * Where "back" leads on a task screen opened directly (no earlier page of this site in the tab's history): the
 * section the page belongs to. With history, the back key is real history Back instead (Header.tsx).
 *   /checkout → /cart · /used/<unit> → /used · /trade-in/<ref> → /trade-in · /support/<page> → /support
 *   /account/<section> → /account · anything else (a product, the cart) → /
 */
export function backFallback(path: string): string {
  if (/^\/checkout(\/|$)/.test(path)) return "/cart";
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
