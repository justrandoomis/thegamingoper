import type { Route } from "./+types/file";
import { canAny } from "~/server/actor";
import { repairPhotoFile } from "~/server/services/admin/returns/repair.server";
import { returnPhotoFile } from "~/server/services/admin/returns/rma.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { returnsBlobStore } from "./env.server";
import { openReturns } from "./returns.server";

/**
 * GET /admin/returns/files/:fileId — a PRIVATE photo of the module: an RMA's photo (staff who may read that RMA) or a
 * photo a customer attached to a repair request (staff who may read repairs). `private, no-store`, sandboxed
 * (fileResponse). Anything else is the same 404.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { db, actor } = await openReturns(context, ["returns.rma.read", "returns.rma.create", "returns.repair.manage", "returns.warranty.read"]);
  const file = (canAny(actor, ["returns.rma.read", "returns.rma.create"]) ? await returnPhotoFile(db, actor, params.fileId) : null) ?? (canAny(actor, ["returns.repair.manage", "returns.rma.read", "returns.warranty.read"]) ? await repairPhotoFile(db, actor, params.fileId) : null);
  if (!file) return notFound();
  const stored = await getFile(db, returnsBlobStore(), file.id);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
