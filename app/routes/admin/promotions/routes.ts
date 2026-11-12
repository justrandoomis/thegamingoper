import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 08 — Promotions and loyalty (docs/areas/admin-promotions.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/promotions/.
 * A record's page with the id "new" is its empty form (/coupons/new, /rules/new).
 *
 *   /admin/promotions                                what waits, each section's figures, what the checkout applies, status
 *   /admin/promotions/approvals                      the module's decisions in one queue; my own requests
 *   /admin/promotions/coupons                        coupons: states, uses, discount given, views, bulk switch-off   08.01
 *   /admin/promotions/coupons/:couponId              one coupon: terms, second person, switch, try, uses, history     08.01
 *   /admin/promotions/rules                          automatic discount rules                                         08.02
 *   /admin/promotions/rules/:ruleId                  one rule: terms, second person, switch, the dry run              08.02
 *   /admin/promotions/flash                          flash sales; a new draft                                         08.03
 *   /admin/promotions/flash/:saleId                  one sale: SKUs, prices by pricing's rules, allowance, decisions  08.03
 *   /admin/promotions/points                         the programme, what is due (post), the ledger, find a customer   08.04
 *   /admin/promotions/points/:customerId             a customer's points: balance, entries, adjustments               08.04
 *   /admin/promotions/referrals                      referrals to review (signals), reward / reject, codes            08.05
 *   /admin/promotions/vip                            tiers and benefits, members, eligible customers (module 07)      08.06
 *   /admin/promotions/gift-cards                     settlement, issue (code once), requests, redeem, the cards        08.07
 *   /admin/promotions/gift-cards/:cardId             one card: reveal (audited), void, history                        08.07
 *   /admin/promotions/experiments                    A/B tests of offers; a new draft                                 08.08
 *   /admin/promotions/experiments/:experimentId      one test: measurement rule, results, start / pause / complete    08.08
 */
export const promotionsAdminRoutes: RouteConfigEntry[] = [
  route("promotions", "routes/admin/promotions/layout.tsx", [
    index("routes/admin/promotions/index.tsx"),
    route("approvals", "routes/admin/promotions/approvals.tsx"),
    route("coupons", "routes/admin/promotions/coupons.tsx"),
    route("coupons/:couponId", "routes/admin/promotions/coupon.tsx"),
    route("rules", "routes/admin/promotions/rules.tsx"),
    route("rules/:ruleId", "routes/admin/promotions/rule.tsx"),
    route("flash", "routes/admin/promotions/flash.tsx"),
    route("flash/:saleId", "routes/admin/promotions/flash-sale.tsx"),
    route("points", "routes/admin/promotions/points.tsx"),
    route("points/:customerId", "routes/admin/promotions/points-customer.tsx"),
    route("referrals", "routes/admin/promotions/referrals.tsx"),
    route("vip", "routes/admin/promotions/vip.tsx"),
    route("gift-cards", "routes/admin/promotions/gift-cards.tsx"),
    route("gift-cards/:cardId", "routes/admin/promotions/gift-card.tsx"),
    route("experiments", "routes/admin/promotions/experiments.tsx"),
    route("experiments/:experimentId", "routes/admin/promotions/experiment.tsx"),
  ]),
];
