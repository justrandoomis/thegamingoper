/**
 * Switch library — TamTam's own per-game data for the bundle builder (docs/switch-builder.md §4).
 * STUB written by the lead so importers work while the data owner builds it; keep these signatures.
 */
import { DEFAULT_CAPACITY } from "~/lib/switch-builder/storage";
import type { LibraryExtrasPayload } from "~/lib/switch-builder/types";
import type { Db } from "~/server/db.server";

/** Every visible game's TamTam data + the planner constants (public; GET /api/switch-library). */
export async function getLibraryExtras(_db: Db): Promise<LibraryExtrasPayload> {
  return { rev: "0", extras: {}, capacity: DEFAULT_CAPACITY };
}
