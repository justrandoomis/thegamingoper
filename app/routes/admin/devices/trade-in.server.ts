/**
 * The trade-in page's action (/admin/devices/trade-ins/:ref) — one POST endpoint, many intents. Each intent checks the
 * permission it needs at the route first (403 before anything is read), then calls a service that checks it again
 * (assertCan) and validates its input (zod). Ids in the form are scoped to the URL's trade-in. Kept apart from the
 * route module so tests can call it with a hand-made session and form.
 *
 *   schedule   scheduleInspection   (the inspection appointment)                     devices.tradein.inspect
 *   inspect    recordInspection     (checklist, grade, variant, serial, ownership)   devices.tradein.inspect
 *   photo      private upload (trade_in_inspection) + recordTradeInPhoto           devices.tradein.inspect
 *   offer      makeOffer            (the final, human-made quote)                   devices.tradein.offer
 *   answer     recordAnswer         (the customer's answer, in person)               devices.tradein.offer
 *   wipe       confirmWipe          (accounts unlinked, data wiped)                  devices.ownership.verify
 *   payout     payOut               (store credit / cash, the used unit)             devices.tradein.payout
 *   cancel     cancelTradeIn                                                         devices.tradein.offer | inspect
 */
import { can, canAny } from "~/server/actor";
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { checklistAnswersFrom } from "~/server/services/admin/devices/shared.server";
import { assertTradeInPhotoSlot, cancelTradeIn, confirmWipe, INSPECTION_PHOTO_KIND, makeOffer, payOut, recordAnswer, recordInspection, recordTradeInPhoto, scheduleInspection, tradeInByRef } from "~/server/services/admin/devices/tradeins.server";
import type { BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { accessoryWords, failure, text, type Failure } from "./devices.server";

export const TRADE_IN_INTENTS = ["schedule", "inspect", "photo", "offer", "answer", "wipe", "payout", "cancel"] as const;
export type TradeInIntent = (typeof TRADE_IN_INTENTS)[number];

const NEEDS: Record<TradeInIntent, readonly Permission[]> = {
  schedule: ["devices.tradein.inspect"],
  inspect: ["devices.tradein.inspect"],
  photo: ["devices.tradein.inspect"],
  offer: ["devices.tradein.offer"],
  answer: ["devices.tradein.offer"],
  wipe: ["devices.ownership.verify"],
  payout: ["devices.tradein.payout"],
  cancel: ["devices.tradein.offer", "devices.tradein.inspect"],
};

export type TradeInActionResult = { ok: true; intent: TradeInIntent; replayed?: boolean; status?: string; usedUnitId?: string } | Failure;

const yesNo = (value: string): boolean | undefined => (value === "yes" ? true : value === "no" ? false : undefined);

export async function tradeInAction(ctx: Pick<AuthCtx, "locale" | "now">, db: Db, session: EmployeeSession, ref: string, form: FormData, store: () => BlobStore): Promise<TradeInActionResult> {
  const raw = text(form, "intent");
  const intent = (TRADE_IN_INTENTS as readonly string[]).includes(raw) ? (raw as TradeInIntent) : null;
  const { actor } = session;
  const now = ctx.now;
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    if (!canAny(actor, NEEDS[intent])) throw forbidden(NEEDS[intent][0]);
    const row = await tradeInByRef(db, ref);
    switch (intent) {
      case "schedule": {
        const result = await scheduleInspection(db, actor, { tradeInId: row.id, day: text(form, "day"), time: text(form, "time"), note: text(form, "note") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "inspect": {
        const ownership = yesNo(text(form, "ownershipOk"));
        const lock = yesNo(text(form, "accountLockOk"));
        // Who may confirm ownership (devices.ownership.verify) answers both questions; an inspector without that right
        // sees them read-only and leaves what is on file (the service refuses a "yes" from them).
        if (can(actor, "devices.ownership.verify") && (ownership === undefined || lock === undefined)) {
          return { ok: false, intent, code: "invalid", status: 400, fields: { ...(ownership === undefined ? { ownershipOk: "required" } : {}), ...(lock === undefined ? { accountLockOk: "required" } : {}) }, message: undefined };
        }
        const result = await recordInspection(
          db,
          actor,
          {
            tradeInId: row.id,
            templateId: text(form, "templateId"),
            variantId: text(form, "variantId"),
            serial: text(form, "serial"),
            grade: text(form, "grade"),
            answers: checklistAnswersFrom(form),
            included: form.getAll("included").map(String),
            ownershipOk: ownership,
            accountLockOk: lock,
            notes: text(form, "notes"),
          },
          now,
        );
        return { ok: true, intent, status: result.complete ? "complete" : "incomplete" };
      }
      case "photo": {
        // Authorize and check the room left BEFORE anything is stored.
        const checked = await assertTradeInPhotoSlot(db, actor, row.id);
        await enforceRateLimit(db, await limitKey("upload", "employee", actor.id), RATE_LIMITS.upload, now);
        const { file } = await saveImageUpload(db, store(), form.get("file"), { visibility: "private", kind: INSPECTION_PHOTO_KIND, ownerType: "trade_in", ownerId: row.id, createdBy: actor, now });
        await recordTradeInPhoto(db, actor, checked, file.id, now);
        return { ok: true, intent };
      }
      case "offer": {
        const result = await makeOffer(db, actor, { tradeInId: row.id, amountIqd: text(form, "amountIqd"), validDays: text(form, "validDays") || undefined, note: text(form, "note") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "answer": {
        const decision = text(form, "decision");
        const result = await recordAnswer(db, actor, decision === "accept" ? { tradeInId: row.id, decision, payout: text(form, "payout") } : { tradeInId: row.id, decision, reason: text(form, "reason") }, now);
        return { ok: true, intent, status: result.status, replayed: result.replayed };
      }
      case "wipe": {
        const result = await confirmWipe(db, actor, { tradeInId: row.id, note: text(form, "note") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "payout": {
        const result = await payOut(db, actor, { tradeInId: row.id, method: text(form, "method"), locationId: text(form, "locationId"), reason: text(form, "reason"), shiftId: text(form, "shiftId") }, now, { labels: accessoryWords });
        return { ok: true, intent, replayed: result.replayed, usedUnitId: result.usedUnitId, status: result.method };
      }
      case "cancel": {
        const result = await cancelTradeIn(db, actor, { tradeInId: row.id, reason: text(form, "reason") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
