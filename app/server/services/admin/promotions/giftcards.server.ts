/**
 * Admin 08.07 — gift cards: issue, reveal, void, expire, redeem into a customer's wallet, and the settlement of what
 * was issued against what was redeemed.
 *
 *   listGiftCards(db, actor, filters, now) · getGiftCard(db, actor, cardId, now, { dataKeyReady })
 *   issueGiftCard(db, actor, dataKey, { amountIqd, expiresOn?, note, idempotencyKey }, now)   "issued" (code shown once) | "requested"
 *   decideGiftCard(db, actor, dataKey, { approvalId, decision, note }, now) · withdrawGiftCardRequest(db, actor, { approvalId }, now)
 *   revealGiftCardCode(db, actor, dataKey, { cardId, reason }, now)       promotions.gift_card.manage + digital_code.reveal, audited
 *   voidGiftCard(db, actor, { cardId, reason }, now) · expireGiftCards(db, actor, now)
 *   checkGiftCardRedemption(db, actor, { code, customerId | phone }, now)   the amount and the wallet, before confirming
 *   redeemGiftCard(db, actor, { code, customerId | phone, idempotencyKey }, now)   into the wallet, once (a replay of
 *                                       the same form answers its first result; a demo card only into a demo account)
 *
 * Codes are stored the way the devices module stores digital codes: only sha256 over the normalized code finds a card;
 * the code itself is kept ENCRYPTED (AES-256-GCM with DATA_KEY, bound to its row: context "gift_card:<id>"), never in a
 * list, a log or an audit event. The person who issues a card (or the approver of a large one) sees the code once;
 * later it is revealed only with promotions.gift_card.manage + digital_code.reveal, a reason, an audit event and a
 * per-employee limit.
 *
 * Redemption (the schema's design): a card is redeemed ONCE, in full, into the customer's wallet; the wallet then
 * carries the balance and pays at checkout through the core. ONE batch: the guarded update `status = 'active'`
 * (+ expectChanged — a second redemption, also a concurrent one, changes no row and moves no money), the wallet
 * credit through the core's `walletCreditStatement` (kind "gift_card", UNIQUE idempotency key "gift_card:<id>") and
 * its posting through `postWalletCredit` (Dr marketing / Cr wallet liability — these cards are funded by the store),
 * and the audit events. Wrong codes are limited per employee (no guessing).
 *
 * Who decides: a card above GIFT_CARD.soloIqd, or one that takes what the issuer gave out alone in 24 hours above
 * GIFT_CARD.soloDayIqd, waits for a second person (promotions.gift_card.manage, not the requester); the window is
 * re-checked inside the issuing batch.
 *
 * HONEST BOUNDARY: SELLING a card for money (at the counter or online) is not built — it needs a gift-card liability
 * account in the chart (schema owner) and a sale line in the POS / checkout (commerce core). Cards here are the store's
 * own (compensation, prizes, promotions).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { audit, auditStatement } from "~/server/audit.server";
import { decryptSecret, encryptSecret } from "~/server/crypto.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, auditEvents, customers, giftCards, walletLedger, type GiftCard } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, rateLimited, zodFieldErrors } from "~/server/errors";
import { limitKey, rateLimit } from "~/server/ratelimit.server";
import { mapPostingError, postWalletCredit, postedBy } from "~/server/services/accounting/post.server";
import { walletCreditStatement } from "~/server/services/wallet.server";
import { cleanBlock } from "~/server/text.server";
import { ID, KEY, SECTION_READ, assertAny, canDecideApproval, assertMayDecide, customerLabels, employeeNames, historyOf, idFromKey, num } from "./shared.server";
import { DAY_MS, GIFT_CARD, PAGE_SIZE, endOfBaghdadDay, latinDigits, parseWhole, type GiftCardDetail, type GiftCardFilters, type GiftCardPage, type GiftCardRow, type GiftCardSettlement, type GiftCardStatus, type GiftCardView, type PendingGiftCard } from "./types";
import { programRules } from "./program.server";

const KIND = "gift_card" as const;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** "abcd-efgh 2345 6789" → "ABCDEFGH23456789" — what a card is found by. */
export function normalizeGiftCode(raw: string): string {
  return latinDigits(raw).toUpperCase().replace(/[\s-]+/g, "");
}

/** A new code: 16 characters from 31 that cannot be confused (about 79 bits), shown in groups of four. */
export function newGiftCode(): string {
  const out: string[] = [];
  while (out.length < 16) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    for (const byte of bytes) if (byte < 248 && out.length < 16) out.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
  }
  return out.join("").replace(/(.{4})(?=.)/g, "$1-");
}

export const giftCodeHash = async (code: string) => sha256Hex(`tamtam.gift_card.v1|${normalizeGiftCode(code)}`);
export const giftCodeContext = (cardId: string) => `gift_card:${cardId}`;
export const giftCardWalletKey = (cardId: string) => `gift_card:${cardId}`;

function guard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CUSTOMER_UNAVAILABLE") throw new AppError("customer_unavailable", 409);
  if (info?.code === "GIFT_CARD_USED") throw new AppError("gift_card_used", 409);
  if (info?.code === "GIFT_CARD_CHANGED") throw new AppError("gift_card_not_active", 409);
  if (info?.code === "GIFT_SOLO_LIMIT") throw new AppError("gift_card_solo_limit", 409);
  if (info?.code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
  if (info?.kind === "unique" && info.table === "wallet_ledger") throw new AppError("gift_card_used", 409);
  const posting = mapPostingError(error);
  if (posting) throw posting;
  throw error;
}

function requireKey(dataKey: string | null | undefined): string {
  if (!dataKey) throw new AppError("data_key_missing", 503);
  return dataKey;
}

/** Statements that create a card; returns them with the plain code (to show once). */
async function cardStatements(db: Db, actor: Actor, dataKey: string, card: { id: string; amountIqd: number; expiresAt: number | null; note: string; createdBy: string | null; approvalId: string | null; isDemo: boolean }, now: number): Promise<{ statements: BatchStatement[]; code: string }> {
  const code = newGiftCode();
  const normalized = normalizeGiftCode(code);
  return {
    code,
    statements: [
      db.insert(giftCards).values({ id: card.id, codeHash: await giftCodeHash(code), codeHint: normalized.slice(-4), codeEnc: await encryptSecret(code, dataKey, giftCodeContext(card.id)), amountIqd: card.amountIqd, status: "active", expiresAt: card.expiresAt, note: card.note, isDemo: card.isDemo, createdBy: card.createdBy, createdAt: now }),
      auditStatement(db, { actor, action: "promotions.gift_card.issue", entityType: "gift_card", entityId: card.id, summary: `…${normalized.slice(-4)}`, after: { amountIqd: card.amountIqd, expiresAt: card.expiresAt, solo: card.approvalId === null, approvalId: card.approvalId, issuedFor: card.createdBy }, reason: card.note, at: now }),
    ],
  };
}

// ───────────────────────────────────────────────────────────────── reads

/**
 * The views, by the state a card is IN (not only its stored status): an "active" card past its date is expired — it
 * can no longer be redeemed, and the settlement and the front page count it as expired — until "mark expired" stores it.
 */
const pastDate = (now: number) => sql`(status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${now})`;
const viewWhere = (view: GiftCardView, now: number): ReturnType<typeof sql> | null => {
  switch (view) {
    case "all":
      return null;
    case "active":
      return sql`(status = 'active' AND NOT ${pastDate(now)})`;
    case "expired":
      return sql`(status = 'expired' OR ${pastDate(now)})`;
    case "redeemed":
      return sql`status = 'redeemed'`;
    case "void":
      return sql`status = 'void'`;
  }
};

export async function giftCardSettlement(db: Db, actor: Actor, now: number): Promise<GiftCardSettlement> {
  assertAny(actor, SECTION_READ.giftCards);
  const [rows, wallet, pending] = await Promise.all([
    db.all<{ status: GiftCardStatus; past: number; n: number; iqd: number }>(sql`SELECT status, CASE WHEN status = 'active' AND expires_at IS NOT NULL AND expires_at <= ${now} THEN 1 ELSE 0 END AS past, count(*) AS n, coalesce(sum(amount_iqd), 0) AS iqd FROM gift_cards GROUP BY status, past`),
    db.select({ iqd: sql<number>`coalesce(sum(${walletLedger.amountIqd}), 0)` }).from(walletLedger).where(eq(walletLedger.kind, "gift_card")).get(),
    db.all<{ n: number; iqd: number }>(sql`SELECT count(*) AS n, coalesce(sum(CAST(json_extract(payload, '$.amountIqd') AS INTEGER)), 0) AS iqd FROM approvals WHERE kind = 'gift_card' AND status = 'pending'`),
  ]);
  const sum = (filter: (row: (typeof rows)[number]) => boolean) => rows.filter(filter).reduce((acc, row) => ({ count: acc.count + num(row.n), iqd: acc.iqd + num(row.iqd) }), { count: 0, iqd: 0 });
  const redeemed = sum((row) => row.status === "redeemed");
  const walletCreditsIqd = num(wallet?.iqd);
  return {
    issued: sum(() => true),
    outstanding: sum((row) => row.status === "active" && num(row.past) === 0),
    redeemed,
    walletCreditsIqd,
    expired: sum((row) => row.status === "expired" || (row.status === "active" && num(row.past) === 1)),
    expiredWaiting: sum((row) => row.status === "active" && num(row.past) === 1).count,
    void: sum((row) => row.status === "void"),
    pendingRequests: { count: num(pending[0]?.n), iqd: num(pending[0]?.iqd) },
    balanced: redeemed.iqd === walletCreditsIqd,
  };
}

function rowView(card: GiftCard, names: Map<string, string>, people: Map<string, { name: string | null }>, now: number): GiftCardRow {
  const past = card.status === "active" && card.expiresAt !== null && card.expiresAt <= now;
  return {
    id: card.id,
    hint: card.codeHint,
    amountIqd: card.amountIqd,
    balanceIqd: card.status === "active" && !past ? card.amountIqd : 0,
    // past its date it is expired, whatever is stored until "mark expired" runs
    status: past ? "expired" : card.status,
    expiresAt: card.expiresAt,
    createdAt: card.createdAt,
    createdBy: card.createdBy ? (names.get(card.createdBy) ?? null) : null,
    redeemedBy: card.redeemedBy ? (people.get(card.redeemedBy)?.name ?? null) : null,
    redeemedAt: card.redeemedAt,
    note: card.note,
    isDemo: card.isDemo,
  };
}

export async function listGiftCards(db: Db, actor: Actor, filters: GiftCardFilters, now: number): Promise<GiftCardPage> {
  assertAny(actor, SECTION_READ.giftCards);
  const parts = [viewWhere(filters.view, now) ?? sql`1 = 1`];
  if (filters.q) {
    const q = normalizeGiftCode(filters.q).slice(-4);
    parts.push(sql`(upper(coalesce(code_hint, '')) = ${q} OR coalesce(note, '') LIKE ${`%${filters.q.replace(/[%_\\]/g, "")}%`})`);
  }
  const where = sql.join(parts, sql` AND `);
  const [rows, total, counts, settlement, pending] = await Promise.all([
    db
      .select()
      .from(giftCards)
      .where(where)
      .orderBy(desc(giftCards.createdAt), desc(giftCards.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM gift_cards WHERE ${where}`),
    // the same states as the views (an active card past its date counts as expired)
    db.all<{ status: GiftCardStatus; n: number }>(sql`SELECT CASE WHEN ${pastDate(now)} THEN 'expired' ELSE status END AS status, count(*) AS n FROM gift_cards GROUP BY 1`),
    giftCardSettlement(db, actor, now),
    db.select().from(approvals).where(and(eq(approvals.kind, KIND), eq(approvals.status, "pending"))).orderBy(desc(approvals.createdAt)).limit(50),
  ]);
  const [names, people] = await Promise.all([employeeNames(db, [...rows.map((row) => row.createdBy), ...pending.map((row) => row.requestedBy)]), customerLabels(db, actor, rows.map((row) => row.redeemedBy))]);
  const byStatus = new Map(counts.map((row) => [row.status, num(row.n)]));
  const count = num(total[0]?.n);
  return {
    rows: rows.map((card) => rowView(card, names, people, now)),
    total: count,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(count / PAGE_SIZE)),
    counts: { all: [...byStatus.values()].reduce((a, b) => a + b, 0), active: byStatus.get("active") ?? 0, redeemed: byStatus.get("redeemed") ?? 0, expired: byStatus.get("expired") ?? 0, void: byStatus.get("void") ?? 0 },
    settlement,
    pending: pending.map((row): PendingGiftCard => {
      const payload = (row.payload ?? {}) as { amountIqd?: number; expiresAt?: number | null; note?: string };
      return { approvalId: row.id, amountIqd: num(payload.amountIqd), expiresAt: payload.expiresAt ?? null, note: payload.note ?? null, requestedBy: names.get(row.requestedBy) ?? null, requestedAt: row.createdAt, mine: actor.kind === "employee" && row.requestedBy === actor.id, canDecide: canDecideApproval(actor, row) };
    }),
    can: { issue: can(actor, "promotions.gift_card.issue"), manage: can(actor, "promotions.gift_card.manage"), reveal: can(actor, "promotions.gift_card.manage") && can(actor, "digital_code.reveal") },
  };
}

export async function getGiftCard(db: Db, actor: Actor, cardId: string, now: number, options: { dataKeyReady: boolean }): Promise<GiftCardDetail> {
  assertAny(actor, SECTION_READ.giftCards);
  if (!ID.test(cardId)) throw notFound("gift_card");
  const card = await db.select().from(giftCards).where(eq(giftCards.id, cardId)).get();
  if (!card) throw notFound("gift_card");
  const [names, people, reveals, history] = await Promise.all([
    employeeNames(db, [card.createdBy]),
    customerLabels(db, actor, [card.redeemedBy]),
    db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(and(eq(auditEvents.action, "promotions.gift_card.reveal"), eq(auditEvents.entityId, card.id))).get(),
    historyOf(db, "gift_card", card.id),
  ]);
  return {
    ...rowView(card, names, people, now),
    redeemedByCustomerId: card.redeemedBy,
    walletEntryId: card.walletLedgerId,
    reveals: num(reveals?.n),
    history,
    can: { manage: can(actor, "promotions.gift_card.manage"), reveal: can(actor, "promotions.gift_card.manage") && can(actor, "digital_code.reveal"), seeProfile: can(actor, "customers.customer.read") },
    dataKeyReady: options.dataKeyReady,
  };
}

// ───────────────────────────────────────────────────────────────── issuing

export const IssueInput = z.object({
  amountIqd: z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : parseWhole(value) ?? Number.NaN), z.number({ error: (issue) => (issue.input === undefined ? "required" : "number_invalid") }).int("number_invalid").min(1_000, "too_small").max(100_000_000, "too_big").refine((value) => value % GIFT_CARD.stepIqd === 0, "amount_step")),
  expiresOn: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : value), z.string().nullable()),
  note: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(300, "too_long"),
  idempotencyKey: z.string({ error: "required" }).regex(KEY, "invalid"),
});

/** What this employee issued alone in the last 24 hours (from the audit trail, the same SQL as the batch guard). */
const soloSumSql = (employeeId: string, now: number) =>
  sql`(SELECT coalesce(sum(CAST(json_extract(after, '$.amountIqd') AS INTEGER)), 0) FROM audit_events WHERE action = 'promotions.gift_card.issue' AND actor_id = ${employeeId} AND at > ${now - DAY_MS} AND json_extract(after, '$.solo') = 1)`;

export async function issueGiftCard(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ status: "issued" | "requested"; cardId?: string; code?: string; approvalId?: string; replayed: boolean }> {
  // the rules in force (the setting promotions.* — program.server.ts, follow-up 2026-11-12)
  const giftCard = (await programRules(db)).giftCard;
  assertCan(actor, "promotions.gift_card.issue");
  const parsed = IssueInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "gift_card.issue");
  const input = parsed.data;
  // the amounts in force (the setting promotions.gift_card); the schema above only holds the absolute bounds
  if (input.amountIqd < giftCard.minIqd) throw invalid({ amountIqd: "too_small" });
  if (input.amountIqd > giftCard.maxIqd) throw invalid({ amountIqd: "too_big" });
  let expiresAt: number | null = null;
  if (input.expiresOn) {
    expiresAt = endOfBaghdadDay(input.expiresOn);
    if (expiresAt === null) throw invalid({ expiresOn: "invalid" });
    if (expiresAt <= now) throw invalid({ expiresOn: "expires_past" });
    if (expiresAt > now + giftCard.maxValidDays * DAY_MS) throw invalid({ expiresOn: "too_far" });
  }
  const key = requireKey(dataKey);
  const cardId = await idFromKey("gfc", actor, input.idempotencyKey);
  const approvalId = await idFromKey("apr", actor, `${input.idempotencyKey}:gift`);
  const [existingCard, existingRequest] = await Promise.all([db.select({ id: giftCards.id, amountIqd: giftCards.amountIqd }).from(giftCards).where(eq(giftCards.id, cardId)).get(), db.select({ id: approvals.id, payload: approvals.payload }).from(approvals).where(eq(approvals.id, approvalId)).get()]);
  if (existingCard) {
    if (existingCard.amountIqd !== input.amountIqd) throw new AppError("idempotency_mismatch", 409);
    return { status: "issued", cardId, replayed: true };
  }
  if (existingRequest) return { status: "requested", approvalId, replayed: true };
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const soloSoFar = num((await db.all<{ n: number }>(sql`SELECT ${soloSumSql(actorId, now)} AS n`))[0]?.n);
  const needsSecond = input.amountIqd > giftCard.soloIqd || soloSoFar + input.amountIqd > giftCard.soloDayIqd;
  if (needsSecond) {
    await runBatch(db, [
      db.insert(approvals).values({ id: approvalId, kind: KIND, entityType: "gift_card", entityId: cardId, requestedBy: actorId, payload: { amountIqd: input.amountIqd, expiresAt, note: input.note, soloSoFar, demo: options.demo ?? false }, status: "pending", reason: input.note, createdAt: now }),
      auditStatement(db, { actor, action: "promotions.gift_card.request", entityType: "gift_card", entityId: cardId, after: { amountIqd: input.amountIqd, expiresAt, soloSoFar }, reason: input.note, at: now }),
    ]).catch(guard);
    return { status: "requested", approvalId, replayed: false };
  }
  const { statements, code } = await cardStatements(db, actor, key, { id: cardId, amountIqd: input.amountIqd, expiresAt, note: input.note, createdBy: actorId, approvalId: null, isDemo: options.demo ?? false }, now);
  // the 24-hour window again inside the batch: two cards issued at once cannot both slip under it
  await runBatch(db, [expectThat(db, sql`${soloSumSql(actorId, now)} + ${input.amountIqd} <= ${giftCard.soloDayIqd}`, { code: "GIFT_SOLO_LIMIT", detail: actorId }), ...statements]).catch(guard);
  return { status: "issued", cardId, code, replayed: false };
}

export const DecideGiftInput = z.object({ approvalId: z.string().regex(ID, "invalid"), decision: z.enum(["approve", "reject"], { error: "required" }), note: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")) });

/** A second person approves (the card is created now and its code shown to the approver once) or rejects. */
export async function decideGiftCard(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number): Promise<{ status: "approved" | "rejected"; cardId: string; code?: string }> {
  assertCan(actor, "promotions.gift_card.manage");
  const parsed = DecideGiftInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "gift_card.decide");
  const input = parsed.data;
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  assertMayDecide(actor, approval);
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_short" });
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const close = [
    db
      .update(approvals)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", decidedBy: actorId, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
  ];
  if (input.decision === "reject") {
    await runBatch(db, [...close, auditStatement(db, { actor, action: "promotions.gift_card.reject", entityType: "gift_card", entityId: approval.entityId, after: { approvalId: approval.id }, reason: input.note, at: now })]).catch(guard);
    return { status: "rejected", cardId: approval.entityId };
  }
  const payload = (approval.payload ?? {}) as { amountIqd?: number; expiresAt?: number | null; note?: string; demo?: boolean };
  const expiresAt = payload.expiresAt ?? null;
  if (expiresAt !== null && expiresAt <= now) throw invalid({ expiresOn: "expires_past" });
  const { statements, code } = await cardStatements(db, actor, requireKey(dataKey), { id: approval.entityId, amountIqd: num(payload.amountIqd), expiresAt, note: payload.note ?? approval.reason ?? "", createdBy: approval.requestedBy, approvalId: approval.id, isDemo: payload.demo === true }, now);
  await runBatch(db, [...close, ...statements]).catch(guard);
  return { status: "approved", cardId: approval.entityId, code };
}

export async function withdrawGiftCardRequest(db: Db, actor: Actor, raw: { approvalId: string }, now: number): Promise<{ approvalId: string }> {
  assertAny(actor, ["promotions.gift_card.issue", "promotions.gift_card.manage"]);
  const approvalId = z.string().regex(ID, "invalid").parse(raw.approvalId);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.kind, KIND))).get();
  if (!approval) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  if (actor.kind !== "employee" || approval.requestedBy !== actor.id) throw new AppError("forbidden", 403, { detail: "not_requester" });
  await runBatch(db, [
    db.update(approvals).set({ status: "rejected", decidedBy: actor.id, decidedAt: now, decisionNote: "withdrawn" }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
    auditStatement(db, { actor, action: "promotions.gift_card.withdraw", entityType: "gift_card", entityId: approval.entityId, after: { approvalId: approval.id }, at: now }),
  ]).catch(guard);
  return { approvalId: approval.id };
}

// ───────────────────────────────────────────────────────────────── reveal, void, expire

export const RevealGiftInput = z.object({ cardId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(300, "too_long") });

export async function revealGiftCardCode(db: Db, actor: Actor, dataKey: string | null | undefined, raw: unknown, now: number): Promise<{ code: string }> {
  assertCan(actor, "promotions.gift_card.manage");
  assertCan(actor, "digital_code.reveal");
  const parsed = RevealGiftInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "gift_card.reveal");
  const card = await db.select().from(giftCards).where(eq(giftCards.id, parsed.data.cardId)).get();
  if (!card) throw notFound("gift_card");
  if (card.status !== "active" || (card.expiresAt !== null && card.expiresAt <= now) || !card.codeEnc) throw new AppError("gift_card_not_revealable", 409);
  const key = requireKey(dataKey);
  const verdict = await rateLimit(db, await limitKey("gift-reveal", "employee", actor.kind === "employee" ? actor.id : "system"), GIFT_CARD.revealLimit, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
  const code = await decryptSecret(card.codeEnc, key, giftCodeContext(card.id));
  await audit(db, { actor, action: "promotions.gift_card.reveal", entityType: "gift_card", entityId: card.id, summary: `…${card.codeHint ?? ""}`, reason: parsed.data.reason, at: now });
  return { code };
}

export const VoidGiftInput = z.object({ cardId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long") });

export async function voidGiftCard(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ voided: boolean }> {
  assertCan(actor, "promotions.gift_card.manage");
  const parsed = VoidGiftInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "gift_card.void");
  const card = await db.select().from(giftCards).where(eq(giftCards.id, parsed.data.cardId)).get();
  if (!card) throw notFound("gift_card");
  if (card.status !== "active") throw new AppError("gift_card_not_active", 409);
  await runBatch(db, [
    db.update(giftCards).set({ status: "void" }).where(and(eq(giftCards.id, card.id), eq(giftCards.status, "active"))),
    expectChanged(db, 1, { code: "GIFT_CARD_CHANGED", detail: card.id }),
    auditStatement(db, { actor, action: "promotions.gift_card.void", entityType: "gift_card", entityId: card.id, summary: `…${card.codeHint ?? ""}`, before: { status: card.status, amountIqd: card.amountIqd }, after: { status: "void" }, reason: parsed.data.reason, at: now }),
  ]).catch(guard);
  return { voided: true };
}

/** Marks active cards past their date as expired (what nobody redeemed is the breakage of the settlement). */
export async function expireGiftCards(db: Db, actor: Actor, now: number): Promise<{ expired: number; iqd: number }> {
  assertCan(actor, "promotions.gift_card.manage");
  const due = await db.select({ id: giftCards.id, amountIqd: giftCards.amountIqd }).from(giftCards).where(and(eq(giftCards.status, "active"), sql`${giftCards.expiresAt} IS NOT NULL AND ${giftCards.expiresAt} <= ${now}`)).limit(500);
  if (due.length === 0) return { expired: 0, iqd: 0 };
  const iqd = due.reduce((sum, row) => sum + row.amountIqd, 0);
  await runBatch(db, [
    db.update(giftCards).set({ status: "expired" }).where(and(eq(giftCards.status, "active"), sql`${giftCards.expiresAt} IS NOT NULL AND ${giftCards.expiresAt} <= ${now}`)),
    auditStatement(db, { actor, action: "promotions.gift_card.expire", entityType: "gift_card", entityId: "expired", after: { count: due.length, amountIqd: iqd }, at: now }),
  ]);
  return { expired: due.length, iqd };
}

// ───────────────────────────────────────────────────────────────── redemption

const redeemFields = {
  code: z.string({ error: "required" }).trim().min(4, "required").max(40, "too_long"),
  customerId: z.string().regex(ID, "invalid").optional(),
  /** Or the number of the customer's account, as staff type it at the counter. */
  phone: z.string().max(30, "too_long").optional(),
};
const someone = (input: { customerId?: string; phone?: string }) => Boolean(input.customerId || input.phone);

export const RedeemInput = z
  .object({
    ...redeemFields,
    /** The redemption form's key: the same form sent twice answers its first result instead of "already used". */
    idempotencyKey: z.string({ error: "required" }).regex(KEY, "invalid"),
  })
  .refine(someone, { path: ["phone"], message: "required" });
export const CheckRedeemInput = z.object(redeemFields).refine(someone, { path: ["phone"], message: "required" });

/**
 * A customer redeems in the storefront account (2026-11-12, the commerce core's request — the same guarded redemption,
 * never a second path): only into their OWN wallet, named by id (never a number); staff hold gift_card.manage.
 */
function assertOwnWallet(actor: Actor, input: { customerId?: string; phone?: string }): void {
  if (actor.kind !== "customer") return;
  if (input.phone || input.customerId !== actor.id) throw new AppError("forbidden", 403, { detail: "own_wallet_only" });
}

/** The account a card goes into: by id, or by the number typed at the counter (guests have no wallet). */
async function walletCustomerId(db: Db, input: { customerId?: string; phone?: string }): Promise<string> {
  if (input.customerId) return input.customerId;
  const phone = normalizeIraqPhone(input.phone ?? "");
  if (!phone) throw invalid({ phone: "phone_invalid" });
  const id = (await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone)).get())?.id;
  if (!id) throw invalid({ phone: "customer_unknown" });
  return id;
}

/** Finds a card by its code; a code that matches nothing counts against the employee's guesses (GIFT_CARD.missLimit). */
async function cardByCode(db: Db, actor: Actor, code: string, now: number): Promise<GiftCard> {
  const card = await db.select().from(giftCards).where(eq(giftCards.codeHash, await giftCodeHash(code))).get();
  if (card) return card;
  // wrong codes count per employee — and, for a customer redeeming in the account (2026-11-12), per customer
  const verdict = await rateLimit(db, await limitKey("gift-miss", actor.kind === "customer" ? "customer" : "employee", actor.kind === "employee" || actor.kind === "customer" ? actor.id : "system"), GIFT_CARD.missLimit, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
  throw new AppError("gift_card_unknown", 404);
}

/** Why a card cannot go into this customer's wallet now (null: it can). */
function redeemRefusal(card: GiftCard, customer: { status: string; isDemo: boolean }, now: number): AppError | null {
  if (customer.status !== "active") return new AppError("customer_unavailable", 409);
  if (card.status === "redeemed") return new AppError("gift_card_used", 409);
  if (card.status === "void") return new AppError("gift_card_void", 409);
  if (card.status === "expired" || (card.expiresAt !== null && card.expiresAt <= now)) return new AppError("gift_card_expired", 409);
  if (card.isDemo !== customer.isDemo) return new AppError("gift_card_demo_mismatch", 409);
  return null;
}

/**
 * What a redemption would do, before it is confirmed: the card's amount and whose wallet receives it (the confirm
 * dialog's impact). Reads only; the same checks and the same guessing limit as the redemption itself.
 */
export async function checkGiftCardRedemption(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ cardId: string; hint: string | null; amountIqd: number; expiresAt: number | null; customer: { id: string; name: string | null; phone: { display: string; full: boolean } | null } }> {
  if (actor.kind !== "customer") assertCan(actor, "promotions.gift_card.manage");
  const parsed = CheckRedeemInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "gift_card.check");
  assertOwnWallet(actor, parsed.data);
  const customerId = await walletCustomerId(db, parsed.data);
  const customer = await db.select({ id: customers.id, status: customers.status, isDemo: customers.isDemo }).from(customers).where(eq(customers.id, customerId)).get();
  if (!customer) throw new AppError("wallet_requires_account", 409);
  const card = await cardByCode(db, actor, parsed.data.code, now);
  const refusal = redeemRefusal(card, customer, now);
  if (refusal) throw refusal;
  const label = (await customerLabels(db, actor, [customer.id])).get(customer.id);
  return { cardId: card.id, hint: card.codeHint, amountIqd: card.amountIqd, expiresAt: card.expiresAt, customer: { id: customer.id, name: label?.name ?? null, phone: label?.phone ?? null } };
}

type WalletRow = { id: string; customerId: string; refId: string | null; amountIqd: number };
const walletRow = (db: Db, id: string): Promise<WalletRow | undefined> =>
  db.select({ id: walletLedger.id, customerId: walletLedger.customerId, refId: walletLedger.refId, amountIqd: walletLedger.amountIqd }).from(walletLedger).where(eq(walletLedger.id, id)).get();

/**
 * Redeems a card in full into a customer's wallet (see the file header: once, in one batch). One idempotency key per
 * redemption: the wallet entry's id is derived from (employee, form key), so the same form sent again — a double click,
 * a retry after a lost answer — returns the first redemption (`replayed`), and the key reused for another card or
 * customer is `idempotency_mismatch`. A demo card never credits a real customer (nor a real card a demo account):
 * the money would sit in a real wallet without a real posting. The customer must still be active INSIDE the batch.
 */
export async function redeemGiftCard(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ cardId: string; amountIqd: number; walletEntryId: string; replayed: boolean }> {
  if (actor.kind !== "customer") assertCan(actor, "promotions.gift_card.manage");
  const parsed = RedeemInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "gift_card.redeem");
  const input = parsed.data;
  assertOwnWallet(actor, input);
  const customerId = await walletCustomerId(db, input);
  const walletEntryId = await idFromKey("wal", actor, input.idempotencyKey);
  const [customer, known, earlier] = await Promise.all([
    db.select({ id: customers.id, status: customers.status, isDemo: customers.isDemo }).from(customers).where(eq(customers.id, customerId)).get(),
    giftCodeHash(input.code).then((hash) => db.select().from(giftCards).where(eq(giftCards.codeHash, hash)).get()),
    walletRow(db, walletEntryId),
  ]);
  if (earlier) {
    // this form was redeemed already: the same card for the same customer is its first answer, anything else a misuse of the key
    if (!known || earlier.refId !== known.id || earlier.customerId !== customerId) throw new AppError("idempotency_mismatch", 409);
    return { cardId: known.id, amountIqd: earlier.amountIqd, walletEntryId, replayed: true };
  }
  if (!customer) throw new AppError("wallet_requires_account", 409);
  if (customer.status !== "active") throw new AppError("customer_unavailable", 409);
  const card = known ?? (await cardByCode(db, actor, input.code, now));
  const refusal = redeemRefusal(card, customer, now);
  if (refusal) throw refusal;
  const reason = `Gift card …${card.codeHint ?? ""}`;
  try {
    await runBatch(db, [
      // merged or erased since it was read: no money goes to an account that no longer holds one
      expectThat(db, sql`EXISTS (SELECT 1 FROM customers WHERE id = ${customer.id} AND status = 'active')`, { code: "CUSTOMER_UNAVAILABLE", detail: customer.id }),
      db
        .update(giftCards)
        .set({ status: "redeemed", redeemedBy: customer.id, redeemedAt: now, walletLedgerId: walletEntryId })
        .where(and(eq(giftCards.id, card.id), eq(giftCards.status, "active"), sql`(${giftCards.expiresAt} IS NULL OR ${giftCards.expiresAt} > ${now})`)),
      expectChanged(db, 1, { code: "GIFT_CARD_USED", detail: card.id }),
      walletCreditStatement(db, { id: walletEntryId, customerId: customer.id, amountIqd: card.amountIqd, kind: "gift_card", refType: "gift_card", refId: card.id, reason, idempotencyKey: giftCardWalletKey(card.id), actor, now }),
      // the store funds its own cards: Dr marketing / Cr wallet liability (a demo card — always a demo customer — never reaches the real books)
      ...postWalletCredit(db, { ledgerEntryId: walletEntryId, customerId: customer.id, amountIqd: card.amountIqd, debitAccount: "marketing", memo: "Gift card redeemed", at: now, createdBy: postedBy(actor), isDemo: card.isDemo }),
      auditStatement(db, { actor, action: "customers.wallet.credit", entityType: "customer", entityId: customer.id, after: { entryId: walletEntryId, kind: "gift_card", amountIqd: card.amountIqd, refType: "gift_card", refId: card.id }, reason, at: now }),
      auditStatement(db, { actor, action: "promotions.gift_card.redeem", entityType: "gift_card", entityId: card.id, summary: `…${card.codeHint ?? ""}`, before: { status: "active" }, after: { status: "redeemed", customerId: customer.id, walletEntryId, amountIqd: card.amountIqd }, at: now }),
    ]);
  } catch (error) {
    // the same form sent twice at once: the other request redeemed it with this very entry
    const raced = await walletRow(db, walletEntryId);
    if (raced && raced.refId === card.id && raced.customerId === customer.id) return { cardId: card.id, amountIqd: raced.amountIqd, walletEntryId, replayed: true };
    guard(error);
  }
  return { cardId: card.id, amountIqd: card.amountIqd, walletEntryId, replayed: false };
}
