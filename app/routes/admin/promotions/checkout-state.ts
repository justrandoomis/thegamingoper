/**
 * Where each promotion of module 08 is applied today, per sale channel — what the overview's «ما يُطبَّق اليوم» and
 * each section's note (`SectionState`, ui.tsx) say, from ONE registry so the two never disagree. Read from the
 * commerce core on 2026-11-12; every claim and its source (file and line) is in docs/areas/admin-promotions.md
 * ("What the checkout and the till apply"), and tests/admin-promotions-state.test.ts checks the claims against the
 * core: a change on either side that is not written on the other fails a test instead of leaving staff a stale
 * sentence (the module said for a day that the checkout applied no rules, flash prices or points after the core had
 * started to apply them).
 *
 *   web   the online checkout: the cart's pricing (cart.server.ts priceCart → orders/promotions.ts applyDiscounts) and
 *         placeOrder's batch (orders/place.server.ts) — what the shopper is charged and what the order records
 *   pos   the till in the store (admin 06: services/admin/pos/sale.server.ts → orders/pos-sale.server.ts): the SKU's or
 *         its price list's price and the cashier's own discount; the wallet pays
 *
 *   applied   the channel applies it, completely
 *   partial   the channel applies part of it; its sentence names what is missing
 *   missing   the channel does not apply it yet
 *
 * Each sentence is the message `home.checkout.<section>.<channel>` (admin-promotions.ts). Pure and client-safe.
 */
export const SALE_CHANNELS = ["web", "pos"] as const;
export type SaleChannel = (typeof SALE_CHANNELS)[number];

/** The sections in the overview's order (their names are the messages `nav.<section>`). */
export const STATE_SECTIONS = ["coupons", "rules", "flash", "points", "vip", "giftCards", "referrals", "experiments"] as const;
export type StateSection = (typeof STATE_SECTIONS)[number];

export const CHANNEL_STATES = ["applied", "partial", "missing"] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];

export const CHECKOUT_STATE: Readonly<Record<StateSection, Readonly<Record<SaleChannel, ChannelState>>>> = {
  // web: evaluateCoupon on every read of the cart, step 3 of applyDiscounts, a redemption row in placeOrder's batch.
  // pos: the till takes no coupon (the cashier's own discount, pos.discount.apply within pos.discount_limit_bps).
  coupons: { web: "applied", pos: "missing" },
  // web: the live rules (loadPromotionFacts), step 2 — the rules that combine with coupons add up by priority, then the
  //   coupon (step 3); the best rule that does not combine competes with all of them together and applies alone when
  //   it gives more (review 2026-11-13: the sentence said it only competed with the coupon) — and step 6 (free delivery).
  // pos: the till reads no rule — and the web refuses a rule limited to the point of sale: it applies nowhere.
  rules: { web: "applied", pos: "missing" },
  // web: the running sale's price in the cart while its allowance and the shopper's limit cover the line
  //   (flashLineCap), the units claimed in placeOrder's batch, given back on a cancel — but product pages, lists and
  //   search read no flash sale: the sale price shows from the cart on.
  // pos: the till sells at the SKU's or its price list's price.
  flash: { web: "partial", pos: "missing" },
  // web: step 5 (a signed-in customer redeems), a 'redeem' row in placeOrder's batch, all given back on a cancel and a
  //   share with each refund (ledger rows ref "redeem" — points.ref.redeem); earned after delivery and the return window
  //   (syncOrderPoints, also a nightly job).
  // pos: a sale to a known account earns like any delivered order; the till redeems nothing.
  points: { web: "applied", pos: "partial" },
  // web: step 4 (the member discount, capped by the discount limits in force), step 6 (free delivery), the multiplier
  //   when points are posted — early access is read by nothing.
  // pos: the multiplier counts on the member's till purchases when points are posted; no member discount at the till.
  vip: { web: "partial", pos: "partial" },
  // web: a card is redeemed into the wallet (from the customer's account or by staff); the wallet pays at checkout.
  // pos: the wallet pays at the till (a customer identified by number; never offline). Selling cards: not built.
  giftCards: { web: "applied", pos: "applied" },
  // web: a friend's code typed at the review step, checked (checkReferralCode) and recorded in placeOrder's batch.
  // pos: the till takes no code; staff record a referral by hand (recordReferral).
  referrals: { web: "applied", pos: "missing" },
  // web: results from the orders of each variant's coupon; the storefront assigns and counts no visitor.
  // pos: no coupon at the till, so its sales are in no test.
  experiments: { web: "partial", pos: "missing" },
};

/** A state is words with a dot (DESIGN.md §10): green applies, amber applies with a gap its sentence names, grey not yet. */
export const STATE_TONE: Readonly<Record<ChannelState, "ok" | "warn" | "out">> = { applied: "ok", partial: "warn", missing: "out" };
