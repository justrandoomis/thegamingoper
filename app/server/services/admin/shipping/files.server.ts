/**
 * Private files of admin module 11 — who may open which (served by /admin/shipping/files/:fileId with fileResponse:
 * `private, no-store`, sandboxed):
 *
 *   packing_photo    a parcel's documented packing (11.06)                 shipping.shipment.read
 *   delivery_proof   the signed waybill / parcel at the door (11.06)       shipping.shipment.read
 *   cod_statement    a carrier's settlement statement (11.04)              shipping.cod.settle
 *
 * Anything else — a payment proof, a product image, a file of another module — is "not found" here, whatever the
 * employee may see elsewhere.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { codSettlements, files, shipments } from "~/server/db/schema";
import { ID_PATTERN } from "./shared.server";

export async function shippingFile(db: Db, actor: Actor, fileId: string): Promise<{ id: string } | null> {
  if (!ID_PATTERN.test(fileId)) return null;
  const file = await db
    .select({ id: files.id, kind: files.kind, ownerType: files.ownerType, ownerId: files.ownerId })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.visibility, "private"), isNull(files.deletedAt)))
    .get();
  if (!file) return null;
  if (file.kind === "cod_statement") {
    if (!can(actor, "shipping.cod.settle")) return null;
    const settlement = await db.select({ id: codSettlements.id }).from(codSettlements).where(eq(codSettlements.statementFileId, file.id)).get();
    return settlement ? { id: file.id } : null;
  }
  if (!can(actor, "shipping.shipment.read")) return null;
  if (file.kind === "packing_photo") return file.ownerType === "shipment" ? { id: file.id } : null;
  if (file.kind === "delivery_proof") {
    const parcel = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(or(eq(shipments.proofFileId, file.id), sql`EXISTS (SELECT 1 FROM delivery_attempts da WHERE da.shipment_id = ${shipments.id} AND da.proof_file_id = ${file.id})`))
      .get();
    return parcel ? { id: file.id } : null;
  }
  return null;
}
