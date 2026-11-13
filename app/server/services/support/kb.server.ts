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
 *   const found  = await searchHelp(db, locale, q, { platform });                 // the help centre's results (?q=)
 *   const index  = await getHelpIndex(db);                                        // what the search box suggests from
 *
 * Bodies are localized block arrays (ARCHITECTURE §6) returned as stored; <Blocks> (app/ui/Blocks) checks every block
 * before rendering and only ever puts strings into text nodes. A missing translation falls back to Arabic and says so
 * (`fallback`).
 *
 * Services take `db` first and never import "cloudflare:workers".
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { LOCALE_CODES, pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { deviceModels, knowledgeArticles, platforms, type LocalizedBlocks } from "~/server/db/schema";
import { rankEntries, type HelpIndexEntry } from "./helpsearch";
import { findErrorCode, findErrorCodes, hasDangerSign } from "./matcher";
import { cleanQuestion } from "./state";
import type { ArticleDetail, ArticleKind, ArticleSummary, HelpSearch, SupportDevice, SupportPlatform, SupportPlatformGroup } from "./types";

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

// ───────────────────────────────────────────────────────────────── help-centre search

/** Every string a block holds, as one text (headings, paragraphs, list items, steps, callouts, table cells). */
function blockText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const parts: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
  };
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    add(b.text);
    add(b.title);
    if (Array.isArray(b.items)) {
      for (const item of b.items) {
        if (typeof item === "string") add(item);
        else if (item && typeof item === "object") {
          add((item as Record<string, unknown>).title);
          add((item as Record<string, unknown>).text);
        }
      }
    }
    if (Array.isArray(b.head)) b.head.forEach(add);
    if (Array.isArray(b.rows)) for (const row of b.rows) if (Array.isArray(row)) row.forEach(add);
  }
  return parts.join(" ");
}

const l10nText = (value: L10n | null | undefined) => (value ? LOCALE_CODES.map((code) => value[code] ?? "").join(" ") : "");

/** Every approved public article with its body, in staff order (the search reads bodies; the index reads their codes). */
async function publicArticlesWithBody(db: Db) {
  return db
    .select({ ...articleColumns, body: knowledgeArticles.body })
    .from(knowledgeArticles)
    .leftJoin(deviceModels, eq(knowledgeArticles.deviceModelId, deviceModels.id))
    .leftJoin(platforms, eq(knowledgeArticles.platformId, platforms.id))
    .where(isPublic)
    .orderBy(asc(knowledgeArticles.sort), asc(knowledgeArticles.slug));
}

type BodyRow = Awaited<ReturnType<typeof publicArticlesWithBody>>[number];

/** The words a guide is found by, in every language (./helpsearch HelpEntryText), without its body. */
function entryText(row: BodyRow) {
  return {
    title: l10nText(row.title as L10n),
    summary: l10nText(row.summary as L10n | null),
    names: `${row.deviceName ? l10nText(row.deviceName as L10n) : ""} ${row.platformName ? l10nText(row.platformName as L10n) : ""}`.trim(),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

/**
 * The help centre's search box: a problem in the shopper's words or an error code (the same routing as the assistant,
 * ./matcher), over the approved public guides only. Returns null for an empty query.
 *   danger   the words carry a danger sign: the page says stop, unplug, book a repair — before any guide
 *   code     an error code: the guides that mention it (possibly none — the page says so honestly)
 *   guides   guides ranked by the words (title 3 · summary and tags 2 · body 1) and by the symptom or topic the words
 *            point to; the staff order breaks ties (./helpsearch rankEntries — the page's suggestions rank alike). At
 *            most 8.
 * `platform` (a platform slug, the box's device chips): only that platform's guides and the guides about every device.
 */
export async function searchHelp(db: Db, locale: Locale, raw: unknown, options: { platform?: string | null } = {}): Promise<HelpSearch | null> {
  const query = typeof raw === "string" ? cleanQuestion(raw) : null;
  if (!query) return null;
  const platform = options.platform ?? null;
  const inScope = (article: ArticleSummary) => !platform || article.platform === null || article.platform.slug === platform;
  if (hasDangerSign(query)) return { query, kind: "danger", code: null, articles: [], platform };
  const code = findErrorCode(query);
  if (code) return { query, kind: "code", code, articles: (await findArticlesMentioning(db, locale, code)).filter(inScope), platform };

  const rows = await publicArticlesWithBody(db);
  const entries = rows
    .map((row) => {
      const body = (row.body ?? {}) as LocalizedBlocks;
      return { ...entryText(row), body: `${blockText(body[locale])} ${locale === "ar" ? "" : blockText(body.ar)}`, article: toSummary(row as ArticleRow, locale, row.deviceId ? "device" : "platform") };
    })
    // ranked within the chosen platform (a body-only match is weighed against that platform's best, not another's)
    .filter((entry) => inScope(entry.article));
  return { query, kind: "guides", code: null, articles: rankEntries(entries, query).slice(0, 8).map((entry) => entry.article), platform };
}

/**
 * The index the help centre's search box suggests from while the shopper types (./helpsearch suggestHelp): every
 * approved public guide's title, summary and device / platform names in every language, its tags, its platform and
 * the error codes its text names — never its body. Small (a few hundred bytes a guide); staff order.
 */
export async function getHelpIndex(db: Db): Promise<HelpIndexEntry[]> {
  const rows = await publicArticlesWithBody(db);
  return rows.map((row) => {
    const body = (row.body ?? {}) as LocalizedBlocks;
    const text = entryText(row);
    const everyText = `${text.title} ${LOCALE_CODES.map((code) => blockText(body[code])).join(" ")}`;
    return { slug: row.slug, platform: row.platformSlug ?? null, ...text, codes: findErrorCodes(everyText) };
  });
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
