/**
 * The photo of a wallet top-up transfer — a resource route of the account area.
 *
 *   POST /account/wallet/proof            multipart: file=<image>     → 200 { ok: true, fileId, previewUrl }
 *                                                                       4xx { ok: false, code } (upload_missing · upload_too_large ·
 *                                                                       upload_type · upload_corrupt · upload_dimensions · rate_limited ·
 *                                                                       unauthorized)
 *   GET  /account/wallet/proof/<fileId>   the image itself, ONLY for the customer who uploaded it (404 for anyone else)
 *
 * The file goes through the upload pipeline (type by content, ≤ 8 MB, metadata removed) and is stored PRIVATELY
 * (`files.kind = "wallet_topup_proof"`, never served by /media). Uploading does not create the top-up request: the
 * wallet page sends `fileId` with the amount (requestWalletTopup), and staff decide in the admin.
 * Cross-site posts are refused by the root middleware.
 */
import { data } from "react-router";
import type { Route } from "./+types/wallet-proof";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError } from "~/server/errors";
import { fileResponse } from "~/server/storage.server";
import { getTopupProofForCustomer, saveTopupProof } from "~/server/services/account/topups.server";
import { MAX_IMAGE_BYTES } from "~/server/uploads.server";
import { blobStore } from "./account.server";

const NO_STORE = { "Cache-Control": "no-store" } as const;
/** The image plus the multipart wrapping. */
const MAX_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const fileId = params.fileId;
  if (!session || !fileId) throw data({ ok: false, code: "not_found" }, { status: 404, headers: NO_STORE });
  const stored = await getTopupProofForCustomer(db, blobStore(), session.customer.id, fileId);
  if (!stored) throw data({ ok: false, code: "not_found" }, { status: 404, headers: NO_STORE });
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private", originalName: stored.record.originalName }, stored.bytes, request);
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const ctx = getCtx(context);
  if (request.method !== "POST" || params.fileId) return data({ ok: false as const, code: "method_not_allowed" }, { status: 405, headers: { ...NO_STORE, Allow: "POST" } });
  const db = getDb();
  const session = await getCustomer(ctx, db);
  if (!session) return data({ ok: false as const, code: "unauthorized" }, { status: 401, headers: NO_STORE });
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return data({ ok: false as const, code: "upload_too_large" }, { status: 413, headers: NO_STORE });
  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return data({ ok: false as const, code: "upload_missing" }, { status: 400, headers: NO_STORE });
    }
    const saved = await saveTopupProof(db, blobStore(), session.actor, form.get("file"), ctx.now);
    return data({ ok: true as const, fileId: saved.fileId, previewUrl: saved.previewPath }, { headers: NO_STORE });
  } catch (error) {
    const { status, retryAfterSec, code } = actionError(error);
    const headers = new Headers(NO_STORE);
    if (retryAfterSec !== undefined) headers.set("Retry-After", String(retryAfterSec));
    return data({ ok: false as const, code, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) }, { status, headers });
  }
}
