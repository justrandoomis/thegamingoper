/**
 * GET /api/product-preview/:slug?locale=ar|en|ckb — the data of the quick-preview sheet (./QuickPreview.tsx), which
 * opens on top of any page (cards, rails, search), so it brings its own strings.
 *
 *   200 { ok: true, product: ProductPreview, i18n: { product } }
 *   404 { ok: false, code: "not_found", i18n: { product } }     unknown, unpublished or without an active variant
 *
 * Read-only and public (the same facts the product page shows): no cookie is read or set, nothing protected is
 * selected (stock comes as states, never numbers). Plain JSON for `fetch` — not a fetcher, so a failure stays a value
 * in the sheet instead of replacing the page (docs/ui/commerce.md "Why fetch and not useFetcher").
 */
import type { Route } from "./+types/preview";
import { messagesFor } from "~/i18n/i18n.server";
import { isLocale, type Locale } from "~/lib/locales";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { toProductPreview } from "~/server/services/catalog/product-types";

/** Prices and stock states change; a few seconds of private caching only smooths repeated opens. */
const HEADERS = { "Cache-Control": "private, max-age=15" } as const;

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const asked = new URL(request.url).searchParams.get("locale");
  const locale: Locale = isLocale(asked) ? asked : ctx.locale;
  const i18n = messagesFor(locale, "product");
  const product = await getProductDetail(getDb(), locale, params.slug, {
    now: ctx.now,
    related: false,
  });
  if (!product) return Response.json({ ok: false, code: "not_found", i18n }, { status: 404, headers: HEADERS });
  return Response.json({ ok: true, product: toProductPreview(product), i18n }, { headers: HEADERS });
}
