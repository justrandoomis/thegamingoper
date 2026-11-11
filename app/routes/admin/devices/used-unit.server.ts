/**
 * The used unit page's action (/admin/devices/used/:id) — one POST endpoint, many intents, each checked at the route
 * (403 before anything is read) and again in its service. Kept apart from the route module for tests.
 *
 *   checklist     saveUnitChecklist     (13.02)                                   devices.used.inspect
 *   grade         saveUnitGrading       (13.09: grade, notes, defects, included)  devices.used.grade
 *   checks        confirmUnitChecks     (13.08: ownership, data wipe)             devices.ownership.verify
 *   reinspect     startReinspection     (a unit that came back)                   devices.used.inspect
 *   photo         private upload (used_photo) + recordUnitPhoto                  devices.used.inspect | grade
 *   photo-real    setPhotoReal          ("this photo shows THIS unit")            devices.used.grade
 *   photo-remove  removeUnitPhoto                                                 devices.used.grade
 *   list          listUnit              (publishes the real photos)               devices.used.list
 *   unlist        unlistUnit                                                      devices.used.list
 *   price         setUsedUnitPrice      (pricing 03's rules and four eyes)        pricing.used.update
 */
import { canAny } from "~/server/actor";
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { checklistAnswersFrom } from "~/server/services/admin/devices/shared.server";
import { assertUnitPhotoSlot, confirmUnitChecks, listUnit, recordUnitPhoto, removeUnitPhoto, saveUnitChecklist, saveUnitGrading, setPhotoReal, startReinspection, UNIT_PHOTO_KIND, unlistUnit } from "~/server/services/admin/devices/used.server";
import { MAX_DEFECTS } from "~/server/services/admin/devices/types";
import { setUsedUnitPrice } from "~/server/services/admin/pricing/special.server";
import type { BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { accessoryWords, checked, failure, text, type Failure } from "./devices.server";

export const UNIT_INTENTS = ["checklist", "grade", "checks", "reinspect", "photo", "photo-real", "photo-remove", "list", "unlist", "price"] as const;
export type UnitIntent = (typeof UNIT_INTENTS)[number];

const NEEDS: Record<UnitIntent, readonly Permission[]> = {
  checklist: ["devices.used.inspect"],
  grade: ["devices.used.grade"],
  checks: ["devices.ownership.verify"],
  reinspect: ["devices.used.inspect"],
  photo: ["devices.used.inspect", "devices.used.grade"],
  "photo-real": ["devices.used.grade"],
  "photo-remove": ["devices.used.grade"],
  list: ["devices.used.list"],
  unlist: ["devices.used.list"],
  price: ["pricing.used.update"],
};

export type UnitActionResult = { ok: true; intent: UnitIntent; replayed?: boolean; status?: string } | Failure;

/** The grading form's rows: defects d.<n>.area / severity / ar / en / ckb (rows without words are skipped). */
function defectsFrom(form: FormData) {
  const out: { area: string; severity: string; note: { ar: string; en: string; ckb: string } }[] = [];
  for (let index = 0; index < MAX_DEFECTS; index++) {
    const ar = text(form, `d.${index}.ar`);
    const en = text(form, `d.${index}.en`);
    const ckb = text(form, `d.${index}.ckb`);
    if (!ar && !en && !ckb) continue;
    out.push({ area: text(form, `d.${index}.area`), severity: text(form, `d.${index}.severity`), note: { ar, en, ckb } });
  }
  return out;
}

export async function unitAction(ctx: Pick<AuthCtx, "locale" | "now">, db: Db, session: EmployeeSession, usedUnitId: string, form: FormData, store: () => BlobStore): Promise<UnitActionResult> {
  const raw = text(form, "intent");
  const intent = (UNIT_INTENTS as readonly string[]).includes(raw) ? (raw as UnitIntent) : null;
  const { actor } = session;
  const now = ctx.now;
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    if (!canAny(actor, NEEDS[intent])) throw forbidden(NEEDS[intent][0]);
    switch (intent) {
      case "checklist": {
        const result = await saveUnitChecklist(db, actor, { usedUnitId, templateId: text(form, "templateId"), answers: checklistAnswersFrom(form) }, now);
        return { ok: true, intent, status: result.status };
      }
      case "grade": {
        const included = form.getAll("included").map(String);
        const extra = { ar: text(form, "extraAr"), en: text(form, "extraEn"), ckb: text(form, "extraCkb") };
        const result = await saveUnitGrading(
          db,
          actor,
          {
            usedUnitId,
            grade: text(form, "grade"),
            cosmeticNotes: { ar: text(form, "notesAr"), en: text(form, "notesEn"), ckb: text(form, "notesCkb") },
            defects: defectsFrom(form),
            included: [...included.filter((key) => key !== "extra").map((key) => ({ key })), ...(extra.ar || extra.en ? [{ key: "extra", label: extra }] : [])],
            warrantyDays: text(form, "warrantyDays"),
          },
          now,
          accessoryWords,
        );
        return { ok: true, intent, status: result.status };
      }
      case "checks": {
        const result = await confirmUnitChecks(db, actor, { usedUnitId, ownership: checked(form, "ownership"), wipe: checked(form, "wipe"), note: text(form, "note") }, now);
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "reinspect": {
        const result = await startReinspection(db, actor, { usedUnitId, reason: text(form, "reason") }, now);
        return { ok: true, intent, status: result.status };
      }
      case "photo": {
        const unit = await assertUnitPhotoSlot(db, actor, usedUnitId);
        await enforceRateLimit(db, await limitKey("upload", "employee", actor.id), RATE_LIMITS.upload, now);
        const { file } = await saveImageUpload(db, store(), form.get("file"), { visibility: "private", kind: UNIT_PHOTO_KIND, ownerType: "used_unit", ownerId: unit.id, createdBy: actor, now });
        await recordUnitPhoto(db, actor, unit, file.id, now, text(form, "alt"));
        return { ok: true, intent };
      }
      case "photo-real": {
        const result = await setPhotoReal(db, store(), actor, { usedUnitId, mediaId: text(form, "mediaId"), real: checked(form, "real") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "photo-remove": {
        await removeUnitPhoto(db, store(), actor, { usedUnitId, mediaId: text(form, "mediaId") }, now);
        return { ok: true, intent };
      }
      case "list": {
        const result = await listUnit(db, store(), actor, { usedUnitId }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "unlist": {
        const result = await unlistUnit(db, actor, { usedUnitId, reason: text(form, "reason") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "price": {
        const result = await setUsedUnitPrice(db, actor, { usedUnitId, price: text(form, "price"), expectedPriceIqd: text(form, "expectedPriceIqd"), reason: text(form, "reason") }, now);
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
