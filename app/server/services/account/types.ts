/**
 * Account view models — CLIENT-SAFE (types and constants only; no server imports at runtime).
 *
 * What a signed-in customer sees about their own account. Services in this folder build these, already localized;
 * route components only render them. Nothing here carries another customer's data, cost data, staff identities,
 * storage keys of private files or the duplicate flags staff use to review transfer proofs.
 */
import type { Locale } from "~/lib/locales";

/** Error keys produced by the account services (texts: account:errors.<key>, falling back to errors:errors.<key>). */
export const ACCOUNT_ERROR_KEYS = [
  "address_limit",
  "device_limit",
  "device_unknown",
  "wishlist_full",
  "topup_pending_limit",
  "topup_method_unavailable",
  "topup_proof_invalid",
  "topup_not_pending",
  "otp_unavailable",
  "session_unknown",
  // the gift-card redemption and the privacy-request form of the account (2026-11-12; module 08's and 07's codes in the
  // customer's words — staff read their own wording in those modules)
  "gift_card_unknown",
  "gift_card_used",
  "gift_card_void",
  "gift_card_expired",
  "gift_card_not_active",
  "gift_card_demo_mismatch",
  "privacy_open_exists",
] as const;
export type AccountErrorKey = (typeof ACCOUNT_ERROR_KEYS)[number];

export type AccountProfile = {
  id: string;
  name: string | null;
  email: string | null;
  phoneE164: string;
  /** "0771 ••• ••52" */
  phoneMasked: string;
  /** True once a one-time code confirmed the number. No SMS provider exists yet, so this stays false outside development. */
  phoneVerified: boolean;
  /** The language the store writes to the customer in (messages, receipts). The site's language comes from the URL. */
  locale: Locale;
  createdAt: number;
};

export type AddressView = {
  id: string;
  label: string | null;
  recipientName: string | null;
  phoneE164: string | null;
  governorateId: string;
  governorateName: string;
  districtId: string | null;
  districtName: string | null;
  areaText: string | null;
  addressText: string;
  notes: string | null;
  isDefault: boolean;
};

/** Governorates with their districts, for the address form (no-script: districts grouped per governorate). */
export type GeographyOption = { id: string; name: string; districts: { id: string; name: string }[] };

/** A device model a customer can say they own (saved devices). */
export type DeviceOption = {
  id: string;
  slug: string;
  name: string;
  platformSlug: string;
  platformName: string;
  /** Official product photo key ("<slug>--<n>") or null. */
  artKey: string | null;
  kind: string;
};

export type NotificationChannel = "sms" | "whatsapp" | "email";
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ["sms", "whatsapp", "email"];

export type AccountPreferences = {
  /** What the customer asked for per channel. Saved even though no provider can deliver yet (see `providers`). */
  channels: Record<NotificationChannel, boolean>;
  /** Which channels have a delivery provider configured. None today: messages are held, never reported as sent. */
  providers: Record<NotificationChannel, boolean>;
  /** Latest answer; null = never asked. Marketing is never assumed. */
  marketing: boolean | null;
  /** Recently viewed and personal suggestions. null = never asked. */
  personalization: boolean | null;
};

export type NotificationView = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  /** Locale-less path inside the store, or null. */
  link: string | null;
  readAt: number | null;
  createdAt: number;
};

export const TOPUP_METHODS = ["bank_transfer", "zaincash"] as const;
export type TopupMethod = (typeof TOPUP_METHODS)[number];
export type TopupStatus = "pending_verification" | "approved" | "rejected" | "cancelled";

/** A wallet top-up request as its owner sees it. Duplicate-proof flags and the reviewer's identity are staff-only. */
export type TopupView = {
  id: string;
  ref: string;
  method: "bank_transfer" | "zaincash" | "cash";
  /** What the customer said they sent. */
  declaredAmountIqd: number | null;
  /** What was (or will be, once approved) credited. */
  amountIqd: number;
  reference: string | null;
  status: TopupStatus;
  /** The store's reason, when it rejected the request. */
  rejectReason: string | null;
  createdAt: number;
  verifiedAt: number | null;
  /** Locale-less path of the private proof preview (only its owner can open it). */
  proofPath: string | null;
};

export type TopupDestinations = {
  bankTransfer: { enabled: boolean; accountNumber: string; recipientName: string };
  zaincash: { enabled: boolean; number: string };
};

export type WarrantyView = {
  id: string;
  orderRef: string | null;
  itemName: string;
  startsAt: number;
  endsAt: number;
  state: "active" | "expired" | "void";
  terms: string | null;
};

export type ReturnRequestView = {
  rma: string;
  orderRef: string | null;
  status: string;
  reasonCode: string | null;
  requestedResolution: string | null;
  resolution: string | null;
  rejectReason: string | null;
  createdAt: number;
};

/** A delivered order still inside the store's general return window. */
export type ReturnableOrder = { ref: string; deliveredAt: number; windowEndsAt: number; firstItemName: string; itemCount: number };

/** Numbers for the account overview and the section list. */
export type AccountCounts = {
  orders: number;
  openOrders: number;
  addresses: number;
  savedDevices: number;
  unreadNotifications: number;
  wishlist: number;
  pendingTopups: number;
};

/** How one-time codes can reach the customer here: never by SMS today (no provider), in development on screen. */
export type CodeDelivery = "provider" | "dev" | "unavailable";
