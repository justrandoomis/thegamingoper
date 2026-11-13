/**
 * Admin 08.05 — referrals: one code per customer (`referral_codes`, UNIQUE code and customer), one row per referred
 * person (`referral_redemptions`, a phone number can be referred only once — UNIQUE), abuse rules, and a reward in
 * points once the referred order is delivered and past its return window.
 *
 *   listReferrals(db, actor, filters, now) · issueReferralCode(db, actor, { customerId, maxUses? }, now)
 *   setReferralCodeActive(db, actor, { codeId, active, reason }, now)
 *   recordReferral(db, actor, { code, phone, orderRef?, note, idempotencyKey }, now)   by hand (told at the counter)
 *   rewardReferral(db, actor, { referralId, note }, now) · rejectReferral(db, actor, { referralId, reason }, now)
 *
 * Abuse rules. Refused outright: a code switched off, a code that reached its cap (`max_uses`, counted in the same
 * batch: uses = uses + 1 guarded), self-referral (the referrer's own number or account), a number already referred,
 * an order that is not the referred person's. Shown to the reviewer as signals (a person decides, never a machine):
 * the same address as the referrer, the same device (a sign-in from the same address and browser within
 * REFERRAL.deviceWindowDays), an existing customer, an order missing, not delivered, cancelled or still in its return
 * window. The reward is REFERRAL.rewardPoints posted to the referrer's points (key "referral:<id>:reward", once);
 * whoever recorded a referral by hand cannot reward it.
 *
 * Where codes come from (since 2026-11-12): shoppers type a friend's code at the online checkout — the core checks it
 * as `recordReferral` does (orders/promotions.server.ts checkReferralCode, with this module's normalizeReferralCode)
 * and placeOrder records the `referral_redemptions` row "pending" (referralStatements); a cancelled order gives the use
 * back. HONEST BOUNDARY: sign-up and the point of sale record no code — staff record those here.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { addresses, auditEvents, customerSessions, customers, orders, referralCodes, referralRedemptions } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { cleanBlock } from "~/server/text.server";
import { rewardPointsStatement } from "./loyalty.server";
import { ID, KEY, SECTION_READ, assertAny, customerLabels, employeeNames, idFromKey, num, phoneOf } from "./shared.server";
import { DAY_MS, PAGE_SIZE, REFERRAL, latinDigits, parseWhole, type ReferralCodeRow, type ReferralFilters, type ReferralRow, type ReferralSignal, type ReferralsPage, type ReferralStatus, type ReferralView } from "./types";
import { programRules } from "./program.server";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return `TT${out.slice(0, 6)}`;
}

export const normalizeReferralCode = (raw: string) => latinDigits(raw).toUpperCase().replace(/[\s-]+/g, "");

function guard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "REFERRAL_NOT_QUALIFIED") throw new AppError("referral_not_qualified", 409);
  if (info?.code === "CUSTOMER_UNAVAILABLE") throw new AppError("customer_unavailable", 409);
  if (info?.code === "REFERRAL_CAP") throw new AppError("referral_cap_reached", 409);
  if (info?.code === "REFERRAL_CHANGED") throw new AppError("referral_not_open", 409);
  if (info?.kind === "unique" && info.table === "referral_redemptions") throw new AppError("referral_phone_used", 409);
  if (info?.kind === "unique" && info.table === "referral_codes") throw new AppError("referral_code_exists", 409);
  if (info?.code === "CHECK" && /referral_codes/.test(info.detail)) throw new AppError("referral_cap_reached", 409);
  throw error;
}

/** "Baghdad, Al-Mansour, street 14, house 3" in a form two addresses can be compared on. */
function addressKey(governorateId: string | null, text: string | null): string | null {
  if (!governorateId || !text) return null;
  const clean = latinDigits(text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  return clean.length >= 6 ? `${governorateId}|${clean}` : null;
}

// ───────────────────────────────────────────────────────────────── signals

type RedemptionJoin = {
  id: string;
  code_id: string;
  code: string;
  referrer_id: string;
  referred_customer_id: string | null;
  referred_phone_e164: string;
  order_id: string | null;
  status: ReferralStatus;
  reject_reason: string | null;
  created_at: number;
  rewarded_at: number | null;
};

async function signalsFor(db: Db, rows: readonly RedemptionJoin[], now: number): Promise<Map<string, { signals: ReferralSignal[]; qualifies: boolean; orderRef: string | null }>> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12)
  const referral = (await programRules(db)).referral;
  const out = new Map<string, { signals: ReferralSignal[]; qualifies: boolean; orderRef: string | null }>();
  if (rows.length === 0) return out;
  const windowDays = await getSetting(db, "returns.window_days");
  const orderIds = rows.map((row) => row.order_id).filter((id): id is string => Boolean(id));
  const people = [...new Set(rows.flatMap((row) => [row.referrer_id, row.referred_customer_id].filter((id): id is string => Boolean(id))))];
  const since = now - referral.deviceWindowDays * DAY_MS;
  const [orderRows, addressRows, sessionRows] = await Promise.all([
    orderIds.length ? db.select({ id: orders.id, ref: orders.ref, status: orders.status, deliveredAt: orders.deliveredAt, governorateId: orders.governorateId, addressText: orders.addressText }).from(orders).where(inArray(orders.id, orderIds)) : Promise.resolve([]),
    people.length ? db.select({ customerId: addresses.customerId, governorateId: addresses.governorateId, addressText: addresses.addressText }).from(addresses).where(inArray(addresses.customerId, people)) : Promise.resolve([]),
    people.length ? db.select({ customerId: customerSessions.customerId, ip: customerSessions.ip, userAgent: customerSessions.userAgent }).from(customerSessions).where(and(inArray(customerSessions.customerId, people), sql`${customerSessions.lastSeenAt} >= ${since}`)) : Promise.resolve([]),
  ]);
  const orderById = new Map(orderRows.map((row) => [row.id, row]));
  const addressesOf = new Map<string, Set<string>>();
  for (const row of addressRows) {
    const key = addressKey(row.governorateId, row.addressText);
    if (key) addressesOf.set(row.customerId, new Set([...(addressesOf.get(row.customerId) ?? []), key]));
  }
  const devicesOf = new Map<string, Set<string>>();
  for (const row of sessionRows) if (row.ip && row.userAgent) devicesOf.set(row.customerId, new Set([...(devicesOf.get(row.customerId) ?? []), `${row.ip}|${row.userAgent}`]));
  for (const row of rows) {
    const signals: ReferralSignal[] = [];
    const order = row.order_id ? orderById.get(row.order_id) : undefined;
    const referrerAddresses = addressesOf.get(row.referrer_id) ?? new Set<string>();
    const referredAddresses = new Set([...(row.referred_customer_id ? (addressesOf.get(row.referred_customer_id) ?? []) : [])]);
    const orderAddress = order ? addressKey(order.governorateId, order.addressText) : null;
    if (orderAddress) referredAddresses.add(orderAddress);
    if ([...referredAddresses].some((key) => referrerAddresses.has(key))) signals.push("same_address");
    if (row.referred_customer_id) {
      const mine = devicesOf.get(row.referrer_id) ?? new Set<string>();
      if ([...(devicesOf.get(row.referred_customer_id) ?? [])].some((device) => mine.has(device))) signals.push("same_device");
    }
    const earlier = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(sql`(${orders.contactPhoneE164} = ${row.referred_phone_e164}${row.referred_customer_id ? sql` OR ${orders.customerId} = ${row.referred_customer_id}` : sql``})`, sql`${orders.placedAt} < ${row.created_at}`, sql`${orders.status} <> 'cancelled'`, row.order_id ? sql`${orders.id} <> ${row.order_id}` : sql`1 = 1`))
      .limit(1)
      .get();
    if (earlier) signals.push("existing_customer");
    let qualifies = false;
    if (!order) signals.push("order_missing");
    else if (order.status === "cancelled" || order.status === "returned") signals.push("order_cancelled");
    else if (order.status !== "delivered" || !order.deliveredAt) signals.push("order_not_delivered");
    else if (order.deliveredAt + windowDays * DAY_MS > now) signals.push("order_in_return_window");
    else qualifies = row.status === "pending" || row.status === "qualified";
    out.set(row.id, { signals, qualifies, orderRef: order?.ref ?? null });
  }
  return out;
}

async function recorders(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db.select({ entityId: auditEvents.entityId, actorId: auditEvents.actorId }).from(auditEvents).where(and(eq(auditEvents.action, "promotions.referral.record"), inArray(auditEvents.entityId, [...ids])));
  for (const row of rows) if (row.entityId && row.actorId) out.set(row.entityId, row.actorId);
  return out;
}

// ───────────────────────────────────────────────────────────────── reads

const VIEW_WHERE: Record<ReferralView, ReturnType<typeof sql> | null> = {
  review: sql`r.status IN ('pending', 'qualified')`,
  rewarded: sql`r.status = 'rewarded'`,
  rejected: sql`r.status = 'rejected'`,
  all: null,
};

export async function listReferrals(db: Db, actor: Actor, filters: ReferralFilters, now: number): Promise<ReferralsPage> {
  assertAny(actor, SECTION_READ.referrals);
  const where = VIEW_WHERE[filters.view];
  const base = sql`FROM referral_redemptions AS r JOIN referral_codes AS c ON c.id = r.referral_code_id`;
  const [codes, codeTotal, rows, totals, counts] = await Promise.all([
    db.select().from(referralCodes).orderBy(desc(referralCodes.createdAt)).limit(50),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM referral_codes`),
    db.all<RedemptionJoin>(sql`SELECT r.id, c.id AS code_id, c.code, c.customer_id AS referrer_id, r.referred_customer_id, r.referred_phone_e164, r.order_id, r.status, r.reject_reason, r.created_at, r.rewarded_at ${base}
      ${where ? sql`WHERE ${where}` : sql``} ORDER BY r.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n ${base} ${where ? sql`WHERE ${where}` : sql``}`),
    db.all<{ status: ReferralStatus; n: number }>(sql`SELECT r.status, count(*) AS n FROM referral_redemptions AS r GROUP BY r.status`),
  ]);
  const full = can(actor, "customer.phone.read_full");
  const [labels, signals, recordedBy] = await Promise.all([
    customerLabels(db, actor, [...codes.map((code) => code.customerId), ...rows.flatMap((row) => [row.referrer_id, row.referred_customer_id])]),
    signalsFor(db, rows, now),
    recorders(db, rows.map((row) => row.id)),
  ]);
  const names = await employeeNames(db, recordedBy.values());
  const byStatus = new Map(counts.map((row) => [row.status, num(row.n)]));
  const total = num(totals[0]?.n);
  return {
    codes: codes.map((code): ReferralCodeRow => ({ id: code.id, code: code.code, customerId: code.customerId, customer: labels.get(code.customerId)?.name ?? null, phone: labels.get(code.customerId)?.phone ?? null, uses: code.uses, maxUses: code.maxUses, isActive: code.isActive, createdAt: code.createdAt })),
    codeTotal: num(codeTotal[0]?.n),
    rows: rows.map((row): ReferralRow => {
      const facts = signals.get(row.id);
      const recorder = recordedBy.get(row.id) ?? null;
      return {
        id: row.id,
        code: row.code,
        referrer: labels.get(row.referrer_id)?.name ?? null,
        referrerId: row.referrer_id,
        referredPhone: phoneOf(row.referred_phone_e164, full) ?? { display: "—", full: false },
        referred: row.referred_customer_id ? (labels.get(row.referred_customer_id)?.name ?? null) : null,
        orderRef: facts?.orderRef ?? null,
        status: row.status,
        rejectReason: row.reject_reason,
        createdAt: num(row.created_at),
        rewardedAt: row.rewarded_at === null ? null : num(row.rewarded_at),
        signals: facts?.signals ?? [],
        qualifies: facts?.qualifies ?? false,
        recordedBy: recorder ? (names.get(recorder) ?? null) : null,
        recordedByMe: actor.kind === "employee" && recorder === actor.id,
      };
    }),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: { review: (byStatus.get("pending") ?? 0) + (byStatus.get("qualified") ?? 0), rewarded: byStatus.get("rewarded") ?? 0, rejected: byStatus.get("rejected") ?? 0, all: [...byStatus.values()].reduce((sum, n) => sum + n, 0) },
    can: { manage: can(actor, "promotions.referral.manage") },
  };
}

// ───────────────────────────────────────────────────────────────── codes

export const IssueCodeInput = z
  .object({
    customerId: z.string().regex(ID, "invalid").optional(),
    /** Or the customer's account number, as staff type it. */
    phone: z.string().max(30, "too_long").optional(),
    // left blank: the default in force (the setting promotions.referral), applied by issueReferralCode
    maxUses: z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(REFERRAL.maxUsesCap, "too_big").optional()),
  })
  .refine((input) => Boolean(input.customerId || input.phone), { path: ["phone"], message: "required" });

/** Gives a customer their referral code (one per customer; asking again returns the same code). */
export async function issueReferralCode(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ codeId: string; code: string; replayed: boolean }> {
  if (actor.kind !== "customer") assertCan(actor, "promotions.referral.manage");
  const parsed = IssueCodeInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "referral.code");
  const input = parsed.data;
  // a customer asks for their OWN code in the storefront account (2026-11-12): by their id, never a number, the default cap
  if (actor.kind === "customer" && (input.phone || input.customerId !== actor.id || input.maxUses !== undefined)) throw new AppError("forbidden", 403, { detail: "own_code_only" });
  // a code's uses: as typed, or the default in force (the setting promotions.referral — follow-up 2026-11-12)
  const maxUses = input.maxUses ?? (await programRules(db)).referral.defaultMaxUses;
  let customerId = input.customerId;
  if (!customerId) {
    const phone = normalizeIraqPhone(input.phone ?? "");
    if (!phone) throw invalid({ phone: "phone_invalid" });
    customerId = (await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone)).get())?.id;
    if (!customerId) throw invalid({ phone: "customer_unknown" });
  }
  const customer = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) throw notFound("customer");
  if (customer.status !== "active") throw new AppError("customer_unavailable", 409);
  const existing = await db.select({ id: referralCodes.id, code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.customerId, customer.id)).get();
  if (existing) return { codeId: existing.id, code: existing.code, replayed: true };
  for (let attempt = 0; attempt < 4; attempt++) {
    const codeId = newId("rfc");
    const code = randomCode();
    try {
      await runBatch(db, [
        db.insert(referralCodes).values({ id: codeId, code, customerId: customer.id, maxUses, uses: 0, isActive: true, createdAt: now }),
        auditStatement(db, { actor, action: "promotions.referral.code", entityType: "customer", entityId: customer.id, after: { code, maxUses }, at: now }),
      ]);
      return { codeId, code, replayed: false };
    } catch (error) {
      const info = mapDbError(error);
      if (info?.kind === "unique" && info.columns?.includes("customer_id")) {
        const again = await db.select({ id: referralCodes.id, code: referralCodes.code }).from(referralCodes).where(eq(referralCodes.customerId, customer.id)).get();
        if (again) return { codeId: again.id, code: again.code, replayed: true };
      }
      if (info?.kind !== "unique") throw error;
    }
  }
  throw new AppError("referral_code_exists", 409);
}

export const CodeActiveInput = z.object({ codeId: z.string().regex(ID, "invalid"), active: z.boolean(), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long") });

export async function setReferralCodeActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "promotions.referral.manage");
  const parsed = CodeActiveInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "referral.active");
  const input = parsed.data;
  const row = await db.select().from(referralCodes).where(eq(referralCodes.id, input.codeId)).get();
  if (!row) throw notFound("referral_code");
  if (row.isActive === input.active) return { changed: false };
  await runBatch(db, [
    db.update(referralCodes).set({ isActive: input.active }).where(and(eq(referralCodes.id, row.id), eq(referralCodes.isActive, row.isActive))),
    expectChanged(db, 1, { code: "REFERRAL_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: input.active ? "promotions.referral.code_on" : "promotions.referral.code_off", entityType: "customer", entityId: row.customerId, before: { code: row.code, active: row.isActive }, after: { active: input.active }, reason: input.reason, at: now }),
  ]).catch(guard);
  return { changed: true };
}

// ───────────────────────────────────────────────────────────────── referrals

export const RecordInput = z.object({
  code: z.string({ error: "required" }).trim().min(3, "required").max(20, "too_long"),
  phone: z.string({ error: "required" }).trim().min(1, "required").max(30, "too_long"),
  orderRef: z.preprocess((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""), z.string().max(30, "too_long")),
  note: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long"),
  idempotencyKey: z.string().regex(KEY, "invalid"),
});

/** Records a referral told to staff (the rules in the file header refuse what may never count). */
export async function recordReferral(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ referralId: string; replayed: boolean }> {
  assertCan(actor, "promotions.referral.manage");
  const parsed = RecordInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "referral.record");
  const input = parsed.data;
  const referralId = await idFromKey("rfr", actor, input.idempotencyKey);
  if (await db.select({ id: referralRedemptions.id }).from(referralRedemptions).where(eq(referralRedemptions.id, referralId)).get()) return { referralId, replayed: true };
  const phone = normalizeIraqPhone(input.phone);
  if (!phone) throw invalid({ phone: "phone_invalid" });
  const code = await db.select().from(referralCodes).where(eq(referralCodes.code, normalizeReferralCode(input.code))).get();
  if (!code) throw invalid({ code: "referral_code_unknown" });
  if (!code.isActive) throw new AppError("referral_code_inactive", 409);
  if (code.maxUses !== null && code.uses >= code.maxUses) throw new AppError("referral_cap_reached", 409);
  const referrer = await db.select({ id: customers.id, phone: customers.phoneE164, status: customers.status }).from(customers).where(eq(customers.id, code.customerId)).get();
  if (!referrer || referrer.status !== "active") throw new AppError("customer_unavailable", 409);
  if (referrer.phone === phone) throw new AppError("referral_self", 409);
  const referred = await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone)).get();
  if (referred?.id === referrer.id) throw new AppError("referral_self", 409);
  if (await db.select({ id: referralRedemptions.id }).from(referralRedemptions).where(eq(referralRedemptions.referredPhoneE164, phone)).get()) throw new AppError("referral_phone_used", 409);
  let orderId: string | null = null;
  if (input.orderRef) {
    const order = await db.select({ id: orders.id, customerId: orders.customerId, phone: orders.contactPhoneE164 }).from(orders).where(eq(orders.ref, input.orderRef)).get();
    if (!order) throw invalid({ orderRef: "order_unknown" });
    const theirs = order.phone === phone || (referred !== undefined && order.customerId === referred.id);
    if (!theirs || order.customerId === referrer.id) throw new AppError("referral_order_mismatch", 409);
    orderId = order.id;
  }
  await runBatch(db, [
    db
      .update(referralCodes)
      .set({ uses: sql`${referralCodes.uses} + 1` })
      .where(and(eq(referralCodes.id, code.id), eq(referralCodes.isActive, true), sql`(${referralCodes.maxUses} IS NULL OR ${referralCodes.uses} < ${referralCodes.maxUses})`)),
    expectChanged(db, 1, { code: "REFERRAL_CAP", detail: code.id }),
    db.insert(referralRedemptions).values({ id: referralId, referralCodeId: code.id, referredCustomerId: referred?.id ?? null, referredPhoneE164: phone, orderId, status: "pending", createdAt: now }),
    auditStatement(db, { actor, action: "promotions.referral.record", entityType: "referral", entityId: referralId, summary: code.code, after: { code: code.code, referrerId: referrer.id, referredCustomerId: referred?.id ?? null, phone, orderId }, reason: input.note, at: now }),
  ]).catch(guard);
  return { referralId, replayed: false };
}

async function openReferral(db: Db, referralId: string) {
  if (!ID.test(referralId)) throw notFound("referral");
  const row = await db
    .select({ r: referralRedemptions, code: referralCodes.code, codeId: referralCodes.id, referrerId: referralCodes.customerId })
    .from(referralRedemptions)
    .innerJoin(referralCodes, eq(referralCodes.id, referralRedemptions.referralCodeId))
    .where(eq(referralRedemptions.id, referralId))
    .get();
  if (!row) throw notFound("referral");
  if (row.r.status !== "pending" && row.r.status !== "qualified") throw new AppError("referral_not_open", 409);
  return row;
}

export const RewardInput = z.object({ referralId: z.string().regex(ID, "invalid"), note: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")) });

/** Rewards the referrer once the referred order qualifies (delivered, past the return window). */
export async function rewardReferral(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ points: number }> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12); the reward's points expire
  // after the points programme's days in force too (review 2026-11-12: they kept the constant)
  const program = await programRules(db);
  const referral = program.referral;
  assertCan(actor, "promotions.referral.manage");
  const parsed = RewardInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "referral.reward");
  const row = await openReferral(db, parsed.data.referralId);
  const recorder = (await recorders(db, [row.r.id])).get(row.r.id);
  if (recorder && actor.kind === "employee" && recorder === actor.id) throw new AppError("referral_self_review", 403);
  const facts = (
    await signalsFor(
      db,
      [{ id: row.r.id, code_id: row.codeId, code: row.code, referrer_id: row.referrerId, referred_customer_id: row.r.referredCustomerId, referred_phone_e164: row.r.referredPhoneE164, order_id: row.r.orderId, status: row.r.status, reject_reason: null, created_at: row.r.createdAt, rewarded_at: null }],
      now,
    )
  ).get(row.r.id);
  if (!facts?.qualifies || !row.r.orderId) throw new AppError("referral_not_qualified", 409);
  const referrer = await db.select({ status: customers.status }).from(customers).where(eq(customers.id, row.referrerId)).get();
  if (!referrer || (referrer.status !== "active" && referrer.status !== "blocked")) throw new AppError("customer_unavailable", 409);
  const windowDays = await getSetting(db, "returns.window_days");
  const statements: BatchStatement[] = [
    // the qualification again INSIDE the batch: an order returned or cancelled meanwhile earns nothing
    expectThat(db, sql`EXISTS (SELECT 1 FROM orders WHERE id = ${row.r.orderId} AND status = 'delivered' AND delivered_at IS NOT NULL AND delivered_at <= ${now - windowDays * DAY_MS})`, { code: "REFERRAL_NOT_QUALIFIED", detail: row.r.id }),
    expectThat(db, sql`EXISTS (SELECT 1 FROM customers WHERE id = ${row.referrerId} AND status IN ('active', 'blocked'))`, { code: "CUSTOMER_UNAVAILABLE", detail: row.referrerId }),
    db
      .update(referralRedemptions)
      .set({ status: "rewarded", rewardedAt: now })
      .where(and(eq(referralRedemptions.id, row.r.id), inArray(referralRedemptions.status, ["pending", "qualified"]))),
    expectChanged(db, 1, { code: "REFERRAL_CHANGED", detail: row.r.id }),
    rewardPointsStatement(db, actor, { customerId: row.referrerId, points: referral.rewardPoints, referralId: row.r.id, code: row.code, expiryDays: program.loyalty.expiryDays }, now),
    auditStatement(db, { actor, action: "promotions.referral.reward", entityType: "referral", entityId: row.r.id, summary: row.code, after: { points: referral.rewardPoints, referrerId: row.referrerId, signals: facts.signals }, reason: parsed.data.note || null, at: now }),
  ];
  await runBatch(db, statements).catch(guard);
  return { points: referral.rewardPoints };
}

export const RejectInput = z.object({ referralId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long") });

/** Rejects a referral with a reason; its use of the code's cap is given back. */
export async function rejectReferral(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ rejected: boolean }> {
  assertCan(actor, "promotions.referral.manage");
  const parsed = RejectInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "referral.reject");
  const row = await openReferral(db, parsed.data.referralId);
  await runBatch(db, [
    db
      .update(referralRedemptions)
      .set({ status: "rejected", rejectReason: parsed.data.reason })
      .where(and(eq(referralRedemptions.id, row.r.id), inArray(referralRedemptions.status, ["pending", "qualified"]))),
    expectChanged(db, 1, { code: "REFERRAL_CHANGED", detail: row.r.id }),
    db
      .update(referralCodes)
      .set({ uses: sql`${referralCodes.uses} - 1` })
      .where(and(eq(referralCodes.id, row.codeId), sql`${referralCodes.uses} > 0`)),
    auditStatement(db, { actor, action: "promotions.referral.reject", entityType: "referral", entityId: row.r.id, summary: row.code, reason: parsed.data.reason, at: now }),
  ]).catch(guard);
  return { rejected: true };
}
