/**
 * Admin module 17 (content) — what its services share: the error keys, input helpers (the catalogue module's, so a
 * localized text or a reason is read the same way everywhere), who may open which section, and the two checks that
 * keep content honest about the catalogue:
 *
 *   productReadiness(db, productId, at)   would the catalogue (module 02) show this product at `at`? A schedule or a
 *                                         pin never puts a product forward that the catalogue would refuse: it must
 *                                         be published with an active variant, or scheduled to publish by then AND
 *                                         complete by the catalogue's own rules (productCompleteness — the publish
 *                                         job sends an incomplete one back to draft) — content never changes a
 *                                         product's status
 *   checkStoreLink(db, path, now)         what a storefront path opens today: a live product, category, platform,
 *                                         device hub, policy, landing page, a fixed page — or nothing
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { L10n } from "~/lib/locales";
import { can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { AppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { productCompleteness } from "../catalog/common.server";
import { isLive } from "../catalog/rules";
import { LANDING_PATH_PREFIX, normalizeStorePath } from "./rules";

export { parseInput, zBool, zId, zL10nRequired, zReason, zRequiredText, zText } from "../catalog/common.server";

const blankToUndefined = (value: unknown) => (typeof value === "string" && value.trim() === "" ? undefined : value);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max, "too_long").optional());

/**
 * An optional text in ar/en/ckb from a form: null when nothing is written; Arabic is the source, so an English or
 * Sorani text without the Arabic one is refused (`ar: required`) instead of being dropped without a word.
 */
export function zL10n(max: number, required: boolean) {
  const object = z.object({ ar: required ? z.string({ error: "required" }).trim().min(1, "required").max(max, "too_long") : optionalText(max), en: optionalText(max), ckb: optionalText(max) });
  return z
    .preprocess((value) => (value === null ? undefined : value), object.optional())
    .superRefine((value, context) => {
      if (value && !value.ar && (value.en || value.ckb)) context.addIssue({ code: "custom", path: ["ar"], message: "required" });
    })
    .transform((value): L10n | null => {
      if (!value || !value.ar) return null;
      const out: L10n = { ar: value.ar };
      if (value.en) out.en = value.en;
      if (value.ckb) out.ckb = value.ckb;
      return out;
    });
}

/** Error keys this module's services throw (texts: admin-cms → errors.<key>; generic keys come from "errors"). */
export const CMS_ERROR_KEYS = [
  "content_changed",
  "banner_not_found",
  "banner_not_publishable",
  "page_not_found",
  "page_in_settings",
  "page_slug_taken",
  "page_slug_reserved",
  "page_no_draft",
  "page_empty",
  "page_live_schedule",
  "page_not_live",
  "pin_not_found",
  "pin_overlap",
  "pin_window",
  "pin_platform",
  "pin_photo",
  "pin_no_changes",
  "product_unknown",
  "product_not_ready",
  "schedule_past",
  "schedule_order",
  "schedule_far",
  "link_invalid",
  "link_reserved",
  "link_missing",
  "art_unknown",
  "category_unknown",
  "redirect_self",
  "redirect_from_taken",
  "redirect_loop",
  "redirect_chain_target",
  "redirect_chain_source",
  "redirect_target_missing",
  "path_invalid",
  "path_reserved",
  "path_external",
  "path_query",
  "path_home",
  "synonym_term_taken",
  "synonym_empty",
  "synonym_same",
  "synonym_too_many",
  "nav_featured_max",
  "nav_unknown_entry",
  "seo_not_found",
  "nothing_changed",
  "preview_invalid",
  "preview_secret",
] as const;
export type CmsErrorKey = (typeof CMS_ERROR_KEYS)[number];

export function cmsError(code: CmsErrorKey, status = 409, options: { fields?: Record<string, string>; detail?: string } = {}): AppError {
  return new AppError(code, status, options);
}

/** The employee's id for `updated_by` / `created_by` columns (null for the system). */
export function actorIdOf(actor: Actor): string | null {
  return actor.kind === "employee" || actor.kind === "customer" ? actor.id : null;
}

// ───────────────────────────────────────────────────────────────── who may open what

/** The module's sections and the permission each one needs (pages: editing or approving). */
export const SECTION_PERMISSIONS = {
  home: ["cms.home.manage"],
  banners: ["cms.banner.manage"],
  pages: ["cms.page.manage", "cms.page.publish"],
  schedule: ["cms.banner.manage", "cms.home.manage", "cms.page.manage", "cms.page.publish"],
  navigation: ["cms.navigation.manage"],
  search: ["cms.search.manage"],
  seo: ["cms.seo.manage"],
  redirects: ["cms.redirect.manage"],
} as const satisfies Record<string, readonly Permission[]>;
export type CmsSection = keyof typeof SECTION_PERMISSIONS;
export const CMS_SECTIONS = Object.keys(SECTION_PERMISSIONS) as CmsSection[];

export type CmsAccess = Record<CmsSection, boolean> & { publishPages: boolean };

export function cmsAccess(actor: Actor): CmsAccess {
  const out = { publishPages: can(actor, "cms.page.publish") } as CmsAccess;
  for (const section of CMS_SECTIONS) out[section] = canAny(actor, SECTION_PERMISSIONS[section]);
  return out;
}

// ───────────────────────────────────────────────────────────────── the catalogue's word on a product

export type ProductReadiness =
  | { ok: true; productId: string; slug: string; name: Record<string, string>; liveAt: number | null }
  | { ok: false; productId: string; reason: "unknown" | "not_published" | "scheduled_later" | "incomplete"; missing: string[]; slug?: string; publishAt?: number | null };

type ProductRow = { id: string; slug: string; name: string; status: string; publish_at: number | null };

/**
 * Whether the catalogue shows this product at `at` (a schedule's start, or now): published, or scheduled to publish
 * at or before `at` — and complete by the catalogue's rules then as now (an incomplete scheduled product goes back to
 * draft when its time comes, publishDueProducts). Archived, draft, review and hidden products are refused.
 */
export async function productReadiness(db: Db, productId: string, at: number): Promise<ProductReadiness> {
  const rows = await db.all<ProductRow>(sql`SELECT id, slug, name, status, publish_at FROM products WHERE id = ${productId} LIMIT 1`);
  const row = rows[0];
  if (!row) return { ok: false, productId, reason: "unknown", missing: [] };
  const name = (() => {
    try {
      return JSON.parse(row.name) as Record<string, string>;
    } catch {
      return { ar: row.slug };
    }
  })();
  const live = isLive({ status: row.status, publishAt: row.publish_at }, at);
  if (!live) {
    const reason = row.status === "scheduled" ? "scheduled_later" : "not_published";
    return { ok: false, productId, reason, missing: [], slug: row.slug, publishAt: row.publish_at };
  }
  // the storefront lists a product only with an active variant (else its page answers 404)
  const active = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM variants WHERE product_id = ${productId} AND is_active = 1`);
  if (Number(active[0]?.n ?? 0) === 0) return { ok: false, productId, reason: "not_published", missing: ["variants"], slug: row.slug };
  // a product still to be published by the job must pass the catalogue's completeness then (publishDueProducts
  // sends an incomplete one back to draft); one already published is on the store as it is
  if (row.status === "scheduled") {
    const result = await productCompleteness(db, productId);
    if (!result || !result.completeness.complete) {
      return { ok: false, productId, reason: "incomplete", missing: result ? [...result.completeness.missing, ...result.completeness.missingCustom] : [], slug: row.slug };
    }
  }
  return { ok: true, productId, slug: row.slug, name, liveAt: row.status === "scheduled" ? row.publish_at : null };
}

/** Throws `product_not_ready` (with the reason as detail) unless the catalogue shows the product at `at`. */
export async function assertProductReady(db: Db, productId: string, at: number, field = "productId"): Promise<Extract<ProductReadiness, { ok: true }>> {
  const readiness = await productReadiness(db, productId, at);
  if (readiness.ok) return readiness;
  if (readiness.reason === "unknown") throw cmsError("product_unknown", 404, { fields: { [field]: "product_unknown" } });
  throw cmsError("product_not_ready", 409, { fields: { [field]: `product_${readiness.reason}` }, detail: readiness.reason });
}

// ───────────────────────────────────────────────────────────────── links

export type LinkState = "ok" | "missing" | "not_live" | "unchecked" | "external" | "pending_route";
export type LinkCheck = { state: LinkState; kind: string | null; path: string | null };

/** Fixed storefront pages that always exist (routes of the storefront areas). */
const STATIC_PATHS = new Set(["/", "/used", "/trade-in", "/support", "/policies", "/about", "/contact", "/accessibility", "/search", "/cart", "/wishlist", "/track", "/compare"]);

/**
 * What a link opens on the storefront today. Products: published (or scheduled and due) with an active variant;
 * categories and platforms: active; device hubs: published; policies: the six known ones or a published CMS
 * policy; landing pages: published — `pending_route` while the storefront has no route for them yet. Other internal
 * paths are `unchecked`, external https links `external`.
 */
export async function checkStoreLink(db: Db, raw: string, now: number): Promise<LinkCheck> {
  if (/^https?:\/\//i.test(raw.trim())) return { state: "external", kind: "external", path: null };
  const parsed = normalizeStorePath(raw, { query: true });
  if (!parsed.ok) return { state: "missing", kind: null, path: null };
  const path = parsed.path;
  if (STATIC_PATHS.has(path)) return { state: "ok", kind: "page", path };
  const [first, second, ...rest] = path.split("/").filter(Boolean);
  if (!second || rest.length > 0) return { state: "unchecked", kind: null, path };
  const one = async (query: ReturnType<typeof sql>) => Number((await db.all<{ n: number }>(query))[0]?.n ?? 0) > 0;
  switch (first) {
    case "p": {
      const rows = await db.all<{ status: string; publish_at: number | null; active: number }>(
        sql`SELECT p.status, p.publish_at, (SELECT COUNT(*) FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) AS active FROM products p WHERE p.slug = ${second} LIMIT 1`,
      );
      const row = rows[0];
      if (!row) return { state: "missing", kind: "product", path };
      return { state: isLive({ status: row.status, publishAt: row.publish_at }, now) && Number(row.active) > 0 ? "ok" : "not_live", kind: "product", path };
    }
    case "c": {
      const rows = await db.all<{ is_active: number }>(sql`SELECT is_active FROM categories WHERE slug = ${second} LIMIT 1`);
      if (!rows[0]) return { state: "missing", kind: "category", path };
      return { state: Number(rows[0].is_active) === 1 ? "ok" : "not_live", kind: "category", path };
    }
    case "platform": {
      const rows = await db.all<{ is_active: number }>(sql`SELECT is_active FROM platforms WHERE slug = ${second} LIMIT 1`);
      if (!rows[0]) return { state: "missing", kind: "platform", path };
      return { state: Number(rows[0].is_active) === 1 ? "ok" : "not_live", kind: "platform", path };
    }
    case "device": {
      const rows = await db.all<{ status: string }>(sql`SELECT status FROM device_models WHERE slug = ${second} LIMIT 1`);
      if (!rows[0]) return { state: "missing", kind: "device", path };
      return { state: rows[0].status === "published" ? "ok" : "not_live", kind: "device", path };
    }
    case "policies": {
      if (["shipping", "returns", "warranty", "payment", "privacy", "terms"].includes(second)) return { state: "ok", kind: "policy", path };
      const live = await one(sql`SELECT COUNT(*) AS n FROM pages WHERE kind = 'policy' AND slug = ${second} AND is_demo = 0 AND status = 'published'`);
      return { state: live ? "ok" : "missing", kind: "policy", path };
    }
    case LANDING_PATH_PREFIX.slice(1): {
      const live = await one(
        sql`SELECT COUNT(*) AS n FROM pages WHERE kind = 'landing' AND slug = ${second} AND is_demo = 0 AND status IN ('published', 'scheduled') AND (starts_at IS NULL OR starts_at <= ${now}) AND (ends_at IS NULL OR ends_at > ${now})`,
      );
      return { state: live ? "pending_route" : "missing", kind: "landing", path };
    }
    default:
      return { state: "unchecked", kind: null, path };
  }
}

/** The product a storefront link opens ("/p/<slug>"), for the schedule's catalogue check. */
export async function productIdOfLink(db: Db, raw: string): Promise<string | null> {
  const parsed = normalizeStorePath(raw, { query: true });
  if (!parsed.ok) return null;
  const match = /^\/p\/([^/]+)$/.exec(parsed.path);
  if (!match) return null;
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM products WHERE slug = ${match[1]} LIMIT 1`);
  return rows[0]?.id ?? null;
}

// ───────────────────────────────────────────────────────────────── small readers

export function parseJsonText<T>(text: unknown): T | null {
  if (typeof text !== "string" || text === "") return typeof text === "object" && text !== null ? (text as T) : null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];
