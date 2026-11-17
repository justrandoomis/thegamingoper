/**
 * Admin 06 — digital codes of till sales (2026-11-13). A till sale of a digital product gets its codes in the sale's own
 * batch, exactly like the web checkout (orders/pos-sale.server.ts → orders/digital.server.ts assignDigitalCodesStatements:
 * one per unit, soonest expiry first, demo codes only for a demo sale, the rest "pending" when the store has too few).
 * The customer stands at the counter, so the till SHOWS a code on request — on the screen and on a slip of its own,
 * never on the receipt (a receipt is reprinted, and kept as plain data).
 *
 *   const view = await saleCodes(db, actor, "TT-8K2M4Q", locale);                       // states only, never a code
 *   const { code } = await revealSaleCode(db, dataKey, actor, { ref, codeId }, now);    // audited, limited per order
 *
 * WHO SEES A CODE
 *   · the cashier who rang the sale up, while that shift is still open (the customer is at the counter);
 *   · after the shift — or a sale of someone else's shift — a supervisor (pos.shift.review);
 *   · at the till's branch only (a branch-limited employee); never a code of a web order through this door.
 *   Every reveal goes through the core's revealOrderCode: the sale paid and standing (not cancelled or returned), the
 *   code delivered and not revoked (a refund revokes it — refunds.server.ts), the line not refunded in full; each one
 *   is an audit event (`orders.digital_code.reveal`, the employee as the actor) and counts against the order's reveal
 *   limit (REVEAL_LIMIT). A printed slip is a reveal: printing again reveals again, and is recorded again.
 *   Listing the code lines (states, no code) follows the receipt's rule: pos.receipt.reprint, pos.sale.create or
 *   pos.shift.review — a cashier only for their own shifts' sales.
 *
 * Errors: not_found (404 — another order's code, a sale this employee may not open), forbidden (403),
 * code_reveal_closed (403 — a cashier after the shift), and the core's code_not_revealable, code_unpaid (409),
 * rate_limited (429).
 */
import { and, eq } from "drizzle-orm";
import type { Locale } from "~/lib/locales";
import { assertBranch, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orders, posShifts } from "~/server/db/schema";
import { AppError, notFound } from "~/server/errors";
import { orderDigitalLines, revealOrderCode } from "../../orders/digital.server";
import type { CodeRevealResult, OrderDigitalLineView } from "../../orders/types";
import { assertAny } from "./shared.server";

export const CODE_ERROR_KEYS = ["code_reveal_closed"] as const;

const REF = /^[A-Z]{2,4}-[A-Z0-9]{4,16}$/;

export type SaleCodesView = {
  ref: string;
  isDemo: boolean;
  /** Code lines of the sale (empty: none of its lines is a code product). */
  lines: OrderDigitalLineView[];
  /** May this employee show a code of this sale now. */
  canReveal: boolean;
  /** Why not, for a person who could otherwise: the cashier's shift was closed. */
  revealBlocked: "shift_closed" | null;
};

type SaleRow = { id: string; ref: string; status: (typeof orders.$inferSelect)["status"]; paymentStatus: (typeof orders.$inferSelect)["paymentStatus"]; branchId: string | null; isDemo: boolean; shiftOwner: string | null; shiftOpen: boolean };

/** A till sale by its reference, opened for this employee by the receipt's rule (file header), or not_found. */
async function saleFor(db: Db, actor: Actor, ref: string): Promise<SaleRow> {
  assertAny(actor, ["pos.receipt.reprint", "pos.sale.create", "pos.shift.review"]);
  const clean = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  if (!REF.test(clean)) throw notFound("receipt");
  const row = await db
    .select({ id: orders.id, ref: orders.ref, status: orders.status, paymentStatus: orders.paymentStatus, branchId: orders.branchId, isDemo: orders.isDemo, shiftOwner: posShifts.openedBy, shiftStatus: posShifts.status })
    .from(orders)
    .leftJoin(posShifts, eq(posShifts.id, orders.posShiftId))
    .where(and(eq(orders.ref, clean), eq(orders.channel, "pos")))
    .get();
  if (!row) throw notFound("receipt");
  assertBranch(actor, row.branchId);
  const own = actor.kind === "employee" && row.shiftOwner === actor.id;
  if (!can(actor, "pos.shift.review") && !own) throw notFound("receipt");
  return { id: row.id, ref: row.ref, status: row.status, paymentStatus: row.paymentStatus, branchId: row.branchId, isDemo: row.isDemo, shiftOwner: row.shiftOwner, shiftOpen: row.shiftStatus === "open" };
}

/** Whether this employee may show a code of the sale now (file header): a supervisor, or its cashier while the shift is open. */
function revealRight(actor: Actor, sale: SaleRow): { ok: boolean; blocked: "shift_closed" | null } {
  if (can(actor, "pos.shift.review")) return { ok: true, blocked: null };
  const own = actor.kind === "employee" && sale.shiftOwner === actor.id && can(actor, "pos.sale.create");
  if (own && sale.shiftOpen) return { ok: true, blocked: null };
  return { ok: false, blocked: own ? "shift_closed" : null };
}

/** The sale's code lines — ids and states, never a code — and whether this employee may show one now. */
export async function saleCodes(db: Db, actor: Actor, ref: string, locale: Locale): Promise<SaleCodesView> {
  const sale = await saleFor(db, actor, ref);
  const lines = await orderDigitalLines(db, { id: sale.id, paymentStatus: sale.paymentStatus, status: sale.status }, locale);
  const right = revealRight(actor, sale);
  return { ref: sale.ref, isDemo: sale.isDemo, lines, canReveal: right.ok && lines.some((line) => line.codes.some((code) => code.status === "delivered")), revealBlocked: right.blocked };
}

/** One code of a till sale, decrypted for the customer at the counter (file header). Audited by the core. */
export async function revealSaleCode(db: Db, dataKey: string | null | undefined, actor: Actor, input: { ref: string; codeId: string }, now: number): Promise<CodeRevealResult> {
  const sale = await saleFor(db, actor, input.ref);
  const right = revealRight(actor, sale);
  if (!right.ok) {
    if (right.blocked === "shift_closed") throw new AppError("code_reveal_closed", 403, { detail: sale.ref });
    throw notFound("receipt");
  }
  return revealOrderCode(db, dataKey, { order: { id: sale.id, ref: sale.ref }, codeId: typeof input.codeId === "string" ? input.codeId : "", actor }, now);
}

/** What the till says right after a sale: how many code units it has, delivered and still waiting (null: no code line). */
export async function saleCodeSummary(db: Db, orderId: string, locale: Locale): Promise<{ lines: number; delivered: number; pending: number } | null> {
  const order = await db.select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus }).from(orders).where(eq(orders.id, orderId)).get();
  if (!order) return null;
  const lines = await orderDigitalLines(db, order, locale);
  if (lines.length === 0) return null;
  return {
    lines: lines.length,
    delivered: lines.reduce((sum, line) => sum + line.codes.filter((code) => code.status === "delivered").length, 0),
    pending: lines.reduce((sum, line) => sum + line.pending, 0),
  };
}
