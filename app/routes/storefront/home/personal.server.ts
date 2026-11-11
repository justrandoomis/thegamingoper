/**
 * What "stop remembering and delete what was kept" deletes on the SERVER (the browser wipes its own list and cookies
 * in ./personal.ts). One function for every place a shopper withdraws personalization consent — the home page's panel
 * and consent sheet (POST /api/onboarding consent=0) and the account settings — so they always forget the same things:
 *
 *   · the recommendation signals of this device (keyed by the hashed `tt_rs` cookie) and of the signed-in customer,
 *     and the `tt_rs` cookie itself (services/recommendations.server → forgetEvents)
 *   · a signed-in customer's recently-viewed list (services/account/recently-viewed.server)
 *
 * Server only (loaders and actions).
 */
import { sha256Hex } from "~/lib/ids";
import { clearCookie, type RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db/drizzle.server";
import { clearRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import { forgetEvents, isRecSessionToken, REC_SESSION_COOKIE } from "~/server/services/recommendations.server";

export async function forgetPersonalData(ctx: RequestCtx, db: Db, customerId: string | null): Promise<{ signals: number; recent: number }> {
  const token = ctx.cookie(REC_SESSION_COOKIE);
  const sessionHash = isRecSessionToken(token) ? await sha256Hex(token) : null;
  const signals = await forgetEvents(db, { sessionHash, customerId });
  if (token !== null) ctx.setCookie(clearCookie(ctx, REC_SESSION_COOKIE));
  const recent = customerId ? await clearRecentlyViewed(db, { customerId, cartToken: null }) : 0;
  return { signals, recent };
}
