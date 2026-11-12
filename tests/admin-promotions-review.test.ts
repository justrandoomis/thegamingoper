/**
 * Admin module 08 "promotions" — the adversarial review (2026-11-12). Each test here failed on the builder's code:
 *
 *   · field rules: a flash sale's page, its submit answer and the approvals queue told staff WITHOUT profit.read that
 *     a sale price is under the cost or the minimum margin (`needsOverride`, the "a second person for a reason you
 *     cannot see" tag) and that a SKU has no cost (`cost_unknown`) — signals pricing 03 hides from them; the floor went
 *     to cost.read alone (pricing shows it only with profit.read)
 *   · two-person rules: a flash cut was measured from today's price, so a cut of the price (alone, under 10 %) followed
 *     by a flash sale (alone, under 10 %) took a SKU far below its 30-day high with nobody approving (pricing 03 counts
 *     from the 30-day high); a flash request approved by someone without pricing.discount.override after the cost rose
 *     above the sale price; point adjustments split under the 5,000-point limit had no daily ceiling (also two at once)
 *   · IDOR: a record's page decided ANOTHER record's request (its approval id posted to the wrong page)
 *   · money: a gift-card redemption sent twice (double click, a retry) answered "already used" instead of the first
 *     result — there was no idempotency key per redemption; a DEMO card put real money in a real customer's wallet; a
 *     customer merged away just before the redemption's batch still received the money
 *   · races: a referral was rewarded although its order was returned just before the reward's batch
 *   · input: "try this coupon" refused quantities typed in Arabic-Indic digits; switching off 100 coupons at once (what
 *     the service accepts) crashed on D1's 100-parameter limit (500)
 *   · counts: "Members (N)" on the VIP page counted something else than its list
 */
import { and, eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { action as couponAction } from "~/routes/admin/promotions/coupon";
import { action as pointsCustomerAction } from "~/routes/admin/promotions/points-customer";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, coupons, customers, employeeRoles, giftCards, loyaltyLedger, memberships, orders, priceChanges, variantCosts, variants, walletLedger } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { listApprovals } from "~/server/services/admin/promotions/approvals.server";
import { deactivateCoupons, getCoupon, saveCoupon, tryCoupon } from "~/server/services/admin/promotions/coupons.server";
import { getRule, saveRule, setRuleActive } from "~/server/services/admin/promotions/discounts.server";
import { createFlashSale, decideFlashSale, getFlashSale, setFlashItem, submitFlashSale } from "~/server/services/admin/promotions/flash.server";
import { checkGiftCardRedemption, issueGiftCard, listGiftCards, redeemGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { adjustPoints, customerPoints } from "~/server/services/admin/promotions/loyalty.server";
import { promotionsOverview } from "~/server/services/admin/promotions/overview.server";
import { issueReferralCode, recordReferral, rewardReferral } from "~/server/services/admin/promotions/referrals.server";
import { LOYALTY, baghdadDay, toBaghdadInput } from "~/server/services/admin/promotions/types";
import { grantMembership, saveTier, vipPage } from "~/server/services/admin/promotions/vip.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const DATA_KEY = TEST_VARS.DATA_KEY;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance"] as const) staff[key] = await employee(key);
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
/** A custom role on an existing account (same id): only these permissions. */
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

type Batch = (statements: unknown) => Promise<unknown>;

/** The same database, except that `hook` runs once just before the `nth` db.batch call: a competing request. */
function beforeBatch(db: Db, nth: number, hook: () => PromiseLike<unknown>): Db {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: unknown) => {
          calls += 1;
          if (calls === nth) await hook();
          return (target.batch as unknown as Batch).call(target, statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A SKU with stock and a landed cost (and a minimum margin), created 60 days ago. */
async function costedSku(priceIqd: number, landedIqd: number | null, minMarginBps: number | null = 1000) {
  const product = await make.product({ priceIqd, stock: 10 });
  await t.db.update(variants).set({ createdAt: NOW - 60 * DAY }).where(eq(variants.id, product.variantId));
  if (landedIqd !== null) await t.db.insert(variantCosts).values({ variantId: product.variantId, currency: "IQD", unitCostMinor: landedIqd, landedCostIqd: landedIqd, minMarginBps, updatedAt: NOW });
  return product;
}

async function draftSale(actor: EmployeeActor, sku: string, salePrice: string) {
  const created = await createFlashSale(t.db, actor, { nameAr: "عرض للمراجعة", startsAt: toBaghdadInput(NOW + DAY), endsAt: toBaghdadInput(NOW + 2 * DAY), idempotencyKey: key() }, NOW);
  await setFlashItem(t.db, actor, { saleId: created.saleId, code: sku, salePrice }, NOW, "ar");
  return created.saleId;
}

// ───────────────────────────────────────────────────────────────── signed-in requests (route modules)

function requestCtx(): RequestCtx {
  return {
    requestId: `review-${randomToken(6)}`,
    nonce: "n",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie: () => {},
  };
}

/** A signed-in employee (session cookie) with a built-in role; returns the cookie and the employee's id. */
async function signedIn(role: DefaultRoleKey): Promise<{ cookie: string; id: string }> {
  const password = "promotions-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("rev")}@promotions-review.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), id };
}

/** Runs an action (a same-origin POST) inside the request middleware; returns what it returned or threw. */
async function runPost(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown, entries: Record<string, string>): Promise<unknown> {
  const body = new FormData();
  for (const [name, value] of Object.entries(entries)) body.append(name, value);
  const request = new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN }, body });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params, url: new URL(request.url), pattern: path } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}
/** The JSON body and status of an action's answer (a plain object, or `data(…, { status })`). */
function answer(value: unknown): { status: number; body: Record<string, unknown> } {
  const wrapped = value as { type?: string; data?: unknown; init?: { status?: number } } | null;
  if (wrapped && wrapped.type === "DataWithResponseInit") return { status: wrapped.init?.status ?? 200, body: wrapped.data as Record<string, unknown> };
  return { status: 200, body: value as Record<string, unknown> };
}

// ───────────────────────────────────────────────────────────────── field rules (cost, profit)

describe("field rules: flash checks follow pricing 03's own visibility", () => {
  test("without profit.read: no 'needs override', no 'cost unknown', no hidden-reason tag — on the page, in the submit answer and in the queue; the floor only with profit.read", async () => {
    const belowCost = await costedSku(1_000_000, 700_000);
    const saleId = await draftSale(as("manager"), belowCost.sku, "650,000");
    const blind = custom(["promotions.flash_sale.manage"]);
    const page = await getFlashSale(t.db, blind, saleId, NOW, "ar");
    expect(page.items[0].check.needsOverride).toBeUndefined();
    expect(page.needsOverride).toBeFalsy();
    expect(page.items[0].check.reasons).not.toContain("below_cost");
    // a cost-only reader sees no floor either (pricing shows it with profit.read only)
    const costOnly = await getFlashSale(t.db, custom(["promotions.flash_sale.manage", "cost.read"]), saleId, NOW, "ar");
    expect(costOnly.items[0].check.floorIqd).toBeUndefined();
    // with cost + profit everything is there
    const full = await getFlashSale(t.db, as("manager"), saleId, NOW, "ar");
    expect(full.items[0].check).toMatchObject({ needsOverride: true, floorIqd: expect.any(Number) });

    // the submit answer and the request carry the same rule
    const submitted = await submitFlashSale(t.db, blind, { saleId, reason: "عرض للمراجعة" }, NOW, "ar");
    expect(submitted.status).toBe("requested");
    expect(JSON.stringify(submitted)).not.toContain('"needsOverride":true');
    const waiting = await getFlashSale(t.db, blind, saleId, NOW, "ar");
    expect(waiting.pending?.needsOverride).toBeFalsy();
    const queue = await listApprovals(t.db, blind, "ar", { iqd: String, percent: String, points: String });
    const mine = queue.mine.find((card) => card.href === `/admin/promotions/flash/${saleId}`);
    expect(mine).toBeTruthy();
    expect(mine?.facts.some((fact) => fact.label === "override")).toBe(false);

    // a SKU without a cost: "cost unknown" is a cost fact, hidden like pricing hides it
    const uncosted = await costedSku(300_000, null);
    const second = await draftSale(as("manager"), uncosted.sku, "290,000");
    const seen = await getFlashSale(t.db, blind, second, NOW, "ar");
    expect(seen.items[0].check.reasons).not.toContain("cost_unknown");
    expect((await getFlashSale(t.db, as("manager"), second, NOW, "ar")).items[0].check.reasons).toContain("cost_unknown");
  });
});

// ───────────────────────────────────────────────────────────────── two-person rules

describe("two-person rules", () => {
  test("a flash cut counts from the 30-day high (pricing 03's rule): a quiet cut of the price plus a quiet flash cut needs a second person", async () => {
    const sku = await costedSku(920_000, 500_000);
    // yesterday the price went from 1,000,000 to 920,000 (8 %), alone
    await t.db.insert(priceChanges).values({ id: newId("pch"), variantId: sku.variantId, oldPriceIqd: 1_000_000, newPriceIqd: 920_000, reason: "تخفيض", requestedBy: as("manager").id, approvedBy: null, status: "applied", createdAt: NOW - DAY, source: "manual" });
    // a flash price of 850,000 is 7.6 % under today's price, 15 % under the 30-day high
    const saleId = await draftSale(as("manager"), sku.sku, "850000");
    const page = await getFlashSale(t.db, as("manager"), saleId, NOW, "ar");
    expect(page.items[0].check.reasons).toContain("drop_over_limit");
    expect(await submitFlashSale(t.db, as("manager"), { saleId, reason: "عرض نهاية الأسبوع" }, NOW, "ar")).toMatchObject({ status: "requested" });
  });

  test("a flash request is decided by pricing's rules AT the decision: the cost rose above the sale price → only someone with the override approves", async () => {
    const sku = await costedSku(1_000_000, 600_000);
    const saleId = await draftSale(as("manager"), sku.sku, "800000");
    expect(await submitFlashSale(t.db, as("manager"), { saleId, reason: "عرض" }, NOW, "ar")).toMatchObject({ status: "requested" });
    // the landed cost rises after the request: 800,000 is now under the cost
    await t.db.update(variantCosts).set({ landedCostIqd: 900_000, unitCostMinor: 900_000 }).where(eq(variantCosts.variantId, sku.variantId));
    const approvalId = (await getFlashSale(t.db, as("manager2"), saleId, NOW, "ar")).pending?.approvalId as string;
    const noOverride = custom(["promotions.flash_sale.manage", "pricing.price.approve", "cost.read", "profit.read"], "manager2");
    const refused = await failureOf(decideFlashSale(t.db, noOverride, { approvalId, decision: "approve", note: "موافق" }, NOW, "ar"));
    expect(refused).toMatchObject({ status: 403, code: "override_required" });
    expect((await t.db.select().from(approvals).where(eq(approvals.id, approvalId)).get())?.status).toBe("pending");
    // someone holding the override may
    await decideFlashSale(t.db, as("manager2"), { approvalId, decision: "approve", note: "موافق تحت التكلفة" }, NOW, "ar");
    expect((await getFlashSale(t.db, as("manager"), saleId, NOW, "ar")).state).toBe("scheduled");
  });

  test("point adjustments cannot be split under the limit: what one employee gives alone in 24 hours is capped (two tabs at once included)", async () => {
    const customerId = await make.customer();
    const giver = custom(["promotions.loyalty.adjust", "promotions.promotion.read"], "owner");
    const step = 4_000;
    expect(step).toBeLessThanOrEqual(LOYALTY.adjustSecondPersonPoints);
    expect(await adjustPoints(t.db, giver, { customerId, points: String(step), reason: "تعويض أول", idempotencyKey: key() }, NOW)).toMatchObject({ status: "applied" });
    expect(await adjustPoints(t.db, giver, { customerId, points: String(step), reason: "تعويض ثانٍ", idempotencyKey: key() }, NOW)).toMatchObject({ status: "applied" });
    // the third small one would take this employee past the daily ceiling alone: it waits for a second person
    expect(await adjustPoints(t.db, giver, { customerId, points: String(step), reason: "تعويض ثالث", idempotencyKey: key() }, NOW)).toMatchObject({ status: "requested" });
    expect((await customerPoints(t.db, giver, customerId, NOW)).balance).toBe(2 * step);
    // a day later the window is fresh
    expect(await adjustPoints(t.db, giver, { customerId, points: String(step), reason: "تعويض الغد", idempotencyKey: key() }, NOW + DAY + 1)).toMatchObject({ status: "applied" });

    // two at once: each saw 4,000 given so far; the batch re-checks the window
    const other = await make.customer();
    const second = custom(["promotions.loyalty.adjust", "promotions.promotion.read"], "manager2");
    await adjustPoints(t.db, second, { customerId: other, points: String(step), reason: "تعويض", idempotencyKey: key() }, NOW);
    const racing = beforeBatch(t.db, 1, () => adjustPoints(t.db, second, { customerId: other, points: String(step), reason: "من نافذة أخرى", idempotencyKey: key() }, NOW));
    const raced = await failureOf(adjustPoints(racing, second, { customerId: other, points: String(step), reason: "النافذة الأولى", idempotencyKey: key() }, NOW));
    expect(raced.status).toBe(409);
    expect((await customerPoints(t.db, second, other, NOW)).balance).toBe(2 * step);
  });
});

// ───────────────────────────────────────────────────────────────── one request at a time

describe("one waiting request per record, also when two are sent at once", () => {
  test("a coupon edit and a rule switch-on each leave exactly one request when a second one lands just before the batch", async () => {
    const saved = await saveCoupon(t.db, as("manager"), { code: "TWICE5", kind: "fixed", value: "5000", usageLimit: "10", activate: "on" }, NOW);
    const detail = await getCoupon(t.db, as("manager"), saved.couponId, NOW);
    const edit = (actor: EmployeeActor, value: string) => saveCoupon(t.db, actor, { couponId: saved.couponId, kind: "fixed", value, usageLimit: "10", reason: "رفع القيمة", expected: detail.fingerprint }, NOW);
    const racing = beforeBatch(t.db, 1, () => edit(as("manager2"), "90000"));
    const refused = await failureOf(saveCoupon(racing, as("manager"), { couponId: saved.couponId, kind: "fixed", value: "80000", usageLimit: "10", reason: "رفع القيمة", expected: detail.fingerprint }, NOW));
    expect(refused).toMatchObject({ code: "change_pending", status: 409 });
    expect((await t.db.select().from(approvals).where(and(eq(approvals.entityId, saved.couponId), eq(approvals.status, "pending")))).length).toBe(1);

    const rule = await saveRule(t.db, as("manager"), { idempotencyKey: key(), nameAr: "خصم كبير مرتين", kind: "percent", value: "40", maxDiscountIqd: "30000" }, NOW);
    const ruleRow = await getRule(t.db, as("manager"), rule.ruleId, NOW);
    const on = (actor: EmployeeActor, db = t.db) => setRuleActive(db, actor, { ruleId: rule.ruleId, active: true, reason: "تشغيل", expectedUpdatedAt: ruleRow.updatedAt }, NOW);
    const racingRule = beforeBatch(t.db, 1, () => on(as("manager2")));
    expect((await failureOf(on(as("manager"), racingRule))).code).toBe("change_pending");
    expect((await t.db.select().from(approvals).where(and(eq(approvals.entityId, rule.ruleId), eq(approvals.status, "pending")))).length).toBe(1);

    // a flash sale submitted from two tabs: one request
    const sku = await costedSku(1_000_000, 500_000);
    const saleId = await draftSale(as("manager"), sku.sku, "800000");
    const racingSale = beforeBatch(t.db, 1, () => submitFlashSale(t.db, as("manager2"), { saleId, reason: "عرض" }, NOW, "ar"));
    expect((await failureOf(submitFlashSale(racingSale, as("manager"), { saleId, reason: "عرض" }, NOW, "ar"))).code).toBe("change_pending");
    expect((await t.db.select().from(approvals).where(and(eq(approvals.entityId, saleId), eq(approvals.status, "pending")))).length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── IDOR

describe("a record's page decides only its own request", () => {
  test("coupon A's page with coupon B's approval id: 404, and B still waits", async () => {
    const a = await saveCoupon(t.db, as("manager"), { code: "IDORA30", kind: "percent", value: "30", maxDiscountIqd: "20000", usageLimit: "10", activate: "on" }, NOW);
    const b = await saveCoupon(t.db, as("manager"), { code: "IDORB35", kind: "percent", value: "35", maxDiscountIqd: "20000", usageLimit: "10", activate: "on" }, NOW);
    const approvalB = (await getCoupon(t.db, as("manager"), b.couponId, NOW)).pending?.approvalId as string;
    const decider = await signedIn("manager");
    const out = answer(await runPost(decider.cookie, `/admin/promotions/coupons/${a.couponId}`, { couponId: a.couponId }, couponAction as never, { intent: "decide", approvalId: approvalB, decision: "approve", note: "موافق" }));
    expect(out.status).toBe(404);
    expect((await t.db.select().from(approvals).where(eq(approvals.id, approvalB)).get())?.status).toBe("pending");
    expect((await t.db.select().from(coupons).where(eq(coupons.id, b.couponId)).get())?.isActive).toBe(false);
    // on its own page it is decided
    const own = answer(await runPost(decider.cookie, `/admin/promotions/coupons/${b.couponId}`, { couponId: b.couponId }, couponAction as never, { intent: "decide", approvalId: approvalB, decision: "approve", note: "موافق" }));
    expect(own.body).toMatchObject({ ok: true });
  });

  test("customer A's points page with customer B's adjustment request: 404, B's points unchanged", async () => {
    const a = await make.customer();
    const b = await make.customer();
    await adjustPoints(t.db, as("manager"), { customerId: b, points: "6000", reason: "جائزة مسابقة", idempotencyKey: key() }, NOW);
    const approvalB = (await customerPoints(t.db, as("manager2"), b, NOW)).pending[0].approvalId;
    const decider = await signedIn("manager");
    const out = answer(await runPost(decider.cookie, `/admin/promotions/points/${a}`, { customerId: a }, pointsCustomerAction as never, { intent: "decide", approvalId: approvalB, decision: "approve", note: "موافق" }));
    expect(out.status).toBe(404);
    expect((await customerPoints(t.db, as("manager"), b, NOW)).balance).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── gift cards

describe("gift cards: one redemption, real money only from real cards", () => {
  test("the same redemption sent twice answers the first result; the key with another card is a mismatch", async () => {
    const issued = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "25000", note: "تعويض عن تأخير", idempotencyKey: key() }, NOW);
    const customerId = await make.customer();
    const form = key();
    const first = await redeemGiftCard(t.db, as("manager"), { code: issued.code, customerId, idempotencyKey: form }, NOW);
    expect(first).toMatchObject({ cardId: issued.cardId, amountIqd: 25_000 });
    const again = await redeemGiftCard(t.db, as("manager"), { code: issued.code, customerId, idempotencyKey: form }, NOW);
    expect(again).toMatchObject({ cardId: issued.cardId, amountIqd: 25_000, walletEntryId: first.walletEntryId, replayed: true });
    expect(await getWalletBalance(t.db, customerId)).toBe(25_000);
    // another form (another person at another counter) gets "already used"
    expect((await failureOf(redeemGiftCard(t.db, as("manager2"), { code: issued.code, customerId, idempotencyKey: key() }, NOW))).code).toBe("gift_card_used");
    // the first form's key reused for another card is refused
    const other = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "10000", note: "تعويض آخر", idempotencyKey: key() }, NOW);
    expect((await failureOf(redeemGiftCard(t.db, as("manager"), { code: other.code, customerId, idempotencyKey: form }, NOW))).code).toBe("idempotency_mismatch");
    expect((await t.db.select().from(giftCards).where(eq(giftCards.id, other.cardId as string)).get())?.status).toBe("active");
  });

  test("a demo card never puts money in a real customer's wallet", async () => {
    const demo = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "30000", note: "بطاقة تجريبية", idempotencyKey: key() }, NOW, { demo: true });
    const real = await make.customer({ isDemo: false });
    const refused = await failureOf(redeemGiftCard(t.db, as("manager"), { code: demo.code, customerId: real, idempotencyKey: key() }, NOW));
    expect(refused.status).toBe(409);
    expect(await getWalletBalance(t.db, real)).toBe(0);
    expect((await t.db.select().from(giftCards).where(eq(giftCards.id, demo.cardId as string)).get())?.status).toBe("active");
    // into a demo customer's wallet it works
    const demoCustomer = await make.customer({ isDemo: true });
    await redeemGiftCard(t.db, as("manager"), { code: demo.code, customerId: demoCustomer, idempotencyKey: key() }, NOW);
    expect(await getWalletBalance(t.db, demoCustomer)).toBe(30_000);
  });

  test("the redemption's confirm dialog: the amount and whose wallet, before anything moves (reads only, same checks)", async () => {
    const issued = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "12000", note: "تعويض", idempotencyKey: key() }, NOW);
    const phone = make.phone();
    const customerId = await make.customer({ phoneE164: phone, name: "زبون المحفظة" });
    const masked = await checkGiftCardRedemption(t.db, custom(["promotions.gift_card.manage"]), { code: issued.code, phone: phone.replace("+964", "0") }, NOW);
    expect(masked).toMatchObject({ cardId: issued.cardId, amountIqd: 12_000, customer: { id: customerId, name: "زبون المحفظة", phone: { full: false } } });
    expect(JSON.stringify(masked)).not.toContain(phone.slice(-7));
    expect((await failureOf(checkGiftCardRedemption(t.db, as("finance"), { code: issued.code, phone }, NOW))).status).toBe(403);
    expect((await failureOf(checkGiftCardRedemption(t.db, as("manager"), { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ", phone }, NOW))).code).toBe("gift_card_unknown");
    // it moved nothing
    expect(await getWalletBalance(t.db, customerId)).toBe(0);
    expect((await t.db.select().from(giftCards).where(eq(giftCards.id, issued.cardId as string)).get())?.status).toBe("active");
  });

  test("a customer merged away just before the redemption's batch receives nothing", async () => {
    const issued = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "15000", note: "تعويض", idempotencyKey: key() }, NOW);
    const customerId = await make.customer();
    const racing = beforeBatch(t.db, 1, () => t.db.update(customers).set({ status: "merged" }).where(eq(customers.id, customerId)));
    const refused = await failureOf(redeemGiftCard(racing, as("manager"), { code: issued.code, customerId, idempotencyKey: key() }, NOW));
    expect(refused.code).toBe("customer_unavailable");
    expect((await t.db.select().from(walletLedger).where(eq(walletLedger.customerId, customerId))).length).toBe(0);
    expect((await t.db.select().from(giftCards).where(eq(giftCards.id, issued.cardId as string)).get())?.status).toBe("active");
  });
});

// ───────────────────────────────────────────────────────────────── referrals

describe("referrals: the reward re-checks its order inside the batch", () => {
  test("an order returned just before the reward's batch earns the referrer nothing", async () => {
    const referrerId = await make.customer();
    const code = await issueReferralCode(t.db, as("manager"), { customerId: referrerId }, NOW);
    const friendPhone = make.phone();
    const friendId = await make.customer({ phoneE164: friendPhone });
    const product = await make.product({ priceIqd: 90_000 });
    const order = await make.order([{ ...product, qty: 1, unitPriceIqd: 90_000 }], { customerId: friendId, contactPhoneE164: friendPhone, status: "delivered", deliveredAt: NOW - 20 * DAY, placedAt: NOW - 21 * DAY, isDemo: false });
    const recorded = await recordReferral(t.db, as("manager"), { code: code.code, phone: friendPhone, orderRef: order.ref, note: "أخبرنا في المتجر", idempotencyKey: key() }, NOW);
    const racing = beforeBatch(t.db, 1, () => t.db.update(orders).set({ status: "returned" }).where(eq(orders.id, order.orderId)));
    const refused = await failureOf(rewardReferral(racing, as("manager2"), { referralId: recorded.referralId, note: "تحقق" }, NOW));
    expect(refused.code).toBe("referral_not_qualified");
    expect((await t.db.select().from(loyaltyLedger).where(and(eq(loyaltyLedger.customerId, referrerId), eq(loyaltyLedger.refType, "referral")))).length).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── input

describe("input", () => {
  test("'try this coupon' reads quantities typed in Arabic-Indic and Persian digits", async () => {
    const product = await make.product({ priceIqd: 40_000, stock: 5 });
    await saveCoupon(t.db, as("manager"), { code: "TRYDIGITS", kind: "fixed", value: "5000", usageLimit: "10", activate: "on" }, NOW);
    const arabic = await tryCoupon(t.db, as("finance"), { code: "TRYDIGITS", lines: [{ code: product.sku, qty: "٢" }] }, NOW);
    expect(arabic).toMatchObject({ subtotalIqd: 80_000, result: { ok: true, discountIqd: 5000 } });
    const persian = await tryCoupon(t.db, as("finance"), { code: "TRYDIGITS", lines: [{ code: product.sku, qty: "۳" }] }, NOW);
    expect(persian.subtotalIqd).toBe(120_000);
    expect((await failureOf(tryCoupon(t.db, as("finance"), { code: "TRYDIGITS", lines: [{ code: product.sku, qty: "abc" }] }, NOW))).status).toBe(400);
  });

  test("switching off as many coupons as the service accepts never hits D1's parameter limit", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await saveCoupon(t.db, as("manager"), { code: `BULK100${i}`, kind: "fixed", value: "1000", usageLimit: "5", activate: "on" }, NOW)).couponId);
    while (ids.length < 100) ids.push(newId("cpn"));
    const result = await deactivateCoupons(t.db, as("manager"), { couponIds: ids, reason: "نهاية الموسم" }, NOW);
    expect(result).toEqual({ changed: 3, skipped: 97 });
  });
});

// ───────────────────────────────────────────────────────────────── counts

describe("counts equal their lists", () => {
  test("a gift card past its date is expired in its row, the views, the settlement and the front page alike", async () => {
    const issued = await issueGiftCard(t.db, as("manager"), DATA_KEY, { amountIqd: "8000", expiresOn: baghdadDay(NOW + DAY), note: "بطاقة قصيرة", idempotencyKey: key() }, NOW);
    const later = NOW + 3 * DAY;
    const all = await listGiftCards(t.db, as("finance"), { view: "all", q: "", page: 1 }, later);
    expect(all.rows.find((row) => row.id === issued.cardId)).toMatchObject({ status: "expired", balanceIqd: 0 });
    const active = await listGiftCards(t.db, as("finance"), { view: "active", q: "", page: 1 }, later);
    expect(active.rows.some((row) => row.id === issued.cardId)).toBe(false);
    expect(active.total).toBe(active.counts.active);
    expect(active.counts.active).toBe((await promotionsOverview(t.db, as("finance"), later)).giftCards?.active);
    const expired = await listGiftCards(t.db, as("finance"), { view: "expired", q: "", page: 1 }, later);
    expect(expired.rows.some((row) => row.id === issued.cardId)).toBe(true);
    expect(expired.counts.expired).toBe(expired.settlement.expired.count);
  });

  test("the VIP page's members count is the number of members its list shows; the front page agrees", async () => {
    const tier = await saveTier(t.db, as("manager"), { key: `silver${make.next("t").replace(/\D/g, "")}`, nameAr: "فضي", discount: "3", notesAr: "خصم 3% على الطلبات", isActive: "on", reason: "إطلاق" }, NOW);
    const current = await make.customer();
    const ended = await make.customer();
    await grantMembership(t.db, as("manager"), { customerId: current, tierId: tier.tierId, reason: "عميل مميز" }, NOW);
    await grantMembership(t.db, as("manager"), { customerId: ended, tierId: tier.tierId, days: "5", reason: "عضوية قصيرة" }, NOW - 10 * DAY);
    // "Members (N)": the list shows exactly the N members the front page counts — not an ended one
    const page = await vipPage(t.db, as("manager"), NOW, "ar");
    expect(page.members.every((row) => row.status === "active")).toBe(true);
    expect(page.members.map((row) => row.customerId)).toEqual([current]);
    expect(page.memberTotal).toBe(page.members.length);
    expect((await promotionsOverview(t.db, as("manager"), NOW)).vip?.members).toBe(page.memberTotal);
    // the ended one (its end passed, not closed yet) is in the "ended" view, counted there
    const endedView = await vipPage(t.db, as("manager"), NOW, "ar", { members: "ended", page: 1 });
    expect(endedView.members.map((row) => [row.customerId, row.status])).toEqual([[ended, "expired"]]);
    expect(endedView.memberTotal).toBe(endedView.members.length);
    expect(page.memberCounts).toEqual({ current: 1, ended: 1 });
    expect(page.endedWaiting).toBe(1);
    expect((await t.db.select({ n: sql<number>`count(*)` }).from(memberships).where(eq(memberships.status, "active")).get())?.n).toBe(2);
  });
});
