/**
 * GET /api/switch-library — TamTam's own data for the Switch bundle builder (docs/switch-builder.md §4.2).
 *
 *   200 LibraryExtrasPayload { rev, extras: { [gameId]: LibraryExtras }, capacity: CapacityConfig }
 *   429 { error: "rate_limited" } with Retry-After and no-store   (per IP, see below)
 *   405 for anything but GET / HEAD (no action is exported)
 *
 * Public and anonymous: the sizes, prices, trailers, pictures and descriptions staff entered for the open game list
 * (public/library/switch/), hidden games flagged (the flag alone), and the planner's storage figures. It reads no
 * cookie and stores nothing, the answer is the same for everyone, so browsers may keep it for a minute (and the edge
 * cache does, for anonymous GETs: workers/edge-cache.ts).
 *
 * Every request that reaches this loader skipped the edge cache, and each one reads the whole library table. The
 * builder's own request never skips it in production (no query, no cookie: lib/use-library.ts) — only a cache miss
 * does, about once a minute per colo, and the cache's background refresh carries no client IP and is never counted.
 * A query string, a cookie or a HEAD request skips it too, so those are counted per IP (qa-security 2026-11-21):
 * UNCACHED_READS per minute — far above what any shopper sends, also behind a carrier's shared address.
 */
import type { Route } from "./+types/switch-library";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { isAppError } from "~/server/errors";
import { enforceRateLimit, limitKey, type RateLimitRule } from "~/server/ratelimit.server";
import { getLibraryExtras } from "~/server/services/switch-library.server";

const UNCACHED_READS: RateLimitRule = { limit: 60, windowSec: 60 };

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  try {
    await enforceRateLimit(db, await limitKey("switch-library", "ip", ctx.ip), UNCACHED_READS, ctx.now);
  } catch (error) {
    if (!isAppError(error, "rate_limited")) throw error;
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(error.retryAfterSec ?? UNCACHED_READS.windowSec) } });
  }
  const payload = await getLibraryExtras(db);
  return Response.json(payload, { headers: { "Cache-Control": "public, max-age=60" } });
}
