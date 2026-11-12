/**
 * Adversarial review of the module follow-up (2026-11-12) — the settings keys the follow-up introduced, where the
 * modules still read the constants or the pages cannot show what is wrong. Each test failed on the follow-up's code:
 *
 *   · promotions 08.06 (VIP): who is eligible for a membership — the page's list, its count and the module's front
 *     page — was still decided by the constant FLAG_RULES (flagCondition without the rules in force), while module
 *     07 and the flags beside each name follow the setting customers.flag_rules; the page's rule text was a fixed
 *     "2,000,000 IQD or 5 purchases within 365 days", and its flag lines a fixed «{days} يوماً» (wrong for 3–10 days)
 *   · promotions 08.04 / 08.05: points given after a second person's approval and referral rewards expired after
 *     the constant LOYALTY.expiryDays (365) — earned points and direct adjustments follow promotions.loyalty; the
 *     points page's return window read «({days} أيام)» (wrong from 11 days: returns.window_days is a setting)
 *   · customers 07.02: the score bounds the pages state are a setting now, but read «خلال {bounds} يوماً» and
 *     «{bounds} مشتريات» — wrong as soon as the last bound is 3–10 days or 11+ purchases
 *   · settings 22: the new keys' cross-field rules (score bounds in order, a gift card's maximum not below its
 *     minimum, amounts in steps of 1,000) were checked on the server only: the change dialog said "check the
 *     highlighted fields" with nothing highlighted. The form now marks the field before anything is sent
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { translate, type MessageTree } from "~/i18n/translate";
import customersMessages from "~/i18n/messages/admin-customers";
import promotionsMessages from "~/i18n/messages/admin-promotions";
import { randomToken } from "~/lib/ids";
import { draftOf, valueOf } from "~/routes/admin/settings/components/values";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, loyaltyLedger, orders, settings } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { customerFlags } from "~/server/services/admin/customers/flags.server";
import { adjustPoints, customerPoints, decideAdjustment } from "~/server/services/admin/promotions/loyalty.server";
import { promotionsOverview } from "~/server/services/admin/promotions/overview.server";
import { issueReferralCode, recordReferral, rewardReferral } from "~/server/services/admin/promotions/referrals.server";
import { vipPage } from "~/server/services/admin/promotions/vip.server";
import { SETTING_EDITORS } from "~/server/services/admin/settings/catalog";
import { getSetting, setSetting, settingDefault, type SettingKey } from "~/server/settings.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<"owner" | "manager" | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const [name, role] of [["owner", "owner"], ["manager", "manager"], ["manager2", "manager"]] as const) {
    const id = await make.employee({ name: `${name} ${make.next("emp")}` });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role as DefaultRoleKey) });
    staff[name] = { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role as DefaultRoleKey), label: name };
  }
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

const as = (name: keyof typeof staff): EmployeeActor => {
  const actor = staff[name];
  if (!actor) throw new Error(`no ${name}`);
  return actor;
};
const key = () => randomToken(12).replace(/[^A-Za-z0-9_-]/g, "x");
/** The owner (settings.change.approve) changes a key directly: what the store's owner would do on /admin/settings/keys. */
async function change(name: SettingKey, patch: Record<string, unknown>) {
  const current = await getSetting(t.db, name);
  await setSetting(t.db, as("owner"), name, { ...(current as Record<string, unknown>), ...patch } as never, "مراجعة المتابعة", NOW, { expected: current });
}
const reset = (name: SettingKey) => t.db.delete(settings).where(eq(settings.key, name));

describe("promotions 08.06 — VIP eligibility follows the rules in force (customers.flag_rules)", () => {
  test("the page's list and count, the module's front page and the rule text use the setting, as module 07 does", async () => {
    const customerId = await make.customer();
    const product = await make.product({ priceIqd: 600_000 });
    await make.order([{ ...product, qty: 1, unitPriceIqd: 600_000 }], { customerId, status: "delivered", paymentStatus: "paid", paidIqd: 605_000, deliveredAt: NOW - 20 * DAY, placedAt: NOW - 21 * DAY, isDemo: false });
    // below today's bar (2,000,000 IQD or 5 purchases within 365 days): nobody's VIP yet
    expect((await vipPage(t.db, as("manager"), NOW, "ar")).eligible.some((row) => row.customerId === customerId)).toBe(false);

    // the owner lowers the spend bar to 500,000 IQD within 90 days
    await change("customers.flag_rules", { vip_spend_iqd: 500_000, vip_window_days: 90 });
    try {
      // module 07 (the labels) already follows the setting …
      expect((await customerFlags(t.db, [customerId], NOW)).get(customerId)?.map((flag) => flag.id)).toContain("vip_spend");
      // … and so must the memberships page that turns those customers into members
      const page = await vipPage(t.db, as("manager"), NOW, "ar");
      expect(page.eligible.some((row) => row.customerId === customerId && row.flags.some((flag) => flag.id === "vip_spend"))).toBe(true);
      expect((await promotionsOverview(t.db, as("manager"), NOW)).vip?.eligible).toBe(page.eligibleTotal);
      // the rule the page states is the one in force
      expect(page.rule).toEqual({ spendIqd: 500_000, purchases: 5, windowDays: 90 });
    } finally {
      await reset("customers.flag_rules");
    }
  });

  test("the flag lines and the rule text agree with the number of days (a setting: any 1–3650)", () => {
    const ar = promotionsMessages.ar as unknown as MessageTree;
    const span = (count: number) => translate(ar, "ar", "daySpan", { count }) ?? "";
    for (const days of [7, 10]) {
      const line = translate(ar, "ar", "vip.flag.vip_spend", { amount: "500,000 د.ع", days, span: span(days) }) ?? "";
      expect(line).toContain(`${days} أيام`);
      expect(line).not.toContain("يوماً");
      const rule = translate(ar, "ar", "vip.rule.text", { amount: "500,000 د.ع", purchases: 5, days, span: span(days) }) ?? "";
      expect(rule).toContain(`${days} أيام`);
      expect(rule).not.toContain("2,000,000");
    }
    // the points programme's return window is a setting too (returns.window_days): 14 days is «14 يوماً», never «14 أيام»
    for (const key of ["points.program.whenValue", "points.due.orders"]) {
      const text = translate(ar, "ar", key, { count: 3, days: 14, span: span(14) }) ?? "";
      expect(text, key).toContain("14 يوماً");
      expect(text, key).not.toContain("14 أيام");
    }
  });
});

describe("customers 07.02 — the score bounds the page states are a setting: no noun tied to a fixed number", () => {
  test("«خلال 3 / 5 / 7 / 10 يوماً» and «20 مشتريات» never appear, whatever the bounds", () => {
    const ar = customersMessages.ar as unknown as MessageTree;
    const recency = translate(ar, "ar", "rfm.rule.r", { bounds: "3 / 5 / 7 / 10" }) ?? "";
    expect(recency).toContain("3 / 5 / 7 / 10");
    expect(recency).not.toContain("10 يوماً");
    const frequency = translate(ar, "ar", "rfm.rule.f", { bounds: "2 / 3 / 5 / 20" }) ?? "";
    expect(frequency).toContain("2 / 3 / 5 / 20");
    expect(frequency).not.toContain("20 مشتريات");
  });
});

describe("promotions 08.04 / 08.05 — every point posted expires after the programme's days in force", () => {
  test("points given after a second person's approval, and a referral's reward, follow promotions.loyalty.expiry_days", async () => {
    await change("promotions.loyalty", { expiry_days: 30 });
    try {
      // a manual adjustment above the second-person limit: requested, approved by another manager
      const customerId = await make.customer();
      expect(await adjustPoints(t.db, as("manager"), { customerId, points: "6000", reason: "مسابقة الشهر", idempotencyKey: key() }, NOW)).toMatchObject({ status: "requested" });
      const pending = (await customerPoints(t.db, as("manager2"), customerId, NOW)).pending[0];
      await decideAdjustment(t.db, as("manager2"), { approvalId: pending.approvalId, decision: "approve", note: "موافق" }, NOW);
      const approved = await t.db.select({ expiresAt: loyaltyLedger.expiresAt }).from(loyaltyLedger).where(and(eq(loyaltyLedger.customerId, customerId), eq(loyaltyLedger.refType, "approval"))).get();
      expect(approved?.expiresAt).toBe(NOW + 30 * DAY);

      // a referral rewarded once the friend's order is delivered and past the return window
      const referrerId = await make.customer();
      const code = await issueReferralCode(t.db, as("manager"), { customerId: referrerId }, NOW);
      const friendPhone = make.phone();
      const friendId = await make.customer({ phoneE164: friendPhone });
      const product = await make.product({ priceIqd: 100_000 });
      const order = await make.order([{ ...product, qty: 1, unitPriceIqd: 100_000 }], { customerId: friendId, contactPhoneE164: friendPhone, status: "confirmed", placedAt: NOW, isDemo: false });
      const recorded = await recordReferral(t.db, as("manager"), { code: code.code, phone: friendPhone, orderRef: order.ref, note: "أخبرنا في المتجر", idempotencyKey: key() }, NOW);
      await t.db.update(orders).set({ status: "delivered", deliveredAt: NOW - 10 * DAY }).where(eq(orders.id, order.orderId));
      await rewardReferral(t.db, as("manager2"), { referralId: recorded.referralId, note: "تحقق" }, NOW);
      const reward = await t.db.select({ expiresAt: loyaltyLedger.expiresAt }).from(loyaltyLedger).where(and(eq(loyaltyLedger.refType, "referral"), eq(loyaltyLedger.refId, recorded.referralId))).get();
      expect(reward?.expiresAt).toBe(NOW + 30 * DAY);
    } finally {
      await reset("promotions.loyalty");
    }
  });
});

describe("settings 22 — the new keys' cross-field rules are marked on the field before anything is sent", () => {
  const draftFor = (name: "customers.rfm_rules" | "promotions.gift_card", patch: Record<string, string>) => {
    const editor = SETTING_EDITORS[name];
    return { editor, draft: { ...draftOf(editor, settingDefault(name)), ...patch } };
  };

  test("score bounds out of order are refused on the bound that breaks the order", () => {
    const { editor, draft } = draftFor("customers.rfm_rules", { recency_4_days: "20" });
    expect(valueOf(editor, draft).errors).toMatchObject({ recency_4_days: "not_ascending" });
    const frequency = draftFor("customers.rfm_rules", { frequency_4: "3" });
    expect(valueOf(frequency.editor, frequency.draft).errors).toMatchObject({ frequency_4: "not_ascending" });
    // in order: nothing to mark
    const fine = draftFor("customers.rfm_rules", { recency_5_days: "14" });
    expect(valueOf(fine.editor, fine.draft).errors).toEqual({});
  });

  test("a gift card's maximum below its minimum, and amounts off the 1,000 step, are refused on their fields", () => {
    const below = draftFor("promotions.gift_card", { max_iqd: "4000" });
    expect(valueOf(below.editor, below.draft).errors).toMatchObject({ max_iqd: "below_paired" });
    const step = draftFor("promotions.gift_card", { min_iqd: "5500" });
    expect(valueOf(step.editor, step.draft).errors).toMatchObject({ min_iqd: "step_1000" });
    // Arabic-Indic digits are read like the others
    const arabic = draftFor("promotions.gift_card", { min_iqd: "١٠٠٠٠" });
    expect(valueOf(arabic.editor, arabic.draft)).toMatchObject({ errors: {}, value: { min_iqd: 10_000 } });
  });
});
