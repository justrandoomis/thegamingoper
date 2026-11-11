/**
 * Admin module 13 — which private files an employee may open: a trade-in's photos (the shopper's, the inspector's)
 * for trade-in staff, a used unit's photos for used-unit staff (an employee limited to a branch: units of that
 * branch). Everything else — and every public file (those are served by /media) — is null, the same answer as an
 * unknown id. The route serves the bytes `private, no-store`, sandboxed (fileResponse).
 */
import { and, eq, isNull } from "drizzle-orm";
import { canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { files, media, usedUnits } from "~/server/db/schema";
import { assertUnitBranch } from "./shared.server";
import { CUSTOMER_PHOTO_KIND, INSPECTION_PHOTO_KIND } from "./tradeins.server";
import { UNIT_PHOTO_KIND } from "./used.server";

const FILE_ID = /^fil_[0-9A-Z]{26}$/;
const TRADE_READERS = ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"] as const;
const UNIT_READERS = ["devices.registry.read", "devices.used.intake", "devices.used.inspect", "devices.used.grade", "devices.used.list", "devices.ownership.verify"] as const;

export async function devicesFile(db: Db, actor: Actor, fileId: string): Promise<{ id: string } | null> {
  if (!FILE_ID.test(fileId)) return null;
  const file = await db
    .select({ id: files.id, kind: files.kind, ownerType: files.ownerType, ownerId: files.ownerId, visibility: files.visibility })
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt)))
    .get();
  if (!file || file.visibility !== "private") return null;
  if (file.ownerType === "trade_in" && (file.kind === CUSTOMER_PHOTO_KIND || file.kind === INSPECTION_PHOTO_KIND) && canAny(actor, TRADE_READERS)) return { id: file.id };
  if (!canAny(actor, UNIT_READERS)) return null;
  // A used unit's photo: its own upload, or a trade-in inspection photo the unit carries as media.
  const unit = await db
    .select({ id: usedUnits.id, locationId: usedUnits.locationId })
    .from(media)
    .innerJoin(usedUnits, eq(usedUnits.id, media.ownerId))
    .where(and(eq(media.ownerType, "used_unit"), eq(media.fileId, file.id)))
    .get();
  if (!unit) return null;
  if (file.kind !== UNIT_PHOTO_KIND && file.kind !== INSPECTION_PHOTO_KIND) return null;
  try {
    await assertUnitBranch(db, actor, unit.locationId);
  } catch {
    return null;
  }
  return { id: file.id };
}
