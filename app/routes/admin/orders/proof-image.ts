import type { Route } from "./+types/proof-image";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { proofFileOf } from "~/server/services/admin/orders/queues.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { ordersBlobStore } from "./env.server";

/**
 * GET /admin/orders/proofs/image/:proofId — the picture of a transfer proof. A PRIVATE file (SECURITY.md §9): only for
 * employees holding payment_proof.read, sent with `Cache-Control: private, no-store`, a sandboxing CSP and nosniff
 * (fileResponse). Never served by /media.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "payment_proof.read");
  const proof = await proofFileOf(db, actor, params.proofId);
  if (!proof) return notFound();
  const stored = await getFile(db, ordersBlobStore(), proof.fileId);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
