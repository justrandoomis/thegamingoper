import type { Route } from "./+types/file";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { deliveryProofFile } from "~/server/services/admin/orders/fulfillment.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { ordersBlobStore } from "./env.server";

/**
 * GET /admin/orders/files/:fileId — a proof-of-delivery photo of a parcel (05.08). A PRIVATE file: staff who may read
 * orders, `private, no-store`, sandboxed (fileResponse). Payment proofs are NOT served here (they need
 * payment_proof.read: /admin/orders/proofs/image/:proofId).
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.read");
  const file = await deliveryProofFile(db, actor, params.fileId);
  if (!file) return notFound();
  const stored = await getFile(db, ordersBlobStore(), file.id);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
