/**
 * growth — promotions, flash sales, referrals, memberships, campaigns, attribution links,
 * abandoned-cart reminders, recommendation controls and experiments (admin modules 08, 16 and the
 * recommendation engine of brief §6).
 *
 * Honesty rules that shape this file:
 *   · Campaign and experiment numbers are measured rows, never typed-in estimates.
 *   · Marketing messages go only to people whose latest `consents` row (kind "marketing") is granted.
 *   · Browsing signals (`recommendation_events`) are only recorded with personalization consent and
 *     are keyed by a hashed first-party session — no fingerprinting, no cross-device stitching.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { L10n } from "~/lib/locales";
import { NOW_MS, at, flag, id, iqd, json, l10n, type Ref } from "../columns";
import { products, variants } from "./catalog";
import { carts, orders } from "./commerce";
import { customerSegments, customers } from "./customers";

// ───────────────────────────────────────────────────────────────── promotions (08.02)

export const PROMOTION_KINDS = ["percent", "fixed", "bogo", "bundle", "free_shipping", "tiered"] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];

/** Where a promotion applies. All present keys must match. */
export type PromotionScope = {
  platformIds?: string[];
  categoryIds?: string[];
  productIds?: string[];
  variantIds?: string[];
  productKinds?: string[];
  segmentIds?: string[];
  channels?: string[];
  minSubtotalIqd?: number;
  minQty?: number;
};

/** Automatic discount rules (no code needed). Coupons live in `coupons`. */
export const promotions = sqliteTable(
  "promotions",
  {
    id: id(),
    name: l10n("name").notNull(),
    description: l10n("description"),
    kind: text("kind", { enum: PROMOTION_KINDS }).notNull(),
    /** `percent`: basis points. `fixed`: IQD. Other kinds read `config`. */
    value: integer("value"),
    /** Kind-specific settings, e.g. tiers `[{ minQty, bps }]` or BOGO `{ buy, get }`. */
    config: json<Record<string, unknown>>("config"),
    scope: json<PromotionScope>("scope"),
    maxDiscountIqd: iqd("max_discount_iqd"),
    /** Higher runs first. */
    priority: integer("priority").notNull().default(0),
    /** May combine with other promotions and coupons. */
    stackable: flag("stackable").notNull().default(false),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    isActive: flag("is_active").notNull().default(false),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [index("promotions_active_idx").on(t.isActive, t.startsAt, t.endsAt)],
);
export type Promotion = typeof promotions.$inferSelect;
export type NewPromotion = typeof promotions.$inferInsert;

// ───────────────────────────────────────────────────────────────── flash sales (08.03)

export const FLASH_SALE_STATUSES = ["draft", "scheduled", "active", "ended", "cancelled"] as const;
export type FlashSaleStatus = (typeof FLASH_SALE_STATUSES)[number];

export const flashSales = sqliteTable(
  "flash_sales",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: l10n("name").notNull(),
    startsAt: at("starts_at").notNull(),
    endsAt: at("ends_at").notNull(),
    status: text("status", { enum: FLASH_SALE_STATUSES }).notNull().default("draft"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("flash_sales_slug_uq").on(t.slug),
    index("flash_sales_window_idx").on(t.status, t.startsAt, t.endsAt),
    check("flash_sales_window_check", sql`${t.endsAt} > ${t.startsAt}`),
  ],
);
export type FlashSale = typeof flashSales.$inferSelect;
export type NewFlashSale = typeof flashSales.$inferInsert;

/**
 * Sale price and dedicated stock per variant. `qty_sold` can never pass `qty_limit` (CHECK): claim a
 * unit with `UPDATE … SET qty_sold = qty_sold + ? WHERE …` inside the order batch.
 */
export const flashSaleItems = sqliteTable(
  "flash_sale_items",
  {
    id: id(),
    flashSaleId: text("flash_sale_id")
      .notNull()
      .references((): Ref => flashSales.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    salePriceIqd: iqd("sale_price_iqd").notNull(),
    /** Units set aside for the sale; null = limited only by normal stock. */
    qtyLimit: integer("qty_limit"),
    qtySold: integer("qty_sold").notNull().default(0),
    perCustomerLimit: integer("per_customer_limit"),
  },
  (t) => [
    uniqueIndex("flash_sale_items_sale_variant_uq").on(t.flashSaleId, t.variantId),
    index("flash_sale_items_variant_idx").on(t.variantId),
    check("flash_sale_items_qty_check", sql`${t.salePriceIqd} >= 0 AND ${t.qtySold} >= 0 AND (${t.qtyLimit} IS NULL OR ${t.qtySold} <= ${t.qtyLimit})`),
  ],
);
export type FlashSaleItem = typeof flashSaleItems.$inferSelect;
export type NewFlashSaleItem = typeof flashSaleItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── referrals (08.05)

export const referralCodes = sqliteTable(
  "referral_codes",
  {
    id: id(),
    code: text("code").notNull(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("referral_codes_code_uq").on(t.code),
    uniqueIndex("referral_codes_customer_uq").on(t.customerId),
    check("referral_codes_uses_check", sql`${t.uses} >= 0 AND (${t.maxUses} IS NULL OR ${t.uses} <= ${t.maxUses})`),
  ],
);
export type ReferralCode = typeof referralCodes.$inferSelect;
export type NewReferralCode = typeof referralCodes.$inferInsert;

export const REFERRAL_STATUSES = ["pending", "qualified", "rewarded", "rejected"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * One row per referred person. Abuse guards in the schema: a phone number can be referred only once
 * (UNIQUE), and the reward is paid only after the referred order is delivered and past its return
 * window (`qualified` → `rewarded`).
 */
export const referralRedemptions = sqliteTable(
  "referral_redemptions",
  {
    id: id(),
    referralCodeId: text("referral_code_id")
      .notNull()
      .references((): Ref => referralCodes.id),
    referredCustomerId: text("referred_customer_id").references((): Ref => customers.id),
    referredPhoneE164: text("referred_phone_e164").notNull(),
    orderId: text("order_id").references((): Ref => orders.id),
    status: text("status", { enum: REFERRAL_STATUSES }).notNull().default("pending"),
    rejectReason: text("reject_reason"),
    rewardedAt: at("rewarded_at"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("referral_redemptions_phone_uq").on(t.referredPhoneE164),
    index("referral_redemptions_code_idx").on(t.referralCodeId, t.status),
    index("referral_redemptions_customer_idx").on(t.referredCustomerId),
    index("referral_redemptions_order_idx").on(t.orderId),
  ],
);
export type ReferralRedemption = typeof referralRedemptions.$inferSelect;
export type NewReferralRedemption = typeof referralRedemptions.$inferInsert;

// ───────────────────────────────────────────────────────────────── memberships (08.06)

/** Benefits of a tier. Shipping terms never change the stored flat fee — they discount it at checkout. */
export type MembershipBenefits = { discountBps?: number; freeShipping?: boolean; pointsMultiplierBps?: number; earlyAccess?: boolean; notes?: L10n };

export const membershipTiers = sqliteTable(
  "membership_tiers",
  {
    id: id(),
    key: text("key").notNull(),
    name: l10n("name").notNull(),
    benefits: json<MembershipBenefits>("benefits"),
    /** Price when the tier is sold; null = earned only. */
    priceIqd: iqd("price_iqd"),
    durationDays: integer("duration_days"),
    /** Spend within the last 12 months that grants the tier automatically; null = never automatic. */
    minSpendIqd: iqd("min_spend_iqd"),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("membership_tiers_key_uq").on(t.key)],
);
export type MembershipTier = typeof membershipTiers.$inferSelect;
export type NewMembershipTier = typeof membershipTiers.$inferInsert;

export const MEMBERSHIP_STATUSES = ["active", "expired", "cancelled"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const memberships = sqliteTable(
  "memberships",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id),
    tierId: text("tier_id")
      .notNull()
      .references((): Ref => membershipTiers.id),
    status: text("status", { enum: MEMBERSHIP_STATUSES }).notNull().default("active"),
    startsAt: at("starts_at").notNull(),
    endsAt: at("ends_at"),
    /** "purchase" | "auto" | "grant" */
    source: text("source").notNull().default("grant"),
    orderId: text("order_id").references((): Ref => orders.id),
    grantedBy: text("granted_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("memberships_customer_idx").on(t.customerId, t.status),
    index("memberships_tier_idx").on(t.tierId),
    index("memberships_order_idx").on(t.orderId),
    index("memberships_expiry_idx").on(t.status, t.endsAt),
  ],
);
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;

// ───────────────────────────────────────────────────────────────── campaigns (16.01–16.04, 16.07)

export const CAMPAIGN_CHANNELS = ["sms", "whatsapp", "email", "push", "social", "ads", "offline"] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];
export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "sent", "paused", "cancelled", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * A marketing campaign. `spend_iqd` is the amount actually spent (entered from the invoice); CAC and
 * ROAS are computed from it and from attributed orders — see docs/metrics.md.
 */
export const campaigns = sqliteTable(
  "campaigns",
  {
    id: id(),
    name: text("name").notNull(),
    channel: text("channel", { enum: CAMPAIGN_CHANNELS }).notNull(),
    status: text("status", { enum: CAMPAIGN_STATUSES }).notNull().default("draft"),
    /** Audience for message campaigns. */
    segmentId: text("segment_id").references((): Ref => customerSegments.id),
    /** `message_templates.key` of the message. */
    templateKey: text("template_key"),
    content: json<Record<string, unknown>>("content"),
    scheduledAt: at("scheduled_at"),
    sentAt: at("sent_at"),
    budgetIqd: iqd("budget_iqd"),
    spendIqd: iqd("spend_iqd").notNull().default(0),
    /** Value of utm_campaign that attributes orders to this campaign. */
    utmCampaign: text("utm_campaign"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    index("campaigns_status_idx").on(t.status, t.scheduledAt),
    index("campaigns_segment_idx").on(t.segmentId),
    index("campaigns_utm_idx").on(t.utmCampaign),
  ],
);
export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

/** `skipped_no_consent` rows document that a customer was left out because consent was missing. */
export const CAMPAIGN_RECIPIENT_STATUSES = ["pending", "held", "sent", "failed", "skipped_no_consent"] as const;
export type CampaignRecipientStatus = (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export const campaignRecipients = sqliteTable(
  "campaign_recipients",
  {
    id: id(),
    campaignId: text("campaign_id")
      .notNull()
      .references((): Ref => campaigns.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references((): Ref => customers.id),
    recipient: text("recipient").notNull(),
    status: text("status", { enum: CAMPAIGN_RECIPIENT_STATUSES }).notNull().default("pending"),
    outboxId: text("outbox_id"),
    sentAt: at("sent_at"),
  },
  (t) => [
    uniqueIndex("campaign_recipients_campaign_recipient_uq").on(t.campaignId, t.recipient),
    index("campaign_recipients_customer_idx").on(t.customerId),
    index("campaign_recipients_status_idx").on(t.campaignId, t.status),
  ],
);
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type NewCampaignRecipient = typeof campaignRecipients.$inferInsert;

/** Short tracked links (16.04). `orders.utm_link_id` attributes a sale to the link that brought the shopper. */
export const utmLinks = sqliteTable(
  "utm_links",
  {
    id: id(),
    code: text("code").notNull(),
    campaignId: text("campaign_id").references((): Ref => campaigns.id, { onDelete: "set null" }),
    /** Locale-less destination path on the storefront. */
    targetPath: text("target_path").notNull(),
    utmSource: text("utm_source").notNull(),
    utmMedium: text("utm_medium").notNull(),
    utmCampaign: text("utm_campaign"),
    utmContent: text("utm_content"),
    utmTerm: text("utm_term"),
    clicks: integer("clicks").notNull().default(0),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("utm_links_code_uq").on(t.code), index("utm_links_campaign_idx").on(t.campaignId)],
);
export type UtmLink = typeof utmLinks.$inferSelect;
export type NewUtmLink = typeof utmLinks.$inferInsert;

export const CART_REMINDER_STATUSES = ["scheduled", "held", "sent", "failed", "cancelled", "converted"] as const;
export type CartReminderStatus = (typeof CART_REMINDER_STATUSES)[number];

/** Abandoned-cart reminders (16.02). One row per cart and step caps how often a shopper is contacted. */
export const cartReminders = sqliteTable(
  "cart_reminders",
  {
    id: id(),
    cartId: text("cart_id")
      .notNull()
      .references((): Ref => carts.id, { onDelete: "cascade" }),
    customerId: text("customer_id").references((): Ref => customers.id),
    phoneE164: text("phone_e164"),
    channel: text("channel").notNull(),
    step: integer("step").notNull().default(1),
    status: text("status", { enum: CART_REMINDER_STATUSES }).notNull().default("scheduled"),
    scheduledAt: at("scheduled_at").notNull(),
    sentAt: at("sent_at"),
    outboxId: text("outbox_id"),
    /** Order placed from the reminded cart. */
    recoveredOrderId: text("recovered_order_id").references((): Ref => orders.id),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("cart_reminders_cart_step_uq").on(t.cartId, t.step),
    index("cart_reminders_due_idx").on(t.status, t.scheduledAt),
    index("cart_reminders_customer_idx").on(t.customerId),
    index("cart_reminders_order_idx").on(t.recoveredOrderId),
  ],
);
export type CartReminder = typeof cartReminders.$inferSelect;
export type NewCartReminder = typeof cartReminders.$inferInsert;

// ───────────────────────────────────────────────────────────────── recommendations (brief §6)

export const RECOMMENDATION_RULE_KINDS = ["pin", "exclude", "boost"] as const;
export type RecommendationRuleKind = (typeof RECOMMENDATION_RULE_KINDS)[number];

/** Where a rule applies; all present keys must match. An empty context applies everywhere. */
export type RecommendationContext = { placement?: string; productId?: string; platformId?: string; deviceModelId?: string; categoryId?: string };

/** Admin controls over recommendations: pin, exclude or boost a product in a context, with the reason shown in "why this?". */
export const recommendationRules = sqliteTable(
  "recommendation_rules",
  {
    id: id(),
    kind: text("kind", { enum: RECOMMENDATION_RULE_KINDS }).notNull(),
    context: json<RecommendationContext>("context"),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    weight: integer("weight").notNull().default(0),
    reason: text("reason"),
    createdBy: text("created_by"),
    isActive: flag("is_active").notNull().default(true),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [index("recommendation_rules_product_idx").on(t.productId), index("recommendation_rules_kind_idx").on(t.kind, t.isActive)],
);
export type RecommendationRule = typeof recommendationRules.$inferSelect;
export type NewRecommendationRule = typeof recommendationRules.$inferInsert;

export const RECOMMENDATION_EVENT_KINDS = ["view", "click", "add", "purchase"] as const;
export type RecommendationEventKind = (typeof RECOMMENDATION_EVENT_KINDS)[number];

/**
 * Consented browsing and shopping signals: input for recommendations and the only source of their
 * click-through / add-to-cart / conversion numbers. Rows older than the retention period are deleted.
 */
export const recommendationEvents = sqliteTable(
  "recommendation_events",
  {
    id: id(),
    /** Hash of the first-party session token; null for signed-in events keyed by customer. */
    sessionHash: text("session_hash"),
    customerId: text("customer_id").references((): Ref => customers.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RECOMMENDATION_EVENT_KINDS }).notNull(),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    /** Shelf that showed the product ("pdp_related", "cart_setup", "home_trending"…); null = organic. */
    source: text("source"),
    at: at("at").notNull(),
  },
  (t) => [
    index("recommendation_events_product_idx").on(t.productId, t.kind, t.at),
    index("recommendation_events_customer_idx").on(t.customerId, t.at),
    index("recommendation_events_session_idx").on(t.sessionHash, t.at),
    index("recommendation_events_source_idx").on(t.source, t.kind, t.at),
    index("recommendation_events_at_idx").on(t.at),
  ],
);
export type RecommendationEvent = typeof recommendationEvents.$inferSelect;
export type NewRecommendationEvent = typeof recommendationEvents.$inferInsert;

// ───────────────────────────────────────────────────────────────── experiments (08.08)

export const EXPERIMENT_STATUSES = ["draft", "running", "paused", "completed"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export type ExperimentVariant = { key: string; weight: number; config?: Record<string, unknown> };

/** A/B tests on offers, recommendations, layout or motion. The primary metric is fixed before the test starts. */
export const experiments = sqliteTable(
  "experiments",
  {
    id: id(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** "promotion" | "recommendation" | "layout" | "motion" | "content" … */
    area: text("area").notNull(),
    status: text("status", { enum: EXPERIMENT_STATUSES }).notNull().default("draft"),
    variants: json<ExperimentVariant[]>("variants").notNull(),
    /** e.g. "add_to_cart_rate", "conversion_rate" — defined in docs/metrics.md. */
    primaryMetric: text("primary_metric").notNull(),
    startsAt: at("starts_at"),
    endsAt: at("ends_at"),
    winnerVariant: text("winner_variant"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("experiments_key_uq").on(t.key), index("experiments_status_idx").on(t.status)],
);
export type Experiment = typeof experiments.$inferSelect;
export type NewExperiment = typeof experiments.$inferInsert;

/** Which variant a visitor got. Stable per (experiment, subject). */
export const experimentAssignments = sqliteTable(
  "experiment_assignments",
  {
    experimentId: text("experiment_id")
      .notNull()
      .references((): Ref => experiments.id, { onDelete: "cascade" }),
    /** Hash of the session token, or of the customer id when signed in. */
    subjectHash: text("subject_hash").notNull(),
    variantKey: text("variant_key").notNull(),
    assignedAt: at("assigned_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.experimentId, t.subjectHash] })],
);
export type ExperimentAssignment = typeof experimentAssignments.$inferSelect;
export type NewExperimentAssignment = typeof experimentAssignments.$inferInsert;

/** Measured outcomes per variant ("exposure", "click", "add", "purchase", "return"). */
export const experimentEvents = sqliteTable(
  "experiment_events",
  {
    id: id(),
    experimentId: text("experiment_id")
      .notNull()
      .references((): Ref => experiments.id, { onDelete: "cascade" }),
    subjectHash: text("subject_hash").notNull(),
    variantKey: text("variant_key").notNull(),
    kind: text("kind").notNull(),
    valueIqd: iqd("value_iqd"),
    at: at("at").notNull(),
  },
  (t) => [index("experiment_events_experiment_idx").on(t.experimentId, t.variantKey, t.kind), index("experiment_events_at_idx").on(t.at)],
);
export type ExperimentEvent = typeof experimentEvents.$inferSelect;
export type NewExperimentEvent = typeof experimentEvents.$inferInsert;
