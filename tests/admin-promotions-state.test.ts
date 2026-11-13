/**
 * Admin module 08 (owner: admin promotions) — what the module SAYS the online checkout and the till apply
 * (app/routes/admin/promotions/checkout-state.ts: the overview's «ما يُطبَّق اليوم» and each section's note), checked
 * against the commerce core and the till themselves. A change on either side that is not written on the other fails
 * here: the follow-up of 2026-11-12 found the module telling staff that the checkout applied no rules, flash prices,
 * points or member discounts after the core had started to apply them.
 *
 *   · the texts: every section × channel has a state and a sentence in ar, en and ckb, every placeholder filled; the
 *     retired sentences are gone
 *   · the online checkout (the core's own pure decision, orders/promotions.ts): rules, the coupon, the membership
 *     (capped by the discount limits), points and free delivery; a running flash sale; a rule or a coupon for the
 *     point of sale only applies nowhere online
 *   · the till and what nothing reads yet (the source): the till calls none of the core's promotions and takes the
 *     wallet; early access, A/B visitors and catalogue flash prices have no reader; sign-up records no referral
 *   · points from the till (a database): a delivered sale to a known customer earns, times the VIP multiplier
 *   · review 2026-11-13: the ledger labels every reference the core writes (redeemed points given back showed a raw
 *     key), the rules' stacking as the core decides it, a refund's share of redeemed points, the coupon try's regular
 *     price, the «not built yet» lines that read as one sentence, and a rule's dry run that weighs an order's whole
 *     discount (its words said «coupon»)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import messages from "~/i18n/messages/admin-promotions";
import { translate, type MessageTree } from "~/i18n/translate";
import { newId } from "~/lib/ids";
import { CHANNEL_STATES, CHECKOUT_STATE, SALE_CHANNELS, STATE_SECTIONS } from "~/routes/admin/promotions/checkout-state";
import { systemActor } from "~/server/actor";
import { coupons, loyaltyLedger, memberships, membershipTiers, promotions } from "~/server/db/schema";
import { dryRun } from "~/server/services/admin/promotions/discounts.server";
import { syncOrderPoints } from "~/server/services/admin/promotions/loyalty.server";
import { evaluateRule } from "~/server/services/admin/promotions/rules";
import { DEFAULT_PROGRAM, type RuleTerms } from "~/server/services/admin/promotions/types";
import { evaluateCoupon } from "~/server/services/coupons.server";
import { CheckoutInput } from "~/server/services/orders/place.server";
import { applyDiscounts, flashLineCap, restoredPointsFor, type DiscountInput, type PricingLine } from "~/server/services/orders/promotions";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const LOCALES = ["ar", "en", "ckb"] as const;
const ROOT = fileURLToPath(new URL("../", import.meta.url));
/** A message of the module in one language ("" when it is missing). */
const say = (locale: (typeof LOCALES)[number], key: string, vars?: Record<string, string | number>) => translate(messages[locale] as unknown as MessageTree, locale, key, vars) ?? "";

// ───────────────────────────────────────────────────────────────── the texts

describe("the texts", () => {
  test("every section and channel has a state and a sentence in ar, en and ckb, with every placeholder filled", () => {
    const vars = { value: "10 د.ع", percent: "20", amount: "50,000 د.ع" };
    for (const locale of LOCALES) {
      const tree = messages[locale] as unknown as MessageTree;
      const say = (key: string) => translate(tree, locale, key, vars) ?? "";
      for (const state of CHANNEL_STATES) expect(say(`home.checkout.state.${state}`), `${locale}: state ${state}`).not.toBe("");
      for (const channel of SALE_CHANNELS) expect(say(`home.checkout.channel.${channel}`), `${locale}: channel ${channel}`).not.toBe("");
      for (const id of STATE_SECTIONS) {
        for (const channel of SALE_CHANNELS) {
          const sentence = say(`home.checkout.${id}.${channel}`);
          expect(sentence, `${locale}: ${id}.${channel}`).not.toBe("");
          expect(sentence, `${locale}: ${id}.${channel} keeps a placeholder`).not.toMatch(/\{\w+\}/);
        }
      }
      for (const key of ["common.stateTitle", "common.notBuilt", "referrals.signup", "gift.boundary"]) expect(say(key), `${locale}: ${key}`).not.toBe("");
    }
  });

  test("the retired sentences are gone: the checkout applies rules, flash prices, points, member discounts and referral codes", () => {
    const retired: Record<(typeof LOCALES)[number], string[]> = {
      ar: ["لا يطبّقه الدفع بعد", "لا يقرأ هذه القواعد بعد", "لا يقرأ أسعار العروض بعد", "لا يكتب رمز الإحالة في المتجر بعد", "لكن الدفع لا يقرأها بعد", "لحين تطبيقها في الدفع", "يحتاج حساب التزام بطاقات الهدايا"],
      en: ["does not apply this yet", "does not read these rules yet", "does not read sale prices yet", "cannot type a referral code", "does not read it yet", "ready for when the checkout applies it", "it needs a gift-card liability account"],
      ckb: ["پارەدان هێشتا جێبەجێی ناکات", "هێشتا ئەم یاسایانە ناخوێنێتەوە", "هێشتا نرخی ئۆفەرەکان ناخوێنێتەوە", "ناتوانێت کۆدی ناساندن لە فرۆشگا بنووسێت", "بەڵام پارەدان هێشتا نایخوێنێتەوە"],
    };
    for (const locale of LOCALES) {
      const all = JSON.stringify(messages[locale]);
      for (const phrase of retired[locale]) expect(all, `${locale}: «${phrase}»`).not.toContain(phrase);
    }
  });
});

// ───────────────────────────────────────────────────────────────── the online checkout

const rule = (over: Partial<RuleTerms> = {}): RuleTerms => ({
  kind: "percent",
  value: 500,
  tiers: [],
  bogo: null,
  maxDiscountIqd: null,
  stackable: true,
  priority: 0,
  startsAt: null,
  endsAt: null,
  scope: { platformIds: [], categoryIds: [], productKinds: [], segmentIds: [], channels: [], minSubtotalIqd: null, minQty: null },
  ...over,
});
const line: PricingLine = { lineId: "l1", variantId: "v1", productId: "p1", platformId: "ps", categoryChain: ["games"], kind: "game", isDemo: false, qty: 2, unitPriceIqd: 100_000 };
const cart: DiscountInput = { lines: [line], subtotalIqd: 200_000, shippingFeeIqd: 5_000, coupon: null, rules: [], segmentIds: new Set(), member: null, points: null, limits: DEFAULT_PROGRAM.limits, now: NOW };

describe("the online checkout (the core's own decision)", () => {
  test("rules, the coupon, the member discount (capped by the limits), points and free delivery are applied", () => {
    const outcome = applyDiscounts({
      ...cart,
      rules: [{ id: "r1", label: "خصم الألعاب", terms: rule(), isDemo: false }],
      coupon: { couponId: "c1", code: "SAVE10", label: "SAVE10", discountIqd: 10_000 },
      member: { membershipId: "m1", tierId: "t1", label: "ذهبي", discountBps: DEFAULT_PROGRAM.limits.percentBps + 500, freeShipping: true },
      points: { balance: 50, pointValueIqd: DEFAULT_PROGRAM.loyalty.pointValueIqd, requested: 10 },
    });
    expect(outcome.discounts.map((entry) => entry.kind)).toEqual(["rule", "coupon", "member", "points"]);
    // a tier above the limits gives what one person may give alone: the limit, never the tier's own percentage
    expect(outcome.discounts.find((entry) => entry.kind === "member")).toMatchObject({ bps: DEFAULT_PROGRAM.limits.percentBps });
    expect(outcome.pointsUsed).toBe(10);
    expect(outcome.shippingWaiver).toMatchObject({ by: "member", waivedIqd: 5_000 });
    expect(CHECKOUT_STATE.coupons.web).toBe("applied");
    expect(CHECKOUT_STATE.rules.web).toBe("applied");
    expect(CHECKOUT_STATE.points.web).toBe("applied");
    // the discount and free delivery are applied; early access is not (see "what nothing reads yet")
    expect(CHECKOUT_STATE.vip.web).toBe("partial");
  });

  test("a running flash sale prices the cart's line while its allowance and the shopper's limit last", () => {
    const offer = { itemId: "fsi1", saleId: "fs1", label: "عرض الجمعة", salePriceIqd: 80_000, left: 3, perCustomerLeft: 1, perCustomerLimit: 1, endsAt: NOW + DAY, isDemo: false };
    expect(flashLineCap(offer, 100_000, false)).toBe(1);
    expect(flashLineCap({ ...offer, left: 0 }, 100_000, false)).toBe(0);
    // applied in the cart and at checkout; partial only because product pages and lists do not show it (below)
    expect(CHECKOUT_STATE.flash.web).toBe("partial");
  });

  test("a rule for the point of sale only applies nowhere online (and the till reads no rule)", () => {
    const facts = { channel: "web", segmentIds: new Set<string>(), subtotalIqd: 200_000, shippingIqd: 5_000, placedAt: NOW, lines: [{ variantId: "v1", productId: "p1", platformId: "ps", categoryChain: ["games"], kind: "game", qty: 2, unitPriceIqd: 100_000 }] };
    expect(evaluateRule(rule({ scope: { ...rule().scope, channels: ["pos"] } }), facts)).toEqual({ applies: false, skip: "channel" });
    const outcome = applyDiscounts({ ...cart, rules: [{ id: "r2", label: "للكاشير", terms: rule({ scope: { ...rule().scope, channels: ["pos"] } }), isDemo: false }] });
    expect(outcome.discounts).toEqual([]);
    expect(CHECKOUT_STATE.rules.pos).toBe("missing");
  });
});

// ───────────────────────────────────────────────────────────────── the till, and what nothing reads yet (the source)

function filesUnder(relative: string): string[] {
  const start = path.join(ROOT, relative);
  if (statSync(start).isFile()) return [start];
  const out: string[] = [];
  for (const entry of readdirSync(start, { withFileTypes: true })) {
    const full = path.join(start, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path.relative(ROOT, full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
/** Files of `roots` whose source matches `pattern`, minus the ones `allowed` names. */
function readersOf(pattern: RegExp, roots: readonly string[], allowed: (file: string) => boolean = () => false): string[] {
  return roots
    .flatMap(filesUnder)
    .map(rel)
    .filter((file) => !allowed(file) && pattern.test(readFileSync(path.join(ROOT, file), "utf8")));
}
const ownModule = (file: string) => file.startsWith("app/server/services/admin/promotions/") || file.startsWith("app/routes/admin/promotions/") || file === "app/i18n/messages/admin-promotions.ts" || file.startsWith("app/server/db/schema/");

describe("the till and what nothing reads yet", () => {
  const TILL = ["app/server/services/orders/pos-sale.server.ts", "app/server/services/admin/pos", "app/routes/admin/pos"];

  test("the till calls none of the core's promotions: no coupon, rule, flash price, points, member discount or referral", () => {
    const used = readersOf(/applyDiscounts|loadPromotionFacts|evaluateCoupon|evaluateRule|pointsRedeemStatement|checkReferralCode|referralStatements|flashClaimStatements|flashSaleItems|flash_sale_items|membershipTiers|membership_tiers|loyaltyLedger|loyalty_ledger|referralCodes|referral_codes/, TILL);
    // when the till starts to apply one, say so in checkout-state.ts and in home.checkout.<section>.pos
    expect(used).toEqual([]);
    for (const id of ["coupons", "rules", "flash", "referrals", "experiments"] as const) expect(CHECKOUT_STATE[id].pos, id).toBe("missing");
    // points are earned from the till's sales (below) and the multiplier with them; nothing else
    expect(CHECKOUT_STATE.points.pos).toBe("partial");
    expect(CHECKOUT_STATE.vip.pos).toBe("partial");
  });

  test("the till takes the wallet, so a gift card's value spends there too", () => {
    expect(readFileSync(path.join(ROOT, "app/server/services/orders/pos-sale.server.ts"), "utf8")).toContain("walletDebitStatement");
    expect(CHECKOUT_STATE.giftCards).toEqual({ web: "applied", pos: "applied" });
  });

  test("early access is read by nothing outside module 08", () => {
    expect(readersOf(/earlyAccess|early_access/, ["app"], ownModule)).toEqual([]);
    expect(CHECKOUT_STATE.vip.web).toBe("partial");
  });

  test("product pages, lists and search read no flash sale: the sale price shows from the cart on", () => {
    const readers = readersOf(/flashSaleItems|flash_sale_items|flashSales\b|flash_sales/, ["app"], ownModule);
    expect(readers).toEqual(["app/server/services/orders/promotions.server.ts"]);
    expect(CHECKOUT_STATE.flash.web).toBe("partial");
  });

  test("the storefront assigns and counts no A/B visitor", () => {
    expect(readersOf(/insert\(experimentAssignments|insert\(experimentEvents|INSERT INTO experiment_/, ["app"])).toEqual([]);
    expect(CHECKOUT_STATE.experiments.web).toBe("partial");
  });

  test("the checkout takes points and a referral code; sign-up records no referral", () => {
    expect(Object.keys(CheckoutInput.shape)).toEqual(expect.arrayContaining(["redeemPoints", "referralCode"]));
    expect(readersOf(/referral/i, ["app/server/auth", "app/routes/storefront/account/signup.tsx"])).toEqual([]);
    expect(CHECKOUT_STATE.referrals).toEqual({ web: "applied", pos: "missing" });
  });
});

// ───────────────────────────────────────────────────────────────── points from the till (a database)

describe("points from the till", () => {
  let t: TestDb;
  let make: Fixtures;
  beforeAll(async () => {
    t = await createTestDb();
    make = fixtures(t.db, NOW);
  });
  afterAll(async () => {
    await t?.dispose();
  });

  test("a delivered sale at the till to a known customer earns points after the return window, times the VIP multiplier", async () => {
    const customerId = await make.customer();
    const product = await make.product({ priceIqd: 120_000, stock: 5 });
    const tierId = newId("tier");
    await t.db.insert(membershipTiers).values({ id: tierId, key: "gold-till", name: { ar: "ذهبي" }, benefits: { pointsMultiplierBps: 15_000, discountBps: 1_000 }, sort: 0, isActive: true });
    await t.db.insert(memberships).values({ id: newId("mbr"), customerId, tierId, status: "active", startsAt: NOW - 100 * DAY, endsAt: null, source: "grant", createdAt: NOW - 100 * DAY });
    const sale = await make.order([{ ...product, qty: 1, unitPriceIqd: 120_000 }], { channel: "pos", customerId, status: "delivered", paymentStatus: "paid", paidIqd: 120_000, shippingIqd: 0, deliveredAt: NOW - 60 * DAY, placedAt: NOW - 60 * DAY, isDemo: false });
    await syncOrderPoints(t.db, systemActor("promotions.points.sync"), NOW);
    const earned = await t.db.select({ points: loyaltyLedger.points }).from(loyaltyLedger).where(eq(loyaltyLedger.idempotencyKey, `loyalty:earn:${sale.orderId}`)).get();
    // 120,000 IQD kept → 120 points, × 1.5 for the member
    expect(earned?.points).toBe(Math.floor((120 * DEFAULT_PROGRAM.loyalty.pointsPerThousandIqd * 15_000) / 10_000));
  });

  test("a coupon for the point of sale only is refused online (and the till takes no coupon)", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 5 });
    await t.db.insert(coupons).values({ id: newId("cpn"), code: "TILLONLY", kind: "fixed", value: 5_000, conditions: { channels: ["pos"] }, isActive: true, createdAt: NOW - DAY });
    expect(await evaluateCoupon(t.db, { code: "TILLONLY", subtotalIqd: 100_000, lines: [{ variantId: product.variantId, qty: 1, unitPriceIqd: 100_000 }] }, NOW)).toEqual({ ok: false, reason: "not_applicable" });
    expect(CHECKOUT_STATE.coupons.pos).toBe("missing");
  });

  test("review 2026-11-13: a rule's dry run weighs the whole discount an order had (points here, no coupon) — its words say «discount», not «coupon»", async () => {
    const product = await make.product({ priceIqd: 100_000, stock: 5 });
    // orders.discount_iqd is the sum of every discount the checkout applied: rules, the coupon, the membership, points
    await make.order([{ ...product, qty: 1, unitPriceIqd: 100_000 }], { placedAt: NOW - DAY, discountIqd: 30_000, isDemo: false });
    const ruleId = newId("prm");
    await t.db.insert(promotions).values({ id: ruleId, name: { ar: "خصم 10%" }, kind: "percent", value: 1_000, stackable: false, priority: 0, isActive: false, isDemo: false, createdAt: NOW - DAY, updatedAt: NOW - DAY });
    const run = await dryRun(t.db, systemActor("review"), ruleId, { days: 30, includeDemo: false }, NOW);
    // 10% = 10,000 is less than the 30,000 of points the order had: skipped as "its discount was better" — no coupon involved
    expect(run.skips.coupon_better).toBeGreaterThanOrEqual(1);
    const coupon = { ar: /كوبون/, en: /coupon/i, ckb: /کۆپۆن/ } as const;
    for (const locale of LOCALES) {
      for (const key of ["rules.dry.coupon", "rules.dry.cardLine", "rules.dry.skip.coupon_better"]) {
        expect(say(locale, key, { count: 2, subtotal: "100,000", coupon: "30,000" }), `${locale}: ${key}`).not.toMatch(coupon[locale]);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── review 2026-11-13 (wave B reviewer)

describe("review 2026-11-13: the module's words match what the core does", () => {
  test("every reference a points row can carry has its label in ar, en and ckb — the checkout gives redeemed points back as 'redeem'", () => {
    // what the server writes into loyalty_ledger: refType literals, and the raw insert's ('<kind>', '<ref_type>') pair
    // (orders/promotions.server.ts pointsReturnStatement) — the ledger showed «points.ref.redeem» for those rows
    const written = new Set<string>();
    for (const file of filesUnder("app/server")) {
      const source = readFileSync(file, "utf8");
      if (!/insert\(loyaltyLedger\)|INSERT INTO loyalty_ledger/.test(source)) continue;
      for (const match of source.matchAll(/refType: "([a-z_]+)"/g)) written.add(match[1] as string);
      for (const match of source.matchAll(/'(?:earn|redeem|expire|adjust|reversal)', '([a-z_]+)'/g)) written.add(match[1] as string);
    }
    expect([...written]).toEqual(expect.arrayContaining(["approval", "expiry", "manual", "order", "redeem", "referral"]));
    for (const locale of LOCALES) for (const ref of written) expect(say(locale, `points.ref.${ref}`), `${locale}: points.ref.${ref}`).not.toBe("");
  });

  test("rules that do not combine with coupons: only the best one applies, alone, when it beats the combining rules and the coupon together; free delivery either way", () => {
    const offer = (id: string, over: Partial<RuleTerms>) => ({ id, label: id, terms: rule(over), isDemo: false });
    const rules = [
      offer("combines-5", { stackable: true, value: 500, priority: 10 }), // 10,000 of 200,000
      offer("alone-10", { stackable: false, value: 1_000 }), // 20,000
      offer("alone-8", { stackable: false, value: 800 }), // 16,000
      offer("free-delivery", { kind: "free_shipping", value: null, stackable: false }),
    ];
    const ids = (outcome: ReturnType<typeof applyDiscounts>) => outcome.discounts.map((entry) => (entry.kind === "rule" ? entry.ruleId : entry.kind));
    // 10,000 + a 5,000 coupon < 20,000: the best rule that does not combine applies alone — no other rule, no coupon
    const small = applyDiscounts({ ...cart, rules, coupon: { couponId: "c1", code: "SAVE5", label: "SAVE5", discountIqd: 5_000 } });
    expect(ids(small)).toEqual(["alone-10"]);
    expect(small.couponDropped).toEqual({ ruleLabel: "alone-10" });
    expect(small.shippingWaiver).toMatchObject({ by: "rule", ruleId: "free-delivery", waivedIqd: 5_000 });
    // 10,000 + a 15,000 coupon > 20,000: the combining rules and the coupon; no rule that does not combine
    const big = applyDiscounts({ ...cart, rules, coupon: { couponId: "c1", code: "SAVE15", label: "SAVE15", discountIqd: 15_000 } });
    expect(ids(big)).toEqual(["combines-5", "coupon"]);
    expect(big.shippingWaiver).toMatchObject({ by: "rule", ruleId: "free-delivery" });
    // what staff read says exactly that: the overview's / the note's sentence, and the rule form's hint
    const alone = { ar: "وحدها", en: "alone", ckb: "بە تەنها" } as const;
    const combining = { ar: "القواعد التي تجتمع", en: "the rules that combine", ckb: "ئەو یاسایانەی" } as const;
    for (const locale of LOCALES) {
      expect(say(locale, "home.checkout.rules.web"), `${locale}: the note`).toContain(alone[locale]);
      expect(say(locale, "rules.f.stackHint"), `${locale}: the form's hint`).toContain(combining[locale]);
    }
  });

  test("redeemed points: all come back when the order is cancelled, a share with a refund — and the note says so", () => {
    expect(restoredPointsFor({ redeemedPoints: 100, restoredSoFar: 0, refundIqd: 50_000, paidIqd: 200_000, full: false })).toBe(25);
    expect(restoredPointsFor({ redeemedPoints: 100, restoredSoFar: 25, refundIqd: 0, paidIqd: 200_000, full: true })).toBe(75);
    const share = { ar: "حصتها", en: "share", ckb: "بەشی خۆیان" } as const;
    for (const locale of LOCALES) expect(say(locale, "home.checkout.points.web", { value: "10" }), locale).toContain(share[locale]);
  });

  test("trying a coupon prices the items at their regular price (at checkout a running flash sale's price comes first) — the panel says so", () => {
    const source = readFileSync(path.join(ROOT, "app/server/services/admin/promotions/coupons.server.ts"), "utf8");
    const start = source.indexOf("export async function tryCoupon");
    const body = source.slice(start, source.indexOf("\n}\n", start));
    expect(body).toContain("price: variants.priceIqd");
    expect(body).not.toMatch(/runningFlashPrice|flashSale/);
    const regular = { ar: "السعر العادي", en: "regular price", ckb: "نرخی ئاسایی" } as const;
    for (const locale of LOCALES) expect(say(locale, "coupons.try.lead"), locale).toContain(regular[locale]);
  });

  test("a section's «not built yet» line reads as one sentence after its label, and the empty ledger knows the nightly posting", () => {
    const nightly = { ar: "كل ليلة", en: "every night", ckb: "هەموو شەوێک" } as const;
    for (const locale of LOCALES) {
      // SectionState writes «لم يُبنَ بعد:» before these: a second colon read as a label inside a label
      for (const key of ["gift.boundary", "referrals.signup"]) expect(say(locale, key), `${locale}: ${key}`).not.toMatch(/:/);
      expect(say(locale, "points.emptyHint"), `${locale}: points.emptyHint`).toContain(nightly[locale]);
    }
  });
});
