import type { Route } from "./+types/file";
import { supportPhotoFile } from "~/server/services/admin/support/tickets.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { supportBlobStore } from "./env.server";
import { openSupport } from "./support.server";

/**
 * GET /admin/support/files/:fileId — a PRIVATE photo a customer attached to a support ticket, an assistant hand-off or
 * a repair request, for staff who may read tickets (SECURITY.md §9: authorized first, then `fileResponse`:
 * `private, no-store`, sandboxed, the type recorded at upload). Anything else — unknown, public, deleted, a payment
 * proof or any other kind of file — is the same 404.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { db, actor } = await openSupport(context, "support.ticket.read");
  const file = await supportPhotoFile(db, actor, params.fileId);
  if (!file) return notFound();
  const stored = await getFile(db, supportBlobStore(), file.id);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
