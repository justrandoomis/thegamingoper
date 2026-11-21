/**
 * Switch library — TamTam's own per-game data for the bundle builder (docs/switch-builder.md §4.2).
 *
 *   const { rev, extras, capacity } = await getLibraryExtras(db);        // GET /api/switch-library, the quote action
 *
 * The open game LIST ships as static files (public/library/switch/, built by scripts/switch-library/); this service
 * reads what staff add per game in /admin/catalog/switch-library (table switch_library_entries) and the planner's
 * storage figures (setting `builder.switch.capacity`). One D1 round trip: the rows with their pictures, and the
 * setting.
 *
 * Mapping (LibraryExtras): sizes in bytes, the eShop price in US cents, dates as YYYY-MM-DD, the trailer as an
 * 11-character YouTube id, the picture as the storage key /media/<key> serves (with its width and height) — only for a
 * file that is public and not deleted, so a private file's key never leaves the server — TamTam's descriptions per
 * language, a Metacritic score only with its review count and date (it exists only under TamTam's Metacritic
 * licence; a score without them is not shown rather than shown with invented figures), and `hidden: true` for a
 * hidden game (the builder hides it; a plan that already holds it can still be quoted). Fields not set are left
 * out; a row with nothing left is left out.
 *
 * `rev` = "<latest updated_at>-<row count>": the latest change of any row or of the capacity setting, and the number
 * of rows — any save, a new row and a deleted row all change it. `capacity` = sanitizeCapacity(the stored setting):
 * a stored value that no longer fits keeps each field's default instead of breaking the builder.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { sanitizeCapacity } from "~/lib/switch-builder/storage";
import type { LibraryExtras, LibraryExtrasPayload } from "~/lib/switch-builder/types";
import type { Db } from "~/server/db.server";
import { files, settings, switchLibraryEntries } from "~/server/db/schema";
import type { SettingKey } from "~/server/settings.server";
import { isPublicStorageKey } from "~/server/storage.server";

export const CAPACITY_SETTING = "builder.switch.capacity" satisfies SettingKey;

const LOCALES = ["ar", "en", "ckb"] as const;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const wholeAtLeast = (value: number | null, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;

/** "2026-11-21" (or the date part of a longer ISO string) when it is a real calendar date; otherwise undefined. */
function isoDate(value: string | null): string | undefined {
  const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(value.trim()) : null;
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? `${match[1]}-${match[2]}-${match[3]}` : undefined;
}

function entriesQuery(db: Db) {
  return db
    .select({
      gameId: switchLibraryEntries.gameId,
      sizeBytes: switchLibraryEntries.sizeBytes,
      cartridgeBytes: switchLibraryEntries.cartridgeBytes,
      sizeAsOf: switchLibraryEntries.sizeAsOf,
      priceUsdCents: switchLibraryEntries.priceUsdCents,
      priceAsOf: switchLibraryEntries.priceAsOf,
      trailerYoutubeId: switchLibraryEntries.trailerYoutubeId,
      description: switchLibraryEntries.description,
      metacriticScore: switchLibraryEntries.metacriticScore,
      metacriticReviews: switchLibraryEntries.metacriticReviews,
      metacriticAsOf: switchLibraryEntries.metacriticAsOf,
      isHidden: switchLibraryEntries.isHidden,
      updatedAt: switchLibraryEntries.updatedAt,
      imageKey: files.storageKey,
      imageWidth: files.width,
      imageHeight: files.height,
    })
    .from(switchLibraryEntries)
    .leftJoin(files, and(eq(files.id, switchLibraryEntries.imageFileId), eq(files.visibility, "public"), isNull(files.deletedAt)))
    .orderBy(switchLibraryEntries.gameId);
}

type EntryRow = Awaited<ReturnType<typeof entriesQuery>>[number];

/** One row as the builder sees it; empty when nothing usable is set. */
export function toLibraryExtras(row: EntryRow): LibraryExtras {
  const extras: LibraryExtras = {};
  if (wholeAtLeast(row.sizeBytes, 1)) extras.sizeBytes = row.sizeBytes;
  if (wholeAtLeast(row.cartridgeBytes, 0)) extras.cartridgeBytes = row.cartridgeBytes;
  const sizeAsOf = isoDate(row.sizeAsOf);
  if (sizeAsOf) extras.sizeAsOf = sizeAsOf;
  if (wholeAtLeast(row.priceUsdCents, 0)) extras.priceUsdCents = row.priceUsdCents;
  const priceAsOf = isoDate(row.priceAsOf);
  if (priceAsOf) extras.priceAsOf = priceAsOf;
  const trailer = row.trailerYoutubeId?.trim();
  if (trailer && YOUTUBE_ID.test(trailer)) extras.trailerYouTubeId = trailer;
  if (isPublicStorageKey(row.imageKey)) {
    extras.imageKey = row.imageKey;
    if (wholeAtLeast(row.imageWidth, 1)) extras.imageWidth = row.imageWidth;
    if (wholeAtLeast(row.imageHeight, 1)) extras.imageHeight = row.imageHeight;
  }
  const description: NonNullable<LibraryExtras["description"]> = {};
  for (const locale of LOCALES) {
    const text = row.description?.[locale];
    if (typeof text === "string" && text.trim() !== "") description[locale] = text.trim();
  }
  if (Object.keys(description).length > 0) extras.description = description;
  const metacriticAsOf = isoDate(row.metacriticAsOf);
  if (wholeAtLeast(row.metacriticScore, 0) && row.metacriticScore <= 100 && wholeAtLeast(row.metacriticReviews, 0) && metacriticAsOf) {
    extras.metacritic = { score: row.metacriticScore, reviews: row.metacriticReviews, asOf: metacriticAsOf };
  }
  if (row.isHidden) extras.hidden = true;
  return extras;
}

/** A stored setting's raw JSON text, parsed; undefined when there is none or it is not JSON (sanitizeCapacity → defaults). */
function parseStored(text: string | null | undefined): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Every game's TamTam data (hidden ones flagged) + the planner constants — public; GET /api/switch-library. */
export async function getLibraryExtras(db: Db): Promise<LibraryExtrasPayload> {
  const [rows, capacityRows] = await db.batch([
    entriesQuery(db),
    // the raw text, not the JSON column's decoder: a value that is not even JSON must fall back to the defaults too
    db.select({ value: sql<string>`${settings.value}`, updatedAt: settings.updatedAt }).from(settings).where(eq(settings.key, CAPACITY_SETTING)),
  ]);
  const extras: LibraryExtrasPayload["extras"] = {};
  let latest = 0;
  for (const row of rows) {
    if (row.updatedAt > latest) latest = row.updatedAt;
    const entry = toLibraryExtras(row);
    if (Object.keys(entry).length > 0) extras[row.gameId] = entry;
  }
  const stored = capacityRows[0];
  if (stored && stored.updatedAt > latest) latest = stored.updatedAt;
  return { rev: `${latest}-${rows.length}`, extras, capacity: sanitizeCapacity(parseStored(stored?.value)) };
}
