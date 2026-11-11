/**
 * The packing station's action (/admin/orders/:ref/pack) — 04.11 pick → pack → ship and 05.04 parcels.
 *
 *   scan     scanCode       a keyboard-wedge scan: serial → attached (the core's serial statements), SKU/barcode →
 *                           one unit verified, anything else refused and written down        orders.fulfillment.pack
 *   manual   manualVerify   the rest of a line WITHOUT serials confirmed by hand, with a reason    orders.fulfillment.pack
 *   split    splitParcel    units moved into a new parcel                                         orders.fulfillment.pack
 *   packed   markPacked     every line verified → parcels packed                                  orders.fulfillment.pack
 *   ship     changeOrderStatus → shipped (transitionOrder: serials and stock checked again)       orders.fulfillment.ship
 */
import type { EmployeeSession } from "~/server/auth/admin.server";
import type { Db } from "~/server/db/drizzle.server";
import type { Locale } from "~/lib/locales";
import { changeOrderStatus } from "~/server/services/admin/orders/actions.server";
import { manualVerify, markPacked, scanCode, splitParcel, type ScanOutcome } from "~/server/services/admin/orders/fulfillment.server";
import { orderByRef } from "~/server/services/admin/orders/shared.server";
import { failure, text, type Failure } from "./common.server";

export const PACK_INTENTS = ["scan", "manual", "split", "packed", "ship"] as const;
export type PackIntent = (typeof PACK_INTENTS)[number];

export type PackActionResult = { ok: true; intent: "scan"; outcome: ScanOutcome } | { ok: true; intent: Exclude<PackIntent, "scan">; replayed?: boolean } | Failure;

export async function packAction(ctx: { locale: Locale; now: number }, db: Db, session: EmployeeSession, ref: string, form: FormData): Promise<PackActionResult> {
  const raw = text(form, "intent");
  const intent = (PACK_INTENTS as readonly string[]).includes(raw) ? (raw as PackIntent) : null;
  const { actor } = session;
  try {
    const order = await orderByRef(db, ref);
    switch (intent) {
      case "scan":
        return { ok: true, intent, outcome: await scanCode(db, actor, order.id, { code: text(form, "code"), scanId: text(form, "scanId") }, ctx.now) };
      case "manual": {
        const result = await manualVerify(db, actor, order.id, { orderItemId: text(form, "orderItemId"), reason: text(form, "reason"), scanId: text(form, "scanId") }, ctx.now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "split": {
        const lines = form
          .getAll("line")
          .map((value) => String(value))
          .map((orderItemId) => ({ orderItemId, qty: Number(text(form, `qty_${orderItemId}`) || "0") }))
          .filter((line) => line.qty > 0);
        await splitParcel(db, actor, order.id, { lines }, ctx.now);
        return { ok: true, intent };
      }
      case "packed": {
        const result = await markPacked(db, actor, order.id, ctx.now);
        return { ok: true, intent, replayed: result.replayed };
      }
      case "ship": {
        const result = await changeOrderStatus(db, actor, order.id, { to: "shipped", from: (text(form, "from") || undefined) as never, reason: text(form, "reason") || undefined, trackingNo: text(form, "trackingNo") || undefined }, ctx.now);
        return { ok: true, intent, replayed: result.replayed };
      }
      default:
        return { ok: false, intent: null, code: "invalid", status: 400 };
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}
