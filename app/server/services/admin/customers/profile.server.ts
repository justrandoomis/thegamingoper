/**
 * Admin 07.01 — the 360° customer profile: who they are (phone as the employee may see it), what they bought and
 * kept, their RFM scores (07.02) and labels with reasons (07.06), orders, returns (module 12's RMAs), warranties,
 * repairs, support tickets, wallet (the ledger sum, through the wallet service), internal notes, consents, privacy
 * requests, accounts merged into this one, and what staff changed here.
 *
 *   await getCustomerProfile(db, actor, customerId, locale, now)     customers.customer.read
 *   await addCustomerNote(db, actor, { customerId, text }, now)      customers.customer.note
 *
 * Every section needs the permission of the module that owns it (orders.order.read, returns.rma.read,
 * returns.warranty.read, support.ticket.read, customers.wallet.read, customers.consent.read,
 * customers.privacy.manage); without it the section is null — absent from the loader data, not hidden. No cost or
 * profit figure is read here. Serial numbers of warranties need inventory.serial.read. The activity follows the same
 * rule: wallet events (customers.wallet.*, finance.wallet.*) only with a wallet permission, consent events only with
 * customers.consent.read or customers.privacy.manage, other modules' events only with audit.read (review 2026-11-11:
 * the wallet section was absent but its credits and their reasons were in the activity).
 *
 * Notes are append-only: each is an audit event ("customers.customer.note", who, when, the text — phone numbers masked
 * by the audit trail, card-like digit runs refused), so nobody edits or deletes another person's note. A merged
 * account's notes appear on the account it was merged into.
 */
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement, maskPhonesIn } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { addresses, auditEvents, consents, customers, privacyRequests, walletTopups } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError } from "~/server/errors";
import { cleanBlock } from "~/server/text.server";
import { getWalletBalance, listWalletEntries } from "~/server/services/wallet.server";
import { customerFlags } from "./flags.server";
import { NO_FACTS, rfmFacts, storedSegments } from "./rfm.server";
import { customerRules } from "./rules.server";
import { changeableCustomer, customerById, customersAccess, employeeNames, hasLongDigitRun, num, phoneView, type CustomerRow } from "./shared.server";
import {
  CONSENT_KIND_LIST,
  OPEN_ORDER_STATUSES,
  rfmOf,
  type ActivityRow,
  type ConsentState,
  type CustomerHeader,
  type CustomerProfile,
  type PrivacyKind,
  type PrivacyStatus,
  type ProfileNote,
  type ProfileOrder,
  type ProfileRepair,
  type ProfileReturn,
  type ProfileTicket,
  type ProfileWarranty,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 10;
/** A warranty that ends within this many days is "ending". */
export const WARRANTY_ENDING_DAYS = 30;
export const NOTE_ACTION = "customers.customer.note";
/** Contacts logged by hand (communication.server.ts) — shown in the communication log, not in the activity. */
const CONTACT_ACTION = "customers.contact.log";

/** The header every customer page shows (name, phone as allowed, status, labels with reasons, segment). */
export async function customerHeader(db: Db, actor: Actor, customerId: string, now: number): Promise<CustomerHeader> {
  assertCan(actor, "customers.customer.read");
  const row = await customerById(db, customerId);
  return headerOf(db, actor, row, now);
}

async function headerOf(db: Db, actor: Actor, row: CustomerRow, now: number): Promise<CustomerHeader> {
  const [flags, segments, into] = await Promise.all([
    customerFlags(db, [row.id], now),
    storedSegments(db, [row.id]),
    row.mergedIntoId ? db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.id, row.mergedIntoId)).get() : Promise.resolve(undefined),
  ]);
  const stored = segments.get(row.id);
  return {
    id: row.id,
    name: row.name,
    phone: phoneView(row.phoneE164, can(actor, "customer.phone.read_full")),
    email: row.email,
    status: row.status,
    locale: row.locale,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt ?? null,
    phoneVerifiedAt: row.phoneVerifiedAt ?? null,
    vipTier: row.vipTier,
    fraudFlag: row.fraudFlag,
    // stored masked since the review; masked again for rows written before it
    fraudReason: row.fraudReason ? maskPhonesIn(row.fraudReason) : null,
    mergedInto: into ? { id: into.id, name: into.name } : null,
    anonymizedAt: row.anonymizedAt ?? null,
    isDemo: row.isDemo,
    flags: flags.get(row.id) ?? [],
    segment: stored ? { key: stored.segment, computedAt: stored.computedAt } : null,
  };
}

export async function getCustomerProfile(db: Db, actor: Actor, customerId: string, locale: Locale, now: number): Promise<CustomerProfile> {
  assertCan(actor, "customers.customer.read");
  const access = customersAccess(actor);
  const row = await customerById(db, customerId);
  const mergedRows = await db
    .select({ id: customers.id, name: customers.name, phone: customers.phoneE164, at: customers.updatedAt })
    .from(customers)
    .where(eq(customers.mergedIntoId, row.id))
    .orderBy(desc(customers.updatedAt));
  const noteSubjects = [row.id, ...mergedRows.map((merged) => merged.id)];
  // the rules in force (the settings customers.rfm_rules / flag_rules / privacy_due_days — follow-up 2026-11-12)
  const rules = await customerRules(db);

  const [header, statsRows, facts, orders, returnsRows, warrantyRows, repairRows, ticketRows, wallet, notes, consentRows, privacyRows, addressCount, activity] = await Promise.all([
    headerOf(db, actor, row, now),
    db.all<{ orders: number; purchases: number; open_orders: number; spent: number; refunded: number; first_at: number | null; last_at: number | null }>(sql`
      SELECT count(*) AS orders,
        coalesce(sum(CASE WHEN status <> 'cancelled' AND paid_iqd > refunded_iqd THEN 1 ELSE 0 END), 0) AS purchases,
        coalesce(sum(CASE WHEN status IN (${sql.join(
          OPEN_ORDER_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )}) THEN 1 ELSE 0 END), 0) AS open_orders,
        coalesce(sum(CASE WHEN status <> 'cancelled' AND paid_iqd > refunded_iqd THEN paid_iqd - refunded_iqd ELSE 0 END), 0) AS spent,
        coalesce(sum(refunded_iqd), 0) AS refunded,
        min(placed_at) AS first_at, max(placed_at) AS last_at
      FROM orders WHERE customer_id = ${row.id}`),
    rfmFacts(db, [row.id]),
    access.orders ? profileOrders(db, row.id) : Promise.resolve(null),
    access.returns ? profileReturns(db, row.id) : Promise.resolve(null),
    access.warranties ? profileWarranties(db, row.id, locale, can(actor, "inventory.serial.read"), now) : Promise.resolve(null),
    access.repairs ? profileRepairs(db, row.id) : Promise.resolve(null),
    access.tickets ? profileTickets(db, row.id) : Promise.resolve(null),
    access.wallet ? walletSummary(db, row.id, access.financeWallet) : Promise.resolve(null),
    customerNotes(db, noteSubjects, row.id),
    access.consents ? currentConsents(db, row.id) : Promise.resolve(null),
    access.privacy
      ? db
          .select({ ref: privacyRequests.ref, kind: privacyRequests.kind, status: privacyRequests.status, dueAt: privacyRequests.dueAt })
          .from(privacyRequests)
          .where(eq(privacyRequests.customerId, row.id))
          .orderBy(desc(privacyRequests.createdAt))
          .limit(LIST_LIMIT)
      : Promise.resolve(null),
    db.select({ n: sql<number>`count(*)` }).from(addresses).where(eq(addresses.customerId, row.id)).get(),
    customerActivity(db, row.id, activityScope(actor, access)),
  ]);
  const stats = statsRows[0];
  const purchases = num(stats?.purchases);
  const spent = num(stats?.spent);
  const fullPhone = access.fullPhone;
  return {
    header,
    stats: {
      orders: num(stats?.orders),
      purchases,
      openOrders: num(stats?.open_orders),
      spentIqd: spent,
      refundedIqd: num(stats?.refunded),
      aovIqd: purchases > 0 ? Math.floor(spent / purchases) : null,
      firstOrderAt: stats?.first_at === null || stats?.first_at === undefined ? null : num(stats.first_at),
      lastOrderAt: stats?.last_at === null || stats?.last_at === undefined ? null : num(stats.last_at),
    },
    rfm: rfmOf(facts.get(row.id) ?? NO_FACTS, now, rules.rfm),
    rules,
    orders,
    returns: returnsRows,
    warranties: warrantyRows,
    repairs: repairRows,
    tickets: ticketRows,
    wallet,
    notes,
    legacyNote: row.notes?.trim() ? row.notes.trim() : null,
    consents: consentRows,
    privacy: privacyRows ? privacyRows.map((request) => ({ ref: request.ref, kind: request.kind as PrivacyKind, status: request.status as PrivacyStatus, dueAt: request.dueAt ?? null })) : null,
    mergedFrom: mergedRows.map((merged) => ({ id: merged.id, name: merged.name, phone: phoneView(merged.phone, fullPhone), at: merged.at })),
    addresses: num(addressCount?.n),
    activity,
  };
}

async function profileOrders(db: Db, customerId: string): Promise<ProfileOrder[]> {
  const rows = await db.all<{ id: string; ref: string; status: string; payment_status: string; total_iqd: number; paid_iqd: number; refunded_iqd: number; placed_at: number; is_demo: number; items: number }>(sql`
    SELECT o.id, o.ref, o.status, o.payment_status, o.total_iqd, o.paid_iqd, o.refunded_iqd, o.placed_at, o.is_demo,
      (SELECT coalesce(sum(i.qty), 0) FROM order_items AS i WHERE i.order_id = o.id) AS items
    FROM orders AS o WHERE o.customer_id = ${customerId}
    ORDER BY o.placed_at DESC, o.id DESC LIMIT ${LIST_LIMIT}`);
  return rows.map((order) => ({
    id: order.id,
    ref: order.ref,
    status: order.status,
    paymentStatus: order.payment_status,
    totalIqd: num(order.total_iqd),
    paidIqd: num(order.paid_iqd),
    refundedIqd: num(order.refunded_iqd),
    placedAt: num(order.placed_at),
    items: num(order.items),
    isDemo: num(order.is_demo) === 1,
  }));
}

async function profileReturns(db: Db, customerId: string): Promise<ProfileReturn[]> {
  const rows = await db.all<{ id: string; rma: string; status: string; reason_code: string | null; created_at: number; order_ref: string | null }>(sql`
    SELECT r.id, r.rma, r.status, r.reason_code, r.created_at, o.ref AS order_ref
    FROM returns AS r LEFT JOIN orders AS o ON o.id = r.order_id
    WHERE r.customer_id = ${customerId} OR o.customer_id = ${customerId}
    ORDER BY r.created_at DESC, r.id DESC LIMIT ${LIST_LIMIT}`);
  return rows.map((ret) => ({ id: ret.id, rma: ret.rma, status: ret.status, orderRef: ret.order_ref, reasonCode: ret.reason_code, createdAt: num(ret.created_at) }));
}

async function profileWarranties(db: Db, customerId: string, locale: Locale, serials: boolean, now: number): Promise<ProfileWarranty[]> {
  const rows = await db.all<{ id: string; name: string | null; sku: string | null; serial: string | null; starts_at: number; ends_at: number; status: string }>(sql`
    SELECT w.id, i.name_snapshot AS name, i.sku, s.serial, w.starts_at, w.ends_at, w.status
    FROM warranties AS w JOIN order_items AS i ON i.id = w.order_item_id LEFT JOIN serials AS s ON s.id = w.serial_id
    WHERE w.customer_id = ${customerId}
    ORDER BY w.ends_at DESC, w.id DESC LIMIT ${LIST_LIMIT}`);
  return rows.map((warranty) => {
    let name = "";
    try {
      name = pick(JSON.parse(warranty.name ?? "{}"), locale);
    } catch {
      name = "";
    }
    const endsAt = num(warranty.ends_at);
    const state: ProfileWarranty["state"] = warranty.status === "void" ? "void" : endsAt < now ? "expired" : endsAt - now <= WARRANTY_ENDING_DAYS * DAY_MS ? "ending" : "active";
    return { id: warranty.id, itemName: name, sku: warranty.sku, serial: serials ? warranty.serial : null, startsAt: num(warranty.starts_at), endsAt, status: warranty.status, state };
  });
}

async function profileRepairs(db: Db, customerId: string): Promise<ProfileRepair[]> {
  const rows = await db.all<{ id: string; ref: string; status: string; created_at: number; issue: string }>(sql`
    SELECT id, ref, status, created_at, issue FROM repair_tickets WHERE customer_id = ${customerId} ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`);
  return rows.map((repair) => ({ id: repair.id, ref: repair.ref, status: repair.status, createdAt: num(repair.created_at), issue: repair.issue.slice(0, 160) }));
}

async function profileTickets(db: Db, customerId: string): Promise<ProfileTicket[]> {
  const rows = await db.all<{ id: string; ref: string; subject: string; category: string; status: string; priority: string; created_at: number; escalated_at: number | null }>(sql`
    SELECT id, ref, subject, category, status, priority, created_at, escalated_at FROM support_tickets
    WHERE customer_id = ${customerId} ORDER BY created_at DESC, id DESC LIMIT ${LIST_LIMIT}`);
  return rows.map((ticket) => {
    const open = ticket.status !== "resolved" && ticket.status !== "closed";
    return {
      id: ticket.id,
      ref: ticket.ref,
      subject: ticket.subject.slice(0, 160),
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: num(ticket.created_at),
      escalated: ticket.escalated_at !== null,
      open,
      complaint: open && (ticket.category === "complaint" || ticket.escalated_at !== null),
      // the ticket in the support module (14) — the section is sent only with support.ticket.read, which opens it
      href: `/admin/support/tickets/${encodeURIComponent(ticket.ref)}`,
    };
  });
}

/** Balance = Σ of the ledger (wallet service), the last movements, pending top-ups, and the finance page if allowed. */
async function walletSummary(db: Db, customerId: string, financeWallet: boolean) {
  const [balanceIqd, entries, pending] = await Promise.all([
    getWalletBalance(db, customerId),
    listWalletEntries(db, customerId, { limit: 5 }),
    db
      .select({ n: sql<number>`count(*)` })
      .from(walletTopups)
      .where(and(eq(walletTopups.customerId, customerId), eq(walletTopups.status, "pending_verification")))
      .get(),
  ]);
  return {
    balanceIqd,
    entries: entries.items.map((entry) => ({ id: entry.id, kind: entry.kind, amountIqd: entry.amountIqd, at: entry.at, orderRef: entry.orderRef })),
    pendingTopups: num(pending?.n),
    financeHref: financeWallet ? `/admin/finance/wallets/${encodeURIComponent(customerId)}` : null,
  };
}

async function customerNotes(db: Db, subjectIds: readonly string[], selfId: string): Promise<ProfileNote[]> {
  const rows = await db
    .select({ id: auditEvents.id, entityId: auditEvents.entityId, after: auditEvents.after, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, at: auditEvents.at })
    .from(auditEvents)
    .where(and(eq(auditEvents.action, NOTE_ACTION), eq(auditEvents.entityType, "customer"), inArray(auditEvents.entityId, [...subjectIds])))
    .orderBy(desc(auditEvents.seq))
    .limit(50);
  const names = await employeeNames(
    db,
    rows.map((note) => note.actorId),
  );
  return rows.map((note) => ({
    id: note.id,
    text: String((note.after as { text?: unknown } | null)?.text ?? ""),
    by: (note.actorId && names.get(note.actorId)) || note.actorLabel || null,
    at: note.at,
    fromAccount: note.entityId && note.entityId !== selfId ? note.entityId : null,
  }));
}

/** The newest answer per consent question for a customer (null = never asked). */
export async function currentConsents(db: Db, customerId: string): Promise<ConsentState[]> {
  const rows = await db
    .select({ kind: consents.kind, granted: consents.granted, at: consents.at, source: consents.source, id: consents.id })
    .from(consents)
    .where(and(eq(consents.subjectType, "customer"), eq(consents.subjectId, customerId)))
    .orderBy(desc(consents.at), desc(consents.id));
  return CONSENT_KIND_LIST.map((kind) => {
    const latest = rows.find((consent) => consent.kind === kind);
    return { kind, granted: latest ? latest.granted : null, at: latest?.at ?? null, source: latest?.source ?? null };
  });
}

/** Audit actions on a customer that every reader of the profile may see (module 07's own and the customer's). */
const ACTIVITY_OPEN = ["customers.customer.", "customers.address.", "customers.profile."] as const;
/** The wallet section's events (credits, module 10's adjustments): customers.wallet.read or finance.wallet.read. */
const ACTIVITY_WALLET = ["customers.wallet.", "finance.wallet."] as const;
/** The consent section's events: customers.consent.read or customers.privacy.manage. */
const ACTIVITY_CONSENT = ["customers.consent."] as const;

/**
 * Which audit actions this employee may see in a customer's activity: the open ones, the wallet's and the consents'
 * with their section's permission; everything (other modules' events too) with audit.read, who reads the whole trail
 * in module 21 anyway. undefined = no limit.
 */
export function activityScope(actor: Actor, access: ReturnType<typeof customersAccess>): SQL | undefined {
  if (can(actor, "audit.read")) return undefined;
  const prefixes: string[] = [...ACTIVITY_OPEN];
  if (access.wallet || access.financeWallet) prefixes.push(...ACTIVITY_WALLET);
  if (access.consents || access.privacy) prefixes.push(...ACTIVITY_CONSENT);
  return sql`(${sql.join(
    prefixes.map((prefix) => sql`${auditEvents.action} LIKE ${`${prefix}%`}`),
    sql` OR `,
  )})`;
}

/** What staff changed on this customer that this employee may see (see activityScope), newest first. */
async function customerActivity(db: Db, customerId: string, scope: SQL | undefined): Promise<ActivityRow[]> {
  const rows = await db
    .select({ id: auditEvents.id, action: auditEvents.action, actorKind: auditEvents.actorKind, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, at: auditEvents.at, reason: auditEvents.reason })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "customer"), eq(auditEvents.entityId, customerId), sql`${auditEvents.action} NOT IN (${NOTE_ACTION}, ${CONTACT_ACTION})`, scope))
    .orderBy(desc(auditEvents.seq))
    .limit(20);
  const names = await employeeNames(
    db,
    rows.map((event) => event.actorId),
  );
  return rows.map((event) => ({
    id: event.id,
    action: event.action,
    actorKind: event.actorKind,
    by: (event.actorId && names.get(event.actorId)) || event.actorLabel || null,
    at: event.at,
    reason: event.reason,
  }));
}

// ───────────────────────────────────────────────────────────────── notes

export const NoteInput = z.object({
  customerId: z.string({ error: "required" }).min(1, "required").max(128, "invalid"),
  text: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "too_short").max(1000, "too_long"),
});
export type NoteInput = z.input<typeof NoteInput>;

/** Adds an internal note (append-only). Card or account numbers are refused (12+ digits in a row). */
export async function addCustomerNote(db: Db, actor: Actor, raw: NoteInput, now: number): Promise<{ noteId: string }> {
  assertCan(actor, "customers.customer.note");
  const input = NoteInput.parse(raw);
  if (hasLongDigitRun(input.text)) throw new AppError("invalid", 400, { fields: { text: "note_has_card_number" } });
  const row = await changeableCustomer(db, input.customerId);
  const noteId = newId("aud");
  await runBatch(db, [auditStatement(db, { id: noteId, actor, action: NOTE_ACTION, entityType: "customer", entityId: row.id, after: { text: input.text }, at: now })]);
  return { noteId };
}
