/**
 * Knowledge base — the help centre's device directory and the approved public articles (docs/CONTRACTS.md §3,
 * support row). Only `status = 'approved'` AND `audience = 'public'` articles ever leave this module; drafts, articles
 * under review, archived and internal ones do not exist for the storefront.
 *
 *   const groups = await getSupportDirectory(db, locale);                         // platforms → published device models
 *   const guides = await listArticlesForDevice(db, locale, deviceModelId);        // for a device hub (devices area)
 *   const near   = await listArticlesForDevice(db, locale, id, { related: true }); // + other models of the platform
 *   const all    = await listHelpArticles(db, locale);                            // help centre, staff order
 *   const page   = await getArticle(db, locale, slug);                            // ArticleDetail | null
 *
 * Bodies are localized block arrays (ARCHITECTURE §6) returned as stored; <Blocks> (app/ui/Blocks) checks every block
 * before rendering and only ever puts strings into text nodes. A missing translation falls back to Arabic and says so
 * (`fallback`).
 *
 * Services take `db` first and never import "cloudflare:workers".
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, knowledgeArticles, platforms, type LocalizedBlocks } from "~/server/db/schema";
import type { ArticleDetail, ArticleKind, ArticleSummary, SupportDevice, SupportPlatform, SupportPlatformGroup } from "./types";

// ───────────────────────────────────────────────────────────────── device directory

/**
 * Published device models of the active platforms, grouped by platform in menu order. Inactive platforms (the
 * generic "pc" target of compatibility notes) and unpublished models are left out.
 */
export async function getSupportDirectory(db: Db, locale: Locale): Promise<SupportPlatformGroup[]> {
  const rows = await db
    .select({
      id: deviceModels.id,
      slug: deviceModels.slug,
      name: deviceModels.name,
      artKey: deviceModels.artKey,
      kind: deviceModels.deviceKind,
      platformId: platforms.id,
      platformSlug: platforms.slug,
      platformName: platforms.name,
      accent: platforms.accent,
    })
    .from(deviceModels)
    .innerJoin(platforms, eq(deviceModels.platformId, platforms.id))
    .where(and(eq(platforms.isActive, true), eq(deviceModels.status, "published")))
    .orderBy(asc(platforms.sort), asc(platforms.slug), asc(deviceModels.sort), asc(deviceModels.slug));

  const groups: SupportPlatformGroup[] = [];
  for (const row of rows) {
    let group = groups[groups.length - 1];
    if (!group || group.id !== row.platformId) {
      group = { id: row.platformId, slug: row.platformSlug, name: pick(row.platformName, locale), accent: row.accent, devices: [] };
      groups.push(group);
    }
    const platform: SupportPlatform = { id: group.id, slug: group.slug, name: group.name, accent: group.accent };
    group.devices.push({ id: row.id, slug: row.slug, name: pick(row.name, locale), artKey: row.artKey, kind: row.kind, platform });
  }
  return groups;
}

export function findDevice(groups: readonly SupportPlatformGroup[], slug: string | null | undefined): SupportDevice | null {
  if (!slug) return null;
  for (const group of groups) for (const device of group.devices) if (device.slug === slug) return device;
  return null;
}

export function findPlatform(groups: readonly SupportPlatformGroup[], slug: string | null | undefined): SupportPlatformGroup | null {
  if (!slug) return null;
  return groups.find((group) => group.slug === slug) ?? null;
}

// ───────────────────────────────────────────────────────────────── articles

const isPublic = and(eq(knowledgeArticles.status, "approved"), eq(knowledgeArticles.audience, "public"));

const ARTICLE_KINDS: readonly ArticleKind[] = ["guide", "troubleshooting", "faq", "policy", "setup"];

type ArticleRow = {
  id: string;
  slug: string;
  kind: string;
  title: L10n;
  summary: L10n | null;
  tags: string[] | null;
  sort: number;
  isDemo: boolean;
  approvedBy: string | null;
  updatedAt: number;
  deviceId: string | null;
  deviceSlug: string | null;
  deviceName: L10n | null;
  platformId: string | null;
  platformSlug: string | null;
  platformName: L10n | null;
  accent: string | null;
};

const articleColumns = {
  id: knowledgeArticles.id,
  slug: knowledgeArticles.slug,
  kind: knowledgeArticles.kind,
  title: knowledgeArticles.title,
  summary: knowledgeArticles.summary,
  tags: knowledgeArticles.tags,
  sort: knowledgeArticles.sort,
  isDemo: knowledgeArticles.isDemo,
  approvedBy: knowledgeArticles.approvedBy,
  updatedAt: knowledgeArticles.updatedAt,
  deviceId: knowledgeArticles.deviceModelId,
  deviceSlug: deviceModels.slug,
  deviceName: deviceModels.name,
  platformId: knowledgeArticles.platformId,
  platformSlug: platforms.slug,
  platformName: platforms.name,
  accent: platforms.accent,
};

/** Every approved public article (metadata only, no body), in staff order. The list is small; filters run here. */
async function publicArticleRows(db: Db): Promise<ArticleRow[]> {
  const rows = await db
    .select(articleColumns)
    .from(knowledgeArticles)
    .leftJoin(deviceModels, eq(knowledgeArticles.deviceModelId, deviceModels.id))
    .leftJoin(platforms, eq(knowledgeArticles.platformId, platforms.id))
    .where(isPublic)
    .orderBy(asc(knowledgeArticles.sort), asc(knowledgeArticles.slug));
  return rows as ArticleRow[];
}

function toSummary(row: ArticleRow, locale: Locale, scope: ArticleSummary["scope"]): ArticleSummary {
  const summary = row.summary ? pick(row.summary, locale) : "";
  return {
    id: row.id,
    slug: row.slug,
    kind: (ARTICLE_KINDS as readonly string[]).includes(row.kind) ? (row.kind as ArticleKind) : "guide",
    title: pick(row.title, locale),
    summary: summary || null,
    device: row.deviceSlug && row.deviceName ? { slug: row.deviceSlug, name: pick(row.deviceName, locale) } : null,
    platform: row.platformId && row.platformSlug && row.platformName ? { id: row.platformId, slug: row.platformSlug, name: pick(row.platformName, locale), accent: row.accent ?? "brand" } : null,
    scope,
    updatedAt: row.updatedAt,
    isDemo: row.isDemo,
    reviewed: row.approvedBy !== null && row.approvedBy !== "",
  };
}

/** Approved public articles of the help centre (optionally of one platform / kind), in staff order. */
export async function listHelpArticles(db: Db, locale: Locale, options: { platformId?: string | null; kind?: ArticleKind; limit?: number } = {}): Promise<ArticleSummary[]> {
  const rows = await publicArticleRows(db);
  const out: ArticleSummary[] = [];
  for (const row of rows) {
    if (options.platformId && row.platformId !== options.platformId) continue;
    if (options.kind && row.kind !== options.kind) continue;
    out.push(toSummary(row, locale, row.deviceId ? "device" : "platform"));
    if (options.limit && out.length >= options.limit) break;
  }
  return out;
}

/**
 * The approved public articles for one device model: those written for it ("device"), then those written for every
 * device of its platform ("platform"). With `related`, also those written for another model of the same platform
 * ("related" — never presented as written for this device). Unknown device → [].
 */
export async function listArticlesForDevice(db: Db, locale: Locale, deviceModelId: string, options: { related?: boolean } = {}): Promise<ArticleSummary[]> {
  const device = await db.select({ id: deviceModels.id, platformId: deviceModels.platformId }).from(deviceModels).where(eq(deviceModels.id, deviceModelId)).get();
  if (!device) return [];
  const rows = await publicArticleRows(db);
  const own: ArticleSummary[] = [];
  const wide: ArticleSummary[] = [];
  const near: ArticleSummary[] = [];
  for (const row of rows) {
    if (row.deviceId === device.id) own.push(toSummary(row, locale, "device"));
    else if (row.deviceId === null && row.platformId === device.platformId) wide.push(toSummary(row, locale, "platform"));
    else if (options.related && row.deviceId !== null && row.platformId === device.platformId) near.push(toSummary(row, locale, "related"));
  }
  return [...own, ...wide, ...near];
}

/** Articles for a whole platform (no model chosen, or "my model is not listed"): platform-wide first. */
export async function listArticlesForPlatform(db: Db, locale: Locale, platformId: string): Promise<ArticleSummary[]> {
  const rows = await publicArticleRows(db);
  const wide: ArticleSummary[] = [];
  const models: ArticleSummary[] = [];
  for (const row of rows) {
    if (row.platformId !== platformId) continue;
    if (row.deviceId === null) wide.push(toSummary(row, locale, "platform"));
    else models.push(toSummary(row, locale, "related"));
  }
  return [...wide, ...models];
}

/** Articles carrying a tag (the assistant's topics), the device's own first. */
export async function listArticlesByTag(db: Db, locale: Locale, tag: string, scope: { deviceModelId?: string | null; platformId?: string | null } = {}): Promise<ArticleSummary[]> {
  const rows = await publicArticleRows(db);
  const ranked: Array<{ rank: number; summary: ArticleSummary }> = [];
  for (const row of rows) {
    if (!(row.tags ?? []).includes(tag)) continue;
    let rank = 3;
    let kind: ArticleSummary["scope"] = row.deviceId ? "device" : "platform";
    if (scope.deviceModelId && row.deviceId === scope.deviceModelId) rank = 0;
    else if (scope.platformId && row.platformId === scope.platformId && row.deviceId === null) rank = 1;
    else if (scope.platformId && row.platformId === scope.platformId) {
      rank = 2;
      kind = "related";
    } else if (scope.platformId) continue; // another platform's guide is no help here
    ranked.push({ rank, summary: toSummary(row, locale, kind) });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.summary);
}

/** Approved public articles whose text (any language) contains `needle` — e.g. an error code. Case-insensitive. */
export async function findArticlesMentioning(db: Db, locale: Locale, needle: string): Promise<ArticleSummary[]> {
  const text = needle.trim().toUpperCase();
  if (text.length < 3) return [];
  const rows = await db
    .select(articleColumns)
    .from(knowledgeArticles)
    .leftJoin(deviceModels, eq(knowledgeArticles.deviceModelId, deviceModels.id))
    .leftJoin(platforms, eq(knowledgeArticles.platformId, platforms.id))
    .where(and(isPublic, sql`(instr(upper(${knowledgeArticles.body}), ${text}) > 0 OR instr(upper(${knowledgeArticles.title}), ${text}) > 0)`))
    .orderBy(asc(knowledgeArticles.sort), asc(knowledgeArticles.slug));
  return (rows as ArticleRow[]).map((row) => toSummary(row, locale, row.deviceId ? "device" : "platform"));
}

/** The article page: an approved public article by slug, or null (drafts, internal and unknown slugs alike). */
export async function getArticle(db: Db, locale: Locale, slug: string): Promise<ArticleDetail | null> {
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) return null;
  const row = await db
    .select({ ...articleColumns, body: knowledgeArticles.body })
    .from(knowledgeArticles)
    .leftJoin(deviceModels, eq(knowledgeArticles.deviceModelId, deviceModels.id))
    .leftJoin(platforms, eq(knowledgeArticles.platformId, platforms.id))
    .where(and(isPublic, eq(knowledgeArticles.slug, slug)))
    .get();
  if (!row) return null;
  const body = (row.body ?? { ar: [] }) as LocalizedBlocks;
  const own = body[locale];
  const blocks: unknown[] = Array.isArray(own) && own.length > 0 ? own : Array.isArray(body.ar) ? body.ar : [];
  const art = blocks.find((block): block is { type: "art"; name: string } => typeof block === "object" && block !== null && (block as { type?: unknown }).type === "art" && typeof (block as { name?: unknown }).name === "string");
  return {
    ...toSummary(row as ArticleRow, locale, row.deviceId ? "device" : "platform"),
    blocks,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    artKey: art?.name ?? null,
    fallback: locale !== "ar" && !(Array.isArray(own) && own.length > 0),
  };
}

/** Other approved articles about the same device or platform (for "related guides" under an article). */
export async function listRelatedArticles(db: Db, locale: Locale, article: Pick<ArticleSummary, "id" | "device" | "platform">, limit = 4): Promise<ArticleSummary[]> {
  const rows = await publicArticleRows(db);
  const sameDevice: ArticleSummary[] = [];
  const samePlatform: ArticleSummary[] = [];
  for (const row of rows) {
    if (row.id === article.id) continue;
    if (article.device && row.deviceSlug === article.device.slug) sameDevice.push(toSummary(row, locale, "device"));
    else if (article.platform && row.platformId === article.platform.id) samePlatform.push(toSummary(row, locale, row.deviceId ? "related" : "platform"));
  }
  return [...sameDevice, ...samePlatform].slice(0, limit);
}
