/**
 * cms — banners, home page sections, pages and policies, redirects, navigation menus, storefront
 * filters and translation overrides (admin modules 17 and 22).
 *
 * Page bodies are localized block arrays (never HTML/Markdown). Everything publishable has a
 * `draft` side so staff can preview on phone and desktop before publishing (17.06), and optional
 * `starts_at` / `ends_at` for seasonal scheduling (17.02).
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { L10n } from "~/lib/locales";
import { NOW_MS, at, flag, id, json, l10n, type LocalizedBlocks, type Ref } from "../columns";
import { categories, type SeoMeta } from "./catalog";
import { files } from "./core";

export const PUBLISH_STATUSES = ["draft", "scheduled", "published", "archived"] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

/** Promotional banners. `placement` names a slot in the storefront ("home_hero", "home_strip", "category_top", "cart"…). */
export const banners = sqliteTable(
  "banners",
  {
    id: id(),
    placement: text("placement").notNull(),
    title: l10n("title").notNull(),
    subtitle: l10n("subtitle"),
    ctaLabel: l10n("cta_label"),
    /** Locale-less storefront path, or an absolute URL. */
    link: text("link"),
    /** Clay render key, or an uploaded image. */
    artKey: text("art_key"),
    fileId: text("file_id").references((): Ref => files.id),
    /** Accent token, e.g. "brand", "playstation". */
    accent: text("accent"),
    sort: integer("sort").notNull().default(0),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    status: text("status", { enum: PUBLISH_STATUSES }).notNull().default("draft"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [index("banners_placement_idx").on(t.placement, t.status, t.sort), index("banners_file_idx").on(t.fileId)],
);
export type Banner = typeof banners.$inferSelect;
export type NewBanner = typeof banners.$inferInsert;

/**
 * Ordered sections of the home page. `kind` picks the component ("hero", "platforms", "rail",
 * "banner", "deals", "used_spotlight", "recently_viewed", "recommendations", "content");
 * `config` feeds it. `draft_config` holds unpublished edits.
 */
export const homeSections = sqliteTable(
  "home_sections",
  {
    id: id(),
    kind: text("kind").notNull(),
    title: l10n("title"),
    config: json<Record<string, unknown>>("config"),
    draftConfig: json<Record<string, unknown>>("draft_config"),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    isDemo: flag("is_demo").notNull().default(false),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [index("home_sections_sort_idx").on(t.isActive, t.sort)],
);
export type HomeSection = typeof homeSections.$inferSelect;
export type NewHomeSection = typeof homeSections.$inferInsert;

export const PAGE_KINDS = ["policy", "about", "contact", "landing", "custom"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

/** Policies (/policies/:slug), about, contact and landing pages. `draft` is the unpublished body. */
export const pages = sqliteTable(
  "pages",
  {
    id: id(),
    slug: text("slug").notNull(),
    kind: text("kind", { enum: PAGE_KINDS }).notNull().default("custom"),
    title: l10n("title").notNull(),
    body: json<LocalizedBlocks>("body"),
    draft: json<LocalizedBlocks>("draft"),
    seo: json<SeoMeta>("seo"),
    status: text("status", { enum: PUBLISH_STATUSES }).notNull().default("draft"),
    publishedAt: at("published_at"),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    isDemo: flag("is_demo").notNull().default(false),
    updatedBy: text("updated_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("pages_slug_uq").on(t.slug), index("pages_kind_idx").on(t.kind, t.status)],
);
export type Page = typeof pages.$inferSelect;
export type NewPage = typeof pages.$inferInsert;

/** 301/302 redirects managed by staff (17.04). `from_path` is a locale-less path. */
export const redirects = sqliteTable(
  "redirects",
  {
    id: id(),
    fromPath: text("from_path").notNull(),
    toPath: text("to_path").notNull(),
    code: integer("code").notNull().default(301),
    isActive: flag("is_active").notNull().default(true),
    hits: integer("hits").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("redirects_from_path_uq").on(t.fromPath),
    check("redirects_code_check", sql`${t.code} IN (301, 302, 307, 308) AND ${t.fromPath} <> ${t.toPath}`),
  ],
);
export type Redirect = typeof redirects.$inferSelect;
export type NewRedirect = typeof redirects.$inferInsert;

export type NavItem = { label: L10n; link: string; icon?: string; artKey?: string; children?: NavItem[] };

/** Navigation menus by key ("header", "mega", "footer", "mobile_tabs"). */
export const navMenus = sqliteTable(
  "nav_menus",
  {
    id: id(),
    key: text("key").notNull(),
    items: json<NavItem[]>("items").notNull(),
    draftItems: json<NavItem[]>("draft_items"),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("nav_menus_key_uq").on(t.key)],
);
export type NavMenu = typeof navMenus.$inferSelect;
export type NewNavMenu = typeof navMenus.$inferInsert;

/**
 * Which filters a category page offers and in what order (17.03).
 * `source` says where values come from: "price", "brand", "platform", "device_model", "condition",
 * "spec:<key>" or "attribute:<custom field key>". `category_id IS NULL` = default for all categories.
 */
export const catalogFilters = sqliteTable(
  "catalog_filters",
  {
    id: id(),
    categoryId: text("category_id").references((): Ref => categories.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: l10n("label").notNull(),
    source: text("source").notNull(),
    /** "checkbox" | "range" | "toggle" | "swatch" */
    widget: text("widget").notNull().default("checkbox"),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [index("catalog_filters_category_idx").on(t.categoryId, t.isActive, t.sort)],
);
export type CatalogFilter = typeof catalogFilters.$inferSelect;
export type NewCatalogFilter = typeof catalogFilters.$inferInsert;

/**
 * Staff corrections to interface text (22.05). The source of truth stays in
 * app/i18n/messages/<namespace>.ts; a row here overrides one key in one locale.
 */
export const translationOverrides = sqliteTable(
  "translation_overrides",
  {
    namespace: text("namespace").notNull(),
    key: text("key").notNull(),
    locale: text("locale").notNull(),
    value: text("value").notNull(),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.namespace, t.key, t.locale] })],
);
export type TranslationOverride = typeof translationOverrides.$inferSelect;
export type NewTranslationOverride = typeof translationOverrides.$inferInsert;
