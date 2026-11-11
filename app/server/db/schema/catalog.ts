/**
 * catalog — platforms, device knowledge graph, categories, products, variants, pricing,
 * media, bundles, relations, compatibility and reviews (admin modules 02, 03 and part of 13/16/17).
 *
 * [P] = protected cost data: only selected by services after can(actor, "cost.read").
 * [A] = append-only (triggers in drizzle/0001_invariants.sql).
 *
 * Compatibility is explicit: a missing rule means "unverified", never "compatible".
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { CompatibilityStatus as CompatibilityStatusDto, ProductKind as ProductKindDto } from "~/lib/dto";
import type { L10n } from "~/lib/locales";
import { DEVICE_KINDS, NOW_MS, PRODUCT_KINDS, PRODUCT_KIND_SCOPES, at, flag, id, iqd, json, l10n, type DeviceKind, type ProductKind, type ProductKindScope, type Ref, type Same } from "../columns";
import { orderItems } from "./commerce";
import { files } from "./core";
import { customers } from "./customers";

/** A specification value: plain, numeric, yes/no, or localized text. */
export type SpecValue = string | number | boolean | L10n;
/** Flat spec sheet keyed by stable spec keys (e.g. `storage_gb`, `display_in`) so devices can be compared. */
export type Specs = Record<string, SpecValue>;
export type SeoMeta = { title?: L10n; description?: L10n; image?: string; noindex?: boolean; canonical?: string };

// ───────────────────────────────────────────────────────────────── device knowledge graph

export const platforms = sqliteTable(
  "platforms",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: l10n("name").notNull(),
    /** Design-token name of the platform accent (e.g. "nintendo", "playstation"); "brand" = TamTam red. */
    accent: text("accent").notNull().default("brand"),
    sort: integer("sort").notNull().default(0),
    artKey: text("art_key"),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("platforms_slug_uq").on(t.slug), index("platforms_sort_idx").on(t.sort)],
);
export type Platform = typeof platforms.$inferSelect;
export type NewPlatform = typeof platforms.$inferInsert;

export const deviceGenerations = sqliteTable(
  "device_generations",
  {
    id: id(),
    platformId: text("platform_id")
      .notNull()
      .references((): Ref => platforms.id),
    slug: text("slug").notNull(),
    name: l10n("name").notNull(),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [uniqueIndex("device_generations_slug_uq").on(t.slug), index("device_generations_platform_idx").on(t.platformId, t.sort)],
);
export type DeviceGeneration = typeof deviceGenerations.$inferSelect;
export type NewDeviceGeneration = typeof deviceGenerations.$inferInsert;

export const DEVICE_MODEL_STATUSES = ["draft", "published", "archived"] as const;
export type DeviceModelStatus = (typeof DEVICE_MODEL_STATUSES)[number];
// DEVICE_KINDS / PRODUCT_KINDS are defined in ../columns (see the note there) and re-exported here.
export { DEVICE_KINDS, PRODUCT_KINDS, PRODUCT_KIND_SCOPES, type DeviceKind, type ProductKind, type ProductKindScope };

/** A device the store knows about — the anchor of each "everything about this device" hub. */
export const deviceModels = sqliteTable(
  "device_models",
  {
    id: id(),
    platformId: text("platform_id")
      .notNull()
      .references((): Ref => platforms.id),
    generationId: text("generation_id").references((): Ref => deviceGenerations.id),
    slug: text("slug").notNull(),
    name: l10n("name").notNull(),
    summary: l10n("summary"),
    specs: json<Specs>("specs"),
    /** Calendar date "YYYY-MM-DD" (or "YYYY" when only the year is known). */
    releasedOn: text("released_on"),
    status: text("status", { enum: DEVICE_MODEL_STATUSES }).notNull().default("draft"),
    deviceKind: text("device_kind", { enum: DEVICE_KINDS }).notNull().default("console"),
    artKey: text("art_key"),
    sort: integer("sort").notNull().default(0),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("device_models_slug_uq").on(t.slug),
    index("device_models_platform_idx").on(t.platformId, t.sort),
    index("device_models_generation_idx").on(t.generationId),
    index("device_models_status_idx").on(t.status),
  ],
);
export type DeviceModel = typeof deviceModels.$inferSelect;
export type NewDeviceModel = typeof deviceModels.$inferInsert;

// ───────────────────────────────────────────────────────────────── categories

export const categories = sqliteTable(
  "categories",
  {
    id: id(),
    parentId: text("parent_id").references((): Ref => categories.id),
    slug: text("slug").notNull(),
    name: l10n("name").notNull(),
    /** Grouping hint for navigation and filters (open vocabulary, e.g. "consoles", "games", "collection"). */
    kind: text("kind").notNull().default("standard"),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
    description: l10n("description"),
    artKey: text("art_key"),
    seo: json<SeoMeta>("seo"),
  },
  (t) => [uniqueIndex("categories_slug_uq").on(t.slug), index("categories_parent_idx").on(t.parentId, t.sort)],
);
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

// ───────────────────────────────────────────────────────────────── products

export const MEDIA_FORMATS = ["physical", "digital"] as const;
export type MediaFormat = (typeof MEDIA_FORMATS)[number];
export const PRODUCT_STATUSES = ["draft", "review", "scheduled", "published", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
/** What a digital product grants (13.06). Null for physical goods. */
export const LICENSE_TYPES = ["game_key", "subscription", "wallet_topup", "dlc", "account"] as const;
export type LicenseType = (typeof LICENSE_TYPES)[number];

export const products = sqliteTable(
  "products",
  {
    id: id(),
    slug: text("slug").notNull(),
    kind: text("kind", { enum: PRODUCT_KINDS }).notNull(),
    name: l10n("name").notNull(),
    /** One line under the name. */
    short: l10n("short"),
    description: l10n("description"),
    brand: text("brand"),
    platformId: text("platform_id").references((): Ref => platforms.id),
    deviceModelId: text("device_model_id").references((): Ref => deviceModels.id),
    categoryId: text("category_id").references((): Ref => categories.id),
    specs: json<Specs>("specs"),
    /** Values of the custom fields defined in `custom_fields` for this product kind. */
    attributes: json<Record<string, unknown>>("attributes"),
    warrantyMonths: integer("warranty_months"),
    /** e.g. "PEGI 18", "ESRB T". */
    ageRating: text("age_rating"),
    /** Hardware/disc region or edition, e.g. "PAL", "NTSC-U", "ME", "region_free". */
    region: text("region"),
    licenseType: text("license_type", { enum: LICENSE_TYPES }),
    mediaFormat: text("media_format", { enum: MEDIA_FORMATS }),
    status: text("status", { enum: PRODUCT_STATUSES }).notNull().default("draft"),
    /** When a `scheduled` product goes live. */
    publishAt: at("publish_at"),
    /** Placeholder catalogue data (ARCHITECTURE §11). */
    isDemo: flag("is_demo").notNull().default(false),
    seo: json<SeoMeta>("seo"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    /** Extra search terms (transliterations, nicknames) fed into `search_index.keywords`. */
    searchKeywords: l10n("search_keywords"),
    /** Pre-orders (05.07): expected availability, and the deposit taken at checkout if any. */
    preorderReleaseAt: at("preorder_release_at"),
    preorderDepositIqd: iqd("preorder_deposit_iqd"),
    /** Number of the latest row in `product_versions`. */
    version: integer("version").notNull().default(1),
    publishedAt: at("published_at"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
  },
  (t) => [
    uniqueIndex("products_slug_uq").on(t.slug),
    index("products_status_idx").on(t.status, t.publishAt),
    index("products_kind_idx").on(t.kind, t.status),
    index("products_platform_idx").on(t.platformId, t.status),
    index("products_device_model_idx").on(t.deviceModelId),
    index("products_category_idx").on(t.categoryId, t.status),
    index("products_brand_idx").on(t.brand),
    index("products_created_at_idx").on(t.createdAt),
  ],
);
export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

/** [A] Full snapshot of a product (and its variants) each time it is saved — history and safe restore (02.09). */
export const productVersions = sqliteTable(
  "product_versions",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id),
    version: integer("version").notNull(),
    /** Never contains [P] cost fields. */
    snapshot: json<Record<string, unknown>>("snapshot").notNull(),
    changedBy: text("changed_by"),
    reason: text("reason"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("product_versions_product_version_uq").on(t.productId, t.version)],
);
export type ProductVersion = typeof productVersions.$inferSelect;
export type NewProductVersion = typeof productVersions.$inferInsert;

export const variants = sqliteTable(
  "variants",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    barcode: text("barcode"),
    title: l10n("title"),
    /** Option values, e.g. `{ color: "white", storage: "1TB", edition: "disc", region: "ME" }`. */
    options: json<Record<string, string>>("options"),
    priceIqd: iqd("price_iqd").notNull(),
    /** Previous price, set only for a genuine reduction. */
    compareAtIqd: iqd("compare_at_iqd"),
    isDefault: flag("is_default").notNull().default(false),
    isActive: flag("is_active").notNull().default(true),
    /** Each unit is tracked by serial number (consoles, handhelds). */
    trackSerials: flag("track_serials").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    weightGrams: integer("weight_grams"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("variants_sku_uq").on(t.sku),
    index("variants_product_idx").on(t.productId, t.sort),
    index("variants_barcode_idx").on(t.barcode),
    check("variants_price_check", sql`${t.priceIqd} >= 0 AND (${t.compareAtIqd} IS NULL OR ${t.compareAtIqd} >= 0)`),
  ],
);
export type Variant = typeof variants.$inferSelect;
export type NewVariant = typeof variants.$inferInsert;

/**
 * [P] Purchase cost of a variant. `unit_cost_minor` is in the supplier currency's minor units;
 * `fx_rate_micros` is IQD per one unit of that currency × 1,000,000 on `fx_date`.
 * A price may not be published below `min_margin_bps` (03.03).
 */
export const variantCosts = sqliteTable("variant_costs", {
  variantId: text("variant_id")
    .primaryKey()
    .references((): Ref => variants.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("USD"),
  unitCostMinor: integer("unit_cost_minor").notNull(),
  fxRateMicros: integer("fx_rate_micros"),
  /** "YYYY-MM-DD" the rate was taken. */
  fxDate: text("fx_date"),
  /** Purchase cost + allocated freight, customs, fees and commissions, per unit. */
  landedCostIqd: iqd("landed_cost_iqd").notNull(),
  /** Weighted-average cost when the costing policy is "average" instead of FIFO layers. */
  avgCostIqd: iqd("avg_cost_iqd"),
  minMarginBps: integer("min_margin_bps"),
  targetMarginBps: integer("target_margin_bps"),
  updatedBy: text("updated_by"),
  updatedAt: at("updated_at").notNull(),
});
export type VariantCost = typeof variantCosts.$inferSelect;
export type NewVariantCost = typeof variantCosts.$inferInsert;

export const PRICE_CHANGE_STATUSES = ["pending", "approved", "applied", "rejected", "cancelled"] as const;
export type PriceChangeStatus = (typeof PRICE_CHANGE_STATUSES)[number];
export const PRICE_CHANGE_SOURCES = ["manual", "bulk", "import", "suggestion", "rule", "revert"] as const;
export type PriceChangeSource = (typeof PRICE_CHANGE_SOURCES)[number];

/**
 * [A] Price history and approvals (03.05, 03.08). Append-only: a decision is a NEW row that points
 * at the request through `request_id` (pending → approved/rejected → applied); the latest row per
 * request tells its state. `applied` rows are the price history.
 */
export const priceChanges = sqliteTable(
  "price_changes",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    oldPriceIqd: iqd("old_price_iqd"),
    newPriceIqd: iqd("new_price_iqd").notNull(),
    reason: text("reason"),
    requestedBy: text("requested_by"),
    approvedBy: text("approved_by"),
    status: text("status", { enum: PRICE_CHANGE_STATUSES }).notNull(),
    createdAt: at("created_at").notNull(),
    oldCompareAtIqd: iqd("old_compare_at_iqd"),
    newCompareAtIqd: iqd("new_compare_at_iqd"),
    source: text("source", { enum: PRICE_CHANGE_SOURCES }).notNull().default("manual"),
    /** The `pending` row this row decides or applies. */
    requestId: text("request_id").references((): Ref => priceChanges.id),
    /** Row in `approvals` when the change needed sign-off. */
    approvalId: text("approval_id"),
  },
  (t) => [
    index("price_changes_variant_idx").on(t.variantId, t.createdAt),
    index("price_changes_status_idx").on(t.status, t.createdAt),
    index("price_changes_request_idx").on(t.requestId),
  ],
);
export type PriceChange = typeof priceChanges.$inferSelect;
export type NewPriceChange = typeof priceChanges.$inferInsert;

/** Price lists per channel / branch / customer segment (03.04). The variant price is the fallback. */
export const priceLists = sqliteTable(
  "price_lists",
  {
    id: id(),
    code: text("code").notNull(),
    name: l10n("name").notNull(),
    /** Any of these may be null = "applies to all". */
    channel: text("channel"),
    branchId: text("branch_id"),
    segmentId: text("segment_id"),
    /** Higher wins when several lists match. */
    priority: integer("priority").notNull().default(0),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    isActive: flag("is_active").notNull().default(true),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("price_lists_code_uq").on(t.code), index("price_lists_active_idx").on(t.isActive, t.priority)],
);
export type PriceList = typeof priceLists.$inferSelect;
export type NewPriceList = typeof priceLists.$inferInsert;

export const priceListItems = sqliteTable(
  "price_list_items",
  {
    priceListId: text("price_list_id")
      .notNull()
      .references((): Ref => priceLists.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id, { onDelete: "cascade" }),
    /** Price applies from this quantity upwards. */
    minQty: integer("min_qty").notNull().default(1),
    priceIqd: iqd("price_iqd").notNull(),
    compareAtIqd: iqd("compare_at_iqd"),
  },
  (t) => [
    primaryKey({ columns: [t.priceListId, t.variantId, t.minQty] }),
    index("price_list_items_variant_idx").on(t.variantId),
    check("price_list_items_price_check", sql`${t.priceIqd} >= 0 AND ${t.minQty} >= 1`),
  ],
);
export type PriceListItem = typeof priceListItems.$inferSelect;
export type NewPriceListItem = typeof priceListItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── media

export const MEDIA_KINDS = ["image", "video", "render"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/**
 * Gallery entries for products, variants, used units, device models, categories…
 * (`owner_type` + `owner_id`). Either an uploaded file (`file_id`) or a catalogue photo key of `~/art` (`art_key`).
 *
 * `is_illustration` defaults to TRUE: an image only counts as "a photo of this actual unit" when a
 * person says so. A used unit needs at least one `kind = 'image'`, `is_illustration = 0`,
 * `file_id IS NOT NULL` row before it can be listed (trigger, ARCHITECTURE §7.11).
 */
export const media = sqliteTable(
  "media",
  {
    id: id(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    fileId: text("file_id").references((): Ref => files.id),
    artKey: text("art_key"),
    kind: text("kind", { enum: MEDIA_KINDS }).notNull().default("image"),
    alt: l10n("alt"),
    isIllustration: flag("is_illustration").notNull().default(true),
    sort: integer("sort").notNull().default(0),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [index("media_owner_idx").on(t.ownerType, t.ownerId, t.sort), index("media_file_idx").on(t.fileId)],
);
export type MediaItem = typeof media.$inferSelect;
export type NewMediaItem = typeof media.$inferInsert;

// ───────────────────────────────────────────────────────────────── bundles, relations, compatibility

/** Components of a bundle variant; selling the bundle moves stock of the components (02.07). */
export const bundleItems = sqliteTable(
  "bundle_items",
  {
    bundleVariantId: text("bundle_variant_id")
      .notNull()
      .references((): Ref => variants.id, { onDelete: "cascade" }),
    componentVariantId: text("component_variant_id")
      .notNull()
      .references((): Ref => variants.id),
    qty: integer("qty").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.bundleVariantId, t.componentVariantId] }),
    index("bundle_items_component_idx").on(t.componentVariantId),
    check("bundle_items_qty_check", sql`${t.qty} > 0 AND ${t.bundleVariantId} <> ${t.componentVariantId}`),
  ],
);
export type BundleItem = typeof bundleItems.$inferSelect;
export type NewBundleItem = typeof bundleItems.$inferInsert;

export const PRODUCT_RELATION_KINDS = ["accessory", "upsell", "alternative", "upgrade", "setup"] as const;
export type ProductRelationKind = (typeof PRODUCT_RELATION_KINDS)[number];

/** Editorial links between products (02.08). Recommendations still pass the compatibility filter. */
export const productRelations = sqliteTable(
  "product_relations",
  {
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    relatedProductId: text("related_product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: PRODUCT_RELATION_KINDS }).notNull(),
    pinned: flag("pinned").notNull().default(false),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.relatedProductId, t.kind] }),
    index("product_relations_related_idx").on(t.relatedProductId),
    check("product_relations_self_check", sql`${t.productId} <> ${t.relatedProductId}`),
  ],
);
export type ProductRelation = typeof productRelations.$inferSelect;
export type NewProductRelation = typeof productRelations.$inferInsert;

export const COMPATIBILITY_SUBJECT_TYPES = ["product", "variant"] as const;
export type CompatibilitySubjectType = (typeof COMPATIBILITY_SUBJECT_TYPES)[number];
export const COMPATIBILITY_TARGET_TYPES = ["device_model", "generation", "platform"] as const;
export type CompatibilityTargetType = (typeof COMPATIBILITY_TARGET_TYPES)[number];
export const COMPATIBILITY_STATUSES = ["verified", "partial", "incompatible", "unverified"] as const;
export type CompatibilityStatus = (typeof COMPATIBILITY_STATUSES)[number];

/**
 * Edges of the compatibility graph: "<product|variant> works with <device model|generation|platform>".
 * Only `verified` (and `partial`, with its note shown) may be presented as compatible.
 */
export const compatibilityRules = sqliteTable(
  "compatibility_rules",
  {
    id: id(),
    subjectType: text("subject_type", { enum: COMPATIBILITY_SUBJECT_TYPES }).notNull(),
    subjectId: text("subject_id").notNull(),
    targetType: text("target_type", { enum: COMPATIBILITY_TARGET_TYPES }).notNull(),
    targetId: text("target_id").notNull(),
    status: text("status", { enum: COMPATIBILITY_STATUSES }).notNull().default("unverified"),
    note: l10n("note"),
    /** Where the fact comes from (manufacturer page, in-store test, …). */
    source: text("source"),
    verifiedBy: text("verified_by"),
    verifiedAt: at("verified_at"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("compatibility_rules_edge_uq").on(t.subjectType, t.subjectId, t.targetType, t.targetId),
    index("compatibility_rules_target_idx").on(t.targetType, t.targetId, t.status),
  ],
);
export type CompatibilityRule = typeof compatibilityRules.$inferSelect;
export type NewCompatibilityRule = typeof compatibilityRules.$inferInsert;

// ───────────────────────────────────────────────────────────────── reviews

export const REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * Customer reviews. Only real customers write them (there is no demo flag on purpose: reviews are
 * never seeded or invented). Ratings shown in the storefront count approved rows only.
 */
export const reviews = sqliteTable(
  "reviews",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id),
    /** Set when the review comes from a delivered purchase. */
    orderItemId: text("order_item_id").references((): Ref => orderItems.id),
    rating: integer("rating").notNull(),
    title: text("title"),
    body: text("body"),
    status: text("status", { enum: REVIEW_STATUSES }).notNull().default("pending"),
    isVerifiedPurchase: flag("is_verified_purchase").notNull().default(false),
    createdAt: at("created_at").notNull(),
    locale: text("locale"),
    moderatedBy: text("moderated_by"),
    moderatedAt: at("moderated_at"),
    rejectReason: text("reject_reason"),
  },
  (t) => [
    uniqueIndex("reviews_product_customer_uq").on(t.productId, t.customerId),
    index("reviews_product_idx").on(t.productId, t.status, t.createdAt),
    index("reviews_customer_idx").on(t.customerId),
    index("reviews_order_item_idx").on(t.orderItemId),
    index("reviews_status_idx").on(t.status, t.createdAt),
    check("reviews_rating_check", sql`${t.rating} BETWEEN 1 AND 5`),
  ],
);
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;

// ───────────────────────────────────────────────────────────────── search

/** Synonyms per locale ("بلايستيشن" ⇄ "ps5" ⇄ "سوني 5"); expanded into the query by the search service. */
export const searchSynonyms = sqliteTable(
  "search_synonyms",
  {
    id: id(),
    locale: text("locale").notNull(),
    /** Normalized with normalizeSearchText() from ~/server/db/search.server. */
    term: text("term").notNull(),
    synonyms: json<string[]>("synonyms").notNull(),
    isActive: flag("is_active").notNull().default(true),
    createdBy: text("created_by"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex("search_synonyms_term_uq").on(t.locale, t.term)],
);
export type SearchSynonym = typeof searchSynonyms.$inferSelect;
export type NewSearchSynonym = typeof searchSynonyms.$inferInsert;

/** What shoppers searched for, per day — feeds the "searches with no results" report (17.05). No personal data. */
export const searchQueryStats = sqliteTable(
  "search_query_stats",
  {
    /** Asia/Baghdad calendar day, "YYYY-MM-DD". */
    day: text("day").notNull(),
    locale: text("locale").notNull(),
    /** Normalized query text. */
    query: text("query").notNull(),
    searches: integer("searches").notNull().default(0),
    zeroResults: integer("zero_results").notNull().default(0),
    lastAt: at("last_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.locale, t.query] }), index("search_query_stats_zero_idx").on(t.zeroResults, t.day)],
);
export type SearchQueryStat = typeof searchQueryStats.$inferSelect;
export type NewSearchQueryStat = typeof searchQueryStats.$inferInsert;

// ───────────────────────────────────────────────────────────────── custom fields

export const CUSTOM_FIELD_TYPES = ["text", "l10n", "number", "boolean", "select", "multiselect", "date"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

/**
 * Custom fields and validation rules per product kind (02.03, 22.03). Values live in
 * `products.attributes`; `required` fields block publishing while empty.
 */
export const customFields = sqliteTable(
  "custom_fields",
  {
    id: id(),
    /** "product" | "variant" | "customer" | "order" … */
    entity: text("entity").notNull().default("product"),
    /** "*" = every product kind. */
    productKind: text("product_kind", { enum: PRODUCT_KIND_SCOPES }).notNull().default("*"),
    key: text("key").notNull(),
    label: l10n("label").notNull(),
    type: text("type", { enum: CUSTOM_FIELD_TYPES }).notNull().default("text"),
    options: json<Array<{ value: string; label: L10n }>>("options"),
    required: flag("required").notNull().default(false),
    /** e.g. `{ min: 0, max: 100, pattern: "^[A-Z0-9-]+$" }`. */
    validation: json<Record<string, unknown>>("validation"),
    /** Offer this field as a storefront filter. */
    filterable: flag("filterable").notNull().default(false),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("custom_fields_key_uq").on(t.entity, t.productKind, t.key)],
);
export type CustomField = typeof customFields.$inferSelect;
export type NewCustomField = typeof customFields.$inferInsert;

// Compile-time guards: the enums above must stay identical to the view-model unions in ~/lib/dto.
const dtoGuards: [Same<ProductKind, ProductKindDto>, Same<CompatibilityStatus, CompatibilityStatusDto>] = [true, true];
void dtoGuards;
