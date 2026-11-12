/**
 * Admin 17.02 — the calendar of seasonal campaigns and new game releases, in Iraq days: when banners, landing pages
 * and pinned heroes start and end, and the catalogue's own dates (products scheduled to publish, pre-order releases,
 * the release days of variants still to come). It is read-only here: each item is changed where it lives (its
 * editor in this module, or the product's editor in the catalogue — content never changes a product's status).
 *
 *   getSchedule(db, actor, parseScheduleFilters(url.searchParams), locale, now)
 *
 * Problems are said where they will happen: a pin or banner whose product the catalogue will not show at its start
 * (not published by then, or incomplete — publishDueProducts sends an incomplete scheduled product back to draft),
 * pins of one platform whose windows overlap (only one can be published), a scheduled page whose end is before its
 * start. Each kind is listed only for the permission that may change it (catalogue dates: catalog.product.read). A
 * banner or pin still in draft shows its planned dates marked `draft` — a plan, which happens only once published.
 */
import { sql } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { forbidden } from "~/server/errors";
import { DAY_MS, SCHEDULE_SPANS, baghdadDay, inWindow, latinDigits, liveStateOf, parseBaghdadDay, readPinConfig, storePathOfPage, windowsOverlap, type HeroPlatform } from "./rules";
import { parseJsonText, productIdOfLink, productReadiness } from "./shared.server";

export type ScheduleFilters = { from: string | null; days: (typeof SCHEDULE_SPANS)[number] };

export function parseScheduleFilters(params: URLSearchParams): ScheduleFilters {
  const from = params.get("from");
  const days = Number(latinDigits(params.get("days") ?? ""));
  return { from: from && parseBaghdadDay(from) !== null ? latinDigits(from) : null, days: (SCHEDULE_SPANS as readonly number[]).includes(days) ? (days as ScheduleFilters["days"]) : 30 };
}

export type ScheduleKind = "banner" | "page" | "pin" | "product_publish" | "preorder_release" | "variant_release";
export type ScheduleEdge = "start" | "end" | "release";
export type ScheduleProblem = "product_not_ready" | "pin_overlap" | "incomplete";

export type ScheduleItem = {
  key: string;
  kind: ScheduleKind;
  edge: ScheduleEdge;
  at: number;
  title: string;
  /** Platform of a pin; a variant's SKU. */
  detail: string | null;
  /** Where staff change it (an admin path). */
  href: string;
  /** Where it shows on the storefront, when it has a place. */
  storePath: string | null;
  problem: ScheduleProblem | null;
  /**
   * A plan, not a schedule: the banner or pin is still a draft, so this date happens only once someone publishes or
   * schedules it (review 2026-11-12: the calendar and the module's home said "starts" for a draft that never would).
   */
  draft: boolean;
  /** A demo row (is_demo): the storefront never shows it, whatever its dates say. */
  demo: boolean;
  /** A running item: since when (null: it has no start, it runs from its publication). */
  since?: number | null;
};

export type ScheduleDay = { day: string; items: ScheduleItem[] };
export type Schedule = { from: string; to: string; days: ScheduleDay[]; running: ScheduleItem[]; problems: number; can: { banners: boolean; pages: boolean; pins: boolean; catalog: boolean } };

type BannerRow = { id: string; title: string; status: string; starts_at: number | null; ends_at: number | null; link: string | null; placement: string; is_demo: number };
type PageRow = { slug: string; kind: string; title: string; status: string; starts_at: number | null; ends_at: number | null; is_demo: number };
type PinRow = { id: string; config: string | null; is_active: number; starts_at: number | null; ends_at: number | null; is_demo: number };
type ProductRow = { id: string; name: string; publish_at: number | null; preorder_release_at: number | null; status: string };
type VariantDayRow = { product_id: string; name: string; sku: string; day: string };

export async function getSchedule(db: Db, actor: Actor, filters: ScheduleFilters, locale: Locale, now: number): Promise<Schedule> {
  if (!canAny(actor, ["cms.banner.manage", "cms.home.manage", "cms.page.manage", "cms.page.publish"])) throw forbidden("cms.banner.manage");
  const access = { banners: can(actor, "cms.banner.manage"), pages: can(actor, "cms.page.manage") || can(actor, "cms.page.publish"), pins: can(actor, "cms.home.manage"), catalog: can(actor, "catalog.product.read") };
  const fromAt = filters.from ? parseBaghdadDay(filters.from)! : parseBaghdadDay(baghdadDay(now))!;
  const toAt = fromAt + filters.days * DAY_MS;
  const inRange = (at: number | null) => at !== null && at >= fromAt && at < toAt;
  const items: ScheduleItem[] = [];
  const running: ScheduleItem[] = [];
  const name = (text: string | null) => pick(parseJsonText<L10n>(text), locale);

  const [bannerRows, pageRows, pinRows, productRows, variantRows] = await Promise.all([
    access.banners ? db.all<BannerRow>(sql`SELECT id, title, status, starts_at, ends_at, link, placement, is_demo FROM banners WHERE status IN ('draft', 'scheduled', 'published')`) : Promise.resolve([]),
    access.pages ? db.all<PageRow>(sql`SELECT slug, kind, title, status, starts_at, ends_at, is_demo FROM pages WHERE status IN ('scheduled', 'published') AND (starts_at IS NOT NULL OR ends_at IS NOT NULL)`) : Promise.resolve([]),
    access.pins ? db.all<PinRow>(sql`SELECT id, config, is_active, starts_at, ends_at, is_demo FROM home_sections WHERE kind = 'hero_pin'`) : Promise.resolve([]),
    access.catalog
      ? db.all<ProductRow>(sql`SELECT id, name, publish_at, preorder_release_at, status FROM products WHERE (status = 'scheduled' AND publish_at BETWEEN ${fromAt} AND ${toAt}) OR (status = 'published' AND preorder_release_at BETWEEN ${fromAt} AND ${toAt})`)
      : Promise.resolve([]),
    access.catalog
      ? db.all<VariantDayRow>(sql`
          SELECT p.id AS product_id, p.name, v.sku, je.value AS day
          FROM products AS p JOIN json_each(p.attributes, '$.variantReleaseDates') AS je
          JOIN variants AS v ON v.product_id = p.id AND v.sku = je.key AND v.is_active = 1
          WHERE p.status = 'published' AND json_type(p.attributes, '$.variantReleaseDates') = 'object'`)
      : Promise.resolve([]),
  ]);

  // banners: their start and end; a product link checked against the catalogue at the start
  for (const row of bannerRows) {
    const title = name(row.title);
    const runs = row.status === "published" || row.status === "scheduled";
    const base = { kind: "banner" as const, title, detail: row.placement, href: `/admin/cms/banners/${row.id}`, storePath: row.link, draft: !runs, demo: Number(row.is_demo) === 1 };
    let problem: ScheduleProblem | null = null;
    if (runs && row.link) {
      const productId = await productIdOfLink(db, row.link);
      if (productId) {
        const readiness = await productReadiness(db, productId, Math.max(now, row.starts_at ?? now));
        if (!readiness.ok) problem = readiness.reason === "incomplete" ? "incomplete" : "product_not_ready";
      }
    }
    if (runs && inWindow({ startsAt: row.starts_at, endsAt: row.ends_at }, fromAt) && (row.starts_at === null || row.starts_at < fromAt)) running.push({ ...base, key: `banner:${row.id}:run`, edge: "start", at: row.starts_at ?? fromAt, since: row.starts_at, problem });
    if (inRange(row.starts_at)) items.push({ ...base, key: `banner:${row.id}:start`, edge: "start", at: row.starts_at!, problem: runs ? problem : null });
    if (runs && inRange(row.ends_at)) items.push({ ...base, key: `banner:${row.id}:end`, edge: "end", at: row.ends_at!, problem: null });
  }

  for (const row of pageRows) {
    const base = { kind: "page" as const, title: name(row.title) || row.slug, detail: row.kind, href: `/admin/cms/pages/${row.slug}`, storePath: storePathOfPage(row.kind, row.slug), problem: null, draft: false, demo: Number(row.is_demo) === 1 };
    if (inRange(row.starts_at)) items.push({ ...base, key: `page:${row.slug}:start`, edge: "start", at: row.starts_at! });
    if (inRange(row.ends_at)) items.push({ ...base, key: `page:${row.slug}:end`, edge: "end", at: row.ends_at! });
    if (liveStateOf({ status: row.status, startsAt: row.starts_at, endsAt: row.ends_at }, fromAt) === "live" && row.starts_at !== null && row.starts_at < fromAt) running.push({ ...base, key: `page:${row.slug}:run`, edge: "start", at: row.starts_at, since: row.starts_at });
  }

  // pins: overlaps between pins of one platform (drafts included: they cannot both be published)
  const pins = pinRows.map((row) => ({ row, config: readPinConfig(parseJsonText(row.config)) })).filter((entry) => entry.config !== null);
  const productNames = new Map<string, string>();
  if (pins.length > 0) {
    const ids = [...new Set(pins.map((entry) => entry.config!.productId))];
    const rows = await db.all<{ id: string; name: string }>(sql`SELECT id, name FROM products WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
    for (const row of rows) productNames.set(row.id, name(row.name));
  }
  for (const entry of pins) {
    const { row } = entry;
    const config = entry.config!;
    const overlaps = pins.some((other) => other.row.id !== row.id && other.config!.platform === config.platform && windowsOverlap({ startsAt: other.row.starts_at, endsAt: other.row.ends_at }, { startsAt: row.starts_at, endsAt: row.ends_at }));
    let problem: ScheduleProblem | null = overlaps ? "pin_overlap" : null;
    if (!problem) {
      const readiness = await productReadiness(db, config.productId, Math.max(now, row.starts_at ?? now));
      if (!readiness.ok) problem = readiness.reason === "incomplete" ? "incomplete" : "product_not_ready";
    }
    const base = { kind: "pin" as const, title: `${pick(config.headline, locale)} — ${productNames.get(config.productId) ?? ""}`.trim(), detail: config.platform as HeroPlatform, href: `/admin/cms/home/pins/${row.id}`, storePath: "/", draft: Number(row.is_active) !== 1, demo: Number(row.is_demo) === 1 };
    if (Number(row.is_active) === 1 && row.starts_at !== null && row.starts_at < fromAt && (row.ends_at === null || row.ends_at > fromAt)) running.push({ ...base, key: `pin:${row.id}:run`, edge: "start", at: row.starts_at, since: row.starts_at, problem });
    if (inRange(row.starts_at)) items.push({ ...base, key: `pin:${row.id}:start`, edge: "start", at: row.starts_at!, problem });
    if (inRange(row.ends_at)) items.push({ ...base, key: `pin:${row.id}:end`, edge: "end", at: row.ends_at!, problem: null });
  }

  // the catalogue's dates
  for (const row of productRows) {
    const title = name(row.name);
    if (row.status === "scheduled" && inRange(row.publish_at)) {
      const readiness = await productReadiness(db, row.id, row.publish_at!);
      items.push({ key: `product:${row.id}:publish`, kind: "product_publish", edge: "release", at: row.publish_at!, title, detail: null, href: `/admin/catalog/products/${row.id}`, storePath: null, problem: readiness.ok ? null : "incomplete", draft: false, demo: false });
    }
    if (row.status === "published" && inRange(row.preorder_release_at)) items.push({ key: `product:${row.id}:preorder`, kind: "preorder_release", edge: "release", at: row.preorder_release_at!, title, detail: null, href: `/admin/catalog/products/${row.id}`, storePath: null, problem: null, draft: false, demo: false });
  }
  for (const row of variantRows) {
    const at = parseBaghdadDay(row.day);
    if (!inRange(at)) continue;
    items.push({ key: `variant:${row.product_id}:${row.sku}`, kind: "variant_release", edge: "release", at: at!, title: name(row.name), detail: row.sku, href: `/admin/catalog/products/${row.product_id}`, storePath: null, problem: null, draft: false, demo: false });
  }

  items.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  const byDay = new Map<string, ScheduleItem[]>();
  for (const item of items) {
    const day = baghdadDay(item.at);
    byDay.set(day, [...(byDay.get(day) ?? []), item]);
  }
  return {
    from: baghdadDay(fromAt),
    to: baghdadDay(toAt - DAY_MS),
    days: [...byDay.entries()].map(([day, list]) => ({ day, items: list })),
    running: running.sort((a, b) => a.at - b.at),
    problems: [...items, ...running].filter((item) => item.problem !== null).length,
    can: access,
  };
}
