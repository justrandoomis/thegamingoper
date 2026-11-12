/**
 * Admin module 21 "channels" — branches, sales channels and integrations (docs/areas/admin-channels.md). Client-safe:
 * constants, URL state, the API and webhook vocabulary and the view models that the services
 * (app/server/services/admin/channels/*.server.ts) return and the pages (app/routes/admin/channels) render. No server
 * imports here: route components import this file. Ranges and typed digits reuse finance's client-safe helpers.
 */
import { latinDigits, parseRange, rangeSearch, type RangeFilter } from "../finance/types";

export { latinDigits, parseRange, rangeSearch, type RangeFilter };

export const CHANNELS_NS = "admin-channels";

/** The module's own failure codes (texts: admin-channels → errors.*). */
export const CHANNELS_ERROR_KEYS = [
  "branch_changed",
  "branch_in_use",
  "code_taken",
  "channel_changed",
  "channel_system",
  "channel_in_use",
  "key_taken",
  "scope_not_held",
  "api_key_revoked",
  "api_key_replayed",
  "webhook_changed",
  "webhook_inactive",
  "delivery_not_retryable",
  "data_key_missing",
  "provider_unknown",
  "integration_changed",
  "credentials_missing",
  "nothing_changed",
  "idempotency_mismatch",
  "orders_read_required",
] as const;
export type ChannelsErrorKey = (typeof CHANNELS_ERROR_KEYS)[number];

/** Field keys the module's forms can show (texts: admin-channels → field.*). */
export const CHANNELS_FIELD_KEYS = [
  "required",
  "too_long",
  "code_invalid",
  "key_invalid",
  "key_reserved",
  "phone_invalid",
  "district_mismatch",
  "not_found",
  "reason_required",
  "scope_required",
  "scope_unknown",
  "expiry_invalid",
  "rate_invalid",
  "url_invalid",
  "url_https",
  "url_host",
  "url_port",
  "url_credentials",
  "events_required",
  "event_unknown",
  "secret_required",
  "value_invalid",
] as const;

// ───────────────────────────────────────────────────────────────── branches and channels (21.01, 21.06)

/** "BGD-1", "ERB": upper-case letters, digits and dashes, 2–16 characters (typed in lower case is accepted). */
export const BRANCH_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,15}$/;
/** "noon", "instagram_shop": lower-case letters, digits and underscores, 2–24 characters, starting with a letter. */
export const CHANNEL_KEY_PATTERN = /^[a-z][a-z0-9_]{1,23}$/;
/** The two built-in channels: they match `orders.channel`, and nothing here switches them off. */
export const SYSTEM_CHANNEL_KEYS = ["web", "pos"] as const;
export type SystemChannelKey = (typeof SYSTEM_CHANNEL_KEYS)[number];
/** Kinds a person can add: an outside marketplace or social selling. "online" and "pos" are the built-in ones. */
export const NEW_CHANNEL_KINDS = ["marketplace", "social"] as const;
export type NewChannelKind = (typeof NEW_CHANNEL_KINDS)[number];
export const CHANNEL_KIND_LIST = ["online", "pos", "marketplace", "social"] as const;
export type ChannelKindName = (typeof CHANNEL_KIND_LIST)[number];

export const BRANCH_VIEWS = ["active", "inactive", "all"] as const;
export type BranchView = (typeof BRANCH_VIEWS)[number];

export function parseBranchView(params: URLSearchParams): BranchView {
  const view = params.get("view");
  return (BRANCH_VIEWS as readonly string[]).includes(view ?? "") ? (view as BranchView) : "active";
}

// ───────────────────────────────────────────────────────────────── API keys and the read API (21.03)

/**
 * What a key may be given: the permissions the API's read endpoints check, nothing else. A person gives a key only
 * scopes they hold themselves (the hierarchy rule of docs/SECURITY.md §7).
 */
export const API_SCOPES = ["catalog.product.read", "inventory.stock.read", "orders.order.read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export type ApiEndpoint = { path: string; resource: "products" | "stock" | "orders"; scope: ApiScope; params: readonly string[] };
/** The read-only endpoints (GET only). Never cost, profit, customers' names, phones or addresses. */
export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  { path: "/api/v1/products", resource: "products", scope: "catalog.product.read", params: ["cursor", "limit"] },
  { path: "/api/v1/stock", resource: "stock", scope: "inventory.stock.read", params: ["sku", "cursor", "limit"] },
  { path: "/api/v1/orders", resource: "orders", scope: "orders.order.read", params: ["since", "cursor", "limit"] },
];
export const API_PAGE_DEFAULT = 50;
export const API_PAGE_MAX = 100;
/** Requests per minute a key may make (its own limit, chosen at creation) and the ceiling. */
export const API_RATE_DEFAULT = 60;
export const API_RATE_MAX = 600;
/** Requests per minute from one network before any key is checked (guessing, floods). */
export const API_IP_RATE = 120;
/** A key always expires; these are the choices (days). */
export const API_EXPIRY_CHOICES = [30, 90, 180, 365] as const;
export const API_EXPIRY_DEFAULT = 90;
/** Keys look like "ttk_<8 characters>_<43 characters>"; the first part is the prefix shown in lists. */
export const API_KEY_PREFIX = "ttk_";

/**
 * "suspended": the key's creator could no longer make it — the account is disabled or limited to a branch — so it does
 * not work (the hierarchy rule, docs/SECURITY.md §7); it works again if the account does, or is revoked.
 */
export type ApiKeyState = "active" | "suspended" | "expired" | "revoked";
export const API_KEY_STATE_TONE: Record<ApiKeyState, Tone> = { active: "ok", suspended: "bad", expired: "warn", revoked: "out" };

// ───────────────────────────────────────────────────────────────── webhooks (21.03, 21.04)

/** Events a webhook can subscribe to — each one is an order event of the commerce core ("ping" is the test event). */
export const WEBHOOK_EVENTS = ["order.placed", "order.confirmed", "order.shipped", "order.delivered", "order.cancelled", "order.returned"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const PING_EVENT = "ping";

export const DELIVERY_STATUS_LIST = ["pending", "succeeded", "failed", "gave_up"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUS_LIST)[number];
export const DELIVERY_TONE: Record<DeliveryStatus, Tone> = { pending: "info", succeeded: "ok", failed: "warn", gave_up: "bad" };
/** Attempts before a delivery is given up, and the waits (minutes) before attempts 2, 3, 4, 5, 6. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
export const WEBHOOK_BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;
/** A claimed attempt that never reported back is free again after this long. */
export const WEBHOOK_CLAIM_MS = 10 * 60_000;
/** Order events older than this are never queued (a webhook only hears what happens after it was created). */
export const WEBHOOK_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
export const WEBHOOK_URL_MAX = 500;

export type DeliveryFilters = { status: DeliveryStatus | null; webhook: string | null; page: number };

export function parseDeliveryFilters(params: URLSearchParams): DeliveryFilters {
  const status = params.get("status");
  const webhook = params.get("webhook");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    status: (DELIVERY_STATUS_LIST as readonly string[]).includes(status ?? "") ? (status as DeliveryStatus) : null,
    webhook: webhook && /^[A-Za-z0-9_-]{1,64}$/.test(webhook) ? webhook : null,
    page: Number.isFinite(page) && page >= 1 && page <= 1000 ? page : 1,
  };
}

export function deliverySearch(filters: Partial<DeliveryFilters>): string {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.webhook) params.set("webhook", filters.webhook);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const DELIVERY_PAGE_SIZE = 25;

// ───────────────────────────────────────────────────────────────── providers (21.05)

export const PROVIDER_KINDS = ["payment", "shipping", "messaging"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * A provider's form: settings that are not secret (kept readable) and the one secret (encrypted, never shown again).
 * `url`: an address the adapter to come would call — kept only as https on 443 with a public host name, the webhook
 * rule (checkWebhookUrl); the adapter must still check the resolved addresses (isPublicAddress).
 */
export type ProviderField = { key: string; ltr?: boolean; max: number; url?: true };
export type ProviderDef = {
  /** Stable key: integrations.provider. */
  key: string;
  kind: ProviderKind;
  /** The provider's own name (Latin), shown as written. */
  name: string;
  /** Non-secret settings. */
  fields: readonly ProviderField[];
  /** Outbox channels the provider would carry (messaging). */
  carries?: readonly ("sms" | "whatsapp" | "email")[];
};

/**
 * Providers that operate in Iraq and that the store could connect — a starting list, not an endorsement. NOTHING here
 * is connected: no adapter that talks to any of them is built, so every one stays "not connected" whatever is saved.
 * Couriers are the store's own carriers (module 11), added at run time.
 */
export const PROVIDER_CATALOG: readonly ProviderDef[] = [
  { key: "zaincash", kind: "payment", name: "Zain Cash", fields: [{ key: "merchantId", ltr: true, max: 80 }, { key: "msisdn", ltr: true, max: 20 }] },
  { key: "qicard", kind: "payment", name: "Qi Card", fields: [{ key: "merchantId", ltr: true, max: 80 }] },
  { key: "fastpay", kind: "payment", name: "FastPay", fields: [{ key: "merchantId", ltr: true, max: 80 }] },
  { key: "asiahawala", kind: "payment", name: "AsiaHawala", fields: [{ key: "merchantId", ltr: true, max: 80 }] },
  { key: "sms_gateway", kind: "messaging", name: "SMS", fields: [{ key: "senderId", ltr: true, max: 20 }, { key: "endpoint", ltr: true, max: 200, url: true }], carries: ["sms"] },
  { key: "whatsapp_cloud", kind: "messaging", name: "WhatsApp Business Platform", fields: [{ key: "phoneNumberId", ltr: true, max: 40 }, { key: "businessAccountId", ltr: true, max: 40 }], carries: ["whatsapp"] },
  { key: "email_service", kind: "messaging", name: "Email", fields: [{ key: "fromAddress", ltr: true, max: 120 }, { key: "endpoint", ltr: true, max: 200, url: true }], carries: ["email"] },
];

/** "carrier:<carrier id>" — a courier of module 11 as a shipping provider. */
export const CARRIER_PROVIDER_PREFIX = "carrier:";
export const CARRIER_FIELDS: readonly ProviderField[] = [{ key: "accountId", ltr: true, max: 80 }, { key: "endpoint", ltr: true, max: 200, url: true }];

/** What a provider row can say about itself — never "connected" while no adapter exists. */
export type ProviderState = "not_connected" | "credentials_saved";

// ───────────────────────────────────────────────────────────────── shared view models

export type Tone = "ok" | "warn" | "info" | "bad" | "out" | "soon";

export type PersonRef = { id: string; name: string } | null;

/** An admin link with what the employee may open: `href` only when they may. */
export type SourceLink = { href: string | null; permission: string };

export type ChannelsAccess = {
  branches: boolean;
  channels: boolean;
  apiKeys: boolean;
  webhooks: boolean;
  monitor: boolean;
  providers: boolean;
  profit: boolean;
  orders: boolean;
  cost: boolean;
  profitFields: boolean;
};

export type BranchRow = {
  id: string;
  code: string;
  name: string;
  nameAr: string;
  nameEn: string;
  governorate: string | null;
  district: string | null;
  phone: string | null;
  isActive: boolean;
  createdAt: number;
  locations: number;
  registers: number;
  employees: number;
  priceLists: number;
};

export type BranchDetail = BranchRow & {
  governorateId: string | null;
  districtId: string | null;
  addressText: string | null;
  hoursAr: string;
  hoursEn: string;
  /** What a save must still match (stale forms are refused). */
  fingerprint: string;
  usage: {
    locations: { id: string; code: string; name: string; kind: string; isSellable: boolean; isActive: boolean }[] | null;
    stock: { skus: number; onHand: number; available: number } | null;
    registers: { id: string; code: string; name: string; isActive: boolean }[] | null;
    employees: { id: string; name: string; status: string }[] | null;
    priceLists: { id: string; code: string; name: string; isActive: boolean }[] | null;
    sales: { orders: number; totalIqd: number; from: string; to: string } | null;
  };
  /** Records that stop the branch from being switched off (active ones), whatever the viewer may read. */
  inUse: { locations: number; registers: number; employees: number; priceLists: number };
  links: { locations: string | null; registers: string | null; employees: string | null; priceLists: string | null; sales: string | null };
};

export type ChannelRules = {
  /** Where the channel's stock comes from. */
  stock: { kind: "sellable_locations"; locations: number } | { kind: "register_stores"; stores: number; registers: number } | { kind: "none" };
  /** Price lists scoped to the channel and whether the channel's sales use them today. */
  prices: { activeLists: number; applied: boolean };
  /** Delivery: the governorate fee rule for the online store, none at the counter, not connected for the others. */
  delivery: { kind: "governorate_fee"; flatFeeIqd: number; overridesEnabled: boolean } | { kind: "counter" } | { kind: "not_connected" };
};

export type ChannelRow = {
  id: string;
  key: string;
  name: string;
  nameAr: string;
  nameEn: string;
  kind: ChannelKindName;
  isSystem: boolean;
  isActive: boolean;
  /** Orders can arrive from it: the two built-in channels only (no marketplace is connected). */
  connected: boolean;
  rules: ChannelRules;
  fingerprint: string;
};

export type ChannelOrderSummary = {
  key: string;
  name: string;
  connected: boolean;
  placed: number;
  open: number;
  delivered: number;
  cancelled: number;
  returned: number;
  /** Σ total of the orders placed in the range that are not cancelled (docs/metrics.md §3, a pipeline figure). */
  gmvIqd: number;
  /** Σ (subtotal − discount) ÷ orders not cancelled; null when there are none. */
  averageBasketIqd: number | null;
  lastPlacedAt: number | null;
  /** Where the orders are listed. */
  list: string | null;
};

export type ChannelProfitRow = {
  key: string;
  name: string;
  connected: boolean;
  /** Orders whose sale was recognised (delivered) in the range. */
  ordersRecognised: number;
  grossIqd: number;
  discountsIqd: number;
  refundsIqd: number;
  netRevenueIqd: number;
  shippingIncomeIqd: number;
  /** cost.read — the keys are ABSENT without it (never null-masked, never 0). */
  cogsIqd?: number;
  shippingCostsIqd?: number;
  uncostedUnits?: number;
  /** cost.read AND profit.read — absent without them. Margins are null when net revenue is 0. */
  grossProfitIqd?: number;
  grossMarginBps?: number | null;
  /** Gross profit − (shipping costs − shipping income): what the channel leaves before store-wide costs. */
  contributionIqd?: number;
  contributionMarginBps?: number | null;
  /** POS by branch (the register's branch); empty for the others. */
  branches: { branchId: string | null; name: string | null; ordersRecognised: number; netRevenueIqd: number; cogsIqd?: number; grossProfitIqd?: number }[];
};

export type ChannelProfitability = {
  range: { from: string; to: string; demo: boolean };
  rows: ChannelProfitRow[];
  /** Postings of the same accounts that no channel can be named for (manual entries, expenses, payroll). */
  unattributed: { grossIqd: number; discountsIqd: number; refundsIqd: number; shippingIncomeIqd: number; cogsIqd?: number; shippingCostsIqd?: number };
  /** Commissions are booked with payroll runs, store-wide (docs/metrics.md §4). cost.read AND profit.read. */
  commissionsIqd?: number;
  /** The finance core's figures for the same range — the channels add up to them. */
  store: { netRevenueIqd: number; cogsIqd?: number; netProfitIqd?: number; netMarginBps?: number | null };
  fields: { cost: boolean; profit: boolean };
};
