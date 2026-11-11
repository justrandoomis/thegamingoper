/**
 * Wallet top-up REQUESTS (brief §3.10, §4 B; schema `wallet_topups`). A customer sends money by bank-card transfer or
 * Zain Cash to the store's details from settings, uploads a photo of the transfer and says how much they sent. The
 * request stays `pending_verification` until an employee checks the proof in the admin — NOTHING HERE CREDITS THE
 * WALLET. Approval belongs to the admin (wallet_ledger row of kind 'topup' with idempotency key "topup:<id>", written
 * by `creditWallet` with refType "wallet_topup"); rejection writes `reject_reason`, which the customer sees.
 *
 *   const proof = await saveTopupProof(db, store, actor, form.get("file"), ctx.now);     // private file, kind wallet_topup_proof
 *   const { topup } = await requestWalletTopup(db, actor, { method, declaredAmountIqd, reference, fileId, idempotencyKey }, ctx.now);
 *   const pendingIqd = await getPendingTopupTotal(db, customerId);                        // <WalletBalance pendingIqd>
 *   const list = await listWalletTopups(db, customerId);
 *   await cancelWalletTopup(db, actor, topupId, ctx.now);                                 // only while pending
 *
 * The proof is stored PRIVATELY (never served by /media): only its owner can open it, through the account's proof
 * route, after `getTopupProofForCustomer` checked ownership. The proof's SHA-256 is stored with the request so staff
 * can spot a screenshot used twice — that flag is for staff only and is never shown to the customer.
 *
 * Errors (AppError): invalid (400, fields), unauthorized (401), topup_method_unavailable · topup_proof_invalid ·
 * topup_pending_limit · topup_not_pending · idempotency_mismatch · customer_unavailable (409), not_found (404),
 * rate_limited (429), upload_* (from ~/server/uploads.server).
 * Must not import "cloudflare:workers".
 */
import { and, asc, desc, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef } from "~/lib/ids";
import type { CustomerActor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { customers, files, walletTopups } from "~/server/db/schema";
import { expectChanged, expectThat, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, unauthorized } from "~/server/errors";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { cleanLine } from "~/server/text.server";
import { deleteFile, getFile, getFileRecord, type BlobStore, type StoredFile } from "~/server/storage.server";
import { saveImageUpload, type UploadSource } from "~/server/uploads.server";
import { getPaymentInstructions } from "~/server/services/payments/payments.server";
import { TOPUP_METHODS, type TopupDestinations, type TopupView } from "./types";

/** `files.kind` of a top-up proof. */
export const TOPUP_PROOF_KIND = "wallet_topup_proof";
/** Sanity bounds for one request (the store can still credit a different, verified amount). */
export const TOPUP_MIN_IQD = 1_000;
export const TOPUP_MAX_IQD = 10_000_000;
/** Requests waiting for review at the same time, per customer. */
export const MAX_PENDING_TOPUPS = 3;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Locale-less path where the owner can open their proof (the account's private proof route). */
export const topupProofPath = (fileId: string) => `/account/wallet/proof/${fileId}`;

function requireActor(actor: CustomerActor): string {
  if (actor?.kind !== "customer" || !actor.id) throw unauthorized();
  return actor.id;
}

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);
/** "150,000" / "١٥٠٬٠٠٠" / "150 000" → 150000; anything else stays as it is for zod to refuse. */
function amountOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const latin = value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  const digits = latin.replace(/[\s,٬،]/g, "");
  if (digits === "") return undefined;
  return /^\d{1,12}$/.test(digits) ? Number(digits) : value;
}

export const RequestTopupInput = z.object({
  method: z.preprocess(blank, z.enum(TOPUP_METHODS, { error: (issue) => (issue.input === undefined ? "required" : "invalid") })),
  declaredAmountIqd: z.preprocess(
    amountOf,
    z
      .number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") })
      .int("invalid")
      .min(TOPUP_MIN_IQD, "too_small")
      .max(TOPUP_MAX_IQD, "too_big"),
  ),
  reference: z.preprocess(blank, z.string().overwrite(cleanLine).trim().max(80, "too_long").optional()),
  fileId: z.preprocess(blank, z.string({ error: "topup_proof_invalid" }).regex(ID, "topup_proof_invalid")),
  idempotencyKey: z.preprocess(blank, z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid")),
});
export type RequestTopupInput = z.input<typeof RequestTopupInput>;

function toView(row: typeof walletTopups.$inferSelect): TopupView {
  return {
    id: row.id,
    ref: row.ref,
    method: row.method,
    declaredAmountIqd: row.declaredAmountIqd,
    amountIqd: row.amountIqd,
    reference: row.reference,
    status: row.status,
    rejectReason: row.status === "rejected" ? row.rejectReason : null,
    createdAt: row.createdAt,
    verifiedAt: row.verifiedAt,
    proofPath: row.proofFileId ? topupProofPath(row.proofFileId) : null,
  };
}

/** Where to send a top-up: the store's own details from settings (the same ones checkout shows). */
export async function getTopupDestinations(db: Db): Promise<TopupDestinations> {
  const instructions = await getPaymentInstructions(db);
  return { bankTransfer: instructions.bankTransfer, zaincash: instructions.zaincash };
}

/**
 * Stores the photo of a transfer for a top-up request: checked and cleaned by the upload pipeline (type by content,
 * size, metadata removed), saved PRIVATELY with the customer as owner. Rate-limited per IP (`actor.ip`, when the request
 * has one) and per customer: accounts cost nothing, so a per-account budget alone grew with every sign-up from the same
 * address (security review, second pass). A proof no request uses is deleted after a day (purgeUnusedTopupProofs).
 */
export async function saveTopupProof(db: Db, store: BlobStore, actor: CustomerActor, source: UploadSource, now: number): Promise<{ fileId: string; previewPath: string }> {
  const customerId = requireActor(actor);
  await enforceRateLimit(db, await limitKey("upload_topup", "ip", actor.ip ?? null), RATE_LIMITS.upload, now);
  await enforceRateLimit(db, await limitKey("upload", "customer", customerId), RATE_LIMITS.upload, now);
  const { file } = await saveImageUpload(db, store, source, { visibility: "private", kind: TOPUP_PROOF_KIND, ownerType: "customer", ownerId: customerId, createdBy: actor, now });
  return { fileId: file.id, previewPath: topupProofPath(file.id) };
}

/** A top-up proof for its owner only (null for anyone else, a deleted file or another kind of file). */
export async function getTopupProofForCustomer(db: Db, store: BlobStore, customerId: string, fileId: string): Promise<StoredFile | null> {
  if (!ID.test(customerId) || typeof fileId !== "string" || !ID.test(fileId)) return null;
  const record = await getFileRecord(db, fileId);
  if (!record || record.kind !== TOPUP_PROOF_KIND || record.visibility !== "private" || record.createdByKind !== "customer" || record.createdBy !== customerId) return null;
  return getFile(db, store, fileId);
}

/**
 * Files a top-up request (pending until a person approves it). Idempotent on `idempotencyKey`: a retry returns the
 * first request (`replayed: true`); the same key from another customer is `idempotency_mismatch`.
 */
export async function requestWalletTopup(db: Db, actor: CustomerActor, raw: RequestTopupInput, now: number): Promise<{ topup: TopupView; replayed: boolean }> {
  const customerId = requireActor(actor);
  const input = RequestTopupInput.parse(raw);

  const replay = async () => {
    const existing = await db.select().from(walletTopups).where(eq(walletTopups.idempotencyKey, input.idempotencyKey)).get();
    if (!existing) return null;
    if (existing.customerId !== customerId) throw new AppError("idempotency_mismatch", 409);
    return { topup: toView(existing), replayed: true };
  };
  const earlier = await replay();
  if (earlier) return earlier;

  const customer = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) throw notFound("customer");
  if (customer.status !== "active") throw new AppError("customer_unavailable", 409, { detail: customer.status });

  const destinations = await getTopupDestinations(db);
  const enabled = input.method === "bank_transfer" ? destinations.bankTransfer.enabled : destinations.zaincash.enabled;
  if (!enabled) throw new AppError("topup_method_unavailable", 409, { fields: { method: "topup_method_unavailable" } });

  const file = await db
    .select({ id: files.id, kind: files.kind, sha256: files.sha256, createdBy: files.createdBy, createdByKind: files.createdByKind, visibility: files.visibility })
    .from(files)
    .where(and(eq(files.id, input.fileId), isNull(files.deletedAt)))
    .get();
  if (!file || file.kind !== TOPUP_PROOF_KIND || file.visibility !== "private" || file.createdByKind !== "customer" || file.createdBy !== customerId) {
    throw new AppError("topup_proof_invalid", 409, { fields: { fileId: "topup_proof_invalid" } });
  }
  const usedBy = await db.select({ id: walletTopups.id }).from(walletTopups).where(eq(walletTopups.proofFileId, file.id)).get();
  if (usedBy) throw new AppError("topup_proof_invalid", 409, { fields: { fileId: "topup_proof_invalid" } });

  const id = newId("wtu");
  const ref = publicRef("TU");
  const row = {
    id,
    ref,
    customerId,
    method: input.method,
    amountIqd: input.declaredAmountIqd,
    declaredAmountIqd: input.declaredAmountIqd,
    reference: input.reference ?? null,
    proofFileId: file.id,
    sha256: file.sha256,
    status: "pending_verification" as const,
    idempotencyKey: input.idempotencyKey,
    createdAt: now,
  };
  try {
    await runBatch(db, [
      db.insert(walletTopups).values(row),
      // Two requests at the same moment cannot both slip under the limit, nor share one proof.
      expectThat(
        db,
        sql`(SELECT count(*) FROM ${walletTopups} WHERE ${walletTopups.customerId} = ${customerId} AND ${walletTopups.status} = 'pending_verification') <= ${MAX_PENDING_TOPUPS}`,
        "TOPUP_PENDING_LIMIT",
      ),
      expectThat(db, sql`(SELECT count(*) FROM ${walletTopups} WHERE ${walletTopups.proofFileId} = ${file.id}) = 1`, "TOPUP_PROOF_INVALID"),
      auditStatement(db, {
        actor,
        action: "customers.wallet.topup_request",
        entityType: "wallet_topup",
        entityId: id,
        after: { ref, method: input.method, declaredAmountIqd: input.declaredAmountIqd, reference: input.reference ?? null, proofFileId: file.id },
        at: now,
      }),
    ]);
  } catch (error) {
    const raced = await replay().catch(() => null);
    if (raced) return raced;
    throw error;
  }
  return { topup: toView({ ...row, verifiedBy: null, verifiedAt: null, rejectReason: null, walletLedgerId: null }), replayed: false };
}

/** The customer's top-up requests, newest first. */
export async function listWalletTopups(db: Db, customerId: string, limit = 10): Promise<TopupView[]> {
  const rows = await db
    .select()
    .from(walletTopups)
    .where(eq(walletTopups.customerId, customerId))
    .orderBy(desc(walletTopups.createdAt), desc(walletTopups.id))
    .limit(Math.min(Math.max(limit, 1), 50));
  return rows.map(toView);
}

/** Money sent and still under review — not spendable yet (`<WalletBalance pendingIqd>`). */
export async function getPendingTopupTotal(db: Db, customerId: string): Promise<number> {
  const row = await db
    .select({ total: sql<number>`coalesce(sum(${walletTopups.amountIqd}), 0)` })
    .from(walletTopups)
    .where(and(eq(walletTopups.customerId, customerId), eq(walletTopups.status, "pending_verification")))
    .get();
  return Number(row?.total ?? 0);
}

/** How long an uploaded top-up proof may wait for the request that uses it (the wallet page sends both within minutes). */
export const UNUSED_TOPUP_PROOF_MAX_AGE_SEC = 24 * 60 * 60;

/**
 * Deletes top-up proofs that no request uses, older than `maxAgeSec` (an upload whose request was never sent, or a
 * photo replaced before sending): bytes removed, row marked deleted — up to 200 per call. For the daily retention job
 * (app/server/jobs.server.ts). Before the second security pass nothing ever deleted them: up to 8 MB each, private, in
 * the file store for good. Returns how many were removed.
 */
export async function purgeUnusedTopupProofs(db: Db, store: BlobStore, now: number, maxAgeSec = UNUSED_TOPUP_PROOF_MAX_AGE_SEC): Promise<number> {
  const stale = await db
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        eq(files.kind, TOPUP_PROOF_KIND),
        isNull(files.deletedAt),
        lt(files.createdAt, now - maxAgeSec * 1000),
        notExists(db.select({ id: walletTopups.id }).from(walletTopups).where(eq(walletTopups.proofFileId, files.id))),
      ),
    )
    .orderBy(asc(files.createdAt))
    .limit(200);
  let removed = 0;
  for (const row of stale) if (await deleteFile(db, store, row.id, now)) removed++;
  return removed;
}

/** Withdraws a request that is still waiting for review. */
export async function cancelWalletTopup(db: Db, actor: CustomerActor, topupId: string, now: number): Promise<void> {
  const customerId = requireActor(actor);
  if (typeof topupId !== "string" || !ID.test(topupId)) throw invalid({ topupId: "invalid" });
  const mine = and(eq(walletTopups.id, topupId), eq(walletTopups.customerId, customerId));
  const existing = await db.select({ ref: walletTopups.ref, status: walletTopups.status }).from(walletTopups).where(mine).get();
  if (!existing) throw notFound("wallet_topup");
  if (existing.status !== "pending_verification") throw new AppError("topup_not_pending", 409);
  // Guarded: staff may decide at the same moment; then nothing changes and the customer is told it is no longer pending.
  await runBatch(db, [
    db.update(walletTopups).set({ status: "cancelled" }).where(and(mine, eq(walletTopups.status, "pending_verification"))),
    expectChanged(db, 1, "TOPUP_NOT_PENDING"),
    auditStatement(db, { actor, action: "customers.wallet.topup_cancel", entityType: "wallet_topup", entityId: topupId, before: { status: existing.status }, after: { status: "cancelled", ref: existing.ref }, at: now }),
  ]);
}
