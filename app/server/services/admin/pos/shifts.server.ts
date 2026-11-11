/**
 * Admin 06.02 — shifts and the cash drawer.
 *
 *   await openShift(db, actor, { registerId, openingFloatIqd: 100_000, denominations, idempotencyKey }, now);
 *   await moveCash(db, actor, { shiftId, kind: "drop", amountIqd: 500_000, reason: "إلى الخزنة", idempotencyKey }, now);
 *   await closeShift(db, actor, { shiftId, denominations: { "25000": 12, "10000": 7 }, idempotencyKey }, now);   // blind
 *   await reviewShift(db, otherActor, { shiftId, expectedVarianceIqd: -5_000, note: "…" }, now);                 // two people
 *
 * RULES
 *   · One open shift per register (database: UNIQUE partial index) and per employee. The drawer belongs to whoever
 *     opened it: only they sell, move cash and close it — or a supervisor (pos.shift.review) who takes it over.
 *   · Expected cash = opening float + Σ cash_movements (append-only): cash sales, refunds paid out, pay-ins,
 *     pay-outs, drops. Computed inside the closing UPDATE itself, so a sale racing the close is either in the
 *     count or refused (the sale's batch requires the shift open, or — counted, unreviewed — moves its figures).
 *   · BLIND COUNT: the drawer's owner never receives the expected cash, the cash sales total, the sales by method or
 *     the variance — not while the shift is open, not after (page data, JSON, print) — and that holds for a
 *     supervisor working a till too (`seesShiftFigures`; review 2026-11-11: a manager's own drawer used to show its
 *     expected cash, so they could count exactly that and close with no difference nobody would ever review).
 *     Other supervisors (pos.shift.review) see everything.
 *   · A difference is approved by a second person (pos.shift.review, never the employee who opened or closed the
 *     shift) with a note; approving posts it once: short → Dr cash over/short / Cr cash, over → the reverse
 *     (ref_type "pos_shift", key "pos_shift:<id>:variance"). Pay-ins, pay-outs and drops move cash between the
 *     drawer and the store's safe (both in the "cash" account): no posting. Spending from the drawer is an expense in
 *     finance (10.05, paid from cash).
 *   · Every change is one guarded batch with an audit event (pos.shift.open / close / review, pos.cash.<kind>). Opening
 *     re-checks inside its batch that the register is still on and still sells from an active store location (a
 *     register switched off in between gets no shift). A key that comes back with other figures (another register or
 *     float, another kind or amount of cash move) is `idempotency_mismatch`, never a silent "replayed".
 *
 * Errors: forbidden (403), not_found (404), invalid (400), shift_already_open, register_busy, pos_register_inactive,
 * pos_location_invalid, shift_not_open, shift_not_in_review, shift_changed, drawer_short, idempotency_mismatch (409),
 * shift_self_review (403).
 */
import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { type Locale } from "~/lib/locales";
import { actorRef, assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { cashMovements, employees, inventoryLocations, orders, payments, posRegisters, posShifts } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { journalStatements, mapPostingError, postedBy } from "../../accounting/post.server";
import { assertAny, employeeNames, ID_PATTERN, KEY_PATTERN, person, POS_READERS } from "./shared.server";
import {
  baghdadDayRange,
  CASH_MOVE_KINDS,
  IQD_DENOMINATIONS,
  MAX_DRAWER_IQD,
  shiftStateOf,
  type ShiftFilters,
  type ShiftListRow,
  type ShiftReport,
  type ShiftView,
  type TillMethod,
} from "./types";

export const SHIFT_ERROR_KEYS = ["shift_already_open", "register_busy", "shift_not_open", "shift_not_in_review", "shift_changed", "drawer_short", "shift_self_review", "count_mismatch", "idempotency_mismatch"] as const;

const PAGE_SIZE = 25;
const idSchema = z.string({ error: "required" }).regex(ID_PATTERN, "invalid");
const amount = z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(MAX_DRAWER_IQD, "too_big");
const reasonText = z.string({ error: "required" }).overwrite(cleanLine).trim().min(3, "reason_required").max(300, "too_long");
const DenominationsInput = z
  .record(z.string(), z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(100_000, "too_big"))
  .refine((value) => Object.keys(value).every((key) => (IQD_DENOMINATIONS as readonly number[]).includes(Number(key))), "invalid");

/** Σ count × note value. */
export function denominationTotal(denominations: Record<string, number>): number {
  return Object.entries(denominations).reduce((sum, [note, count]) => sum + Number(note) * count, 0);
}

/** Expected cash of a shift, as SQL (opening float + every cash movement). */
const expectedSql = (shiftId: SQL | string) =>
  sql`(SELECT s.opening_float_iqd + coalesce((SELECT sum(m.amount_iqd) FROM cash_movements AS m WHERE m.shift_id = s.id), 0) FROM pos_shifts AS s WHERE s.id = ${shiftId})`;

async function shiftRow(db: Db, shiftId: string) {
  const row = await db
    .select({ shift: posShifts, register: posRegisters })
    .from(posShifts)
    .innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId))
    .where(eq(posShifts.id, shiftId))
    .get();
  if (!row) throw notFound("pos_shift");
  return row;
}

/** The drawer's owner, or a supervisor taking it over. */
function assertDrawer(actor: Actor, shift: { openedBy: string }): void {
  if (actor.kind === "employee" && shift.openedBy !== actor.id && !can(actor, "pos.shift.review")) throw forbidden("pos.shift.review");
}

/**
 * Whether the actor receives a shift's money figures (expected cash, cash sales, sales by method, discounts, the
 * difference): supervisors (pos.shift.review) only — and never the employee whose drawer it is, a supervisor working
 * a till included (blind count; the person who approves a difference must not be the only one who saw the figure).
 */
export function seesShiftFigures(actor: Actor, shift: { openedBy: string }): boolean {
  return can(actor, "pos.shift.review") && !(actor.kind === "employee" && shift.openedBy === actor.id);
}

const idempotencyMismatch = () => new AppError("idempotency_mismatch", 409);

const isDemoEmployee = async (db: Db, id: string) => Boolean((await db.select({ isDemo: employees.isDemo }).from(employees).where(eq(employees.id, id)).get())?.isDemo);

// ───────────────────────────────────────────────────────────────── open

export type OpenShiftForm = {
  mine: ShiftView | null;
  registers: { id: string; code: string; name: string; location: string; busy: boolean }[];
};

/** What the "open a shift" form offers: the employee's open shift (if any) and the registers they may open. */
export async function openShiftForm(db: Db, actor: Actor, locale: Locale): Promise<OpenShiftForm> {
  assertAny(actor, POS_READERS);
  const branchId = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const rows = await db
    .select({ register: posRegisters, location: inventoryLocations })
    .from(posRegisters)
    .innerJoin(inventoryLocations, eq(inventoryLocations.id, posRegisters.locationId))
    .where(and(eq(posRegisters.isActive, true), eq(inventoryLocations.kind, "store"), eq(inventoryLocations.isActive, true), branchId ? eq(posRegisters.branchId, branchId) : undefined))
    .orderBy(asc(posRegisters.code));
  const busy = rows.length ? await db.select({ registerId: posShifts.registerId }).from(posShifts).where(and(inArray(posShifts.registerId, rows.map((row) => row.register.id)), eq(posShifts.status, "open"))) : [];
  return {
    mine: await myShift(db, actor, locale),
    registers: rows.map(({ register, location }) => ({ id: register.id, code: register.code, name: register.name, location: `${location.code} · ${location.name}`, busy: busy.some((row) => row.registerId === register.id) })),
  };
}

export const OpenShiftInput = z.object({
  registerId: idSchema,
  openingFloatIqd: amount,
  denominations: DenominationsInput.optional(),
  notes: z.string().overwrite(cleanBlock).trim().max(500, "too_long").nullish().transform((value) => value || null),
  idempotencyKey: z.string().regex(KEY_PATTERN, "invalid"),
});

export async function openShift(db: Db, actor: Actor, raw: z.input<typeof OpenShiftInput>, now: number): Promise<{ shiftId: string; replayed: boolean }> {
  assertCan(actor, "pos.shift.open");
  const input = OpenShiftInput.parse(raw);
  if (input.denominations && denominationTotal(input.denominations) !== input.openingFloatIqd) throw invalid({ openingFloatIqd: "count_mismatch" });
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const shiftId = `psh_${(await sha256Hex(`tamtam.pos.shift.v1|${actorId}|${input.idempotencyKey}`)).slice(0, 26)}`;
  /** The shift this key opened before: the same register and float replay it; other figures are refused. */
  const replayOf = async () => {
    const existing = await db.select({ id: posShifts.id, registerId: posShifts.registerId, openingFloatIqd: posShifts.openingFloatIqd }).from(posShifts).where(eq(posShifts.id, shiftId)).get();
    if (!existing) return null;
    if (existing.registerId !== input.registerId || existing.openingFloatIqd !== input.openingFloatIqd) throw idempotencyMismatch();
    return { shiftId: existing.id, replayed: true };
  };
  const earlier = await replayOf();
  if (earlier) return earlier;

  const register = await db
    .select({ register: posRegisters, location: inventoryLocations })
    .from(posRegisters)
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, posRegisters.locationId))
    .where(eq(posRegisters.id, input.registerId))
    .get();
  if (!register) throw notFound("pos_register");
  assertBranch(actor, register.register.branchId);
  if (!register.register.isActive) throw new AppError("pos_register_inactive", 409, { fields: { registerId: "pos_register_inactive" } });
  if (!register.location || register.location.kind !== "store" || !register.location.isActive || !register.location.isSellable) throw new AppError("pos_location_invalid", 409, { fields: { registerId: "pos_location_invalid" } });
  const mine = await db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.openedBy, actorId), eq(posShifts.status, "open"))).get();
  if (mine) throw new AppError("shift_already_open", 409, { detail: mine.id });

  try {
    await runBatch(db, [
      // The register was read above: it must still be on and still sell from an active, sellable store location now
      // (a manager switching it off or moving it in between leaves no open shift on it).
      expectThat(
        db,
        sql`EXISTS (SELECT 1 FROM pos_registers AS r JOIN inventory_locations AS l ON l.id = r.location_id
          WHERE r.id = ${input.registerId} AND r.is_active = 1 AND l.kind = 'store' AND l.is_active = 1 AND l.is_sellable = 1)`,
        { code: "REGISTER_CHANGED", detail: input.registerId },
      ),
      db.insert(posShifts).values({ id: shiftId, registerId: input.registerId, openedBy: actorId, openedAt: now, openingFloatIqd: input.openingFloatIqd, status: "open", denominations: null, notes: input.notes }),
      // One open drawer per employee (also for two tabs at once).
      expectThat(db, sql`(SELECT count(*) FROM pos_shifts WHERE opened_by = ${actorId} AND status = 'open') = 1`, { code: "SHIFT_ALREADY_OPEN", detail: actorId }),
      auditStatement(db, {
        actor,
        action: "pos.shift.open",
        entityType: "pos_shift",
        entityId: shiftId,
        summary: `${register.register.code}: shift opened with ${input.openingFloatIqd} IQD`,
        after: { registerId: input.registerId, openingFloatIqd: input.openingFloatIqd, denominations: input.denominations ?? null },
        at: now,
      }),
    ]);
  } catch (error) {
    const again = await replayOf();
    if (again) return again;
    if (isDbError(error, "REGISTER_CHANGED")) throw new AppError("pos_register_inactive", 409, { fields: { registerId: "pos_register_inactive" } });
    if (isUniqueViolation(error) || isDbError(error, "UNIQUE")) throw new AppError("register_busy", 409, { fields: { registerId: "register_busy" } });
    if (isDbError(error, "SHIFT_ALREADY_OPEN")) throw new AppError("shift_already_open", 409);
    throw error;
  }
  return { shiftId, replayed: false };
}

// ───────────────────────────────────────────────────────────────── cash in and out

export const MoveCashInput = z.object({
  shiftId: idSchema,
  kind: z.enum(CASH_MOVE_KINDS),
  amountIqd: amount.refine((value) => value > 0, "too_small"),
  reason: reasonText,
  idempotencyKey: z.string().regex(KEY_PATTERN, "invalid"),
});

/** Cash into the drawer (pay_in) or out of it (pay_out, drop to the safe). Never takes the drawer below zero. */
export async function moveCash(db: Db, actor: Actor, raw: z.input<typeof MoveCashInput>, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "pos.cash.move");
  const input = MoveCashInput.parse(raw);
  const key = `pos_move:${input.idempotencyKey}`;
  const signed = input.kind === "pay_in" ? input.amountIqd : -input.amountIqd;
  /** The move this key recorded before: the same shift, kind and amount replay it; other figures are refused. */
  const replayOf = async () => {
    const earlier = await db.select({ shiftId: cashMovements.shiftId, kind: cashMovements.kind, amountIqd: cashMovements.amountIqd }).from(cashMovements).where(eq(cashMovements.idempotencyKey, key)).get();
    if (!earlier) return null;
    if (earlier.shiftId !== input.shiftId || earlier.kind !== input.kind || earlier.amountIqd !== signed) throw idempotencyMismatch();
    return { replayed: true };
  };
  const earlier = await replayOf();
  if (earlier) return earlier;
  const { shift, register } = await shiftRow(db, input.shiftId);
  assertBranch(actor, register.branchId);
  assertDrawer(actor, shift);
  if (shift.status !== "open") throw new AppError("shift_not_open", 409);
  const { actorKind, actorId } = actorRef(actor);
  const statements: BatchStatement[] = [
    expectThat(db, sql`EXISTS (SELECT 1 FROM pos_shifts WHERE id = ${shift.id} AND status = 'open')`, { code: "SHIFT_NOT_OPEN", detail: shift.id }),
    db.insert(cashMovements).values({ id: newId("cmv"), shiftId: shift.id, kind: input.kind, amountIqd: signed, reason: input.reason, actorKind, actorId, idempotencyKey: key, at: now }),
  ];
  if (signed < 0) statements.push(expectThat(db, sql`${expectedSql(shift.id)} >= 0`, { code: "DRAWER_SHORT", detail: shift.id }));
  statements.push(
    auditStatement(db, { actor, action: `pos.cash.${input.kind}`, entityType: "pos_shift", entityId: shift.id, summary: `${register.code}: ${input.kind} ${input.amountIqd} IQD`, after: { kind: input.kind, amountIqd: signed }, reason: input.reason, at: now }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    // Two requests with one key at once: the other one recorded it (the same figures) — or other figures (refused).
    const raced = await replayOf();
    if (raced) return raced;
    if (isUniqueViolation(error, "cash_movements.idempotency_key") || isUniqueViolation(error, "cash_movements.id")) return { replayed: true };
    if (isDbError(error, "DRAWER_SHORT")) throw new AppError("drawer_short", 409, { fields: { amountIqd: "drawer_short" } });
    if (isDbError(error, "SHIFT_NOT_OPEN")) throw new AppError("shift_not_open", 409);
    throw error;
  }
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── close (blind count)

export const CloseShiftInput = z
  .object({
    shiftId: idSchema,
    denominations: DenominationsInput.optional(),
    /** Without a breakdown: the counted total. */
    countedCashIqd: amount.optional(),
    notes: z.string().overwrite(cleanBlock).trim().max(500, "too_long").nullish().transform((value) => value || null),
  })
  .refine((value) => value.denominations !== undefined || value.countedCashIqd !== undefined, { message: "count_required", path: ["countedCashIqd"] });

/**
 * Counts the drawer and closes the shift. The drawer's owner is never told the expected amount: the result says only
 * whether a supervisor has to review a difference (`varianceIqd` only for a supervisor closing someone else's drawer).
 */
export async function closeShift(db: Db, actor: Actor, raw: z.input<typeof CloseShiftInput>, now: number): Promise<{ needsReview: boolean; varianceIqd: number | null; replayed: boolean }> {
  assertCan(actor, "pos.shift.close");
  const input = CloseShiftInput.parse(raw);
  const counted = input.denominations ? denominationTotal(input.denominations) : (input.countedCashIqd as number);
  if (input.denominations && input.countedCashIqd !== undefined && input.countedCashIqd !== counted) throw invalid({ countedCashIqd: "count_mismatch" });
  if (counted > MAX_DRAWER_IQD) throw invalid({ countedCashIqd: "too_big" });
  const { shift, register } = await shiftRow(db, input.shiftId);
  assertBranch(actor, register.branchId);
  assertDrawer(actor, shift);
  // The difference only for a supervisor closing someone else's drawer — never for the drawer's owner (blind count).
  const reviewer = seesShiftFigures(actor, shift);
  const closer = actor.kind === "employee" ? actor.id : "system";
  if (shift.status !== "open") {
    if (shift.closedBy === closer && shift.countedCashIqd === counted) return { needsReview: (shift.varianceIqd ?? 0) !== 0 && !shift.approvedBy, varianceIqd: reviewer ? shift.varianceIqd : null, replayed: true };
    throw new AppError("shift_not_open", 409);
  }
  try {
    await runBatch(db, [
      db
        .update(posShifts)
        .set({
          status: "closed",
          closedBy: closer,
          closedAt: now,
          countedCashIqd: counted,
          expectedCashIqd: sql`${posShifts.openingFloatIqd} + coalesce((SELECT sum(m.amount_iqd) FROM cash_movements AS m WHERE m.shift_id = ${posShifts.id}), 0)`,
          varianceIqd: sql`${counted} - (${posShifts.openingFloatIqd} + coalesce((SELECT sum(m.amount_iqd) FROM cash_movements AS m WHERE m.shift_id = ${posShifts.id}), 0))`,
          denominations: input.denominations ?? null,
          notes: input.notes ?? shift.notes,
        })
        .where(and(eq(posShifts.id, shift.id), eq(posShifts.status, "open"))),
      expectChanged(db, 1, { code: "SHIFT_CHANGED", detail: shift.id }),
      auditStatement(db, { actor, action: "pos.shift.close", entityType: "pos_shift", entityId: shift.id, summary: `${register.code}: drawer counted ${counted} IQD`, after: { countedCashIqd: counted, denominations: input.denominations ?? null }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "SHIFT_CHANGED")) throw new AppError("shift_not_open", 409);
    throw error;
  }
  const after = await db.select({ varianceIqd: posShifts.varianceIqd, expectedCashIqd: posShifts.expectedCashIqd }).from(posShifts).where(eq(posShifts.id, shift.id)).get();
  // The trail keeps what the system expected (readers of the audit trail are allowed to see it).
  await runBatch(db, [auditStatement(db, { actor, action: "pos.shift.variance", entityType: "pos_shift", entityId: shift.id, after: { expectedCashIqd: after?.expectedCashIqd ?? null, varianceIqd: after?.varianceIqd ?? null }, at: now })]);
  const variance = after?.varianceIqd ?? 0;
  return { needsReview: variance !== 0, varianceIqd: reviewer ? variance : null, replayed: false };
}

// ───────────────────────────────────────────────────────────────── review (second person)

export const ReviewShiftInput = z.object({
  shiftId: idSchema,
  /** The difference the reviewer saw (a recount or a late sale since → shift_changed). */
  expectedVarianceIqd: z.number({ error: "invalid" }).int("invalid"),
  note: reasonText,
});

/** Approves a counted difference and posts it to cash over/short — never by the employee who opened or closed the shift. */
export async function reviewShift(db: Db, actor: Actor, raw: z.input<typeof ReviewShiftInput>, now: number): Promise<{ replayed: boolean; journalEntryId: string | null }> {
  assertCan(actor, "pos.shift.review");
  const input = ReviewShiftInput.parse(raw);
  const { shift, register } = await shiftRow(db, input.shiftId);
  assertBranch(actor, register.branchId);
  const reviewer = actor.kind === "employee" ? actor.id : "system";
  if (shift.approvedBy) {
    if (shift.approvedBy === reviewer) return { replayed: true, journalEntryId: null };
    throw new AppError("shift_not_in_review", 409);
  }
  if (shift.status !== "closed" || (shift.varianceIqd ?? 0) === 0) throw new AppError("shift_not_in_review", 409);
  if (actor.kind === "employee" && (shift.openedBy === actor.id || shift.closedBy === actor.id)) throw new AppError("shift_self_review", 403);
  if (shift.varianceIqd !== input.expectedVarianceIqd) throw new AppError("shift_changed", 409, { detail: `${shift.varianceIqd}` });
  const variance = shift.varianceIqd as number;
  const demoOrders = await db.select({ demo: sql<number>`sum(CASE WHEN ${orders.isDemo} THEN 1 ELSE 0 END)`, all: sql<number>`count(*)` }).from(orders).where(eq(orders.posShiftId, shift.id)).get();
  const isDemo = (await isDemoEmployee(db, shift.openedBy)) || (Number(demoOrders?.all ?? 0) > 0 && Number(demoOrders?.demo ?? 0) === Number(demoOrders?.all ?? 0));
  const posting = journalStatements(db, {
    at: now,
    memo: `POS shift ${register.code}: cash ${variance < 0 ? "short" : "over"} ${Math.abs(variance)} IQD`,
    refType: "pos_shift",
    refId: shift.id,
    createdBy: postedBy(actor),
    idempotencyKey: `pos_shift:${shift.id}:variance`,
    isDemo,
    lines:
      variance < 0
        ? [
            { accountCode: "cash_over_short", debitIqd: -variance },
            { accountCode: "cash", creditIqd: -variance },
          ]
        : [
            { accountCode: "cash", debitIqd: variance },
            { accountCode: "cash_over_short", creditIqd: variance },
          ],
  });
  try {
    await runBatch(db, [
      db
        .update(posShifts)
        .set({ approvedBy: reviewer, varianceReason: input.note })
        .where(and(eq(posShifts.id, shift.id), eq(posShifts.status, "closed"), sql`${posShifts.approvedBy} IS NULL`, eq(posShifts.varianceIqd, variance))),
      expectChanged(db, 1, { code: "SHIFT_CHANGED", detail: shift.id }),
      ...posting,
      auditStatement(db, { actor, action: "pos.shift.review", entityType: "pos_shift", entityId: shift.id, summary: `${register.code}: difference of ${variance} IQD approved`, before: { approvedBy: null }, after: { approvedBy: reviewer, varianceIqd: variance }, reason: input.note, at: now }),
    ]);
  } catch (error) {
    const posted = mapPostingError(error);
    if (posted) throw posted;
    if (isDbError(error, "SHIFT_CHANGED")) throw new AppError("shift_changed", 409);
    throw error;
  }
  const entry = await db.all<{ id: string }>(sql`SELECT id FROM journal_entries WHERE idempotency_key = ${`pos_shift:${shift.id}:variance`}`);
  return { replayed: false, journalEntryId: entry[0]?.id ?? null };
}

// ───────────────────────────────────────────────────────────────── reads

type ShiftJoin = { shift: typeof posShifts.$inferSelect; register: typeof posRegisters.$inferSelect; location: typeof inventoryLocations.$inferSelect | null };

async function salesOf(db: Db, shiftIds: readonly string[]): Promise<Map<string, { count: number; totalIqd: number }>> {
  if (shiftIds.length === 0) return new Map();
  const rows = await db
    .select({ shiftId: orders.posShiftId, count: sql<number>`count(*)`, total: sql<number>`coalesce(sum(${orders.totalIqd}), 0)` })
    .from(orders)
    .where(and(inArray(orders.posShiftId, [...shiftIds]), eq(orders.channel, "pos")))
    .groupBy(orders.posShiftId);
  return new Map(rows.map((row) => [row.shiftId as string, { count: Number(row.count), totalIqd: Number(row.total) }]));
}

function viewOf(row: ShiftJoin, names: Map<string, string>, sales: { count: number; totalIqd: number } | undefined, actor: Actor): ShiftView {
  const { shift, register, location } = row;
  const reviewer = seesShiftFigures(actor, shift);
  const mine = actor.kind === "employee" && shift.openedBy === actor.id;
  return {
    id: shift.id,
    state: shiftStateOf(shift),
    register: { id: register.id, code: register.code, name: register.name },
    location: location ? { id: location.id, code: location.code, name: location.name } : null,
    openedBy: person(names, shift.openedBy) ?? { id: shift.openedBy, name: shift.openedBy },
    openedAt: shift.openedAt,
    closedBy: person(names, shift.closedBy),
    closedAt: shift.closedAt,
    approvedBy: person(names, shift.approvedBy),
    openingFloatIqd: shift.openingFloatIqd,
    countedCashIqd: shift.countedCashIqd,
    expectedCashIqd: reviewer ? shift.expectedCashIqd : null,
    varianceIqd: reviewer ? shift.varianceIqd : null,
    varianceNote: reviewer ? shift.varianceReason : null,
    denominations: shift.denominations ?? null,
    notes: shift.notes,
    sales: { count: sales?.count ?? 0, totalIqd: reviewer ? (sales?.totalIqd ?? 0) : null },
    mine,
  };
}

async function joinShifts(db: Db, where: SQL | undefined, order: SQL[], limit?: number, offset?: number): Promise<ShiftJoin[]> {
  const query = db
    .select({ shift: posShifts, register: posRegisters, location: inventoryLocations })
    .from(posShifts)
    .innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId))
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, posRegisters.locationId))
    .where(where)
    .orderBy(...order);
  return limit === undefined ? query : query.limit(limit).offset(offset ?? 0);
}

/** The employee's open shift (any register), or null. */
export async function myShift(db: Db, actor: Actor, _locale: Locale): Promise<ShiftView | null> {
  if (actor.kind !== "employee") return null;
  const [row] = await joinShifts(db, and(eq(posShifts.openedBy, actor.id), eq(posShifts.status, "open")), [desc(posShifts.openedAt)], 1);
  if (!row) return null;
  const [names, sales] = await Promise.all([employeeNames(db, [row.shift.openedBy]), salesOf(db, [row.shift.id])]);
  return viewOf(row, names, sales.get(row.shift.id), actor);
}

export type ShiftPage = { rows: ShiftListRow[]; total: number; page: number; pageCount: number; registers: { id: string; code: string; name: string }[]; reviewer: boolean };

/** Shifts with filters in the URL; employees without pos.shift.review see their own only. */
export async function listShifts(db: Db, actor: Actor, filters: ShiftFilters, _locale: Locale): Promise<ShiftPage> {
  assertAny(actor, ["pos.shift.review", "pos.shift.open", "pos.shift.close"]);
  const reviewer = can(actor, "pos.shift.review");
  const self = actor.kind === "employee" ? actor.id : null;
  const branchId = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const conditions: (SQL | undefined)[] = [];
  if (!reviewer || filters.mine) conditions.push(self ? eq(posShifts.openedBy, self) : sql`0`);
  if (branchId) conditions.push(eq(posRegisters.branchId, branchId));
  if (filters.register) conditions.push(eq(posShifts.registerId, filters.register));
  if (filters.day) {
    const range = baghdadDayRange(filters.day);
    conditions.push(sql`${posShifts.openedAt} >= ${range.from} AND ${posShifts.openedAt} < ${range.to}`);
  }
  if (filters.state === "open") conditions.push(eq(posShifts.status, "open"));
  if (filters.state === "review") conditions.push(and(eq(posShifts.status, "closed"), ne(posShifts.varianceIqd, 0), sql`${posShifts.approvedBy} IS NULL`));
  if (filters.state === "closed") conditions.push(and(eq(posShifts.status, "closed"), or(eq(posShifts.varianceIqd, 0), sql`${posShifts.varianceIqd} IS NULL`, sql`${posShifts.approvedBy} IS NOT NULL`)));
  const where = and(...conditions);
  const totalRow = await db
    .select({ n: sql<number>`count(*)` })
    .from(posShifts)
    .innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId))
    .where(where)
    .get();
  const total = Number(totalRow?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await joinShifts(db, where, [desc(posShifts.openedAt), desc(posShifts.id)], PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const [names, sales, registers] = await Promise.all([
    employeeNames(db, rows.map((row) => row.shift.openedBy)),
    salesOf(db, rows.map((row) => row.shift.id)),
    db.select({ id: posRegisters.id, code: posRegisters.code, name: posRegisters.name }).from(posRegisters).where(branchId ? eq(posRegisters.branchId, branchId) : undefined).orderBy(asc(posRegisters.code)),
  ]);
  return {
    rows: rows.map((row) => {
      const view = viewOf(row, names, sales.get(row.shift.id), actor);
      return { id: view.id, state: view.state, register: view.register, openedBy: view.openedBy, openedAt: view.openedAt, closedAt: view.closedAt, openingFloatIqd: view.openingFloatIqd, countedCashIqd: view.countedCashIqd, expectedCashIqd: view.expectedCashIqd, varianceIqd: view.varianceIqd, sales: view.sales, mine: view.mine };
    }),
    total,
    page,
    pageCount,
    registers,
    reviewer,
  };
}

/** Closed shifts with a difference this employee may approve (not their own), for the module's tab and home. */
export async function countReviewable(db: Db, actor: Actor): Promise<number | null> {
  if (!can(actor, "pos.shift.review")) return null;
  const self = actor.kind === "employee" ? actor.id : "";
  const branchId = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(posShifts)
    .innerJoin(posRegisters, eq(posRegisters.id, posShifts.registerId))
    .where(and(eq(posShifts.status, "closed"), ne(posShifts.varianceIqd, 0), sql`${posShifts.approvedBy} IS NULL`, ne(posShifts.openedBy, self), sql`coalesce(${posShifts.closedBy}, '') <> ${self}`, branchId ? eq(posRegisters.branchId, branchId) : undefined))
    .get();
  return Number(row?.n ?? 0);
}

/** The shift report (Z report): sales by method, discounts, cash moves, the count — money figures for supervisors only, never for the drawer's owner. */
export async function shiftReport(db: Db, actor: Actor, shiftId: string, _locale: Locale): Promise<ShiftReport> {
  assertAny(actor, ["pos.shift.review", "pos.shift.open", "pos.shift.close"]);
  const [row] = await joinShifts(db, eq(posShifts.id, shiftId), [asc(posShifts.id)], 1);
  if (!row) throw notFound("pos_shift");
  assertBranch(actor, row.register.branchId);
  const reviewer = can(actor, "pos.shift.review");
  if (!reviewer && !(actor.kind === "employee" && row.shift.openedBy === actor.id)) throw notFound("pos_shift");
  const [moves, methodRows, discountRow, sales] = await Promise.all([
    db
      .select({ id: cashMovements.id, kind: cashMovements.kind, amountIqd: cashMovements.amountIqd, reason: cashMovements.reason, at: cashMovements.at, actorId: cashMovements.actorId, orderRef: orders.ref })
      .from(cashMovements)
      .leftJoin(orders, eq(orders.id, cashMovements.orderId))
      .where(eq(cashMovements.shiftId, shiftId))
      .orderBy(asc(cashMovements.at), asc(cashMovements.id)),
    db
      .select({ method: payments.method, count: sql<number>`count(*)`, total: sql<number>`coalesce(sum(${payments.amountIqd}), 0)` })
      .from(payments)
      .where(and(eq(payments.posShiftId, shiftId), eq(payments.status, "paid")))
      .groupBy(payments.method),
    db.all<{ lines: number; lineIqd: number; orderIqd: number; sales: number }>(sql`
      SELECT
        (SELECT count(*) FROM order_items AS i JOIN orders AS o ON o.id = i.order_id WHERE o.pos_shift_id = ${shiftId} AND i.discount_iqd > 0) AS lines,
        (SELECT coalesce(sum(i.discount_iqd), 0) FROM order_items AS i JOIN orders AS o ON o.id = i.order_id WHERE o.pos_shift_id = ${shiftId}) AS lineIqd,
        (SELECT coalesce(sum(o.discount_iqd), 0) FROM orders AS o WHERE o.pos_shift_id = ${shiftId}) AS orderIqd,
        (SELECT count(*) FROM orders AS o WHERE o.pos_shift_id = ${shiftId} AND (o.discount_iqd > 0 OR EXISTS (SELECT 1 FROM order_items AS i WHERE i.order_id = o.id AND i.discount_iqd > 0))) AS sales`),
    salesOf(db, [shiftId]),
  ]);
  const names = await employeeNames(db, [row.shift.openedBy, row.shift.closedBy, row.shift.approvedBy, ...moves.map((move) => move.actorId)]);
  const view = viewOf(row, names, sales.get(shiftId), actor);
  const sum = (kind: string) => moves.filter((move) => move.kind === kind).reduce((total, move) => total + move.amountIqd, 0);
  const expected = row.shift.openingFloatIqd + moves.reduce((total, move) => total + move.amountIqd, 0);
  const discount = discountRow[0];
  const self = actor.kind === "employee" ? actor.id : "";
  // Money figures: supervisors only, and never the drawer's owner (a supervisor's own till included) — blind count.
  const figures = seesShiftFigures(actor, row.shift);
  return {
    ...view,
    cash: figures
      ? { expectedIqd: row.shift.status === "open" ? expected : row.shift.expectedCashIqd, salesIqd: sum("sale"), refundsIqd: sum("refund"), payInIqd: sum("pay_in"), payOutIqd: sum("pay_out"), dropIqd: sum("drop") }
      : { expectedIqd: null, salesIqd: null, refundsIqd: null, payInIqd: null, payOutIqd: null, dropIqd: null },
    byMethod: figures ? methodRows.map((entry) => ({ method: entry.method as TillMethod, count: Number(entry.count), totalIqd: Number(entry.total) })) : null,
    discounts: figures && discount ? { lines: Number(discount.lines), lineIqd: Number(discount.lineIqd), orderIqd: Number(discount.orderIqd), sales: Number(discount.sales) } : null,
    // The drawer's owner sees what they moved by hand, never the sales' cash (blind count).
    moves: moves
      .filter((move) => figures || move.kind !== "sale")
      .map((move) => ({ id: move.id, kind: move.kind, amountIqd: move.amountIqd, reason: move.reason, at: move.at, by: names.get(move.actorId ?? "") ?? move.actorId ?? "", orderRef: move.orderRef })),
    canReview: reviewer && view.state === "review" && row.shift.openedBy !== self && row.shift.closedBy !== self,
    reviewBlocked: reviewer && view.state === "review" && (row.shift.openedBy === self || row.shift.closedBy === self) ? "own_shift" : null,
  };
}
