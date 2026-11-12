/**
 * Repair requests in the support inbox (14.01): what the customer asked for (RP-…, from the storefront's repair page,
 * the assistant, the shop counter or a return) as support staff need it — device, the problem in the customer's
 * words, their hand-over and day preferences, the private photos, where the repair stands — and a ticket for a
 * conversation about it (the customer calls: "where is my console?").
 *
 *   const view = await getRepairRequest(db, actor, "RP-7K4M2Q9X", locale, now, { file });
 *   const { ref } = await openRepairTicket(db, actor, { repairRef, channel: "phone", message, idempotencyKey }, now, storeMode);
 *
 * The repair's WORK — receiving, diagnosis, the quote and the customer's answer, parts, status changes — is module 12's
 * (/admin/returns/repairs/:ref, returns.repair.manage): it writes the `repair_events` rows (kind "status",
 * data.to) the storefront's status page reads. Nothing here changes a repair. The serial the customer typed stays
 * private: support staff see whether one was given and whether it is one of our units, not the number itself
 * (module 12's page shows it to whoever works on the repair).
 *
 * Who: support.ticket.read (opening a ticket: support.ticket.reply).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, files, repairEvents, repairTickets, supportTickets, warranties } from "~/server/db/schema";
import { notFound } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { employeeNames, normalizeRepairRef, phoneView } from "./shared.server";
import { openStaffTicket, type TicketPhoto } from "./tickets.server";
import { REPAIR_OPEN_STATUSES, STAFF_CHANNELS, isRepairStatus, type PersonRef, type PhoneView, type RepairStatus, type TicketStatus } from "./types";

export type RepairRequestView = {
  id: string;
  ref: string;
  status: RepairStatus;
  source: string;
  device: string | null;
  deviceText: string | null;
  issue: string;
  contact: { name: string | null; phone: PhoneView | null };
  handover: string | null;
  preferredDay: string | null;
  preferredWindow: string | null;
  serial: { given: boolean; ours: boolean };
  isWarranty: boolean;
  warranty: { state: "active" | "expired" | "void"; endsAt: number } | null;
  quote: { iqd: number | null; approved: boolean };
  photos: TicketPhoto[];
  timeline: { status: RepairStatus; at: number }[];
  slaDueAt: number | null;
  late: boolean;
  assigned: PersonRef | null;
  tickets: { ref: string; subject: string; status: TicketStatus }[];
  workHref: string | null;
  createdAt: number;
  isDemo: boolean;
  can: { openTicket: boolean };
};

export async function getRepairRequest(db: Db, actor: Actor, ref: string, locale: Locale, now: number, urls: { file: (id: string) => string }): Promise<RepairRequestView> {
  assertCan(actor, "support.ticket.read");
  const normalized = normalizeRepairRef(ref);
  const row = normalized ? await db.select().from(repairTickets).where(eq(repairTickets.ref, normalized)).get() : undefined;
  if (!row) throw notFound("repair");
  const [model, events, photos, warranty, tickets] = await Promise.all([
    row.deviceModelId ? db.select({ name: deviceModels.name }).from(deviceModels).where(eq(deviceModels.id, row.deviceModelId)).get() : Promise.resolve(undefined),
    db.select({ kind: repairEvents.kind, data: repairEvents.data, at: repairEvents.at }).from(repairEvents).where(eq(repairEvents.ticketId, row.id)).orderBy(asc(repairEvents.at), asc(repairEvents.id)),
    db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.ownerType, "repair_ticket"), eq(files.ownerId, row.id), eq(files.visibility, "private"), isNull(files.deletedAt))),
    row.warrantyId ? db.select({ endsAt: warranties.endsAt, status: warranties.status }).from(warranties).where(eq(warranties.id, row.warrantyId)).get() : Promise.resolve(undefined),
    db.select({ ref: supportTickets.ref, subject: supportTickets.subject, status: supportTickets.status }).from(supportTickets).where(eq(supportTickets.repairTicketId, row.id)).orderBy(asc(supportTickets.createdAt)).limit(20),
  ]);
  const names = await employeeNames(db, [row.assignedTo]);
  const first = (events.find((event) => event.kind === "submitted")?.data ?? {}) as Record<string, unknown>;
  const timeline: { status: RepairStatus; at: number }[] = [];
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const to = event.kind === "submitted" ? "submitted" : event.kind === "status" ? (data.to ?? data.status) : null;
    if (typeof to === "string" && isRepairStatus(to) && timeline[timeline.length - 1]?.status !== to) timeline.push({ status: to, at: event.at });
  }
  const status: RepairStatus = isRepairStatus(row.status) ? row.status : "submitted";
  if (timeline[timeline.length - 1]?.status !== status) timeline.push({ status, at: row.updatedAt });
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.slice(0, 40) : null);
  const open = (REPAIR_OPEN_STATUSES as readonly string[]).includes(status);
  return {
    id: row.id,
    ref: row.ref,
    status,
    source: row.source,
    device: model ? pick(model.name, locale) : null,
    deviceText: row.deviceText,
    issue: row.issue,
    contact: { name: row.contactName, phone: phoneView(actor, row.phoneE164) },
    handover: text(first.handover),
    preferredDay: text(first.preferredDay),
    preferredWindow: text(first.preferredWindow),
    serial: { given: Boolean(row.serialText || row.serialId), ours: row.serialId !== null },
    isWarranty: row.isWarranty,
    warranty: warranty ? { state: warranty.status === "void" ? "void" : warranty.endsAt < now ? "expired" : "active", endsAt: warranty.endsAt } : null,
    quote: { iqd: row.quoteIqd ?? null, approved: row.quoteApprovedAt !== null },
    photos: photos.map((photo) => ({ id: photo.id, url: urls.file(photo.id) })),
    timeline,
    slaDueAt: row.slaDueAt,
    late: open && status !== "ready" && row.slaDueAt !== null && row.slaDueAt < now,
    assigned: row.assignedTo ? { id: row.assignedTo, name: names.get(row.assignedTo) ?? row.assignedTo } : null,
    tickets: tickets.map((ticket) => ({ ref: ticket.ref, subject: ticket.subject, status: ticket.status })),
    workHref: canAny(actor, ["returns.repair.manage", "returns.rma.read", "returns.warranty.read"]) ? `/admin/returns/repairs/${row.ref}` : null,
    createdAt: row.createdAt,
    isDemo: row.isDemo,
    can: { openTicket: can(actor, "support.ticket.reply") },
  };
}

export const RepairTicketInput = z.object({
  repairRef: z.string().trim().max(40),
  channel: z.enum(STAFF_CHANNELS, "invalid").default("phone"),
  subject: z.string().overwrite(cleanLine).trim().max(140, "too_long").default(""),
  message: z.string().overwrite(cleanBlock).trim().min(2, "required").max(4000, "too_long"),
  idempotencyKey: z.string().trim().min(8, "invalid").max(200, "invalid"),
});

/** A support ticket about this repair (the customer called about it), linked to it and to the customer by id. */
export async function openRepairTicket(db: Db, actor: Actor, raw: z.input<typeof RepairTicketInput>, now: number, storeMode: "demo" | "live"): Promise<{ ref: string; replayed: boolean }> {
  assertCan(actor, "support.ticket.reply");
  const input = RepairTicketInput.parse(raw);
  const ref = normalizeRepairRef(input.repairRef);
  const repair = ref ? await db.select({ ref: repairTickets.ref, phone: repairTickets.phoneE164, name: repairTickets.contactName }).from(repairTickets).where(eq(repairTickets.ref, ref)).get() : undefined;
  if (!repair) throw notFound("repair");
  const result = await openStaffTicket(
    db,
    actor,
    { channel: input.channel, phone: repair.phone, contactName: repair.name ?? "", subject: input.subject.length >= 3 ? input.subject : repair.ref, category: "repair", message: input.message, repairRef: repair.ref, takeIt: true, idempotencyKey: input.idempotencyKey },
    now,
    storeMode,
  );
  return { ref: result.ref, replayed: result.replayed };
}
