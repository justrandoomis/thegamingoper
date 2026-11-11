/**
 * POST /api/upload/proof — the photo of a manual transfer (bank card / Zain Cash) for an order. Owner: checkout area.
 * Everything it does, and why in that order, is in ~/routes/storefront/checkout/proof.server.ts (`handleProofUpload`);
 * this module only binds it to the request: the signed-in customer (if any), the private blob store (KV), the time,
 * and where a stored picture is shown back to its shopper (`shopperFilePath` → GET /api/files/:fileId).
 *
 *   POST multipart/form-data  ref, t?, declaredAmountIqd, reference?, note?, file
 *   → 200 { ok: true, previewUrl }  ·  4xx { ok: false, code, fields? }        (what sendProof in ~/ui/ProofUploader reads)
 *
 * Same-origin only (the root middleware refuses cross-site POSTs), rate-limited per IP and per order, never cached.
 * The stored file is private (`prv_…` key): /media never serves it; `previewUrl` is the shoppers' private-file route,
 * which checks the order's token or the owner's session on every request.
 */
import { env } from "cloudflare:workers";
import { data } from "react-router";
import type { Route } from "./+types/upload-proof";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { kvBlobStore, shopperFilePath } from "~/server/storage.server";
import { handleProofUpload } from "~/routes/storefront/checkout/proof.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function loader() {
  return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const { status, body } = await handleProofUpload(
    { db, store: kvBlobStore(env.KV), customerId: session?.customer.id ?? null, ip: ctx.ip, locale: ctx.locale, now: ctx.now, previewPath: shopperFilePath },
    request,
  );
  const headers = new Headers(NO_STORE);
  if (!body.ok && body.retryAfterSec !== undefined) headers.set("Retry-After", String(body.retryAfterSec));
  return data(body, { status, headers });
}
