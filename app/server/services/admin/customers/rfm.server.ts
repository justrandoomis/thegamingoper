/**
 * Admin 07.02 — RFM segments (recency, frequency, monetary value) computed from the store's real orders.
 *
 *   const facts = await rfmFacts(db, [customerId]);                 // purchases, kept IQD, last purchase — per customer
 *   rfmOf(facts.get(id) ?? NO_FACTS, now)                           // pure (types.ts): scores 1–5 and the segment
 *   await recomputeSegments(db, actor, now);                        // customers.segment.manage — stores the membership
 *   await segmentOverview(db, actor, now);                          // stored counts, live counts, the R × F grid
 *
 * A purchase is an order the store was paid for and did not pay back in full (paid_iqd − refunded_iqd > 0, never a
 * cancelled one); the rules and the segment map are in types.ts, written so the page can explain them. Membership is
 * stored in `customer_segments` (key "rfm.<segment>", dynamic) and `customer_segment_members`, replaced as a whole in
 * ONE batch by a recompute (audited), so the list's segment filter and the counts always come from the same run.
 * Merged and erased accounts are never members.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { customerSegmentMembers, customerSegments } from "~/server/db/schema";
import { chunkRows, runBatch } from "~/server/db/tx.server";
import { actorId, num } from "./shared.server";
import { RFM_RULES, RFM_SEGMENTS, rfmOf, rfmSegmentKey, type RfmFacts, type RfmScore, type RfmSegment } from "./types";

export const NO_FACTS: RfmFacts = { purchases: 0, monetaryIqd: 0, lastPurchaseAt: null };

/** Stable row id of a segment, so a recompute updates the same rows. */
export const segmentRowId = (segment: RfmSegment) => `seg_rfm_${segment}`;

const SEGMENT_NAMES: Record<RfmSegment, { ar: string; en: string; ckb: string }> = {
  champions: { ar: "الأبطال", en: "Champions", ckb: "پاڵەوانەکان" },
  loyal: { ar: "الأوفياء", en: "Loyal", ckb: "دڵسۆزەکان" },
  new: { ar: "عملاء جدد", en: "New customers", ckb: "کڕیارە نوێیەکان" },
  promising: { ar: "واعدون", en: "Promising", ckb: "بەڵێندەرەکان" },
  need_attention: { ar: "يحتاجون اهتماماً", en: "Need attention", ckb: "پێویستیان بە سەرنجە" },
  cant_lose: { ar: "لا نريد خسارتهم", en: "Can't lose them", ckb: "نابێت لەدەستیان بدەین" },
  at_risk: { ar: "معرّضون للخسارة", en: "At risk", ckb: "لە مەترسیدان" },
  hibernating: { ar: "خاملون", en: "Hibernating", ckb: "خامۆشەکان" },
  lost: { ar: "مفقودون", en: "Lost", ckb: "لەدەستچووەکان" },
  none: { ar: "لم يشتروا بعد", en: "No purchase yet", ckb: "هێشتا نەیانکڕیوە" },
};

/** Purchases, kept IQD and the last purchase of each customer that has any (others: NO_FACTS). */
export async function rfmFacts(db: Db, customerIds?: readonly string[]): Promise<Map<string, RfmFacts>> {
  const out = new Map<string, RfmFacts>();
  const query = (ids: readonly string[] | null) =>
    db.all<{ id: string; purchases: number; monetary: number; last_at: number | null }>(sql`
      SELECT o.customer_id AS id, count(*) AS purchases, coalesce(sum(o.paid_iqd - o.refunded_iqd), 0) AS monetary, max(o.placed_at) AS last_at
      FROM orders AS o
      WHERE o.customer_id IS NOT NULL AND o.status <> 'cancelled' AND o.paid_iqd > o.refunded_iqd
      ${
        ids
          ? sql`AND o.customer_id IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `,
            )})`
          : sql``
      }
      GROUP BY o.customer_id`);
  const rows = [];
  if (customerIds) {
    const unique = [...new Set(customerIds)];
    for (let i = 0; i < unique.length; i += 90) rows.push(...(await query(unique.slice(i, i + 90))));
  } else {
    rows.push(...(await query(null)));
  }
  for (const row of rows) out.set(row.id, { purchases: num(row.purchases), monetaryIqd: num(row.monetary), lastPurchaseAt: row.last_at === null ? null : num(row.last_at) });
  return out;
}

/** Every customer that can be a member (not merged, not erased) with its live segment. */
async function liveSegments(db: Db, now: number): Promise<{ members: Map<RfmSegment, string[]>; grid: number[][] }> {
  const [customersRows, facts] = await Promise.all([db.all<{ id: string }>(sql`SELECT id FROM customers WHERE status IN ('active', 'blocked')`), rfmFacts(db)]);
  const members = new Map<RfmSegment, string[]>(RFM_SEGMENTS.map((segment) => [segment, []]));
  // grid[r][f] for r, f in 0..5 (0 = no purchase)
  const grid = Array.from({ length: 6 }, () => Array.from({ length: 6 }, () => 0));
  for (const { id } of customersRows) {
    const rfm = rfmOf(facts.get(id) ?? NO_FACTS, now);
    members.get(rfm.segment)?.push(id);
    grid[rfm.r][rfm.f]++;
  }
  return { members, grid };
}

export type SegmentRow = { segment: RfmSegment; stored: number | null; now: number; computedAt: number | null };
export type SegmentOverview = {
  rows: SegmentRow[];
  /** Customers per recency (rows, 5 → 0) × frequency (columns, 0 → 5) score, now. */
  grid: { r: RfmScore; cells: { f: RfmScore; count: number }[] }[];
  computedAt: number | null;
  total: number;
  /** True when the stored membership no longer matches what the orders say now. */
  stale: boolean;
  canRecompute: boolean;
};

/** The segments page (07.02): stored membership from the last recompute next to what the orders say now. */
export async function segmentOverview(db: Db, actor: Actor, now: number): Promise<SegmentOverview> {
  assertCan(actor, "customers.customer.read");
  const [stored, live] = await Promise.all([
    db.select({ key: customerSegments.key, count: customerSegments.memberCount, computedAt: customerSegments.computedAt }).from(customerSegments).where(like(customerSegments.key, "rfm.%")),
    liveSegments(db, now),
  ]);
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const rows: SegmentRow[] = RFM_SEGMENTS.map((segment) => {
    const row = byKey.get(rfmSegmentKey(segment));
    return { segment, stored: row ? num(row.count) : null, now: live.members.get(segment)?.length ?? 0, computedAt: row?.computedAt ?? null };
  });
  const computedAt = stored.reduce<number | null>((latest, row) => (row.computedAt !== null && (latest === null || row.computedAt > latest) ? row.computedAt : latest), null);
  const grid = ([5, 4, 3, 2, 1, 0] as RfmScore[]).map((r) => ({ r, cells: ([0, 1, 2, 3, 4, 5] as RfmScore[]).map((f) => ({ f, count: live.grid[r][f] })) }));
  const total = rows.reduce((sum, row) => sum + row.now, 0);
  return { rows, grid, computedAt, total, stale: rows.some((row) => row.stored !== row.now), canRecompute: can(actor, "customers.segment.manage") };
}

/**
 * Recomputes every customer's RFM segment from the orders and replaces the stored membership in ONE batch (segment
 * rows upserted with their counts and the time, members deleted and inserted, an audit event with the counts).
 */
export async function recomputeSegments(db: Db, actor: Actor, now: number): Promise<{ counts: Record<RfmSegment, number>; total: number }> {
  assertCan(actor, "customers.segment.manage");
  const { members } = await liveSegments(db, now);
  const counts = Object.fromEntries(RFM_SEGMENTS.map((segment) => [segment, members.get(segment)?.length ?? 0])) as Record<RfmSegment, number>;
  const segmentIds = RFM_SEGMENTS.map(segmentRowId);
  const statements: BatchStatement[] = [];
  for (const segment of RFM_SEGMENTS) {
    const values = {
      id: segmentRowId(segment),
      key: rfmSegmentKey(segment),
      name: SEGMENT_NAMES[segment],
      description: `RFM segment "${segment}" (admin 07.02)`,
      rules: { kind: "rfm", segment, rules: RFM_RULES },
      isDynamic: true,
      memberCount: counts[segment],
      computedAt: now,
      createdBy: actorId(actor),
      createdAt: now,
      updatedAt: now,
    };
    statements.push(
      db
        .insert(customerSegments)
        .values(values)
        .onConflictDoUpdate({ target: customerSegments.key, set: { memberCount: values.memberCount, computedAt: now, updatedAt: now, rules: values.rules } }),
    );
  }
  statements.push(db.delete(customerSegmentMembers).where(inArray(customerSegmentMembers.segmentId, segmentIds)));
  const rows = RFM_SEGMENTS.flatMap((segment) => (members.get(segment) ?? []).map((customerId) => ({ segmentId: segmentRowId(segment), customerId, addedAt: now })));
  for (const chunk of chunkRows(customerSegmentMembers, rows)) statements.push(db.insert(customerSegmentMembers).values(chunk));
  const total = rows.length;
  statements.push(auditStatement(db, { actor, action: "customers.segment.recompute", entityType: "customer_segment", entityId: "rfm", after: { counts, total, rules: RFM_RULES }, at: now }));
  await runBatch(db, statements);
  return { counts, total };
}

/** The stored segment of each customer (from the last recompute). */
export async function storedSegments(db: Db, customerIds: readonly string[]): Promise<Map<string, { segment: RfmSegment; computedAt: number | null }>> {
  const out = new Map<string, { segment: RfmSegment; computedAt: number | null }>();
  const unique = [...new Set(customerIds)];
  for (let i = 0; i < unique.length; i += 90) {
    const rows = await db
      .select({ customerId: customerSegmentMembers.customerId, key: customerSegments.key, computedAt: customerSegments.computedAt })
      .from(customerSegmentMembers)
      .innerJoin(customerSegments, eq(customerSegments.id, customerSegmentMembers.segmentId))
      .where(and(inArray(customerSegmentMembers.customerId, unique.slice(i, i + 90)), like(customerSegments.key, "rfm.%")));
    for (const row of rows) {
      const segment = row.key.slice("rfm.".length) as RfmSegment;
      if ((RFM_SEGMENTS as readonly string[]).includes(segment)) out.set(row.customerId, { segment, computedAt: row.computedAt });
    }
  }
  return out;
}
