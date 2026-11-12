/**
 * Admin 17.04 — search-engine titles and descriptions of products, categories and the store's pages.
 *
 * What a search engine is given is exactly what the storefront renders: a product page's title is its SEO title or
 * its name, its description the SEO description or the start of its description (product.tsx); a category page uses
 * its name and a sentence of its own (the category page does not read `categories.seo` yet — a request to the
 * catalogue area; the sitemap already honours its `noindex`); a page's SEO description is its summary
 * (content.server). The list shows those resolved values and their issues (missing, too long or short, a title
 * another page also uses, kept out of search engines).
 *
 *   listSeo(db, actor, parseSeoFilters(url.searchParams), locale)
 *   getSeoEditor(db, actor, type, id, locale) · saveSeo(db, actor, raw, now)                cms.seo.manage
 *
 * Writes: a PRODUCT's SEO goes through the catalogue's own write path (commitStatements: version guard → the form's
 * product version, an append-only version snapshot, the audit event, the search rows last — CONTRACTS §4 02); a
 * CATEGORY's is guarded on the SEO text the form saw (the table has no version); a PAGE's SEO belongs to its draft and
 * is approved with it (the page editor), so it is not written here.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { categories, products, type Product, type SeoMeta } from "~/server/db/schema";
import { expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { baselines, commitStatements, rethrowCatalog, requireProductState } from "../catalog/common.server";
import { PAGE_SIZE, SEO_ENTITY_TYPES, SEO_ISSUES, SEO_LIMITS, oneOf, pageOf, queryText, seoIssues, storePathOfPage, type SeoEntityType, type SeoIssue } from "./rules";
import { cmsError, parseInput, parseJsonText, zL10n, zReason } from "./shared.server";

export type SeoFilters = { type: SeoEntityType | null; issue: SeoIssue | null; q: string; page: number };

export function parseSeoFilters(params: URLSearchParams): SeoFilters {
  return { type: oneOf(params.get("type"), SEO_ENTITY_TYPES, null), issue: oneOf(params.get("issue"), SEO_ISSUES, null), q: queryText(params.get("q")), page: pageOf(params.get("page")) };
}

export type SeoRow = {
  type: SeoEntityType;
  id: string;
  name: string;
  path: string;
  /** The title and description a search engine gets now (Arabic), and whether they are written or taken over. */
  title: string;
  titleWritten: boolean;
  description: string | null;
  descriptionWritten: boolean;
  noindex: boolean;
  issues: SeoIssue[];
  status: string;
};

export type SeoList = { rows: SeoRow[]; total: number; page: number; pageCount: number; counts: Record<SeoIssue | "all", number> };

type ProductSeoRow = { id: string; slug: string; name: string; description: string | null; short: string | null; seo: string | null; status: string };
type CategorySeoRow = { id: string; slug: string; name: string; seo: string | null; is_active: number };
type PageSeoRow = { id: string; slug: string; kind: string; title: string; seo: string | null; status: string };

const ar = (value: L10n | null | undefined) => value?.ar?.trim() || "";

/** The storefront's cut of a description (product.tsx): 160 characters at a word boundary. */
function autoDescription(text: string): string {
  if (text.length <= SEO_LIMITS.descriptionIdeal) return text;
  const cut = text.slice(0, SEO_LIMITS.descriptionIdeal);
  const space = cut.lastIndexOf(" ");
  return `${(space > 80 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Every product (not archived), active category and stored page, with what search engines get and its issues. */
export async function listSeo(db: Db, actor: Actor, filters: SeoFilters, locale: Locale): Promise<SeoList> {
  assertCan(actor, "cms.seo.manage");
  const [productRows, categoryRows, pageRows] = await Promise.all([
    db.all<ProductSeoRow>(sql`SELECT id, slug, name, description, short, seo, status FROM products WHERE status <> 'archived' ORDER BY updated_at DESC, id`),
    db.all<CategorySeoRow>(sql`SELECT id, slug, name, seo, is_active FROM categories WHERE is_active = 1 ORDER BY sort, id`),
    db.all<PageSeoRow>(sql`SELECT id, slug, kind, title, seo, status FROM pages WHERE status IN ('published', 'scheduled', 'draft') ORDER BY kind, slug`),
  ]);
  const rows: SeoRow[] = [];
  for (const row of productRows) {
    const name = parseJsonText<L10n>(row.name);
    const seo = parseJsonText<SeoMeta>(row.seo);
    const written = ar(seo?.description);
    const fallback = ar(parseJsonText<L10n>(row.description)) || ar(parseJsonText<L10n>(row.short));
    rows.push({
      type: "product",
      id: row.id,
      name: pick(name, locale) || row.slug,
      path: `/p/${row.slug}`,
      title: ar(seo?.title) || ar(name),
      titleWritten: Boolean(ar(seo?.title)),
      description: written || (fallback ? autoDescription(fallback) : null),
      descriptionWritten: Boolean(written),
      noindex: seo?.noindex === true,
      issues: [],
      status: row.status,
    });
  }
  for (const row of categoryRows) {
    const name = parseJsonText<L10n>(row.name);
    const seo = parseJsonText<SeoMeta>(row.seo);
    rows.push({
      type: "category",
      id: row.id,
      name: pick(name, locale) || row.slug,
      path: `/c/${row.slug}`,
      title: ar(seo?.title) || ar(name),
      titleWritten: Boolean(ar(seo?.title)),
      description: ar(seo?.description) || null,
      descriptionWritten: Boolean(ar(seo?.description)),
      noindex: seo?.noindex === true,
      issues: [],
      status: "active",
    });
  }
  for (const row of pageRows) {
    const title = parseJsonText<L10n>(row.title);
    const seo = parseJsonText<SeoMeta>(row.seo);
    rows.push({
      type: "page",
      id: row.slug,
      name: pick(title, locale) || row.slug,
      path: storePathOfPage(row.kind, row.slug),
      title: ar(title),
      titleWritten: true,
      description: ar(seo?.description) || null,
      descriptionWritten: Boolean(ar(seo?.description)),
      noindex: seo?.noindex === true,
      issues: [],
      status: row.status,
    });
  }
  // issues, and titles more than one entry uses (a search engine shows them as the same page)
  const titleCount = new Map<string, number>();
  for (const row of rows) if (row.title) titleCount.set(row.title, (titleCount.get(row.title) ?? 0) + 1);
  for (const row of rows) {
    row.issues = seoIssues({ title: row.title, description: row.description, noindex: row.noindex });
    if (row.title && (titleCount.get(row.title) ?? 0) > 1) row.issues.splice(1, 0, "duplicate_title");
  }
  // each issue chip counts what the type and words filters keep: its count is the list it opens (review 2026-11-12);
  // duplicates above are still found across every entry
  const needle = filters.q.toLowerCase();
  const matching = rows.filter((row) => (!filters.type || row.type === filters.type) && (!needle || `${row.name} ${row.path} ${row.title}`.toLowerCase().includes(needle)));
  const counts = Object.fromEntries([["all", matching.length], ...SEO_ISSUES.map((issue) => [issue, 0])]) as Record<SeoIssue | "all", number>;
  for (const row of matching) for (const issue of row.issues) counts[issue]++;
  const filtered = matching.filter((row) => !filters.issue || row.issues.includes(filters.issue));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  return { rows: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: filtered.length, page, pageCount, counts };
}

export type SeoEditor = {
  type: "product" | "category";
  id: string;
  name: L10n;
  path: string;
  seo: { title: L10n | null; description: L10n | null; noindex: boolean };
  /** What search engines get when a field is left empty. */
  fallback: { title: L10n; description: L10n | null };
  /** Product: its version; category: the stored SEO text (the guard). */
  version: string;
  status: string;
};

export async function getSeoEditor(db: Db, actor: Actor, type: string, id: string): Promise<SeoEditor> {
  assertCan(actor, "cms.seo.manage");
  if (type === "product") {
    const row = await db.select().from(products).where(eq(products.id, id)).get();
    if (!row) throw cmsError("seo_not_found", 404);
    const seo = (row.seo ?? null) as SeoMeta | null;
    const description: L10n | null = row.description ?? row.short ?? null;
    return {
      type,
      id,
      name: row.name,
      path: `/p/${row.slug}`,
      seo: { title: seo?.title ?? null, description: seo?.description ?? null, noindex: seo?.noindex === true },
      fallback: { title: row.name, description: description ? (Object.fromEntries(Object.entries(description).map(([code, text]) => [code, autoDescription(String(text ?? ""))])) as L10n) : null },
      version: String(row.version),
      status: row.status,
    };
  }
  if (type === "category") {
    const row = await db.select().from(categories).where(eq(categories.id, id)).get();
    if (!row) throw cmsError("seo_not_found", 404);
    const seo = (row.seo ?? null) as SeoMeta | null;
    return {
      type,
      id,
      name: row.name,
      path: `/c/${row.slug}`,
      seo: { title: seo?.title ?? null, description: seo?.description ?? null, noindex: seo?.noindex === true },
      fallback: { title: row.name, description: null },
      version: JSON.stringify(row.seo ?? null),
      status: row.isActive ? "active" : "inactive",
    };
  }
  throw notFound("seo");
}

const SaveInput = z.object({
  type: z.enum(["product", "category"], { error: "invalid" }),
  id: z.string().trim().min(1).max(128),
  version: z.string().max(4000),
  title: zL10n(SEO_LIMITS.titleMax, false),
  description: zL10n(SEO_LIMITS.descriptionMax, false),
  noindex: z.preprocess((value) => value === true || value === "on" || value === "true" || value === "1", z.boolean()),
  reason: zReason(false),
});

/** The new SEO object: written fields replace, empty ones are removed; other keys (image, canonical) are kept. */
function nextSeo(previous: SeoMeta | null, input: { title: L10n | null; description: L10n | null; noindex: boolean }): SeoMeta | null {
  const seo: SeoMeta = { ...(previous ?? {}) };
  if (input.title) seo.title = input.title;
  else delete seo.title;
  if (input.description) seo.description = input.description;
  else delete seo.description;
  if (input.noindex) seo.noindex = true;
  else delete seo.noindex;
  return Object.keys(seo).length > 0 ? seo : null;
}

/** Saves a product's or a category's SEO (see the file header for each write path). */
export async function saveSeo(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ saved: boolean }> {
  assertCan(actor, "cms.seo.manage");
  const input = parseInput(SaveInput, raw);
  if (input.noindex && !input.reason) throw invalid({ reason: "reason_required" });
  if (input.type === "product") {
    const state = await requireProductState(db, input.id);
    if (String(state.product.version) !== input.version) throw cmsError("content_changed", 409);
    const seo = nextSeo(state.product.seo, input);
    if (JSON.stringify(seo) === JSON.stringify(state.product.seo ?? null)) return { saved: false };
    const next: Product = { ...state.product, seo };
    const hasBaseline = (await baselines(db, [state.product])).has(state.product.id);
    const plan = commitStatements(db, { actor, now, before: state, after: { product: next, variants: state.variants }, action: "cms.seo.product", reason: input.reason ?? null, summary: `${state.product.slug}: SEO`, hasBaseline });
    await runBatch(db, [...plan.statements, ...plan.search]).catch((error) => {
      try {
        rethrowCatalog(error);
      } catch (mapped) {
        if ((mapped as { code?: string }).code === "product_changed") throw cmsError("content_changed", 409);
        throw mapped;
      }
    });
    return { saved: true };
  }
  const row = await db.select().from(categories).where(eq(categories.id, input.id)).get();
  if (!row) throw cmsError("seo_not_found", 404);
  if (JSON.stringify(row.seo ?? null) !== input.version) throw cmsError("content_changed", 409);
  const seo = nextSeo(row.seo, input);
  if (JSON.stringify(seo) === JSON.stringify(row.seo ?? null)) return { saved: false };
  const stored = row.seo === null ? sql`${categories.seo} IS NULL` : sql`${categories.seo} = ${JSON.stringify(row.seo)}`;
  await runBatch(db, [
    expectThat(db, sql`EXISTS (SELECT 1 FROM categories WHERE id = ${row.id} AND ${row.seo === null ? sql`seo IS NULL` : sql`seo = ${JSON.stringify(row.seo)}`})`, { code: "CONTENT_CHANGED", detail: row.id }),
    db.update(categories).set({ seo }).where(and(eq(categories.id, row.id), stored)),
    auditStatement(db, { actor, action: "cms.seo.category", entityType: "category", entityId: row.id, before: row.seo ?? null, after: seo, reason: input.reason ?? null, at: now }),
  ]).catch((error) => {
    if (mapDbError(error)?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
    throw error;
  });
  return { saved: true };
}

/** Products and categories whose resolved title another one also uses (for the editor's warning). */
export async function sameTitleCount(db: Db, type: "product" | "category", id: string, titleAr: string): Promise<number> {
  if (!titleAr) return 0;
  const productHits = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM products WHERE status <> 'archived' AND NOT (${type === "product" ? sql`id = ${id}` : sql`0`}) AND COALESCE(json_extract(seo, '$.title.ar'), json_extract(name, '$.ar')) = ${titleAr}`);
  const categoryHits = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM categories WHERE is_active = 1 AND NOT (${type === "category" ? sql`id = ${id}` : sql`0`}) AND COALESCE(json_extract(seo, '$.title.ar'), json_extract(name, '$.ar')) = ${titleAr}`);
  return Number(productHits[0]?.n ?? 0) + Number(categoryHits[0]?.n ?? 0);
}
