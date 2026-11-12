/**
 * Admin 16.04 — campaign links (UTM) and the attribution of sales to campaigns.
 *
 *   createLink(db, actor, raw, now, origin)            marketing.utm.manage — a storefront path + source/medium/campaign → a tracked URL
 *   listLinks(db, actor, filters, origin)              marketing.utm.manage | marketing.report.read
 *   attributionReport(db, actor, range, now)           marketing.utm.manage | marketing.report.read
 *   attributedByCampaign(db, scope)                    for the performance report (16.07)
 *
 * HONEST BOUNDARY: the storefront does not record where a shopper came from yet — no page reads utm_* or `tt_l`, and
 * `placeOrder` writes neither `orders.utm_link_id` nor `orders.attribution` (requested of the storefront and the
 * commerce core, docs/areas/admin-marketing.md). So a link works as a URL today, but no order carries its source:
 * attribution counts only orders that REALLY carry one (none, today) and says so — never a modelled or guessed share.
 * `utm_links.clicks` is not counted by anything either: shown as "not measured", never as 0.
 *
 * A link's URL: `<origin><path>?utm_source=…&utm_medium=…&utm_campaign=…[&utm_content=…][&utm_term=…]&tt_l=<code>`
 * — the code names the link itself, so the capture can store `utm_link_id`.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import { can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { utmLinks } from "~/server/db/schema";
import { mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid } from "~/server/errors";
import { normalizeStorePath } from "~/server/services/admin/cms/rules";
import { checkStoreLink } from "~/server/services/admin/cms/shared.server";
import { actorId, assertAny, employeeNames, ID, num, SECTION_READ } from "./shared.server";
import { DAY_MS, UTM_VALUE, dayStart, utmValue, type DayRange, type LinkFilters, type LinkOption } from "./types";

type LinkDbRow = {
  id: string;
  code: string;
  campaign_id: string | null;
  target_path: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  created_by: string | null;
  created_at: number;
};

/** The tracked URL of a link on the store's public origin. */
export function linkUrl(origin: string, link: { targetPath: string; source: string; medium: string; campaign: string | null; content: string | null; term: string | null; code: string }): string {
  const params = new URLSearchParams();
  params.set("utm_source", link.source);
  params.set("utm_medium", link.medium);
  if (link.campaign) params.set("utm_campaign", link.campaign);
  if (link.content) params.set("utm_content", link.content);
  if (link.term) params.set("utm_term", link.term);
  params.set("tt_l", link.code);
  const base = origin.replace(/\/+$/, "");
  return `${base}${link.targetPath}${link.targetPath.includes("?") ? "&" : "?"}${params.toString()}`;
}

const toOption = (origin: string, row: LinkDbRow): LinkOption => ({
  id: row.id,
  code: row.code,
  targetPath: row.target_path,
  source: row.utm_source,
  medium: row.utm_medium,
  url: linkUrl(origin, { targetPath: row.target_path, source: row.utm_source, medium: row.utm_medium, campaign: row.utm_campaign, content: row.utm_content, term: row.utm_term, code: row.code }),
});

/**
 * A campaign's own links (the ones a message may use as {link}): the newest 50 — and always `includeId`, the link its
 * text uses, however many links were made after it (otherwise the form would drop it and the page lose it).
 */
export async function campaignLinks(db: Db, campaignId: string, origin: string, includeId: string | null = null): Promise<LinkOption[]> {
  const rows = await db.all<LinkDbRow>(sql`SELECT * FROM utm_links WHERE campaign_id = ${campaignId} ORDER BY created_at DESC, id DESC LIMIT 50`);
  if (includeId && !rows.some((row) => row.id === includeId)) rows.push(...(await db.all<LinkDbRow>(sql`SELECT * FROM utm_links WHERE id = ${includeId} AND campaign_id = ${campaignId}`)));
  return rows.map((row) => toOption(origin, row));
}

/** One of the campaign's own links by its id (the {link} of a held message), or null. */
export async function campaignLink(db: Db, campaignId: string, linkId: string, origin: string): Promise<LinkOption | null> {
  const row = (await db.all<LinkDbRow>(sql`SELECT * FROM utm_links WHERE id = ${linkId} AND campaign_id = ${campaignId}`))[0];
  return row ? toOption(origin, row) : null;
}

export type LinkRow = LinkOption & {
  campaign: string | null;
  content: string | null;
  term: string | null;
  campaignId: string | null;
  campaignName: string | null;
  /** Orders that carry this link (none until the storefront records it). */
  orders: number;
  createdBy: string | null;
  createdAt: number;
};

export type LinkListPage = { rows: LinkRow[]; total: number; page: number; pageCount: number; campaigns: { id: string; name: string; utm: string | null }[]; canManage: boolean };

export async function listLinks(db: Db, actor: Actor, filters: LinkFilters, origin: string): Promise<LinkListPage> {
  assertAny(actor, SECTION_READ.links);
  const search = filters.q ? sql`(l.code LIKE ${`%${filters.q.toLowerCase()}%`} OR l.target_path LIKE ${`%${filters.q.toLowerCase()}%`} OR l.utm_source LIKE ${`%${filters.q.toLowerCase()}%`} OR l.utm_campaign LIKE ${`%${filters.q.toLowerCase()}%`})` : sql`1 = 1`;
  const campaign = filters.campaign ? sql`l.campaign_id = ${filters.campaign}` : sql`1 = 1`;
  const [count] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM utm_links l WHERE ${search} AND ${campaign}`);
  const total = num(count?.n);
  const pageCount = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(filters.page, pageCount);
  const rows = await db.all<LinkDbRow & { campaign_name: string | null; orders: number }>(sql`
    SELECT l.*, c.name AS campaign_name, (SELECT COUNT(*) FROM orders o WHERE o.utm_link_id = l.id) AS orders
    FROM utm_links l LEFT JOIN campaigns c ON c.id = l.campaign_id
    WHERE ${search} AND ${campaign}
    ORDER BY l.created_at DESC, l.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`);
  const names = await employeeNames(db, rows.map((row) => row.created_by));
  const campaigns = await db.all<{ id: string; name: string; utm_campaign: string | null }>(sql`SELECT id, name, utm_campaign FROM campaigns WHERE status <> 'cancelled' ORDER BY updated_at DESC LIMIT 200`);
  return {
    rows: rows.map((row) => ({
      ...toOption(origin, row),
      campaign: row.utm_campaign,
      content: row.utm_content,
      term: row.utm_term,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      orders: num(row.orders),
      createdBy: row.created_by ? (names.get(row.created_by) ?? null) : null,
      createdAt: num(row.created_at),
    })),
    total,
    page,
    pageCount,
    campaigns: campaigns.map((row) => ({ id: row.id, name: row.name, utm: row.utm_campaign })),
    canManage: can(actor, "marketing.utm.manage"),
  };
}

const slug = (required: boolean) =>
  z.preprocess(
    (value) => utmValue(value) ?? "",
    z
      .string()
      .refine((value) => (required ? value.length > 0 : true), "required")
      .refine((value) => value === "" || UTM_VALUE.test(value), "utm_invalid"),
  );

const CreateInput = z.object({
  targetPath: z.preprocess((value) => (typeof value === "string" ? value.trim() : ""), z.string().min(1, "required").max(300, "too_long")),
  source: slug(true),
  medium: slug(true),
  campaignId: z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().regex(ID, "invalid").optional()),
  campaign: slug(false),
  content: slug(false),
  term: slug(false),
  idempotencyKey: z.string().min(16, "invalid").max(128, "invalid").regex(/^[A-Za-z0-9_-]+$/, "invalid"),
});
export type CreateLinkInput = z.input<typeof CreateInput>;

function randomCode(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * Builds a link to a storefront page (CMS's path rules: locale-less, never the admin or the API; a page that does not
 * exist is refused). With a campaign, utm_campaign is the campaign's own value. One key = one link.
 */
export async function createLink(db: Db, actor: Actor, raw: unknown, now: number, origin: string): Promise<{ linkId: string; code: string; url: string; replayed: boolean; pageState: string }> {
  assertAny(actor, ["marketing.utm.manage"]);
  const input = CreateInput.parse(raw ?? {});
  const linkId = `utm_${(await sha256Hex(`tamtam.marketing.link|${input.idempotencyKey}`)).slice(0, 24)}`;
  const replay = (await db.all<LinkDbRow>(sql`SELECT * FROM utm_links WHERE id = ${linkId}`))[0];
  if (replay) {
    if (replay.created_by !== actorId(actor)) throw new AppError("idempotency_mismatch", 409);
    return { linkId, code: replay.code, url: toOption(origin, replay).url, replayed: true, pageState: "ok" };
  }
  const parsed = normalizeStorePath(input.targetPath, { query: true });
  if (!parsed.ok) throw invalid({ targetPath: parsed.code });
  const targetPath = `${parsed.path}${parsed.query}`;
  if (/[?&](utm_[a-z]+|tt_l)=/i.test(parsed.query)) throw invalid({ targetPath: "path_query" });
  const check = await checkStoreLink(db, targetPath, now);
  if (check.state === "missing") throw invalid({ targetPath: "link_missing" });
  let utmCampaign: string | null = input.campaign || null;
  if (input.campaignId) {
    const campaign = (await db.all<{ id: string; utm_campaign: string | null; status: string }>(sql`SELECT id, utm_campaign, status FROM campaigns WHERE id = ${input.campaignId}`))[0];
    if (!campaign) throw invalid({ campaignId: "invalid" });
    if (campaign.status === "cancelled") throw invalid({ campaignId: "campaign_closed" });
    utmCampaign = campaign.utm_campaign;
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = randomCode();
    try {
      await runBatch(db, [
        db.insert(utmLinks).values({
          id: linkId,
          code,
          campaignId: input.campaignId ?? null,
          targetPath,
          utmSource: input.source,
          utmMedium: input.medium,
          utmCampaign,
          utmContent: input.content || null,
          utmTerm: input.term || null,
          clicks: 0,
          createdBy: actorId(actor),
          createdAt: now,
        }),
        auditStatement(db, { actor, action: "marketing.link.create", entityType: input.campaignId ? "campaign" : "utm_link", entityId: input.campaignId ?? linkId, after: { linkId, code, targetPath, source: input.source, medium: input.medium, campaign: utmCampaign, content: input.content || null, term: input.term || null }, at: now }),
      ]);
      const url = linkUrl(origin, { targetPath, source: input.source, medium: input.medium, campaign: utmCampaign, content: input.content || null, term: input.term || null, code });
      return { linkId, code, url, replayed: false, pageState: check.state };
    } catch (error) {
      const info = mapDbError(error);
      if (info?.kind !== "unique") throw error;
      // the same key at once: the other request made it
      const again = (await db.all<LinkDbRow>(sql`SELECT * FROM utm_links WHERE id = ${linkId}`))[0];
      if (again) return { linkId, code: again.code, url: toOption(origin, again).url, replayed: true, pageState: check.state };
      // a code taken by another link: draw again
    }
  }
  throw new AppError("utm_taken", 409);
}

// ───────────────────────────────────────────────────────────────── attribution

type AttributedRow = { id: string; placed_at: number; utm_link_id: string | null; attribution: string | null; total_iqd: number; paid_iqd: number; refunded_iqd: number; link_campaign: string | null; link_source: string | null; link_medium: string | null };

function attributionOf(text: string | null): { source?: string; medium?: string; campaign?: string } {
  if (!text) return {};
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string) => (typeof value[key] === "string" && (value[key] as string).length <= 100 ? (value[key] as string) : undefined);
    return { source: pick("source"), medium: pick("medium"), campaign: pick("campaign") };
  } catch {
    return {};
  }
}

export type AttributedTotals = { orders: number; paidIqd: number; gmvIqd: number };

/** An order ATTRIBUTED to a campaign (docs/metrics.md §8): when it was placed and what arrived and stayed. */
export type AttributedOrder = { campaignId: string; placedAt: number; paidIqd: number };

/**
 * Orders placed in [fromMs, toMs) that carry a source (a link or a recorded utm_campaign), by campaign. Money is what
 * arrived and stayed: Σ (paid − refunded) per order (docs/metrics.md §8). Cancelled orders never count. `attributed`
 * counts every order that carries a source; `orders` are only those attributed to a campaign (a campaign link, or a
 * recorded utm_campaign that is a campaign's) — the metrics' "attributed order", one list for months, totals and
 * campaigns alike. A source that matches no campaign is `unmatched`.
 */
export async function attributedByCampaign(db: Db, scope: { fromMs: number; toMs: number; includeDemo: boolean }): Promise<{ byCampaign: Map<string, AttributedTotals>; bySource: Map<string, AttributedTotals & { source: string; medium: string | null }>; unmatched: AttributedTotals; attributed: number; orders: AttributedOrder[] }> {
  // a demo campaign is not a campaign of a real report: its link or its utm_campaign attributes nothing there
  const rows = await db.all<AttributedRow>(sql`
    SELECT o.id, o.placed_at, o.utm_link_id, o.attribution, o.total_iqd, o.paid_iqd, o.refunded_iqd, l.utm_source AS link_source, l.utm_medium AS link_medium,
      CASE WHEN ${scope.includeDemo ? 1 : 0} = 1 OR lc.is_demo = 0 THEN l.campaign_id ELSE NULL END AS link_campaign
    FROM orders o LEFT JOIN utm_links l ON l.id = o.utm_link_id LEFT JOIN campaigns lc ON lc.id = l.campaign_id
    WHERE (${scope.includeDemo ? 1 : 0} = 1 OR o.is_demo = 0) AND o.status <> 'cancelled' AND o.placed_at >= ${scope.fromMs} AND o.placed_at < ${scope.toMs}
      AND (o.utm_link_id IS NOT NULL OR o.attribution IS NOT NULL)`);
  const byUtm = new Map<string, string>();
  if (rows.length > 0) {
    for (const row of await db.all<{ id: string; utm_campaign: string }>(sql`SELECT id, utm_campaign FROM campaigns WHERE utm_campaign IS NOT NULL AND (${scope.includeDemo ? 1 : 0} = 1 OR is_demo = 0)`)) byUtm.set(row.utm_campaign, row.id);
  }
  const byCampaign = new Map<string, AttributedTotals>();
  const bySource = new Map<string, AttributedTotals & { source: string; medium: string | null }>();
  const unmatched: AttributedTotals = { orders: 0, paidIqd: 0, gmvIqd: 0 };
  const orders: AttributedOrder[] = [];
  const add = (totals: AttributedTotals, row: AttributedRow) => {
    totals.orders += 1;
    totals.paidIqd += num(row.paid_iqd) - num(row.refunded_iqd);
    totals.gmvIqd += num(row.total_iqd);
  };
  for (const row of rows) {
    const recorded = attributionOf(row.attribution);
    const campaignId = row.link_campaign ?? (recorded.campaign ? (byUtm.get(recorded.campaign.toLowerCase()) ?? null) : null);
    if (campaignId) {
      const totals = byCampaign.get(campaignId) ?? { orders: 0, paidIqd: 0, gmvIqd: 0 };
      add(totals, row);
      byCampaign.set(campaignId, totals);
      orders.push({ campaignId, placedAt: num(row.placed_at), paidIqd: num(row.paid_iqd) - num(row.refunded_iqd) });
    } else add(unmatched, row);
    const source = recorded.source ?? row.link_source ?? null;
    if (source) {
      const medium = recorded.medium ?? row.link_medium ?? null;
      const key = `${source}|${medium ?? ""}`;
      const totals = bySource.get(key) ?? { orders: 0, paidIqd: 0, gmvIqd: 0, source, medium };
      add(totals, row);
      bySource.set(key, totals);
    }
  }
  return { byCampaign, bySource, unmatched, attributed: rows.length, orders };
}

export type AttributionReport = {
  range: DayRange;
  /** Orders placed in the range (not cancelled) and how many of them carry a source. */
  orders: { total: number; attributed: number };
  /** Has any order ever carried a source? False until the storefront records it. */
  captured: boolean;
  byCampaign: { campaignId: string; name: string; utm: string | null; orders: number; paidIqd: number; gmvIqd: number }[];
  bySource: { source: string; medium: string | null; orders: number; paidIqd: number; gmvIqd: number }[];
  unmatched: AttributedTotals;
};

export async function attributionReport(db: Db, actor: Actor, range: DayRange, now: number): Promise<AttributionReport> {
  assertAny(actor, SECTION_READ.links);
  void now;
  const fromMs = dayStart(range.from) ?? 0;
  const toMs = (dayStart(range.to) ?? fromMs) + DAY_MS;
  const [{ byCampaign, bySource, unmatched, attributed }, totalRows, everRows] = await Promise.all([
    attributedByCampaign(db, { fromMs, toMs, includeDemo: range.demo }),
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM orders WHERE (${range.demo ? 1 : 0} = 1 OR is_demo = 0) AND status <> 'cancelled' AND placed_at >= ${fromMs} AND placed_at < ${toMs}`),
    db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM (SELECT 1 FROM orders WHERE utm_link_id IS NOT NULL OR attribution IS NOT NULL LIMIT 1)`),
  ]);
  const ids = [...byCampaign.keys()];
  const names = ids.length > 0 ? await db.all<{ id: string; name: string; utm_campaign: string | null }>(sql`SELECT id, name, utm_campaign FROM campaigns WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`) : [];
  return {
    range,
    orders: { total: num(totalRows[0]?.n), attributed },
    captured: num(everRows[0]?.n) > 0,
    byCampaign: ids
      .map((id) => {
        const totals = byCampaign.get(id) as AttributedTotals;
        const found = names.find((row) => row.id === id);
        return { campaignId: id, name: found?.name ?? id, utm: found?.utm_campaign ?? null, ...totals };
      })
      .sort((a, b) => b.paidIqd - a.paidIqd),
    bySource: [...bySource.values()].sort((a, b) => b.orders - a.orders),
    unmatched,
  };
}
