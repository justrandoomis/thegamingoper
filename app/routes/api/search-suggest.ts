/**
 * GET /api/search/suggest?q=<text>&locale=<ar|en|ckb> — the header search field's autocomplete (catalog area;
 * contract in app/routes/storefront/shell/SearchForm.tsx and docs/CONTRACTS.md §2).
 *
 *   200 { suggestions: { label: string; href: string; hint?: string }[] }      at most 8; href is locale-less
 *        a corrected spelling first ("هل تقصد"), then the platform / department / device hub the words name, then
 *        products (hint: their department). Fewer than two characters → an empty list.
 *   429 { suggestions: [], error: "rate_limited" } with Retry-After   (per IP)
 *   405 for anything but GET / HEAD (no action is exported)
 *
 * Public and anonymous: nothing is stored about the query (statistics are counted by the /search page only), the
 * answer depends on q and locale alone, so browsers may keep it for a minute.
 */
import type { Route } from "./+types/search-suggest";
import { serverT } from "~/i18n/i18n.server";
import { isLocale } from "~/lib/locales";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { isAppError } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { MAX_QUERY_LENGTH, suggestSearch } from "~/server/services/search.server";
import { isPlatform } from "~/ui/PlatformLed";

/** Keystrokes are debounced (160 ms) by the field; a person typing fast stays far below this. */
const SUGGEST_LIMIT: RateLimitRule = { limit: 120, windowSec: 60 };

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH);
  const asked = url.searchParams.get("locale");
  const locale = isLocale(asked) ? asked : ctx.locale;
  const db = getDb();

  try {
    await enforceRateLimit(db, await limitKey("suggest", "ip", ctx.ip), SUGGEST_LIMIT, ctx.now);
  } catch (error) {
    if (!isAppError(error, "rate_limited")) throw error;
    return Response.json(
      { suggestions: [], error: "rate_limited" },
      { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSec ?? 60) } },
    );
  }

  const items = await suggestSearch(db, locale, q, { now: ctx.now });
  const t = serverT(locale, "catalog");
  const ui = serverT(locale, "ui");
  const suggestions = items.map((item) => {
    // the four known platforms carry the design system's names (Latin brand names stay Latin), as in the shell
    const slug = item.kind === "platform" ? item.href.slice("/platform/".length) : "";
    const label = isPlatform(slug) ? ui(`platform.${slug}`) : item.label;
    const hint = item.hint ?? (item.kind === "product" ? undefined : t(`suggest.${item.kind}`));
    return hint ? { label, href: item.href, hint } : { label, href: item.href };
  });
  return Response.json({ suggestions }, { headers: { "Cache-Control": "public, max-age=60" } });
}
