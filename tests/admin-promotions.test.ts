/**
 * Admin module 08 "promotions" (owner: admin promotions) — the services under app/server/services/admin/promotions and
 * the route glue of app/routes/admin/promotions, on a real local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · the pure rules: approval reasons, coupon / rule / flash states, the dry-run evaluator, points, FIFO expiry,
 *     the A/B decision rule, digits and Baghdad time
 *   · authorization per role (manager, finance, support, cashier, content) and the field rules: no cost or margin
 *     without cost.read / profit.read (flash checks, dry-run margin), no gift-card code anywhere but a reveal
 *   · coupons (08.01): the core's evaluateCoupon is the one validation path; large terms wait for a second person who
 *     is never the requester; an edit waits while the terms in force stay; stale forms refused; bulk switch-off
 *   · rules (08.02): the dry run of recent orders (scope, stacking with coupons, demo left out)
 *   · flash sales (08.03): pricing's rules decide who approves; allowance never above the stock; overlap refused
 *   · points (08.04): earn once after the return window, reverse a later refund, expire FIFO, adjustments (two people
 *     above the limit), overdraft refused
 *   · referrals (08.05): self-referral, a number referred twice, the cap, qualification, the recorder never rewards
 *   · VIP (08.06): module 07's rule decides who is eligible, one membership at a time, the multiplier earns points
 *   · gift cards (08.07): issued once per form, encrypted, revealed with a permission and an audit, redeemed once into
 *     the wallet (also two at once), the 24-hour solo limit, the settlement balances with the wallet ledger
 *   · A/B tests (08.08): no start without the measurement rule; no winner before the rule can be read
 *   · the module's approvals queue and the route actions' permission order
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { auditEvents, categories, coupons, customers, employeeRoles, giftCards, journalEntries, loyaltyLedger, orders, platforms, products, refunds, variantCosts, walletLedger } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { countDecidable, listApprovals } from "~/server/services/admin/promotions/approvals.server";
import { decideCoupon, deactivateCoupons, getCoupon, listCoupons, saveCoupon, setCouponActive, tryCoupon, withdrawCouponRequest } from "~/server/services/admin/promotions/coupons.server";
import { decideRule, dryRun, getRule, saveRule, setRuleActive } from "~/server/services/admin/promotions/discounts.server";
import { completeExperiment, getExperiment, saveExperiment, startExperiment } from "~/server/services/admin/promotions/experiments.server";
import { createFlashSale, decideFlashSale, getFlashSale, setFlashItem, submitFlashSale } from "~/server/services/admin/promotions/flash.server";
import { decideGiftCard, getGiftCard, giftCardSettlement, issueGiftCard, listGiftCards, redeemGiftCard, revealGiftCardCode, voidGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { adjustPoints, customerPoints, decideAdjustment, loyaltyOverview, postExpiry, syncOrderPoints } from "~/server/services/admin/promotions/loyalty.server";
import { promotionsOverview } from "~/server/services/admin/promotions/overview.server";
import { issueReferralCode, listReferrals, recordReferral, rejectReferral, rewardReferral } from "~/server/services/admin/promotions/referrals.server";
import { couponStateOf, discountApprovalReasons, evaluateRule, expiredUnconsumed, experimentDecision, flashStateOf, pointsFor, stackedChange } from "~/server/services/admin/promotions/rules";
import { PROMOTIONS_ERROR_KEYS, fromBaghdadInput, parsePercentBps, parseWhole, toBaghdadInput, type RuleTerms } from "~/server/services/admin/promotions/types";
import { grantMembership, saveTier, vipPage } from "~/server/services/admin/promotions/vip.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import messages from "~/i18n/messages/admin-promotions";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const DATA_KEY = TEST_VARS.DATA_KEY;

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "support", "cashier", "content"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}
const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
/** A custom role on the manager's account (same id): only these permissions. */
const custom = (permissions: Permission[], key: keyof typeof staff = "manager"): EmployeeActor => ({ kind: "employee", id: as(key).id, permissions: new Set(permissions) });
const key = () => randomToken(12).replace(/[^A-Za-z0-9_-]/g, "x");

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (appError) return appError;
    throw error;
  }
  throw new Error("expected a failure");
}

// ───────────────────────────────────────────────────────────────── pure rules

describe("rules (pure)", () => {
  test("approval reasons follow DISCOUNT_LIMITS", () => {
    expect(discountApprovalReasons({ kind: "percent", value: 1000, maxDiscountIqd: 25_000, usageLimit: 100, perCustomerLimit: 1 }, { coupon: true })).toEqual([]);
    expect(discountApprovalReasons({ kind: "percent", value: 2500, maxDiscountIqd: 25_000, usageLimit: 100, perCustomerLimit: null }, { coupon: true })).toEqual(["percent_over"]);
    expect(discountApprovalReasons({ kind: "percent", value: 1000, maxDiscountIqd: null, usageLimit: 10, perCustomerLimit: null }, { coupon: true })).toEqual(["uncapped"]);
    expect(discountApprovalReasons({ kind: "fixed", value: 75_000, maxDiscountIqd: null, usageLimit: null, perCustomerLimit: null }, { coupon: true })).toEqual(["amount_over", "no_limits"]);
    expect(discountApprovalReasons({ kind: "fixed", value: 5_000, maxDiscountIqd: null }, {})).toEqual([]);
    expect(discountApprovalReasons({ kind: "tiered", value: null, maxDiscountIqd: 20_000, tiers: [{ bps: 1000 }, { bps: 2500 }] })).toEqual(["percent_over"]);
    expect(discountApprovalReasons({ kind: "free_shipping", value: null, maxDiscountIqd: null })).toEqual([]);
  });

  test("coupon and flash states", () => {
    const base = { isActive: true, startsAt: null, endsAt: null, usageLimit: 2 };
    expect(couponStateOf(base, 0, false, NOW)).toBe("live");
    expect(couponStateOf(base, 2, false, NOW)).toBe("exhausted");
    expect(couponStateOf({ ...base, endsAt: NOW }, 0, false, NOW)).toBe("expired");
    expect(couponStateOf({ ...base, startsAt: NOW + 1 }, 0, false, NOW)).toBe("scheduled");
    expect(couponStateOf({ ...base, isActive: false }, 0, true, NOW)).toBe("pending");
    expect(couponStateOf({ ...base, isActive: false }, 0, false, NOW)).toBe("off");
    const sale = { status: "scheduled", startsAt: NOW + 10, endsAt: NOW + 20 };
    expect(flashStateOf(sale, false, NOW)).toBe("scheduled");
    expect(flashStateOf(sale, false, NOW + 10)).toBe("active");
    expect(flashStateOf(sale, false, NOW + 20)).toBe("ended");
    expect(flashStateOf({ ...sale, status: "draft" }, true, NOW)).toBe("pending");
  });

  const rule = (over: Partial<RuleTerms>): RuleTerms => ({
    kind: "percent",
    value: 1000,
    tiers: [],
    bogo: null,
    maxDiscountIqd: null,
    stackable: false,
    priority: 0,
    startsAt: null,
    endsAt: null,
    scope: { platformIds: [], categoryIds: [], productKinds: [], segmentIds: [], channels: [], minSubtotalIqd: null, minQty: null },
    ...over,
  });
  const cart = { channel: "web", segmentIds: new Set<string>(), subtotalIqd: 300_000, shippingIqd: 5000, placedAt: NOW, lines: [
    { variantId: "v1", productId: "p1", platformId: "ps", categoryChain: ["games-ps5", "games"], kind: "game", qty: 2, unitPriceIqd: 100_000 },
    { variantId: "v2", productId: "p2", platformId: "xb", categoryChain: ["acc"], kind: "accessory", qty: 1, unitPriceIqd: 100_000 },
  ] };

  test("evaluateRule: scope by category (with parents), tiers, buy X get Y, free shipping, min subtotal", () => {
    expect(evaluateRule(rule({ scope: { ...rule({}).scope, categoryIds: ["games"] } }), cart)).toMatchObject({ applies: true, eligibleIqd: 200_000, discountIqd: 20_000 });
    expect(evaluateRule(rule({ scope: { ...rule({}).scope, platformIds: ["nin"] } }), cart)).toEqual({ applies: false, skip: "no_lines" });
    expect(evaluateRule(rule({ kind: "tiered", value: null, tiers: [{ minQty: 2, bps: 500 }, { minQty: 3, bps: 1500 }] }), cart)).toMatchObject({ applies: true, discountIqd: 45_000 });
    expect(evaluateRule(rule({ kind: "bogo", value: null, bogo: { buy: 2, get: 1 } }), cart)).toMatchObject({ applies: true, discountIqd: 100_000 });
    expect(evaluateRule(rule({ kind: "free_shipping", value: null }), cart)).toMatchObject({ applies: true, discountIqd: 0, shippingDiscountIqd: 5000 });
    expect(evaluateRule(rule({ scope: { ...rule({}).scope, minSubtotalIqd: 400_000 } }), cart)).toEqual({ applies: false, skip: "min_subtotal" });
    expect(evaluateRule(rule({ scope: { ...rule({}).scope, channels: ["pos"] } }), cart)).toEqual({ applies: false, skip: "channel" });
    expect(evaluateRule(rule({ maxDiscountIqd: 7_000 }), cart)).toMatchObject({ discountIqd: 7_000 });
    // stacking: a non-stackable rule gives the better of the two
    const outcome = evaluateRule(rule({}), cart);
    if (!outcome.applies) throw new Error("expected to apply");
    expect(stackedChange(outcome, false, 25_000, 300_000).goodsIqd).toBe(5_000);
    expect(stackedChange(outcome, false, 40_000, 300_000).goodsIqd).toBe(0);
    expect(stackedChange(outcome, true, 40_000, 300_000).goodsIqd).toBe(30_000);
  });

  test("points, FIFO expiry, the A/B decision rule", () => {
    expect(pointsFor({ paidIqd: 105_000, refundedIqd: 0, subtotalIqd: 100_000, discountIqd: 0 })).toBe(100);
    expect(pointsFor({ paidIqd: 105_000, refundedIqd: 50_500, subtotalIqd: 100_000, discountIqd: 0 })).toBe(54);
    expect(pointsFor({ paidIqd: 105_000, refundedIqd: 0, subtotalIqd: 100_000, discountIqd: 0 }, 15_000)).toBe(150);
    expect(expiredUnconsumed([{ points: 100, expiresAt: NOW - 1 }, { points: 50, expiresAt: NOW + DAY }], 30, NOW)).toBe(70);
    expect(expiredUnconsumed([{ points: 100, expiresAt: NOW - 1 }], 120, NOW)).toBe(0);
    const result = (key: string, orders: number, net: number) => ({ key, couponCode: key, orders, netRevenueIqd: net, avgOrderIqd: orders ? Math.round(net / orders) : null, discountPerOrderIqd: 0, refundRateBps: 0, discountIqd: 0, refundedOrders: 0 });
    expect(experimentDecision([result("A", 10, 100), result("B", 40, 900)], "net_revenue_iqd", 30)).toEqual({ ready: false, leader: null, short: [{ key: "A", missing: 20 }] });
    expect(experimentDecision([result("A", 30, 100), result("B", 40, 900)], "net_revenue_iqd", 30)).toMatchObject({ ready: true, leader: "B" });
    expect(experimentDecision([result("A", 30, 100), result("B", 40, 900)], null, 30).ready).toBe(false);
  });

  test("digits and Baghdad time", () => {
    expect(parseWhole("١٢٬٥٠٠")).toBe(12_500);
    expect(parseWhole("۱۲۵۰۰")).toBe(12_500);
    expect(parseWhole("12,500")).toBe(12_500);
    expect(parseWhole("12.5")).toBeNull();
    expect(parsePercentBps("12.5")).toBe(1_250);
    expect(parsePercentBps("١٢٫٥")).toBe(1_250);
    expect(parsePercentBps("100")).toBe(10_000);
    const at = fromBaghdadInput("2026-11-20T18:00");
    expect(at).toBe(Date.UTC(2026, 10, 20, 15, 0));
    expect(toBaghdadInput(at)).toBe("2026-11-20T18:00");
    expect(Number.isNaN(fromBaghdadInput("2026-02-30T10:00"))).toBe(true);
    expect(fromBaghdadInput("")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization", () => {
  test("finance reads, support / cashier / content cannot open the module", async () => {
    const filters = { view: "all" as const, q: "", sort: "newest" as const, page: 1 };
    await expect(listCoupons(t.db, as("finance"), filters, NOW)).resolves.toBeTruthy();
    expect((await failureOf(saveCoupon(t.db, as("finance"), { code: "FIN10", kind: "fixed", value: "1000" }, NOW))).status).toBe(403);
    for (const role of ["support", "cashier", "content"] as const) {
      expect((await failureOf(listCoupons(t.db, as(role), filters, NOW))).status, role).toBe(403);
      expect((await failureOf(promotionsOverview(t.db, as(role), NOW))).status, role).toBe(403);
    }
    const overview = await promotionsOverview(t.db, as("finance"), NOW);
    expect(overview.coupons).not.toBeNull();
    // a role with only the coupon permission sees nothing of the other sections
    const couponsOnly = await promotionsOverview(t.db, custom(["promotions.coupon.manage"]), NOW);
    expect(couponsOnly.coupons).not.toBeNull();
    expect(couponsOnly.giftCards).toBeNull();
    expect(couponsOnly.points).toBeNull();
  });

  test("every error key has a text in ar, en and ckb", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const errors = (messages[locale] as { errors?: Record<string, string> }).errors ?? {};
      for (const code of PROMOTIONS_ERROR_KEYS) expect(errors[code], `${locale}: errors.${code}`).toBeTruthy();
    }
  });
});

// ───────────────────────────────────────────────────────────────── coupons

describe("coupons (08.01)", () => {
  test("a small coupon goes live at once; the core's evaluateCoupon applies it", async () => {
    const product = await make.product({ priceIqd: 200_000, stock: 5 });
    const saved = await saveCoupon(t.db, as("manager"), { code: "small10", kind: "percent", value: "10", maxDiscountIqd: "25,000", usageLimit: "100", perCustomerLimit: "1", activate: "on", description: "خصم صغير" }, NOW);
    expect(saved).toMatchObject({ status: "applied", reasons: [] });
    const coupon = await t.db.select().from(coupons).where(eq(coupons.id, saved.couponId)).get();
    expect(coupon).toMatchObject({ code: "SMALL10", isActive: true, value: 1000, maxDiscountIqd: 25_000 });
    const tried = await tryCoupon(t.db, as("finance"), { code: "small10", lines: [{ code: product.sku, qty: 1 }] }, NOW);
    expect(tried.result).toMatchObject({ ok: true, discountIqd: 20_000 });
    // a double submit of the same new coupon is a replay, another author's same code is taken
    expect(await saveCoupon(t.db, as("manager"), { code: "SMALL10", kind: "percent", value: "10", maxDiscountIqd: "25000", usageLimit: "100", perCustomerLimit: "1", activate: "on", description: "خصم صغير" }, NOW)).toMatchObject({ replayed: true });
    expect((await failureOf(saveCoupon(t.db, as("manager2"), { code: "small10", kind: "fixed", value: "1000" }, NOW))).fields).toMatchObject({ code: "code_taken" });
  });

  test("large terms wait for a second person who is not the requester", async () => {
    const saved = await saveCoupon(t.db, as("manager"), { code: "BIG30", kind: "percent", value: "30", usageLimit: "50", activate: "on" }, NOW);
    expect(saved.status).toBe("requested");
    expect(saved.reasons).toEqual(["percent_over", "uncapped"]);
    const detail = await getCoupon(t.db, as("manager"), saved.couponId, NOW);
    expect(detail).toMatchObject({ state: "pending", isActive: false, can: { decide: false } });
    const approvalId = detail.pending?.approvalId as string;
    expect((await failureOf(decideCoupon(t.db, as("manager"), { approvalId, decision: "approve" }, NOW))).code).toBe("approver_is_requester");
    // a coupon manager without pricing.discount.override cannot decide either
    expect((await failureOf(decideCoupon(t.db, custom(["promotions.coupon.manage"], "manager2"), { approvalId, decision: "approve" }, NOW))).status).toBe(403);
    expect(await countDecidable(t.db, as("manager2"))).toBeGreaterThan(0);
    expect(await decideCoupon(t.db, as("manager2"), { approvalId, decision: "approve", note: "حملة الجمعة" }, NOW)).toMatchObject({ status: "approved" });
    expect((await t.db.select().from(coupons).where(eq(coupons.id, saved.couponId)).get())?.isActive).toBe(true);
    // switching it off and on again needs nobody: these exact terms were approved
    const after = await getCoupon(t.db, as("manager"), saved.couponId, NOW);
    expect(after.approvedTerms).toBe(true);
    await setCouponActive(t.db, as("manager"), { couponId: saved.couponId, active: false, reason: "توقف مؤقت", expected: after.fingerprint }, NOW);
    expect(await setCouponActive(t.db, as("manager"), { couponId: saved.couponId, active: true, reason: "استئناف", expected: after.fingerprint }, NOW)).toEqual({ status: "applied" });
  });

  test("an edit beyond the limits waits while the live terms stay; a stale form is refused; withdraw", async () => {
    const saved = await saveCoupon(t.db, as("manager"), { code: "EDIT5", kind: "fixed", value: "5000", usageLimit: "10", activate: "on" }, NOW);
    const detail = await getCoupon(t.db, as("manager"), saved.couponId, NOW);
    const edit = await saveCoupon(t.db, as("manager"), { couponId: saved.couponId, kind: "fixed", value: "80000", usageLimit: "10", reason: "رفع القيمة", expected: detail.fingerprint }, NOW);
    expect(edit).toMatchObject({ status: "requested", reasons: ["amount_over"] });
    expect((await t.db.select().from(coupons).where(eq(coupons.id, saved.couponId)).get())?.value).toBe(5000);
    expect((await failureOf(saveCoupon(t.db, as("manager"), { couponId: saved.couponId, kind: "fixed", value: "6000", usageLimit: "10", reason: "تعديل", expected: detail.fingerprint }, NOW))).code).toBe("change_pending");
    const pending = (await getCoupon(t.db, as("manager"), saved.couponId, NOW)).pending;
    await withdrawCouponRequest(t.db, as("manager"), { approvalId: pending?.approvalId as string }, NOW);
    expect((await failureOf(saveCoupon(t.db, as("manager"), { couponId: saved.couponId, kind: "fixed", value: "6000", usageLimit: "10", reason: "تعديل", expected: "{}" }, NOW))).code).toBe("coupon_changed");
    expect(await saveCoupon(t.db, as("manager"), { couponId: saved.couponId, kind: "fixed", value: "6000", usageLimit: "10", reason: "تعديل", expected: detail.fingerprint }, NOW)).toMatchObject({ status: "applied" });
  });

  test("bulk switch-off, validation of Arabic digits and dates", async () => {
    const a = await saveCoupon(t.db, as("manager"), { code: "BULKA", kind: "fixed", value: "١٠٠٠", usageLimit: "٥", activate: "on" }, NOW);
    const b = await saveCoupon(t.db, as("manager"), { code: "BULKB", kind: "fixed", value: "1000", usageLimit: "5" }, NOW);
    expect((await t.db.select().from(coupons).where(eq(coupons.id, a.couponId)).get())).toMatchObject({ value: 1000, usageLimit: 5 });
    expect(await deactivateCoupons(t.db, as("manager"), { couponIds: [a.couponId, b.couponId], reason: "نهاية الحملة" }, NOW)).toEqual({ changed: 1, skipped: 1 });
    const bad = await failureOf(saveCoupon(t.db, as("manager"), { code: "BADDATE", kind: "percent", value: "120", startsAt: "2026-12-01T10:00", endsAt: "2026-11-30T10:00" }, NOW));
    expect(bad.fields).toMatchObject({ value: "percent_too_big", endsAt: "ends_before_start" });
    // an empty form names every missing field at once, each with its own text
    expect((await failureOf(saveCoupon(t.db, as("manager"), { code: "", kind: "percent", value: "" }, NOW))).fields).toEqual({ code: "required", value: "required" });
    expect((await failureOf(saveCoupon(t.db, as("manager"), { code: "x", kind: "percent", value: "abc", usageLimit: "خمسة" }, NOW))).fields).toMatchObject({ usageLimit: "number_invalid" });
    expect((await failureOf(saveCoupon(t.db, as("manager"), { code: "x", kind: "percent", value: "abc" }, NOW))).fields).toEqual({ code: "code_invalid", value: "percent_invalid" });
  });
});

// ───────────────────────────────────────────────────────────────── discount rules

describe("discount rules (08.02)", () => {
  test("the dry run prices recent orders again: scope, coupon stacking, demo left out, margin only with cost + profit", async () => {
    await t.db.insert(platforms).values({ id: "plt_test_ps", slug: "test-ps", name: { ar: "بلايستيشن" }, sort: 1 });
    await t.db.insert(categories).values([
      { id: "cat_test_games", slug: "test-games", name: { ar: "ألعاب" }, sort: 1 },
      { id: "cat_test_games_ps", parentId: "cat_test_games", slug: "test-games-ps", name: { ar: "ألعاب بلايستيشن" }, sort: 2 },
    ]);
    const game = await make.product({ kind: "game", priceIqd: 80_000 });
    await t.db.update(products).set({ categoryId: "cat_test_games_ps", platformId: "plt_test_ps" }).where(eq(products.id, game.productId));
    await t.db.insert(variantCosts).values({ variantId: game.variantId, currency: "IQD", unitCostMinor: 50_000, landedCostIqd: 50_000, updatedAt: NOW });
    const other = await make.product({ kind: "accessory", priceIqd: 30_000 });
    const customerId = await make.customer();
    await make.order([{ ...game, qty: 2, unitPriceIqd: 80_000 }], { customerId, placedAt: NOW - 2 * DAY, status: "delivered", isDemo: false });
    await make.order([{ ...other, qty: 1, unitPriceIqd: 30_000 }], { placedAt: NOW - 3 * DAY, isDemo: false });
    await make.order([{ ...game, qty: 1, unitPriceIqd: 80_000 }], { placedAt: NOW - DAY, isDemo: true });
    // an order with a coupon worth more than the rule
    await make.order([{ ...game, qty: 1, unitPriceIqd: 80_000 }], { placedAt: NOW - DAY, discountIqd: 20_000, isDemo: false });
    await t.db.run(sql`UPDATE order_items SET cost_snapshot_iqd = 50000 WHERE variant_id = ${game.variantId}`);
    const saved = await saveRule(t.db, as("manager"), { idempotencyKey: key(), nameAr: "خصم ألعاب", kind: "percent", value: "10", maxDiscountIqd: "50000", categoryIds: ["cat_test_games"] }, NOW);
    expect(saved.status).toBe("applied");
    const run = await dryRun(t.db, as("manager"), saved.ruleId, { days: 30, includeDemo: false }, NOW);
    expect(run.demoLeftOut).toBeGreaterThanOrEqual(1);
    expect(run.changed).toBe(1);
    expect(run.discountIqd).toBe(16_000);
    expect(run.skips.no_lines).toBeGreaterThanOrEqual(1);
    expect(run.skips.coupon_better).toBe(1);
    expect(run.margin).toMatchObject({ revenueBeforeIqd: 160_000, revenueAfterIqd: 144_000, costIqd: 100_000 });
    const noCost = await dryRun(t.db, custom(["promotions.promotion.read"]), saved.ruleId, { days: 30, includeDemo: true }, NOW);
    expect(noCost.margin).toBeUndefined();
    expect(JSON.stringify(noCost)).not.toContain("50000");
    expect(noCost.changed).toBe(2);
  });

  test("switching on a rule beyond the limits waits for a second person", async () => {
    const saved = await saveRule(t.db, as("manager"), { idempotencyKey: key(), nameAr: "خصم كبير", kind: "percent", value: "40", maxDiscountIqd: "30000" }, NOW);
    const detail = await getRule(t.db, as("manager"), saved.ruleId, NOW);
    expect(detail.approvalReasons).toEqual(["percent_over"]);
    expect(await setRuleActive(t.db, as("manager"), { ruleId: saved.ruleId, active: true, reason: "تجربة", expectedUpdatedAt: detail.updatedAt }, NOW)).toEqual({ status: "requested" });
    const pending = (await getRule(t.db, as("manager2"), saved.ruleId, NOW)).pending;
    expect(pending?.canDecide).toBe(true);
    expect((await failureOf(decideRule(t.db, as("manager"), { approvalId: pending?.approvalId as string, decision: "approve" }, NOW))).code).toBe("approver_is_requester");
    await decideRule(t.db, as("manager2"), { approvalId: pending?.approvalId as string, decision: "approve" }, NOW);
    expect((await getRule(t.db, as("manager"), saved.ruleId, NOW)).state).toBe("live");
  });
});

// ───────────────────────────────────────────────────────────────── flash sales

describe("flash sales (08.03)", () => {
  test("pricing's rules decide; the allowance never exceeds the stock; cost fields only with cost.read", async () => {
    const console5 = await make.product({ priceIqd: 1_000_000, stock: 4 });
    await t.db.insert(variantCosts).values({ variantId: console5.variantId, currency: "IQD", unitCostMinor: 700_000, landedCostIqd: 700_000, minMarginBps: 1000, updatedAt: NOW });
    const created = await createFlashSale(t.db, as("manager"), { nameAr: "عرض الجمعة", startsAt: toBaghdadInput(NOW + DAY), endsAt: toBaghdadInput(NOW + 2 * DAY), idempotencyKey: key() }, NOW);
    expect((await failureOf(setFlashItem(t.db, as("manager"), { saleId: created.saleId, code: console5.sku, salePrice: "850,000", qtyLimit: "5" }, NOW, "ar"))).fields).toMatchObject({ qtyLimit: "allowance_over_stock" });
    expect((await failureOf(setFlashItem(t.db, as("manager"), { saleId: created.saleId, code: console5.sku, salePrice: "1000000" }, NOW, "ar"))).fields).toMatchObject({ salePrice: "price_not_lower" });
    await setFlashItem(t.db, as("manager"), { saleId: created.saleId, code: console5.sku, salePrice: "850000", qtyLimit: "3", perCustomerLimit: "1" }, NOW, "ar");
    const seen = await getFlashSale(t.db, as("manager"), created.saleId, NOW, "ar");
    expect(seen.items[0]).toMatchObject({ canSell: 3, available: 4, check: { needsApproval: true, floorIqd: 778_000 } });
    const blind = await getFlashSale(t.db, custom(["promotions.flash_sale.manage"]), created.saleId, NOW, "ar");
    expect(blind.items[0].check.floorIqd).toBeUndefined();
    expect(blind.items[0].check.marginAfterBps).toBeUndefined();
    expect(JSON.stringify(blind)).not.toContain("700000");
    expect(await submitFlashSale(t.db, as("manager"), { saleId: created.saleId, reason: "عرض نهاية الأسبوع" }, NOW, "ar")).toMatchObject({ status: "requested", needsOverride: false });
    const pending = (await getFlashSale(t.db, as("manager2"), created.saleId, NOW, "ar")).pending;
    expect((await failureOf(decideFlashSale(t.db, as("manager"), { approvalId: pending?.approvalId as string, decision: "approve" }, NOW, "ar"))).code).toBe("approver_is_requester");
    await decideFlashSale(t.db, as("manager2"), { approvalId: pending?.approvalId as string, decision: "approve" }, NOW, "ar");
    expect((await getFlashSale(t.db, as("manager"), created.saleId, NOW, "ar")).state).toBe("scheduled");
    expect((await getFlashSale(t.db, as("manager"), created.saleId, NOW + DAY + 1, "ar")).state).toBe("active");
    // the same SKU in an overlapping draft is refused at submit
    const second = await createFlashSale(t.db, as("manager"), { nameAr: "عرض متداخل", startsAt: toBaghdadInput(NOW + DAY + 60_000), endsAt: toBaghdadInput(NOW + 3 * DAY), idempotencyKey: key() }, NOW);
    await setFlashItem(t.db, as("manager"), { saleId: second.saleId, code: console5.sku, salePrice: "950000" }, NOW, "ar");
    expect((await failureOf(submitFlashSale(t.db, as("manager"), { saleId: second.saleId, reason: "اختبار" }, NOW, "ar"))).code).toBe("flash_item_problem");
  });
});

// ───────────────────────────────────────────────────────────────── points

describe("reward points (08.04)", () => {
  test("earn once after the return window, reverse a later refund, expire FIFO", async () => {
    const product = await make.product({ priceIqd: 250_000 });
    const customerId = await make.customer();
    const order = await make.order([{ ...product, qty: 1, unitPriceIqd: 250_000 }], { customerId, status: "delivered", paymentStatus: "paid", paidIqd: 255_000, deliveredAt: NOW - 10 * DAY, placedAt: NOW - 12 * DAY, isDemo: false });
    const young = await make.order([{ ...product, qty: 1, unitPriceIqd: 250_000 }], { customerId, status: "delivered", paymentStatus: "paid", paidIqd: 255_000, deliveredAt: NOW - DAY, placedAt: NOW - 2 * DAY, isDemo: false });
    expect((await loyaltyOverview(t.db, as("manager"), NOW)).ordersWaiting).toBeGreaterThanOrEqual(1);
    const first = await syncOrderPoints(t.db, as("manager"), NOW);
    expect(first.earnedOrders).toBeGreaterThanOrEqual(1);
    const earn = await t.db.select().from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:earn:${order.orderId}`)).get();
    expect(earn?.points).toBe(250);
    expect(await t.db.select().from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:earn:${young.orderId}`)).get()).toBeUndefined();
    // a second run earns nothing twice
    await syncOrderPoints(t.db, as("manager"), NOW);
    expect((await t.db.select({ n: sql<number>`count(*)` }).from(loyaltyLedger).where(eq(loyaltyLedger.refId, order.orderId)).get())?.n).toBe(1);
    // a refund of 100,000 paid after the points were earned takes back 100 points (its share of the 250,000 kept)
    const paymentId = await make.payment(order.orderId, 255_000);
    await t.db.insert(refunds).values({ id: newId("rfd"), orderId: order.orderId, paymentId, amountIqd: 100_000, method: "cash", reason: "إرجاع جزئي", status: "paid", createdAt: NOW + 1000, paidAt: NOW + 1000 });
    const second = await syncOrderPoints(t.db, as("manager"), NOW + 2000);
    expect(second).toMatchObject({ reversed: 1, reversedPoints: 100 });
    expect((await customerPoints(t.db, as("manager"), customerId, NOW + 2000)).balance).toBe(150);
    // a year later what was never used expires, once
    const later = NOW + 400 * DAY;
    expect((await postExpiry(t.db, as("manager"), later)).points).toBeGreaterThanOrEqual(150);
    expect((await customerPoints(t.db, as("manager"), customerId, later)).balance).toBe(0);
    expect((await postExpiry(t.db, as("manager"), later)).points).toBe(0);
    // support cannot post or see points
    expect((await failureOf(syncOrderPoints(t.db, as("support"), NOW))).status).toBe(403);
  });

  test("adjustments: small at once, large by a second person, never below zero", async () => {
    const customerId = await make.customer();
    expect(await adjustPoints(t.db, as("manager"), { customerId, points: "300", reason: "تعويض", idempotencyKey: "adjust-0001" }, NOW)).toEqual({ status: "applied", replayed: false });
    expect(await adjustPoints(t.db, as("manager"), { customerId, points: "300", reason: "تعويض", idempotencyKey: "adjust-0001" }, NOW)).toEqual({ status: "applied", replayed: true });
    expect((await failureOf(adjustPoints(t.db, as("manager"), { customerId, points: "-301", reason: "خطأ", idempotencyKey: "adjust-0002" }, NOW))).code).toBe("points_insufficient");
    expect(await adjustPoints(t.db, as("manager"), { customerId, points: "6000", reason: "مسابقة", idempotencyKey: "adjust-0003" }, NOW)).toMatchObject({ status: "requested" });
    const pending = (await customerPoints(t.db, as("manager2"), customerId, NOW)).pending[0];
    expect((await failureOf(decideAdjustment(t.db, as("manager"), { approvalId: pending.approvalId, decision: "approve" }, NOW))).code).toBe("approver_is_requester");
    await decideAdjustment(t.db, as("manager2"), { approvalId: pending.approvalId, decision: "approve", note: "موافق" }, NOW);
    expect((await customerPoints(t.db, as("manager"), customerId, NOW)).balance).toBe(6300);
  });
});

// ───────────────────────────────────────────────────────────────── referrals

describe("referrals (08.05)", () => {
  test("abuse rules, qualification and a reward the recorder cannot give", async () => {
    const referrerId = await make.customer();
    const referrer = await t.db.select().from(customers).where(eq(customers.id, referrerId)).get();
    const code = await issueReferralCode(t.db, as("manager"), { customerId: referrerId, maxUses: "2" }, NOW);
    expect(await issueReferralCode(t.db, as("manager"), { customerId: referrerId }, NOW)).toMatchObject({ code: code.code, replayed: true });
    expect((await failureOf(recordReferral(t.db, as("manager"), { code: code.code, phone: referrer?.phoneE164 as string, note: "إحالة", idempotencyKey: key() }, NOW))).code).toBe("referral_self");
    const friendPhone = make.phone();
    const friendId = await make.customer({ phoneE164: friendPhone });
    const product = await make.product({ priceIqd: 100_000 });
    const order = await make.order([{ ...product, qty: 1, unitPriceIqd: 100_000 }], { customerId: friendId, contactPhoneE164: friendPhone, status: "confirmed", placedAt: NOW, isDemo: false });
    const recorded = await recordReferral(t.db, as("manager"), { code: code.code.toLowerCase(), phone: friendPhone, orderRef: order.ref, note: "أخبرنا في المتجر", idempotencyKey: key() }, NOW);
    expect((await failureOf(recordReferral(t.db, as("manager"), { code: code.code, phone: friendPhone, note: "مرة ثانية", idempotencyKey: key() }, NOW))).code).toBe("referral_phone_used");
    const list = await listReferrals(t.db, as("manager2"), { view: "review", page: 1 }, NOW);
    const row = list.rows.find((entry) => entry.id === recorded.referralId);
    expect(row).toMatchObject({ status: "pending", qualifies: false });
    expect(row?.signals).toContain("order_not_delivered");
    expect((await failureOf(rewardReferral(t.db, as("manager2"), { referralId: recorded.referralId }, NOW))).code).toBe("referral_not_qualified");
    await t.db.update(orders).set({ status: "delivered", deliveredAt: NOW - 10 * DAY }).where(eq(orders.id, order.orderId));
    expect((await failureOf(rewardReferral(t.db, as("manager"), { referralId: recorded.referralId }, NOW))).code).toBe("referral_self_review");
    expect(await rewardReferral(t.db, as("manager2"), { referralId: recorded.referralId, note: "تحقق" }, NOW)).toEqual({ points: 500 });
    expect((await customerPoints(t.db, as("manager"), referrerId, NOW)).balance).toBe(500);
    expect((await failureOf(rewardReferral(t.db, as("manager2"), { referralId: recorded.referralId }, NOW))).code).toBe("referral_not_open");
    // the cap: two uses, the second fills it, a rejected one gives its use back
    const second = await recordReferral(t.db, as("manager"), { code: code.code, phone: make.phone(), note: "ثانية", idempotencyKey: key() }, NOW);
    expect((await failureOf(recordReferral(t.db, as("manager"), { code: code.code, phone: make.phone(), note: "ثالثة", idempotencyKey: key() }, NOW))).code).toBe("referral_cap_reached");
    await rejectReferral(t.db, as("manager2"), { referralId: second.referralId, reason: "رقم مكرر" }, NOW);
    await expect(recordReferral(t.db, as("manager"), { code: code.code, phone: make.phone(), note: "رابعة", idempotencyKey: key() }, NOW)).resolves.toMatchObject({ replayed: false });
  });
});

// ───────────────────────────────────────────────────────────────── VIP

describe("VIP memberships (08.06)", () => {
  test("module 07's rule decides who is eligible; one membership at a time; the multiplier earns points", async () => {
    const tier = await saveTier(t.db, as("manager"), { key: "gold", nameAr: "ذهبي", discount: "5", multiplier: "1.5", freeShipping: "on", notesAr: "توصيل مجاني وخصم 5% ونقاط مضاعفة 1.5", isActive: "on", reason: "إطلاق البرنامج" }, NOW);
    const vipId = await make.customer();
    const product = await make.product({ priceIqd: 2_100_000 });
    await make.order([{ ...product, qty: 1, unitPriceIqd: 2_100_000 }], { customerId: vipId, status: "delivered", paymentStatus: "paid", paidIqd: 2_105_000, deliveredAt: NOW - 20 * DAY, placedAt: NOW - 21 * DAY, isDemo: false });
    const page = await vipPage(t.db, as("manager"), NOW, "ar");
    expect(page.eligible.some((row) => row.customerId === vipId && row.flags.some((flag) => flag.id === "vip_spend"))).toBe(true);
    await grantMembership(t.db, as("manager"), { customerId: vipId, tierId: tier.tierId, reason: "عميل مميز" }, NOW);
    expect((await failureOf(grantMembership(t.db, as("manager"), { customerId: vipId, tierId: tier.tierId, reason: "مرة ثانية" }, NOW))).code).toBe("membership_exists");
    expect((await vipPage(t.db, as("manager"), NOW, "ar")).eligible.some((row) => row.customerId === vipId)).toBe(false);
    await syncOrderPoints(t.db, as("manager"), NOW);
    expect((await customerPoints(t.db, as("manager"), vipId, NOW)).balance).toBe(3150);
    expect((await failureOf(vipPage(t.db, as("cashier"), NOW, "ar"))).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────── gift cards

describe("gift cards (08.07)", () => {
  test("issued once per form, encrypted, revealed with a permission and an audit, redeemed once into the wallet", async () => {
    const issued = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "50,000", note: "تعويض عن تأخير", idempotencyKey: "gift-form-0001" }, NOW);
    expect(issued).toMatchObject({ status: "issued", replayed: false });
    const code = issued.code as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "50000", note: "تعويض عن تأخير", idempotencyKey: "gift-form-0001" }, NOW)).toEqual({ status: "issued", cardId: issued.cardId, replayed: true });
    const stored = await t.db.select().from(giftCards).where(eq(giftCards.id, issued.cardId as string)).get();
    expect(JSON.stringify(stored)).not.toContain(code.replace(/-/g, ""));
    expect(stored?.codeHint).toBe(code.replace(/-/g, "").slice(-4));
    const page = await listGiftCards(t.db, as("finance"), { view: "all", q: "", page: 1 }, NOW);
    expect(JSON.stringify(page)).not.toContain(code.replace(/-/g, "").slice(0, 8));
    const audits = await t.db.select({ after: auditEvents.after, summary: auditEvents.summary }).from(auditEvents).where(eq(auditEvents.entityId, issued.cardId as string));
    expect(JSON.stringify(audits)).not.toContain(code.replace(/-/g, "").slice(0, 8));
    // reveal: the manager holds digital_code.reveal; finance does not manage gift cards
    expect((await failureOf(revealGiftCardCode(t.db, as("finance"), DATA_KEY, { cardId: issued.cardId, reason: "فقد الرمز" }, NOW))).status).toBe(403);
    expect((await failureOf(revealGiftCardCode(t.db, custom(["promotions.gift_card.manage"]), DATA_KEY, { cardId: issued.cardId, reason: "فقد الرمز" }, NOW))).status).toBe(403);
    expect(await revealGiftCardCode(t.db, as("manager"), DATA_KEY, { cardId: issued.cardId, reason: "فقد الرمز" }, NOW)).toEqual({ code });
    expect((await getGiftCard(t.db, as("manager"), issued.cardId as string, NOW, { dataKeyReady: true })).reveals).toBe(1);
    // redeem into the wallet — twice at once: one wins, the money moves once
    const customerId = await make.customer();
    const results = await Promise.allSettled([redeemGiftCard(t.db, as("manager"), { code: code.toLowerCase(), customerId, idempotencyKey: key() }, NOW), redeemGiftCard(t.db, as("manager2"), { code, customerId, idempotencyKey: key() }, NOW)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getWalletBalance(t.db, customerId)).toBe(50_000);
    expect((await failureOf(redeemGiftCard(t.db, as("manager"), { code, customerId, idempotencyKey: key() }, NOW))).code).toBe("gift_card_used");
    const ledger = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `gift_card:${issued.cardId}`));
    expect(ledger).toHaveLength(1);
    expect(await t.db.select({ id: journalEntries.id }).from(journalEntries).where(and(eq(journalEntries.refType, "wallet_ledger"), eq(journalEntries.refId, ledger[0].id))).get()).toBeTruthy();
    expect((await failureOf(revealGiftCardCode(t.db, as("manager"), DATA_KEY, { cardId: issued.cardId, reason: "مرة أخرى" }, NOW))).code).toBe("gift_card_not_revealable");
    const settlement = await giftCardSettlement(t.db, as("finance"), NOW);
    expect(settlement.balanced).toBe(true);
    expect(settlement.redeemed.iqd).toBe(settlement.walletCreditsIqd);
    // a wrong code is refused (and counted)
    expect((await failureOf(redeemGiftCard(t.db, as("manager"), { code: "AAAA-BBBB-CCCC-DDDD", customerId, idempotencyKey: key() }, NOW))).code).toBe("gift_card_unknown");
  });

  test("a large card waits for a second person; what one person issues alone in 24 hours is capped", async () => {
    const issuer = custom(["promotions.gift_card.issue", "promotions.gift_card.manage"], "manager2");
    const big = await issueGiftCard(t.db, issuer, DATA_KEY, { amountIqd: "150000", note: "جائزة مسابقة", idempotencyKey: "gift-form-0002" }, NOW);
    expect(big).toMatchObject({ status: "requested" });
    expect((await failureOf(decideGiftCard(t.db, issuer, DATA_KEY, { approvalId: big.approvalId, decision: "approve" }, NOW))).code).toBe("approver_is_requester");
    const decided = await decideGiftCard(t.db, as("owner"), DATA_KEY, { approvalId: big.approvalId, decision: "approve", note: "جائزة معتمدة" }, NOW);
    expect(decided.code).toBeTruthy();
    expect((await t.db.select().from(giftCards).where(eq(giftCards.id, decided.cardId)).get())?.createdBy).toBe(as("manager2").id);
    // 100,000 + 100,000 alone, then 60,000 more would pass 250,000: a request instead
    await issueGiftCard(t.db, issuer, DATA_KEY, { amountIqd: "100000", note: "تعويض", idempotencyKey: "gift-form-0003" }, NOW);
    await issueGiftCard(t.db, issuer, DATA_KEY, { amountIqd: "100000", note: "تعويض", idempotencyKey: "gift-form-0004" }, NOW);
    expect(await issueGiftCard(t.db, issuer, DATA_KEY, { amountIqd: "60000", note: "تعويض", idempotencyKey: "gift-form-0005" }, NOW)).toMatchObject({ status: "requested" });
    // without DATA_KEY nothing is issued
    expect((await failureOf(issueGiftCard(t.db, as("manager"), undefined, { amountIqd: "5000", note: "بدون مفتاح", idempotencyKey: "gift-form-0006" }, NOW))).code).toBe("data_key_missing");
    // void
    const small = await issueGiftCard(t.db, as("owner"), DATA_KEY, { amountIqd: "5000", note: "اختبار", idempotencyKey: "gift-form-0007" }, NOW);
    await voidGiftCard(t.db, as("owner"), { cardId: small.cardId, reason: "أُصدرت بالخطأ" }, NOW);
    const customerId = await make.customer();
    expect((await failureOf(redeemGiftCard(t.db, as("owner"), { code: small.code, customerId, idempotencyKey: key() }, NOW))).code).toBe("gift_card_void");
  });
});

// ───────────────────────────────────────────────────────────────── A/B tests

describe("A/B tests (08.08)", () => {
  test("no start without the measurement rule; results from real orders; no winner before the rule can be read", async () => {
    const a = await saveCoupon(t.db, as("manager"), { code: "ABTESTA", kind: "fixed", value: "5000", usageLimit: "100", activate: "on" }, NOW);
    const b = await saveCoupon(t.db, as("manager"), { code: "ABTESTB", kind: "fixed", value: "7000", usageLimit: "100", activate: "on" }, NOW);
    const created = await saveExperiment(t.db, as("manager"), { idempotencyKey: key(), key: "fixed-5k-vs-7k", name: "5,000 أم 7,000", couponIds: [a.couponId, b.couponId] }, NOW);
    const draft = await getExperiment(t.db, as("manager"), created.experimentId, NOW, { includeDemo: false });
    expect(draft.problems).toEqual(expect.arrayContaining(["metric_missing", "sample_missing", "end_missing"]));
    expect((await failureOf(startExperiment(t.db, as("manager"), { experimentId: created.experimentId, reason: "ابدأ" }, NOW))).code).toBe("experiment_rule_missing");
    await saveExperiment(t.db, as("manager"), { experimentId: created.experimentId, key: "fixed-5k-vs-7k", name: "5,000 أم 7,000", couponIds: [a.couponId, b.couponId], metric: "net_revenue_iqd", minOrders: "10", plannedEnd: "2026-12-10" }, NOW);
    await startExperiment(t.db, as("manager"), { experimentId: created.experimentId, reason: "ابدأ" }, NOW);
    const product = await make.product({ priceIqd: 100_000 });
    await make.order([{ ...product, qty: 1, unitPriceIqd: 100_000 }], { couponId: a.couponId, discountIqd: 5000, placedAt: NOW + 1000, paidIqd: 100_000, isDemo: false });
    const running = await getExperiment(t.db, as("finance"), created.experimentId, NOW + 2000, { includeDemo: false });
    expect(running.results.find((row) => row.key === "A")).toMatchObject({ orders: 1, netRevenueIqd: 100_000, discountPerOrderIqd: 5000 });
    expect(running.decision.ready).toBe(false);
    expect(running.visitorEvents).toBe(0);
    expect((await failureOf(completeExperiment(t.db, as("manager"), { experimentId: created.experimentId, winner: "A", reason: "انتهى" }, NOW + 3000))).code).toBe("experiment_not_decidable");
    expect(await completeExperiment(t.db, as("manager"), { experimentId: created.experimentId, winner: "", reason: "لا نتيجة" }, NOW + 3000)).toEqual({ winner: null });
  });
});

// ───────────────────────────────────────────────────────────────── the queue

describe("approvals queue", () => {
  test("the requester sees their own requests to withdraw, never to decide", async () => {
    await saveCoupon(t.db, as("manager"), { code: "QUEUE50", kind: "percent", value: "50", maxDiscountIqd: "10000", usageLimit: "5", activate: "on" }, NOW);
    const format = { iqd: (value: number) => `${value} IQD`, percent: (bps: number) => `${bps / 100}%`, points: (value: number) => String(value) };
    const mine = await listApprovals(t.db, as("manager"), "ar", format);
    expect(mine.mine.some((card) => card.title === "QUEUE50")).toBe(true);
    expect(mine.decide.some((card) => card.title === "QUEUE50")).toBe(false);
    const theirs = await listApprovals(t.db, as("manager2"), "ar", format);
    expect(theirs.decide.some((card) => card.title === "QUEUE50" && card.href.startsWith("/admin/promotions/coupons/"))).toBe(true);
    expect(await countDecidable(t.db, as("finance"))).toBeNull();
  });
});


// ───────────────────────────────────────────────────────────────── races and the route glue

describe("races", () => {
  test("two deciders at once: one decision counts", async () => {
    const saved = await saveCoupon(t.db, as("manager"), { code: "RACE40", kind: "percent", value: "40", maxDiscountIqd: "20000", usageLimit: "10", activate: "on" }, NOW);
    const approvalId = (await getCoupon(t.db, as("manager"), saved.couponId, NOW)).pending?.approvalId as string;
    const results = await Promise.allSettled([decideCoupon(t.db, as("manager2"), { approvalId, decision: "approve" }, NOW), decideCoupon(t.db, as("owner"), { approvalId, decision: "reject", note: "مرفوض" }, NOW)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(toAppError(failed.reason)?.code).toBe("change_not_pending");
  });

  test("two point postings at once earn each order once", async () => {
    const product = await make.product({ priceIqd: 120_000 });
    const customerId = await make.customer();
    const order = await make.order([{ ...product, qty: 1, unitPriceIqd: 120_000 }], { customerId, status: "delivered", paymentStatus: "paid", paidIqd: 125_000, deliveredAt: NOW - 30 * DAY, placedAt: NOW - 31 * DAY, isDemo: false });
    await Promise.allSettled([syncOrderPoints(t.db, as("manager"), NOW), syncOrderPoints(t.db, as("owner"), NOW)]);
    const rows = await t.db.select().from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:earn:${order.orderId}`));
    expect(rows).toHaveLength(1);
    expect(rows[0].points).toBe(120);
  });

  test("the referral cap holds under two records at once", async () => {
    const owner = await make.customer();
    const code = await issueReferralCode(t.db, as("manager"), { customerId: owner, maxUses: "1" }, NOW);
    const results = await Promise.allSettled([
      recordReferral(t.db, as("manager"), { code: code.code, phone: make.phone(), note: "أولى", idempotencyKey: key() }, NOW),
      recordReferral(t.db, as("manager2"), { code: code.code, phone: make.phone(), note: "ثانية", idempotencyKey: key() }, NOW),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(toAppError((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)?.code).toBe("referral_cap_reached");
  });
});

describe("route glue", () => {
  const session = (actor: EmployeeActor) => ({ actor, employee: { id: actor.id } }) as unknown as import("~/server/auth/admin.server").EmployeeSession;
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [name, value] of Object.entries(entries)) data.append(name, value);
    return data;
  };
  test("an intent's permission is checked before anything is read; unknown intents are 400", async () => {
    const { runIntent } = await import("~/routes/admin/promotions/promotions.server");
    let ran = false;
    const handle = async (intent: string) => {
      ran = true;
      return { ok: true as const, intent };
    };
    const intents = { save: ["promotions.coupon.manage"], decide: ["promotions.coupon.manage", "pricing.discount.override"] } as const;
    const denied = await runIntent({ locale: "ar", now: NOW }, session(as("finance")), form({ intent: "save" }), intents, handle);
    expect(denied).toMatchObject({ ok: false, code: "forbidden", status: 403 });
    expect(ran).toBe(false);
    const half = await runIntent({ locale: "en", now: NOW }, session(custom(["promotions.coupon.manage"])), form({ intent: "decide" }), intents, handle);
    expect(half).toMatchObject({ ok: false, status: 403 });
    expect(ran).toBe(false);
    expect(await runIntent({ locale: "ar", now: NOW }, session(as("manager")), form({ intent: "drop-table" }), intents, handle)).toMatchObject({ ok: false, code: "invalid", status: 400 });
    expect(await runIntent({ locale: "ar", now: NOW }, session(as("manager")), form({ intent: "save" }), intents, handle)).toEqual({ ok: true, intent: "save" });
    // an expected failure comes back translated, with its status
    const failed = await runIntent({ locale: "en", now: NOW }, session(as("manager")), form({ intent: "save" }), intents, async () => {
      throw toAppError(new Error("x")) ?? new (await import("~/server/errors")).AppError("gift_card_used", 409);
    });
    expect(failed).toMatchObject({ ok: false, code: "gift_card_used", status: 409, message: "This card was already used; it cannot be used twice." });
  });
});
