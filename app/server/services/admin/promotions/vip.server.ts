/**
 * Admin 08.06 — VIP memberships: tiers with written benefits and shipping terms (`membership_tiers`), and who holds
 * one (`memberships`).
 *
 *   vipPage(db, actor, now, locale)                         tiers, members, customers eligible by module 07's rule
 *   saveTier(db, actor, raw, now)                           create / edit (guarded on what the form showed)
 *   grantMembership(db, actor, { customerId, tierId, days?, reason }, now)   one active membership per customer
 *   endMembership(db, actor, { membershipId, reason }, now) · closeEndedMemberships(db, actor, now)
 *
 * Who is a VIP is module 07's rule, reused, not forked: `flagCondition("vip", now, rules)` and `customerFlags` from
 * services/admin/customers/flags.server.ts with the thresholds in force (customerRules — the setting
 * customers.flag_rules: a manual VIP label, or ≥ the spend / ≥ the purchases within the window; by default 2,000,000
 * IQD / 5 purchases / 365 days). Review 2026-11-12: the list and its count still used the constants while the flags
 * beside each name followed the setting. This module turns an eligible customer into a member of a tier, by a person,
 * with a reason.
 *
 * What a benefit does today: the points multiplier is applied when points are posted (08.04, this module). The
 * member discount, free shipping and early access are written terms the commerce core does not read yet: `priceCart`
 * (a discount line for an active membership's `discountBps`) and the shipping fee in `priceCart` / `placeOrder` (0
 * for `freeShipping`; the stored flat fee itself never changes) — requested.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { customers, membershipTiers, memberships, type MembershipBenefits } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { customerFlags, flagCondition } from "~/server/services/admin/customers/flags.server";
import { customerRules } from "~/server/services/admin/customers/rules.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { stableText } from "./rules";
import { ID, SECTION_READ, assertAny, customerLabels, employeeNames, num } from "./shared.server";
import { DAY_MS, PAGE_SIZE, parsePercentBps, parseWhole, type EligibleRow, type MemberRow, type MemberView, type TierBenefits, type TierRow, type VipFilters, type VipPage } from "./types";

function guard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "TIER_CHANGED") throw new AppError("tier_changed", 409);
  if (info?.code === "MEMBERSHIP_EXISTS") throw new AppError("membership_exists", 409);
  if (info?.code === "MEMBERSHIP_CHANGED") throw new AppError("membership_not_active", 409);
  if (info?.kind === "unique" && info.table === "membership_tiers") throw invalid({ key: "key_taken" });
  throw error;
}

export function benefitsView(raw: MembershipBenefits | null | undefined): TierBenefits {
  const b = raw ?? {};
  return {
    discountBps: typeof b.discountBps === "number" && b.discountBps > 0 ? b.discountBps : null,
    freeShipping: b.freeShipping === true,
    pointsMultiplierBps: typeof b.pointsMultiplierBps === "number" && b.pointsMultiplierBps > 10_000 ? b.pointsMultiplierBps : null,
    earlyAccess: b.earlyAccess === true,
    notes: b.notes && typeof b.notes.ar === "string" ? b.notes : null,
  };
}

const tierFingerprint = (row: { key: string; name: L10n; benefits: MembershipBenefits | null; durationDays: number | null; sort: number; isActive: boolean }) =>
  stableText({ key: row.key, name: row.name, benefits: benefitsView(row.benefits), durationDays: row.durationDays, sort: row.sort, isActive: row.isActive });

// ───────────────────────────────────────────────────────────────── reads

export async function vipPage(db: Db, actor: Actor, now: number, locale: Locale, filters: VipFilters = { members: "current", page: 1 }): Promise<VipPage> {
  assertAny(actor, SECTION_READ.vip);
  // module 07's VIP rule with the thresholds in force (the same ones customerFlags explains each name with)
  const { flags: rules } = await customerRules(db);
  const vip = flagCondition("vip", now, rules);
  const active = sql`EXISTS (SELECT 1 FROM memberships AS m WHERE m.customer_id = c.id AND m.status = 'active' AND (m.ends_at IS NULL OR m.ends_at > ${now}))`;
  // "current" is exactly what the front page counts as members; the list pages through the chosen view and its count
  const current = sql`(${memberships.status} = 'active' AND (${memberships.endsAt} IS NULL OR ${memberships.endsAt} > ${now}))`;
  const inView = filters.members === "current" ? current : sql`NOT ${current}`;
  const [tiers, counts, memberRows, viewCounts, ended, eligibleIds, eligibleTotal] = await Promise.all([
    db.select().from(membershipTiers).orderBy(asc(membershipTiers.sort), asc(membershipTiers.key)),
    db.select({ tierId: memberships.tierId, n: sql<number>`count(*)` }).from(memberships).where(and(eq(memberships.status, "active"), sql`(${memberships.endsAt} IS NULL OR ${memberships.endsAt} > ${now})`)).groupBy(memberships.tierId),
    db
      .select({ m: memberships, tierName: membershipTiers.name })
      .from(memberships)
      .innerJoin(membershipTiers, eq(membershipTiers.id, memberships.tierId))
      .where(inView)
      .orderBy(desc(memberships.startsAt), desc(memberships.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ current: sql<number>`coalesce(sum(CASE WHEN ${current} THEN 1 ELSE 0 END), 0)`, all: sql<number>`count(*)` }).from(memberships).get(),
    db.select({ n: sql<number>`count(*)` }).from(memberships).where(and(eq(memberships.status, "active"), sql`${memberships.endsAt} IS NOT NULL AND ${memberships.endsAt} <= ${now}`)).get(),
    vip ? db.all<{ id: string }>(sql`SELECT c.id FROM customers AS c WHERE c.status = 'active' AND ${vip} AND NOT ${active} ORDER BY c.created_at DESC LIMIT 50`) : Promise.resolve([]),
    vip ? db.all<{ n: number }>(sql`SELECT count(*) AS n FROM customers AS c WHERE c.status = 'active' AND ${vip} AND NOT ${active}`) : Promise.resolve([{ n: 0 }]),
  ]);
  const memberCounts: Record<MemberView, number> = { current: num(viewCounts?.current), ended: num(viewCounts?.all) - num(viewCounts?.current) };
  const memberTotal = memberCounts[filters.members];
  const ids = eligibleIds.map((row) => row.id);
  const [labels, flags, granters] = await Promise.all([customerLabels(db, actor, [...ids, ...memberRows.map((row) => row.m.customerId)]), customerFlags(db, ids, now), employeeNames(db, memberRows.map((row) => row.m.grantedBy))]);
  const byTier = new Map(counts.map((row) => [row.tierId, num(row.n)]));
  return {
    tiers: tiers.map((tier): TierRow => ({ id: tier.id, key: tier.key, name: tier.name, benefits: benefitsView(tier.benefits), durationDays: tier.durationDays, sort: tier.sort, isActive: tier.isActive, members: byTier.get(tier.id) ?? 0, fingerprint: tierFingerprint(tier) })),
    members: memberRows.map(
      ({ m, tierName }): MemberRow => ({
        id: m.id,
        customerId: m.customerId,
        customer: labels.get(m.customerId)?.name ?? null,
        phone: labels.get(m.customerId)?.phone ?? null,
        tierId: m.tierId,
        tier: pick(tierName, locale),
        status: m.status === "active" && m.endsAt !== null && m.endsAt <= now ? "expired" : m.status,
        startsAt: m.startsAt,
        endsAt: m.endsAt,
        source: m.source,
        grantedBy: m.grantedBy ? (granters.get(m.grantedBy) ?? null) : null,
      }),
    ),
    memberView: filters.members,
    memberTotal,
    memberCounts,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(memberTotal / PAGE_SIZE)),
    endedWaiting: num(ended?.n),
    eligible: ids.map((id): EligibleRow => ({ customerId: id, customer: labels.get(id)?.name ?? null, phone: labels.get(id)?.phone ?? null, flags: (flags.get(id) ?? []).filter((flag) => flag.id.startsWith("vip_")).map((flag) => ({ id: flag.id, vars: flag.vars as Record<string, string | number> })) })),
    eligibleTotal: num(eligibleTotal[0]?.n),
    rule: { spendIqd: rules.vipSpendIqd, purchases: rules.vipPurchases, windowDays: rules.vipWindowDays },
    can: { manage: can(actor, "promotions.membership.manage"), seeProfiles: can(actor, "customers.customer.read") },
  };
}

// ───────────────────────────────────────────────────────────────── tiers

const optionalLine = (max: number) => z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanLine).trim().max(max, "too_long"));
const optionalBlock = (max: number) => z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(max, "too_long"));
const flagValue = z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.boolean());

export const TierInput = z
  .object({
    tierId: z.string().regex(ID, "invalid").optional(),
    expected: z.string().max(4_000).optional(),
    key: z.preprocess((value) => (typeof value === "string" ? value.trim().toLowerCase() : value), z.string({ error: "required" }).regex(/^[a-z][a-z0-9_-]{1,29}$/, "key_invalid")),
    nameAr: z.string({ error: "required" }).overwrite(cleanLine).trim().min(2, "required").max(60, "too_long"),
    nameEn: optionalLine(60),
    discount: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parsePercentBps(value) ?? Number.NaN), z.number({ error: "percent_invalid" }).int().min(0, "too_small").max(5_000, "too_big").nullable()),
    multiplier: z.preprocess((value) => {
      if (value === "" || value === null || value === undefined) return null;
      const bps = parsePercentBps(value);
      // typed as a factor ("1.5") — parsePercentBps reads 1.5 as 150 basis points → × 100
      return bps === null ? Number.NaN : bps * 100;
    }, z.number({ error: "number_invalid" }).int().min(10_000, "too_small").max(30_000, "too_big").nullable()),
    freeShipping: flagValue,
    earlyAccess: flagValue,
    notesAr: optionalBlock(600),
    notesEn: optionalBlock(600),
    durationDays: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(3_650, "too_big").nullable()),
    sort: z.preprocess((value) => (value === "" || value === null || value === undefined ? 0 : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(0, "too_small").max(99, "too_big")),
    isActive: flagValue,
    reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long"),
  })
  .superRefine((input, ctx) => {
    if (!input.notesAr) ctx.addIssue({ code: "custom", path: ["notesAr"], message: "required" });
  });

export async function saveTier(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ tierId: string; created: boolean; changed: boolean }> {
  assertCan(actor, "promotions.membership.manage");
  const parsed = TierInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "vip.tier");
  const input = parsed.data;
  const name: L10n = input.nameEn ? { ar: input.nameAr, en: input.nameEn } : { ar: input.nameAr };
  const benefits: MembershipBenefits = {
    ...(input.discount ? { discountBps: input.discount } : {}),
    ...(input.freeShipping ? { freeShipping: true } : {}),
    ...(input.multiplier && input.multiplier > 10_000 ? { pointsMultiplierBps: input.multiplier } : {}),
    ...(input.earlyAccess ? { earlyAccess: true } : {}),
    notes: input.notesEn ? { ar: input.notesAr, en: input.notesEn } : { ar: input.notesAr },
  };
  if (!input.tierId) {
    const tierId = newId("tier");
    await runBatch(db, [
      db.insert(membershipTiers).values({ id: tierId, key: input.key, name, benefits, priceIqd: null, durationDays: input.durationDays, minSpendIqd: null, sort: input.sort, isActive: input.isActive }),
      auditStatement(db, { actor, action: "promotions.vip.tier_create", entityType: "membership_tier", entityId: tierId, summary: input.key, after: { name, benefits, durationDays: input.durationDays, isActive: input.isActive }, reason: input.reason, at: now }),
    ]).catch(guard);
    return { tierId, created: true, changed: true };
  }
  const row = await db.select({ tier: membershipTiers, nameText: sql<string>`CAST(${membershipTiers.name} AS TEXT)`, benefitsText: sql<string | null>`CAST(${membershipTiers.benefits} AS TEXT)` }).from(membershipTiers).where(eq(membershipTiers.id, input.tierId)).get();
  if (!row) throw notFound("membership_tier");
  if (input.expected !== undefined && input.expected !== tierFingerprint(row.tier)) throw new AppError("tier_changed", 409);
  const next = { key: input.key, name, benefits, durationDays: input.durationDays, sort: input.sort, isActive: input.isActive };
  if (tierFingerprint(next) === tierFingerprint(row.tier)) return { tierId: row.tier.id, created: false, changed: false };
  await runBatch(db, [
    db
      .update(membershipTiers)
      .set(next)
      .where(
        and(
          eq(membershipTiers.id, row.tier.id),
          sql`CAST(${membershipTiers.name} AS TEXT) = ${row.nameText} AND coalesce(CAST(${membershipTiers.benefits} AS TEXT), '') = ${row.benefitsText ?? ""} AND ${membershipTiers.durationDays} IS ${row.tier.durationDays} AND ${membershipTiers.sort} = ${row.tier.sort} AND ${membershipTiers.isActive} = ${row.tier.isActive ? 1 : 0} AND ${membershipTiers.key} = ${row.tier.key}`,
        ),
      ),
    expectChanged(db, 1, { code: "TIER_CHANGED", detail: row.tier.id }),
    auditStatement(db, { actor, action: "promotions.vip.tier_update", entityType: "membership_tier", entityId: row.tier.id, summary: input.key, before: { name: row.tier.name, benefits: row.tier.benefits, durationDays: row.tier.durationDays, isActive: row.tier.isActive }, after: next, reason: input.reason, at: now }),
  ]).catch(guard);
  return { tierId: row.tier.id, created: false, changed: true };
}

// ───────────────────────────────────────────────────────────────── memberships

export const GrantInput = z.object({
  customerId: z.string({ error: "required" }).regex(ID, "invalid"),
  tierId: z.string({ error: "required" }).regex(ID, "invalid"),
  days: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(3_650, "too_big").nullable()),
  reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long"),
});

/** Makes a customer a member of a tier (one active membership at a time — re-checked inside the batch). */
export async function grantMembership(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ membershipId: string; endsAt: number | null }> {
  assertCan(actor, "promotions.membership.manage");
  const parsed = GrantInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "vip.grant");
  const input = parsed.data;
  const [tier, customer] = await Promise.all([db.select().from(membershipTiers).where(eq(membershipTiers.id, input.tierId)).get(), db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.id, input.customerId)).get()]);
  if (!tier) throw notFound("membership_tier");
  if (!tier.isActive) throw new AppError("tier_inactive", 409);
  if (!customer) throw notFound("customer");
  if (customer.status !== "active") throw new AppError("customer_unavailable", 409);
  const days = input.days ?? tier.durationDays;
  const endsAt = days ? now + days * DAY_MS : null;
  const membershipId = newId("mbr");
  await runBatch(db, [
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM memberships WHERE customer_id = ${customer.id} AND status = 'active' AND (ends_at IS NULL OR ends_at > ${now}))`, { code: "MEMBERSHIP_EXISTS", detail: customer.id }),
    db.insert(memberships).values({ id: membershipId, customerId: customer.id, tierId: tier.id, status: "active", startsAt: now, endsAt, source: "grant", grantedBy: actor.kind === "employee" ? actor.id : null, createdAt: now }),
    auditStatement(db, { actor, action: "promotions.vip.grant", entityType: "customer", entityId: customer.id, summary: tier.key, after: { membershipId, tierId: tier.id, endsAt }, reason: input.reason, at: now }),
  ]).catch(guard);
  return { membershipId, endsAt };
}

export const EndInput = z.object({ membershipId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long") });

export async function endMembership(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ ended: boolean }> {
  assertCan(actor, "promotions.membership.manage");
  const parsed = EndInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "vip.end");
  const row = await db.select().from(memberships).where(eq(memberships.id, parsed.data.membershipId)).get();
  if (!row) throw notFound("membership");
  if (row.status !== "active") throw new AppError("membership_not_active", 409);
  await runBatch(db, [
    db.update(memberships).set({ status: "cancelled", endsAt: row.endsAt !== null && row.endsAt < now ? row.endsAt : now }).where(and(eq(memberships.id, row.id), eq(memberships.status, "active"))),
    expectChanged(db, 1, { code: "MEMBERSHIP_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "promotions.vip.end", entityType: "customer", entityId: row.customerId, before: { membershipId: row.id, status: row.status, endsAt: row.endsAt }, after: { status: "cancelled" }, reason: parsed.data.reason, at: now }),
  ]).catch(guard);
  return { ended: true };
}

/** Marks memberships whose end date has passed as expired (their benefits already stopped at that date). */
export async function closeEndedMemberships(db: Db, actor: Actor, now: number): Promise<{ expired: number }> {
  assertCan(actor, "promotions.membership.manage");
  const due = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.status, "active"), sql`${memberships.endsAt} IS NOT NULL AND ${memberships.endsAt} <= ${now}`)).limit(500);
  if (due.length === 0) return { expired: 0 };
  await runBatch(db, [
    db.update(memberships).set({ status: "expired" }).where(and(eq(memberships.status, "active"), sql`${memberships.endsAt} IS NOT NULL AND ${memberships.endsAt} <= ${now}`)),
    auditStatement(db, { actor, action: "promotions.vip.expire", entityType: "membership", entityId: "ended", after: { count: due.length }, at: now }),
  ]);
  return { expired: due.length };
}
