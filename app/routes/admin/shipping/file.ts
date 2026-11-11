import type { Route } from "./+types/file";
import { shippingFile } from "~/server/services/admin/shipping/files.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { shippingBlobStore } from "./env.server";
import { openShipping } from "./shipping.server";

/**
 * GET /admin/shipping/files/:fileId — a PRIVATE file of the shipping module: a parcel's packing photo or proof of
 * delivery (shipping.shipment.read), a carrier's settlement statement (shipping.cod.settle). `private, no-store`,
 * sandboxed (fileResponse). Anything else — including a file this employee may not open — is the same 404.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { db, actor } = await openShipping(context);
  const file = await shippingFile(db, actor, params.fileId);
  if (!file) return notFound();
  const stored = await getFile(db, shippingBlobStore(), file.id);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
