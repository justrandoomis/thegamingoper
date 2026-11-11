import type { Route } from "./+types/topup-proof";
import { isAppError } from "~/server/errors";
import { topupProofFile } from "~/server/services/admin/finance/wallets.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { financeBlobStore } from "./env.server";
import { openFinance } from "./finance.server";

/**
 * GET /admin/finance/wallets/topups/:topupId/proof — the photo of a wallet top-up's transfer. A PRIVATE file
 * (SECURITY.md §9, kind wallet_topup_proof): only for employees holding finance.wallet.read AND payment_proof.read,
 * sent with `Cache-Control: private, no-store`, a sandboxing CSP and nosniff (fileResponse). Never served by /media.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { db, actor } = await openFinance(context, "payment_proof.read");
  let fileId: string | null = null;
  try {
    fileId = await topupProofFile(db, actor, params.topupId);
  } catch (error) {
    // finance.wallet.read missing: the same answer as a file that does not exist
    if (isAppError(error, "forbidden")) return notFound();
    throw error;
  }
  if (!fileId) return notFound();
  const stored = await getFile(db, financeBlobStore(), fileId);
  if (!stored || stored.record.visibility !== "private") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
