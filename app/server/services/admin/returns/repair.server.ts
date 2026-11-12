/**
 * Repairs (blueprint 12.07) with SLA timers — the staff side of the tickets the storefront opens (/support/repair,
 * source "storefront" / "assistant"), the ones opened at the counter (source "store") and the ones a return turns into
 * (source "return": the unit stays the customer's and is repaired, under warranty when one runs).
 *
 *   const page = await listRepairs(db, actor, parseRepairFilters(params), locale, now);
 *   await changeRepairStatus(db, actor, { ticketId, from: "diagnosing", to: "awaiting_approval", note }, now);
 *   await setDiagnosis(db, actor, { ticketId, diagnosis, quoteIqd: 45_000 }, now);
 *
 * WORKFLOW: types.ts REPAIR_TRANSITIONS. Receiving the device starts the SLA clock (sla_due_at = received +
 * SLA.repairDays, unless one was set); chargeable work ("repairing", from whichever status) starts, and is finished
 * ("ready"), only on a quote the customer approved (recorded by staff: quote_approved_at; a changed quote is approved
 * again) — warranty repairs and repairs without a quote excepted; the customer's answer is recorded while the ticket is
 * open; ready → completed_at; delivered → delivered_at and cost_iqd (0 under warranty, else the approved quote).
 * A repair of a return handed back REPAIRED (ready → delivered) marks that RMA "repaired"; one handed back unrepairable
 * leaves the RMA open — its unit's money may then go back through the RMA (refund.server). Every change writes a repair
 * event (the storefront's status page reads the "status" events and the quote — never notes, parts or staff names) and
 * an audit event.
 * BOUNDARIES: collecting the repair's price is not here (no payment record exists for repairs — POS / finance);
 * parts are recorded on the ticket, and taking a part out of stock is an inventory adjustment (04) with the ticket's
 * reference — see docs/areas/admin-returns.md.
 *
 * Who: returns.repair.manage for every change; reading also with returns.rma.read or returns.warranty.read.
 * Errors: forbidden (403), not_found (404), invalid (400), repair_changed · transition_not_allowed ·
 * quote_not_approved · assignee_not_technician (409).
 */
import { and, asc, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { actorRef, assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  customers,
  deviceModels,
  employeeRoles,
  employees,
  files,
  orderItems,
  orders,
  products,
  repairEvents,
  repairTickets,
  returnItems,
  returns,
  rolePermissions,
  serials,
  variants,
  warranties,
  type RepairPart,
  type RepairTicket,
} from "~/server/db/schema";
import { batchSql, expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { DAY_MS, employeeNames, phoneView, returnById, returnRepairId, slaTargets } from "./shared.server";
import { REPAIR_OPEN, REPAIR_REASON_REQUIRED, REPAIR_STATUS_LIST, REPAIR_TRANSITIONS, SLA, type EmployeeRef, type RepairDetail, type RepairFilters, type RepairListRow, type RepairStatusKey, type WarrantyState } from "./types";

export const REPAIR_ERROR_KEYS = ["repair_changed", "transition_not_allowed", "quote_not_approved", "assignee_not_technician"] as const;

const PAGE_SIZE = 25;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID, "invalid");

function readable(actor: Actor): void {
  if (!canAny(actor, ["returns.repair.manage", "returns.rma.read", "returns.warranty.read"])) throw forbidden("returns.repair.manage");
}

export function normalizeRepairRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const value = ref.trim().toUpperCase();
  return /^RP-[A-Z0-9]{4,16}$/.test(value) ? value : null;
}

async function ticketByRef(db: Db, ref: string): Promise<RepairTicket> {
  const normalized = normalizeRepairRef(ref);
  const row = normalized ? await db.select().from(repairTickets).where(eq(repairTickets.ref, normalized)).get() : undefined;
  if (!row) throw notFound("repair");
  return row;
}

async function ticketById(db: Db, id: string): Promise<RepairTicket> {
  const row = typeof id === "string" && ID.test(id) ? await db.select().from(repairTickets).where(eq(repairTickets.id, id)).get() : undefined;
  if (!row) throw notFound("repair");
  return row;
}

/** Active employees who may work on repairs (their roles grant returns.repair.manage, or everything). */
export async function technicians(db: Db): Promise<EmployeeRef[]> {
  return db
    .selectDistinct({ id: employees.id, name: employees.name })
    .from(employees)
    .innerJoin(employeeRoles, eq(employeeRoles.employeeId, employees.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, employeeRoles.roleId))
    .where(and(eq(employees.status, "active"), isNull(employees.disabledAt), sql`${rolePermissions.permission} IN ('returns.repair.manage', '*')`))
    .orderBy(employees.name);
}

const late = (row: Pick<RepairTicket, "status" | "slaDueAt">, now: number) => row.slaDueAt !== null && REPAIR_OPEN.includes(row.status as RepairStatusKey) && row.status !== "ready" && row.slaDueAt < now;

// ───────────────────────────────────────────────────────────────── list

export async function listRepairs(db: Db, actor: Actor, filters: RepairFilters, locale: Locale, now: number): Promise<{ rows: RepairListRow[]; total: number; page: number; pageCount: number; filters: RepairFilters; canManage: boolean }> {
  readable(actor);
  const me = actor.kind === "employee" ? actor.id : "";
  const open = inArray(repairTickets.status, [...REPAIR_OPEN]);
  const view: Record<RepairFilters["view"], SQL | undefined> = {
    open,
    late: and(inArray(repairTickets.status, REPAIR_OPEN.filter((status) => status !== "ready")), lt(repairTickets.slaDueAt, now)),
    mine: and(open, eq(repairTickets.assignedTo, me)),
    warranty: and(open, eq(repairTickets.isWarranty, true)),
    done: inArray(repairTickets.status, ["delivered", "unrepairable", "cancelled"]),
    all: undefined,
  };
  const text = filters.q.trim();
  let search: SQL | undefined;
  if (text) {
    const ref = normalizeRepairRef(text);
    const phone = normalizeIraqPhone(text);
    const digits = toLatinDigits(text).replace(/\D/g, "");
    if (ref) search = eq(repairTickets.ref, ref);
    else if (phone) search = eq(repairTickets.phoneE164, phone);
    else if (digits.length >= 4 && digits.length === text.replace(/[\s-]/g, "").length) search = can(actor, "customer.phone.read_full") ? sql`${repairTickets.phoneE164} LIKE ${`%${digits.slice(0, 15)}%`}` : sql`0`;
    else search = or(sql`upper(${repairTickets.serialText}) = ${text.toUpperCase().replace(/\s+/g, "").slice(0, 40)}`, sql`${repairTickets.contactName} LIKE ${`%${text.slice(0, 30).replace(/[%_]/g, "")}%`}`);
  }
  const where = and(view[filters.view], filters.status ? eq(repairTickets.status, filters.status) : undefined, search);
  const [rows, count] = await Promise.all([
    db
      .select()
      .from(repairTickets)
      .where(where)
      .orderBy(filters.view === "done" || filters.view === "all" ? desc(repairTickets.createdAt) : sql`${repairTickets.slaDueAt} IS NULL`, asc(repairTickets.slaDueAt), desc(repairTickets.createdAt))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(repairTickets).where(where).get(),
  ]);
  const modelIds = [...new Set(rows.map((row) => row.deviceModelId).filter((id): id is string => typeof id === "string"))];
  const returnIds = [...new Set(rows.map((row) => row.returnId).filter((id): id is string => typeof id === "string"))];
  const [models, rmas, names] = await Promise.all([
    modelIds.length ? db.select({ id: deviceModels.id, name: deviceModels.name }).from(deviceModels).where(inArray(deviceModels.id, modelIds)) : Promise.resolve([]),
    returnIds.length ? db.select({ id: returns.id, rma: returns.rma }).from(returns).where(inArray(returns.id, returnIds)) : Promise.resolve([]),
    employeeNames(
      db,
      rows.map((row) => row.assignedTo),
    ),
  ]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      ref: row.ref,
      status: row.status as RepairStatusKey,
      source: row.source,
      device: row.deviceModelId ? (pick(models.find((model) => model.id === row.deviceModelId)?.name ?? null, locale) || null) : row.deviceText,
      customerName: row.contactName,
      customerProfileId: customerProfileId(actor, row.customerId),
      phone: phoneView(actor, row.phoneE164),
      isWarranty: row.isWarranty,
      assignedTo: row.assignedTo ? { id: row.assignedTo, name: names.get(row.assignedTo) ?? row.assignedTo } : null,
      slaDueAt: row.slaDueAt,
      late: late(row, now),
      createdAt: row.createdAt,
      rma: rmas.find((entry) => entry.id === row.returnId)?.rma ?? null,
      isDemo: row.isDemo,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filters,
    canManage: can(actor, "returns.repair.manage"),
  };
}

// ───────────────────────────────────────────────────────────────── one ticket

const partsOf = (parts: unknown): RepairPart[] => (Array.isArray(parts) ? (parts as RepairPart[]).filter((part) => part && typeof part.name === "string") : []);

/** A safe excerpt of an event's data (strings, numbers, booleans; never cost). */
function eventData(value: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!value || typeof value !== "object") return out;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (/cost/i.test(key) && key !== "costIqd") continue;
    if (entry === null || typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") out[key] = typeof entry === "string" ? entry.slice(0, 300) : entry;
  }
  return out;
}

export async function getRepair(db: Db, actor: Actor, ref: string, locale: Locale, now: number, urls: { file: (id: string) => string }): Promise<RepairDetail> {
  readable(actor);
  const row = await ticketByRef(db, ref);
  const [model, events, photos, warranty, rma, techs, customer] = await Promise.all([
    row.deviceModelId ? db.select({ name: deviceModels.name }).from(deviceModels).where(eq(deviceModels.id, row.deviceModelId)).get() : Promise.resolve(undefined),
    db.select().from(repairEvents).where(eq(repairEvents.ticketId, row.id)).orderBy(asc(repairEvents.at), asc(repairEvents.id)),
    db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerType, "repair_ticket"), eq(files.ownerId, row.id), isNull(files.deletedAt))),
    row.warrantyId ? db.select({ id: warranties.id, endsAt: warranties.endsAt, status: warranties.status }).from(warranties).where(eq(warranties.id, row.warrantyId)).get() : Promise.resolve(undefined),
    row.returnId ? db.select({ id: returns.id, rma: returns.rma, contactName: orders.contactName }).from(returns).innerJoin(orders, eq(orders.id, returns.orderId)).where(eq(returns.id, row.returnId)).get() : Promise.resolve(undefined),
    can(actor, "returns.repair.manage") ? technicians(db) : Promise.resolve([] as EmployeeRef[]),
    !row.contactName && row.customerId ? db.select({ name: customers.name }).from(customers).where(eq(customers.id, row.customerId)).get() : Promise.resolve(undefined),
  ]);
  const names = await employeeNames(db, [row.assignedTo, ...events.map((event) => event.actorId)]);
  const parts = partsOf(row.parts);
  const status = row.status as RepairStatusKey;
  return {
    id: row.id,
    ref: row.ref,
    status,
    source: row.source,
    device: model ? pick(model.name, locale) : null,
    deviceText: row.deviceText,
    serial: row.serialId || row.serialText ? { id: row.serialId, text: row.serialText } : null,
    // the ticket's own contact name; else the return's order contact or the customer's account name
    customer: { name: row.contactName ?? rma?.contactName ?? customer?.name ?? null, profileId: customerProfileId(actor, row.customerId), phone: phoneView(actor, row.phoneE164) },
    issue: row.issue,
    diagnosis: row.diagnosis,
    resolution: row.resolution,
    isWarranty: row.isWarranty,
    warranty: warranty ? { id: warranty.id, endsAt: warranty.endsAt, state: (warranty.status === "void" ? "void" : warranty.endsAt < now ? "expired" : "active") as WarrantyState } : null,
    rma: rma ? { id: rma.id, rma: rma.rma } : null,
    quoteIqd: row.quoteIqd,
    quoteApprovedAt: row.quoteApprovedAt,
    costIqd: row.costIqd,
    parts: parts.map((part) => ({ variantId: part.variantId ?? null, name: part.name, qty: part.qty, priceIqd: part.priceIqd, fromStock: false })),
    partsTotalIqd: parts.reduce((sum, part) => sum + part.priceIqd * part.qty, 0),
    slaDueAt: row.slaDueAt,
    late: late(row, now),
    receivedAt: row.receivedAt,
    completedAt: row.completedAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    assignedTo: row.assignedTo ? { id: row.assignedTo, name: names.get(row.assignedTo) ?? row.assignedTo } : null,
    technicians: techs,
    transitions: [...(REPAIR_TRANSITIONS[status] ?? [])],
    events: events.map((event) => ({
      id: event.id,
      kind: event.kind,
      note: event.note,
      at: event.at,
      actor: { kind: event.actorKind, name: event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? null) : null },
      data: eventData(event.data),
    })),
    photos: photos.map((photo) => ({ id: photo.id, url: urls.file(photo.id) })),
    can: { manage: can(actor, "returns.repair.manage"), stock: can(actor, "inventory.stock.adjust") },
    isDemo: row.isDemo,
  };
}

// ───────────────────────────────────────────────────────────────── changes

function eventStatement(db: Db, actor: Actor, ticketId: string, kind: string, now: number, note: string | null, data: Record<string, unknown> = {}): BatchStatement {
  const { actorKind, actorId } = actorRef(actor);
  return db.insert(repairEvents).values({ id: newId("rev"), ticketId, kind, note, data, actorKind, actorId, at: now });
}

/** A guarded change of one ticket (its status in the WHERE clause) with its event and audit, in one batch. */
async function change(db: Db, ticket: RepairTicket, set: Partial<typeof repairTickets.$inferInsert>, extra: BatchStatement[], now: number): Promise<void> {
  try {
    await runBatch(db, [
      db
        .update(repairTickets)
        .set({ ...set, updatedAt: now })
        .where(and(eq(repairTickets.id, ticket.id), eq(repairTickets.status, ticket.status))),
      expectChanged(db, 1, { code: "REPAIR_CHANGED", detail: ticket.id }),
      ...extra,
    ]);
  } catch (error) {
    if (isDbError(error, "REPAIR_CHANGED")) throw new AppError("repair_changed", 409, { detail: ticket.id, cause: error });
    throw error;
  }
}

export const RepairStatusInput = z.object({
  ticketId: idSchema,
  /** The status the employee saw (a stale page is refused: repair_changed). */
  from: z.enum(REPAIR_STATUS_LIST, "invalid"),
  to: z.enum(REPAIR_STATUS_LIST, "invalid"),
  note: z.string().trim().max(1000, "too_long").optional(),
});

export async function changeRepairStatus(db: Db, actor: Actor, raw: z.input<typeof RepairStatusInput>, now: number): Promise<{ status: RepairStatusKey; replayed: boolean }> {
  assertCan(actor, "returns.repair.manage");
  const input = RepairStatusInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  if (ticket.status === input.to) return { status: input.to, replayed: true };
  if (ticket.status !== input.from) throw new AppError("repair_changed", 409, { detail: ticket.status });
  if (!REPAIR_TRANSITIONS[ticket.status as RepairStatusKey]?.includes(input.to)) throw new AppError("transition_not_allowed", 409, { detail: `${ticket.status}→${input.to}` });
  const note = input.note ?? "";
  if (REPAIR_REASON_REQUIRED.includes(input.to) && note.length < 3) throw invalid({ note: "required" });
  // Paid work never starts before the customer said yes to the price — from diagnosing, awaiting parts or approval alike —
  // and is not finished on a price they have not accepted (a changed quote is approved again: setDiagnosis).
  if ((input.to === "repairing" || input.to === "ready") && !ticket.isWarranty && (ticket.quoteIqd ?? 0) > 0 && !ticket.quoteApprovedAt) throw new AppError("quote_not_approved", 409, { detail: ticket.id });

  const set: Partial<typeof repairTickets.$inferInsert> = { status: input.to };
  if (input.to === "received") {
    set.receivedAt = ticket.receivedAt ?? now;
    set.slaDueAt = ticket.slaDueAt ?? now + (await slaTargets(db)).repairDays * DAY_MS;
  }
  if (input.to === "ready") set.completedAt = now;
  if (input.to === "delivered") {
    set.deliveredAt = now;
    set.costIqd = ticket.isWarranty || ticket.status === "unrepairable" ? 0 : ticket.quoteApprovedAt ? (ticket.quoteIqd ?? 0) : 0;
  }
  if (input.to === "unrepairable" || input.to === "cancelled") set.resolution = note.slice(0, 500);
  const extra: BatchStatement[] = [
    eventStatement(db, actor, ticket.id, "status", now, note || null, { from: ticket.status, to: input.to }),
    auditStatement(db, { actor, action: "returns.repair.status", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, before: { status: ticket.status }, after: { status: input.to }, reason: note || null, at: now }),
  ];
  // A return's unit handed back repaired: that RMA is resolved by the repair. Handed back unrepairable, it is not.
  if (input.to === "delivered" && ticket.returnId && ticket.status === "ready") {
    extra.push(batchSql(db, sql`UPDATE returns SET status = 'repaired', resolution = 'repair', closed_at = ${now}, updated_at = ${now} WHERE id = ${ticket.returnId} AND status IN ('received', 'inspected')`));
  }
  await change(db, ticket, set, extra, now);
  return { status: input.to, replayed: false };
}

export const DiagnosisInput = z.object({
  ticketId: idSchema,
  diagnosis: z.string().trim().min(3, "required").max(2000, "too_long"),
  /** What the customer will pay (empty: no charge decided yet; 0 under warranty). */
  quoteIqd: z.number().int("invalid").min(0, "too_small").max(100_000_000, "too_big").nullable(),
});

/** The technician's findings and the quote (a new quote needs the customer's approval again). */
export async function setDiagnosis(db: Db, actor: Actor, raw: z.input<typeof DiagnosisInput>, now: number): Promise<void> {
  assertCan(actor, "returns.repair.manage");
  const input = DiagnosisInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  if (!REPAIR_OPEN.includes(ticket.status as RepairStatusKey)) throw new AppError("repair_changed", 409, { detail: ticket.status });
  const quoteChanged = input.quoteIqd !== ticket.quoteIqd;
  await change(
    db,
    ticket,
    { diagnosis: input.diagnosis, quoteIqd: ticket.isWarranty ? 0 : input.quoteIqd, quoteApprovedAt: quoteChanged ? null : ticket.quoteApprovedAt },
    [
      eventStatement(db, actor, ticket.id, quoteChanged ? "quote" : "diagnosis", now, null, { quoteIqd: ticket.isWarranty ? 0 : input.quoteIqd }),
      auditStatement(db, { actor, action: "returns.repair.diagnosis", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, before: { quoteIqd: ticket.quoteIqd }, after: { quoteIqd: ticket.isWarranty ? 0 : input.quoteIqd, diagnosis: input.diagnosis.slice(0, 200) }, at: now }),
    ],
    now,
  );
}

export const QuoteDecisionInput = z.object({ ticketId: idSchema, approved: z.boolean(), note: z.string().trim().min(3, "required").max(500, "too_long") });

/** The customer's answer to the quote, as staff heard it (by phone, at the counter) — with how it was given. */
export async function recordQuoteDecision(db: Db, actor: Actor, raw: z.input<typeof QuoteDecisionInput>, now: number): Promise<void> {
  assertCan(actor, "returns.repair.manage");
  const input = QuoteDecisionInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  if (!REPAIR_OPEN.includes(ticket.status as RepairStatusKey)) throw new AppError("repair_changed", 409, { detail: ticket.status });
  if (ticket.quoteIqd === null) throw new AppError("quote_not_approved", 409, { detail: "no quote" });
  await change(db, ticket, { quoteApprovedAt: input.approved ? now : null }, [
    eventStatement(db, actor, ticket.id, input.approved ? "quote_approved" : "quote_declined", now, input.note, { quoteIqd: ticket.quoteIqd }),
    auditStatement(db, { actor, action: input.approved ? "returns.repair.quote_approved" : "returns.repair.quote_declined", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, after: { quoteIqd: ticket.quoteIqd }, reason: input.note, at: now }),
  ], now);
}

export const PartInput = z.object({
  ticketId: idSchema,
  name: z.string().trim().min(2, "required").max(120, "too_long"),
  qty: z.number().int("invalid").min(1, "too_small").max(50, "too_big"),
  /** Charged to the customer per unit (0 under warranty). */
  priceIqd: z.number().int("invalid").min(0, "too_small").max(50_000_000, "too_big"),
  variantId: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => value || undefined),
});

/** A part used (or to be used) in the repair — the replaced parts of the unit's service history (12.06). */
export async function addPart(db: Db, actor: Actor, raw: z.input<typeof PartInput>, now: number): Promise<void> {
  assertCan(actor, "returns.repair.manage");
  const input = PartInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  if (!REPAIR_OPEN.includes(ticket.status as RepairStatusKey)) throw new AppError("repair_changed", 409, { detail: ticket.status });
  if (input.variantId) {
    const variant = await db.select({ id: variants.id }).from(variants).where(eq(variants.id, input.variantId)).get();
    if (!variant) throw invalid({ variantId: "invalid" });
  }
  const part: RepairPart = { name: input.name, qty: input.qty, priceIqd: ticket.isWarranty ? 0 : input.priceIqd, ...(input.variantId ? { variantId: input.variantId } : {}) };
  const parts = [...partsOf(ticket.parts), part];
  if (parts.length > 30) throw invalid({ name: "too_big" });
  await change(db, ticket, { parts }, [
    eventStatement(db, actor, ticket.id, "part", now, null, { name: part.name, qty: part.qty, priceIqd: part.priceIqd }),
    auditStatement(db, { actor, action: "returns.repair.part", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, after: part, at: now }),
  ], now);
}

export const AssignInput = z.object({ ticketId: idSchema, employeeId: z.string().trim().max(128).optional() });

export async function assignRepair(db: Db, actor: Actor, raw: z.input<typeof AssignInput>, now: number): Promise<void> {
  assertCan(actor, "returns.repair.manage");
  const input = AssignInput.parse(raw);
  const ticket = await ticketById(db, input.ticketId);
  const employeeId = input.employeeId || null;
  if (employeeId && !(await technicians(db)).some((tech) => tech.id === employeeId)) throw new AppError("assignee_not_technician", 409, { fields: { employeeId: "assignee_not_technician" } });
  if (ticket.assignedTo === employeeId) return;
  await change(db, ticket, { assignedTo: employeeId }, [
    eventStatement(db, actor, ticket.id, "assigned", now, null, { employeeId }),
    auditStatement(db, { actor, action: "returns.repair.assign", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, before: { assignedTo: ticket.assignedTo }, after: { assignedTo: employeeId }, at: now }),
  ], now);
}

export const SlaInput = z.object({ ticketId: idSchema, dueOn: z.string().trim().min(1, "required").max(10, "invalid"), reason: z.string().trim().min(3, "required").max(500, "too_long") });

/** Moves the SLA due date (end of that Baghdad day), with the reason the customer was told. */
export async function setRepairSla(db: Db, actor: Actor, raw: z.input<typeof SlaInput>, now: number): Promise<{ slaDueAt: number }> {
  assertCan(actor, "returns.repair.manage");
  const input = SlaInput.parse(raw);
  const day = toLatinDigits(input.dueOn);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw invalid({ dueOn: "invalid" });
  const [y, m, d] = day.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d);
  const check = new Date(start);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw invalid({ dueOn: "invalid" });
  const slaDueAt = start - 3 * 60 * 60 * 1000 + DAY_MS - 1;
  if (slaDueAt <= now) throw invalid({ dueOn: "not_later" });
  const ticket = await ticketById(db, input.ticketId);
  if (!REPAIR_OPEN.includes(ticket.status as RepairStatusKey)) throw new AppError("repair_changed", 409, { detail: ticket.status });
  await change(db, ticket, { slaDueAt }, [
    eventStatement(db, actor, ticket.id, "sla", now, input.reason, { slaDueAt }),
    auditStatement(db, { actor, action: "returns.repair.sla", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, before: { slaDueAt: ticket.slaDueAt }, after: { slaDueAt }, reason: input.reason, at: now }),
  ], now);
  return { slaDueAt };
}

export async function addRepairNote(db: Db, actor: Actor, raw: { ticketId?: string; text?: string }, now: number): Promise<void> {
  assertCan(actor, "returns.repair.manage");
  const text = z.string().trim().min(2, "required").max(1000, "too_long").parse(raw.text ?? "");
  const ticket = await ticketById(db, raw.ticketId ?? "");
  await runBatch(db, [eventStatement(db, actor, ticket.id, "note", now, text), auditStatement(db, { actor, action: "returns.repair.note", entityType: "repair_ticket", entityId: ticket.id, summary: ticket.ref, reason: text, at: now })]);
}

// ───────────────────────────────────────────────────────────────── new tickets

export const CounterRepairInput = z.object({
  phone: z.string().trim().min(1, "required").max(40, "phone_invalid"),
  contactName: z.string().trim().max(80, "too_long").optional(),
  /** A device model id of ours, or empty with `deviceText`. */
  deviceModelId: z.string().trim().max(128).optional(),
  deviceText: z.string().trim().max(120, "too_long").optional(),
  serial: z.string().trim().max(40, "too_long").optional(),
  issue: z.string().trim().min(10, "too_short").max(2000, "too_long"),
  idempotencyKey: z.string().trim().min(8, "invalid").max(200, "invalid"),
});

/** A device handed over at the counter: the ticket starts "received" and its SLA clock runs. */
export async function openCounterRepair(db: Db, actor: Actor, raw: z.input<typeof CounterRepairInput>, now: number, storeMode: "demo" | "live" = "live"): Promise<{ ref: string; replayed: boolean }> {
  assertCan(actor, "returns.repair.manage");
  const input = CounterRepairInput.parse(raw);
  const phone = normalizeIraqPhone(input.phone);
  if (!phone) throw invalid({ phone: "phone_invalid" });
  let deviceModelId: string | null = null;
  if (input.deviceModelId) {
    const model = await db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, input.deviceModelId)).get();
    if (!model) throw invalid({ deviceModelId: "invalid" });
    deviceModelId = model.id;
  } else if (!input.deviceText || input.deviceText.length < 2) {
    throw invalid({ deviceText: "required" });
  }
  const id = `rep_${(await sha256Hex(`counter:${input.idempotencyKey}`)).slice(0, 26)}`;
  const existing = await db.select({ ref: repairTickets.ref }).from(repairTickets).where(eq(repairTickets.id, id)).get();
  if (existing) return { ref: existing.ref, replayed: true };
  const serialText = input.serial ? input.serial.toUpperCase().replace(/\s+/g, "") : null;
  const unit = serialText ? await db.select({ id: serials.id }).from(serials).where(sql`upper(${serials.serial}) = ${serialText}`).get() : undefined;
  const warranty = unit
    ? await db
        .select({ id: warranties.id })
        .from(warranties)
        .where(and(eq(warranties.serialId, unit.id), eq(warranties.status, "active"), sql`${warranties.endsAt} >= ${now}`))
        .get()
    : undefined;
  const ref = publicRef("RP");
  try {
    await runBatch(db, [
      db.insert(repairTickets).values({
        id,
        ref,
        customerId: null,
        phoneE164: phone,
        deviceModelId,
        serialId: unit?.id ?? null,
        warrantyId: warranty?.id ?? null,
        issue: input.issue,
        status: "received",
        slaDueAt: now + (await slaTargets(db)).repairDays * DAY_MS,
        createdAt: now,
        contactName: input.contactName || null,
        serialText,
        deviceText: deviceModelId ? null : (input.deviceText ?? null),
        source: "store",
        isWarranty: warranty !== undefined,
        receivedAt: now,
        isDemo: storeMode === "demo",
        updatedAt: now,
      }),
      eventStatement(db, actor, id, "status", now, null, { from: null, to: "received", source: "store" }),
      auditStatement(db, { actor, action: "returns.repair.create", entityType: "repair_ticket", entityId: id, summary: `${ref} · store`, after: { ref, source: "store", deviceModelId, linkedToOurUnit: unit !== undefined, warranty: warranty?.id ?? null }, at: now }),
    ]);
  } catch (error) {
    const again = await db.select({ ref: repairTickets.ref }).from(repairTickets).where(eq(repairTickets.id, id)).get();
    if (again) return { ref: again.ref, replayed: true };
    throw error;
  }
  return { ref, replayed: false };
}

export const ReturnRepairInput = z.object({ returnId: idSchema, itemId: idSchema, issue: z.string().trim().min(10, "too_short").max(2000, "too_long") });

/**
 * A kept unit of a return (inspection decision "keep") repaired for its customer: a ticket with source "return",
 * linked to the RMA, the unit's serial and its running warranty (then free of charge). One ticket per RMA line.
 */
export async function openReturnRepair(db: Db, actor: Actor, raw: z.input<typeof ReturnRepairInput>, now: number): Promise<{ ref: string; replayed: boolean }> {
  assertCan(actor, "returns.repair.manage");
  const input = ReturnRepairInput.parse(raw);
  const ret = await returnById(db, input.returnId);
  const item = await db
    .select({ id: returnItems.id, serialId: returnItems.serialId, inspectedBy: returnItems.inspectedBy, restockAction: returnItems.restockAction, orderItemId: returnItems.orderItemId, deviceModelId: products.deviceModelId })
    .from(returnItems)
    .innerJoin(orderItems, eq(orderItems.id, returnItems.orderItemId))
    .innerJoin(variants, eq(variants.id, orderItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(returnItems.id, input.itemId), eq(returnItems.returnId, ret.id)))
    .get();
  if (!item) throw notFound("return_item");
  if (!item.inspectedBy || item.restockAction !== null) throw new AppError("rma_changed", 409, { detail: "the unit is not kept for its customer" });
  const id = await returnRepairId(item.id);
  const existing = await db.select({ ref: repairTickets.ref }).from(repairTickets).where(eq(repairTickets.id, id)).get();
  if (existing) return { ref: existing.ref, replayed: true };
  // a closed, refunded or cancelled RMA opens no repair (the page offers it while the RMA is received or inspected)
  if (ret.status !== "received" && ret.status !== "inspected") throw new AppError("rma_changed", 409, { detail: ret.status });
  const warranty = await db
    .select({ id: warranties.id })
    .from(warranties)
    .where(and(eq(warranties.orderItemId, item.orderItemId), item.serialId ? eq(warranties.serialId, item.serialId) : undefined, eq(warranties.status, "active"), sql`${warranties.endsAt} >= ${now}`))
    .get();
  const ref = publicRef("RP");
  const contact = await db.select({ name: orders.contactName, phone: orders.contactPhoneE164 }).from(orders).where(eq(orders.id, ret.orderId)).get();
  await runBatch(db, [
    db.insert(repairTickets).values({
      id,
      ref,
      customerId: ret.customerId,
      phoneE164: ret.phoneE164 ?? contact?.phone ?? "",
      contactName: contact?.name ?? null,
      deviceModelId: item.deviceModelId,
      serialId: item.serialId,
      warrantyId: warranty?.id ?? null,
      issue: input.issue,
      status: "received",
      slaDueAt: now + (await slaTargets(db)).repairDays * DAY_MS,
      createdAt: now,
      source: "return",
      returnId: ret.id,
      isWarranty: warranty !== undefined,
      quoteIqd: warranty ? 0 : null,
      receivedAt: now,
      updatedAt: now,
    }),
    eventStatement(db, actor, id, "status", now, null, { from: null, to: "received", source: "return", rma: ret.rma }),
    auditStatement(db, { actor, action: "returns.repair.create", entityType: "repair_ticket", entityId: id, summary: `${ref} · ${ret.rma}`, after: { ref, source: "return", returnId: ret.id, itemId: item.id, warranty: warranty?.id ?? null }, at: now }),
    auditStatement(db, { actor, action: "returns.rma.repair", entityType: "return", entityId: ret.id, summary: ret.rma, after: { repairRef: ref, itemId: item.id }, at: now }),
  ]);
  return { ref, replayed: false };
}

/** Device models staff can pick at the counter (published ones of the catalogue). */
export async function deviceOptions(db: Db, locale: Locale): Promise<{ id: string; name: string }[]> {
  const rows = await db.select({ id: deviceModels.id, name: deviceModels.name, status: deviceModels.status }).from(deviceModels).orderBy(asc(deviceModels.slug));
  return rows.filter((row) => row.status === "published").map((row) => ({ id: row.id, name: pick(row.name, locale) }));
}

/** A repair ticket's photo for an employee who may read repairs; null otherwise (one 404). */
export async function repairPhotoFile(db: Db, actor: Actor, fileId: string): Promise<{ id: string } | null> {
  readable(actor);
  if (typeof fileId !== "string" || !ID.test(fileId)) return null;
  const row = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ownerType, "repair_ticket"), eq(files.visibility, "private"), isNull(files.deletedAt)))
    .get();
  return row ?? null;
}
