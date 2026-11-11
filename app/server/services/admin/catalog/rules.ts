/**
 * Admin catalogue (module 02) — the rules both the server and the screens need: product statuses as staff see them,
 * what each product kind must have before it may go on sale (02.03), the publishing transitions and their
 * permissions (02.05), the variant option axes (02.01) and the CSV columns (02.06).
 *
 * Pure data and pure functions: no database, no server imports (types only), so the editor can show the same
 * checklist the service enforces. The services decide; the screens only explain.
 *
 * STATUS AS STAFF SEE IT. The database stores draft | review | scheduled | published | archived. "Hidden" is not a
 * stored value: it is a product that was on the storefront and was taken off it — `status = 'draft'` with
 * `published_at` set. Hiding keeps `published_at`, so showing it again does not make it a "new arrival".
 *
 * COMPLETENESS (02.03). Every product needs an Arabic name and description, a category, at least one active variant,
 * a price on every active variant (set in Pricing, module 03 — never here) and a picture. Each kind adds its own
 * facts: compatibility (at least one verified or partial rule), the store's warranty (`warranty_months`: 0 means
 * "no store warranty", empty means "not decided"), age rating, region, licence type, media format, bundle
 * components. Required custom fields (`custom_fields`, module 22) for the kind are added on top. A product that
 * misses anything cannot be published or scheduled, and a save never makes a live product less complete.
 */
import type { CompatibilityStatus, CompatibilityTargetType, DeviceKind, DeviceModelStatus, LicenseType, MediaFormat, ProductKind, ProductRelationKind, ProductStatus } from "~/server/db/schema";

// ───────────────────────────────────────────────────────────────── enums (copies of the schema's, client-safe)

export const PRODUCT_KIND_LIST = ["console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const satisfies readonly ProductKind[];
export const STORED_STATUSES = ["draft", "review", "scheduled", "published", "archived"] as const satisfies readonly ProductStatus[];
export const LICENSE_TYPE_LIST = ["game_key", "subscription", "wallet_topup", "dlc", "account"] as const satisfies readonly LicenseType[];
export const MEDIA_FORMAT_LIST = ["physical", "digital"] as const satisfies readonly MediaFormat[];
export const RELATION_KIND_LIST = ["accessory", "upsell", "alternative", "upgrade", "setup"] as const satisfies readonly ProductRelationKind[];
export const COMPAT_STATUS_LIST = ["verified", "partial", "incompatible", "unverified"] as const satisfies readonly CompatibilityStatus[];
export const COMPAT_TARGET_LIST = ["device_model", "generation", "platform"] as const satisfies readonly CompatibilityTargetType[];
export const DEVICE_KIND_LIST = ["console", "handheld_pc", "controller", "headset", "other"] as const satisfies readonly DeviceKind[];
export const DEVICE_MODEL_STATUS_LIST = ["draft", "published", "archived"] as const satisfies readonly DeviceModelStatus[];
/** Platform accents (design-token gel names; "brand" = TamTam red). */
export const PLATFORM_ACCENTS = ["brand", "nintendo", "playstation", "xbox", "handheld"] as const;

/** Statuses as the admin shows and filters them: the stored ones plus "hidden" (taken off the storefront). */
export const ADMIN_STATUSES = ["draft", "review", "scheduled", "published", "hidden", "archived"] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];

export function isAdminStatus(value: unknown): value is AdminStatus {
  return typeof value === "string" && (ADMIN_STATUSES as readonly string[]).includes(value);
}

export function isProductKind(value: unknown): value is ProductKind {
  return typeof value === "string" && (PRODUCT_KIND_LIST as readonly string[]).includes(value);
}

/** The status staff see for a stored row. */
export function adminStatusOf(row: { status: string; publishedAt: number | null }): AdminStatus {
  if (row.status === "draft") return row.publishedAt !== null ? "hidden" : "draft";
  return (STORED_STATUSES as readonly string[]).includes(row.status) ? (row.status as AdminStatus) : "draft";
}

/** On the storefront right now: published, or scheduled with its time passed (the product page and cart read it so). */
export function isLive(row: { status: string; publishAt: number | null }, now: number): boolean {
  return row.status === "published" || (row.status === "scheduled" && row.publishAt !== null && row.publishAt <= now);
}

/** Products the storefront search may find: published or scheduled (search filters by status again on read). */
export function isSearchListed(status: string): boolean {
  return status === "published" || status === "scheduled";
}

/** How the product list can be sorted (URL parameter "sort"). */
export const PRODUCT_SORTS = ["updated", "created", "name", "status"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

// ───────────────────────────────────────────────────────────────── completeness (02.03)

export const REQUIREMENTS = [
  "name_ar",
  "description_ar",
  "category",
  "variants",
  "prices",
  "images",
  "compatibility",
  "warranty",
  "age_rating",
  "region",
  "license_type",
  "media_format",
  "bundle_components",
] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

/** What every product needs. */
export const BASE_REQUIREMENTS: readonly Requirement[] = ["name_ar", "description_ar", "category", "variants", "prices", "images"];

/**
 * What each kind needs on top (blueprint 02.03: compatibility, warranty, age rating, region, licence type).
 * Region is required where it decides whether the item works for the buyer: a digital code is redeemed on an
 * account of one country. Physical games and consoles in this catalogue are not region-locked, so it stays optional.
 */
export const KIND_REQUIREMENTS: Readonly<Record<ProductKind, readonly Requirement[]>> = {
  console: ["warranty"],
  game: ["compatibility", "age_rating", "media_format"],
  controller: ["compatibility", "warranty"],
  headset: ["compatibility", "warranty"],
  storage: ["compatibility", "warranty"],
  accessory: ["compatibility", "warranty"],
  part: ["compatibility", "warranty"],
  digital: ["compatibility", "license_type", "region"],
  bundle: ["bundle_components"],
};

export function requirementsOf(kind: ProductKind): Requirement[] {
  return [...BASE_REQUIREMENTS, ...(KIND_REQUIREMENTS[kind] ?? [])];
}

/** The facts completeness is decided from — what a list row or the editor already has. */
export type CompletenessFacts = {
  kind: ProductKind;
  nameAr: string | null;
  descriptionAr: string | null;
  /** The category exists and is active. */
  categoryOk: boolean;
  activeVariants: number;
  /** Active variants without a price (price 0 = not set yet). */
  unpricedVariants: number;
  images: number;
  /** Compatibility rules on the product or its variants with status verified or partial. */
  compatibleRules: number;
  warrantyMonths: number | null;
  ageRating: string | null;
  region: string | null;
  /** Every active variant names its own region (options.region) — counts as a region for kinds that need one. */
  variantsHaveRegion: boolean;
  licenseType: string | null;
  mediaFormat: string | null;
  /** Active variants with no bundle component (bundles only). */
  variantsWithoutComponents: number;
};

/** A required custom field (custom_fields, module 22) and whether this product fills it. */
export type CustomRequirement = { key: string; label: { ar: string; en?: string; ckb?: string }; filled: boolean };

const filled = (value: string | null | undefined) => typeof value === "string" && value.trim() !== "";

export function meets(requirement: Requirement, facts: CompletenessFacts): boolean {
  switch (requirement) {
    case "name_ar":
      return filled(facts.nameAr);
    case "description_ar":
      return filled(facts.descriptionAr);
    case "category":
      return facts.categoryOk;
    case "variants":
      return facts.activeVariants > 0;
    case "prices":
      return facts.activeVariants > 0 && facts.unpricedVariants === 0;
    case "images":
      return facts.images > 0;
    case "compatibility":
      return facts.compatibleRules > 0;
    case "warranty":
      return facts.warrantyMonths !== null && Number.isInteger(facts.warrantyMonths) && facts.warrantyMonths >= 0;
    case "age_rating":
      return filled(facts.ageRating);
    case "region":
      return filled(facts.region) || (facts.activeVariants > 0 && facts.variantsHaveRegion);
    case "license_type":
      return filled(facts.licenseType);
    case "media_format":
      return filled(facts.mediaFormat);
    case "bundle_components":
      return facts.activeVariants > 0 && facts.variantsWithoutComponents === 0;
  }
}

export type Completeness = {
  complete: boolean;
  /** Built-in requirements not met, in checklist order. */
  missing: Requirement[];
  /** Required custom fields left empty (their keys). */
  missingCustom: string[];
  /** Every requirement with its state, for the checklist. */
  checklist: { requirement: Requirement; ok: boolean }[];
};

export function completenessOf(facts: CompletenessFacts, custom: readonly CustomRequirement[] = []): Completeness {
  const checklist = requirementsOf(facts.kind).map((requirement) => ({ requirement, ok: meets(requirement, facts) }));
  const missing = checklist.filter((entry) => !entry.ok).map((entry) => entry.requirement);
  const missingCustom = custom.filter((field) => !field.filled).map((field) => field.key);
  return { complete: missing.length === 0 && missingCustom.length === 0, missing, missingCustom, checklist };
}

/** Requirements a change would newly break (a save never makes a live product less complete). */
export function newlyMissing(before: Completeness, after: Completeness): string[] {
  const had = new Set([...before.missing, ...before.missingCustom.map((key) => `custom:${key}`)]);
  return [...after.missing, ...after.missingCustom.map((key) => `custom:${key}`)].filter((key) => !had.has(key));
}

// ───────────────────────────────────────────────────────────────── publishing workflow (02.05)

export const WORKFLOW_ACTIONS = ["submit_review", "return_draft", "publish", "schedule", "unschedule", "hide", "archive", "unarchive"] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export type WorkflowRule = {
  /** Stored statuses the action starts from. */
  from: readonly ProductStatus[];
  to: ProductStatus;
  permission: "catalog.product.update" | "catalog.product.publish" | "catalog.product.archive";
  /** The product must be complete (02.03). */
  needsComplete: boolean;
  /** A reason is required (it is shown in the history and the audit trail). */
  needsReason: boolean;
};

export const WORKFLOW: Readonly<Record<WorkflowAction, WorkflowRule>> = {
  submit_review: { from: ["draft"], to: "review", permission: "catalog.product.update", needsComplete: false, needsReason: false },
  return_draft: { from: ["review"], to: "draft", permission: "catalog.product.publish", needsComplete: false, needsReason: true },
  publish: { from: ["draft", "review", "scheduled"], to: "published", permission: "catalog.product.publish", needsComplete: true, needsReason: false },
  schedule: { from: ["draft", "review", "scheduled"], to: "scheduled", permission: "catalog.product.publish", needsComplete: true, needsReason: false },
  unschedule: { from: ["scheduled"], to: "draft", permission: "catalog.product.publish", needsComplete: false, needsReason: true },
  hide: { from: ["published"], to: "draft", permission: "catalog.product.publish", needsComplete: false, needsReason: true },
  archive: { from: ["draft", "review", "scheduled", "published"], to: "archived", permission: "catalog.product.archive", needsComplete: false, needsReason: true },
  unarchive: { from: ["archived"], to: "draft", permission: "catalog.product.archive", needsComplete: false, needsReason: true },
};

export function isWorkflowAction(value: unknown): value is WorkflowAction {
  return typeof value === "string" && (WORKFLOW_ACTIONS as readonly string[]).includes(value);
}

/** The actions that start from this stored status, in the order the editor offers them. */
export function actionsFrom(status: string): WorkflowAction[] {
  return WORKFLOW_ACTIONS.filter((action) => (WORKFLOW[action].from as readonly string[]).includes(status));
}

/** Most units of one component in a bundle. */
export const MAX_COMPONENT_QTY = 20;

/** Latest a product may be scheduled ahead. */
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────── variants (02.01)

/** The option axes staff fill per variant (stored in variants.options); `model` is the maker's model number. */
export const OPTION_AXES = ["platform", "color", "storage", "edition", "region", "condition"] as const;
export type OptionAxis = (typeof OPTION_AXES)[number];
export const VARIANT_CONDITIONS = ["new", "open_box", "refurbished"] as const;
export type VariantCondition = (typeof VARIANT_CONDITIONS)[number];
/** Option keys the editor shows as their own fields; any other key is kept as an "other option". */
export const KNOWN_OPTION_KEYS: readonly string[] = [...OPTION_AXES, "model"];

/** SKU: upper-case letters, digits and - _ . (the catalogue's shape), 2–64 characters. */
export const SKU_PATTERN = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;
/** Slug: lower-case words joined by "-" (or "_"), at most 80 characters. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
/** Barcodes: EAN-8, UPC-A (12), EAN-13 or GTIN-14 digits. */
export const BARCODE_PATTERN = /^(\d{8}|\d{12}|\d{13}|\d{14})$/;

/** GS1 check digit (EAN-8, UPC-A, EAN-13, GTIN-14). A scanner never misreads one into a valid one. */
export function barcodeCheckDigitOk(code: string): boolean {
  if (!BARCODE_PATTERN.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // From the right (excluding the check digit): weights 3, 1, 3, 1, …
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += digits[i] * weight;
  return (10 - (sum % 10)) % 10 === check;
}

// ───────────────────────────────────────────────────────────────── field suggestions

/** Common values; the fields still accept others ("PEGI 16", "ESRB T", "region_free", "US"). */
export const AGE_RATING_SUGGESTIONS = ["PEGI 3", "PEGI 7", "PEGI 12", "PEGI 16", "PEGI 18", "ESRB E", "ESRB E10+", "ESRB T", "ESRB M"] as const;
export const REGION_SUGGESTIONS = ["region_free", "US", "UK", "EU", "SA", "AE", "JP", "ME"] as const;

// ───────────────────────────────────────────────────────────────── CSV (02.06)

/**
 * Columns of the product sheet (export and import share them, so an exported file can be edited and imported).
 * `slug` finds the product. An empty cell leaves the field as it is; "-" clears an optional field.
 * `sku` and `barcode` are read only for NEW products (one default variant, without a price until Pricing sets one).
 * Read-only columns in exports (status, price_min_iqd, price_max_iqd) are ignored on import.
 */
export const CSV_PRODUCT_COLUMNS = [
  "slug",
  "kind",
  "category",
  "platform",
  "device_model",
  "brand",
  "name_ar",
  "name_en",
  "name_ckb",
  "short_ar",
  "short_en",
  "short_ckb",
  "description_ar",
  "description_en",
  "description_ckb",
  "warranty_months",
  "age_rating",
  "region",
  "license_type",
  "media_format",
  "keywords_ar",
  "keywords_en",
  "keywords_ckb",
  "sku",
  "barcode",
] as const;
export type CsvProductColumn = (typeof CSV_PRODUCT_COLUMNS)[number];
/** Columns an export adds for reading only. */
export const CSV_READ_ONLY_COLUMNS = ["status", "price_min_iqd", "price_max_iqd"] as const;
/** The token that clears an optional field. */
export const CSV_CLEAR = "-";
/** Rows read from one file. */
export const CSV_MAX_ROWS = 200;
/** Bytes read from one file. */
export const CSV_MAX_BYTES = 1024 * 1024;
