/**
 * Module follow-up (2026-11-12), DO item 2: the rules admin 07 customers and admin 08 promotions kept as constants are
 * settings now — typed keys in app/server/settings.server.ts (additive), edited in the settings module, read by the
 * modules with their exported signatures unchanged. Each test failed before (the keys did not exist):
 *
 *   · the defaults are today's constants, every key has its editor, the money-control ones need the owner
 *   · a changed key changes what the module does: RFM bounds, VIP / risk thresholds, the privacy target, the discount
 *     limits, the points programme, the referral default and the gift-card second-person limit
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, orders, privacyRequests, referralCodes, settings } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { customerFlags } from "~/server/services/admin/customers/flags.server";
import { createPrivacyRequest } from "~/server/services/admin/customers/privacy.server";
import { segmentOverview } from "~/server/services/admin/customers/rfm.server";
import { customerRules } from "~/server/services/admin/customers/rules.server";
import { FLAG_RULES, PRIVACY_DUE_DAYS, RFM_RULES, rfmOf } from "~/server/services/admin/customers/types";
import { couponReasons, saveCoupon } from "~/server/services/admin/promotions/coupons.server";
import { issueGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { adjustPoints } from "~/server/services/admin/promotions/loyalty.server";
import { programRules } from "~/server/services/admin/promotions/program.server";
import { issueReferralCode } from "~/server/services/admin/promotions/referrals.server";
import { DISCOUNT_LIMITS, GIFT_CARD, LOYALTY, REFERRAL } from "~/server/services/admin/promotions/types";
import { SETTING_EDITORS } from "~/server/services/admin/settings/catalog";
import { SETTINGS, getSetting, setSetting, settingDefault, type SettingKey } from "~/server/settings.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
let t: TestDb;
let make: Fixtures;
const people: Partial<Record<DefaultRoleKey, EmployeeActor>> = {};
const KEYS = ["customers.rfm_rules", "customers.flag_rules", "customers.privacy_due_days", "promotions.discount_limits", "promotions.loyalty", "promotions.referral", "promotions.gift_card"] as const;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager"] as const) {
    const id = await make.employee({ name: role });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    people[role] = { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role };
  }
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});
const as = (key: DefaultRoleKey): EmployeeActor => {
  const actor = people[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const key = () => randomToken(12).replace(/[^A-Za-z0-9_-]/g, "x");
async function change<K extends SettingKey>(name: K, patch: Record<string, unknown> | number) {
  const current = await getSetting(t.db, name);
  const value = typeof patch === "number" ? patch : { ...(current as Record<string, unknown>), ...patch };
  await setSetting(t.db, as("owner"), name, value, "اختبار المتابعة", NOW, { expected: current });
}
async function reset(name: SettingKey) {
  await t.db.delete(settings).where(eq(settings.key, name));
}

describe("the customers and promotions rules are settings", () => {
  test("defaults are today's constants; each key has its editor; the controls wait for the owner", async () => {
    for (const name of KEYS) {
      expect(SETTINGS[name], name).toBeDefined();
      expect(SETTING_EDITORS[name], name).toBeDefined();
    }
    const rules = await customerRules(t.db);
    expect(rules).toEqual({ rfm: { recencyDays: [...RFM_RULES.recencyDays], frequency: [...RFM_RULES.frequency], monetaryIqd: [...RFM_RULES.monetaryIqd] }, flags: { ...FLAG_RULES }, privacyDueDays: PRIVACY_DUE_DAYS });
    expect(await programRules(t.db)).toEqual({ limits: { ...DISCOUNT_LIMITS }, loyalty: { ...LOYALTY }, referral: { ...REFERRAL }, giftCard: { ...GIFT_CARD } });
    expect(settingDefault("promotions.discount_limits")).toEqual({ percent_bps: DISCOUNT_LIMITS.percentBps, per_order_iqd: DISCOUNT_LIMITS.perOrderIqd });
    // money-control limits: a manager (settings.manage, not settings.change.approve) only requests a change
    const code = await setSetting(t.db, as("manager"), "promotions.discount_limits", { percent_bps: 3_000, per_order_iqd: 50_000 }, "رفع الحد", NOW).catch((error: unknown) => toAppError(error)?.code);
    expect(code).toBe("setting_needs_approval");
    const flagCode = await setSetting(t.db, as("manager"), "customers.flag_rules", { ...settingDefault("customers.flag_rules"), risk_cancelled: 9 }, "رفع حد الخطر", NOW).catch((error: unknown) => toAppError(error)?.code);
    expect(flagCode).toBe("setting_needs_approval");
    // the score bounds and the privacy target are no money control
    await setSetting(t.db, as("manager"), "customers.privacy_due_days", 20, "هدف أقصر", NOW);
    expect((await customerRules(t.db)).privacyDueDays).toBe(20);
    await reset("customers.privacy_due_days");
    // the schemas refuse bounds out of order
    const order = await setSetting(t.db, as("owner"), "customers.rfm_rules", { ...settingDefault("customers.rfm_rules"), recency_4_days: 20 }, "حدود خاطئة", NOW).catch((error: unknown) => toAppError(error)?.fields);
    expect(order).toMatchObject({ "value.recency_4_days": "not_ascending" });
  });

  test("customers: a changed RFM bound, VIP threshold and privacy target change the segments, the labels and the due date", async () => {
    const customerId = await make.customer();
    const product = await make.product({ priceIqd: 150_000 });
    const order = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1, unitPriceIqd: 150_000 }], { customerId, status: "delivered", paymentStatus: "paid", placedAt: NOW - 40 * DAY });
    await t.db.update(orders).set({ paidIqd: order.totalIqd }).where(eq(orders.id, order.orderId));
    const facts = { purchases: 1, monetaryIqd: order.totalIqd, lastPurchaseAt: NOW - 40 * DAY };
    // 40 days ago: score 4 by today's bounds (≤ 90); with "score 5 within 60 days" it is a 5
    expect(rfmOf(facts, NOW).r).toBe(4);
    await change("customers.rfm_rules", { recency_5_days: 60, recency_4_days: 120 });
    const { rfm } = await customerRules(t.db);
    expect(rfmOf(facts, NOW, rfm).r).toBe(5);
    expect((await segmentOverview(t.db, as("owner"), NOW)).rules.recencyDays[0]).toBe(60);
    await reset("customers.rfm_rules");

    expect((await customerFlags(t.db, [customerId], NOW)).get(customerId)?.map((flag) => flag.id)).not.toContain("vip_spend");
    await change("customers.flag_rules", { vip_spend_iqd: 100_000 });
    expect((await customerFlags(t.db, [customerId], NOW)).get(customerId)?.map((flag) => flag.id)).toContain("vip_spend");
    await reset("customers.flag_rules");

    await change("customers.privacy_due_days", 10);
    const opened = await createPrivacyRequest(t.db, as("owner"), { customerId, kind: "export", details: "نسخة من بياناتي", idempotencyKey: key() }, NOW);
    const row = await t.db.select({ dueAt: privacyRequests.dueAt }).from(privacyRequests).where(eq(privacyRequests.ref, opened.ref)).get();
    expect(row?.dueAt).toBe(NOW + 10 * DAY);
    await reset("customers.privacy_due_days");
  });

  test("promotions: a changed discount limit, points threshold, referral default and gift-card limit change the decisions", async () => {
    // 15 % is within today's 20 %: switched on at once; with a 10 % limit it waits for a second person
    const terms = { kind: "percent", value: 1_500, maxDiscountIqd: 20_000, usageLimit: 100, perCustomerLimit: 1 } as Parameters<typeof couponReasons>[0];
    expect(couponReasons(terms)).toEqual([]);
    await change("promotions.discount_limits", { percent_bps: 1_000 });
    const saved = await saveCoupon(t.db, as("manager"), { code: `FU${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`, kind: "percent", value: "15", maxDiscountIqd: "20000", usageLimit: "100", perCustomerLimit: "1", activate: "on", description: "متابعة" }, NOW);
    expect(saved.status).toBe("requested");
    expect(saved.reasons).toContain("percent_over");
    await reset("promotions.discount_limits");

    const customerId = await make.customer();
    const giver: EmployeeActor = { kind: "employee", id: as("manager").id, permissions: new Set(["promotions.loyalty.adjust", "promotions.promotion.read"]) };
    expect(await adjustPoints(t.db, giver, { customerId, points: "300", reason: "تعويض", idempotencyKey: key() }, NOW)).toMatchObject({ status: "applied" });
    await change("promotions.loyalty", { adjust_second_person_points: 200 });
    expect(await adjustPoints(t.db, giver, { customerId, points: "300", reason: "تعويض ثانٍ", idempotencyKey: key() }, NOW)).toMatchObject({ status: "requested" });
    await reset("promotions.loyalty");

    await change("promotions.referral", { default_max_uses: 3 });
    const referrer = await make.customer();
    const code = await issueReferralCode(t.db, as("owner"), { customerId: referrer }, NOW);
    expect((await t.db.select({ maxUses: referralCodes.maxUses }).from(referralCodes).where(eq(referralCodes.id, code.codeId)).get())?.maxUses).toBe(3);
    await reset("promotions.referral");

    await change("promotions.gift_card", { solo_iqd: 10_000 });
    const issued = await issueGiftCard(t.db, as("manager"), TEST_VARS.DATA_KEY, { amountIqd: "20000", note: "تعويض عن تأخير", idempotencyKey: key() }, NOW);
    expect(issued.status).toBe("requested");
    const tooSmall = await issueGiftCard(t.db, as("manager"), TEST_VARS.DATA_KEY, { amountIqd: "2000", note: "بطاقة صغيرة", idempotencyKey: key() }, NOW).catch((error: unknown) => toAppError(error)?.fields);
    expect(tooSmall).toMatchObject({ amountIqd: "too_small" });
    await reset("promotions.gift_card");
  });
});
