/**
 * Admin module 08 — Promotions & loyalty: client-safe constants, URL filters, digit and time parsing, and the view
 * models the screens render. Pure: no database, no server imports (route components import it).
 *
 *   const filters = parseCouponFilters(new URL(request.url).searchParams);   // view, q, sort, page
 *   <Link to={`/admin/promotions/coupons${couponSearch({ ...filters, page: 2 })}`}>
 *   parseWhole("١٢٬٥٠٠") === 12_500 · parsePercentBps("12.5") === 1_250 · fromBaghdadInput("2026-11-20T18:00")
 *
 * The rules that decide (who approves what, how a discount rule would apply, how points expire) are in ./rules.ts.
 */
import type { L10n } from "~/lib/locales";

export const PROMOTIONS_NS = "admin-promotions";
export const PAGE_SIZE = 25;
export const DAY_MS = 86_400_000;
/** Asia/Baghdad is UTC+3 all year (no daylight saving). */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

export type Tone = "ok" | "warn" | "info" | "bad" | "out" | "soon" | "neutral";

// ───────────────────────────────────────────────────────────────── limits (module constants; settings keys requested)

/** Coupons and automatic rules: beyond these a second person (pricing.discount.override) approves the terms. */
export const DISCOUNT_LIMITS = {
  /** A percentage above this (basis points) — 20 %. */
  percentBps: 2_000,
  /** The most one order can get (a fixed amount, or a percentage's ceiling) above this — 50,000 IQD. */
  perOrderIqd: 50_000,
} as const;

/** The loyalty programme (08.04). */
export const LOYALTY = {
  /** Points earned per 1,000 IQD of goods paid and kept (shipping excluded). */
  pointsPerThousandIqd: 1,
  /** What one point is worth when it is redeemed at checkout (once the core applies points). */
  pointValueIqd: 10,
  /** Earned points expire this many days after they are posted (first in, first out). */
  expiryDays: 365,
  /** A manual adjustment of more points than this is decided by a second person. */
  adjustSecondPersonPoints: 5_000,
  /**
   * What one employee may GIVE alone in 24 hours (manual credits, summed): small adjustments cannot be split under
   * the limit above. Beyond it the adjustment waits for a second person; taking points back is never capped here.
   */
  adjustSoloDayPoints: 10_000,
  maxAdjustPoints: 100_000,
  /** Orders handled per "post points" run (D1 statement limits). */
  syncBatchOrders: 200,
} as const;

/** Referrals (08.05). */
export const REFERRAL = {
  /** Points posted to the referrer when a referral is rewarded. */
  rewardPoints: 500,
  /** Successful referrals one code may bring, unless staff set another cap. */
  defaultMaxUses: 10,
  maxUsesCap: 100,
  /** Sign-ins this recent count for the "same device" signal. */
  deviceWindowDays: 90,
} as const;

/** Gift cards (08.07). Amounts in IQD. */
export const GIFT_CARD = {
  minIqd: 5_000,
  maxIqd: 1_000_000,
  stepIqd: 1_000,
  /** A card above this is issued only after a second person approves it. */
  soloIqd: 100_000,
  /** What one employee may issue alone in 24 hours (no splitting a large card into small ones). */
  soloDayIqd: 250_000,
  maxValidDays: 730,
  /** Reveals of a code per employee. */
  revealLimit: { limit: 20, windowSec: 10 * 60 },
  /** Wrong codes typed at redemption per employee (guessing). */
  missLimit: { limit: 10, windowSec: 10 * 60 },
} as const;

/** A constant's shape with its numbers widened (the value in force may differ from the constant). */
type Widened<T> = { readonly [K in keyof T]: T[K] extends number ? number : T[K] };
/**
 * The programme rules in force (module follow-up 2026-11-12): the settings promotions.discount_limits, .loyalty,
 * .referral and .gift_card (app/server/settings.server.ts) in the constants' shapes — program.server.ts programRules.
 * The constants above are their defaults; the technical limits (batch sizes, rate limits, the step, the cap on a
 * code's uses) stay constants.
 */
export type DiscountLimits = Widened<typeof DISCOUNT_LIMITS>;
export type LoyaltyRules = Widened<typeof LOYALTY>;
export type ReferralRules = Widened<typeof REFERRAL>;
export type GiftCardRules = Widened<typeof GIFT_CARD>;
export type ProgramRules = { limits: DiscountLimits; loyalty: LoyaltyRules; referral: ReferralRules; giftCard: GiftCardRules };
/** The defaults (the constants) — what a page shows before its layout's data arrives. */
export const DEFAULT_PROGRAM: ProgramRules = { limits: DISCOUNT_LIMITS, loyalty: LOYALTY, referral: REFERRAL, giftCard: GIFT_CARD };

/** Flash sales (08.03). */
export const FLASH = { maxItems: 60, maxDays: 14, maxAllowance: 10_000, maxPerCustomer: 20 } as const;

/** A/B tests (08.08). */
export const EXPERIMENT = { minSampleDefault: 30, minSampleFloor: 10, minSampleCap: 10_000, maxVariants: 4, maxDays: 90 } as const;

// ───────────────────────────────────────────────────────────────── coupons (08.01)

export const COUPON_STATES = ["pending", "live", "scheduled", "off", "expired", "exhausted"] as const;
export type CouponState = (typeof COUPON_STATES)[number];
export const COUPON_STATE_TONE: Record<CouponState, Tone> = { pending: "warn", live: "ok", scheduled: "soon", off: "out", expired: "out", exhausted: "info" };

export const COUPON_VIEWS = ["all", "live", "scheduled", "pending", "off", "ended"] as const;
export type CouponView = (typeof COUPON_VIEWS)[number];
export const COUPON_SORTS = ["newest", "code", "uses", "ends"] as const;
export type CouponSort = (typeof COUPON_SORTS)[number];

export const CHANNELS = ["web", "pos"] as const;
export type Channel = (typeof CHANNELS)[number];
export const PRODUCT_KIND_OPTIONS = ["console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const;

/** Why a coupon's or a rule's terms need a second person. */
export const APPROVAL_REASONS = ["percent_over", "amount_over", "uncapped", "no_limits"] as const;
export type ApprovalReason = (typeof APPROVAL_REASONS)[number];

/** The money terms of a coupon (what an approval approves). Conditions narrow who gets it. */
export type CouponConditionsView = {
  platformIds: string[];
  categoryIds: string[];
  productIds: string[];
  productKinds: string[];
  segmentIds: string[];
  channels: string[];
  firstOrderOnly: boolean;
  minQty: number | null;
};
export type CouponTerms = {
  kind: "fixed" | "percent";
  value: number;
  minSubtotalIqd: number | null;
  maxDiscountIqd: number | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  startsAt: number | null;
  endsAt: number | null;
  conditions: CouponConditionsView;
};

export type CouponFilters = { view: CouponView; q: string; sort: CouponSort; page: number };

export type CouponRow = {
  id: string;
  code: string;
  kind: "fixed" | "percent";
  value: number;
  state: CouponState;
  isActive: boolean;
  description: string | null;
  used: number;
  usageLimit: number | null;
  discountGivenIqd: number;
  startsAt: number | null;
  endsAt: number | null;
  createdAt: number;
  isDemo: boolean;
  pending: boolean;
};

export type CouponPage = { rows: CouponRow[]; total: number; page: number; pageCount: number; counts: Partial<Record<CouponView, number>> };

export type PendingChange = {
  approvalId: string;
  action: "create" | "update" | "activate";
  requestedBy: string;
  requestedByName: string | null;
  requestedAt: number;
  reason: string | null;
  reasons: ApprovalReason[];
  terms: CouponTerms | null;
  mine: boolean;
  canDecide: boolean;
};

export type RedemptionRow = { id: string; orderRef: string | null; orderStatus: string | null; customer: string | null; phone: { display: string; full: boolean } | null; amountIqd: number; at: number; voidedAt: number | null };

export type CouponDetail = {
  id: string;
  code: string;
  description: string | null;
  isActive: boolean;
  isDemo: boolean;
  state: CouponState;
  terms: CouponTerms;
  fingerprint: string;
  createdAt: number;
  createdBy: string | null;
  used: number;
  voided: number;
  discountGivenIqd: number;
  approvalReasons: ApprovalReason[];
  approvedTerms: boolean;
  pending: PendingChange | null;
  redemptions: RedemptionRow[];
  history: HistoryRow[];
  can: { manage: boolean; decide: boolean };
};

export type HistoryRow = { id: string; at: number; action: string; actor: string | null; reason: string | null };

/** What the condition pickers offer. */
export type ConditionOptions = {
  platforms: { id: string; name: string }[];
  categories: { id: string; name: string; depth: number }[];
  segments: { id: string; name: string; members: number }[];
};

// ───────────────────────────────────────────────────────────────── automatic discount rules (08.02)

export const RULE_KINDS = ["percent", "fixed", "tiered", "bogo", "free_shipping"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const RULE_STATES = ["pending", "live", "scheduled", "off", "expired"] as const;
export type RuleState = (typeof RULE_STATES)[number];
export const RULE_STATE_TONE: Record<RuleState, Tone> = { pending: "warn", live: "ok", scheduled: "soon", off: "out", expired: "out" };
export const RULE_VIEWS = ["all", "live", "scheduled", "pending", "off", "ended"] as const;
export type RuleView = (typeof RULE_VIEWS)[number];
export const DRY_RUN_DAYS = [7, 30, 90] as const;
export const DRY_RUN_MAX_ORDERS = 2_000;

export type RuleScope = {
  platformIds: string[];
  categoryIds: string[];
  productKinds: string[];
  segmentIds: string[];
  channels: string[];
  minSubtotalIqd: number | null;
  minQty: number | null;
};
export type RuleTier = { minQty: number; bps: number };
export type RuleTerms = {
  kind: RuleKind;
  /** percent: basis points; fixed: IQD; others: null. */
  value: number | null;
  tiers: RuleTier[];
  bogo: { buy: number; get: number } | null;
  maxDiscountIqd: number | null;
  stackable: boolean;
  priority: number;
  startsAt: number | null;
  endsAt: number | null;
  scope: RuleScope;
};

export type RuleFilters = { view: RuleView; q: string; page: number };
export type RuleRow = { id: string; name: string; kind: RuleKind; value: number | null; state: RuleState; isActive: boolean; startsAt: number | null; endsAt: number | null; stackable: boolean; priority: number; isDemo: boolean; pending: boolean };
export type RulePage = { rows: RuleRow[]; total: number; page: number; pageCount: number; counts: Partial<Record<RuleView, number>> };

/** Why a recent order would not have been changed by a rule. */
export const DRY_RUN_SKIPS = ["channel", "segment", "no_lines", "min_subtotal", "min_qty", "no_tier", "coupon_better", "not_in_window"] as const;
export type DryRunSkip = (typeof DRY_RUN_SKIPS)[number];

export type DryRunOrder = { ref: string; placedAt: number; channel: string; subtotalIqd: number; existingDiscountIqd: number; ruleDiscountIqd: number; changeIqd: number; shippingIqd: number; isDemo: boolean };
export type DryRun = {
  days: number;
  includeDemo: boolean;
  scanned: number;
  truncated: boolean;
  demoLeftOut: number;
  changed: number;
  discountIqd: number;
  shippingDiscountIqd: number;
  subtotalOfChangedIqd: number;
  skips: Partial<Record<DryRunSkip, number>>;
  orders: DryRunOrder[];
  /** [P] Only with cost.read + profit.read: the margin of the changed orders before and after; null margins when a cost is unknown. */
  margin?: { revenueBeforeIqd: number; revenueAfterIqd: number; costIqd: number | null; marginBeforeBps: number | null; marginAfterBps: number | null; uncostedLines: number };
};

export type RuleDetail = {
  id: string;
  name: L10n;
  description: L10n | null;
  isActive: boolean;
  isDemo: boolean;
  state: RuleState;
  terms: RuleTerms;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  approvalReasons: ApprovalReason[];
  approvedTerms: boolean;
  pending: PendingChange | null;
  history: HistoryRow[];
  can: { manage: boolean; decide: boolean };
};

// ───────────────────────────────────────────────────────────────── flash sales (08.03)

export const FLASH_STATES = ["draft", "pending", "scheduled", "active", "ended", "cancelled"] as const;
export type FlashState = (typeof FLASH_STATES)[number];
export const FLASH_STATE_TONE: Record<FlashState, Tone> = { draft: "neutral", pending: "warn", scheduled: "soon", active: "ok", ended: "out", cancelled: "out" };
export const FLASH_VIEWS = ["all", "draft", "pending", "scheduled", "active", "ended"] as const;
export type FlashView = (typeof FLASH_VIEWS)[number];
export type FlashFilters = { view: FlashView; page: number };

export type FlashRow = { id: string; slug: string; name: string; state: FlashState; startsAt: number; endsAt: number; items: number; allowance: number | null; sold: number; isDemo: boolean };
export type FlashPage = { rows: FlashRow[]; total: number; page: number; pageCount: number; counts: Partial<Record<FlashView, number>> };

/**
 * Pricing (03)'s reasons a price needs a second person — the flash price is checked by the same rules, with pricing's
 * field rule: without cost.read + profit.read the reasons that reveal a cost (under the cost or the minimum margin, no
 * cost known), "needs the override" and the floor are absent; `needsApproval` then says only what the visible reasons
 * say, and the server decides the rest when the sale is submitted.
 */
export type FlashItemCheck = {
  needsApproval: boolean;
  /** [P] profit.read only. */
  needsOverride?: boolean;
  /** Pricing's reasons this person may see. */
  reasons: string[];
  /** The cut from today's price, in basis points. */
  dropBps: number | null;
  /** The highest price of the last 30 days (pricing's drop window — public): the approval limit counts from it. */
  referencePriceIqd: number;
  /** The cut measured from that price, in basis points. */
  referenceDropBps: number | null;
  /** [P] profit.read: the lowest price without an override. */
  floorIqd?: number | null;
  /** [P] profit.read: margins at today's price and at the flash price. */
  marginBeforeBps?: number | null;
  marginAfterBps?: number | null;
};

export type FlashItemView = {
  id: string;
  variantId: string;
  sku: string;
  name: string;
  priceIqd: number;
  salePriceIqd: number;
  qtyLimit: number | null;
  qtySold: number;
  perCustomerLimit: number | null;
  available: number;
  /** min(allowance left, units available): what the sale can still sell at the flash price. */
  canSell: number;
  problems: ("price_not_lower" | "allowance_over_stock" | "variant_inactive" | "overlap")[];
  check: FlashItemCheck;
};

export type FlashDetail = {
  id: string;
  slug: string;
  name: L10n;
  state: FlashState;
  storedStatus: string;
  startsAt: number;
  endsAt: number;
  isDemo: boolean;
  createdBy: string | null;
  createdAt: number;
  items: FlashItemView[];
  /** What the visible reasons say (the server's own verdict only with profit.read). */
  needsApproval: boolean;
  /** [P] profit.read only. */
  needsOverride?: boolean;
  /** True without profit.read: rules this person may not see might apply — the server decides at submit. */
  decidedOnSubmit: boolean;
  /** `needsOverride` [P] profit.read only. */
  pending: (PendingChange & { needsOverride?: boolean }) | null;
  history: HistoryRow[];
  withCost: boolean;
  withProfit: boolean;
  can: { manage: boolean; decide: boolean; override: boolean };
};

// ───────────────────────────────────────────────────────────────── loyalty (08.04)

export const LOYALTY_KINDS = ["earn", "redeem", "expire", "adjust", "reversal"] as const;
export type LoyaltyKind = (typeof LOYALTY_KINDS)[number];
export const LOYALTY_KIND_TONE: Record<LoyaltyKind, Tone> = { earn: "ok", redeem: "info", expire: "out", adjust: "neutral", reversal: "warn" };
export type LedgerFilters = { kind: LoyaltyKind | null; customer: string | null; page: number };

export type LedgerRow = { id: string; at: number; kind: LoyaltyKind; points: number; customerId: string; customer: string | null; phone: { display: string; full: boolean } | null; refType: string | null; refLabel: string | null; reason: string | null; expiresAt: number | null; actor: string | null };
export type LedgerPage = { rows: LedgerRow[]; total: number; page: number; pageCount: number };

export type LoyaltyOverview = {
  outstandingPoints: number;
  outstandingValueIqd: number;
  members: number;
  earned30d: number;
  expiringPoints30d: number;
  /** Delivered orders past their return window that have not earned yet (what "post points" would do). */
  ordersWaiting: number;
  /** Orders whose refunds came after they earned and whose points are not reversed yet. */
  reversalsWaiting: number;
  /** Customers holding points that expired but have no expiry row yet. */
  expiryWaiting: number;
  returnWindowDays: number;
};

export type CustomerPoints = {
  customerId: string;
  name: string | null;
  phone: { display: string; full: boolean } | null;
  status: string;
  balance: number;
  valueIqd: number;
  expiringSoon: number;
  multiplierBps: number | null;
  entries: LedgerRow[];
  pending: PendingAdjustment[];
  canAdjust: boolean;
  canSeeProfile: boolean;
};

export type PendingAdjustment = { approvalId: string; points: number; reason: string | null; requestedBy: string | null; requestedAt: number; mine: boolean; canDecide: boolean };

// ───────────────────────────────────────────────────────────────── referrals (08.05)

export const REFERRAL_STATUSES = ["pending", "qualified", "rewarded", "rejected"] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const REFERRAL_STATUS_TONE: Record<ReferralStatus, Tone> = { pending: "warn", qualified: "info", rewarded: "ok", rejected: "out" };
/** Signals for the reviewer (never decided by a machine): */
export const REFERRAL_SIGNALS = ["same_address", "same_device", "existing_customer", "order_missing", "order_not_delivered", "order_in_return_window", "order_cancelled"] as const;
export type ReferralSignal = (typeof REFERRAL_SIGNALS)[number];
export const REFERRAL_VIEWS = ["review", "rewarded", "rejected", "all"] as const;
export type ReferralView = (typeof REFERRAL_VIEWS)[number];
export type ReferralFilters = { view: ReferralView; page: number };

export type ReferralCodeRow = { id: string; code: string; customerId: string; customer: string | null; phone: { display: string; full: boolean } | null; uses: number; maxUses: number | null; isActive: boolean; createdAt: number };
export type ReferralRow = {
  id: string;
  code: string;
  referrer: string | null;
  referrerId: string;
  referredPhone: { display: string; full: boolean };
  referred: string | null;
  orderRef: string | null;
  status: ReferralStatus;
  rejectReason: string | null;
  createdAt: number;
  rewardedAt: number | null;
  signals: ReferralSignal[];
  qualifies: boolean;
  recordedBy: string | null;
  recordedByMe: boolean;
};
export type ReferralsPage = { codes: ReferralCodeRow[]; codeTotal: number; rows: ReferralRow[]; total: number; page: number; pageCount: number; counts: Partial<Record<ReferralView, number>>; can: { manage: boolean } };

// ───────────────────────────────────────────────────────────────── VIP memberships (08.06)

export type TierBenefits = { discountBps: number | null; freeShipping: boolean; pointsMultiplierBps: number | null; earlyAccess: boolean; notes: L10n | null };
export type TierRow = { id: string; key: string; name: L10n; benefits: TierBenefits; durationDays: number | null; sort: number; isActive: boolean; members: number; fingerprint: string };
export type MemberRow = { id: string; customerId: string; customer: string | null; phone: { display: string; full: boolean } | null; tierId: string; tier: string; status: "active" | "expired" | "cancelled"; startsAt: number; endsAt: number | null; source: string; grantedBy: string | null };
export type EligibleRow = { customerId: string; customer: string | null; phone: { display: string; full: boolean } | null; flags: { id: string; vars: Record<string, string | number> }[] };
/** The members list: "current" = active and not past its end (what the front page counts), "ended" = everything else. */
export const MEMBER_VIEWS = ["current", "ended"] as const;
export type MemberView = (typeof MEMBER_VIEWS)[number];
export type VipFilters = { members: MemberView; page: number };
/** `memberTotal` is the number of rows of the chosen view (the list pages through exactly those). */
export type VipPage = {
  tiers: TierRow[];
  members: MemberRow[];
  memberView: MemberView;
  memberTotal: number;
  memberCounts: Record<MemberView, number>;
  page: number;
  pageCount: number;
  endedWaiting: number;
  eligible: EligibleRow[];
  eligibleTotal: number;
  /** Module 07's VIP rule in force (the setting customers.flag_rules — review 2026-11-12), as the page states it. */
  rule: { spendIqd: number; purchases: number; windowDays: number };
  can: { manage: boolean; seeProfiles: boolean };
};

// ───────────────────────────────────────────────────────────────── gift cards (08.07)

export const GIFT_CARD_STATUSES = ["active", "redeemed", "void", "expired"] as const;
export type GiftCardStatus = (typeof GIFT_CARD_STATUSES)[number];
export const GIFT_CARD_STATUS_TONE: Record<GiftCardStatus, Tone> = { active: "ok", redeemed: "info", void: "out", expired: "out" };
export const GIFT_CARD_VIEWS = ["all", "active", "redeemed", "expired", "void"] as const;
export type GiftCardView = (typeof GIFT_CARD_VIEWS)[number];
export type GiftCardFilters = { view: GiftCardView; q: string; page: number };

export type GiftCardRow = { id: string; hint: string | null; amountIqd: number; balanceIqd: number; status: GiftCardStatus; expiresAt: number | null; createdAt: number; createdBy: string | null; redeemedBy: string | null; redeemedAt: number | null; note: string | null; isDemo: boolean };
export type GiftCardSettlement = {
  issued: { count: number; iqd: number };
  outstanding: { count: number; iqd: number };
  redeemed: { count: number; iqd: number };
  /** What the wallet ledger says the redemptions credited — must equal `redeemed.iqd`. */
  walletCreditsIqd: number;
  /** Expired before anyone redeemed them (breakage). */
  expired: { count: number; iqd: number };
  /** Active cards past their date, not yet marked expired. */
  expiredWaiting: number;
  void: { count: number; iqd: number };
  pendingRequests: { count: number; iqd: number };
  balanced: boolean;
};
export type GiftCardPage = { rows: GiftCardRow[]; total: number; page: number; pageCount: number; counts: Partial<Record<GiftCardView, number>>; settlement: GiftCardSettlement; pending: PendingGiftCard[]; can: { issue: boolean; manage: boolean; reveal: boolean } };
export type PendingGiftCard = { approvalId: string; amountIqd: number; expiresAt: number | null; note: string | null; requestedBy: string | null; requestedAt: number; mine: boolean; canDecide: boolean };
export type GiftCardDetail = GiftCardRow & { redeemedByCustomerId: string | null; walletEntryId: string | null; reveals: number; history: HistoryRow[]; can: { manage: boolean; reveal: boolean; seeProfile: boolean }; dataKeyReady: boolean };

// ───────────────────────────────────────────────────────────────── A/B tests (08.08)

export const EXPERIMENT_STATUSES = ["draft", "running", "paused", "completed"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];
export const EXPERIMENT_STATUS_TONE: Record<ExperimentStatus, Tone> = { draft: "neutral", running: "ok", paused: "warn", completed: "out" };
/** What can be measured today from real orders, per coupon variant (docs/metrics.md: orders not cancelled). */
export const EXPERIMENT_METRICS = ["orders", "net_revenue_iqd", "avg_order_iqd", "discount_per_order_iqd", "refund_rate_bps"] as const;
export type ExperimentMetric = (typeof EXPERIMENT_METRICS)[number];
/** Which way is better for each metric. */
export const METRIC_BETTER: Record<ExperimentMetric, "higher" | "lower"> = { orders: "higher", net_revenue_iqd: "higher", avg_order_iqd: "higher", discount_per_order_iqd: "lower", refund_rate_bps: "lower" };

export type ExperimentVariantView = { key: string; couponId: string | null; couponCode: string | null; weight: number };
export type VariantResult = { key: string; couponCode: string | null; orders: number; netRevenueIqd: number; avgOrderIqd: number | null; discountPerOrderIqd: number | null; refundRateBps: number | null; discountIqd: number; refundedOrders: number };
export type ExperimentRow = { id: string; key: string; name: string; status: ExperimentStatus; primaryMetric: string; variants: number; startsAt: number | null; endsAt: number | null; winner: string | null };
export type ExperimentDetail = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  status: ExperimentStatus;
  variants: ExperimentVariantView[];
  primaryMetric: ExperimentMetric | null;
  minSample: number | null;
  plannedEnd: number | null;
  startsAt: number | null;
  endsAt: number | null;
  winner: string | null;
  results: VariantResult[];
  decision: { ready: boolean; leader: string | null; short: { key: string; missing: number }[] };
  problems: string[];
  visitorEvents: number;
  includeDemo: boolean;
  history: HistoryRow[];
  can: { manage: boolean };
};

// ───────────────────────────────────────────────────────────────── approvals (the module's queue)

export const APPROVAL_KINDS = ["coupon", "promotion_rule", "flash_sale", "gift_card", "loyalty_adjustment"] as const;
export type PromotionApprovalKind = (typeof APPROVAL_KINDS)[number];
export type ApprovalCard = {
  id: string;
  kind: PromotionApprovalKind;
  title: string;
  href: string;
  requestedBy: string | null;
  requestedAt: number;
  reason: string | null;
  /** Short facts ("خصم 25%", "150,000 د.ع") as label/value pairs. */
  facts: { label: string; value: string }[];
  mine: boolean;
  canDecide: boolean;
};

export type PromotionsOverview = {
  coupons: { live: number; pending: number; usedThisMonth: number } | null;
  rules: { live: number; pending: number } | null;
  flash: { running: number; scheduled: number; pending: number } | null;
  points: { outstanding: number; ordersWaiting: number } | null;
  referrals: { review: number } | null;
  vip: { members: number; eligible: number } | null;
  giftCards: { outstandingIqd: number; active: number; pending: number } | null;
  experiments: { running: number } | null;
  decide: number;
};

// ───────────────────────────────────────────────────────────────── errors

/** Error codes of this module (texts: admin-promotions → errors.*). */
export const PROMOTIONS_ERROR_KEYS = [
  "code_taken",
  "coupon_changed",
  "coupon_needs_approval",
  "change_pending",
  "change_not_pending",
  "approver_is_requester",
  "rule_changed",
  "flash_changed",
  "flash_not_draft",
  "flash_not_scheduled",
  "flash_started",
  "flash_empty",
  "flash_overlap",
  "flash_item_problem",
  "flash_window_past",
  "points_insufficient",
  "customer_unavailable",
  "referral_code_exists",
  "referral_code_inactive",
  "referral_cap_reached",
  "referral_self",
  "referral_phone_used",
  "referral_not_open",
  "referral_not_qualified",
  "referral_self_review",
  "referral_order_mismatch",
  "membership_exists",
  "membership_not_active",
  "tier_changed",
  "tier_inactive",
  "gift_card_unknown",
  "gift_card_used",
  "gift_card_void",
  "gift_card_expired",
  "gift_card_not_active",
  "gift_card_not_revealable",
  "gift_card_solo_limit",
  "gift_card_demo_mismatch",
  "override_required",
  "points_solo_limit",
  "data_key_missing",
  "wallet_requires_account",
  "experiment_changed",
  "experiment_not_draft",
  "experiment_not_running",
  "experiment_rule_missing",
  "experiment_not_decidable",
  "key_taken",
  "idempotency_mismatch",
] as const;
export type PromotionsErrorKey = (typeof PROMOTIONS_ERROR_KEYS)[number];

// ───────────────────────────────────────────────────────────────── digits, amounts, time

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic and Persian digits → Latin; the Arabic decimal separator → "."; everything else unchanged. */
export function latinDigits(value: string): string {
  let out = "";
  for (const char of value) {
    const a = ARABIC_INDIC.indexOf(char);
    const p = PERSIAN.indexOf(char);
    out += a >= 0 ? String(a) : p >= 0 ? String(p) : char === "٫" ? "." : char;
  }
  return out;
}

/** A whole number typed by a person ("12,500", "١٢٬٥٠٠", "12 500"); null when it is not one. */
export function parseWhole(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const text = latinDigits(raw).trim().replace(/[\s,٬،']/g, "");
  if (!/^-?\d{1,13}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** A percentage with up to two decimals ("12.5", "١٢٫٥", "12,5") as basis points (1250); null when it is not one. */
export function parsePercentBps(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  if (typeof raw !== "string") return null;
  const text = latinDigits(raw).trim().replace(/\s|%/g, "").replace(",", ".");
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** Basis points as the percentage people type ("12.5"). */
export function bpsToPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const rest = Math.abs(bps % 100);
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0").replace(/0$/, "")}`;
}

/** An instant as the value of an <input type="datetime-local"> in Baghdad time ("2026-11-20T18:00"). */
export function toBaghdadInput(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 16);
}

/** "2026-11-20T18:00" (Baghdad) → epoch ms; "" → null; anything else → NaN (a field error). */
export function fromBaghdadInput(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return Number.NaN;
  const text = latinDigits(value).trim();
  if (text === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(text);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match.map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(utc);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) return Number.NaN;
  return utc - BAGHDAD_OFFSET_MS;
}

/** The Baghdad calendar day of an instant ("2026-11-20"). */
export function baghdadDay(ms: number): string {
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** The last millisecond of a Baghdad day ("2026-11-20" → 2026-11-20 23:59:59.999 Baghdad); null when it is not a day. */
export function endOfBaghdadDay(day: unknown): number | null {
  if (typeof day !== "string") return null;
  const text = latinDigits(day).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const start = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (new Date(start).toISOString().slice(0, 10) !== text) return null;
  return start - BAGHDAD_OFFSET_MS + DAY_MS - 1;
}

// ───────────────────────────────────────────────────────────────── URL state (lists work without JavaScript)

const pick = <T extends string>(list: readonly T[], value: string | null, fallback: T): T => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : fallback);
const pageOf = (value: string | null) => {
  const n = parseWhole(value ?? "");
  return n !== null && n >= 1 && n <= 10_000 ? n : 1;
};
const query = (entries: Record<string, string | number | null | undefined | false>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) if (value !== null && value !== undefined && value !== false && value !== "") params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
};
const qOf = (params: URLSearchParams) => (params.get("q") ?? "").trim().slice(0, 60);

export function parseCouponFilters(params: URLSearchParams): CouponFilters {
  return { view: pick(COUPON_VIEWS, params.get("view"), "all"), q: qOf(params), sort: pick(COUPON_SORTS, params.get("sort"), "newest"), page: pageOf(params.get("page")) };
}
export function couponSearch(filters: Partial<CouponFilters>): string {
  return query({ view: filters.view === "all" ? null : filters.view, q: filters.q, sort: filters.sort === "newest" ? null : filters.sort, page: filters.page && filters.page > 1 ? filters.page : null });
}

export function parseRuleFilters(params: URLSearchParams): RuleFilters {
  return { view: pick(RULE_VIEWS, params.get("view"), "all"), q: qOf(params), page: pageOf(params.get("page")) };
}
export function ruleSearch(filters: Partial<RuleFilters>): string {
  return query({ view: filters.view === "all" ? null : filters.view, q: filters.q, page: filters.page && filters.page > 1 ? filters.page : null });
}

export function parseFlashFilters(params: URLSearchParams): FlashFilters {
  return { view: pick(FLASH_VIEWS, params.get("view"), "all"), page: pageOf(params.get("page")) };
}
export function flashSearch(filters: Partial<FlashFilters>): string {
  return query({ view: filters.view === "all" ? null : filters.view, page: filters.page && filters.page > 1 ? filters.page : null });
}

export function parseLedgerFilters(params: URLSearchParams): LedgerFilters {
  const kind = params.get("kind");
  const customer = (params.get("customer") ?? "").trim();
  return { kind: kind && (LOYALTY_KINDS as readonly string[]).includes(kind) ? (kind as LoyaltyKind) : null, customer: /^[A-Za-z0-9_.:-]{1,128}$/.test(customer) ? customer : null, page: pageOf(params.get("page")) };
}
export function ledgerSearch(filters: Partial<LedgerFilters>): string {
  return query({ kind: filters.kind, customer: filters.customer, page: filters.page && filters.page > 1 ? filters.page : null });
}

export function parseReferralFilters(params: URLSearchParams): ReferralFilters {
  return { view: pick(REFERRAL_VIEWS, params.get("view"), "review"), page: pageOf(params.get("page")) };
}
export function referralSearch(filters: Partial<ReferralFilters>): string {
  return query({ view: filters.view === "review" ? null : filters.view, page: filters.page && filters.page > 1 ? filters.page : null });
}

export function parseVipFilters(params: URLSearchParams): VipFilters {
  return { members: pick(MEMBER_VIEWS, params.get("members"), "current"), page: pageOf(params.get("page")) };
}
export function vipSearch(filters: Partial<VipFilters>): string {
  return query({ members: filters.members === "current" ? null : filters.members, page: filters.page && filters.page > 1 ? filters.page : null });
}

export function parseGiftCardFilters(params: URLSearchParams): GiftCardFilters {
  return { view: pick(GIFT_CARD_VIEWS, params.get("view"), "all"), q: qOf(params), page: pageOf(params.get("page")) };
}
export function giftCardSearch(filters: Partial<GiftCardFilters>): string {
  return query({ view: filters.view === "all" ? null : filters.view, q: filters.q, page: filters.page && filters.page > 1 ? filters.page : null });
}

/** The dry-run window from the URL (?days=7|30|90&demo=1). */
export function parseDryRun(params: URLSearchParams): { days: (typeof DRY_RUN_DAYS)[number]; includeDemo: boolean } {
  const days = parseWhole(params.get("days") ?? "");
  return { days: (DRY_RUN_DAYS as readonly number[]).includes(days ?? -1) ? (days as (typeof DRY_RUN_DAYS)[number]) : 30, includeDemo: params.get("demo") === "1" };
}
