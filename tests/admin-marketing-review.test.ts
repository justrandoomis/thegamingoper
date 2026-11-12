/**
 * Admin module 16 "marketing" — the adversarial review (2026-11-12). Every test here failed on the builder's code
 * (run against a saved copy of it); each one names the defect it guards:
 *
 *   · two-person / one-rule invariants: a cross-sell rule switched back on beside an identical active rule, and two
 *     identical rules created at once, left TWO active rules for one product, device and shelf; a pin was switched back
 *     on although its device could no longer be verified (unpublished device: the check was skipped)
 *   · input: a weight typed in Persian digits was refused ("۵۰"), a hexadecimal one accepted ("0x10" → 16)
 *   · races before the write batch: two campaigns created at once took the same utm_campaign (attribution goes to
 *     one of them arbitrarily); a spend entry recorded while a release was finishing ERASED the release record, so
 *     the campaign could be released a second time
 *   · idempotency: the same spend entry posted twice at once answered "the campaign changed" instead of the first
 *     result; a release clicked twice answered "not due yet" instead of the first result
 *   · honesty: the release lost the campaign's own link once the campaign had more than 50 links (the held message
 *     said nothing where {link} was); people refused INSIDE the write (a "no" between the count and the write) were
 *     counted nowhere; the front page counted a DEMO cart reminder and links of DEMO campaigns as real figures; its
 *     "due" figure opened a list of something else; the explorer's buyers by platform ignored the chosen segment;
 *     the performance report's monthly "attributed" orders counted orders that match no campaign (docs/metrics.md §8)
 *     while its totals and campaign rows did not
 *   · safe variables: {name} carried whatever a stranger typed as a guest-checkout name — a web address, a number —
 *     into the store's marketing text
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { L10n } from "~/lib/locales";
import type { EmployeeActor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { cartItems, cartReminders, carts, compatibilityRules, consents, customerSegmentMembers, customerSegments, deviceModels, guestContacts, platforms, products, stockLevels, variants } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, type DefaultRoleKey } from "~/server/permissions";
import { exploreAudience } from "~/server/services/admin/marketing/audience.server";
import { decideCampaign, getCampaign, listCampaigns, recordSpend, releaseCampaign, saveCampaign, submitCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { prepareCartReminders } from "~/server/services/admin/marketing/carts.server";
import { listCrossSellRules, saveCrossSellRule, setCrossSellRuleActive } from "~/server/services/admin/marketing/crosssell.server";
import { createLink } from "~/server/services/admin/marketing/links.server";
import { marketingOverview } from "~/server/services/admin/marketing/overview.server";
import { performanceReport } from "~/server/services/admin/marketing/performance.server";
import { baghdadMonth, parseAudienceQuery, parseCampaignFilters, type CampaignView } from "~/server/services/admin/marketing/types";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ORIGIN = "https://tamtamgames.com";
let t: TestDb;
let make: Fixtures;

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const t3 = (ar: string, en: string, ckb: string): L10n => ({ ar, en, ckb });
const actor = (id: string, permissions: Iterable<string>): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions), label: id });
const role = (id: string, key: DefaultRoleKey) => actor(id, defaultRolePermissions(key));
const m1 = role("emp_rv_m1", "manager");
const m2 = role("emp_rv_m2", "manager");
const owner = actor("emp_rv_owner", ["*"]);

/** The error code (and fields) a call fails with; null when it succeeds. */
async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number; fields: Record<string, string> } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return { code: appError.code, status: appError.status, fields: appError.fields ?? {} };
  }
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

// ───────────────────────────────────────────────────────────────── the test world

const DEV = "dvm_rv_box";
const DEV2 = "dvm_rv_box2";
const PAD = "prd_rv_pad";
const CASE = "prd_rv_case";

/** A platform of its own for one test (its buyers are that test's audience), with one product on it. */
async function shelf(key: string) {
  const platformId = `plt_rv_${key}`;
  const productId = `prd_rv_g_${key}`;
  const variantId = `var_rv_g_${key}`;
  const sku = `SKU-RV-${key}`;
  await runBatch(t.db, [
    t.db.insert(platforms).values({ id: platformId, slug: `zz-rv-${key}`, name: t3(`منصة ${key}`, `Platform ${key}`, `پلاتفۆرم ${key}`), accent: "nintendo", sort: 90, isActive: true }),
    t.db.insert(products).values({ id: productId, slug: `rv-game-${key}`, kind: "game", name: t3(`لعبة ${key}`, `Game ${key}`, `یاری ${key}`), status: "published", platformId, createdAt: NOW, updatedAt: NOW }),
    t.db.insert(variants).values({ id: variantId, productId, sku, priceIqd: 50_000, isDefault: true }),
    t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 20 }),
  ]);
  return { platformId, productId, variantId, sku };
}
type Shelf = Awaited<ReturnType<typeof shelf>>;

async function account(options: { name?: string; consent?: boolean; isDemo?: boolean } = {}) {
  const phone = make.phone();
  const id = await make.customer({ id: newId("cus"), phoneE164: phone, name: options.name ?? "زبون المراجعة", isDemo: options.isDemo ?? false });
  if (options.consent !== false) await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: id, kind: "marketing", granted: true, source: "account", at: NOW - 10 * DAY });
  return { id, phone };
}
async function guest(name: string) {
  const phone = make.phone();
  const id = newId("gst");
  await t.db.insert(guestContacts).values({ id, phoneE164: phone, name, createdAt: NOW - 8 * DAY });
  await t.db.insert(consents).values({ id: newId("cns"), subjectType: "guest_contact", subjectId: id, kind: "marketing", granted: true, source: "checkout", at: NOW - 8 * DAY });
  return { id, phone };
}
async function buy(item: Shelf, who: { customerId?: string; guestContactId?: string; phone: string }, options: { paid?: number; placedAt?: number; attribution?: Record<string, string> } = {}) {
  const order = await make.order([{ variantId: item.variantId, sku: item.sku, unitPriceIqd: 50_000 }], {
    customerId: who.customerId ?? null,
    guestContactId: who.guestContactId ?? null,
    contactPhoneE164: who.phone,
    placedAt: options.placedAt ?? NOW - 5 * DAY,
    status: "delivered",
    paidIqd: options.paid ?? 0,
    ...(options.attribution ? { attribution: options.attribution } : {}),
  });
  return order;
}
const key = (label: string) => `rv-${label}-${newId("k").slice(-10)}`.replace(/[^A-Za-z0-9_-]/g, "x");

/** A message campaign written by m1, asked for by m1 and approved by the owner (a second person). */
async function approved(name: string, item: Shelf, extra: Record<string, unknown> = {}) {
  const created = await saveCampaign(t.db, m1, { idempotencyKey: key("campaign"), name, channel: "sms", platformIds: [item.platformId], guests: true, bodyAr: "مرحباً {name}، عرض جديد في {store}.", ...extra }, NOW);
  return approve(created.campaignId);
}
async function approve(campaignId: string) {
  const page = await getCampaign(t.db, m1, campaignId, "ar", NOW, ORIGIN);
  const request = await submitCampaign(t.db, m1, { campaignId, expectedUpdatedAt: page.campaign.updatedAt, note: "" }, NOW);
  const shown = await getCampaign(t.db, owner, campaignId, "ar", NOW, ORIGIN);
  await decideCampaign(t.db, owner, { campaignId, approvalId: request.approvalId, decision: "approve", fingerprint: shown.campaign.fingerprint, note: "" }, NOW);
  return campaignId;
}
const heldTexts = async (campaignId: string) =>
  (await rows<{ recipient: string; payload: string }>("SELECT recipient, payload FROM outbox WHERE ref_type = 'campaign' AND ref_id = ?", campaignId)).map((row) => ({ recipient: row.recipient, text: String((JSON.parse(row.payload) as { text?: string }).text ?? "") }));

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  const statements: BatchStatement[] = [
    t.db.insert(platforms).values({ id: "plt_rv_dev", slug: "zz-rv-dev", name: t3("منصة الأجهزة", "Device platform", "پلاتفۆرمی ئامێر"), accent: "xbox", sort: 91, isActive: true }),
    t.db.insert(deviceModels).values({ id: DEV, platformId: "plt_rv_dev", slug: "zz-rv-box", name: t3("Rvbox", "Rvbox", "Rvbox"), status: "published", deviceKind: "console", sort: 1 }),
    t.db.insert(deviceModels).values({ id: DEV2, platformId: "plt_rv_dev", slug: "zz-rv-box2", name: t3("Rvbox 2", "Rvbox 2", "Rvbox 2"), status: "published", deviceKind: "console", sort: 2 }),
  ];
  for (const [id, kind] of [
    [PAD, "controller"],
    [CASE, "accessory"],
  ] as const) {
    statements.push(
      t.db.insert(products).values({ id, slug: id.replace(/_/g, "-"), kind, name: t3(`ملحق ${id}`, `Add-on ${id}`, `پاشکۆ ${id}`), status: "published", platformId: "plt_rv_dev", createdAt: NOW, updatedAt: NOW }),
      t.db.insert(variants).values({ id: id.replace(/^prd_/, "var_"), productId: id, sku: `SKU-${id}`, priceIqd: 40_000, isDefault: true }),
      t.db.insert(stockLevels).values({ variantId: id.replace(/^prd_/, "var_"), locationId: DEFAULT_LOCATION_ID, onHand: 10 }),
    );
  }
  for (const [id, productId, target] of [
    ["cr_rv_1", PAD, DEV],
    ["cr_rv_2", CASE, DEV],
    ["cr_rv_3", PAD, DEV2],
  ] as const) {
    statements.push(t.db.insert(compatibilityRules).values({ id, subjectType: "product", subjectId: productId, targetType: "device_model", targetId: target, status: "verified" }));
  }
  await runBatch(t.db, statements);
});
afterAll(async () => {
  await t?.dispose();
});

const activeRules = async (productId: string, device = DEV) =>
  (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM recommendation_rules WHERE is_active = 1 AND product_id = ? AND json_extract(context, '$.deviceModelId') = ?", productId, device))[0].n;

// ───────────────────────────────────────────────────────────────── cross-sell (16.05)

describe("cross-sell: one active rule per kind, product, device and shelf; verified only", () => {
  test("a rule switched back on beside an identical active rule is refused", async () => {
    const base = { kind: "pin", deviceModelId: DEV, productId: PAD, placement: "", reason: "يد إضافية مع الجهاز", weight: "0" };
    const first = await saveCrossSellRule(t.db, m1, base, NOW);
    await setCrossSellRuleActive(t.db, m1, { ruleId: first.ruleId, active: "0", reason: "إيقاف مؤقت" }, NOW);
    await saveCrossSellRule(t.db, m1, base, NOW); // allowed: the first one is off
    const again = await failure(() => setCrossSellRuleActive(t.db, m1, { ruleId: first.ruleId, active: "1", reason: "إعادة التشغيل" }, NOW));
    expect(again?.code).toBe("rule_changed");
    expect(again?.status).toBe(409);
    expect(await activeRules(PAD)).toBe(1);
  });

  test("two identical rules created at once: the second is refused inside the write", async () => {
    const base = { kind: "boost", deviceModelId: DEV, productId: CASE, placement: "device_hub:setup", reason: "حقيبة مع الجهاز", weight: "10" };
    // batch 1 is the compatibility read (compatibilityForModels reads through db.batch); batch 2 is the write
    const racing = beforeBatch(t.db, 2, () => saveCrossSellRule(t.db, m2, base, NOW));
    const second = await failure(() => saveCrossSellRule(racing, m1, base, NOW));
    expect(second?.code).toBe("rule_changed");
    expect(second?.fields.productId).toBe("rule_exists");
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM recommendation_rules WHERE is_active = 1 AND kind = 'boost' AND product_id = ?", CASE))[0].n).toBe(1);
  });

  test("a weight typed in Persian digits is read; a hexadecimal one is not a whole number", async () => {
    const base = { kind: "boost", deviceModelId: DEV, productId: PAD, placement: "product:related", reason: "يد مع الجهاز" };
    const saved = await saveCrossSellRule(t.db, m1, { ...base, weight: "۵۰" }, NOW);
    expect((await rows<{ weight: number }>("SELECT weight FROM recommendation_rules WHERE id = ?", saved.ruleId))[0].weight).toBe(50);
    const hex = await failure(() => saveCrossSellRule(t.db, m1, { ...base, placement: "cart:setup", weight: "0x10" }, NOW));
    expect(hex?.fields.weight).toBe("number_invalid");
  });

  test("a pin is not switched back on when its device can no longer be verified", async () => {
    const pin = await saveCrossSellRule(t.db, m1, { kind: "pin", deviceModelId: DEV2, productId: PAD, placement: "", reason: "يد مع الجهاز الثاني", weight: "0" }, NOW);
    await setCrossSellRuleActive(t.db, m1, { ruleId: pin.ruleId, active: "0", reason: "إيقاف" }, NOW);
    await t.d1.prepare("UPDATE device_models SET status = 'draft' WHERE id = ?").bind(DEV2).run();
    const on = await failure(() => setCrossSellRuleActive(t.db, m1, { ruleId: pin.ruleId, active: "1", reason: "إعادة" }, NOW));
    expect(on?.code).toBe("rule_not_verified");
    expect(await activeRules(PAD, DEV2)).toBe(0);
    const list = await listCrossSellRules(t.db, m1, { device: DEV2, kind: null, active: "all", page: 1 }, "ar", NOW);
    expect(list.rows.find((row) => row.id === pin.ruleId)?.isActive).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── campaigns: races and double clicks

describe("campaigns: races before the write, double clicks, the release record", () => {
  test("two campaigns created at once with the same utm_campaign: the second is refused inside the write", async () => {
    const racing = beforeBatch(t.db, 1, () => saveCampaign(t.db, m2, { idempotencyKey: key("utm-other"), name: "حملة منافسة", channel: "ads", utmCampaign: "rv-same-launch" }, NOW));
    const second = await failure(() => saveCampaign(racing, m1, { idempotencyKey: key("utm-first"), name: "حملة الإطلاق", channel: "ads", utmCampaign: "rv-same-launch" }, NOW));
    expect(second?.status).toBe(400);
    expect(second?.fields.utmCampaign).toBe("utm_taken");
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM campaigns WHERE utm_campaign = 'rv-same-launch'"))[0].n).toBe(1);
  });

  test("the same spend entry posted twice at once is recorded once, and the repeat gets the first result", async () => {
    const ads = await saveCampaign(t.db, m1, { idempotencyKey: key("ads-spend"), name: "إعلانات المراجعة", channel: "ads" }, NOW);
    const page = await getCampaign(t.db, m1, ads.campaignId, "ar", NOW, ORIGIN);
    const entry = { campaignId: ads.campaignId, period: baghdadMonth(NOW), amountIqd: "120000", reference: "INV-1", note: "فاتورة الشهر", idempotencyKey: key("spend"), expectedUpdatedAt: page.campaign.updatedAt };
    const racing = beforeBatch(t.db, 1, () => recordSpend(t.db, m1, entry, NOW));
    const repeat = await recordSpend(racing, m1, entry, NOW);
    expect(repeat.replayed).toBe(true);
    expect(repeat.spendIqd).toBe(120_000);
    const stored = await rows<{ spend_iqd: number; n: number }>("SELECT spend_iqd, json_array_length(content, '$.spend') AS n FROM campaigns WHERE id = ?", ads.campaignId);
    expect(stored[0]).toEqual({ spend_iqd: 120_000, n: 1 });
  });

  test("a release clicked twice: the second answers the first result, never \"not due\"", async () => {
    const item = await shelf("dbl");
    for (let i = 0; i < 2; i++) {
      const person = await account();
      await buy(item, { customerId: person.id, phone: person.phone });
    }
    const campaignId = await approved("حملة النقر المزدوج", item);
    const racing = beforeBatch(t.db, 1, () => releaseCampaign(t.db, owner, { campaignId }, NOW, ORIGIN));
    const second = await releaseCampaign(racing, owner, { campaignId }, NOW, ORIGIN);
    expect(second.replayed).toBe(true);
    expect(second.held).toBe(2);
    expect(await heldTexts(campaignId)).toHaveLength(2);
  });

  test("a spend entry racing the end of a release never erases the release record", async () => {
    const item = await shelf("spendrace");
    const person = await account();
    await buy(item, { customerId: person.id, phone: person.phone });
    const campaignId = await approved("حملة الإنفاق أثناء الإطلاق", item);
    await releaseCampaign(t.db, owner, { campaignId }, NOW, ORIGIN);
    // the release was interrupted after its messages were written (a Worker limit): it resumes later
    await t.d1.prepare("UPDATE campaigns SET content = json_remove(content, '$.release') WHERE id = ?").bind(campaignId).run();
    const page = await getCampaign(t.db, m1, campaignId, "ar", NOW, ORIGIN);
    expect(page.campaign.can.release).toBe(true);
    const entry = { campaignId, period: baghdadMonth(NOW), amountIqd: "5000", reference: "", note: "رسوم الرسائل", idempotencyKey: key("spend-race"), expectedUpdatedAt: page.campaign.updatedAt };
    // the resumed release finishes between the spend form's read and its write
    const racing = beforeBatch(t.db, 1, () => releaseCampaign(t.db, owner, { campaignId }, NOW + 1000, ORIGIN));
    const spend = await failure(() => recordSpend(racing, m1, entry, NOW + 2000));
    expect(spend?.code).toBe("campaign_changed");
    const after = await getCampaign(t.db, m1, campaignId, "ar", NOW + 3000, ORIGIN);
    expect(after.campaign.content.release?.complete).toBe(true);
    expect(after.campaign.can.release).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── the release: links, counts, safe names

describe("the release: the campaign's link, every person counted, safe names", () => {
  test("the held message keeps the campaign's own link even when the campaign has more than 50 links", async () => {
    const item = await shelf("links");
    const person = await account();
    await buy(item, { customerId: person.id, phone: person.phone });
    const created = await saveCampaign(t.db, m1, { idempotencyKey: key("many-links"), name: "حملة كثيرة الروابط", channel: "sms", platformIds: [item.platformId], guests: true, bodyAr: "عرض {store}" }, NOW);
    const chosen = await createLink(t.db, m1, { targetPath: "/", source: "sms", medium: "message", campaignId: created.campaignId, content: "chosen", idempotencyKey: key("link-chosen") }, NOW, ORIGIN);
    let page = await getCampaign(t.db, m1, created.campaignId, "ar", NOW, ORIGIN);
    await saveCampaign(t.db, m1, { campaignId: created.campaignId, expectedUpdatedAt: page.campaign.updatedAt, name: "حملة كثيرة الروابط", channel: "sms", platformIds: [item.platformId], guests: true, bodyAr: "عرض {store}: {link}", linkId: chosen.linkId }, NOW + 1);
    for (let i = 0; i < 51; i++) await createLink(t.db, m1, { targetPath: "/", source: "sms", medium: "message", campaignId: created.campaignId, content: `extra-${i}`, idempotencyKey: key(`link-${i}`) }, NOW + 10 + i, ORIGIN);
    page = await getCampaign(t.db, m1, created.campaignId, "ar", NOW, ORIGIN);
    // the page still offers (and shows) the chosen link
    expect(page.campaign.links.some((link) => link.id === chosen.linkId)).toBe(true);
    expect(page.rendered.ar?.body).toContain(chosen.url);
    await approve(created.campaignId);
    await releaseCampaign(t.db, owner, { campaignId: created.campaignId }, NOW + 100, ORIGIN);
    const [held] = await heldTexts(created.campaignId);
    expect(held.text).toContain(chosen.url);
  });

  test("a person refused inside the write is counted: held + every reason = the people considered", async () => {
    const item = await shelf("refused");
    const stays = await account();
    const leaves = await account();
    for (const person of [stays, leaves]) await buy(item, { customerId: person.id, phone: person.phone });
    const campaignId = await approved("حملة الانسحاب أثناء الكتابة", item);
    // the "no" lands after the audience was counted, just before the messages are written
    const racing = beforeBatch(t.db, 1, () => t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: leaves.id, kind: "marketing", granted: false, source: "account", at: NOW - 1 }));
    const result = await releaseCampaign(racing, owner, { campaignId }, NOW, ORIGIN);
    expect(result.held).toBe(1);
    expect((await heldTexts(campaignId)).map((row) => row.recipient)).toEqual([stays.phone]);
    expect(result.excluded.changed).toBe(1);
    const page = await getCampaign(t.db, m1, campaignId, "ar", NOW, ORIGIN);
    const stats = page.campaign.content.release;
    expect(stats?.excluded.changed).toBe(1);
    const excluded = Object.values(stats?.excluded ?? {}).reduce((sum, n) => sum + n, 0);
    expect((stats?.held ?? 0) + excluded).toBe(stats?.candidates);
  });

  test("{name} is a first name only: a web address or a number typed at a guest checkout never reaches the text", async () => {
    const item = await shelf("names");
    const linkName = await guest("tamtam-gift.com/claim هدية");
    const numberName = await guest("07701234567");
    const real = await guest("زينب علي");
    for (const person of [linkName, numberName, real]) await buy(item, { guestContactId: person.id, phone: person.phone });
    const campaignId = await approved("حملة الأسماء", item);
    await releaseCampaign(t.db, owner, { campaignId }, NOW, ORIGIN);
    const texts = await heldTexts(campaignId);
    const of = (phone: string) => texts.find((row) => row.recipient === phone)?.text ?? "";
    expect(of(linkName.phone)).not.toContain("tamtam-gift");
    expect(of(linkName.phone)).toContain("صديقنا");
    expect(of(numberName.phone)).not.toContain("07701234567");
    expect(of(real.phone)).toContain("زينب");

    // the same for a cart reminder
    const shopper = await account({ name: "www.tamtam-refund.iq" });
    const cartId = newId("crt");
    await t.db.insert(carts).values({ id: cartId, tokenHash: newId("tok"), customerId: shopper.id, createdAt: NOW - 4 * HOUR, updatedAt: NOW - 3 * HOUR });
    await t.db.insert(cartItems).values({ id: newId("cit"), cartId, variantId: item.variantId, qty: 1, addedAt: NOW - 3 * HOUR });
    expect((await prepareCartReminders(t.db, m1, { cartIds: [cartId], idempotencyKey: key("cart-name") }, NOW, ORIGIN)).prepared).toBe(1);
    const [reminder] = await rows<{ payload: string }>("SELECT o.payload FROM cart_reminders r JOIN outbox o ON o.id = r.outbox_id WHERE r.cart_id = ?", cartId);
    const payload = JSON.parse(reminder.payload) as { name: string; text: string };
    expect(payload.name).toBe("صديقنا");
    expect(payload.text).not.toContain("tamtam-refund");
  });
});

// ───────────────────────────────────────────────────────────────── figures that must equal their lists

describe("figures: real records only, equal to the list they open, reconciled", () => {
  test("the front page counts neither a demo customer's cart reminder nor the links of a demo campaign", async () => {
    const before = await marketingOverview(t.db, owner, NOW);
    const demo = await account({ isDemo: true });
    const cartId = newId("crt");
    await t.db.insert(carts).values({ id: cartId, tokenHash: newId("tok"), customerId: demo.id, createdAt: NOW - 5 * HOUR, updatedAt: NOW - 4 * HOUR });
    await t.db.insert(cartReminders).values({ id: newId("crm"), cartId, customerId: demo.id, phoneE164: demo.phone, channel: "sms", step: 1, status: "held", scheduledAt: NOW, createdAt: NOW - HOUR });
    const demoCampaign = await saveCampaign(t.db, m1, { idempotencyKey: key("demo-campaign"), name: "حملة تجريبية", channel: "social" }, NOW, { demo: true });
    await createLink(t.db, m1, { targetPath: "/", source: "instagram", medium: "social", campaignId: demoCampaign.campaignId, idempotencyKey: key("demo-link") }, NOW, ORIGIN);
    const after = await marketingOverview(t.db, owner, NOW);
    expect(after.carts?.remindedThisWeek).toBe(before.carts?.remindedThisWeek);
    expect(after.links?.total).toBe(before.links?.total);
  });

  test("the front page's \"due\" figure equals the list it opens", async () => {
    const item = await shelf("due");
    const person = await account();
    await buy(item, { customerId: person.id, phone: person.phone });
    await approved("حملة مستحقة", item);
    await approved("حملة لاحقة", item, { scheduledAt: "2026-12-20T10:00" });
    const tracking = await saveCampaign(t.db, m1, { idempotencyKey: key("tracking-due"), name: "حملة إعلانات معتمدة", channel: "ads" }, NOW);
    await approve(tracking.campaignId);
    const overview = await marketingOverview(t.db, owner, NOW);
    expect(overview.due).toBeGreaterThanOrEqual(1);
    const filters = parseCampaignFilters(new URLSearchParams("view=due"));
    expect(filters.view).toBe("due");
    const list = await listCampaigns(t.db, owner, filters, NOW);
    expect(list.total).toBe(overview.due);
    expect(list.counts["due" as CampaignView]).toBe(overview.due);
    expect(list.rows.every((row) => row.state === "due")).toBe(true);
  });

  test("the explorer's buyers by platform follow the chosen segment", async () => {
    const item = await shelf("segment");
    const member = await account();
    for (const person of [member, await account(), await account()]) await buy(item, { customerId: person.id, phone: person.phone });
    await t.db.insert(customerSegments).values({ id: "seg_rv_one", key: "rv.one", name: t3("قسم المراجعة", "Review segment", "بەشی پێداچوونەوە"), createdAt: NOW, updatedAt: NOW, memberCount: 1 });
    await t.db.insert(customerSegmentMembers).values({ segmentId: "seg_rv_one", customerId: member.id, addedAt: NOW });
    const all = await exploreAudience(t.db, m1, parseAudienceQuery(new URLSearchParams(`platform=${item.platformId}`)), "ar", NOW);
    expect(all.byPlatform.find((row) => row.platformId === item.platformId)?.buyers).toBe(3);
    const narrowed = await exploreAudience(t.db, m1, parseAudienceQuery(new URLSearchParams(`platform=${item.platformId}&segment=seg_rv_one`)), "ar", NOW);
    expect(narrowed.preview.eligible).toBe(1);
    expect(narrowed.byPlatform.find((row) => row.platformId === item.platformId)?.buyers).toBe(1);
  });

  test("performance: the months, the totals and the campaign rows count the same attributed orders (metrics §8)", async () => {
    const item = await shelf("attrib");
    const ads = await saveCampaign(t.db, m1, { idempotencyKey: key("attrib-ads"), name: "إعلانات منسوبة", channel: "ads", utmCampaign: "rv-attrib" }, NOW);
    const page = await getCampaign(t.db, m1, ads.campaignId, "ar", NOW, ORIGIN);
    await recordSpend(t.db, m1, { campaignId: ads.campaignId, period: baghdadMonth(NOW), amountIqd: "20000", reference: "", note: "إعلان", idempotencyKey: key("attrib-spend"), expectedUpdatedAt: page.campaign.updatedAt }, NOW);
    const a = await account({ consent: false });
    const b = await account({ consent: false });
    await buy(item, { customerId: a.id, phone: a.phone }, { paid: 40_000, placedAt: NOW - DAY, attribution: { source: "instagram", campaign: "rv-attrib" } });
    // carries a source, but no campaign: not an attributed order
    await buy(item, { customerId: b.id, phone: b.phone }, { paid: 25_000, placedAt: NOW - DAY, attribution: { source: "google" } });
    const report = await performanceReport(t.db, owner, { from: baghdadMonth(NOW), to: baghdadMonth(NOW), demo: false }, NOW);
    const month = report.months[0];
    const campaigns = report.campaigns.reduce((sum, row) => ({ orders: sum.orders + row.attributedOrders, paid: sum.paid + row.attributedPaidIqd }), { orders: 0, paid: 0 });
    expect(campaigns).toEqual({ orders: 1, paid: 40_000 });
    expect({ orders: month.attributedOrders, paid: month.attributedPaidIqd }).toEqual(campaigns);
    expect({ orders: report.totals.attributedOrders, paid: report.totals.attributedPaidIqd }).toEqual(campaigns);
    expect(report.campaigns.find((row) => row.id === ads.campaignId)?.roas).toBe(2);
  });
});
