/**
 * GET /api/search/suggest?q=<text>&locale=<ar|en|ckb> — the header search field's suggestions (catalog area;
 * contract in app/routes/storefront/shell/SearchForm.tsx and docs/CONTRACTS.md §2).
 *
 *   200 { suggestions: { label: string; href: string; hint?: string; image?: string; priceIqd?: number; kindLabel?: string;
 *         qualifier?: string }[], total?: number }
 *        at most 8 rows; href is locale-less: a corrected spelling first ("هل تقصد"), then the platform / department /
 *        device hub the words name (hint: what it is), then products (hint: their department; image: the art key of
 *        their picture; priceIqd: integer IQD, left out while sold out; kindLabel: «جهاز PS5»; qualifier: the words
 *        the Latin title leaves out, «نسخة الأقراص» — the service's own, printed by the shell on the row's meta line,
 *        never glued into the label). `total` is how many products /search?q= lists for the same words — the count
 *        of «اعرض كل النتائج (42)» — present whenever the query was long enough to search. Fewer than two characters
 *        → an empty list and no total.
 *   429 { suggestions: [], error: "rate_limited" } with Retry-After   (per IP)
 *   405 for anything but GET / HEAD (no action is exported)
 *
 * Public and anonymous: nothing is stored about the query (statistics are counted by the /search page only), the
 * answer depends on q and locale alone, so browsers may keep it for a minute.
 */
import type { Route } from "./+types/search-suggest";
import { serverT } from "~/i18n/i18n.server";
import type { ProductCardData } from "~/lib/dto";
import { isLocale } from "~/lib/locales";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { isAppError } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { getCardsByIds } from "~/server/services/catalog/cards.server";
import { MAX_QUERY_LENGTH, suggestSearchWithTotal } from "~/server/services/search.server";
import { isPlatform } from "~/ui/PlatformLed";

/** Keystrokes are debounced (160 ms) by the field; a person typing fast stays far below this. */
const SUGGEST_LIMIT: RateLimitRule = { limit: 120, windowSec: 60 };

export type SuggestionRow = { label: string; href: string; hint?: string; image?: string; priceIqd?: number; kindLabel?: string; qualifier?: string };

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

  // ONE match of the words: the rows, their products' ids, and how many products /search lists for the same words
  // (null when the query is too short to search)
  const result = await suggestSearchWithTotal(db, locale, q, { now: ctx.now });
  const items = result.items;
  const total: number | undefined = result.total ?? undefined;

  // the product rows' pictures, prices and kinds
  const cards = new Map<string, ProductCardData>();
  if (result.productIds.length > 0) for (const card of await getCardsByIds(db, locale, result.productIds, { now: ctx.now })) cards.set(`/p/${card.slug}`, card);

  const t = serverT(locale, "catalog");
  const ui = serverT(locale, "ui");
  const suggestions = items.map((item): SuggestionRow => {
    // the four known platforms carry the design system's names (Latin brand names stay Latin), as in the shell
    const slug = item.kind === "platform" ? item.href.slice("/platform/".length) : "";
    const label = isPlatform(slug) ? ui(`platform.${slug}`) : item.label;
    const hint = item.hint ?? (item.kind === "product" ? undefined : t(`suggest.${item.kind}`));
    const row: SuggestionRow = hint ? { label, href: item.href, hint } : { label, href: item.href };
    // the words the product's Latin title leaves out («نسخة الأقراص»): the service's own, products only
    if (item.kind === "product" && item.qualifier) row.qualifier = item.qualifier;
    const card = item.kind === "product" ? cards.get(item.href) : undefined;
    if (card) {
      if (card.image.artKey) row.image = card.image.artKey;
      // a sold-out product's price would read as an offer: the row shows what it is, the page says it is sold out
      if (card.stock !== "out_of_stock" && Number.isSafeInteger(card.priceIqd) && card.priceIqd >= 0) row.priceIqd = card.priceIqd;
      if (card.kindLabel) row.kindLabel = card.kindLabel;
    }
    return row;
  });
  return Response.json(total === undefined ? { suggestions } : { suggestions, total }, { headers: { "Cache-Control": "public, max-age=60" } });
}
