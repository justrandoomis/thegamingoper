/**
 * GET /api/files/:fileId — a shopper's OWN private file, shown back to them (owner: server core; docs/SECURITY.md §9).
 *
 *   transfer proof       (files.kind "payment_proof")        the signed-in customer who owns the order, or the order's
 *                                                              confirmation token as `?t=<accessToken>` (the token of
 *                                                              /order/<ref>?t=…) — getPaymentProofFileForShopper
 *   wallet top-up proof  (files.kind "wallet_topup_proof")   the signed-in customer who uploaded it — getTopupProofForCustomer
 *
 * Build the URL with `shopperFilePath(fileId, token)` (~/server/storage.server). Every request is authorized again; a
 * private file is never a public URL. Everything else — an unknown id, another kind of file, a public file (those are
 * /media's), a deleted one, someone else's, a wrong or missing token, a guest without one — is the same 404, so the
 * route tells nobody what exists. A file it serves goes out through fileResponse(): `Cache-Control: private, no-store`,
 * `Cross-Origin-Resource-Policy: same-origin`, the type recorded at upload with `nosniff`, a sandboxing
 * Content-Security-Policy, `inline` only for the three image types. GET only (no action: React Router answers 405).
 * Staff see proofs in the admin, behind `payment_proof.read`, never here (their cookie is not sent to /api anyway).
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";
import type { Route } from "./+types/files";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getTopupProofForCustomer } from "~/server/services/account/topups.server";
import { getPaymentProofFileForShopper } from "~/server/services/payments/payments.server";
import { fileResponse, kvBlobStore } from "~/server/storage.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const store = kvBlobStore(env.KV);
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const accessToken = new URL(request.url).searchParams.get("t");
  const stored =
    (await getPaymentProofFileForShopper(db, store, params.fileId, { accessToken, customerId })) ??
    (customerId ? await getTopupProofForCustomer(db, store, customerId, params.fileId) : null);
  if (!stored) throw data({ ok: false as const, code: "not_found" }, { status: 404, headers: NO_STORE });
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private", originalName: stored.record.originalName }, stored.bytes, request);
}
