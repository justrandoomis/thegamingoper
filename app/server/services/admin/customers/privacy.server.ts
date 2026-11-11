/**
 * Admin 07.04 — the consent and privacy log: marketing and other consents with their history, unsubscribes, and
 * privacy requests (export, deletion, correction, unsubscribe) handled after the person was verified.
 *
 *   await listConsentLog(db, actor, filters)                                          customers.consent.read
 *   await customerConsentHistory(db, actor, customerId)                               customers.consent.read
 *   await recordWithdrawal(db, actor, { customerId, kind, reason }, now)              customers.privacy.manage
 *   await listPrivacyRequests / getPrivacyRequest / createPrivacyRequest / verifyPrivacyRequest /
 *         rejectPrivacyRequest / completePrivacyRequest(…)                            customers.privacy.manage
 *   await buildPrivacyExport(db, actor, ref, now)                                     customers.privacy.manage (audited)
 *   await planErasure(db, actor, ref, now) · executeErasure(db, actor, { ref, reason }, now)
 *
 * CONSENTS are append-only (`consents`, a database rule): staff never change or delete an answer. They may record a
 * WITHDRAWAL the customer asked for (by phone, in the shop) — never a grant: consent must come from the person.
 *
 * REQUESTS: opened by staff on the customer's behalf (the storefront has no privacy form yet), due in PRIVACY_DUE_DAYS
 * (the store's own target). Nothing is handed out or erased before the person is verified (`verified_at`, the method
 * and a note are recorded: call back on the account's number, ID in the shop, …). No SMS provider exists, so a
 * one-time code cannot be the method.
 *   · export — a JSON file of the customer's own data built when staff download it (each download audited with its
 *     hash); staff hand it over and complete the request. Internal staff notes, fraud assessments and staff names are
 *     not personal data of the customer and are left out; no cost figure is ever included.
 *   · delete — follows the retention rules (RETENTION below): personal records that are not financial history are
 *     erased and the account anonymized (name, e-mail, password, notes, preferences cleared; the phone replaced by a
 *     tombstone so the number can open a new account; status "deleted"; the consented browsing signals deleted and the
 *     name on the person's guest contacts cleared); every consent still granted is withdrawn — the account's and the
 *     person's checkout answers as a guest; orders, payments, refunds, the wallet ledger, consents and the audit trail
 *     are kept — never deleted. Refused while the account has open orders, money in the wallet, a pending top-up or
 *     adjustment, an open return or repair (the plan lists each with what to do; each is checked again in the batch).
 *     The admin has no way to pay a wallet out (adjustments are credits), so an account holding money waits until it
 *     is spent — the commerce core request in docs/areas/admin-customers.md.
 *   · unsubscribe — records withdrawals (marketing; the others asked for) and completes the request — on the account
 *     and on the answers the person gave at checkout as a guest (guest contacts of the account or of its number), or
 *     for a visitor's number on its guest contacts only.
 *   · rectify — staff correct the details on the contact page, then complete it with a note.
 * Each step is one guarded batch with its audit event (entity "privacy_request").
 */
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { publicRef, sha256Hex } from "~/lib/ids";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  addresses,
  auditEvents,
  carts,
  consents,
  customerSegmentMembers,
  customerSessions,
  customers,
  guestContacts,
  notifications,
  privacyRequests,
  recentlyViewed,
  recommendationEvents,
  savedDevices,
  wishlistItems,
  type PrivacyRequest,
} from "~/server/db/schema";
import { batchSql, expectChanged, expectThat, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { CONSENT_POLICY_VERSION, consentStatement } from "~/server/services/account/preferences.server";
import { cleanBlock } from "~/server/text.server";
import { currentConsents } from "./profile.server";
import { actorId, changeableCustomer, customerById, employeeNames, ID, num, phoneView } from "./shared.server";
import {
  CONSENT_KIND_LIST,
  OPEN_ORDER_STATUSES,
  PAGE_SIZE,
  PRIVACY_DUE_DAYS,
  PRIVACY_KIND_LIST,
  PRIVACY_OPEN_STATUSES,
  RETENTION,
  VERIFY_METHODS,
  type ConsentKindKey,
  type ConsentLogFilters,
  type ConsentState,
  type ErasedPart,
  type KeptPart,
  type PhoneView,
  type PrivacyFilters,
  type PrivacyKind,
  type PrivacyStatus,
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export { RETENTION };
export type { ErasedPart, KeptPart };

const RETURN_OPEN = ["requested", "approved", "in_transit", "received", "inspected"] as const;
const REPAIR_DONE = ["delivered", "unrepairable", "cancelled"] as const;

const inList = (values: readonly string[]) =>
  sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );

/** The tombstone that replaces an erased account's phone (unique, never a real number). */
export const erasedPhone = (customerId: string) => `erased:${customerId}`;

// ───────────────────────────────────────────────────────────────── consents

export type ConsentLogRow = {
  id: string;
  kind: ConsentKindKey;
  granted: boolean;
  source: string | null;
  at: number;
  policyVersion: string | null;
  subjectType: string;
  customer: { id: string; name: string | null; phone: PhoneView | null; status: string } | null;
  guestPhone: PhoneView | null;
};

/** The consent log across customers and guests (07.04), newest first, 25 a page. */
export async function listConsentLog(db: Db, actor: Actor, filters: ConsentLogFilters): Promise<{ rows: ConsentLogRow[]; total: number; page: number; pageCount: number }> {
  assertCan(actor, "customers.consent.read");
  const where: SQL[] = [];
  if (filters.kind) where.push(sql`k.kind = ${filters.kind}`);
  if (filters.answer === "granted") where.push(sql`k.granted = 1`);
  if (filters.answer === "withdrawn") where.push(sql`k.granted = 0`);
  if (filters.source) where.push(sql`k.source = ${filters.source}`);
  if (filters.q) {
    const e164 = normalizeIraqPhone(filters.q);
    const subject: SQL[] = [];
    if (e164) {
      subject.push(sql`(k.subject_type = 'customer' AND k.subject_id IN (SELECT id FROM customers WHERE phone_e164 = ${e164}))`);
      subject.push(sql`(k.subject_type = 'guest_contact' AND k.subject_id IN (SELECT id FROM guest_contacts WHERE phone_e164 = ${e164}))`);
    }
    if (ID.test(filters.q)) subject.push(sql`k.subject_id = ${filters.q}`);
    where.push(subject.length ? sql`(${sql.join(subject, sql` OR `)})` : sql`0`);
  }
  const condition = where.length ? sql.join(where, sql` AND `) : sql`1`;
  const [count] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM consents AS k WHERE ${condition}`);
  const total = num(count?.n);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<{ id: string; kind: ConsentKindKey; granted: number; source: string | null; at: number; policy_version: string | null; subject_type: string; subject_id: string }>(sql`
    SELECT k.id, k.kind, k.granted, k.source, k.at, k.policy_version, k.subject_type, k.subject_id FROM consents AS k
    WHERE ${condition} ORDER BY k.at DESC, k.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`);
  const fullPhone = can(actor, "customer.phone.read_full");
  const customerIds = rows.filter((row) => row.subject_type === "customer").map((row) => row.subject_id);
  const guestIds = rows.filter((row) => row.subject_type === "guest_contact").map((row) => row.subject_id);
  const [people, guests] = await Promise.all([
    customerIds.length ? db.select({ id: customers.id, name: customers.name, phone: customers.phoneE164, status: customers.status }).from(customers).where(inArray(customers.id, [...new Set(customerIds)].slice(0, 90))) : Promise.resolve([]),
    guestIds.length ? db.select({ id: guestContacts.id, phone: guestContacts.phoneE164 }).from(guestContacts).where(inArray(guestContacts.id, [...new Set(guestIds)].slice(0, 90))) : Promise.resolve([]),
  ]);
  const personOf = new Map(people.map((person) => [person.id, person]));
  const guestOf = new Map(guests.map((guest) => [guest.id, guest]));
  return {
    rows: rows.map((row) => {
      const person = row.subject_type === "customer" ? personOf.get(row.subject_id) : undefined;
      return {
        id: row.id,
        kind: row.kind,
        granted: num(row.granted) === 1,
        source: row.source,
        at: num(row.at),
        policyVersion: row.policy_version,
        subjectType: row.subject_type,
        customer: person ? { id: person.id, name: person.name, phone: phoneView(person.phone, fullPhone), status: person.status } : null,
        guestPhone: row.subject_type === "guest_contact" ? phoneView(guestOf.get(row.subject_id)?.phone, fullPhone) : null,
      };
    }),
    total,
    page,
    pageCount,
  };
}

export type ConsentHistoryRow = { id: string; kind: ConsentKindKey; granted: boolean; source: string | null; at: number; policyVersion: string | null };

/** A customer's current answers and every answer they (or staff on their behalf) ever recorded. */
export async function customerConsentHistory(db: Db, actor: Actor, customerId: string): Promise<{ current: ConsentState[]; history: ConsentHistoryRow[] }> {
  assertCan(actor, "customers.consent.read");
  const row = await customerById(db, customerId);
  const [current, history] = await Promise.all([
    currentConsents(db, row.id),
    db
      .select({ id: consents.id, kind: consents.kind, granted: consents.granted, source: consents.source, at: consents.at, policyVersion: consents.policyVersion })
      .from(consents)
      .where(and(eq(consents.subjectType, "customer"), eq(consents.subjectId, row.id)))
      .orderBy(desc(consents.at), desc(consents.id))
      .limit(200),
  ]);
  return { current, history: history.map((entry) => ({ ...entry, kind: entry.kind as ConsentKindKey })) };
}

const reason = z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "required").max(500, "too_long");

export const WithdrawalInput = z.object({ customerId: z.string().regex(ID, "invalid"), kind: z.enum(CONSENT_KIND_LIST, { error: "required" }), reason });
export type WithdrawalInput = z.input<typeof WithdrawalInput>;

/**
 * Records that the customer withdrew a consent (an unsubscribe). Refused when the answer is already "no", and on a
 * merged or erased account (read-only history: the erasure already withdrew what was granted).
 */
export async function recordWithdrawal(db: Db, actor: Actor, raw: WithdrawalInput, now: number): Promise<{ recorded: true }> {
  assertCan(actor, "customers.privacy.manage");
  const input = WithdrawalInput.parse(raw);
  const row = await changeableCustomer(db, input.customerId);
  const current = (await currentConsents(db, row.id)).find((state) => state.kind === input.kind);
  if (current?.granted === false) throw new AppError("consent_not_granted", 409);
  const statement = consentStatement(db, { subjectType: "customer", subjectId: row.id, kind: input.kind, granted: false, source: "admin", ip: actor.kind === "employee" ? (actor.ip ?? null) : null, now });
  await runBatch(db, [
    statement,
    auditStatement(db, { actor, action: "customers.consent.withdraw", entityType: "customer", entityId: row.id, before: { kind: input.kind, granted: current?.granted ?? null }, after: { kind: input.kind, granted: false, policyVersion: CONSENT_POLICY_VERSION }, reason: input.reason, at: now }),
  ]);
  return { recorded: true };
}

// ───────────────────────────────────────────────────────────────── requests

export type PrivacyRequestRow = {
  id: string;
  ref: string;
  kind: PrivacyKind;
  status: PrivacyStatus;
  customer: { id: string; name: string | null; status: string } | null;
  phone: PhoneView | null;
  createdAt: number;
  dueAt: number | null;
  verifiedAt: number | null;
  completedAt: number | null;
  overdue: boolean;
  handledBy: string | null;
};

function requestRow(request: PrivacyRequest, person: { id: string; name: string | null; status: string } | undefined, fullPhone: boolean, names: Map<string, string>, now: number): PrivacyRequestRow {
  const open = (PRIVACY_OPEN_STATUSES as readonly string[]).includes(request.status);
  return {
    id: request.id,
    ref: request.ref,
    kind: request.kind,
    status: request.status,
    customer: person ? { id: person.id, name: person.name, status: person.status } : null,
    phone: phoneView(request.phoneE164, fullPhone),
    createdAt: request.createdAt,
    dueAt: request.dueAt ?? null,
    verifiedAt: request.verifiedAt ?? null,
    completedAt: request.completedAt ?? null,
    overdue: open && request.dueAt !== null && request.dueAt < now,
    handledBy: request.handledBy ? (names.get(request.handledBy) ?? null) : null,
  };
}

async function decorate(db: Db, actor: Actor, rows: PrivacyRequest[], now: number): Promise<PrivacyRequestRow[]> {
  const ids = [...new Set(rows.map((row) => row.customerId).filter((id): id is string => Boolean(id)))];
  const [people, names] = await Promise.all([
    ids.length ? db.select({ id: customers.id, name: customers.name, status: customers.status }).from(customers).where(inArray(customers.id, ids.slice(0, 90))) : Promise.resolve([]),
    employeeNames(
      db,
      rows.map((row) => row.handledBy),
    ),
  ]);
  const personOf = new Map(people.map((person) => [person.id, person]));
  const fullPhone = can(actor, "customer.phone.read_full");
  return rows.map((row) => requestRow(row, row.customerId ? personOf.get(row.customerId) : undefined, fullPhone, names, now));
}

export async function listPrivacyRequests(db: Db, actor: Actor, filters: PrivacyFilters, now: number): Promise<{ rows: PrivacyRequestRow[]; total: number; page: number; pageCount: number }> {
  assertCan(actor, "customers.privacy.manage");
  const where: SQL[] = [];
  if (filters.view === "open") where.push(inArray(privacyRequests.status, [...PRIVACY_OPEN_STATUSES]));
  if (filters.view === "overdue") where.push(and(inArray(privacyRequests.status, [...PRIVACY_OPEN_STATUSES]), sql`${privacyRequests.dueAt} < ${now}`) as SQL);
  if (filters.view === "done") where.push(inArray(privacyRequests.status, ["completed", "rejected"]));
  if (filters.kind) where.push(eq(privacyRequests.kind, filters.kind));
  const condition = where.length ? and(...where) : undefined;
  const count = await db.select({ n: sql<number>`count(*)` }).from(privacyRequests).where(condition).get();
  const total = num(count?.n);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db
    .select()
    .from(privacyRequests)
    .where(condition)
    .orderBy(sql`CASE WHEN ${privacyRequests.status} IN ('open', 'verifying', 'in_progress') THEN 0 ELSE 1 END`, sql`${privacyRequests.dueAt} IS NULL`, privacyRequests.dueAt, desc(privacyRequests.createdAt))
    .limit(PAGE_SIZE)
    .offset((page - 1) * PAGE_SIZE);
  return { rows: await decorate(db, actor, rows, now), total, page, pageCount };
}

/** Open requests and the overdue ones (the module's queue cards); null without customers.privacy.manage. */
export async function privacyCounts(db: Db, actor: Actor, now: number): Promise<{ open: number; overdue: number } | null> {
  if (!can(actor, "customers.privacy.manage")) return null;
  const row = await db
    .select({
      open: sql<number>`coalesce(sum(CASE WHEN ${privacyRequests.status} IN ('open', 'verifying', 'in_progress') THEN 1 ELSE 0 END), 0)`,
      overdue: sql<number>`coalesce(sum(CASE WHEN ${privacyRequests.status} IN ('open', 'verifying', 'in_progress') AND ${privacyRequests.dueAt} < ${now} THEN 1 ELSE 0 END), 0)`,
    })
    .from(privacyRequests)
    .get();
  return { open: num(row?.open), overdue: num(row?.overdue) };
}

async function requestByRef(db: Db, ref: string): Promise<PrivacyRequest> {
  const value = typeof ref === "string" ? ref.trim().toUpperCase() : "";
  if (!/^PR-[A-Z0-9]{4,16}$/.test(value)) throw notFound("privacy_request");
  const row = await db.select().from(privacyRequests).where(eq(privacyRequests.ref, value)).get();
  if (!row) throw notFound("privacy_request");
  return row;
}

export type RequestHistoryRow = { id: string; action: string; by: string | null; at: number; reason: string | null; method: string | null };

export type PrivacyRequestDetail = PrivacyRequestRow & {
  details: string | null;
  resolutionNote: string | null;
  verifyMethod: string | null;
  history: RequestHistoryRow[];
  exports: { at: number; by: string | null; sha256: string | null; bytes: number | null }[];
  erasure: ErasurePlan | null;
  can: { verify: boolean; reject: boolean; complete: boolean; export: boolean; erase: boolean; unsubscribe: boolean };
};

export async function getPrivacyRequest(db: Db, actor: Actor, ref: string, now: number): Promise<PrivacyRequestDetail> {
  assertCan(actor, "customers.privacy.manage");
  const request = await requestByRef(db, ref);
  const [row] = await decorate(db, actor, [request], now);
  const events = await db
    .select({ id: auditEvents.id, action: auditEvents.action, actorId: auditEvents.actorId, actorLabel: auditEvents.actorLabel, at: auditEvents.at, reason: auditEvents.reason, after: auditEvents.after })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "privacy_request"), eq(auditEvents.entityId, request.id)))
    .orderBy(desc(auditEvents.seq))
    .limit(50);
  const names = await employeeNames(
    db,
    events.map((event) => event.actorId),
  );
  const by = (event: (typeof events)[number]) => (event.actorId && names.get(event.actorId)) || event.actorLabel || null;
  const verify = events.find((event) => event.action === "customers.privacy.verify");
  const open = (PRIVACY_OPEN_STATUSES as readonly string[]).includes(request.status);
  const verified = request.verifiedAt !== null && request.status === "in_progress";
  const erasure = request.kind === "delete" && request.customerId && open ? erasureFor(actor, await planFor(db, request.customerId)) : null;
  return {
    ...row,
    details: request.details,
    resolutionNote: request.resolutionNote,
    verifyMethod: String((verify?.after as { method?: string } | null)?.method ?? "") || null,
    history: events.map((event) => ({ id: event.id, action: event.action, by: by(event), at: event.at, reason: event.reason, method: String((event.after as { method?: string } | null)?.method ?? "") || null })),
    exports: events
      .filter((event) => event.action === "customers.privacy.export")
      .map((event) => {
        const after = (event.after ?? {}) as { sha256?: string; bytes?: number };
        return { at: event.at, by: by(event), sha256: after.sha256 ?? null, bytes: typeof after.bytes === "number" ? after.bytes : null };
      }),
    erasure,
    can: {
      verify: open && request.verifiedAt === null,
      reject: open,
      complete: verified && (request.kind === "export" || request.kind === "rectify"),
      // a new copy of the file only while the request is being worked on (never once it is finished or rejected)
      export: request.kind === "export" && verified && Boolean(request.customerId),
      erase: verified && request.kind === "delete" && Boolean(erasure && erasure.blockers.length === 0),
      unsubscribe: verified && request.kind === "unsubscribe",
    },
  };
}

const blank = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value === null ? undefined : value);

export const CreateRequestInput = z.object({
  customerId: z.preprocess(blank, z.string().regex(ID, "invalid").optional()),
  phone: z.preprocess(blank, z.string().trim().max(40, "phone_invalid").optional()),
  kind: z.enum(PRIVACY_KIND_LIST, { error: "required" }),
  details: z.preprocess(blank, z.string().overwrite(cleanBlock).trim().max(1000, "too_long").optional()),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});
export type CreateRequestInput = z.input<typeof CreateRequestInput>;

/**
 * Opens a request on the customer's behalf, due in PRIVACY_DUE_DAYS. A phone that belongs to an account links the
 * request to it. One open request per customer and kind (privacy_open_exists). Idempotent on the key.
 */
export async function createPrivacyRequest(db: Db, actor: Actor, raw: CreateRequestInput, now: number): Promise<{ ref: string; replayed: boolean }> {
  assertCan(actor, "customers.privacy.manage");
  const input = CreateRequestInput.parse(raw);
  const id = `prq_${(await sha256Hex(`privacy:${input.idempotencyKey}`)).slice(0, 26)}`;
  const earlier = await db.select({ ref: privacyRequests.ref }).from(privacyRequests).where(eq(privacyRequests.id, id)).get();
  if (earlier) return { ref: earlier.ref, replayed: true };

  let customerId: string | null = null;
  let phoneE164: string | null = null;
  if (input.customerId) {
    const row = await customerById(db, input.customerId);
    if (row.status === "merged" || row.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: row.status });
    customerId = row.id;
    phoneE164 = row.phoneE164;
  } else if (input.phone) {
    phoneE164 = normalizeIraqPhone(input.phone);
    if (!phoneE164) throw invalid({ phone: "phone_invalid" });
    const owner = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.phoneE164, phoneE164)).get();
    if (owner && owner.status !== "merged" && owner.status !== "deleted") customerId = owner.id;
  } else {
    throw invalid({ phone: "required" });
  }
  // Everything but an unsubscribe of a guest number needs an account to act on.
  if (!customerId && input.kind !== "unsubscribe") throw new AppError("privacy_customer_required", 409);
  // One open request per kind for an account — and for a visitor's number without one.
  const subject = customerId ? eq(privacyRequests.customerId, customerId) : and(isNull(privacyRequests.customerId), eq(privacyRequests.phoneE164, phoneE164 as string));
  const open = await db
    .select({ ref: privacyRequests.ref })
    .from(privacyRequests)
    .where(and(subject, eq(privacyRequests.kind, input.kind), inArray(privacyRequests.status, [...PRIVACY_OPEN_STATUSES])))
    .get();
  if (open) throw new AppError("privacy_open_exists", 409, { detail: open.ref });
  const ref = publicRef("PR");
  try {
    await runBatch(db, [
      db.insert(privacyRequests).values({ id, ref, customerId, phoneE164: phoneE164 as string, kind: input.kind, status: "open", details: input.details ?? null, dueAt: now + PRIVACY_DUE_DAYS * DAY_MS, createdAt: now }),
      auditStatement(db, { actor, action: "customers.privacy.open", entityType: "privacy_request", entityId: id, after: { ref, kind: input.kind, customerId, dueDays: PRIVACY_DUE_DAYS }, reason: input.details ?? null, at: now }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.select({ ref: privacyRequests.ref }).from(privacyRequests).where(eq(privacyRequests.id, id)).get();
      if (raced) return { ref: raced.ref, replayed: true };
    }
    throw error;
  }
  return { ref, replayed: false };
}

export const VerifyInput = z.object({ ref: z.string().min(1, "required").max(40, "invalid"), method: z.enum(VERIFY_METHODS, { error: "required" }), note: reason });
export type VerifyInput = z.input<typeof VerifyInput>;

function guardCode(error: unknown, map: Record<string, string>): never {
  const code = mapDbError(error)?.code;
  if (code && map[code]) throw new AppError(map[code], 409);
  throw error;
}

/** Records how the person was confirmed to be the account holder; the request moves to "in progress". */
export async function verifyPrivacyRequest(db: Db, actor: Actor, raw: VerifyInput, now: number): Promise<{ status: "in_progress" }> {
  assertCan(actor, "customers.privacy.manage");
  const input = VerifyInput.parse(raw);
  const request = await requestByRef(db, input.ref);
  if (request.verifiedAt !== null) throw new AppError("privacy_already_verified", 409);
  if (!(PRIVACY_OPEN_STATUSES as readonly string[]).includes(request.status)) throw new AppError("privacy_not_open", 409);
  await runBatch(db, [
    db
      .update(privacyRequests)
      .set({ status: "in_progress", verifiedAt: now, handledBy: actorId(actor) })
      .where(and(eq(privacyRequests.id, request.id), sql`${privacyRequests.verifiedAt} IS NULL`, inArray(privacyRequests.status, ["open", "verifying"]))),
    expectChanged(db, 1, { code: "PRIVACY_CHANGED", detail: request.id }),
    auditStatement(db, { actor, action: "customers.privacy.verify", entityType: "privacy_request", entityId: request.id, before: { status: request.status }, after: { status: "in_progress", method: input.method }, reason: input.note, at: now }),
  ]).catch((error) => guardCode(error, { PRIVACY_CHANGED: "privacy_not_open" }));
  return { status: "in_progress" };
}

export const CloseInput = z.object({ ref: z.string().min(1, "required").max(40, "invalid"), note: reason });
export type CloseInput = z.input<typeof CloseInput>;

/** Rejects a request with the reason (for example: the person could not be verified). */
export async function rejectPrivacyRequest(db: Db, actor: Actor, raw: CloseInput, now: number): Promise<{ status: "rejected" }> {
  assertCan(actor, "customers.privacy.manage");
  const input = CloseInput.parse(raw);
  const request = await requestByRef(db, input.ref);
  if (!(PRIVACY_OPEN_STATUSES as readonly string[]).includes(request.status)) throw new AppError("privacy_not_open", 409);
  await runBatch(db, [
    db
      .update(privacyRequests)
      .set({ status: "rejected", completedAt: now, handledBy: actorId(actor), resolutionNote: input.note })
      .where(and(eq(privacyRequests.id, request.id), inArray(privacyRequests.status, [...PRIVACY_OPEN_STATUSES]))),
    expectChanged(db, 1, { code: "PRIVACY_CHANGED", detail: request.id }),
    auditStatement(db, { actor, action: "customers.privacy.reject", entityType: "privacy_request", entityId: request.id, before: { status: request.status }, after: { status: "rejected" }, reason: input.note, at: now }),
  ]).catch((error) => guardCode(error, { PRIVACY_CHANGED: "privacy_not_open" }));
  return { status: "rejected" };
}

/**
 * Completes a verified export (after the file was downloaded at least once) or correction request, with a note of
 * what was handed over or corrected.
 */
export async function completePrivacyRequest(db: Db, actor: Actor, raw: CloseInput, now: number): Promise<{ status: "completed" }> {
  assertCan(actor, "customers.privacy.manage");
  const input = CloseInput.parse(raw);
  const request = await requestByRef(db, input.ref);
  if (request.status !== "in_progress" || request.verifiedAt === null) throw new AppError(request.verifiedAt === null ? "privacy_not_verified" : "privacy_not_open", 409);
  if (request.kind !== "export" && request.kind !== "rectify") throw new AppError("privacy_wrong_kind", 409);
  const statements: BatchStatement[] = [];
  if (request.kind === "export") {
    statements.push(
      expectThat(
        db,
        sql`EXISTS (SELECT 1 FROM audit_events WHERE action = 'customers.privacy.export' AND entity_type = 'privacy_request' AND entity_id = ${request.id})`,
        { code: "PRIVACY_NOT_EXPORTED", detail: request.id },
      ),
    );
  }
  statements.push(
    db
      .update(privacyRequests)
      .set({ status: "completed", completedAt: now, handledBy: actorId(actor), resolutionNote: input.note })
      .where(and(eq(privacyRequests.id, request.id), eq(privacyRequests.status, "in_progress"))),
    expectChanged(db, 1, { code: "PRIVACY_CHANGED", detail: request.id }),
    auditStatement(db, { actor, action: "customers.privacy.complete", entityType: "privacy_request", entityId: request.id, before: { status: request.status }, after: { status: "completed", kind: request.kind }, reason: input.note, at: now }),
  );
  await runBatch(db, statements).catch((error) => guardCode(error, { PRIVACY_CHANGED: "privacy_not_open", PRIVACY_NOT_EXPORTED: "privacy_not_exported" }));
  return { status: "completed" };
}

export const UnsubscribeInput = z.object({
  ref: z.string().min(1, "required").max(40, "invalid"),
  kinds: z.array(z.enum(CONSENT_KIND_LIST)).min(1, "required"),
  note: reason,
});
export type UnsubscribeInput = z.input<typeof UnsubscribeInput>;

/**
 * The guest contacts (checkouts without an account) of a person: those the account claimed and those on its number.
 * Their consent answers are the same person's answers, so an unsubscribe or an erasure reaches them too.
 */
async function personGuestContacts(db: Db, customerId: string | null, phoneE164: string | null): Promise<string[]> {
  const phone = phoneE164?.startsWith("+964") ? phoneE164 : null;
  const conditions = [customerId ? eq(guestContacts.customerId, customerId) : undefined, phone ? eq(guestContacts.phoneE164, phone) : undefined].filter((condition): condition is SQL => condition !== undefined);
  if (conditions.length === 0) return [];
  const rows = await db
    .select({ id: guestContacts.id })
    .from(guestContacts)
    .where(or(...conditions))
    .limit(200);
  return rows.map((row) => row.id);
}

/**
 * Records the withdrawals an unsubscribe request asked for (marketing at least) and completes it, in one batch: on the
 * account and on the answers the same person gave at checkout as a guest (guest contacts of the account or its number)
 * — review 2026-11-11: those stayed "granted"; for a visitor's number, on its guest contacts only.
 */
export async function executeUnsubscribe(db: Db, actor: Actor, raw: UnsubscribeInput, now: number): Promise<{ withdrawn: ConsentKindKey[] }> {
  assertCan(actor, "customers.privacy.manage");
  const input = UnsubscribeInput.parse(raw);
  const request = await requestByRef(db, input.ref);
  if (request.kind !== "unsubscribe") throw new AppError("privacy_wrong_kind", 409);
  if (request.status !== "in_progress" || request.verifiedAt === null) throw new AppError(request.verifiedAt === null ? "privacy_not_verified" : "privacy_not_open", 409);
  const guests = await personGuestContacts(db, request.customerId, request.phoneE164);
  const subjects: { subjectType: "customer" | "guest_contact"; subjectId: string }[] = [
    ...(request.customerId ? [{ subjectType: "customer" as const, subjectId: request.customerId }] : []),
    ...guests.map((id) => ({ subjectType: "guest_contact" as const, subjectId: id })),
  ];
  const rows: { subjectType: "customer" | "guest_contact"; subjectId: string; kind: ConsentKindKey }[] = [];
  for (const subject of subjects) {
    const answers = await db
      .select({ kind: consents.kind, granted: consents.granted })
      .from(consents)
      .where(and(eq(consents.subjectType, subject.subjectType), eq(consents.subjectId, subject.subjectId)))
      .orderBy(desc(consents.at), desc(consents.id));
    for (const kind of new Set(input.kinds)) {
      const latest = answers.find((answer) => answer.kind === kind);
      if (latest?.granted !== false) rows.push({ ...subject, kind });
    }
  }
  const withdrawn = [...new Set(rows.map((row) => row.kind))];
  await runBatch(db, [
    ...rows.map((row) => consentStatement(db, { subjectType: row.subjectType, subjectId: row.subjectId, kind: row.kind, granted: false, source: "privacy_request", ip: null, now })),
    db
      .update(privacyRequests)
      .set({ status: "completed", completedAt: now, handledBy: actorId(actor), resolutionNote: input.note })
      .where(and(eq(privacyRequests.id, request.id), eq(privacyRequests.status, "in_progress"))),
    expectChanged(db, 1, { code: "PRIVACY_CHANGED", detail: request.id }),
    auditStatement(db, { actor, action: "customers.privacy.unsubscribe", entityType: "privacy_request", entityId: request.id, after: { customerId: request.customerId, withdrawn, guestContacts: guests.length }, reason: input.note, at: now }),
  ]).catch((error) => guardCode(error, { PRIVACY_CHANGED: "privacy_not_open" }));
  return { withdrawn };
}

// ───────────────────────────────────────────────────────────────── export

/**
 * The customer's own data as a JSON document, built now for a verified export request that is still in progress; each
 * build is audited with the file's SHA-256 and size (the trail shows exactly what was handed over). Once the request is
 * completed or rejected no new copy is made (privacy_not_open) — another copy needs a new request. No cost data, no
 * staff notes, no fraud assessment, no other person's data.
 */
export async function buildPrivacyExport(db: Db, actor: Actor, ref: string, now: number): Promise<{ filename: string; body: string; sha256: string }> {
  assertCan(actor, "customers.privacy.manage");
  const request = await requestByRef(db, ref);
  if (request.kind !== "export") throw new AppError("privacy_wrong_kind", 409);
  if (request.verifiedAt === null) throw new AppError("privacy_not_verified", 409);
  if (request.status !== "in_progress") throw new AppError("privacy_not_open", 409);
  if (!request.customerId) throw new AppError("privacy_customer_required", 409);
  const id = request.customerId;
  const customer = await customerById(db, id);
  const q = <T>(query: SQL) => db.all<T>(query);
  const [addressRows, orderRows, itemRows, paymentRows, refundRows, walletRows, topupRows, returnRows, warrantyRows, repairRows, ticketRows, messageRows, consentRows, notificationRows, wishlistRows, deviceRows, reviewRows, tradeRows] = await Promise.all([
    q(sql`SELECT label, recipient_name, phone_e164, governorate_id, district_id, area_text, address_text, notes, is_default, created_at FROM addresses WHERE customer_id = ${id}`),
    // the shopper's own note is theirs; the staff's cancel reason and internal notes are not (fraud assessments)
    q(sql`SELECT ref, channel, status, payment_status, payment_method, subtotal_iqd, discount_iqd, shipping_iqd, tax_iqd, total_iqd, paid_iqd, refunded_iqd, contact_name, contact_phone_e164, governorate_id, district_id, area_text, address_text, notes, preferred_day, preferred_window, marketing_consent, placed_at, confirmed_at, shipped_at, delivered_at, cancelled_at FROM orders WHERE customer_id = ${id} ORDER BY placed_at`),
    q(sql`SELECT o.ref AS order_ref, i.sku, i.name_snapshot, i.options_snapshot, i.unit_price_iqd, i.qty, i.discount_iqd, i.total_iqd, i.refunded_qty, i.warranty_months FROM order_items AS i JOIN orders AS o ON o.id = i.order_id WHERE o.customer_id = ${id}`),
    q(sql`SELECT o.ref AS order_ref, p.method, p.status, p.amount_iqd, p.created_at FROM payments AS p JOIN orders AS o ON o.id = p.order_id WHERE o.customer_id = ${id}`),
    q(sql`SELECT o.ref AS order_ref, r.amount_iqd, r.method, r.status, r.created_at FROM refunds AS r JOIN orders AS o ON o.id = r.order_id WHERE o.customer_id = ${id}`),
    q(sql`SELECT kind, amount_iqd, ref_type, at FROM wallet_ledger WHERE customer_id = ${id} ORDER BY at`),
    q(sql`SELECT ref, method, amount_iqd, declared_amount_iqd, status, reject_reason, created_at FROM wallet_topups WHERE customer_id = ${id}`),
    q(sql`SELECT r.rma, o.ref AS order_ref, r.status, r.reason_code, r.reason, r.resolution, r.created_at FROM returns AS r LEFT JOIN orders AS o ON o.id = r.order_id WHERE r.customer_id = ${id}`),
    q(sql`SELECT i.name_snapshot, w.starts_at, w.ends_at, w.status, w.terms FROM warranties AS w JOIN order_items AS i ON i.id = w.order_item_id WHERE w.customer_id = ${id}`),
    q(sql`SELECT ref, status, issue, diagnosis, resolution, quote_iqd, cost_iqd, created_at FROM repair_tickets WHERE customer_id = ${id}`),
    q(sql`SELECT t.ref, t.subject, t.category, t.status, t.created_at, (SELECT json_group_array(json_object('at', m.created_at, 'from', m.author_kind, 'body', m.body)) FROM ticket_messages AS m WHERE m.ticket_id = t.id AND m.is_internal = 0) AS messages FROM support_tickets AS t WHERE t.customer_id = ${id}`),
    q(sql`SELECT channel, template, status, created_at, sent_at FROM outbox WHERE customer_id = ${id} ORDER BY created_at`),
    q(sql`SELECT kind, granted, source, at, policy_version FROM consents WHERE subject_type = 'customer' AND subject_id = ${id} ORDER BY at`),
    q(sql`SELECT kind, title, body, link, read_at, created_at FROM notifications WHERE customer_id = ${id}`),
    q(sql`SELECT p.slug, w.created_at FROM wishlist_items AS w JOIN products AS p ON p.id = w.product_id WHERE w.customer_id = ${id}`),
    q(sql`SELECT d.slug, s.created_at FROM saved_devices AS s JOIN device_models AS d ON d.id = s.device_model_id WHERE s.customer_id = ${id}`),
    q(sql`SELECT p.slug, r.rating, r.title, r.body, r.status, r.created_at FROM reviews AS r JOIN products AS p ON p.id = r.product_id WHERE r.customer_id = ${id}`),
    q(sql`SELECT ref, status, estimate_min_iqd, estimate_max_iqd, final_offer_iqd, payout_method, created_at FROM trade_ins WHERE customer_id = ${id}`),
  ]);
  const document = {
    format: "tamtam-privacy-export",
    version: 1,
    request: { ref: request.ref, kind: request.kind, createdAt: new Date(request.createdAt).toISOString(), verifiedAt: request.verifiedAt ? new Date(request.verifiedAt).toISOString() : null },
    generatedAt: new Date(now).toISOString(),
    note: "Amounts are whole Iraqi dinars (IQD). Times are UTC milliseconds unless written as ISO dates.",
    account: {
      id: customer.id,
      name: customer.name,
      phone: customer.phoneE164.startsWith("+964") ? customer.phoneE164 : null,
      email: customer.email,
      language: customer.locale,
      status: customer.status,
      createdAt: new Date(customer.createdAt).toISOString(),
      notificationChannels: customer.notificationPrefs ?? {},
    },
    addresses: addressRows,
    orders: orderRows,
    orderItems: itemRows,
    payments: paymentRows,
    refunds: refundRows,
    wallet: walletRows,
    walletTopups: topupRows,
    returns: returnRows,
    warranties: warrantyRows,
    repairs: repairRows,
    supportTickets: ticketRows,
    messages: messageRows,
    consents: consentRows,
    notifications: notificationRows,
    wishlist: wishlistRows,
    savedDevices: deviceRows,
    reviews: reviewRows,
    tradeIns: tradeRows,
  };
  const body = JSON.stringify(document, null, 2);
  const sha256 = await sha256Hex(body);
  await runBatch(db, [
    auditStatement(db, {
      actor,
      action: "customers.privacy.export",
      entityType: "privacy_request",
      entityId: request.id,
      after: { ref: request.ref, customerId: id, sha256, bytes: new TextEncoder().encode(body).byteLength, orders: orderRows.length, addresses: addressRows.length, consents: consentRows.length },
      at: now,
    }),
  ]);
  return { filename: `privacy-export-${request.ref}.json`, body, sha256 };
}

// ───────────────────────────────────────────────────────────────── erasure

export type ErasureBlocker = { code: "open_orders" | "wallet_balance" | "pending_topups" | "pending_adjustments" | "open_returns" | "open_repairs" | "account_merged" | "account_erased"; count: number; amountIqd?: number };
export type ErasurePlan = { customerId: string; erased: Record<ErasedPart, number>; kept: Record<KeptPart, number>; blockers: ErasureBlocker[] };

/** The customer's returns — also an RMA filed without the account on one of its orders. */
const customerReturns = (customerId: string) => sql`(customer_id = ${customerId} OR order_id IN (SELECT id FROM orders WHERE customer_id = ${customerId}))`;

/**
 * The person behind an account: the account itself and every account merged into it (directly or through a chain —
 * staff verified they are the same person), with the real numbers among them.
 */
type Person = { ids: string[]; merged: string[]; phones: string[] };
async function personOf(db: Db, customer: { id: string; phoneE164: string }): Promise<Person> {
  const merged = await db.all<{ id: string; phone_e164: string }>(sql`
    WITH RECURSIVE folded(id) AS (
      SELECT id FROM customers WHERE merged_into_id = ${customer.id}
      UNION SELECT c.id FROM customers AS c JOIN folded AS f ON c.merged_into_id = f.id
    )
    SELECT c.id, c.phone_e164 FROM customers AS c JOIN folded AS f ON f.id = c.id ORDER BY c.id LIMIT 40`);
  const phones = [customer.phoneE164, ...merged.map((row) => row.phone_e164)].filter((phone) => phone.startsWith("+964"));
  return { ids: [customer.id, ...merged.map((row) => row.id)], merged: merged.map((row) => row.id), phones };
}
const idsOf = (values: readonly string[]) => inList(values);
/** Rows of the person (the account and its merged accounts) in a table with a `customer_id` column. */
const ofPerson = (person: Person) => sql`customer_id IN (${idsOf(person.ids)})`;
/** The person's guest contacts (checkouts without an account): claimed by one of its accounts, or on one of its numbers. */
const personGuests = (person: Person) => (person.phones.length ? sql`(${ofPerson(person)} OR phone_e164 IN (${idsOf(person.phones)}))` : ofPerson(person));

/** What erasing this customer would remove and keep, and what stands in the way. */
async function planFor(db: Db, customerId: string): Promise<ErasurePlan> {
  const customer = await customerById(db, customerId);
  const person = await personOf(db, customer);
  const one = async (query: SQL) => num((await db.all<{ n: number }>(query))[0]?.n);
  const [addressN, deviceN, wishN, recentN, noticeN, sessionN, segmentN, cartN, guestN, browsingN, orderN, paymentN, walletN, walletSum, consentN, auditN, returnN, warrantyN, ticketN, tradeN, messageN, openOrders, topups, adjustments, openReturns, openRepairs] = await Promise.all([
    one(sql`SELECT count(*) AS n FROM addresses WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM saved_devices WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM wishlist_items WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM recently_viewed WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM notifications WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM customer_sessions WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM customer_segment_members WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM carts WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM guest_contacts WHERE ${personGuests(person)}`),
    one(sql`SELECT count(*) AS n FROM recommendation_events WHERE ${ofPerson(person)}`),
    one(sql`SELECT count(*) AS n FROM orders WHERE customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM payments AS p JOIN orders AS o ON o.id = p.order_id WHERE o.customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM wallet_ledger WHERE customer_id = ${customerId}`),
    one(sql`SELECT coalesce(sum(amount_iqd), 0) AS n FROM wallet_ledger WHERE customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM consents WHERE subject_type = 'customer' AND subject_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM audit_events WHERE entity_type = 'customer' AND entity_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM returns WHERE ${customerReturns(customerId)}`),
    one(sql`SELECT count(*) AS n FROM warranties WHERE customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM support_tickets WHERE customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM trade_ins WHERE customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM outbox WHERE customer_id = ${customerId}`),
    one(sql`SELECT count(*) AS n FROM orders WHERE customer_id = ${customerId} AND status IN (${inList(OPEN_ORDER_STATUSES)})`),
    one(sql`SELECT count(*) AS n FROM wallet_topups WHERE customer_id = ${customerId} AND status = 'pending_verification'`),
    one(sql`SELECT count(*) AS n FROM approvals WHERE kind = 'wallet_adjustment' AND entity_id = ${customerId} AND status = 'pending'`),
    one(sql`SELECT count(*) AS n FROM returns WHERE ${customerReturns(customerId)} AND status IN (${inList(RETURN_OPEN)})`),
    one(sql`SELECT count(*) AS n FROM repair_tickets WHERE customer_id = ${customerId} AND status NOT IN (${inList(REPAIR_DONE)})`),
  ]);
  const blockers: ErasureBlocker[] = [];
  if (customer.status === "merged") blockers.push({ code: "account_merged", count: 1 });
  if (customer.status === "deleted") blockers.push({ code: "account_erased", count: 1 });
  if (openOrders > 0) blockers.push({ code: "open_orders", count: openOrders });
  if (walletSum !== 0) blockers.push({ code: "wallet_balance", count: 1, amountIqd: walletSum });
  if (topups > 0) blockers.push({ code: "pending_topups", count: topups });
  if (adjustments > 0) blockers.push({ code: "pending_adjustments", count: adjustments });
  if (openReturns > 0) blockers.push({ code: "open_returns", count: openReturns });
  if (openRepairs > 0) blockers.push({ code: "open_repairs", count: openRepairs });
  return {
    customerId,
    erased: { profile: 1, mergedAccounts: person.merged.length, addresses: addressN, savedDevices: deviceN, wishlist: wishN, recentlyViewed: recentN, browsing: browsingN, notifications: noticeN, sessions: sessionN, segments: segmentN, carts: cartN, guestContacts: guestN },
    kept: { orders: orderN, payments: paymentN, wallet: walletN, consents: consentN, audit: auditN, returns: returnN, warranties: warrantyN, tickets: ticketN, tradeIns: tradeN, messages: messageN, request: 1 },
    blockers,
  };
}

/** The plan as this employee may see it: the wallet's amount only with customers.wallet.read (review 2026-11-11). */
function erasureFor(actor: Actor, plan: ErasurePlan): ErasurePlan {
  if (can(actor, "customers.wallet.read")) return plan;
  return { ...plan, blockers: plan.blockers.map(({ amountIqd: _amount, ...blocker }) => blocker) };
}

export async function planErasure(db: Db, actor: Actor, ref: string): Promise<ErasurePlan> {
  assertCan(actor, "customers.privacy.manage");
  const request = await requestByRef(db, ref);
  if (request.kind !== "delete") throw new AppError("privacy_wrong_kind", 409);
  if (!request.customerId) throw new AppError("privacy_customer_required", 409);
  return erasureFor(actor, await planFor(db, request.customerId));
}

type Answer = { subjectType: "customer" | "guest_contact"; subjectId: string; kind: ConsentKindKey };

/** The answers whose newest row is still "granted" among these subjects: (subject, question) pairs to withdraw. */
async function grantedAnswers(db: Db, subjectType: Answer["subjectType"], subjects: SQL): Promise<Answer[]> {
  const rows = await db.all<{ subject_id: string; kind: ConsentKindKey; granted: number }>(sql`
    SELECT subject_id, kind, granted FROM consents WHERE subject_type = ${subjectType} AND subject_id IN (${subjects}) ORDER BY at DESC, id DESC`);
  const seen = new Set<string>();
  const out: Answer[] = [];
  for (const row of rows) {
    const key = `${row.subject_id}|${row.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (num(row.granted) === 1) out.push({ subjectType, subjectId: row.subject_id, kind: row.kind });
  }
  return out;
}

/** Every answer of the person still "granted": its accounts' and its checkouts' as a guest. */
async function personGrantedAnswers(db: Db, person: Person): Promise<Answer[]> {
  const [accounts, guests] = await Promise.all([grantedAnswers(db, "customer", idsOf(person.ids)), grantedAnswers(db, "guest_contact", sql`SELECT id FROM guest_contacts WHERE ${personGuests(person)}`)]);
  return [...accounts, ...guests];
}

export const EraseInput = z.object({ ref: z.string().min(1, "required").max(40, "invalid"), reason });
export type EraseInput = z.input<typeof EraseInput>;

/** What an erasure clears on an account row (the merged accounts of the person keep their status "merged"). */
const anonymized = (customerId: string, now: number) => ({
  name: null,
  email: null,
  passwordHash: null,
  passwordIters: null,
  notes: null,
  notificationPrefs: null,
  vipTier: null,
  fraudReason: null,
  phoneE164: erasedPhone(customerId),
  anonymizedAt: now,
  updatedAt: now,
});

/**
 * Carries out a verified deletion request (07.04, retention rules above), in ONE batch: guards (still verified and in
 * progress, still no open order, return or repair, no wallet money, no pending top-up or adjustment — each checked
 * again inside the batch), the account anonymized together with the accounts merged into it (the same person: their
 * rows stay "merged" but lose name, e-mail, number and notes), the personal records removed (the consented browsing
 * signals and the name on the person's guest contacts too), every consent still granted withdrawn — the accounts' and
 * the ones the person gave at checkout as a guest, so nothing can be sent to those numbers any more —, the request
 * completed, audit events with counts only (the trail must not keep what was erased).
 */
export async function executeErasure(db: Db, actor: Actor, raw: EraseInput, now: number): Promise<{ status: "completed"; erased: Record<ErasedPart, number> }> {
  assertCan(actor, "customers.privacy.manage");
  const input = EraseInput.parse(raw);
  const request = await requestByRef(db, input.ref);
  if (request.kind !== "delete") throw new AppError("privacy_wrong_kind", 409);
  if (request.status !== "in_progress" || request.verifiedAt === null) throw new AppError(request.verifiedAt === null ? "privacy_not_verified" : "privacy_not_open", 409);
  if (!request.customerId) throw new AppError("privacy_customer_required", 409);
  const customerId = request.customerId;
  const plan = await planFor(db, customerId);
  if (plan.blockers.length > 0) throw new AppError("erasure_blocked", 409, { detail: plan.blockers.map((blocker) => blocker.code).join(",") });
  const person = await personOf(db, await customerById(db, customerId));
  const answers = await personGrantedAnswers(db, person);
  const toWithdraw = answers.filter((answer) => answer.subjectType === "customer" && answer.subjectId === customerId).map((answer) => answer.kind);

  const statements: BatchStatement[] = [
    expectThat(db, sql`(SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger WHERE customer_id = ${customerId}) = 0`, { code: "ERASURE_BLOCKED", detail: "wallet_balance" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM orders WHERE customer_id = ${customerId} AND status IN (${inList(OPEN_ORDER_STATUSES)}))`, { code: "ERASURE_BLOCKED", detail: "open_orders" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM wallet_topups WHERE customer_id = ${customerId} AND status = 'pending_verification')`, { code: "ERASURE_BLOCKED", detail: "pending_topups" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM approvals WHERE kind = 'wallet_adjustment' AND entity_id = ${customerId} AND status = 'pending')`, { code: "ERASURE_BLOCKED", detail: "pending_adjustments" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM returns WHERE ${customerReturns(customerId)} AND status IN (${inList(RETURN_OPEN)}))`, { code: "ERASURE_BLOCKED", detail: "open_returns" }),
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM repair_tickets WHERE customer_id = ${customerId} AND status NOT IN (${inList(REPAIR_DONE)}))`, { code: "ERASURE_BLOCKED", detail: "open_repairs" }),
    db
      .update(customers)
      .set({ ...anonymized(customerId, now), status: "deleted" })
      .where(and(eq(customers.id, customerId), inArray(customers.status, ["active", "blocked"]))),
    expectChanged(db, 1, { code: "CUSTOMER_CHANGED", detail: customerId }),
    ...person.merged.map((mergedId) =>
      db
        .update(customers)
        .set(anonymized(mergedId, now))
        .where(and(eq(customers.id, mergedId), eq(customers.status, "merged"))),
    ),
    db.delete(addresses).where(inArray(addresses.customerId, person.ids)),
    db.delete(savedDevices).where(inArray(savedDevices.customerId, person.ids)),
    db.delete(wishlistItems).where(inArray(wishlistItems.customerId, person.ids)),
    db.delete(recentlyViewed).where(inArray(recentlyViewed.customerId, person.ids)),
    db.delete(notifications).where(inArray(notifications.customerId, person.ids)),
    db.delete(customerSessions).where(inArray(customerSessions.customerId, person.ids)),
    db.delete(customerSegmentMembers).where(inArray(customerSegmentMembers.customerId, person.ids)),
    db.delete(recommendationEvents).where(inArray(recommendationEvents.customerId, person.ids)),
    db.update(carts).set({ customerId: null }).where(inArray(carts.customerId, person.ids)),
    batchSql(db, sql`UPDATE guest_contacts SET name = NULL WHERE ${personGuests(person)}`),
    ...answers.map((answer) => consentStatement(db, { subjectType: answer.subjectType, subjectId: answer.subjectId, kind: answer.kind, granted: false, source: "erasure", ip: null, now })),
    db
      .update(privacyRequests)
      .set({ status: "completed", completedAt: now, handledBy: actorId(actor), resolutionNote: input.reason })
      .where(and(eq(privacyRequests.id, request.id), eq(privacyRequests.status, "in_progress"))),
    expectChanged(db, 1, { code: "PRIVACY_CHANGED", detail: request.id }),
    auditStatement(db, {
      actor,
      action: "customers.privacy.erase",
      entityType: "privacy_request",
      entityId: request.id,
      after: { customerId, mergedAccounts: person.merged, erased: plan.erased, kept: plan.kept, withdrawn: toWithdraw, otherWithdrawn: answers.length - toWithdraw.length },
      reason: input.reason,
      at: now,
    }),
    auditStatement(db, { actor, action: "customers.customer.erase", entityType: "customer", entityId: customerId, after: { requestRef: request.ref, erased: plan.erased }, reason: input.reason, at: now }),
    ...person.merged.map((mergedId) => auditStatement(db, { actor, action: "customers.customer.erase", entityType: "customer", entityId: mergedId, after: { requestRef: request.ref, mergedInto: customerId }, reason: input.reason, at: now })),
  ];
  await runBatch(db, statements).catch((error) => guardCode(error, { ERASURE_BLOCKED: "erasure_blocked", CUSTOMER_CHANGED: "customer_changed", PRIVACY_CHANGED: "privacy_not_open" }));
  return { status: "completed", erased: plan.erased };
}

/** Requests of one customer (the customer's privacy page). */
export async function customerPrivacyRequests(db: Db, actor: Actor, customerId: string, now: number): Promise<PrivacyRequestRow[]> {
  assertCan(actor, "customers.privacy.manage");
  const row = await customerById(db, customerId);
  const rows = await db
    .select()
    .from(privacyRequests)
    .where(or(eq(privacyRequests.customerId, row.id), row.phoneE164.startsWith("+964") ? eq(privacyRequests.phoneE164, row.phoneE164) : undefined))
    .orderBy(desc(privacyRequests.createdAt))
    .limit(50);
  return decorate(db, actor, rows, now);
}

/** Sources seen in the consent log (for the filter). */
export async function consentSources(db: Db, actor: Actor): Promise<string[]> {
  assertCan(actor, "customers.consent.read");
  const rows = await db.all<{ source: string | null }>(sql`SELECT DISTINCT source FROM consents WHERE source IS NOT NULL ORDER BY source LIMIT 50`);
  return rows.map((row) => row.source).filter((source): source is string => Boolean(source));
}

