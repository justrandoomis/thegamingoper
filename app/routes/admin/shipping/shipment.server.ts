/**
 * The parcel page's action (/admin/shipping/shipments/:shipmentId) — one POST endpoint, many intents, each handled by
 * a service that checks its own permission (assertCan) and validates its input (zod). Kept apart from the route module
 * so tests can call it with a hand-made session and form. Uploads are authorized and counted BEFORE a file is stored.
 *
 *   waybill         saveWaybill                       shipping.shipment.create
 *   pickup          pickupParcels (the order ships)   shipping.shipment.update + orders.fulfillment.ship
 *   move            moveParcels                       shipping.shipment.update (retry / returning: shipping.attempt.manage)
 *   attempt         recordAttempt                     shipping.attempt.manage
 *   deliver         deliverShipment (+ photo)         shipping.shipment.update (+ orders.fulfillment.deliver, + shipping.proof.manage)
 *   proof           addDeliveryProof (photo)          shipping.proof.manage
 *   packing         addPackingPhoto (photo)           shipping.proof.manage
 *   receive_return  receiveReturn                     shipping.attempt.manage
 *   sync            syncParcels                       shipping.shipment.update
 */
import { assertCan, can } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, invalid } from "~/server/errors";
import { parcelById } from "~/server/services/admin/shipping/shared.server";
import { addDeliveryProof, addPackingPhoto, assertDeliverable, deliverShipment, moveParcels, pickupParcels, receiveReturn, recordAttempt, saveWaybill, syncParcels } from "~/server/services/admin/shipping/shipments.server";
import type { BlobStore } from "~/server/storage.server";
import { saveImageUpload } from "~/server/uploads.server";
import { amount, enforceUploadLimit, optional, text, type ShippingRequest } from "./shipping.server";

export const PARCEL_INTENTS = ["waybill", "pickup", "move", "attempt", "deliver", "proof", "packing", "receive_return", "sync"] as const;
export type ParcelIntent = (typeof PARCEL_INTENTS)[number];

/** A chosen file (an empty file input sends a 0-byte part, which is "no file"). */
function chosenFile(form: FormData): File | null {
  const value = form.get("file");
  return value instanceof File && value.size > 0 ? value : null;
}

async function upload(req: ShippingRequest, store: () => BlobStore, form: FormData, kind: "packing_photo" | "delivery_proof", owner: { type: string; id: string }): Promise<string> {
  const file = chosenFile(form);
  if (!file) throw invalid({ file: "upload_missing" });
  await enforceUploadLimit(req);
  const { file: saved } = await saveImageUpload(req.db as Db, store(), file, { visibility: "private", kind, ownerType: owner.type, ownerId: owner.id, createdBy: req.actor, now: req.now });
  return saved.id;
}

export async function parcelAction(req: ShippingRequest, shipmentId: string, form: FormData, store: () => BlobStore): Promise<Record<string, unknown> & { intent: ParcelIntent }> {
  const raw = text(form, "intent");
  const intent = (PARCEL_INTENTS as readonly string[]).includes(raw) ? (raw as ParcelIntent) : null;
  if (!intent) throw invalid({ intent: "invalid" });
  const { db, actor, now } = req;
  const parcel = await parcelById(db, shipmentId);
  const from = optional(form, "from") as never;
  switch (intent) {
    case "waybill": {
      // the permission before the input: a role that may not make waybills gets 403, never a field error
      assertCan(actor, "shipping.shipment.create");
      const cost = amount(form, "costIqd");
      if (Number.isNaN(cost)) throw invalid({ costIqd: "invalid" });
      const result = await saveWaybill(db, actor, { shipmentId: parcel.id, carrierId: text(form, "carrierId"), serviceLevel: text(form, "serviceLevel") as never, trackingNo: optional(form, "trackingNo"), costIqd: cost, reason: optional(form, "reason"), from }, now);
      return { intent, ...result };
    }
    case "pickup": {
      const result = await pickupParcels(db, actor, { shipmentIds: [parcel.id] }, now);
      const failure = result.failed[0];
      if (failure) throw new AppError(failure.code, 409, { detail: failure.detail ?? failure.ref });
      return { intent, shipped: result.shipped };
    }
    case "move": {
      const result = await moveParcels(db, actor, { shipmentIds: [parcel.id], to: text(form, "to") as never, note: optional(form, "reason") ?? optional(form, "note"), from }, now);
      if (result.moved === 0 && result.skipped.length) throw new AppError("shipment_changed", 409, { detail: parcel.status });
      return { intent, ...result };
    }
    case "attempt": {
      const result = await recordAttempt(db, actor, { shipmentId: parcel.id, outcome: (optional(form, "code") ?? text(form, "outcome")) as never, reason: optional(form, "reason"), notes: optional(form, "notes"), nextAttemptDay: optional(form, "nextAttemptDay"), from }, now);
      return { intent, ...result };
    }
    case "deliver": {
      // Authorize and check the delivery before anything is stored: no file of a delivery that is refused (who may not
      // record it, a stale page, a parcel or order that cannot be delivered, a sensitive device without the receiver's
      // name) reaches storage. A repeated delivery takes no photo (the "proof" intent adds one).
      assertCan(actor, "shipping.shipment.update");
      let fileId: string | undefined;
      if (chosenFile(form)) {
        assertCan(actor, "shipping.proof.manage");
        const check = await assertDeliverable(db, actor, { shipmentId: parcel.id, receivedByName: optional(form, "receivedByName"), from: optional(form, "from") });
        if (check === "deliver") fileId = await upload(req, store, form, "delivery_proof", { type: "order", id: parcel.orderId });
      }
      const result = await deliverShipment(db, actor, { shipmentId: parcel.id, receivedByName: optional(form, "receivedByName"), fileId, note: optional(form, "note"), from }, now);
      return { intent, ...result };
    }
    case "proof": {
      assertCan(actor, "shipping.proof.manage");
      if (parcel.status !== "delivered") throw new AppError("proof_not_delivered", 409, { detail: parcel.status });
      if (text(form, "receivedByName").length < 2) throw invalid({ receivedByName: "required" });
      const fileId = await upload(req, store, form, "delivery_proof", { type: "order", id: parcel.orderId });
      await addDeliveryProof(db, actor, { shipmentId: parcel.id, fileId, receivedByName: text(form, "receivedByName") }, now);
      return { intent };
    }
    case "packing": {
      assertCan(actor, "shipping.proof.manage");
      if (parcel.status !== "pending" && parcel.status !== "packed") throw new AppError("packing_after_pickup", 409, { detail: parcel.status });
      const fileId = await upload(req, store, form, "packing_photo", { type: "shipment", id: parcel.id });
      await addPackingPhoto(db, actor, { shipmentId: parcel.id, fileId, note: optional(form, "note") }, now);
      return { intent };
    }
    case "receive_return": {
      const lines = [...form.keys()]
        .filter((key) => key.startsWith("disp:"))
        .map((key) => ({ orderItemId: key.slice(5), disposition: (text(form, key) === "scrap" ? "scrap" : "restock") as "scrap" | "restock" }));
      const result = await receiveReturn(db, actor, { shipmentId: parcel.id, reason: text(form, "reason"), lines }, now);
      return { intent, ...result };
    }
    case "sync": {
      const result = await syncParcels(db, actor, parcel.orderId, now);
      return { intent, ...result };
    }
  }
}

/** Whether this employee may record the delivery photo along with the delivery (for the form). */
export const mayAttachProof = (req: ShippingRequest) => can(req.actor, "shipping.proof.manage");
