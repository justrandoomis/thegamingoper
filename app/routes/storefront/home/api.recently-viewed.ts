/**
 * GET /api/recently-viewed?ids=prd_a,prd_b&locale=en — product cards for the ids this browser remembers
 * (./personal.ts keeps them on the device, only with the shopper's consent; the server stores nothing).
 *
 *   → 200 { ok: true, cards: ProductCardData[] }   in the order asked; unknown or unpublished ids are left out
 *   → 400 { ok: false, code: "invalid", fields }   more than 12 ids, or an id that is not one
 *
 * Read-only and public (cards are what every listing shows), so it is not rate-limited; `no-store` because the ids
 * are personal.
 */
import { data } from "react-router";
import type { Route } from "./+types/api.recently-viewed";
import { isLocale } from "~/lib/locales";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { getRecentlyViewedCards } from "~/server/services/home.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const url = new URL(request.url);
  const locale = url.searchParams.get("locale");
  const raw = url.searchParams.get("ids") ?? "";
  const ids = raw === "" ? [] : raw.split(",");
  try {
    const cards = ids.length === 0 ? [] : await getRecentlyViewedCards(getDb(), isLocale(locale) ? locale : ctx.locale, ids, ctx.now);
    return data({ ok: true as const, cards }, { headers: NO_STORE });
  } catch (error) {
    const { status, retryAfterSec: _retry, ...failure } = actionError(error);
    return data(failure, { status, headers: NO_STORE });
  }
}
