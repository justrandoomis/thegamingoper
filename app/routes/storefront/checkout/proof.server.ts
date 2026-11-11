/**
 * POST /api/upload/proof — the transfer proof of an order (brief §4 C/D, CONTRACTS §1 payments, DESIGN.md §9.18).
 * The route (app/routes/api/upload-proof.ts) is a thin shell around `handleProofUpload`, which takes its database,
 * blob store and request facts as arguments so tests can drive it against a real local D1 + KV.
 *
 * multipart/form-data:
 *   ref                 the order reference (TT-…)
 *   t                   the confirmation link's access token — or none, when the signed-in customer owns the order
 *   declaredAmountIqd   what the shopper says they transferred (whole dinars; Arabic-Indic digits and separators ok)
 *   reference           optional — the transfer's reference number (lets staff spot a reused receipt)
 *   note                optional
 *   file                the photo: JPEG, PNG or WebP, ≤ 8 MB — decided by its bytes, metadata stripped
 *
 * Answers exactly what `sendProof` in ~/ui/ProofUploader reads: 200 `{ ok: true, previewUrl? }`, or
 * `{ ok: false, code, fields? }` with the status of the failure (400 invalid · 404 not_found · 409 proof_not_expected /
 * payment_window_closed · 413 / 415 / 422 upload_* · 429 rate_limited). `previewUrl` is where this shopper can open the
 * stored picture again — the shoppers' private-file route, GET /api/files/<fileId> (with `?t=<token>` for a guest),
 * which authorizes every request and answers `private, no-store`, so it still works after a reload; it is included
 * when the caller says where that route is (`deps.previewPath`, the route passes shopperFilePath). `duplicateOf`
 * (another proof with the same picture or reference) is for staff only and never leaves this function.
 *
 * Order of work — nothing is stored for a request that cannot succeed:
 *   1. body size (Content-Length) and the per-IP upload limit, before the body is read
 *   2. the fields (amount, note, reference), checked with the commerce core's own limits
 *   3. who: the signed-in customer's own order, else the confirmation token — a wrong reference and a wrong token
 *      both answer not_found; then a per-order limit
 *   4. the order must be waiting for a proof (`payment.canUploadProof`): otherwise proof_not_expected, or
 *      payment_window_closed when the upload window has passed
 *   5. the image is validated and stored PRIVATE, kind "payment_proof" (saveImageUpload: type by magic bytes, size,
 *      structure, dimensions, metadata removed, SHA-256)
 *   6. payments.submitPaymentProof attaches it (order → payment_review, payment → pending_verification). If that is
 *      refused, the stored file is deleted again.
 */
import { z } from "zod";
import type { Locale } from "~/lib/locales";
import type { Actor } from "~/server/actor";
import { readFormData } from "~/server/body.server";
import type { Db } from "~/server/db/drizzle.server";
import { isAppError, toAppError } from "~/server/errors";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { deleteFile, type BlobStore } from "~/server/storage.server";
import { MAX_IMAGE_BYTES, saveImageUpload } from "~/server/uploads.server";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { submitPaymentProof } from "~/server/services/payments/payments.server";
import { parseAmountInput } from "./checkout-form";
import { findOrderForShopper } from "./checkout.server";

/** The image limit plus room for the small text fields and the multipart framing. */
export const MAX_PROOF_BODY_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export type ProofUploadAnswer = { ok: true; previewUrl?: string } | { ok: false; code: string; fields?: Record<string, string>; retryAfterSec?: number };
export type ProofUploadOutcome = { status: number; body: ProofUploadAnswer };

export type ProofUploadDeps = {
  db: Db;
  store: BlobStore;
  /** The signed-in customer, when there is one (the route resolves the session). */
  customerId: string | null;
  ip: string | null;
  locale: Locale;
  now: number;
  /**
   * Where the stored picture can be shown back to this shopper — `shopperFilePath` from ~/server/storage.server
   * (GET /api/files/:fileId; `accessToken` is the confirmation token for a guest, null for the signed-in owner).
   * Without it the answer carries no `previewUrl`.
   */
  previewPath?: (fileId: string, accessToken: string | null) => string;
};

const fail = (status: number, code: string, extra: Omit<Extract<ProofUploadAnswer, { ok: false }>, "ok" | "code"> = {}): ProofUploadOutcome => ({ status, body: { ok: false, code, ...extra } });

/** The text fields, with the limits of SubmitProofInput (payments.server.ts). */
const ProofFields = z.object({
  declaredAmountIqd: z.number({ error: "required" }).int("invalid").min(1, "too_small").max(1_000_000_000, "too_big"),
  note: z.string().trim().max(500, "too_long"),
  reference: z.string().trim().max(100, "too_long"),
});

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** A failure from a service (AppError) as an answer; anything unexpected is rethrown. */
function answerFor(error: unknown): ProofUploadOutcome {
  const appError = toAppError(error);
  if (!appError) throw error;
  return fail(appError.status, appError.code, {
    ...(appError.fields ? { fields: { ...appError.fields } } : {}),
    ...(appError.retryAfterSec !== undefined ? { retryAfterSec: appError.retryAfterSec } : {}),
  });
}

export async function handleProofUpload(deps: ProofUploadDeps, request: Request): Promise<ProofUploadOutcome> {
  const { db, store, customerId, ip, locale, now } = deps;

  // 1. Size and the per-IP limit, before reading anything.
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_PROOF_BODY_BYTES) return fail(413, "upload_too_large", { fields: { file: "upload_too_large" } });
  try {
    await enforceRateLimit(db, await limitKey("upload_proof", "ip", ip), RATE_LIMITS.upload, now);
  } catch (error) {
    return answerFor(error);
  }

  let form: FormData;
  try {
    // Counted while it is read: a body without a Content-Length is cut off at the limit, never read to its end.
    form = await readFormData(request, MAX_PROOF_BODY_BYTES);
  } catch (error) {
    if (isAppError(error, "upload_too_large")) return fail(413, "upload_too_large", { fields: { file: "upload_too_large" } });
    return fail(400, "invalid", { fields: { file: "upload_missing" } });
  }

  // 2. The fields.
  const ref = normalizeOrderRef(field(form, "ref"));
  const amountText = field(form, "declaredAmountIqd");
  // Digits as people type them (Arabic-Indic, separators); something that is not a whole number is "invalid", not "missing".
  const amount = amountText.trim() === "" ? undefined : parseAmountInput(amountText);
  const parsed = ProofFields.safeParse({ declaredAmountIqd: amount ?? undefined, note: field(form, "note"), reference: field(form, "reference") });
  if (!ref || amount === null || !parsed.success) {
    const fields: Record<string, string> = {};
    if (!ref) fields.ref = "invalid";
    if (amount === null) fields.declaredAmountIqd = "invalid";
    if (!parsed.success) for (const issue of parsed.error.issues) fields[String(issue.path[0])] ??= /^[a-z_]+$/.test(issue.message) ? issue.message : "invalid";
    return fail(400, "invalid", { fields });
  }

  // 3. Whose order: the customer's own, else the confirmation token. Someone else's order is "not found".
  const token = field(form, "t").trim() || null;
  const found = await findOrderForShopper(db, { ref, token, customerId, locale, now });
  if (!found) return fail(404, "not_found");
  try {
    await enforceRateLimit(db, await limitKey("upload_proof", "order", ref), RATE_LIMITS.upload, now);
  } catch (error) {
    return answerFor(error);
  }

  // 4. Is a proof expected now? (submitPaymentProof checks again; this keeps files out of storage when it is not.)
  const payment = found.order.payment;
  if (!payment.canUploadProof) {
    const closed = found.order.status === "awaiting_payment" && payment.dueAt !== null && now >= payment.dueAt;
    return fail(409, closed ? "payment_window_closed" : "proof_not_expected");
  }

  // 5. Store the picture privately.
  const actor: Actor = found.access === "customer" && customerId ? { kind: "customer", id: customerId, ip } : { kind: "guest", ip };
  let fileId: string;
  try {
    const saved = await saveImageUpload(db, store, form.get("file"), { visibility: "private", kind: "payment_proof", createdBy: actor, now });
    fileId = saved.file.id;
  } catch (error) {
    return answerFor(error);
  }

  // 6. Attach it to the payment. A refusal removes the stored picture again.
  try {
    await submitPaymentProof(
      db,
      { orderRef: ref, accessToken: found.access === "token" ? token : null, customerId: found.access === "customer" ? customerId : null, ip },
      { fileId, declaredAmountIqd: parsed.data.declaredAmountIqd, note: parsed.data.note || null, reference: parsed.data.reference || null },
      now,
    );
  } catch (error) {
    await deleteFile(db, store, fileId, now).catch(() => {});
    return answerFor(error);
  }
  // The answer never says whether this picture or reference was seen before (duplicateOf is for staff).
  if (!deps.previewPath) return { status: 200, body: { ok: true } };
  return { status: 200, body: { ok: true, previewUrl: deps.previewPath(fileId, found.access === "token" ? token : null) } };
}
