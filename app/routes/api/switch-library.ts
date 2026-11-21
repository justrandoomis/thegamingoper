/**
 * GET /api/switch-library — TamTam's own data for the Switch bundle builder (docs/switch-builder.md §4.2).
 *
 *   200 LibraryExtrasPayload { rev, extras: { [gameId]: LibraryExtras }, capacity: CapacityConfig }
 *   405 for anything but GET / HEAD (no action is exported)
 *
 * Public and anonymous: the sizes, prices, trailers, pictures and descriptions staff entered for the open game list
 * (public/library/switch/), hidden games flagged, and the planner's storage figures. It reads no cookie and stores
 * nothing, the answer is the same for everyone, so browsers may keep it for a minute (and the edge cache does, for
 * anonymous GETs).
 */
import type { Route } from "./+types/switch-library";
import { getDb } from "~/server/db.server";
import { getLibraryExtras } from "~/server/services/switch-library.server";

export async function loader(_: Route.LoaderArgs) {
  const payload = await getLibraryExtras(getDb());
  return Response.json(payload, { headers: { "Cache-Control": "public, max-age=60" } });
}
