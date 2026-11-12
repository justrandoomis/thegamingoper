/**
 * Digital codes of paid orders (docs/CONTRACTS.md §1 "orders/digital.server.ts") — the commerce core's side of module
 * 13's `digital_codes` (the codes are imported there, ENCRYPTED with DATA_KEY, context "digital_code:<id>").
 *
 *   statements.push(...(await assignDigitalCodesStatements(db, { orderId, lines, isDemo, actor, now })));  // the batch that makes the order paid
 *   statements.push(...(await revokeDigitalCodesStatements(db, { orderId, items, actor, now })));          // a refund's batch
 *   const lines = await orderDigitalLines(db, order, locale);                                            // the order page (no code text)
 *   const { code } = await revealOrderCode(db, dataKey, { order, codeId, actor }, now);                  // «اعرض الرمز», audited
 *
 * RULES
 *   · A line is a code line when its variant has codes in module 13's store (any status). It gets ONE code per unit
 *     in the batch that makes the order PAID: placeOrder for a wallet payment, verifyPayment when the transfer that
 *     completes it is approved, recordCodCollection when the cash that completes it is recorded — never before
 *     payment, never twice (each line takes at most qty − refunded − already delivered). Codes are taken soonest
 *     expiry first, then oldest; an expired code is never given; a demo order takes demo codes only, a real order real
 *     ones. Fewer codes than units: the line keeps what there is and the rest is "pending" (staff add codes; module
 *     13's queue) — a payment never fails for it.
 *   · The buyer sees the code only after payment, one code at a time on request: an account's order to its signed-in
 *     owner, a guest's order behind its confirmation token (orderCodesOpenWith — security review 2026-11-12: an
 *     account order's link, kept in the browser's history, opened its codes after sign-out on a shared device). Every
 *     reveal is an audit event (`orders.digital_code.reveal`, without the code; the signed-in customer as the actor
 *     whenever there is one, and `access`: account | link), counts against a limit per order (REVEAL_LIMIT), and
 *     stamps `revealed_at` (first time) and `reveal_count`.
 *   · A refund revokes (decided in its batch, review 2026-11-12): a refunded line keeps as many codes as it still has
 *     paid units — the delivered codes beyond them are revoked, a never-revealed one first, then the newest (refunding
 *     a unit still waiting for its code revokes nothing) —, and once the order is refunded in full every code of it is
 *     revoked (two refunds at once included). A revoked code is never shown again; neither is any code of a cancelled
 *     or returned order (its refund may be waiting).
 *
 * Errors: not_found (404 — a code that is not this order's), code_unpaid (409), code_not_revealable (409),
 * rate_limited (429). Must not import "cloudflare:workers".
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { sha256Hex, timingSafeEqual } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import type { Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import { decryptSecret } from "~/server/crypto.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { digitalCodes, orderItems, orders, type Order } from "~/server/db/schema";
import { batchSql, expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound, rateLimited } from "~/server/errors";
import { limitKey, rateLimit } from "~/server/ratelimit.server";
import { orderRefundedInFullSql } from "./promotions.server";
import type { CodeRevealResult, OrderDigitalLineView } from "./types";

export const DIGITAL_ERROR_KEYS = ["code_unpaid", "code_not_revealable"] as const;

/** Reveals per order (all its codes together): generous for a buyer, tight for someone harvesting. */
export const REVEAL_LIMIT = { limit: 30, windowSec: 60 * 60 } as const;

/** module 13's encryption context of a code (services/admin/devices/codes.server.ts codeContext). */
const codeContext = (codeId: string) => `digital_code:${codeId}`;

/** Order payment states in which its lines are paid for. */
const PAID = new Set(["paid", "partially_refunded"]);

/** Variant ids (of these) that have codes in module 13's store. */
async function codeVariants(db: Db, variantIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(variantIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.selectDistinct({ variantId: digitalCodes.variantId }).from(digitalCodes).where(inArray(digitalCodes.variantId, ids));
  return new Set(rows.map((row) => row.variantId));
}

export type CodeLine = { orderItemId: string; variantId: string; qty: number; refundedQty?: number };

/**
 * The statements that give each code line of an order its codes (file header), for the batch that makes the order
 * paid. `lines` may be lines inserted in the same batch (placeOrder) — their ids are known, their rows not yet.
 */
export async function assignDigitalCodesStatements(db: Db, input: { orderId: string; lines: readonly CodeLine[]; isDemo: boolean; actor: Actor; now: number }): Promise<BatchStatement[]> {
  const coded = await codeVariants(db, input.lines.map((line) => line.variantId));
  const lines = input.lines.filter((line) => coded.has(line.variantId));
  if (lines.length === 0) return [];
  const held = await db
    .select({ orderItemId: digitalCodes.orderItemId, n: sql<number>`count(*)` })
    .from(digitalCodes)
    .where(and(inArray(digitalCodes.orderItemId, lines.map((line) => line.orderItemId)), eq(digitalCodes.status, "delivered")))
    .groupBy(digitalCodes.orderItemId);
  const heldBy = new Map(held.map((row) => [row.orderItemId, Number(row.n)]));
  const statements: BatchStatement[] = [];
  const delivered: { orderItemId: string; units: number }[] = [];
  for (const line of lines) {
    const units = line.qty - (line.refundedQty ?? 0) - (heldBy.get(line.orderItemId) ?? 0);
    if (units <= 0) continue;
    delivered.push({ orderItemId: line.orderItemId, units });
    statements.push(
      batchSql(
        db,
        sql`UPDATE digital_codes SET status = 'delivered', order_item_id = ${line.orderItemId}, delivered_at = ${input.now}
          WHERE id IN (SELECT id FROM digital_codes WHERE variant_id = ${line.variantId} AND status = 'available' AND is_demo = ${input.isDemo ? 1 : 0}
            AND (expires_at IS NULL OR expires_at > ${input.now})
            ORDER BY CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END, expires_at, created_at, id LIMIT ${units})`,
      ),
    );
  }
  if (delivered.length === 0) return [];
  statements.push(auditStatement(db, { actor: input.actor, action: "orders.digital_code.deliver", entityType: "order", entityId: input.orderId, after: { lines: delivered }, at: input.now }));
  return statements;
}

/** assignDigitalCodesStatements for an order already stored (its lines read now). */
export async function assignOrderCodesStatements(db: Db, order: Pick<Order, "id" | "isDemo">, actor: Actor, now: number): Promise<BatchStatement[]> {
  const lines = await db.select({ orderItemId: orderItems.id, variantId: orderItems.variantId, qty: orderItems.qty, refundedQty: orderItems.refundedQty }).from(orderItems).where(eq(orderItems.orderId, order.id));
  return assignDigitalCodesStatements(db, { orderId: order.id, lines, isDemo: order.isDemo, actor, now });
}

/**
 * A refund's batch, AFTER its own `order_items` and `orders` updates (both are read here at write time):
 *   · per refunded line, the delivered codes BEYOND the units still paid for (qty − refunded_qty) are revoked — a refund
 *     of a unit that was still waiting for its code revokes nothing (review 2026-11-12: it revoked the code already
 *     delivered, and the buyer was left with a paid unit and no code); a code never revealed goes first, then the newest;
 *   · once the order is refunded in full (orderRefundedInFullSql — decided in the batch, so two refunds at once see each
 *     other), every delivered code of it; `all` revokes them unconditionally.
 */
export async function revokeDigitalCodesStatements(db: Db, input: { orderId: string; items: readonly { orderItemId: string; qty: number }[]; all: boolean; actor: Actor; reason: string; now: number }): Promise<BatchStatement[]> {
  const held = await db
    .select({ orderItemId: digitalCodes.orderItemId, n: sql<number>`count(*)` })
    .from(digitalCodes)
    .innerJoin(orderItems, eq(orderItems.id, digitalCodes.orderItemId))
    .where(and(eq(orderItems.orderId, input.orderId), eq(digitalCodes.status, "delivered")))
    .groupBy(digitalCodes.orderItemId);
  if (held.length === 0) return [];
  const statements: BatchStatement[] = [];
  const allOfOrder = sql`status = 'delivered' AND order_item_id IN (SELECT id FROM order_items WHERE order_id = ${input.orderId})`;
  if (input.all) {
    statements.push(batchSql(db, sql`UPDATE digital_codes SET status = 'revoked' WHERE ${allOfOrder}`));
  } else {
    const heldBy = new Set(held.map((row) => row.orderItemId));
    for (const item of input.items) {
      if (!heldBy.has(item.orderItemId) || item.qty <= 0) continue;
      const excess = sql`max(0, (SELECT count(*) FROM digital_codes WHERE order_item_id = ${item.orderItemId} AND status = 'delivered') - coalesce((SELECT qty - refunded_qty FROM order_items WHERE id = ${item.orderItemId}), 0))`;
      statements.push(
        batchSql(
          db,
          sql`UPDATE digital_codes SET status = 'revoked' WHERE id IN (SELECT id FROM digital_codes WHERE order_item_id = ${item.orderItemId} AND status = 'delivered'
            ORDER BY CASE WHEN revealed_at IS NULL THEN 0 ELSE 1 END, delivered_at DESC, id DESC LIMIT ${excess})`,
        ),
      );
    }
    statements.push(batchSql(db, sql`UPDATE digital_codes SET status = 'revoked' WHERE ${allOfOrder} AND ${orderRefundedInFullSql(input.orderId)}`));
  }
  statements.push(auditStatement(db, { actor: input.actor, action: "orders.digital_code.revoke", entityType: "order", entityId: input.orderId, after: { all: input.all, items: input.items, rule: "beyond the units still paid; all once refunded in full" }, reason: input.reason, at: input.now }));
  return statements;
}

/** Order statuses whose codes are no longer the buyer's to see (the money is on its way back, or the order came back). */
const CLOSED_STATUSES = new Set(["cancelled", "returned"]);

/**
 * The order's paid code lines as its shopper sees them — ids and states, never the code (shown on request). Empty
 * before payment and for orders without code lines. Nothing is "pending" for a cancelled or returned order. The caller
 * has opened the order for this shopper.
 */
export async function orderDigitalLines(db: Db, order: Pick<Order, "id" | "paymentStatus"> & { status?: Order["status"] }, locale: Locale): Promise<OrderDigitalLineView[]> {
  if (!PAID.has(order.paymentStatus) && order.paymentStatus !== "refunded") return [];
  const items = await db.select({ id: orderItems.id, variantId: orderItems.variantId, name: orderItems.nameSnapshot, qty: orderItems.qty, refundedQty: orderItems.refundedQty }).from(orderItems).where(eq(orderItems.orderId, order.id));
  const coded = await codeVariants(db, items.map((item) => item.variantId));
  const lines = items.filter((item) => coded.has(item.variantId));
  if (lines.length === 0) return [];
  const codes = await db
    .select({ id: digitalCodes.id, orderItemId: digitalCodes.orderItemId, status: digitalCodes.status, revealedAt: digitalCodes.revealedAt })
    .from(digitalCodes)
    .where(and(inArray(digitalCodes.orderItemId, lines.map((line) => line.id)), inArray(digitalCodes.status, ["delivered", "revoked"])))
    .orderBy(digitalCodes.deliveredAt, digitalCodes.id);
  return lines.map((line) => {
    const own = codes.filter((code) => code.orderItemId === line.id);
    const delivered = own.filter((code) => code.status === "delivered").length;
    return {
      orderItemId: line.id,
      name: pick(line.name, locale),
      qty: line.qty,
      codes: own.map((code) => ({ id: code.id, status: code.status as "delivered" | "revoked", revealedAt: code.revealedAt })),
      pending: PAID.has(order.paymentStatus) && !CLOSED_STATUSES.has(order.status ?? "") ? Math.max(0, line.qty - line.refundedQty - delivered) : 0,
    };
  });
}

/**
 * Who may open an order's codes (security review 2026-11-12): an order that belongs to an ACCOUNT, its signed-in owner
 * only ("account"); a guest's order, its confirmation link ("link" — there is no account to sign in to). The link of an
 * account's order still opens the ORDER, but not its codes: that link sits in the browser's history even for a
 * signed-in shopper (the checkout lands on it) and keeps working after they sign out on a shared device. Null when
 * there is no such order. Reads only.
 */
export async function orderCodesOpenWith(db: Db, orderRef: string): Promise<"account" | "link" | null> {
  const ref = typeof orderRef === "string" ? orderRef.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(ref)) return null;
  const row = await db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.ref, ref)).get();
  if (!row) return null;
  return row.customerId ? "account" : "link";
}

/**
 * revealOrderCode for a shopper who proves access (CONTRACTS §1, orderCodesOpenWith): the signed-in customer who owns
 * the order, or — for a GUEST's order only — the confirmation link's token (compared as hashes). Anyone else — a wrong
 * token, another customer, an account's order opened with its link but without its owner signed in, an order that does
 * not exist — gets the same not_found. The actor of the audit event is the signed-in customer whenever there is one —
 * also when a guest order's LINK opened it (someone else's order shared with them; security review 2026-11-12: that
 * reveal was recorded as an anonymous guest) — else a guest with the request's address; the event says how they got
 * in (`access`: "account" | "link").
 */
export async function revealOrderCodeForShopper(
  db: Db,
  dataKey: string | null | undefined,
  input: { ref: string; accessToken?: string | null; customerId?: string | null; codeId: string; ip?: string | null; requestId?: string | null },
  now: number,
): Promise<CodeRevealResult> {
  const ref = typeof input.ref === "string" ? input.ref.trim().toUpperCase() : "";
  if (!/^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(ref)) throw notFound("order");
  const order = await db.select({ id: orders.id, ref: orders.ref, customerId: orders.customerId, accessTokenHash: orders.accessTokenHash }).from(orders).where(eq(orders.ref, ref)).get();
  if (!order) throw notFound("order");
  const byCustomer = Boolean(input.customerId) && order.customerId === input.customerId;
  let byToken = false;
  // the link opens a GUEST's codes only: an account's order needs its owner signed in (orderCodesOpenWith)
  if (!byCustomer && order.customerId === null && typeof input.accessToken === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(input.accessToken) && order.accessTokenHash) {
    byToken = timingSafeEqual(order.accessTokenHash, await sha256Hex(input.accessToken));
  }
  if (!byCustomer && !byToken) throw notFound("order");
  const actor: Actor = input.customerId ? { kind: "customer", id: input.customerId, ip: input.ip ?? null, requestId: input.requestId ?? null } : { kind: "guest", ip: input.ip ?? null, requestId: input.requestId ?? null };
  return revealOrderCode(db, dataKey, { order, codeId: input.codeId, actor, access: byCustomer ? "account" : "link" }, now);
}

/**
 * One code of this order, decrypted for its shopper (file header). `order` must already be opened for this shopper
 * (confirmation token or owner's session) — this checks only that the code is the order's, the order is paid and still
 * stands (not cancelled — its refund may be waiting —, not returned: code_not_revealable, review 2026-11-12) and the
 * line was not refunded in full. Audited; limited per order.
 */
export async function revealOrderCode(
  db: Db,
  dataKey: string | null | undefined,
  input: { order: Pick<Order, "id" | "ref">; codeId: string; actor: Actor; /** How the shopper opened the order (revealOrderCodeForShopper) — written into the audit event. */ access?: "account" | "link" },
  now: number,
): Promise<CodeRevealResult> {
  if (typeof input.codeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.codeId)) throw notFound("digital_code");
  const row = await db
    .select({ id: digitalCodes.id, codeEnc: digitalCodes.codeEnc, status: digitalCodes.status, revealedAt: digitalCodes.revealedAt, orderId: orderItems.orderId, qty: orderItems.qty, refundedQty: orderItems.refundedQty, paymentStatus: orders.paymentStatus, orderStatus: orders.status })
    .from(digitalCodes)
    .innerJoin(orderItems, eq(orderItems.id, digitalCodes.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(digitalCodes.id, input.codeId))
    .get();
  // another order's code looks exactly like one that does not exist
  if (!row || row.orderId !== input.order.id) throw notFound("digital_code");
  if (row.status !== "delivered" || CLOSED_STATUSES.has(row.orderStatus)) throw new AppError("code_not_revealable", 409);
  if (!PAID.has(row.paymentStatus) || row.refundedQty >= row.qty) throw new AppError("code_unpaid", 409);
  const verdict = await rateLimit(db, await limitKey("code-reveal-order", "order", input.order.id), REVEAL_LIMIT, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
  const code = await decryptSecret(row.codeEnc, dataKey, codeContext(row.id));
  try {
    await runBatch(db, [
      db
        .update(digitalCodes)
        .set({ revealCount: sql`${digitalCodes.revealCount} + 1`, revealedAt: sql`coalesce(${digitalCodes.revealedAt}, ${now})` })
        .where(
          and(
            eq(digitalCodes.id, row.id),
            eq(digitalCodes.status, "delivered"),
            // still the buyer's at write time: revoked, cancelled or returned meanwhile → nothing is shown
            sql`EXISTS (SELECT 1 FROM order_items AS i JOIN orders AS o ON o.id = i.order_id WHERE i.id = ${digitalCodes.orderItemId} AND i.refunded_qty < i.qty AND o.status NOT IN ('cancelled', 'returned') AND o.payment_status IN ('paid', 'partially_refunded'))`,
          ),
        ),
      expectChanged(db, 1, { code: "CODE_NOT_REVEALABLE", detail: row.id }),
      auditStatement(db, { actor: input.actor, action: "orders.digital_code.reveal", entityType: "digital_code", entityId: row.id, after: { orderRef: input.order.ref, ...(input.access ? { access: input.access } : {}) }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "CODE_NOT_REVEALABLE")) throw new AppError("code_not_revealable", 409, { cause: error });
    throw error;
  }
  return { codeId: row.id, code };
}
