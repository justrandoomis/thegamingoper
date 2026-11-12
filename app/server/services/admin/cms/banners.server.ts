/**
 * Admin 17.01 / 17.02 — promotional banners (`banners`): where they stand (home strip, every category, one category,
 * the cart), their words in ar/en/ckb, a catalogue photo, the link, and when they run (Iraq time).
 *
 *   listBanners(db, actor, parseBannerFilters(url.searchParams), locale, now)
 *   getBannerEditor(db, actor, bannerId | "new", locale, now)
 *   saveBanner(db, actor, raw, now, { demo? })                         → { bannerId, created }
 *   changeBannerStatus(db, actor, { bannerId, version, action, startsAt?, endsAt?, reason }, now)
 *   getActiveBanners(db, locale, placement, { now, categoryId?, includeDemo? })   ← the storefront's read
 *
 * Rules: a banner has no separate draft (the table has none) — a banner that is not published is the draft, and
 * the editor warns that saving a LIVE banner changes the store at once (its preview shows the change first). Every
 * write is guarded by the row's `updated_at` (a stale form → `content_changed`) and audited. Publishing or
 * scheduling — and saving a live or scheduled banner — checks the link: an internal path that opens nothing (or the
 * admin, the API) is refused, and a product link must be a product the catalogue shows at the banner's start
 * (published, or scheduled by then, and complete: assertProductReady). Content never changes a product's status.
 * Permission: cms.banner.manage for everything here.
 */
import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getPhoto } from "~/art";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { banners, categories, type Banner } from "~/server/db/schema";
import { searchProductIds } from "~/server/db/search.server";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { MAX_SCHEDULE_AHEAD_MS } from "../catalog/rules";
import {
  BANNER_ACCENTS,
  BANNER_PLACEMENTS,
  BANNER_TEXT,
  BANNER_VIEWS,
  type BannerView,
  CATEGORY_PLACEMENT_PREFIX,
  PAGE_SIZE,
  isBannerPlacement,
  isSafeExternalUrl,
  latinDigits,
  liveStateOf,
  normalizeStorePath,
  oneOf,
  ownStorePath,
  pageOf,
  parseBaghdadLocal,
  queryText,
  type BannerStatus,
  type LiveState,
} from "./rules";
import { actorIdOf, assertProductReady, checkStoreLink, cmsError, parseInput, productIdOfLink, zL10n, zL10nRequired, zReason, zText, type LinkCheck } from "./shared.server";

// ───────────────────────────────────────────────────────────────── list

export type BannerFilters = { view: BannerView; placement: string | null; q: string; page: number };

export function parseBannerFilters(params: URLSearchParams): BannerFilters {
  const placement = params.get("placement");
  return { view: oneOf(params.get("view"), BANNER_VIEWS, "all"), placement: placement && isBannerPlacement(placement) ? placement : null, q: queryText(params.get("q")), page: pageOf(params.get("page")) };
}

export type BannerListRow = {
  id: string;
  placement: string;
  /** The category's name for a one-category banner. */
  categoryName: string | null;
  title: string;
  status: BannerStatus;
  state: LiveState;
  startsAt: number | null;
  endsAt: number | null;
  sort: number;
  artKey: string | null;
  link: string | null;
  isDemo: boolean;
  updatedAt: number;
};

/**
 * `counts`: how many banners each view holds among those the placement and words filters keep — the count on a view's
 * chip is the list that chip opens (review 2026-11-12: they counted every banner); `stored`: every banner there is.
 */
export type BannerList = { rows: BannerListRow[]; total: number; page: number; pageCount: number; counts: Record<BannerView, number>; stored: number; categories: { id: string; name: string }[] };

/** Every banner (demo ones included and marked), newest change first, with how many sit in each view. */
export async function listBanners(db: Db, actor: Actor, filters: BannerFilters, locale: Locale, now: number): Promise<BannerList> {
  assertCan(actor, "cms.banner.manage");
  const all = await db.select().from(banners).orderBy(desc(banners.updatedAt), asc(banners.id));
  const categoryRows = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sort), asc(categories.id));
  const categoryName = new Map(categoryRows.map((row) => [row.id, pick(row.name, locale)]));
  const viewOf = (row: Banner): BannerView => liveStateOf(row, now);
  const needle = filters.q.toLowerCase();
  const matching = all.filter((row) => {
    if (filters.placement && row.placement !== filters.placement) return false;
    if (needle) {
      const haystack = [row.title.ar, row.title.en, row.title.ckb, row.link].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const counts = Object.fromEntries(BANNER_VIEWS.map((view) => [view, 0])) as Record<BannerView, number>;
  for (const row of matching) {
    counts.all++;
    counts[viewOf(row)]++;
  }
  const filtered = matching.filter((row) => filters.view === "all" || viewOf(row) === filters.view);
  const total = filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(
    (row): BannerListRow => ({
      id: row.id,
      placement: row.placement,
      categoryName: row.placement.startsWith(CATEGORY_PLACEMENT_PREFIX) ? (categoryName.get(row.placement.slice(CATEGORY_PLACEMENT_PREFIX.length)) ?? null) : null,
      title: pick(row.title, locale),
      status: row.status,
      state: liveStateOf(row, now),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      sort: row.sort,
      artKey: row.artKey,
      link: row.link,
      isDemo: row.isDemo,
      updatedAt: row.updatedAt,
    }),
  );
  return { rows, total, page, pageCount, counts, stored: all.length, categories: categoryRows.map((row) => ({ id: row.id, name: pick(row.name, locale) })) };
}

// ───────────────────────────────────────────────────────────────── one banner

export type BannerValues = {
  placement: string;
  title: L10n;
  subtitle: L10n | null;
  ctaLabel: L10n | null;
  link: string | null;
  artKey: string | null;
  accent: string;
  sort: number;
  startsAt: number | null;
  endsAt: number | null;
};

export type BannerEditor = {
  banner: (BannerValues & { id: string; status: BannerStatus; state: LiveState; isDemo: boolean; version: number; createdBy: string | null }) | null;
  categories: { id: string; name: string }[];
  link: LinkCheck | null;
};

export async function getBannerEditor(db: Db, actor: Actor, bannerId: string, locale: Locale, now: number): Promise<BannerEditor> {
  assertCan(actor, "cms.banner.manage");
  const categoryRows = await db.select({ id: categories.id, name: categories.name }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sort), asc(categories.id));
  const list = categoryRows.map((row) => ({ id: row.id, name: pick(row.name, locale) }));
  if (bannerId === "new") return { banner: null, categories: list, link: null };
  const row = await db.select().from(banners).where(eq(banners.id, bannerId)).get();
  if (!row) throw notFound("banner");
  return {
    banner: {
      id: row.id,
      placement: row.placement,
      title: row.title,
      subtitle: row.subtitle,
      ctaLabel: row.ctaLabel,
      link: row.link,
      artKey: row.artKey,
      accent: row.accent ?? "brand",
      sort: row.sort,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      status: row.status,
      state: liveStateOf(row, now),
      isDemo: row.isDemo,
      version: row.updatedAt,
      createdBy: row.createdBy,
    },
    categories: list,
    link: row.link ? await checkStoreLink(db, row.link, now) : null,
  };
}

const zLocal = z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), z.string().optional());

export const BannerInput = z.object({
  bannerId: z.string().trim().min(1).max(128).optional(),
  version: z.coerce.number().int().optional(),
  placement: z.string({ error: "required" }).trim().refine(isBannerPlacement, "invalid"),
  title: zL10nRequired(BANNER_TEXT.title),
  subtitle: zL10n(BANNER_TEXT.subtitle, false),
  ctaLabel: zL10n(BANNER_TEXT.cta, false),
  link: zText(500),
  artKey: zText(160),
  accent: z.enum(BANNER_ACCENTS, { error: "invalid" }).default("brand"),
  sort: z.preprocess((value) => (typeof value === "string" ? latinDigits(value.trim()) || undefined : value), z.coerce.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(999, "too_big").default(0)),
  startsAt: zLocal,
  endsAt: zLocal,
});

type ParsedBanner = z.output<typeof BannerInput>;

/**
 * The banner's values from a parsed form: link normalized (a full address of the store itself is the store path it
 * names — ownStorePath —, so it can never reach the admin), times in Iraq time, every reference checked.
 */
async function valuesOf(db: Db, input: ParsedBanner, origins: readonly string[]): Promise<BannerValues> {
  const fields: Record<string, string> = {};
  let link: string | null = null;
  if (input.link) {
    const own = ownStorePath(input.link, origins);
    if (own === null && /^https?:\/\//i.test(input.link)) {
      if (isSafeExternalUrl(input.link)) link = input.link.trim();
      else fields.link = "link_invalid";
    } else {
      const parsed = normalizeStorePath(own ?? input.link, { query: true });
      if (parsed.ok) link = `${parsed.path}${parsed.query}`;
      else fields.link = parsed.code === "path_reserved" ? "link_reserved" : "link_invalid";
    }
  }
  if (input.ctaLabel && !input.link) fields.link = "required";
  const startsAt = input.startsAt === undefined ? null : parseBaghdadLocal(input.startsAt);
  const endsAt = input.endsAt === undefined ? null : parseBaghdadLocal(input.endsAt);
  if (input.startsAt !== undefined && startsAt === null) fields.startsAt = "invalid";
  if (input.endsAt !== undefined && endsAt === null) fields.endsAt = "invalid";
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) fields.endsAt = "schedule_order";
  if (input.artKey && !getPhoto(input.artKey)) fields.artKey = "art_unknown";
  if (input.placement.startsWith(CATEGORY_PLACEMENT_PREFIX)) {
    const id = input.placement.slice(CATEGORY_PLACEMENT_PREFIX.length);
    const category = await db.select({ id: categories.id }).from(categories).where(and(eq(categories.id, id), eq(categories.isActive, true))).get();
    if (!category) fields.placement = "category_unknown";
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return {
    placement: input.placement,
    title: input.title,
    subtitle: input.subtitle,
    ctaLabel: input.ctaLabel,
    link,
    artKey: input.artKey ?? null,
    accent: input.accent,
    sort: input.sort,
    startsAt,
    endsAt,
  };
}

/**
 * What a banner that runs (published or scheduled) must satisfy: an end after its start and after now, a link that
 * opens something, and — for a product link — a product the catalogue shows when the banner starts.
 */
async function assertRunnable(db: Db, values: Pick<BannerValues, "link" | "startsAt" | "endsAt">, now: number): Promise<void> {
  if (values.endsAt !== null && values.endsAt <= Math.max(now, values.startsAt ?? now)) throw invalid({ endsAt: "schedule_past" });
  if (!values.link) return;
  const check = await checkStoreLink(db, values.link, Math.max(now, values.startsAt ?? now));
  const productId = await productIdOfLink(db, values.link);
  if (productId) {
    await assertProductReady(db, productId, Math.max(now, values.startsAt ?? now), "link");
    return;
  }
  if (check.state === "missing" || check.state === "not_live") throw cmsError("link_missing", 409, { fields: { link: "link_missing" }, detail: check.kind ?? "" });
}

function conflictOf(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
  throw error;
}

/**
 * Creates a banner (a draft) or saves one; a live or scheduled banner is checked as when it was published, and a
 * scheduled one keeps a start (without one it would never run). `origins`: the request's own origin (ctx.origin).
 */
export async function saveBanner(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean; origins?: readonly string[] } = {}): Promise<{ bannerId: string; created: boolean }> {
  assertCan(actor, "cms.banner.manage");
  const input = parseInput(BannerInput, raw);
  const values = await valuesOf(db, input, options.origins ?? []);
  const by = actorIdOf(actor);
  if (!input.bannerId) {
    const bannerId = newId("ban");
    await runBatch(db, [
      db.insert(banners).values({ id: bannerId, ...values, status: "draft", isDemo: options.demo ?? false, createdBy: by, updatedAt: now }),
      auditStatement(db, { actor, action: "cms.banner.create", entityType: "banner", entityId: bannerId, after: { placement: values.placement, title: values.title.ar, link: values.link, demo: options.demo ?? false }, at: now }),
    ]);
    return { bannerId, created: true };
  }
  const row = await db.select().from(banners).where(eq(banners.id, input.bannerId)).get();
  if (!row) throw notFound("banner");
  if (input.version === undefined || row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  // a scheduled banner without a start never runs (the storefront read skips it): take it off, or give it a start
  if (row.status === "scheduled" && values.startsAt === null) throw invalid({ startsAt: "required" });
  if (row.status === "published" || row.status === "scheduled") await assertRunnable(db, values, now);
  const changed = (Object.keys(values) as (keyof BannerValues)[]).filter((key) => JSON.stringify(values[key] ?? null) !== JSON.stringify((row as Record<string, unknown>)[key] ?? null));
  if (changed.length === 0) return { bannerId: row.id, created: false };
  await runBatch(db, [
    db.update(banners).set({ ...values, updatedAt: now }).where(and(eq(banners.id, row.id), eq(banners.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, {
      actor,
      action: "cms.banner.update",
      entityType: "banner",
      entityId: row.id,
      before: Object.fromEntries(changed.map((key) => [key, (row as Record<string, unknown>)[key] ?? null])),
      after: Object.fromEntries(changed.map((key) => [key, values[key] ?? null])),
      summary: row.status === "published" ? "live banner changed" : null,
      at: now,
    }),
  ]).catch(conflictOf);
  return { bannerId: row.id, created: false };
}

export const BANNER_ACTIONS = ["publish", "schedule", "unpublish", "archive", "restore"] as const;
export type BannerAction = (typeof BANNER_ACTIONS)[number];

const StatusInput = z.object({
  bannerId: z.string().trim().min(1),
  version: z.coerce.number().int(),
  action: z.enum(BANNER_ACTIONS, { error: "invalid" }),
  startsAt: zLocal,
  endsAt: zLocal,
  reason: zReason(true),
});

const NEXT_STATUS: Record<BannerAction, BannerStatus> = { publish: "published", schedule: "scheduled", unpublish: "draft", archive: "archived", restore: "draft" };
const FROM: Record<BannerAction, readonly BannerStatus[]> = {
  publish: ["draft", "scheduled", "published"],
  schedule: ["draft", "scheduled", "published"],
  unpublish: ["published", "scheduled"],
  archive: ["draft", "published", "scheduled"],
  restore: ["archived"],
};

/**
 * Publishes now (optionally until an end), schedules (a start in the future, optionally an end), takes a banner off
 * the store (back to draft), archives or restores it. Always with a reason; audited with before/after.
 */
export async function changeBannerStatus(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: BannerStatus }> {
  assertCan(actor, "cms.banner.manage");
  const input = parseInput(StatusInput, raw);
  const row = await db.select().from(banners).where(eq(banners.id, input.bannerId)).get();
  if (!row) throw notFound("banner");
  if (row.updatedAt !== input.version) throw cmsError("content_changed", 409);
  if (!FROM[input.action].includes(row.status)) throw cmsError("content_changed", 409, { detail: `${row.status} → ${input.action}` });
  let startsAt = row.startsAt;
  let endsAt = row.endsAt;
  if (input.action === "publish" || input.action === "schedule") {
    const start = input.startsAt === undefined ? null : parseBaghdadLocal(input.startsAt);
    const end = input.endsAt === undefined ? null : parseBaghdadLocal(input.endsAt);
    if (input.startsAt !== undefined && start === null) throw invalid({ startsAt: "invalid" });
    if (input.endsAt !== undefined && end === null) throw invalid({ endsAt: "invalid" });
    if (input.action === "schedule") {
      if (start === null) throw invalid({ startsAt: "required" });
      if (start <= now) throw invalid({ startsAt: "schedule_past" });
      if (start > now + MAX_SCHEDULE_AHEAD_MS) throw invalid({ startsAt: "schedule_far" });
      startsAt = start;
    } else {
      startsAt = null;
    }
    endsAt = end;
    if (endsAt !== null && startsAt !== null && endsAt <= startsAt) throw invalid({ endsAt: "schedule_order" });
    await assertRunnable(db, { link: row.link, startsAt, endsAt }, now);
  }
  const status = NEXT_STATUS[input.action];
  await runBatch(db, [
    db.update(banners).set({ status, startsAt, endsAt, updatedAt: now }).where(and(eq(banners.id, row.id), eq(banners.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
    auditStatement(db, {
      actor,
      action: `cms.banner.${input.action}`,
      entityType: "banner",
      entityId: row.id,
      before: { status: row.status, startsAt: row.startsAt, endsAt: row.endsAt },
      after: { status, startsAt, endsAt },
      reason: input.reason,
      at: now,
    }),
  ]).catch(conflictOf);
  return { status };
}

export type PhotoChoice = { productId: string; name: string; keys: string[] };

/** Catalogue photos to put on a banner: the products a search finds, with up to four of their photo keys each. */
export async function searchProductPhotos(db: Db, actor: Actor, q: string, locale: Locale): Promise<PhotoChoice[]> {
  assertCan(actor, "cms.banner.manage");
  const query = q.trim().slice(0, 80);
  if (!query) return [];
  const hits = (await searchProductIds(db, query, { limit: 8 })).map((hit) => hit.productId);
  if (hits.length === 0) return [];
  const rows = await db.all<{ id: string; name: string; art_key: string }>(sql`
    SELECT p.id, p.name, m.art_key FROM products AS p JOIN media AS m ON m.owner_type = 'product' AND m.owner_id = p.id AND m.art_key IS NOT NULL AND m.kind IN ('image', 'render')
    WHERE p.id IN (SELECT value FROM json_each(${JSON.stringify(hits)}))
    ORDER BY p.id, m.sort, m.id`);
  const out = new Map<string, PhotoChoice>();
  for (const row of rows) {
    if (!getPhoto(row.art_key)) continue;
    const entry = out.get(row.id) ?? { productId: row.id, name: (() => { try { return pick(JSON.parse(row.name) as L10n, locale); } catch { return row.id; } })(), keys: [] };
    if (entry.keys.length < 4) entry.keys.push(row.art_key);
    out.set(row.id, entry);
  }
  return hits.map((id) => out.get(id)).filter((entry): entry is PhotoChoice => Boolean(entry));
}

// ───────────────────────────────────────────────────────────────── the storefront's read

export type StoreBanner = {
  id: string;
  title: string;
  subtitle: string | null;
  ctaLabel: string | null;
  /** Locale-less storefront path (wrap it in LocaleLink) or an https URL. */
  link: string | null;
  external: boolean;
  /** A catalogue photo key for <Art>/<Render>. */
  artKey: string | null;
  accent: string;
  /** The language the words are in (Arabic when the visitor's language has none). */
  textLocale: Locale;
};

/** Most banners one placement shows at once. */
export const BANNERS_PER_PLACEMENT = 3;

/**
 * The banners a storefront slot shows now: published (or scheduled and due), inside their window, not demo (unless
 * `includeDemo`), by `sort`. `category_top` banners show on every category page; pass `categoryId` to add the ones
 * for that category. A banner linking to a product the catalogue no longer shows is left out.
 */
export async function getActiveBanners(db: Db, locale: Locale, placement: (typeof BANNER_PLACEMENTS)[number], options: { now: number; categoryId?: string | null; includeDemo?: boolean }): Promise<StoreBanner[]> {
  const { now } = options;
  const places = [placement, ...(placement === "category_top" && options.categoryId ? [`${CATEGORY_PLACEMENT_PREFIX}${options.categoryId}`] : [])];
  const conditions: SQL[] = [
    inArray(banners.placement, places),
    inArray(banners.status, ["published", "scheduled"]),
    sql`(${banners.startsAt} IS NULL OR ${banners.startsAt} <= ${now})`,
    sql`(${banners.endsAt} IS NULL OR ${banners.endsAt} > ${now})`,
    // a scheduled banner without a start never runs
    sql`(${banners.status} = 'published' OR ${banners.startsAt} IS NOT NULL)`,
  ];
  if (!options.includeDemo) conditions.push(eq(banners.isDemo, false));
  const rows = await db
    .select()
    .from(banners)
    .where(and(...conditions))
    .orderBy(asc(banners.sort), desc(banners.updatedAt))
    .limit(BANNERS_PER_PLACEMENT * 2);
  const productSlugs = rows.map((row) => /^\/p\/([^/?#]+)/.exec(row.link ?? "")?.[1]).filter((slug): slug is string => Boolean(slug));
  const liveSlugs = new Set<string>();
  if (productSlugs.length > 0) {
    const live = await db.all<{ slug: string }>(
      sql`SELECT p.slug FROM products p WHERE p.slug IN (${sql.join(
        productSlugs.map((slug) => sql`${slug}`),
        sql`, `,
      )}) AND (p.status = 'published' OR (p.status = 'scheduled' AND p.publish_at <= ${now})) AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1)`,
    );
    for (const row of live) liveSlugs.add(row.slug);
  }
  const out: StoreBanner[] = [];
  for (const row of rows) {
    const slug = /^\/p\/([^/?#]+)/.exec(row.link ?? "")?.[1];
    if (slug && !liveSlugs.has(slug)) continue;
    const textLocale: Locale = row.title[locale] ? locale : "ar";
    out.push({
      id: row.id,
      title: pick(row.title, textLocale),
      subtitle: row.subtitle ? pick(row.subtitle, textLocale) || null : null,
      ctaLabel: row.ctaLabel ? pick(row.ctaLabel, textLocale) || null : null,
      link: row.link,
      external: Boolean(row.link && /^https:\/\//i.test(row.link)),
      artKey: row.artKey,
      accent: row.accent ?? "brand",
      textLocale,
    });
    if (out.length === BANNERS_PER_PLACEMENT) break;
  }
  return out;
}

/** Banners whose window starts or ends between `from` and `to` (the schedule). */
export async function bannersInRange(db: Db, from: number, to: number) {
  return db
    .select()
    .from(banners)
    .where(
      and(
        inArray(banners.status, ["published", "scheduled", "draft"]),
        or(sql`${banners.startsAt} BETWEEN ${from} AND ${to}`, sql`${banners.endsAt} BETWEEN ${from} AND ${to}`, sql`(${banners.startsAt} IS NULL OR ${banners.startsAt} < ${from}) AND (${banners.endsAt} IS NULL OR ${banners.endsAt} > ${to}) AND ${banners.status} IN ('published', 'scheduled')`),
      ),
    )
    .orderBy(asc(banners.startsAt));
}
