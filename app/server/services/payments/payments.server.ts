/**
 * Payments (docs/CONTRACTS.md §1, brief §4, ARCHITECTURE §7.6) — how money for an order arrives.
 *
 *   const instructions = await getPaymentInstructions(db, ctx.locale);          // from settings, never hard-coded
 *   await submitPaymentProof(db, { orderRef, accessToken }, { fileId, declaredAmountIqd, note }, ctx.now);
 *   await verifyPayment(db, actor, paymentId, { approve: true }, ctx.now);
 *   await recordCodCollection(db, actor, orderId, 754_000, ctx.now);
 *
 * MANUAL TRANSFERS (bank card / Mastercard, Zain Cash) ARE NEVER PAID AUTOMATICALLY
 *   placeOrder        order awaiting_payment, payment row `pending`, stock held until payment_due_at
 *   submitPaymentProof (the shopper) a stored PRIVATE image (files.kind "payment_proof", uploaded by
 *                     POST /api/upload/proof with no owner or owner ("order", <order id>)) + the
 *                     amount they say they sent (+ note, + reference), before payment_due_at.
 *                     → proof `submitted`, payment `pending_verification`, order `payment_review`,
 *                     stock held while staff review it (the reservation no longer expires). The file
 *                     is re-owned by the proof (owner_type "payment_proof", owner_id = proof id), so
 *                     the private-file route can authorize it (payment_proof.read, or the order's shopper).
 *                     The shopper sees it again at GET /api/files/:fileId (getPaymentProofFileForShopper:
 *                     the order's signed-in owner, or its confirmation token as `?t=`); latestProofFileId
 *                     tells the order page which file that is after a reload.
 *                     A proof whose image (sha256) or reference was seen before is accepted but
 *                     FLAGGED (`duplicate_of`) for the reviewer. Nothing here ever marks a payment paid.
 *   verifyPayment     (an EMPLOYEE with orders.payment.verify — a person, never a job)
 *       approve       the proof's declared amount AND the amount that arrived (`receivedAmountIqd`,
 *                     default: the declared amount) must both equal the amount due; any difference —
 *                     including a verifier typing the due amount as "received" for a proof that
 *                     declares something else — needs orders.payment.override and a written reason.
 *                     → payment `paid` with verified_by / verified_at (the database refuses `paid`
 *                     without them), order `confirmed` + paid_iqd, journal entry (Dr bank clearing,
 *                     Cr customer control; an accepted difference goes to cash over/short).
 *       reject        a reason is required → proof and payment `rejected`, order back to
 *                     awaiting_payment with a fresh upload window (checkout.transfer_proof_hours) so
 *                     the shopper can send a corrected proof ("replaces a rejected proof": the new
 *                     proof is a new row; the rejected one stays as history).
 *       Repeating the same decision is a no-op; two reviewers deciding at once cannot both apply.
 *
 * CASH ON DELIVERY
 *   recordCodCollection (orders.payment.record) once the order is shipped or delivered: payment
 *   `paid`, order paid_iqd, journal entry (Dr cash, Cr customer control). A different amount needs
 *   orders.payment.override and a reason.
 *
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex, timingSafeEqual } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { files, orderEvents, orders, paymentProofs, payments, stockReservations, type Order, type Payment } from "~/server/db/schema";
import { expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { getSetting, getSettings } from "~/server/settings.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { getFile, type BlobStore, type StoredFile } from "~/server/storage.server";
import { mapPostingError, postCodCollected, postTransferVerified, postedBy } from "../accounting/post.server";
import { assignOrderCodesStatements } from "../orders/digital.server";
import { normalizeOrderRef } from "../orders/manage.server";

/** Error keys this module produces (besides invalid / forbidden / not_found and the field keys). */
export const PAYMENT_ERROR_KEYS = [
  "proof_not_expected",
  "payment_window_closed",
  "proof_file_invalid",
  "proof_missing",
  "payment_not_pending",
  "payment_not_transfer",
  "payment_not_cod",
  "cod_not_collectable",
  "payment_already_recorded",
  "amount_mismatch",
  "override_reason_required",
  "period_closed",
] as const;

const HOUR_MS = 60 * 60 * 1000;
const TRANSFER_METHODS = ["bank_transfer", "zaincash"] as const;

/**
 * The order's payment state once the money that completes it arrives: "paid" — or "partially_refunded" when part of what
 * it was paid earlier (a split order's wallet part) was already refunded (review 2026-11-12).
 */
const paidStatusSql = sql<"paid" | "partially_refunded">`CASE WHEN ${orders.refundedIqd} > 0 THEN 'partially_refunded' ELSE 'paid' END`;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const isTransfer = (method: string | null | undefined): method is (typeof TRANSFER_METHODS)[number] => method === "bank_transfer" || method === "zaincash";

// ───────────────────────────────────────────────────────────────── instructions

export type PaymentInstructions = {
  cod: { enabled: boolean };
  wallet: { enabled: boolean };
  /** Card / Mastercard transfer: the card or account number and the recipient's name, exactly as stored in settings. */
  bankTransfer: { enabled: boolean; accountNumber: string; recipientName: string };
  /** Zain Cash: the store's number (07XXXXXXXXX). */
  zaincash: { enabled: boolean; number: string };
};

/**
 * Which payment methods are on and where manual transfers go — read from settings on every call
 * (an owner's change applies at once). `locale` is accepted for the contract; the values are not
 * translated (they are numbers and a name).
 */
export async function getPaymentInstructions(db: Db, locale?: Locale): Promise<PaymentInstructions> {
  void locale;
  const values = await getSettings(db, ["payments.cod", "payments.wallet", "payments.bank_transfer", "payments.zaincash"]);
  const bank = values["payments.bank_transfer"];
  const zain = values["payments.zaincash"];
  return {
    cod: { enabled: values["payments.cod"].enabled },
    wallet: { enabled: values["payments.wallet"].enabled },
    bankTransfer: { enabled: bank.enabled, accountNumber: bank.account_number, recipientName: bank.recipient_name },
    zaincash: { enabled: zain.enabled, number: zain.number },
  };
}

// ───────────────────────────────────────────────────────────────── proofs (the shopper)

export const SubmitProofInput = z.object({
  /** A private `files` row of kind "payment_proof" (stored by POST /api/upload/proof). */
  fileId: idSchema,
  /** What the shopper says they transferred, in IQD. */
  declaredAmountIqd: z.number().int("invalid").min(1, "too_small").max(1_000_000_000, "too_big"),
  note: z
    .string()
    .overwrite(cleanBlock)
    .trim()
    .max(500, "too_long")
    .nullish()
    .transform((value) => value || null),
  /** The transfer's reference number, when the shopper has one (used to flag duplicates). */
  reference: z
    .string()
    .overwrite(cleanLine)
    .trim()
    .max(100, "too_long")
    .nullish()
    .transform((value) => value || null),
});
export type SubmitProofInput = z.input<typeof SubmitProofInput>;

/** Who submits: the confirmation link's token (guests) or the signed-in customer who owns the order. */
export type ProofSubmitter = { orderRef: string; accessToken?: string | null; customerId?: string | null; ip?: string | null };

async function orderForShopper(db: Db, who: ProofSubmitter): Promise<Order> {
  const ref = normalizeOrderRef(who?.orderRef);
  const order = ref ? await db.select().from(orders).where(eq(orders.ref, ref)).get() : undefined;
  if (!order) throw notFound("order");
  const byCustomer = Boolean(who.customerId) && order.customerId === who.customerId;
  let byToken = false;
  if (!byCustomer && typeof who.accessToken === "string" && who.accessToken.length >= 32 && order.accessTokenHash) {
    byToken = timingSafeEqual(order.accessTokenHash, await sha256Hex(who.accessToken));
  }
  // Someone else's order looks exactly like an order that does not exist.
  if (!byCustomer && !byToken) throw notFound("order");
  return order;
}

/**
 * Attaches a transfer proof to the order's payment (file header). Throws AppError: invalid (400),
 * not_found (404 — also for an order the caller may not see), proof_not_expected ·
 * payment_window_closed · proof_file_invalid (409).
 */
export async function submitPaymentProof(db: Db, who: ProofSubmitter, raw: SubmitProofInput, now: number): Promise<{ proofId: string; duplicateOf: string | null }> {
  const input = SubmitProofInput.parse(raw);
  const order = await orderForShopper(db, who);
  if (order.status !== "awaiting_payment" || !isTransfer(order.paymentMethod)) throw new AppError("proof_not_expected", 409, { detail: order.status });
  if (order.paymentDueAt !== null && now >= order.paymentDueAt) throw new AppError("payment_window_closed", 409, { detail: order.ref });

  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), inArray(payments.method, [...TRANSFER_METHODS]), inArray(payments.status, ["pending", "rejected"])))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .get();
  if (!payment) throw new AppError("proof_not_expected", 409, { detail: order.ref });

  const file = await db.select().from(files).where(eq(files.id, input.fileId)).get();
  const fileOk =
    file !== undefined &&
    file.deletedAt === null &&
    file.visibility === "private" &&
    file.kind === "payment_proof" &&
    file.mime.startsWith("image/") &&
    (file.ownerType === null || (file.ownerType === "order" && file.ownerId === order.id) || (file.ownerType === "payment" && file.ownerId === payment.id));
  if (!fileOk || !file) throw new AppError("proof_file_invalid", 409, { fields: { fileId: "proof_file_invalid" }, detail: input.fileId });
  const reused = await db.select({ id: paymentProofs.id }).from(paymentProofs).where(eq(paymentProofs.fileId, file.id)).get();
  if (reused) throw new AppError("proof_file_invalid", 409, { fields: { fileId: "proof_file_invalid" }, detail: `${file.id} already used` });

  // Flag (never refuse) a picture or reference seen before: the reviewer decides.
  const seen = await db
    .select({ id: paymentProofs.id })
    .from(paymentProofs)
    .where(input.reference ? or(eq(paymentProofs.sha256, file.sha256), and(isNotNull(paymentProofs.reference), eq(paymentProofs.reference, input.reference))) : eq(paymentProofs.sha256, file.sha256))
    .orderBy(paymentProofs.createdAt, paymentProofs.id)
    .get();
  const duplicateOf = seen?.id ?? null;

  const proofId = newId("prf");
  const actor: Actor = order.customerId && who.customerId === order.customerId ? { kind: "customer", id: order.customerId, ip: who.ip ?? null } : { kind: "guest", ip: who.ip ?? null };
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [
    db.insert(paymentProofs).values({
      id: proofId,
      paymentId: payment.id,
      fileId: file.id,
      declaredAmountIqd: input.declaredAmountIqd,
      note: input.note,
      status: "submitted",
      duplicateOf,
      sha256: file.sha256,
      reference: input.reference,
      createdAt: now,
    }),
    db
      .update(payments)
      .set({ status: "pending_verification", declaredAmountIqd: input.declaredAmountIqd, reference: input.reference ?? payment.reference, updatedAt: now })
      .where(and(eq(payments.id, payment.id), inArray(payments.status, ["pending", "rejected"]))),
    expectChanged(db, 1, { code: "PAYMENT_CHANGED", detail: payment.id }),
    db
      .update(orders)
      .set({ status: "payment_review", paymentStatus: "pending_verification", updatedAt: now })
      .where(and(eq(orders.id, order.id), eq(orders.status, "awaiting_payment"))),
    expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
    // The stock stays held while the proof is reviewed (a rejection opens a new window).
    db
      .update(stockReservations)
      .set({ expiresAt: null })
      .where(and(eq(stockReservations.orderId, order.id), eq(stockReservations.status, "active"))),
    db
      .update(files)
      .set({ ownerType: "payment_proof", ownerId: proofId })
      .where(eq(files.id, file.id)),
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "proof_submitted", data: { paymentId: payment.id, proofId, declaredAmountIqd: input.declaredAmountIqd, duplicateOf }, actorKind, actorId, at: now }),
    auditStatement(db, {
      actor,
      action: "orders.payment.proof_submit",
      entityType: "payment",
      entityId: payment.id,
      after: { orderRef: order.ref, proofId, declaredAmountIqd: input.declaredAmountIqd, duplicateOf, hasReference: input.reference !== null },
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "PAYMENT_CHANGED") || isDbError(error, "ORDER_CHANGED")) throw new AppError("proof_not_expected", 409, { detail: order.ref, cause: error });
    throw error;
  }
  return { proofId, duplicateOf };
}

// ───────────────────────────────────────────────────────────────── proofs shown back to the shopper

/** Who may see a stored transfer proof again: the signed-in customer who owns the order, or the confirmation link's token. */
export type ProofViewer = { accessToken?: string | null; customerId?: string | null };

const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

/**
 * The picture of a transfer proof, for the shopper of its order only (GET /api/files/:fileId shows it back after a
 * reload): the file must be a live, private `payment_proof` attached to a proof of an order that `who.customerId` owns
 * or whose confirmation token is `who.accessToken` (compared as hashes, in constant time). Null for everything else —
 * an unknown id, another kind of file, a file not attached to a proof, someone else's order, a wrong or missing token —
 * so the caller answers one 404 whatever the reason. Staff use the admin's own viewer (payment_proof.read). Returns the
 * file only: never the duplicate flag, never a public URL.
 */
export async function getPaymentProofFileForShopper(db: Db, store: BlobStore, fileId: unknown, who: ProofViewer): Promise<StoredFile | null> {
  if (typeof fileId !== "string" || !ID_PATTERN.test(fileId)) return null;
  const row = await db
    .select({ customerId: orders.customerId, accessTokenHash: orders.accessTokenHash })
    .from(paymentProofs)
    .innerJoin(files, eq(files.id, paymentProofs.fileId))
    .innerJoin(payments, eq(payments.id, paymentProofs.paymentId))
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .where(and(eq(paymentProofs.fileId, fileId), eq(files.kind, "payment_proof"), eq(files.visibility, "private"), isNull(files.deletedAt)))
    .get();
  if (!row) return null;
  const byCustomer = typeof who?.customerId === "string" && who.customerId !== "" && row.customerId === who.customerId;
  let byToken = false;
  if (!byCustomer && typeof who?.accessToken === "string" && ACCESS_TOKEN_PATTERN.test(who.accessToken) && row.accessTokenHash) {
    byToken = timingSafeEqual(row.accessTokenHash, await sha256Hex(who.accessToken));
  }
  if (!byCustomer && !byToken) return null;
  return getFile(db, store, fileId);
}

/**
 * The file id of an order's latest transfer proof (null when it has none), so the order page can show the picture again
 * after a reload — as `shopperFilePath(fileId, token)` (~/server/storage.server), a URL the file route authorizes again
 * on every request. It does not check who asks: call it only for an order already opened for this shopper
 * (the confirmation token or the owner's session).
 */
export async function latestProofFileId(db: Db, orderRef: string): Promise<string | null> {
  const ref = normalizeOrderRef(orderRef);
  if (!ref) return null;
  const row = await db
    .select({ fileId: paymentProofs.fileId })
    .from(paymentProofs)
    .innerJoin(payments, eq(payments.id, paymentProofs.paymentId))
    .innerJoin(orders, eq(orders.id, payments.orderId))
    .innerJoin(files, eq(files.id, paymentProofs.fileId))
    .where(and(eq(orders.ref, ref), isNull(files.deletedAt)))
    .orderBy(desc(paymentProofs.createdAt), desc(paymentProofs.id))
    .get();
  return row?.fileId ?? null;
}

// ───────────────────────────────────────────────────────────────── verification (staff)

export const VerifyPaymentInput = z.object({
  approve: z.boolean(),
  /** Reject: why (shown to the shopper). Approve with an amount difference: the override reason. */
  note: z
    .string()
    .trim()
    .max(500, "too_long")
    .nullish()
    .transform((value) => value || ""),
  /** What actually arrived, checked against the bank / Zain Cash statement. Default: the proof's declared amount. */
  receivedAmountIqd: z.number().int("invalid").min(1, "too_small").max(1_000_000_000, "too_big").optional(),
});
export type VerifyPaymentInput = z.input<typeof VerifyPaymentInput>;

/**
 * Approves or rejects the submitted proof of a transfer payment (file header). Throws AppError:
 * forbidden (403: no orders.payment.verify, or an actor who is not an employee), amount_mismatch
 * (403: the amounts differ and the verifier lacks orders.payment.override), invalid (400: reason
 * missing), not_found (404), payment_not_transfer · payment_not_pending · proof_missing ·
 * period_closed (409). Returns `replayed: true` when the same decision was already made.
 */
export async function verifyPayment(db: Db, actor: Actor, paymentId: string, raw: VerifyPaymentInput, now: number): Promise<{ status: "paid" | "rejected"; override: boolean; replayed: boolean }> {
  assertCan(actor, "orders.payment.verify");
  // A transfer is approved by a person: the verifier's id is what the database requires.
  if (actor.kind !== "employee") throw forbidden("orders.payment.verify");
  const input = VerifyPaymentInput.parse(raw);

  const payment = await db.select().from(payments).where(eq(payments.id, paymentId)).get();
  if (!payment) throw notFound("payment");
  if (!isTransfer(payment.method)) throw new AppError("payment_not_transfer", 409, { detail: payment.method });
  if (payment.status === "paid" && input.approve) return { status: "paid", override: false, replayed: true };
  if (payment.status === "rejected" && !input.approve) return { status: "rejected", override: false, replayed: true };
  if (payment.status !== "pending_verification") throw new AppError("payment_not_pending", 409, { detail: payment.status });

  const order = await db.select().from(orders).where(eq(orders.id, payment.orderId)).get();
  if (!order) throw notFound("order");
  if (order.status !== "payment_review") throw new AppError("payment_not_pending", 409, { detail: `order ${order.status}` });
  const proof = await db
    .select()
    .from(paymentProofs)
    .where(and(eq(paymentProofs.paymentId, payment.id), eq(paymentProofs.status, "submitted")))
    .orderBy(desc(paymentProofs.createdAt), desc(paymentProofs.id))
    .get();
  if (!proof) throw new AppError("proof_missing", 409, { detail: payment.id });

  const { actorKind, actorId } = actorRef(actor);
  const guards = (paymentStatus: Payment["status"]): BatchStatement[] => [
    db
      .update(paymentProofs)
      .set({ status: paymentStatus === "paid" ? "approved" : "rejected", reviewedBy: actor.id, reviewedAt: now, reviewNote: input.note || null })
      .where(and(eq(paymentProofs.id, proof.id), eq(paymentProofs.status, "submitted"))),
    expectChanged(db, 1, { code: "PAYMENT_CHANGED", detail: proof.id }),
  ];

  let statements: BatchStatement[];
  let override = false;
  if (input.approve) {
    const due = payment.amountIqd;
    const declared = proof.declaredAmountIqd;
    const received = input.receivedAmountIqd ?? declared;
    // Both must be what is due: what the shopper says they sent (the proof) and what arrived (the
    // statement). Typing the due amount as "received" does not make a proof that declares another
    // amount approvable — any difference is an override (permission + written reason, audited).
    override = received !== due || declared !== due;
    if (override) {
      const detail = `declared ${declared}, received ${received}, due ${due}`;
      if (!can(actor, "orders.payment.override")) throw new AppError("amount_mismatch", 403, { fields: { receivedAmountIqd: "amount_mismatch" }, detail });
      if (input.note.length < 3) throw invalid({ note: "override_reason_required" }, detail);
    }
    // Two events at the same instant: ids that sort in the order they happened (the timeline reads by at, id).
    const eventId = newId("oev");
    statements = [
      db
        .update(payments)
        .set({ status: "paid", amountIqd: received, verifiedBy: actor.id, verifiedAt: now, paidAt: now, rejectReason: null, updatedAt: now })
        .where(and(eq(payments.id, payment.id), eq(payments.status, "pending_verification"))),
      expectChanged(db, 1, { code: "PAYMENT_CHANGED", detail: payment.id }),
      ...guards("paid"),
      db
        .update(orders)
        .set({ status: "confirmed", paymentStatus: paidStatusSql, paidIqd: sql`${orders.paidIqd} + ${received}`, confirmedAt: sql`coalesce(${orders.confirmedAt}, ${now})`, updatedAt: now })
        .where(and(eq(orders.id, order.id), eq(orders.status, "payment_review"))),
      expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
      ...postTransferVerified(db, { paymentId: payment.id, orderId: order.id, ref: order.ref, method: payment.method as "bank_transfer" | "zaincash", receivedIqd: received, dueIqd: due, at: now, createdBy: actor.id, isDemo: order.isDemo }),
      db.insert(orderEvents).values({ id: `${eventId}.1`, orderId: order.id, kind: "payment_verified", data: { paymentId: payment.id, proofId: proof.id, amountIqd: received, override }, actorKind, actorId, at: now }),
      db.insert(orderEvents).values({ id: `${eventId}.2`, orderId: order.id, kind: "status_changed", data: { from: "payment_review", to: "confirmed", reason: null }, actorKind, actorId, at: now }),
      // the order is paid now: its digital lines get their codes in this batch (orders/digital.server)
      ...(await assignOrderCodesStatements(db, order, actor, now)),
      auditStatement(db, {
        actor,
        action: override ? "orders.payment.override" : "orders.payment.verify",
        entityType: "payment",
        entityId: payment.id,
        summary: `${order.ref}: transfer verified`,
        before: { status: payment.status, dueIqd: due, declaredAmountIqd: proof.declaredAmountIqd },
        after: { status: "paid", receivedIqd: received, proofId: proof.id, duplicateOf: proof.duplicateOf },
        reason: input.note || null,
        at: now,
      }),
    ];
  } else {
    if (input.note.length < 3) throw invalid({ note: "required" });
    const hours = await getSetting(db, "checkout.transfer_proof_hours");
    const dueAt = now + hours * HOUR_MS;
    statements = [
      db
        .update(payments)
        .set({ status: "rejected", rejectReason: input.note, updatedAt: now })
        .where(and(eq(payments.id, payment.id), eq(payments.status, "pending_verification"))),
      expectChanged(db, 1, { code: "PAYMENT_CHANGED", detail: payment.id }),
      ...guards("rejected"),
      db
        .update(orders)
        .set({ status: "awaiting_payment", paymentStatus: "rejected", paymentDueAt: dueAt, updatedAt: now })
        .where(and(eq(orders.id, order.id), eq(orders.status, "payment_review"))),
      expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
      // A new upload window; the stock stays held until it ends.
      db
        .update(stockReservations)
        .set({ expiresAt: dueAt })
        .where(and(eq(stockReservations.orderId, order.id), eq(stockReservations.status, "active"))),
      db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "payment_rejected", data: { paymentId: payment.id, proofId: proof.id, paymentDueAt: dueAt }, actorKind, actorId, at: now }),
      auditStatement(db, {
        actor,
        action: "orders.payment.reject",
        entityType: "payment",
        entityId: payment.id,
        summary: `${order.ref}: transfer proof rejected`,
        before: { status: payment.status },
        after: { status: "rejected", proofId: proof.id, paymentDueAt: dueAt },
        reason: input.note,
        at: now,
      }),
    ];
  }

  try {
    await runBatch(db, statements);
  } catch (error) {
    const posting = mapPostingError(error);
    if (posting) throw posting;
    if (isDbError(error, "PAYMENT_CHANGED") || isDbError(error, "ORDER_CHANGED")) {
      // Another reviewer decided first: the same decision is a no-op, a different one is refused.
      const current = await db.select({ status: payments.status }).from(payments).where(eq(payments.id, payment.id)).get();
      if (input.approve && current?.status === "paid") return { status: "paid", override: false, replayed: true };
      if (!input.approve && current?.status === "rejected") return { status: "rejected", override: false, replayed: true };
      throw new AppError("payment_not_pending", 409, { detail: current?.status ?? "missing", cause: error });
    }
    throw error;
  }
  return { status: input.approve ? "paid" : "rejected", override, replayed: false };
}

// ───────────────────────────────────────────────────────────────── cash on delivery

/**
 * Records the cash collected for a cash-on-delivery order (shipped or delivered). Idempotent: the
 * same amount recorded again is a no-op. Throws AppError: forbidden (403), invalid (400),
 * not_found (404), payment_not_cod · cod_not_collectable · payment_already_recorded ·
 * payment_not_pending · period_closed (409). A different amount than due needs
 * orders.payment.override and `opts.reason`.
 */
export async function recordCodCollection(db: Db, actor: Actor, orderId: string, amountIqd: number, now: number, opts: { reason?: string | null } = {}): Promise<{ paymentId: string; replayed: boolean }> {
  assertCan(actor, "orders.payment.record");
  const amount = z.number().int("invalid").min(1, "too_small").max(1_000_000_000, "too_big").safeParse(amountIqd);
  if (!amount.success) throw invalid({ amountIqd: amount.error.issues[0]?.message ?? "invalid" });
  const reason = typeof opts.reason === "string" ? opts.reason.trim() : "";

  const order = await db.select().from(orders).where(eq(orders.id, orderId)).get();
  if (!order) throw notFound("order");
  if (order.paymentMethod !== "cod") throw new AppError("payment_not_cod", 409, { detail: order.paymentMethod ?? "none" });
  const payment = await db
    .select()
    .from(payments)
    .where(and(eq(payments.orderId, order.id), eq(payments.method, "cod"), ne(payments.status, "cancelled")))
    .orderBy(desc(payments.createdAt), desc(payments.id))
    .get();
  if (!payment) throw new AppError("payment_not_pending", 409, { detail: "no cash-on-delivery payment" });
  if (payment.status === "paid") {
    if (payment.amountIqd === amount.data) return { paymentId: payment.id, replayed: true };
    throw new AppError("payment_already_recorded", 409, { detail: payment.id });
  }
  if (payment.status !== "pending") throw new AppError("payment_not_pending", 409, { detail: payment.status });
  if (order.status !== "shipped" && order.status !== "delivered") throw new AppError("cod_not_collectable", 409, { detail: order.status });

  const due = payment.amountIqd;
  const override = amount.data !== due;
  if (override) {
    if (!can(actor, "orders.payment.override")) throw new AppError("amount_mismatch", 403, { fields: { amountIqd: "amount_mismatch" }, detail: `collected ${amount.data}, due ${due}` });
    if (reason.length < 3) throw invalid({ reason: "override_reason_required" }, `collected ${amount.data}, due ${due}`);
  }
  const { actorKind, actorId } = actorRef(actor);
  const by = postedBy(actor);
  const statements: BatchStatement[] = [
    db
      .update(payments)
      .set({ status: "paid", amountIqd: amount.data, verifiedBy: by, verifiedAt: now, paidAt: now, updatedAt: now })
      .where(and(eq(payments.id, payment.id), eq(payments.status, "pending"))),
    expectChanged(db, 1, { code: "PAYMENT_CHANGED", detail: payment.id }),
    db
      .update(orders)
      .set({ paymentStatus: paidStatusSql, paidIqd: sql`${orders.paidIqd} + ${amount.data}`, updatedAt: now })
      .where(and(eq(orders.id, order.id), eq(orders.paymentStatus, "cod_due"))),
    expectChanged(db, 1, { code: "ORDER_CHANGED", detail: order.id }),
    ...postCodCollected(db, { paymentId: payment.id, orderId: order.id, ref: order.ref, receivedIqd: amount.data, dueIqd: due, at: now, createdBy: by, isDemo: order.isDemo }),
    db.insert(orderEvents).values({ id: newId("oev"), orderId: order.id, kind: "cod_collected", data: { paymentId: payment.id, amountIqd: amount.data, override }, actorKind, actorId, at: now }),
    // the order is paid now: its digital lines get their codes in this batch (orders/digital.server)
    ...(await assignOrderCodesStatements(db, order, actor, now)),
    auditStatement(db, {
      actor,
      action: override ? "orders.payment.override" : "orders.payment.record",
      entityType: "payment",
      entityId: payment.id,
      summary: `${order.ref}: cash on delivery collected`,
      before: { status: payment.status, dueIqd: due },
      after: { status: "paid", collectedIqd: amount.data },
      reason: reason || null,
      at: now,
    }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    const posting = mapPostingError(error);
    if (posting) throw posting;
    if (isDbError(error, "PAYMENT_CHANGED") || isDbError(error, "ORDER_CHANGED")) {
      const again = await db.select({ status: payments.status, amountIqd: payments.amountIqd }).from(payments).where(eq(payments.id, payment.id)).get();
      if (again?.status === "paid" && again.amountIqd === amount.data) return { paymentId: payment.id, replayed: true };
      throw new AppError("payment_already_recorded", 409, { detail: payment.id, cause: error });
    }
    throw error;
  }
  return { paymentId: payment.id, replayed: false };
}
