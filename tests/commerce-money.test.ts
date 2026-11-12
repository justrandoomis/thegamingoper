/**
 * Commerce core, part 2 — money: manual transfers (proofs, duplicates, rejection and a corrected
 * proof, verification with the amount rule and the override), cash on delivery, the wallet ledger,
 * refunds (bounds, threshold and four eyes, restock vs scrap, serials released, wallet credits),
 * standard postings and closed periods, the scheduled jobs (unpaid transfer orders, audit seal,
 * retention, consistency findings, job_runs) and the error texts every code needs.
 * Real local D1 (tests/helpers/db.ts).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import accountMessages from "~/i18n/messages/account";
import errorMessages from "~/i18n/messages/errors";
import usedMessages from "~/i18n/messages/used";
import { serverT } from "~/i18n/i18n.server";
import { newId, randomToken } from "~/lib/ids";
import { LOCALE_CODES } from "~/lib/locales";
import { systemActor, type Actor } from "~/server/actor";
import {
  assistantMessages,
  assistantSessions,
  auditEvents,
  authEvents,
  consents,
  consistencyFindings,
  customerSegmentMembers,
  customerSessions,
  files,
  fiscalPeriods,
  jobRuns,
  journalEntries,
  journalLines,
  orderItemSerials,
  orderItems,
  orders,
  otpCodes,
  outbox,
  paymentProofs,
  payments,
  rateLimits,
  recommendationEvents,
  refunds,
  serials,
  stockLevels,
  stockMovements,
  stockReservations,
  supportTickets,
  tradeInEvents,
  tradeIns,
  walletLedger,
} from "~/server/db/schema";
import { JournalEntryError } from "~/server/db/journal.server";
import { DEFAULT_LOCATION_ID, accountId, districtId, governorateId } from "~/server/db/seed/reference";
import { TRIGGER_ERROR_CODES, runBatch } from "~/server/db/tx.server";
import { AppError, CORE_ERROR_KEYS, actionError, toAppError } from "~/server/errors";
import { CRON_DAILY, CRON_FREQUENT, RETENTION_DAYS, listJobRuns, listOpenFindings, runJob, runScheduledJobs } from "~/server/jobs.server";
import type { Permission } from "~/server/permissions";
import { setSetting } from "~/server/settings.server";
import { ACCOUNTING_ERROR_KEYS, journalStatements, mapPostingError, postSale } from "~/server/services/accounting/post.server";
import { CART_ERROR_KEYS, addToCart, getCartView } from "~/server/services/cart.server";
import { STOCK_ERROR_KEYS, assignSerialsStatements, receiveStock, reserveStatements } from "~/server/services/inventory/stock.server";
import { ORDER_ERROR_KEYS, getOrderByAccessToken, getOrderForCustomer, transitionOrder } from "~/server/services/orders/manage.server";
import { CHECKOUT_ERROR_KEYS, placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { RETURN_ERROR_KEYS } from "~/server/services/orders/returns.server";
import { PAYMENT_ERROR_KEYS, getPaymentInstructions, recordCodCollection, submitPaymentProof, verifyPayment } from "~/server/services/payments/payments.server";
import { REFUND_ERROR_KEYS, approveRefund, createRefund, getRefundableAmount } from "~/server/services/refunds.server";
import { SHIPPING_ERROR_KEYS } from "~/server/services/shipping/fees.server";
import { ACCOUNT_ERROR_KEYS } from "~/server/services/account/types";
import { TRADE_IN_ERROR_KEYS, addTradeInDraftPhoto } from "~/server/services/tradein.server";
import { kvBlobStore } from "~/server/storage.server";
import { WALLET_ERROR_KEYS, creditWallet, getWalletBalance, listWalletEntries, walletDebitStatement } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A 1×1 PNG: what a trade-in wizard's photo upload stores. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

let t: TestDb;
let make: Fixtures;
let verifierId: string;
let requesterId: string;
let approverId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  verifierId = await make.employee();
  requesterId = await make.employee();
  approverId = await make.employee();
});
afterAll(async () => {
  await t.dispose();
});

const OPS: Permission[] = ["orders.order.update", "orders.order.cancel", "orders.fulfillment.pack", "orders.fulfillment.ship", "orders.fulfillment.deliver", "orders.payment.record"];
const employee = (id: string, permissions: Permission[]): Actor => ({ kind: "employee", id, permissions: new Set(permissions) });
const verifier = (extra: Permission[] = []) => employee(verifierId, ["orders.payment.verify", ...extra]);
const ops = () => employee(verifierId, OPS);
const refunder = () => employee(requesterId, ["orders.refund.create", "orders.refund.approve"]);
const approver = () => employee(approverId, ["orders.refund.create", "orders.refund.approve"]);
const system = systemActor("test.money");

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

/** A stored private proof image (what POST /api/upload/proof leaves behind). */
async function proofFile(overrides: Partial<typeof files.$inferInsert> = {}): Promise<string> {
  const id = newId("fil");
  await t.db.insert(files).values({
    id,
    storageKey: `prv/${id}.jpg`,
    visibility: "private",
    kind: "payment_proof",
    mime: "image/jpeg",
    bytes: 48_213,
    sha256: randomToken().toLowerCase(),
    createdAt: NOW,
    ...overrides,
  });
  return id;
}

/** A costed, stocked product (stock received through the stock service, so movements and layers exist). */
async function stocked(priceIqd: number, qty: number, unitCostIqd: number, options: { trackSerials?: boolean } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials });
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `SN-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd, serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  return product;
}

async function placed(lines: { variantId: string; qty: number }[], method: CheckoutInput["paymentMethod"], options: { customerId?: string | null; at?: number } = {}) {
  const customerId = options.customerId ?? null;
  const at = options.at ?? NOW;
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId, locale: "en" }, line, at)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId, locale: "en", governorateId: governorateId("erbil") }, at);
  const body: CheckoutInput = {
    idempotencyKey: randomToken(),
    phone: make.phone(),
    governorateId: governorateId("erbil"),
    districtId: districtId("erbil", "erbil"),
    areaText: "عينكاوة",
    addressText: "شارع 100 متر، قرب مجمع الأحلام، بيت 12",
    marketingConsent: false,
    paymentMethod: method,
    expectedTotalIqd: view.totalIqd,
  };
  const result = await placeOrder(t.db, { cartToken: token, customer: customerId ? { id: customerId } : null, locale: "ar", ip: null, storeMode: "live" }, body, at);
  return { ...result, body, cartToken: token as string };
}

async function order(orderId: string) {
  return (await t.db.select().from(orders).where(eq(orders.id, orderId)).get())!;
}
async function paymentOf(orderId: string) {
  return (await t.db.select().from(payments).where(eq(payments.orderId, orderId)).get())!;
}
async function linesOfEntry(key: string) {
  return t.db
    .select({ account: journalLines.accountId, debit: journalLines.debitIqd, credit: journalLines.creditIqd })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(eq(journalEntries.idempotencyKey, key));
}
async function level(variantId: string) {
  return t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
}

// ───────────────────────────────────────────────────────────────── the transfer flow

describe("manual transfer, end to end", () => {
  test("place → proof → reject → new proof → verify → confirmed → shipped → delivered → partial refund to the wallet", async () => {
    const customerId = await make.customer();
    const consoleItem = await stocked(400_000, 3, 330_000);
    const pad = await stocked(100_000, 3, 70_000);
    const order0 = await placed(
      [
        { variantId: consoleItem.variantId, qty: 1 },
        { variantId: pad.variantId, qty: 2 },
      ],
      "bank_transfer",
      { customerId },
    );
    expect(order0.totalIqd).toBe(605_000);
    expect(await order(order0.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "unpaid", paidIqd: 0 });

    // 1. The shopper sends a proof. It is never "paid" by itself.
    const first = await submitPaymentProof(t.db, { orderRef: order0.ref, customerId }, { fileId: await proofFile(), declaredAmountIqd: 605_000, note: "حوالة من بطاقة ماستركارد", reference: "TRX-7781" }, NOW + HOUR);
    expect(first.duplicateOf).toBeNull();
    expect(await order(order0.orderId)).toMatchObject({ status: "payment_review", paymentStatus: "pending_verification", paidIqd: 0 });
    expect(await paymentOf(order0.orderId)).toMatchObject({ status: "pending_verification", declaredAmountIqd: 605_000, verifiedBy: null });
    expect((await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order0.orderId))).every((row) => row.status === "active" && row.expiresAt === null)).toBe(true);
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: order0.ref, customerId }, { fileId: await proofFile(), declaredAmountIqd: 605_000 }, NOW + HOUR))).toMatchObject({ code: "proof_not_expected" });

    // 2. Rejected, with a reason: back to awaiting payment with a fresh window, stock still held.
    const paymentId = (await paymentOf(order0.orderId)).id;
    expect((await failureOf(verifyPayment(t.db, verifier(), paymentId, { approve: false }, NOW + 2 * HOUR))).fields).toEqual({ note: "required" });
    await verifyPayment(t.db, verifier(), paymentId, { approve: false, note: "الصورة غير واضحة، أرسل لقطة أوضح" }, NOW + 2 * HOUR);
    expect(await order(order0.orderId)).toMatchObject({ status: "awaiting_payment", paymentStatus: "rejected", paymentDueAt: NOW + 2 * HOUR + 24 * HOUR });
    expect(await paymentOf(order0.orderId)).toMatchObject({ status: "rejected", rejectReason: "الصورة غير واضحة، أرسل لقطة أوضح" });
    expect((await t.db.select().from(paymentProofs).where(eq(paymentProofs.id, first.proofId)).get())).toMatchObject({ status: "rejected", reviewedBy: verifierId });
    expect((await t.db.select().from(stockReservations).where(eq(stockReservations.orderId, order0.orderId))).map((row) => row.expiresAt)).toEqual([NOW + 26 * HOUR, NOW + 26 * HOUR]);
    const rejectedView = await getOrderForCustomer(t.db, customerId, order0.ref, "ar", NOW + 3 * HOUR);
    expect(rejectedView?.payment).toMatchObject({ status: "rejected", canUploadProof: true, proof: { status: "rejected", rejectReason: "الصورة غير واضحة، أرسل لقطة أوضح" } });

    // 3. A corrected proof replaces it (the rejected one stays as history).
    const second = await submitPaymentProof(t.db, { orderRef: order0.ref, customerId }, { fileId: await proofFile(), declaredAmountIqd: 605_000 }, NOW + 3 * HOUR);
    expect(second.duplicateOf).toBeNull();
    expect(await t.db.select({ status: paymentProofs.status }).from(paymentProofs).where(inArray(paymentProofs.id, [first.proofId, second.proofId]))).toEqual(
      expect.arrayContaining([{ status: "rejected" }, { status: "submitted" }]),
    );

    // 4. Verified by a person: paid, confirmed, booked. Approving again changes nothing.
    expect(await failureOf(verifyPayment(t.db, employee(verifierId, ["orders.order.read"]), paymentId, { approve: true }, NOW + 4 * HOUR))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(verifyPayment(t.db, system, paymentId, { approve: true }, NOW + 4 * HOUR))).toMatchObject({ code: "forbidden" });
    expect(await verifyPayment(t.db, verifier(), paymentId, { approve: true }, NOW + 4 * HOUR)).toEqual({ status: "paid", override: false, replayed: false });
    expect(await verifyPayment(t.db, verifier(), paymentId, { approve: true }, NOW + 5 * HOUR)).toMatchObject({ status: "paid", replayed: true });
    expect(await paymentOf(order0.orderId)).toMatchObject({ status: "paid", amountIqd: 605_000, verifiedBy: verifierId, verifiedAt: NOW + 4 * HOUR, paidAt: NOW + 4 * HOUR });
    expect(await order(order0.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: 605_000, confirmedAt: NOW + 4 * HOUR });
    expect(await linesOfEntry(`payment:${paymentId}:received`)).toEqual(
      expect.arrayContaining([
        { account: accountId("bank_clearing"), debit: 605_000, credit: 0 },
        { account: accountId("cod_receivable"), debit: 0, credit: 605_000 },
      ]),
    );
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.refId, paymentId))).toHaveLength(1);

    // 5. Shipped and delivered: revenue and cost of goods are booked.
    await transitionOrder(t.db, ops(), order0.orderId, "shipped", {}, NOW + DAY);
    await transitionOrder(t.db, ops(), order0.orderId, "delivered", {}, NOW + 2 * DAY);
    expect(await linesOfEntry(`order:${order0.orderId}:cogs`)).toEqual(expect.arrayContaining([{ account: accountId("cogs"), debit: 330_000 + 2 * 70_000, credit: 0 }]));

    // 6. One pad comes back: a refund to the wallet, requested by one employee and issued by another.
    const padLine = (await t.db.select().from(orderItems).where(and(eq(orderItems.orderId, order0.orderId), eq(orderItems.variantId, pad.variantId))).get())!;
    expect(await getRefundableAmount(t.db, paymentId)).toBe(605_000);
    const request = await createRefund(
      t.db,
      refunder(),
      { orderId: order0.orderId, paymentId, items: [{ orderItemId: padLine.id, qty: 1, disposition: "restock" }], amountIqd: 100_000, method: "wallet", reason: "قطعة مرتجعة سليمة ضمن مدة الإرجاع" },
      NOW + 3 * DAY,
    );
    expect(request).toMatchObject({ status: "pending", replayed: false });
    expect(await getRefundableAmount(t.db, paymentId)).toBe(505_000);
    expect(await failureOf(approveRefund(t.db, refunder(), request.refundId, { approve: true }, NOW + 3 * DAY))).toMatchObject({ code: "approver_is_requester", status: 403 });
    expect(await approveRefund(t.db, approver(), request.refundId, { approve: true }, NOW + 3 * DAY)).toEqual({ status: "paid" });

    expect(await getWalletBalance(t.db, customerId)).toBe(100_000);
    expect(await t.db.select({ kind: walletLedger.kind, amount: walletLedger.amountIqd, refType: walletLedger.refType }).from(walletLedger).where(eq(walletLedger.customerId, customerId))).toEqual([{ kind: "refund", amount: 100_000, refType: "refund" }]);
    expect(await order(order0.orderId)).toMatchObject({ paymentStatus: "partially_refunded", refundedIqd: 100_000, paidIqd: 605_000 });
    expect((await t.db.select({ refunded: orderItems.refundedQty }).from(orderItems).where(eq(orderItems.id, padLine.id)).get())?.refunded).toBe(1);
    expect(await level(pad.variantId)).toMatchObject({ onHand: 2, reserved: 0 });
    expect(await linesOfEntry(`refund:${request.refundId}`)).toEqual(
      expect.arrayContaining([
        { account: accountId("sales_refunds"), debit: 100_000, credit: 0 },
        { account: accountId("wallet_liability"), debit: 0, credit: 100_000 },
      ]),
    );
    // The returned pad goes back to inventory at the cost it left with.
    expect(await linesOfEntry(`refund:${request.refundId}:goods`)).toEqual(
      expect.arrayContaining([
        { account: accountId("inventory"), debit: 70_000, credit: 0 },
        { account: accountId("cogs"), debit: 0, credit: 70_000 },
      ]),
    );

    // 7. The books balance, and the customer control account of this order nets to zero.
    const totals = await t.db.all<{ debit: number; credit: number }>(sql`SELECT sum(debit_iqd) AS debit, sum(credit_iqd) AS credit FROM journal_lines`);
    expect(Number(totals[0].debit)).toBe(Number(totals[0].credit));
    const control = await t.db.all<{ balance: number }>(sql`
      SELECT coalesce(sum(l.debit_iqd), 0) - coalesce(sum(l.credit_iqd), 0) AS balance FROM journal_lines AS l JOIN journal_entries AS e ON e.id = l.entry_id
      WHERE l.account_id = ${accountId("cod_receivable")} AND e.ref_id IN (${order0.orderId}, ${paymentId}, ${request.refundId})`);
    expect(Number(control[0].balance)).toBe(0);

    // 8. What the customer sees.
    const view = await getOrderForCustomer(t.db, customerId, order0.ref, "en", NOW + 3 * DAY);
    expect(view?.payment).toMatchObject({ status: "partially_refunded", amountDueIqd: 0, paidIqd: 605_000, refundedIqd: 100_000, canUploadProof: false, proof: { status: "approved" } });
    expect(view?.refunds).toEqual([{ amountIqd: 100_000, method: "wallet", status: "paid", at: NOW + 3 * DAY }]);
    expect(view?.timeline.map((entry) => entry.kind)).toEqual(["placed", "proof_submitted", "payment_rejected", "proof_submitted", "payment_verified", "confirmed", "shipped", "delivered", "refunded"]);
  });
});

describe("transfer proofs and verification rules", () => {
  test("only the shopper of the order may send a proof: confirmation token or the signed-in owner; others see not_found", async () => {
    const product = await stocked(50_000, 5, 30_000);
    const guestOrder = await placed([{ variantId: product.variantId, qty: 1 }], "zaincash");
    const stranger = await make.customer();
    const body = { fileId: await proofFile(), declaredAmountIqd: 55_000 };
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: guestOrder.ref }, body, NOW))).toMatchObject({ code: "not_found", status: 404 });
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: guestOrder.ref, accessToken: randomToken() }, body, NOW))).toMatchObject({ code: "not_found" });
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: guestOrder.ref, customerId: stranger }, body, NOW))).toMatchObject({ code: "not_found" });
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: "TT-NOPE2345", accessToken: guestOrder.accessToken }, body, NOW))).toMatchObject({ code: "not_found" });

    // The file must be a private payment-proof image that is not attached anywhere else.
    const publicFile = await proofFile({ visibility: "public", storageKey: `pub/${newId("x")}.jpg` });
    const wrongKind = await proofFile({ kind: "used_photo" });
    const otherOwner = await proofFile({ ownerType: "order", ownerId: "ord_someone_else" });
    for (const fileId of [publicFile, wrongKind, otherOwner, "fil_missing"]) {
      expect(await failureOf(submitPaymentProof(t.db, { orderRef: guestOrder.ref, accessToken: guestOrder.accessToken }, { fileId, declaredAmountIqd: 55_000 }, NOW))).toMatchObject({ code: "proof_file_invalid", fields: { fileId: "proof_file_invalid" } });
    }
    expect((await failureOf(submitPaymentProof(t.db, { orderRef: guestOrder.ref, accessToken: guestOrder.accessToken }, { fileId: body.fileId, declaredAmountIqd: 0 }, NOW))).fields).toEqual({ declaredAmountIqd: "too_small" });

    await submitPaymentProof(t.db, { orderRef: guestOrder.ref, accessToken: guestOrder.accessToken }, body, NOW);
    const proof = await t.db.select().from(paymentProofs).where(eq(paymentProofs.fileId, body.fileId)).get();
    expect(proof).toMatchObject({ status: "submitted", declaredAmountIqd: 55_000 });
    expect((await t.db.select({ ownerType: files.ownerType, ownerId: files.ownerId }).from(files).where(eq(files.id, body.fileId)).get())).toEqual({ ownerType: "payment_proof", ownerId: proof!.id });

    // Cash on delivery never waits for a proof; the window closes at payment_due_at.
    const cod = await placed([{ variantId: product.variantId, qty: 1 }], "cod");
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: cod.ref, accessToken: cod.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 55_000 }, NOW))).toMatchObject({ code: "proof_not_expected" });
    const late = await placed([{ variantId: product.variantId, qty: 1 }], "bank_transfer");
    expect(await failureOf(submitPaymentProof(t.db, { orderRef: late.ref, accessToken: late.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 55_000 }, NOW + 24 * HOUR))).toMatchObject({
      code: "payment_window_closed",
    });
  });

  test("a picture or reference seen before is accepted but flagged for the reviewer", async () => {
    const product = await stocked(40_000, 5, 25_000);
    const a = await placed([{ variantId: product.variantId, qty: 1 }], "bank_transfer");
    const b = await placed([{ variantId: product.variantId, qty: 1 }], "bank_transfer");
    const c = await placed([{ variantId: product.variantId, qty: 1 }], "zaincash");
    const sharedHash = "f".repeat(64);
    const original = await submitPaymentProof(t.db, { orderRef: a.ref, accessToken: a.accessToken }, { fileId: await proofFile({ sha256: sharedHash }), declaredAmountIqd: 45_000, reference: "ZC-55501" }, NOW);
    const sameImage = await submitPaymentProof(t.db, { orderRef: b.ref, accessToken: b.accessToken }, { fileId: await proofFile({ sha256: sharedHash }), declaredAmountIqd: 45_000 }, NOW);
    const sameReference = await submitPaymentProof(t.db, { orderRef: c.ref, accessToken: c.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 45_000, reference: "ZC-55501" }, NOW);
    expect(original.duplicateOf).toBeNull();
    expect(sameImage.duplicateOf).toBe(original.proofId);
    expect(sameReference.duplicateOf).toBe(original.proofId);
    expect((await order(b.orderId)).status).toBe("payment_review");
  });

  test("the amount that arrived must equal the amount due; a difference needs the override permission and a reason", async () => {
    const product = await stocked(300_000, 3, 200_000);
    const short = await placed([{ variantId: product.variantId, qty: 1 }], "bank_transfer");
    await submitPaymentProof(t.db, { orderRef: short.ref, accessToken: short.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 300_000 }, NOW);
    const paymentId = (await paymentOf(short.orderId)).id;

    expect(await failureOf(verifyPayment(t.db, verifier(), paymentId, { approve: true }, NOW))).toMatchObject({ code: "amount_mismatch", status: 403 });
    expect((await failureOf(verifyPayment(t.db, verifier(["orders.payment.override"]), paymentId, { approve: true }, NOW))).fields).toEqual({ note: "override_reason_required" });
    // The verifier found 300,000 on the statement, not 305,000; the owner accepts the shortfall.
    expect(await verifyPayment(t.db, verifier(["orders.payment.override"]), paymentId, { approve: true, note: "رسوم التحويل خصمها البنك، قبلنا النقص" }, NOW)).toMatchObject({ status: "paid", override: true });
    expect(await paymentOf(short.orderId)).toMatchObject({ status: "paid", amountIqd: 300_000 });
    expect(await order(short.orderId)).toMatchObject({ status: "confirmed", paymentStatus: "paid", paidIqd: 300_000 });
    expect(await linesOfEntry(`payment:${paymentId}:received`)).toEqual(
      expect.arrayContaining([
        { account: accountId("bank_clearing"), debit: 300_000, credit: 0 },
        { account: accountId("cash_over_short"), debit: 5_000, credit: 0 },
        { account: accountId("cod_receivable"), debit: 0, credit: 305_000 },
      ]),
    );
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, paymentId), eq(auditEvents.action, "orders.payment.override")))).toHaveLength(1);
    // Nothing more is owed, and a refund can never exceed what arrived.
    expect((await getOrderByAccessToken(t.db, short.ref, short.accessToken, "en", NOW))?.payment).toMatchObject({ status: "paid", amountDueIqd: 0, paidIqd: 300_000 });
    expect(await getRefundableAmount(t.db, paymentId)).toBe(300_000);
  });
});

describe("cash on delivery", () => {
  test("collected once the parcel has left; the same amount again is a no-op; a different amount needs the override", async () => {
    const product = await stocked(150_000, 5, 100_000);
    const cod = await placed([{ variantId: product.variantId, qty: 1 }], "cod");
    expect(await failureOf(recordCodCollection(t.db, ops(), cod.orderId, 155_000, NOW))).toMatchObject({ code: "cod_not_collectable" });
    await transitionOrder(t.db, ops(), cod.orderId, "confirmed", {}, NOW);
    await transitionOrder(t.db, ops(), cod.orderId, "shipped", {}, NOW);
    expect(await failureOf(recordCodCollection(t.db, employee(verifierId, ["orders.order.read"]), cod.orderId, 155_000, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(recordCodCollection(t.db, ops(), cod.orderId, 150_000, NOW))).toMatchObject({ code: "amount_mismatch", status: 403 });

    const first = await recordCodCollection(t.db, ops(), cod.orderId, 155_000, NOW + HOUR);
    expect(first.replayed).toBe(false);
    expect((await recordCodCollection(t.db, ops(), cod.orderId, 155_000, NOW + 2 * HOUR)).replayed).toBe(true);
    expect(await failureOf(recordCodCollection(t.db, ops(), cod.orderId, 150_000, NOW + 2 * HOUR))).toMatchObject({ code: "payment_already_recorded" });
    expect(await paymentOf(cod.orderId)).toMatchObject({ status: "paid", amountIqd: 155_000, verifiedBy: verifierId, paidAt: NOW + HOUR });
    expect(await order(cod.orderId)).toMatchObject({ paymentStatus: "paid", paidIqd: 155_000, status: "shipped" });
    expect(await linesOfEntry(`payment:${first.paymentId}:received`)).toEqual(
      expect.arrayContaining([
        { account: accountId("cash"), debit: 155_000, credit: 0 },
        { account: accountId("cod_receivable"), debit: 0, credit: 155_000 },
      ]),
    );

    const walletBuyer = await make.customer();
    await creditWallet(t.db, employee(verifierId, ["customers.wallet.adjust"]), { customerId: walletBuyer, amountIqd: 200_000, kind: "topup", reason: "شحن نقدي في المتجر", idempotencyKey: randomToken(), fundedBy: "cash" }, NOW);
    const prepaid = await placed([{ variantId: product.variantId, qty: 1 }], "wallet", { customerId: walletBuyer });
    expect(await failureOf(recordCodCollection(t.db, ops(), prepaid.orderId, 155_000, NOW))).toMatchObject({ code: "payment_not_cod" });
  });

  test("payment instructions come from settings", async () => {
    expect(await getPaymentInstructions(t.db, "ar")).toEqual({
      cod: { enabled: true },
      wallet: { enabled: true },
      bankTransfer: { enabled: true, accountNumber: "9269317427", recipientName: "علي خليفة" },
      zaincash: { enabled: true, number: "07719061852" },
    });
    await setSetting(t.db, system, "payments.bank_transfer", { enabled: true, account_number: "1234 5678 9012", recipient_name: "متجر طمطم" }, "حساب جديد للمتجر", NOW);
    try {
      expect((await getPaymentInstructions(t.db, "en")).bankTransfer).toEqual({ enabled: true, accountNumber: "123456789012", recipientName: "متجر طمطم" });
    } finally {
      await setSetting(t.db, system, "payments.bank_transfer", { enabled: true, account_number: "9269317427", recipient_name: "علي خليفة" }, "إعادة الحساب الأصلي", NOW);
    }
  });
});

// ───────────────────────────────────────────────────────────────── wallet

describe("wallet", () => {
  test("the balance is the sum of the ledger; credits are permissioned, idempotent and booked; guests have no wallet", async () => {
    const customerId = await make.customer();
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    const key = randomToken();
    const adjuster = employee(verifierId, ["customers.wallet.adjust"]);
    const first = await creditWallet(t.db, adjuster, { customerId, amountIqd: 75_000, kind: "topup", reason: "حوالة زين كاش مؤكدة", idempotencyKey: key, fundedBy: "bank_clearing" }, NOW);
    expect(first.replayed).toBe(false);
    expect(await creditWallet(t.db, adjuster, { customerId, amountIqd: 75_000, kind: "topup", reason: "حوالة زين كاش مؤكدة", idempotencyKey: key }, NOW)).toEqual({ entryId: first.entryId, replayed: true });
    expect(await failureOf(creditWallet(t.db, adjuster, { customerId, amountIqd: 80_000, kind: "topup", reason: "حوالة زين كاش مؤكدة", idempotencyKey: key }, NOW))).toMatchObject({ code: "idempotency_mismatch" });
    expect(await failureOf(creditWallet(t.db, adjuster, { customerId, amountIqd: 50_000, kind: "trade_in_credit", reason: "مقايضة جهاز", idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(creditWallet(t.db, { kind: "customer", id: customerId }, { customerId, amountIqd: 50_000, kind: "topup", reason: "أضف لي رصيداً", idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "forbidden" });
    await creditWallet(t.db, employee(verifierId, ["devices.tradein.payout"]), { customerId, amountIqd: 50_000, kind: "trade_in_credit", refType: "trade_in", refId: "trd_1", reason: "مقايضة جهاز مفحوص", idempotencyKey: randomToken() }, NOW + 1);
    expect(await getWalletBalance(t.db, customerId)).toBe(125_000);
    expect(await linesOfEntry(`wallet:${first.entryId}`)).toEqual(
      expect.arrayContaining([
        { account: accountId("bank_clearing"), debit: 75_000, credit: 0 },
        { account: accountId("wallet_liability"), debit: 0, credit: 75_000 },
      ]),
    );

    // A debit that would overdraw is refused by the database trigger, whatever calls it.
    const overdraft = await failureOf(runBatch(t.db, [walletDebitStatement(t.db, { customerId, amountIqd: 125_001, refType: "test", refId: null, idempotencyKey: randomToken(), actor: system, now: NOW })]));
    expect(overdraft).toMatchObject({ code: "wallet_overdraft", detail: customerId });
    expect(await getWalletBalance(t.db, customerId)).toBe(125_000);
  });

  test("the wallet history is paged newest first and links purchases and refunds to the order", async () => {
    const customerId = await make.customer();
    await creditWallet(t.db, employee(verifierId, ["customers.wallet.adjust"]), { customerId, amountIqd: 200_000, kind: "topup", reason: "شحن في المتجر", idempotencyKey: randomToken(), fundedBy: "cash" }, NOW - DAY);
    const product = await stocked(60_000, 3, 40_000);
    const bought = await placed([{ variantId: product.variantId, qty: 1 }], "wallet", { customerId, at: NOW - HOUR });
    const payment = await paymentOf(bought.orderId);
    const refund = await createRefund(t.db, refunder(), { orderId: bought.orderId, paymentId: payment.id, amountIqd: 15_000, method: "wallet", reason: "تعويض عن تأخير التوصيل" }, NOW);
    await approveRefund(t.db, approver(), refund.refundId, { approve: true }, NOW);

    const page1 = await listWalletEntries(t.db, customerId, { limit: 2 });
    expect(page1.total).toBe(3);
    expect(page1.items.map((item) => [item.kind, item.amountIqd, item.orderRef])).toEqual([
      ["refund", 15_000, bought.ref],
      ["purchase", -65_000, bought.ref],
    ]);
    const page2 = await listWalletEntries(t.db, customerId, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((item) => [item.kind, item.amountIqd, item.orderRef])).toEqual([["topup", 200_000, null]]);
    expect(page2.nextCursor).toBeNull();
    expect(await getWalletBalance(t.db, customerId)).toBe(150_000);
  });
});

// ───────────────────────────────────────────────────────────────── refunds

describe("refunds", () => {
  test("bounded by what was paid and bought; a COD order must be collected first", async () => {
    const product = await stocked(80_000, 6, 50_000);
    const cod = await placed([{ variantId: product.variantId, qty: 2 }], "cod");
    const codPayment = await paymentOf(cod.orderId);
    const [line] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, cod.orderId));
    expect(await failureOf(createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId: codPayment.id, amountIqd: 10_000, method: "cash", reason: "اختبار قبل التحصيل" }, NOW))).toMatchObject({ code: "payment_not_paid" });
    await transitionOrder(t.db, ops(), cod.orderId, "confirmed", {}, NOW);
    await transitionOrder(t.db, ops(), cod.orderId, "shipped", {}, NOW);
    await recordCodCollection(t.db, ops(), cod.orderId, 165_000, NOW);

    expect(await failureOf(createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId: codPayment.id, amountIqd: 165_001, method: "cash", reason: "أكثر من المدفوع" }, NOW))).toMatchObject({ code: "refund_exceeds_payment" });
    expect(await failureOf(createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId: codPayment.id, items: [{ orderItemId: line.id, qty: 3 }], amountIqd: 10_000, method: "cash", reason: "كمية أكبر من المشتراة" }, NOW))).toMatchObject({
      code: "refund_qty_exceeds",
    });
    expect(await failureOf(createRefund(t.db, employee(verifierId, ["orders.refund.approve"]), { orderId: cod.orderId, paymentId: codPayment.id, amountIqd: 10_000, method: "cash", reason: "بدون صلاحية" }, NOW))).toMatchObject({ code: "forbidden" });

    // A pending refund already counts against the bound; rejecting it frees it again.
    const big = await createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId: codPayment.id, amountIqd: 165_000, method: "cash", reason: "إرجاع كامل" }, NOW);
    expect(await failureOf(createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId: codPayment.id, amountIqd: 1, method: "cash", reason: "استرداد إضافي" }, NOW))).toMatchObject({ code: "refund_exceeds_payment" });
    expect((await failureOf(approveRefund(t.db, approver(), big.refundId, { approve: false }, NOW))).fields).toEqual({ note: "required" });
    expect(await approveRefund(t.db, approver(), big.refundId, { approve: false, note: "تم الاتفاق على استبدال بدل الاسترداد" }, NOW)).toEqual({ status: "rejected" });
    expect(await getRefundableAmount(t.db, codPayment.id)).toBe(165_000);
    // The database bound holds even for a refund written behind the service's back.
    const forged = await failureOf(t.db.insert(refunds).values({ id: newId("rfd"), orderId: cod.orderId, paymentId: codPayment.id, amountIqd: 165_001, method: "cash", status: "pending", createdAt: NOW }).run());
    expect(forged.code).toBe("refund_exceeds_payment");
  });

  test("up to the owner's threshold a refund is issued at once; above it, it waits for a second person", async () => {
    await setSetting(t.db, system, "refunds.approval_threshold_iqd", 20_000, "صلاحية استرداد صغيرة للموظفين", NOW);
    try {
      const product = await stocked(70_000, 4, 45_000);
      const cod = await placed([{ variantId: product.variantId, qty: 1 }], "cod");
      await transitionOrder(t.db, ops(), cod.orderId, "confirmed", {}, NOW);
      await transitionOrder(t.db, ops(), cod.orderId, "shipped", {}, NOW);
      const { paymentId } = await recordCodCollection(t.db, ops(), cod.orderId, 75_000, NOW);
      const small = await createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId, amountIqd: 20_000, method: "cash", reason: "خصم لاحق متفق عليه", idempotencyKey: randomToken() }, NOW);
      expect(small.status).toBe("paid");
      expect(await linesOfEntry(`refund:${small.refundId}`)).toEqual(
        expect.arrayContaining([
          // Not delivered yet: no revenue to reverse, the money comes back out of the customer control account.
          { account: accountId("cod_receivable"), debit: 20_000, credit: 0 },
          { account: accountId("cash"), debit: 0, credit: 20_000 },
        ]),
      );
      const large = await createRefund(t.db, refunder(), { orderId: cod.orderId, paymentId, amountIqd: 20_001, method: "cash", reason: "استرداد أكبر من الحد" }, NOW);
      expect(large.status).toBe("pending");
      expect(await order(cod.orderId)).toMatchObject({ refundedIqd: 20_000, paymentStatus: "partially_refunded" });

      // Delivered after a refund: revenue is net of it and the customer control account still nets to zero.
      await approveRefund(t.db, approver(), large.refundId, { approve: false, note: "رُفض بعد مراجعة المدير" }, NOW);
      await transitionOrder(t.db, ops(), cod.orderId, "delivered", {}, NOW + HOUR);
      expect(await linesOfEntry(`order:${cod.orderId}:sale`)).toEqual(
        expect.arrayContaining([
          { account: accountId("cod_receivable"), debit: 55_000, credit: 0 },
          { account: accountId("sales_refunds"), debit: 20_000, credit: 0 },
          { account: accountId("sales_revenue"), debit: 0, credit: 70_000 },
          { account: accountId("shipping_income"), debit: 0, credit: 5_000 },
        ]),
      );
    } finally {
      await setSetting(t.db, system, "refunds.approval_threshold_iqd", 0, "إعادة الحد إلى صفر", NOW);
    }
  });

  test("serialised units that come back: restocked units can be sold again, scrapped units are written off; the serial link is released", async () => {
    const product = await stocked(500_000, 3, 420_000, { trackSerials: true });
    const unitIds = (await t.db.select({ id: serials.id, serial: serials.serial }).from(serials).where(eq(serials.variantId, product.variantId))).sort((a, b) => a.serial.localeCompare(b.serial)).map((row) => row.id);
    const buyer = await placed([{ variantId: product.variantId, qty: 2 }], "cod");
    const [line] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, buyer.orderId));
    await transitionOrder(t.db, ops(), buyer.orderId, "confirmed", {}, NOW);
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: line.id, serialIds: unitIds.slice(0, 2), actor: ops(), now: NOW }));
    await transitionOrder(t.db, ops(), buyer.orderId, "shipped", {}, NOW);
    await transitionOrder(t.db, ops(), buyer.orderId, "delivered", {}, NOW);
    const { paymentId } = await recordCodCollection(t.db, ops(), buyer.orderId, 1_005_000, NOW);

    // A refund that names a serial which is not on the line is refused before anything is stored.
    const wrong = await failureOf(
      createRefund(t.db, refunder(), { orderId: buyer.orderId, paymentId, items: [{ orderItemId: line.id, qty: 1, disposition: "scrap", serialIds: [unitIds[2]] }], amountIqd: 1_000, method: "cash", reason: "رقم تسلسلي خطأ" }, NOW),
    );
    expect(wrong).toMatchObject({ code: "invalid", fields: { items: "serial_not_on_line" } });
    expect(await getRefundableAmount(t.db, paymentId)).toBe(1_005_000);

    const back = await createRefund(
      t.db,
      refunder(),
      {
        orderId: buyer.orderId,
        paymentId,
        items: [{ orderItemId: line.id, qty: 2, disposition: "restock", serialIds: [unitIds[0], unitIds[1]] }],
        amountIqd: 1_000_000,
        method: "cash",
        reason: "إرجاع جهازين",
      },
      NOW,
    );
    await approveRefund(t.db, approver(), back.refundId, { approve: true }, NOW + HOUR);
    expect(await t.db.select({ status: serials.status }).from(serials).where(inArray(serials.id, unitIds.slice(0, 2)))).toEqual([{ status: "in_stock" }, { status: "in_stock" }]);
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.orderItemId, line.id))).every((row) => row.releasedAt === NOW + HOUR)).toBe(true);
    expect(await level(product.variantId)).toMatchObject({ onHand: 3, reserved: 0 });

    // A restocked unit can be sold again (the released link keeps the history).
    const again = await placed([{ variantId: product.variantId, qty: 1 }], "cod");
    const [line2] = await t.db.select().from(orderItems).where(eq(orderItems.orderId, again.orderId));
    await runBatch(t.db, assignSerialsStatements(t.db, { orderItemId: line2.id, serialIds: [unitIds[0]], actor: ops(), now: NOW + 2 * HOUR }));
    expect(await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, unitIds[0]))).toHaveLength(2);

    // Scrapped: the unit is written off and stays out of stock.
    await transitionOrder(t.db, ops(), again.orderId, "confirmed", {}, NOW + 2 * HOUR);
    await transitionOrder(t.db, ops(), again.orderId, "shipped", {}, NOW + 2 * HOUR);
    await transitionOrder(t.db, ops(), again.orderId, "delivered", {}, NOW + 2 * HOUR);
    const paid2 = await recordCodCollection(t.db, ops(), again.orderId, 505_000, NOW + 2 * HOUR);
    const scrap = await createRefund(
      t.db,
      refunder(),
      { orderId: again.orderId, paymentId: paid2.paymentId, items: [{ orderItemId: line2.id, qty: 1, disposition: "scrap" }], amountIqd: 505_000, method: "cash", reason: "وصل الجهاز معطوباً" },
      NOW + 3 * HOUR,
    );
    await approveRefund(t.db, approver(), scrap.refundId, { approve: true }, NOW + 3 * HOUR);
    expect((await t.db.select({ status: serials.status }).from(serials).where(eq(serials.id, unitIds[0])).get())?.status).toBe("scrapped");
    expect(await level(product.variantId)).toMatchObject({ onHand: 2 });
    const kinds = await t.db.select({ kind: stockMovements.kind, qty: stockMovements.qtyDelta }).from(stockMovements).where(and(eq(stockMovements.refId, again.orderId), inArray(stockMovements.kind, ["return", "damage"])));
    expect(kinds).toEqual(expect.arrayContaining([{ kind: "return", qty: 1 }, { kind: "damage", qty: -1 }]));
    expect(await linesOfEntry(`refund:${scrap.refundId}:goods`)).toEqual(
      expect.arrayContaining([
        { account: accountId("inventory_adjustments"), debit: 420_000, credit: 0 },
        { account: accountId("cogs"), debit: 0, credit: 420_000 },
      ]),
    );
    expect(await order(again.orderId)).toMatchObject({ paymentStatus: "refunded", refundedIqd: 505_000 });
  });

  test("a refund to the original transfer needs the outgoing transfer's reference", async () => {
    const product = await stocked(90_000, 2, 60_000);
    const transfer = await placed([{ variantId: product.variantId, qty: 1 }], "zaincash");
    await submitPaymentProof(t.db, { orderRef: transfer.ref, accessToken: transfer.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 95_000 }, NOW);
    const paymentId = (await paymentOf(transfer.orderId)).id;
    await verifyPayment(t.db, verifier(), paymentId, { approve: true }, NOW);
    const refund = await createRefund(t.db, refunder(), { orderId: transfer.orderId, paymentId, amountIqd: 95_000, method: "original", reason: "طلب العميل الإلغاء قبل الشحن" }, NOW);
    expect((await failureOf(approveRefund(t.db, approver(), refund.refundId, { approve: true }, NOW))).fields).toEqual({ reference: "reference_required" });
    await approveRefund(t.db, approver(), refund.refundId, { approve: true, reference: "ZC-OUT-9911" }, NOW);
    expect(await t.db.select({ status: refunds.status, reference: refunds.reference }).from(refunds).where(eq(refunds.id, refund.refundId)).get()).toEqual({ status: "paid", reference: "ZC-OUT-9911" });
    expect(await linesOfEntry(`refund:${refund.refundId}`)).toEqual(expect.arrayContaining([{ account: accountId("bank_clearing"), debit: 0, credit: 95_000 }]));
  });
});

// ───────────────────────────────────────────────────────────────── accounting

describe("standard postings", () => {
  test("unbalanced or malformed entries fail before the database; zero lines are dropped", () => {
    expect(() => journalStatements(t.db, { at: NOW, lines: [{ accountCode: "cash", debitIqd: 100 }, { accountCode: "sales_revenue", creditIqd: 99 }] })).toThrow(JournalEntryError);
    expect(() => journalStatements(t.db, { at: NOW, lines: [{ accountCode: "cash", debitIqd: 100, creditIqd: 100 }, { accountCode: "sales_revenue", creditIqd: 100 }] })).toThrow(JournalEntryError);
    expect(() => journalStatements(t.db, { at: NOW, lines: [{ accountCode: "cash", debitIqd: 1.5 }, { accountCode: "sales_revenue", creditIqd: 1.5 }] })).toThrow(JournalEntryError);
    expect(journalStatements(t.db, { at: NOW, lines: [{ accountCode: "cash", debitIqd: 0 }, { accountCode: "sales_revenue", creditIqd: 0 }] })).toEqual([]);
    expect(() => postSale(t.db, { at: NOW, createdBy: null, isDemo: false, orderId: "o", ref: "TT-X", subtotalIqd: 10, discountIqd: 0, shippingIqd: 0, totalIqd: 10, refundedBeforeIqd: 11 })).toThrow();
  });

  test("a closed month refuses postings (period_closed); the same business event cannot be posted twice (already_posted)", async () => {
    const january = Date.UTC(2026, 0, 15, 9);
    await t.db.insert(fiscalPeriods).values({ period: "2026-01", status: "closed", closedBy: approverId, closedAt: NOW });
    const closed = journalStatements(t.db, { at: january, memo: "late", lines: [{ accountCode: "operating_expenses", debitIqd: 5_000 }, { accountCode: "cash", creditIqd: 5_000 }] });
    const error = await runBatch(t.db, closed).then(() => null, (caught: unknown) => caught);
    expect(mapPostingError(error)).toMatchObject({ code: "period_closed", status: 409, detail: "2026-01" });

    const key = `test:${randomToken()}`;
    const entry = () => journalStatements(t.db, { at: NOW, idempotencyKey: key, lines: [{ accountCode: "operating_expenses", debitIqd: 7_000 }, { accountCode: "cash", creditIqd: 7_000 }] });
    await runBatch(t.db, entry());
    const twice = await runBatch(t.db, entry()).then(() => null, (caught: unknown) => caught);
    expect(mapPostingError(twice)).toMatchObject({ code: "already_posted", status: 409 });
    expect(await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, key))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── scheduled jobs

describe("scheduled jobs", () => {
  test("every 5 minutes: unpaid transfer orders past their window are cancelled and release what they held; reviewed ones wait", async () => {
    const product = await stocked(45_000, 6, 30_000);
    const overdue = await placed([{ variantId: product.variantId, qty: 2 }], "bank_transfer", { at: NOW - 25 * HOUR });
    const inReview = await placed([{ variantId: product.variantId, qty: 1 }], "zaincash", { at: NOW - 25 * HOUR });
    await submitPaymentProof(t.db, { orderRef: inReview.ref, accessToken: inReview.accessToken }, { fileId: await proofFile(), declaredAmountIqd: 50_000 }, NOW - 24.5 * HOUR);
    const fresh = await placed([{ variantId: product.variantId, qty: 1 }], "bank_transfer", { at: NOW - HOUR });
    expect(await level(product.variantId)).toMatchObject({ onHand: 6, reserved: 4 });

    // A stray reservation with an expiry and no order flow behind it is released by the safety net.
    const stray = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1, unitPriceIqd: 45_000 }]);
    await runBatch(t.db, reserveStatements(t.db, { orderId: stray.orderId, lines: [{ variantId: product.variantId, qty: 1 }], expiresAt: NOW - 1, actor: system, now: NOW - HOUR }));

    const run = await runScheduledJobs(t.db, CRON_FREQUENT, NOW);
    expect(run.ok).toBe(true);
    expect(run.jobs.map((job) => [job.job, job.status])).toEqual([
      ["orders.expire_unpaid", "succeeded"],
      ["inventory.reservations.expire", "succeeded"],
      ["catalog.publish_due", "succeeded"],
      ["outbox.deliver", "skipped"],
    ]);
    expect(run.jobs[0].stats).toMatchObject({ cancelled: expect.any(Number), failed: 0 });
    expect(Number(run.jobs[1].stats.released)).toBeGreaterThanOrEqual(1);

    expect(await order(overdue.orderId)).toMatchObject({ status: "cancelled", paymentStatus: "unpaid" });
    expect((await order(overdue.orderId)).cancelReason).toMatch(/^payment_window_expired/);
    expect(await paymentOf(overdue.orderId)).toMatchObject({ status: "cancelled" });
    expect((await order(inReview.orderId)).status).toBe("payment_review");
    expect((await order(fresh.orderId)).status).toBe("awaiting_payment");
    // 2 released by the cancellation, 1 by the safety net: the review and the fresh order still hold theirs.
    expect(await level(product.variantId)).toMatchObject({ onHand: 6, reserved: 2 });
    const recorded = await t.db.select().from(jobRuns).where(eq(jobRuns.id, run.jobs[0].runId)).get();
    expect(recorded).toMatchObject({ job: "orders.expire_unpaid", status: "succeeded", origin: "cron", startedAt: NOW });
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, overdue.orderId), eq(auditEvents.action, "orders.order.cancel"), eq(auditEvents.actorKind, "system")))).toHaveLength(1);
  });

  test("daily: the audit chain is sealed (head hash returned), rate limits and expired personal data are pruned", async () => {
    const customerId = await make.customer();
    const old = NOW - 400 * DAY;
    await t.db.insert(rateLimits).values([
      { key: "test:old", windowStart: NOW - 3 * DAY, count: 3 },
      { key: "test:new", windowStart: NOW - 60_000, count: 1 },
    ]);
    await t.db.insert(customerSessions).values([
      { idHash: `old-${randomToken()}`, customerId, createdAt: old, lastSeenAt: old, expiresAt: NOW - 40 * DAY },
      { idHash: `live-${randomToken()}`, customerId, createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + 30 * DAY },
    ]);
    await t.db.insert(otpCodes).values([
      { id: newId("otp"), phoneE164: "+9647700000001", purpose: "login", codeHash: "x", expiresAt: NOW - 10 * DAY, createdAt: NOW - 10 * DAY },
      { id: newId("otp"), phoneE164: "+9647700000001", purpose: "login", codeHash: "y", expiresAt: NOW + HOUR, createdAt: NOW },
    ]);
    await t.db.insert(authEvents).values([
      { id: newId("aev"), subjectKind: "customer", kind: "login", success: false, at: NOW - 200 * DAY },
      { id: newId("aev"), subjectKind: "customer", kind: "login", success: true, at: NOW - DAY },
    ]);
    await t.db.insert(outbox).values([
      { id: newId("msg"), channel: "sms", recipient: "+9647700000001", template: "order_placed", status: "held", createdAt: NOW - 100 * DAY },
      { id: newId("msg"), channel: "sms", recipient: "+9647700000001", template: "order_placed", status: "queued", createdAt: NOW - 100 * DAY },
      { id: newId("msg"), channel: "sms", recipient: "+9647700000001", template: "order_placed", status: "held", createdAt: NOW - DAY },
    ]);

    const run = await runScheduledJobs(t.db, CRON_DAILY, NOW);
    expect(run.jobs.map((job) => [job.job, job.status])).toEqual([
      ["audit.seal", "succeeded"],
      ["ratelimits.cleanup", "succeeded"],
      ["retention", "succeeded"],
      ["recommendations.events.purge", "succeeded"],
      // no bindings passed (no KV file store): the photo purge is recorded as not run, never as done
      ["tradein.drafts.purge", "skipped"],
      ["devices.tradein_offers.expire", "succeeded"],
      ["customers.segments.recompute", "succeeded"],
      ["consistency.daily", "succeeded"],
    ]);
    expect(run.ok).toBe(true);
    expect(run.audit?.headHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.audit?.lastSealedSeq).toBeGreaterThan(0);
    expect(run.jobs[2].stats).toMatchObject({ customerSessions: 1, otpCodes: 1, authEvents: 1, outbox: 1 });
    expect(await t.db.select({ key: rateLimits.key }).from(rateLimits).where(inArray(rateLimits.key, ["test:old", "test:new"]))).toEqual([{ key: "test:new" }]);
    expect(await t.db.select().from(customerSessions).where(eq(customerSessions.customerId, customerId))).toHaveLength(1);
    expect(await t.db.select({ status: outbox.status }).from(outbox)).toEqual(expect.arrayContaining([{ status: "queued" }, { status: "held" }]));
    expect(await t.db.select().from(outbox)).toHaveLength(2);
  });

  test("daily consistency checks record problems once, keep counting while they persist, and close them when they are gone", async () => {
    const product = await stocked(20_000, 3, 12_000);
    const fingerprint = `stock.levels_vs_movements|stock_level|${product.variantId}@${DEFAULT_LOCATION_ID}`;
    await t.db.update(stockLevels).set({ onHand: 5 }).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
    // A paid payment that never reached the books.
    const ghost = await make.order([{ variantId: product.variantId, sku: product.sku, unitPriceIqd: 20_000 }]);
    const ghostPayment = await make.payment(ghost.orderId, ghost.totalIqd);
    await t.db.update(orders).set({ paidIqd: ghost.totalIqd }).where(eq(orders.id, ghost.orderId));

    const first = await runScheduledJobs(t.db, CRON_DAILY, NOW);
    expect(first.jobs.find((job) => job.job === "consistency.daily")?.status).toBe("succeeded");
    const finding = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, fingerprint)).get();
    expect(finding).toMatchObject({ checkKey: "stock.levels_vs_movements", severity: "warning", status: "open", occurrences: 1, details: { onHand: 5, movedQty: 3 } });
    const missing = await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, `money.missing_postings|payment|${ghostPayment}`)).get();
    expect(missing).toMatchObject({ severity: "critical", status: "open" });

    await runScheduledJobs(t.db, CRON_DAILY, NOW + DAY);
    expect((await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, fingerprint)).get())).toMatchObject({ occurrences: 2, lastSeenAt: NOW + DAY, status: "open" });

    await t.db.update(stockLevels).set({ onHand: 3 }).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));
    await runScheduledJobs(t.db, CRON_DAILY, NOW + 2 * DAY);
    expect((await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, fingerprint)).get())).toMatchObject({ status: "resolved", resolvedBy: "system:consistency.daily", resolvedAt: NOW + 2 * DAY });
    expect((await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.fingerprint, `money.missing_postings|payment|${ghostPayment}`)).get())?.status).toBe("open");

    // What the operations screens read: open findings worst first, and the job history.
    const open = await listOpenFindings(t.db);
    expect(open.map((row) => row.fingerprint)).toContain(`money.missing_postings|payment|${ghostPayment}`);
    expect(open.map((row) => row.fingerprint)).not.toContain(fingerprint);
    expect(open[0].severity).toBe("critical");
    expect((await listJobRuns(t.db, "consistency.daily")).filter((row) => row.status === "succeeded").length).toBeGreaterThanOrEqual(3);
  });

  test("an unknown cron expression runs nothing and says so in job_runs", async () => {
    const run = await runScheduledJobs(t.db, "0 * * * *", NOW);
    expect(run).toMatchObject({ ok: false, audit: null, jobs: [{ job: "scheduler", status: "skipped" }] });
    expect((await t.db.select().from(jobRuns).where(eq(jobRuns.id, run.jobs[0].runId)).get())?.error).toContain('Unknown cron expression "0 * * * *"');
  });

  test("retention prunes job history older than 90 days but keeps the latest run of every job, however old", async () => {
    const tag = randomToken().slice(0, 8);
    const busy = `test.retention.busy.${tag}`;
    const quiet = `test.retention.quiet.${tag}`;
    const ago = (days: number) => NOW - days * DAY;
    const row = (id: string, job: string, startedAt: number, status: "succeeded" | "failed" = "succeeded") => ({ id: `job_${tag}_${id}`, job, status, origin: "cron" as const, startedAt, finishedAt: startedAt + 1_000, durationMs: 1_000 });
    await t.db.insert(jobRuns).values([
      row("b1", busy, ago(200)),
      row("b2", busy, ago(91), "failed"),
      row("b3", busy, ago(89)),
      row("b4", busy, ago(1)),
      // A job that last ran long ago keeps its last run; at the same start time the higher id is the later run.
      row("q1", quiet, ago(400)),
      row("q2", quiet, ago(300)),
      row("q3", quiet, ago(300)),
    ]);

    const run = await runJob(t.db, "retention", NOW);
    expect(run.status).toBe("succeeded");
    expect(RETENTION_DAYS.jobRuns).toBe(90);
    expect(Number(run.stats.jobRuns)).toBeGreaterThanOrEqual(4);
    const left = await t.db.select({ id: jobRuns.id }).from(jobRuns).where(inArray(jobRuns.job, [busy, quiet])).orderBy(jobRuns.id);
    expect(left.map((kept) => kept.id)).toEqual([`job_${tag}_b3`, `job_${tag}_b4`, `job_${tag}_q3`]);
    // The pruning run is on record itself.
    expect(await t.db.select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, run.runId)).get()).toEqual({ status: "succeeded" });
  });

  test("consented recommendation signals go after 90 days in a job of their own; the trade-in photo purge needs the Worker's file store", async () => {
    const { productId } = await make.product();
    const tag = randomToken().slice(0, 8);
    await t.db.insert(recommendationEvents).values([
      { id: `rev_${tag}_old`, sessionHash: `s${tag}`, kind: "view", productId, at: NOW - 91 * DAY },
      { id: `rev_${tag}_new`, sessionHash: `s${tag}`, kind: "view", productId, at: NOW - DAY },
    ]);

    const run = await runJob(t.db, "recommendations.events.purge", NOW);
    expect(run.status).toBe("succeeded");
    expect(Number(run.stats.deleted)).toBeGreaterThanOrEqual(1);
    const left = await t.db.select({ id: recommendationEvents.id }).from(recommendationEvents).where(eq(recommendationEvents.sessionHash, `s${tag}`));
    expect(left.map((row) => row.id)).toEqual([`rev_${tag}_new`]);
    // no bindings passed (no KV file store): the photo purge is recorded as not run, never as done
    expect(await runJob(t.db, "tradein.drafts.purge", NOW)).toMatchObject({ status: "skipped", stats: { reason: "no_file_store_binding" } });
    // the retention run no longer carries them (each is its own job_runs row)
    const retention = await runJob(t.db, "retention", NOW);
    expect(retention.status).toBe("succeeded");
    expect(Object.keys(retention.stats)).not.toContain("recommendationEvents");
    expect(Object.keys(retention.stats)).not.toContain("tradeInDrafts");
  });

  test("daily, one job_runs row each: customer segments recomputed, trade-in offers past their date closed, abandoned trade-in photos and old signals purged — a failing one fails alone", async () => {
    const tag = randomToken().slice(0, 8).toLowerCase();
    const store = kvBlobStore(t.kv);
    // a customer who bought (paid, nothing refunded), a trade-in offer that ran out an hour ago, an open one, a wizard's
    // photo left three days ago, a consented signal from 91 days ago
    const buyer = await make.customer();
    const { variantId, sku } = await make.product({ priceIqd: 100_000 });
    await make.order([{ variantId, sku, qty: 1, unitPriceIqd: 100_000 }], { customerId: buyer, status: "delivered", paymentStatus: "paid", paidIqd: 105_000 });
    const offerer = await make.employee();
    const inspection = { checklist: { templateId: null, completedAt: NOW - 2 * DAY, completedBy: offerer, items: [{ key: "power", result: "pass" as const }] }, grade: "A" as const, inspectedBy: offerer, inspectedAt: NOW - 2 * DAY };
    const offer = (suffix: string, offerExpiresAt: number) => ({ id: `ti_${tag}_${suffix}`, ref: `TI-${tag.toUpperCase()}${suffix.toUpperCase()}`, phoneE164: "+9647701112233", status: "offered" as const, finalOfferIqd: 120_000, offeredBy: offerer, offeredAt: NOW - 2 * DAY, offerExpiresAt, inspection, createdAt: NOW - 3 * DAY, updatedAt: NOW - 2 * DAY });
    await t.db.insert(tradeIns).values([offer("late", NOW - HOUR), offer("open", NOW + DAY)]);
    const draft = await addTradeInDraftPhoto(t.db, store, randomToken(24), PNG, { kind: "guest" }, NOW - 3 * DAY);
    const { productId } = await make.product();
    await t.db.insert(recommendationEvents).values({ id: `rev_${tag}_daily`, sessionHash: `d${tag}`, kind: "view", productId, at: NOW - 91 * DAY });

    const run = await runScheduledJobs(t.db, CRON_DAILY, NOW, { KV: t.kv });
    expect(run.ok).toBe(true);
    expect(run.jobs.map((job) => [job.job, job.status])).toEqual([
      ["audit.seal", "succeeded"],
      ["ratelimits.cleanup", "succeeded"],
      ["retention", "succeeded"],
      ["recommendations.events.purge", "succeeded"],
      ["tradein.drafts.purge", "succeeded"],
      ["devices.tradein_offers.expire", "succeeded"],
      ["customers.segments.recompute", "succeeded"],
      ["consistency.daily", "succeeded"],
    ]);
    // one row each, with its counters
    const recorded = await t.db.select({ id: jobRuns.id, job: jobRuns.job, status: jobRuns.status }).from(jobRuns).where(inArray(jobRuns.id, run.jobs.map((job) => job.runId)));
    expect(recorded.map((row) => row.job).sort()).toEqual(run.jobs.map((job) => job.job).sort());
    const statsOf = (job: string) => run.jobs.find((outcome) => outcome.job === job)?.stats ?? {};
    expect(Number(statsOf("recommendations.events.purge").deleted)).toBeGreaterThanOrEqual(1);
    expect(Number(statsOf("tradein.drafts.purge").deleted)).toBeGreaterThanOrEqual(1);
    expect(statsOf("devices.tradein_offers.expire")).toMatchObject({ expired: 1, more: false });
    expect(Number(statsOf("customers.segments.recompute").total)).toBeGreaterThanOrEqual(1);
    // what they did
    expect(await t.db.select({ id: recommendationEvents.id }).from(recommendationEvents).where(eq(recommendationEvents.id, `rev_${tag}_daily`))).toEqual([]);
    expect((await t.db.select({ deletedAt: files.deletedAt }).from(files).where(eq(files.id, draft.id)).get())?.deletedAt).toBe(NOW);
    const offers = await t.db.select({ id: tradeIns.id, status: tradeIns.status }).from(tradeIns).where(inArray(tradeIns.id, [`ti_${tag}_late`, `ti_${tag}_open`])).orderBy(tradeIns.id);
    expect(offers).toEqual([
      { id: `ti_${tag}_late`, status: "expired" },
      { id: `ti_${tag}_open`, status: "offered" },
    ]);
    expect(await t.db.select({ kind: tradeInEvents.kind }).from(tradeInEvents).where(eq(tradeInEvents.tradeInId, `ti_${tag}_late`))).toEqual([{ kind: "expired" }]);
    expect(await t.db.select({ customerId: customerSegmentMembers.customerId }).from(customerSegmentMembers).where(eq(customerSegmentMembers.customerId, buyer))).toHaveLength(1);
    expect(await t.db.select({ actorKind: auditEvents.actorKind }).from(auditEvents).where(and(eq(auditEvents.action, "customers.segment.recompute"), eq(auditEvents.at, NOW)))).toContainEqual({ actorKind: "system" });

    // The file store failing takes only its own job down: that run is "failed", every other job of the night succeeds.
    await addTradeInDraftPhoto(t.db, store, randomToken(24), PNG, { kind: "guest" }, NOW - 2 * DAY);
    const broken = new Proxy(t.kv, {
      get(target, property) {
        if (property === "delete") return async () => Promise.reject(new Error("the file store is down (test)"));
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const night = await runScheduledJobs(t.db, CRON_DAILY, NOW + DAY, { KV: broken });
    expect(night.ok).toBe(false);
    expect(night.jobs.filter((job) => job.status !== "succeeded").map((job) => [job.job, job.status])).toEqual([["tradein.drafts.purge", "failed"]]);
    expect(night.jobs.find((job) => job.job === "tradein.drafts.purge")?.error).toContain("the file store is down");
    expect((await t.db.select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, night.jobs.find((job) => job.job === "tradein.drafts.purge")!.runId)).get())?.status).toBe("failed");
  });

  test("retention deletes stored assistant conversations past their expiry with their messages; the ticket keeps its note, the consent row stays", async () => {
    const tag = randomToken().slice(0, 8);
    const session = (id: string, expiresAt: number | null) => ({ id: `ast_${tag}_${id}`, kind: "maintenance" as const, status: "escalated" as const, summary: "ملخص المحادثة", logConsent: true, locale: "ar" as const, createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY, expiresAt });
    await t.db.insert(assistantSessions).values([session("old", NOW - DAY), session("live", NOW + 30 * DAY), session("forever", null)]);
    await t.db.insert(assistantMessages).values(
      ["old", "old", "live", "forever"].map((owner, index) => ({ id: `amg_${tag}_${index}`, sessionId: `ast_${tag}_${owner}`, role: "user" as const, content: "الجهاز لا يشتغل", createdAt: NOW - 400 * DAY + index })),
    );
    await t.db.insert(consents).values({ id: `cns_${tag}`, subjectType: "assistant_session", subjectId: `ast_${tag}_old`, kind: "support_log", granted: true, source: "assistant", at: NOW - 400 * DAY });
    // The hand-off's ticket points at the conversation (a foreign key) and carries the summary as its first internal note.
    await t.db.insert(supportTickets).values({ id: `tkt_${tag}`, ref: `SP-${tag.toUpperCase()}`, channel: "assistant", subject: "الجهاز لا يشتغل", assistantSessionId: `ast_${tag}_old`, createdAt: NOW - 400 * DAY, updatedAt: NOW - 400 * DAY });

    const run = await runJob(t.db, "retention", NOW);
    expect(run.status).toBe("succeeded");
    expect(run.stats.assistantSessions).toBe(1);
    const sessionsLeft = await t.db.select({ id: assistantSessions.id }).from(assistantSessions).where(inArray(assistantSessions.id, [`ast_${tag}_old`, `ast_${tag}_live`, `ast_${tag}_forever`]));
    expect(sessionsLeft.map((row) => row.id).sort()).toEqual([`ast_${tag}_forever`, `ast_${tag}_live`]);
    const messagesLeft = await t.db.select({ sessionId: assistantMessages.sessionId }).from(assistantMessages).where(inArray(assistantMessages.id, [0, 1, 2, 3].map((index) => `amg_${tag}_${index}`)));
    expect(messagesLeft.map((row) => row.sessionId).sort()).toEqual([`ast_${tag}_forever`, `ast_${tag}_live`]);
    expect(await t.db.select({ link: supportTickets.assistantSessionId, subject: supportTickets.subject }).from(supportTickets).where(eq(supportTickets.id, `tkt_${tag}`)).get()).toEqual({ link: null, subject: "الجهاز لا يشتغل" });
    // Append-only: the consent row is history, not conversation content.
    expect(await t.db.select({ id: consents.id }).from(consents).where(eq(consents.id, `cns_${tag}`))).toHaveLength(1);
    // Nothing left to do on the next run.
    expect((await runJob(t.db, "retention", NOW + HOUR)).stats.assistantSessions).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── error texts

describe("error texts", () => {
  const lower = Object.keys(TRIGGER_ERROR_CODES).map((code) => code.toLowerCase());
  const EVERY_CODE = [
    ...new Set<string>([
      ...CORE_ERROR_KEYS,
      ...lower,
      "unique",
      "check",
      "foreign_key",
      "not_null",
      ...CART_ERROR_KEYS,
      ...STOCK_ERROR_KEYS,
      ...SHIPPING_ERROR_KEYS,
      ...CHECKOUT_ERROR_KEYS,
      ...ORDER_ERROR_KEYS,
      ...PAYMENT_ERROR_KEYS,
      ...WALLET_ERROR_KEYS,
      ...REFUND_ERROR_KEYS,
      ...RETURN_ERROR_KEYS,
      ...ACCOUNTING_ERROR_KEYS,
      ...ACCOUNT_ERROR_KEYS,
      ...TRADE_IN_ERROR_KEYS,
    ]),
  ];

  test("every code a shopper or employee can see has a text in ar, en and ckb", () => {
    for (const locale of LOCALE_CODES) {
      const texts = (errorMessages[locale] as { errors: Record<string, string> }).errors;
      const missing = EVERY_CODE.filter((code) => typeof texts[code] !== "string" || texts[code].trim() === "");
      expect(missing, `app/i18n/messages/errors.ts (${locale})`).toEqual([]);
    }
  });

  test("the account and trade-in codes are adopted from their areas, not copied: one sentence each; the core's own wording wins a shared code", () => {
    for (const locale of LOCALE_CODES) {
      const texts = (errorMessages[locale] as { errors: Record<string, string> }).errors;
      const accountTexts = (accountMessages[locale] as { errors: Record<string, string> }).errors;
      const usedTexts = (usedMessages[locale] as { errors: Record<string, string> }).errors;
      for (const code of ACCOUNT_ERROR_KEYS) expect(texts[code], `${locale} ${code}`).toBe(accountTexts[code]);
      for (const code of TRADE_IN_ERROR_KEYS.filter((key) => key !== "idempotency_conflict")) expect(texts[code], `${locale} ${code}`).toBe(usedTexts[code]);
      // The areas hold exactly their lists, so nothing else rides along into the shared namespace.
      expect(Object.keys(accountTexts).sort()).toEqual([...ACCOUNT_ERROR_KEYS].sort());
      expect(Object.keys(usedTexts).sort()).toEqual([...TRADE_IN_ERROR_KEYS].sort());
    }
    // "idempotency_conflict" means a repeated checkout here; the used area keeps its trade-in sentence on its own pages.
    expect(serverT("en", "errors")("errors.idempotency_conflict")).toBe("This order was already sent from another session. Start the checkout again.");
    expect(actionError(new AppError("topup_not_pending", 409), serverT("en", "errors")).message).toBe("This request is no longer under review, so it cannot be cancelled.");
    expect(actionError(new AppError("trade_in_offer_closed", 409), serverT("ar", "errors")).message).toBe((usedMessages.ar as { errors: Record<string, string> }).errors.trade_in_offer_closed);
  });

  test("actionError() translates codes and field keys through the errors namespace", () => {
    const failure = actionError(new AppError("totals_changed", 409, { fields: { phone: "phone_invalid" } }), serverT("en", "errors"));
    expect(failure).toMatchObject({ ok: false, code: "totals_changed", status: 409, message: "Prices or availability changed since you reviewed your order. Check the new total, then confirm again." });
    // the sample number is joined with no-break spaces so it never wraps mid-number
    expect(failure.fields?.phone).toBe("Enter an Iraqi mobile number, for example 0770 123 4567.");
    expect(actionError(new AppError("wallet_insufficient", 409), serverT("ar", "errors")).message).toBe("رصيد محفظتك لا يكفي لهذا الطلب. اختر طريقة دفع أخرى.");
  });
});
