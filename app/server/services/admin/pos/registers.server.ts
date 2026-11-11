/**
 * Admin 06 — registers (tills): which store location a till sells from, its branch, on / off.
 *
 *   await saveRegister(db, actor, { code: "TILL-1", name: "الكاشير 1", locationId, branchId: null, isActive: true, reason }, now);
 *
 * A register sells from ONE inventory location of kind "store" (and the shelves under it): the shop's stock is the
 * website's stock (the same stock_levels rows, through the commerce core). Changing the location or switching a
 * register off while a shift is open on it is refused (its sales would move to another stock mid-shift).
 * Writes need pos.register.manage; a branch-limited employee manages their branch's registers only. Audited
 * (pos.register.create / pos.register.update, before/after, reason).
 *
 * Errors: forbidden (403), not_found (404), invalid (400: code_invalid, name, location_not_store, branch_invalid,
 * reason_required), code_taken (409), register_has_open_shift (409), register_changed (409).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertBranch, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { branches, inventoryLocations, posRegisters, posShifts } from "~/server/db/schema";
import { expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { assertAny, employeeNames, ID_PATTERN, POS_READERS } from "./shared.server";
import { latinDigits, type RegisterRow } from "./types";

export const REGISTER_ERROR_KEYS = ["code_taken", "register_has_open_shift", "register_changed"] as const;

export async function listRegisters(db: Db, actor: Actor, locale: Locale): Promise<RegisterRow[]> {
  assertAny(actor, POS_READERS);
  const branchId = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const rows = await db
    .select({ register: posRegisters, location: inventoryLocations })
    .from(posRegisters)
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, posRegisters.locationId))
    .where(branchId ? eq(posRegisters.branchId, branchId) : undefined)
    .orderBy(asc(posRegisters.code));
  const ids = rows.map((row) => row.register.id);
  const [open, branchRows] = await Promise.all([
    ids.length ? db.select({ id: posShifts.id, registerId: posShifts.registerId, openedBy: posShifts.openedBy, openedAt: posShifts.openedAt }).from(posShifts).where(and(inArray(posShifts.registerId, ids), eq(posShifts.status, "open"))) : Promise.resolve([]),
    db.select({ id: branches.id, code: branches.code, name: branches.name }).from(branches),
  ]);
  const names = await employeeNames(db, open.map((row) => row.openedBy));
  return rows.map(({ register, location }) => {
    const shift = open.find((row) => row.registerId === register.id);
    const branch = branchRows.find((row) => row.id === register.branchId);
    return {
      id: register.id,
      code: register.code,
      name: register.name,
      isActive: register.isActive,
      branch: branch ? { id: branch.id, code: branch.code, name: pick(branch.name, locale) || branch.code } : null,
      location: location ? { id: location.id, code: location.code, name: location.name, kind: location.kind, isActive: location.isActive } : null,
      openShift: shift ? { id: shift.id, openedBy: names.get(shift.openedBy) ?? shift.openedBy, openedAt: shift.openedAt } : null,
    };
  });
}

export type RegisterFormOptions = { locations: { id: string; code: string; name: string }[]; branches: { id: string; code: string; name: string }[] };

/** Store locations (kind "store", active, sellable) and branches a register may use. */
export async function registerFormOptions(db: Db, actor: Actor, locale: Locale): Promise<RegisterFormOptions> {
  assertCan(actor, "pos.register.manage");
  const branchId = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const [locations, branchRows] = await Promise.all([
    db
      .select({ id: inventoryLocations.id, code: inventoryLocations.code, name: inventoryLocations.name })
      .from(inventoryLocations)
      .where(and(eq(inventoryLocations.kind, "store"), eq(inventoryLocations.isActive, true), eq(inventoryLocations.isSellable, true), branchId ? eq(inventoryLocations.branchId, branchId) : undefined))
      .orderBy(asc(inventoryLocations.code)),
    db.select({ id: branches.id, code: branches.code, name: branches.name, isActive: branches.isActive }).from(branches).orderBy(asc(branches.code)),
  ]);
  return {
    locations,
    branches: branchRows.filter((row) => row.isActive && (!branchId || row.id === branchId)).map((row) => ({ id: row.id, code: row.code, name: pick(row.name, locale) || row.code })),
  };
}

const CODE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

export const SaveRegisterInput = z.object({
  registerId: z.string().regex(ID_PATTERN, "invalid").optional(),
  code: z
    .string({ error: "required" })
    .transform((value) => latinDigits(value).trim().toUpperCase())
    .refine((value) => CODE.test(value), "code_invalid"),
  name: z.string({ error: "required" }).overwrite(cleanLine).trim().min(2, "required").max(80, "too_long"),
  locationId: z.string({ error: "required" }).regex(ID_PATTERN, "required"),
  branchId: z
    .string()
    .regex(ID_PATTERN, "invalid")
    .nullish()
    .or(z.literal(""))
    .transform((value) => value || null),
  isActive: z.boolean().default(true),
  reason: z.string().overwrite(cleanLine).trim().max(300, "too_long").nullish().transform((value) => value || null),
});
export type SaveRegisterInput = z.input<typeof SaveRegisterInput>;

/** Creates (no registerId) or changes a register. Returns its id and whether anything changed. */
export async function saveRegister(db: Db, actor: Actor, raw: SaveRegisterInput, now: number): Promise<{ registerId: string; changed: boolean }> {
  assertCan(actor, "pos.register.manage");
  const input = SaveRegisterInput.parse(raw);
  assertBranch(actor, input.branchId);
  const location = await db.select().from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)).get();
  if (!location || location.kind !== "store" || !location.isActive || !location.isSellable) throw invalid({ locationId: "location_not_store" });
  if (actor.kind === "employee" && actor.branchId != null && location.branchId !== actor.branchId) throw invalid({ locationId: "location_not_store" });
  if (input.branchId) {
    const branch = await db.select({ id: branches.id, isActive: branches.isActive }).from(branches).where(eq(branches.id, input.branchId)).get();
    if (!branch || !branch.isActive) throw invalid({ branchId: "branch_invalid" });
  }
  const fields = { code: input.code, name: input.name, locationId: input.locationId, branchId: input.branchId, isActive: input.isActive };

  if (!input.registerId) {
    const same = await db.select().from(posRegisters).where(eq(posRegisters.code, input.code)).get();
    if (same) {
      // A double submit of the same form: nothing new to do.
      if (same.name === input.name && same.locationId === input.locationId && same.branchId === input.branchId && same.isActive === input.isActive) return { registerId: same.id, changed: false };
      throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
    }
    const id = newId("reg");
    try {
      await runBatch(db, [
        db.insert(posRegisters).values({ id, ...fields, createdAt: now }),
        auditStatement(db, { actor, action: "pos.register.create", entityType: "pos_register", entityId: id, after: fields, reason: input.reason, at: now }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, "pos_registers.code")) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
      throw error;
    }
    return { registerId: id, changed: true };
  }

  const before = await db.select().from(posRegisters).where(eq(posRegisters.id, input.registerId)).get();
  if (!before) throw notFound("pos_register");
  assertBranch(actor, before.branchId);
  const unchanged = before.code === input.code && before.name === input.name && before.locationId === input.locationId && before.branchId === input.branchId && before.isActive === input.isActive;
  if (unchanged) return { registerId: before.id, changed: false };
  if (!input.reason || input.reason.length < 3) throw invalid({ reason: "reason_required" });
  const moves = before.locationId !== input.locationId || (before.isActive && !input.isActive);
  if (moves) {
    const open = await db.select({ id: posShifts.id }).from(posShifts).where(and(eq(posShifts.registerId, before.id), eq(posShifts.status, "open"))).get();
    if (open) throw new AppError("register_has_open_shift", 409, { detail: open.id });
  }
  const taken = await db.select({ id: posRegisters.id }).from(posRegisters).where(and(eq(posRegisters.code, input.code), ne(posRegisters.id, before.id))).get();
  if (taken) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
  try {
    await runBatch(db, [
      db
        .update(posRegisters)
        .set(fields)
        .where(and(eq(posRegisters.id, before.id), eq(posRegisters.code, before.code), eq(posRegisters.isActive, before.isActive), before.locationId ? eq(posRegisters.locationId, before.locationId) : sql`${posRegisters.locationId} IS NULL`)),
      expectChanged(db, 1, { code: "REGISTER_CHANGED", detail: before.id }),
      // Never move or switch off a register under an open shift (checked again inside the batch).
      ...(moves ? [expectChangedNoOpenShift(db, before.id)] : []),
      auditStatement(db, {
        actor,
        action: "pos.register.update",
        entityType: "pos_register",
        entityId: before.id,
        before: { code: before.code, name: before.name, locationId: before.locationId, branchId: before.branchId, isActive: before.isActive },
        after: fields,
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "pos_registers.code")) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
    if (isDbError(error, "REGISTER_CHANGED")) throw new AppError("register_changed", 409, { detail: before.id });
    if (isDbError(error, "REGISTER_HAS_OPEN_SHIFT")) throw new AppError("register_has_open_shift", 409, { detail: before.id });
    throw error;
  }
  return { registerId: before.id, changed: true };
}

function expectChangedNoOpenShift(db: Db, registerId: string) {
  return expectThat(db, sql`NOT EXISTS (SELECT 1 FROM pos_shifts WHERE register_id = ${registerId} AND status = 'open')`, { code: "REGISTER_HAS_OPEN_SHIFT", detail: registerId });
}
