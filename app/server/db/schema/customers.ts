/**
 * customers — accounts, guest contacts, addresses, sessions, OTP codes, consent history,
 * wishlists, notifications, privacy requests and CRM segments (admin module 07).
 *
 * Checkout never requires an account: a guest order stores its own contact snapshot and links
 * to `guest_contacts`. Customers are never hard-deleted once they have orders — a privacy
 * deletion anonymizes the row (`anonymized_at`) so financial history stays intact.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Locale } from "~/lib/locales";
import { NOW_MS, at, flag, id, json, l10n, type Ref } from "../columns";
import { deviceModels, products } from "./catalog";
import { files } from "./core";
import { districts, governorates } from "./shipping";

export const CUSTOMER_STATUSES = ["active", "blocked", "merged", "deleted"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/** Per-channel notification preferences (07.03). Marketing still requires a `consents` row. */
export type NotificationPrefs = { sms?: boolean; whatsapp?: boolean; email?: boolean; push?: boolean };

export const customers = sqliteTable(
  "customers",
  {
    id: id(),
    /** Canonical +9647XXXXXXXXX (normalizeIraqPhone). The account identifier. */
    phoneE164: text("phone_e164").notNull(),
    name: text("name"),
    email: text("email"),
    /** PBKDF2-SHA256 hash including its per-user salt; null for accounts that sign in by OTP only. */
    passwordHash: text("password_hash"),
    passwordIters: integer("password_iters"),
    status: text("status", { enum: CUSTOMER_STATUSES }).notNull().default("active"),
    locale: text("locale").$type<Locale>().notNull().default("ar"),
    /** Key of a membership tier or a manual VIP label; null = none. */
    vipTier: text("vip_tier"),
    /** Orders from flagged customers go to human review (05.09, 07.06). */
    fraudFlag: flag("fraud_flag").notNull().default(false),
    /** Staff-only notes. */
    notes: text("notes"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
    phoneVerifiedAt: at("phone_verified_at"),
    lastLoginAt: at("last_login_at"),
    fraudReason: text("fraud_reason"),
    notificationPrefs: json<NotificationPrefs>("notification_prefs"),
    /** Target account after a verified merge of duplicates (07.05); status becomes "merged". */
    mergedIntoId: text("merged_into_id").references((): Ref => customers.id),
    /** Personal fields were erased by a privacy request. */
    anonymizedAt: at("anonymized_at"),
    isDemo: flag("is_demo").notNull().default(false),
  },
  (t) => [
    uniqueIndex("customers_phone_uq").on(t.phoneE164),
    index("customers_email_idx").on(t.email),
    index("customers_status_idx").on(t.status),
    index("customers_created_at_idx").on(t.createdAt),
    index("customers_merged_into_idx").on(t.mergedIntoId),
  ],
);
export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

/** Contact details of shoppers who ordered without an account. One row per phone number in practice. */
export const guestContacts = sqliteTable(
  "guest_contacts",
  {
    id: id(),
    phoneE164: text("phone_e164").notNull(),
    name: text("name"),
    createdAt: at("created_at").notNull(),
    /** Set when the guest later creates an account and claims their orders by phone verification. */
    customerId: text("customer_id").references((): Ref => customers.id),
  },
  (t) => [index("guest_contacts_phone_idx").on(t.phoneE164), index("guest_contacts_customer_idx").on(t.customerId)],
);
export type GuestContact = typeof guestContacts.$inferSelect;
export type NewGuestContact = typeof guestContacts.$inferInsert;

export const addresses = sqliteTable(
  "addresses",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id, { onDelete: "cascade" }),
    /** "البيت", "العمل"… */
    label: text("label"),
    recipientName: text("recipient_name"),
    phoneE164: text("phone_e164"),
    governorateId: text("governorate_id")
      .notNull()
      .references((): Ref => governorates.id),
    districtId: text("district_id").references((): Ref => districts.id),
    /** Neighbourhood / area as the customer wrote it. */
    areaText: text("area_text"),
    addressText: text("address_text").notNull(),
    notes: text("notes"),
    isDefault: flag("is_default").notNull().default(false),
    createdAt: at("created_at").notNull().default(NOW_MS),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    index("addresses_customer_idx").on(t.customerId),
    index("addresses_governorate_idx").on(t.governorateId),
    index("addresses_district_idx").on(t.districtId),
  ],
);
export type Address = typeof addresses.$inferSelect;
export type NewAddress = typeof addresses.$inferInsert;

/** Customer sessions. The primary key is sha256(session token); the token itself is only in the cookie. */
export const customerSessions = sqliteTable(
  "customer_sessions",
  {
    idHash: text("id_hash").primaryKey(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id, { onDelete: "cascade" }),
    createdAt: at("created_at").notNull(),
    lastSeenAt: at("last_seen_at").notNull(),
    expiresAt: at("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: at("revoked_at"),
  },
  (t) => [index("customer_sessions_customer_idx").on(t.customerId), index("customer_sessions_expires_idx").on(t.expiresAt)],
);
export type CustomerSession = typeof customerSessions.$inferSelect;
export type NewCustomerSession = typeof customerSessions.$inferInsert;

/**
 * One-time codes sent to a phone. Only the hash is stored; `attempts` caps guessing.
 * `purpose` is an open vocabulary owned by the auth service ("login", "order_lookup", "claim_orders", …).
 */
export const otpCodes = sqliteTable(
  "otp_codes",
  {
    id: id(),
    phoneE164: text("phone_e164").notNull(),
    purpose: text("purpose").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: at("expires_at").notNull(),
    consumedAt: at("consumed_at"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    ip: text("ip"),
    /** What the code unlocks when it is tied to one thing, e.g. an order reference. */
    ref: text("ref"),
  },
  (t) => [index("otp_codes_phone_idx").on(t.phoneE164, t.purpose, t.expiresAt), index("otp_codes_expires_idx").on(t.expiresAt)],
);
export type OtpCode = typeof otpCodes.$inferSelect;
export type NewOtpCode = typeof otpCodes.$inferInsert;

export const CONSENT_KINDS = ["marketing", "personalization", "analytics", "support_log"] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

/**
 * [A] Consent history (07.04): every grant and withdrawal is a new row; the latest row per
 * (subject, kind) is the current state. `subject_type` is "customer", "guest_contact", "session" or "order".
 * Marketing consent is never pre-checked.
 */
export const consents = sqliteTable(
  "consents",
  {
    id: id(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    kind: text("kind", { enum: CONSENT_KINDS }).notNull(),
    granted: flag("granted").notNull(),
    /** Where it was given: "checkout", "account", "banner", "assistant", "admin"… */
    source: text("source"),
    at: at("at").notNull(),
    ip: text("ip"),
    /** Version of the policy text the person saw. */
    policyVersion: text("policy_version"),
  },
  (t) => [index("consents_subject_idx").on(t.subjectType, t.subjectId, t.kind, t.at)],
);
export type Consent = typeof consents.$inferSelect;
export type NewConsent = typeof consents.$inferInsert;

/** Devices a customer says they own — drives "compatible with your device" and setup suggestions. */
export const savedDevices = sqliteTable(
  "saved_devices",
  {
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id, { onDelete: "cascade" }),
    deviceModelId: text("device_model_id")
      .notNull()
      .references((): Ref => deviceModels.id, { onDelete: "cascade" }),
    createdAt: at("created_at").notNull().default(NOW_MS),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.deviceModelId] }), index("saved_devices_model_idx").on(t.deviceModelId)],
);
export type SavedDevice = typeof savedDevices.$inferSelect;
export type NewSavedDevice = typeof savedDevices.$inferInsert;

/** Favourites. Owned by a customer or, for guests, by the hashed cart token. */
export const wishlistItems = sqliteTable(
  "wishlist_items",
  {
    id: id(),
    customerId: text("customer_id").references((): Ref => customers.id, { onDelete: "cascade" }),
    cartTokenHash: text("cart_token_hash"),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("wishlist_items_customer_product_uq").on(t.customerId, t.productId).where(sql`${t.customerId} IS NOT NULL`),
    uniqueIndex("wishlist_items_token_product_uq").on(t.cartTokenHash, t.productId).where(sql`${t.cartTokenHash} IS NOT NULL`),
    index("wishlist_items_product_idx").on(t.productId),
    check("wishlist_items_owner_check", sql`${t.customerId} IS NOT NULL OR ${t.cartTokenHash} IS NOT NULL`),
  ],
);
export type WishlistItem = typeof wishlistItems.$inferSelect;
export type NewWishlistItem = typeof wishlistItems.$inferInsert;

/** Browsing history used for "recently viewed" — only written when personalization consent is given. */
export const recentlyViewed = sqliteTable(
  "recently_viewed",
  {
    id: id(),
    customerId: text("customer_id").references((): Ref => customers.id, { onDelete: "cascade" }),
    cartTokenHash: text("cart_token_hash"),
    productId: text("product_id")
      .notNull()
      .references((): Ref => products.id, { onDelete: "cascade" }),
    viewedAt: at("viewed_at").notNull(),
  },
  (t) => [
    uniqueIndex("recently_viewed_customer_product_uq").on(t.customerId, t.productId).where(sql`${t.customerId} IS NOT NULL`),
    uniqueIndex("recently_viewed_token_product_uq").on(t.cartTokenHash, t.productId).where(sql`${t.cartTokenHash} IS NOT NULL`),
    index("recently_viewed_customer_idx").on(t.customerId, t.viewedAt),
    index("recently_viewed_token_idx").on(t.cartTokenHash, t.viewedAt),
    index("recently_viewed_product_idx").on(t.productId),
    check("recently_viewed_owner_check", sql`${t.customerId} IS NOT NULL OR ${t.cartTokenHash} IS NOT NULL`),
  ],
);
export type RecentlyViewedItem = typeof recentlyViewed.$inferSelect;
export type NewRecentlyViewedItem = typeof recentlyViewed.$inferInsert;

/** In-account notifications (order updates, proof rejected, trade-in offer ready, …). */
export const notifications = sqliteTable(
  "notifications",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: l10n("title").notNull(),
    body: l10n("body"),
    /** Locale-less path, e.g. "/order/TT-7K4M2Q9X". */
    link: text("link"),
    readAt: at("read_at"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [index("notifications_customer_idx").on(t.customerId, t.readAt, t.createdAt)],
);
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

export const PRIVACY_REQUEST_KINDS = ["export", "delete", "rectify", "unsubscribe"] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
export const PRIVACY_REQUEST_STATUSES = ["open", "verifying", "in_progress", "completed", "rejected"] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

/** Data export / deletion / correction requests (07.04, 20.07). Handled only after the phone is verified. */
export const privacyRequests = sqliteTable(
  "privacy_requests",
  {
    id: id(),
    ref: text("ref").notNull(),
    customerId: text("customer_id").references((): Ref => customers.id),
    phoneE164: text("phone_e164").notNull(),
    kind: text("kind", { enum: PRIVACY_REQUEST_KINDS }).notNull(),
    status: text("status", { enum: PRIVACY_REQUEST_STATUSES }).notNull().default("open"),
    details: text("details"),
    verifiedAt: at("verified_at"),
    handledBy: text("handled_by"),
    dueAt: at("due_at"),
    completedAt: at("completed_at"),
    /** The export file (private). */
    resultFileId: text("result_file_id").references((): Ref => files.id),
    resolutionNote: text("resolution_note"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("privacy_requests_ref_uq").on(t.ref),
    index("privacy_requests_customer_idx").on(t.customerId),
    index("privacy_requests_phone_idx").on(t.phoneE164),
    index("privacy_requests_status_idx").on(t.status, t.createdAt),
    index("privacy_requests_result_file_idx").on(t.resultFileId),
  ],
);
export type PrivacyRequest = typeof privacyRequests.$inferSelect;
export type NewPrivacyRequest = typeof privacyRequests.$inferInsert;

// ───────────────────────────────────────────────────────────────── segments (07.02, 16.03)

/**
 * Saved customer segments. Dynamic segments are defined by `rules` (RFM bands, platform owned,
 * last purchase, governorate, …) and recomputed by a job; static ones are edited by hand.
 */
export const customerSegments = sqliteTable(
  "customer_segments",
  {
    id: id(),
    key: text("key").notNull(),
    name: l10n("name").notNull(),
    description: text("description"),
    rules: json<Record<string, unknown>>("rules"),
    isDynamic: flag("is_dynamic").notNull().default(true),
    memberCount: integer("member_count").notNull().default(0),
    computedAt: at("computed_at"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("customer_segments_key_uq").on(t.key)],
);
export type CustomerSegment = typeof customerSegments.$inferSelect;
export type NewCustomerSegment = typeof customerSegments.$inferInsert;

export const customerSegmentMembers = sqliteTable(
  "customer_segment_members",
  {
    segmentId: text("segment_id")
      .notNull()
      .references((): Ref => customerSegments.id, { onDelete: "cascade" }),
    customerId: text("customer_id")
      .notNull()
      .references((): Ref => customers.id, { onDelete: "cascade" }),
    addedAt: at("added_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.segmentId, t.customerId] }), index("customer_segment_members_customer_idx").on(t.customerId)],
);
export type CustomerSegmentMember = typeof customerSegmentMembers.$inferSelect;
export type NewCustomerSegmentMember = typeof customerSegmentMembers.$inferInsert;
