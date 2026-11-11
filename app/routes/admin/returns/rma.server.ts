/**
 * The RMA page's action (/admin/returns/:rma) — one POST endpoint, many intents. Each intent first checks the
 * permission it needs at the route (403 before anything is read), then calls a service that checks it again
 * (assertCan) and validates its input (zod). Every id in the form is scoped to the URL's RMA (an item or refund of
 * another RMA is not_found). Kept apart from the route module so tests can call it with a hand-made session and form.
 *
 *   decide           decideReturn          (approve / reject; never the employee who opened it)   returns.rma.approve
 *   transit          markInTransit                                                                returns.rma.inspect | create
 *   cancel           cancelReturn                                                                 returns.rma.approve
 *   close            closeReturn                                                                  returns.rma.approve
 *   note             addReturnNote                                                                returns.rma.create | inspect | approve
 *   photo            private upload (return_photo) + recordReturnPhoto                            returns.rma.create | inspect
 *   inspect          inspectItem           (goods through the core)                               returns.rma.inspect
 *   refund           requestReturnRefund   (createRefund, idempotency key)                        orders.refund.create
 *   refund-decision  decideReturnRefund    (approveRefund, never the requester)                   orders.refund.approve
 *   repair           openReturnRepair      (a kept unit repaired for its customer)                returns.repair.manage
 */
import { canAny } from "~/server/actor";
import type { AuthCtx, EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { inspectItem } from "~/server/services/admin/returns/inspect.server";
import { decideReturnRefund, requestReturnRefund } from "~/server/services/admin/returns/refund.server";
import { openReturnRepair } from "~/server/services/admin/returns/repair.server";
import { addReturnNote, assertPhotoSlot, cancelReturn, closeReturn, decideReturn, markInTransit, recordReturnPhoto } from "~/server/services/admin/returns/rma.server";
import { returnByRma } from "~/server/services/admin/returns/shared.server";
import type { BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { failure, text, type Failure } from "./returns.server";
import { parseWhole } from "~/server/services/admin/returns/types";

export const RMA_INTENTS = ["decide", "transit", "cancel", "close", "note", "photo", "inspect", "refund", "refund-decision", "repair"] as const;
export type RmaIntent = (typeof RMA_INTENTS)[number];

const NEEDS: Record<RmaIntent, readonly Permission[]> = {
  decide: ["returns.rma.approve"],
  transit: ["returns.rma.inspect", "returns.rma.create"],
  cancel: ["returns.rma.approve"],
  close: ["returns.rma.approve"],
  note: ["returns.rma.create", "returns.rma.inspect", "returns.rma.approve"],
  photo: ["returns.rma.create", "returns.rma.inspect"],
  inspect: ["returns.rma.inspect"],
  refund: ["orders.refund.create"],
  "refund-decision": ["orders.refund.approve"],
  repair: ["returns.repair.manage"],
};

export type RmaActionResult = { ok: true; intent: RmaIntent; replayed?: boolean; status?: string } | Failure;

const yes = (value: string) => value === "1" || value === "true" || value === "on";

export async function rmaAction(ctx: Pick<AuthCtx, "locale" | "now">, db: Db, session: EmployeeSession, rma: string, form: FormData, store: () => BlobStore): Promise<RmaActionResult> {
  const raw = text(form, "intent");
  const intent = (RMA_INTENTS as readonly string[]).includes(raw) ? (raw as RmaIntent) : null;
  const { actor } = session;
  const now = ctx.now;
  try {
    if (!intent) return { ok: false, intent: null, code: "invalid", status: 400 };
    if (!canAny(actor, NEEDS[intent])) throw forbidden(NEEDS[intent][0]);
    const ret = await returnByRma(db, rma);
    switch (intent) {
      case "decide": {
        const result = await decideReturn(db, actor, ret.id, { approve: yes(text(form, "approve")), note: text(form, "note") || undefined }, now);
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "transit": {
        const result = await markInTransit(db, actor, ret.id, { note: text(form, "note") || undefined }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "cancel": {
        const result = await cancelReturn(db, actor, ret.id, { reason: text(form, "reason") }, now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "close": {
        const result = await closeReturn(db, actor, ret.id, { resolution: text(form, "resolution") as never, note: text(form, "note") }, now);
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "note":
        await addReturnNote(db, actor, ret.id, { text: text(form, "text") }, now);
        return { ok: true, intent };
      case "photo": {
        // Authorize and check the room left BEFORE anything is stored.
        const checked = await assertPhotoSlot(db, actor, ret.id);
        await enforceRateLimit(db, await limitKey("upload", "employee", actor.id), RATE_LIMITS.upload, now);
        const { file } = await saveImageUpload(db, store(), form.get("file"), { visibility: "private", kind: "return_photo", ownerType: "return", ownerId: ret.id, createdBy: actor, now });
        await recordReturnPhoto(db, actor, checked, file.id, now);
        return { ok: true, intent };
      }
      case "inspect": {
        const result = await inspectItem(
          db,
          actor,
          {
            returnId: ret.id,
            itemId: text(form, "itemId"),
            condition: text(form, "condition") as never,
            decision: text(form, "decision") as never,
            locationId: text(form, "locationId") || undefined,
            serial: text(form, "serial") || undefined,
            notes: text(form, "notes") || undefined,
          },
          now,
        );
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "refund": {
        const result = await requestReturnRefund(
          db,
          actor,
          {
            returnId: ret.id,
            paymentId: text(form, "paymentId"),
            itemIds: form.getAll("itemId").map(String),
            amountIqd: parseWhole(text(form, "amountIqd")) as number,
            method: text(form, "method") as never,
            reason: text(form, "reason"),
            reference: text(form, "reference") || undefined,
            idempotencyKey: text(form, "idempotencyKey"),
          },
          now,
        );
        return { ok: true, intent, replayed: result.replayed, status: result.status };
      }
      case "refund-decision": {
        const result = await decideReturnRefund(db, actor, { returnId: ret.id, refundId: text(form, "refundId"), approve: yes(text(form, "approve")), note: text(form, "note") || undefined, reference: text(form, "reference") || undefined }, now);
        return { ok: true, intent, status: result.status };
      }
      case "repair": {
        const result = await openReturnRepair(db, actor, { returnId: ret.id, itemId: text(form, "itemId"), issue: text(form, "issue") }, now);
        return { ok: true, intent, replayed: result.replayed, status: result.ref };
      }
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
