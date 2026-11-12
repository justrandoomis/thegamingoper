/**
 * Admin module 16 "marketing" — the services against a real local D1 with the demo catalogue (createTestDb +
 * seedDemo) and a small test world on its own platform ("zz-mkt") where every answer is written down:
 *
 *   · consent: only an explicit, CURRENT marketing consent counts — the newest answer across an account and every
 *     guest checkout of its number; guest checkouts per number count; merged / deleted / blocked accounts (and a number
 *     tied to one) never; channel switched off; e-mail without an address; demo vs real; the 7-day message limit;
 *   · the same rules inside the write (recipientGuard): a "no" that lands after the count keeps the message out;
 *   · segmentation by platform and purchase date (+ module 07's stored segment);
 *   · campaigns: safe variables, the second person (never the requester nor anyone who wrote it), the fingerprint,
 *     the release HELD in the outbox (never "sent"), idempotent; spend entries (idempotent, corrections, no future);
 *   · abandoned carts: verdicts, held reminders, one per cart, again in the write;
 *   · links: the CMS's path rules; attribution only from orders that carry their source;
 *   · cross-sell: pin / boost only VERIFIED add-ons, exclude, re-check on switching on, the shelf as shoppers see it;
 *   · reviews: approve only a verified purchase that holds up, reject with a code, the storefront counts approved only;
 *   · performance: CAC, ROAS, LTV — "not available" (null) instead of 0, no cost or profit anywhere;
 *   · authorization per role.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { L10n } from "~/lib/locales";
import type { Actor, EmployeeActor } from "~/server/actor";
import { cartItems, carts, compatibilityRules, consents, customerSegmentMembers, customerSegments, customers, deviceModels, guestContacts, outbox, platforms, products, reviews, stockLevels, variants } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch, type BatchStatement } from "~/server/db/tx.server";
import { isAppError } from "~/server/errors";
import { defaultRolePermissions, type DefaultRoleKey } from "~/server/permissions";
import { exploreAudience, recipientGuard, resolveAudience } from "~/server/services/admin/marketing/audience.server";
import { cancelCampaign, countDecidableCampaigns, decideCampaign, getCampaign, listCampaigns, listRecipients, recordSpend, releaseCampaign, saveCampaign, submitCampaign, withdrawCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { listAbandonedCarts, prepareCartReminders, reminderTime } from "~/server/services/admin/marketing/carts.server";
import { deviceAddOns, listCrossSellRules, previewDeviceShelf, saveCrossSellRule, setCrossSellRuleActive } from "~/server/services/admin/marketing/crosssell.server";
import { attributionReport, createLink, linkUrl, listLinks } from "~/server/services/admin/marketing/links.server";
import { performanceReport } from "~/server/services/admin/marketing/performance.server";
import { listReviews, moderateReview } from "~/server/services/admin/marketing/reviews.server";
import { EMPTY_AUDIENCE, SEND_LIMITS, baghdadMonth, fromLocalInput, parseAudienceQuery, parseWhole, ratio, type AudienceSpec } from "~/server/services/admin/marketing/types";
import { getReviewSummary } from "~/server/services/reviews.server";
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
async function code(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (isAppError(error)) return error.code;
    if (error && typeof error === "object" && "issues" in error) return "invalid";
    throw error;
  }
}
async function fields(run: () => Promise<unknown>): Promise<Record<string, string>> {
  try {
    await run();
    return {};
  } catch (error) {
    if (isAppError(error)) return error.fields ?? {};
    if (error && typeof error === "object" && "issues" in error) {
      const out: Record<string, string> = {};
      for (const issue of (error as { issues: { path: (string | number)[]; message: string }[] }).issues) out[issue.path.join(".")] ??= issue.message;
      return out;
    }
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── the test world

const PLT = "plt_zzmkt";
const OTHER = "plt_zzmko";
const DEV = "dvm_zzmkt";
const P = { console: "prd_zm_console", pad: "prd_zm_pad", case: "prd_zm_case", partial: "prd_zm_partial", none: "prd_zm_none", game: "prd_zm_game", gone: "prd_zm_gone", other: "prd_zo_other" } as const;
const VAR = (productId: string) => productId.replace(/^prd_/, "var_");

const m1 = role("emp_mkt_m1", "manager");
const m2 = role("emp_mkt_m2", "manager");
const owner = actor("emp_mkt_owner", ["*"]);
const finance = role("emp_mkt_fin", "finance");
const content = role("emp_mkt_content", "content");
const cashier = role("emp_mkt_cashier", "cashier");
/** marketing permissions only: no full phone numbers, no customer profiles */
const marketer = actor("emp_mkt_only", ["marketing.campaign.manage", "marketing.campaign.send", "marketing.cart_recovery.manage", "marketing.utm.manage", "marketing.recommendation.manage", "marketing.review.moderate", "marketing.report.read"]);

type Person = { id: string; phone: string };
const people: Record<string, Person> = {};
const guests: Record<string, { phone: string; ids: string[] }> = {};

async function buildWorld() {
  const db = t.db;
  const statements: BatchStatement[] = [
    db.insert(platforms).values({ id: PLT, slug: "zz-mkt", name: t3("منصة التسويق", "Marketing platform", "پلاتفۆرمی بازاڕگەری"), accent: "nintendo", sort: 96, isActive: true }),
    db.insert(platforms).values({ id: OTHER, slug: "zz-mko", name: t3("منصة أخرى", "Other platform", "پلاتفۆرمی تر"), accent: "xbox", sort: 97, isActive: true }),
    db.insert(deviceModels).values({ id: DEV, platformId: PLT, slug: "zz-mkt-box", name: t3("Mktbox", "Mktbox", "Mktbox"), status: "published", deviceKind: "console", sort: 1 }),
  ];
  const kinds: Record<string, "console" | "controller" | "accessory" | "game"> = { [P.console]: "console", [P.pad]: "controller", [P.case]: "accessory", [P.partial]: "accessory", [P.none]: "accessory", [P.game]: "game", [P.gone]: "accessory", [P.other]: "accessory" };
  for (const [id, kind] of Object.entries(kinds)) {
    statements.push(
      db.insert(products).values({ id, slug: id.replace(/^prd_/, "").replace(/_/g, "-"), kind, name: t3(`منتج ${id}`, `Product ${id}`, `بەرهەم ${id}`), status: "published", platformId: id === P.other ? OTHER : PLT, deviceModelId: id === P.console ? DEV : null, createdAt: NOW, updatedAt: NOW }),
      db.insert(variants).values({ id: VAR(id), productId: id, sku: `SKU-${id}`, priceIqd: 50_000, isDefault: true }),
      db.insert(stockLevels).values({ variantId: VAR(id), locationId: DEFAULT_LOCATION_ID, onHand: id === P.gone ? 0 : 10 }),
    );
  }
  const rule = (id: string, productId: string, status: "verified" | "partial") => db.insert(compatibilityRules).values({ id, subjectType: "product", subjectId: productId, targetType: "device_model", targetId: DEV, status });
  statements.push(rule("cr_zm_1", P.pad, "verified"), rule("cr_zm_2", P.case, "verified"), rule("cr_zm_3", P.partial, "partial"), rule("cr_zm_4", P.game, "verified"), rule("cr_zm_5", P.gone, "verified"));
  await runBatch(db, statements);
}

async function account(key: string, options: { name?: string; status?: "active" | "blocked" | "merged" | "deleted"; isDemo?: boolean; email?: string; prefs?: Record<string, boolean>; consents?: { granted: boolean; at: number }[] } = {}) {
  const phone = make.phone();
  const id = await make.customer({ id: `cus_mkt_${key}`, phoneE164: phone, name: options.name ?? `زبون ${key}`, status: options.status ?? "active", isDemo: options.isDemo ?? false, email: options.email ?? null, notificationPrefs: options.prefs ?? null });
  for (const answer of options.consents ?? []) await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: id, kind: "marketing", granted: answer.granted, source: "account", at: answer.at });
  people[key] = { id, phone };
  return people[key];
}
async function guest(key: string, answers: { granted: boolean; at: number }[], phone = make.phone()) {
  const ids: string[] = [];
  for (const answer of answers) {
    const id = newId("gst");
    await t.db.insert(guestContacts).values({ id, phoneE164: phone, name: `ضيف ${key}`, createdAt: answer.at });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "guest_contact", subjectId: id, kind: "marketing", granted: answer.granted, source: "checkout", at: answer.at });
    ids.push(id);
  }
  guests[key] = { phone, ids };
  return guests[key];
}
async function buy(productId: string, who: { customerId?: string; guestContactId?: string; phone?: string }, options: { placedAt?: number; status?: string; isDemo?: boolean; paid?: number } = {}) {
  const line = { variantId: VAR(productId), sku: `SKU-${productId}`, unitPriceIqd: 50_000 };
  const order = await make.order([line], { customerId: who.customerId ?? null, guestContactId: who.guestContactId ?? null, ...(who.phone ? { contactPhoneE164: who.phone } : {}), placedAt: options.placedAt ?? NOW - 5 * DAY, status: (options.status ?? "delivered") as "delivered", isDemo: options.isDemo ?? false, paidIqd: options.paid ?? 0 });
  return order;
}

const AUDIENCE: AudienceSpec = { ...EMPTY_AUDIENCE, platformIds: [PLT], boughtFrom: "2026-10-01", boughtTo: "2026-11-30", guests: true };

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedDemo(t.db, NOW);
  await buildWorld();
  // consenting account; a withdrawn one; never asked
  await account("yes", { name: "سارة الربيعي", consents: [{ granted: true, at: NOW - 20 * DAY }] });
  await account("withdrawn", { consents: [{ granted: true, at: NOW - 20 * DAY }, { granted: false, at: NOW - 2 * DAY }] });
  await account("never");
  // merged, deleted, blocked accounts — consent yes, never receive anything
  await account("merged", { status: "merged", consents: [{ granted: true, at: NOW - 10 * DAY }] });
  await account("deleted", { status: "deleted", consents: [{ granted: true, at: NOW - 10 * DAY }] });
  await account("blocked", { status: "blocked", consents: [{ granted: true, at: NOW - 10 * DAY }] });
  // SMS switched off; at the message limit; bought another platform only
  await account("smsoff", { prefs: { sms: false, whatsapp: true, email: true }, consents: [{ granted: true, at: NOW - 10 * DAY }] });
  await account("capped", { consents: [{ granted: true, at: NOW - 10 * DAY }] });
  await account("otherplatform", { consents: [{ granted: true, at: NOW - 10 * DAY }] });
  // the account said no, the same number said yes at a later guest checkout: the newest answer wins
  await account("laterYes", { consents: [{ granted: false, at: NOW - 15 * DAY }] });
  // a demo person
  await account("demo", { isDemo: true, consents: [{ granted: true, at: NOW - 10 * DAY }] });
  // guests: one consenting number; one that said yes and later no (two checkouts of the same number)
  await guest("g", [{ granted: true, at: NOW - 6 * DAY }]);
  await guest("h", [
    { granted: true, at: NOW - 9 * DAY },
    { granted: false, at: NOW - 3 * DAY },
  ]);
  // a guest checkout with the MERGED account's number saying yes: still never
  await guest("mergedNumber", [{ granted: true, at: NOW - 4 * DAY }], people.merged.phone);
  await guest("laterYesGuest", [{ granted: true, at: NOW - 4 * DAY }], people.laterYes.phone);

  for (const key of ["yes", "withdrawn", "never", "merged", "deleted", "blocked", "smsoff", "capped", "laterYes"]) await buy(P.console, { customerId: people[key].id, phone: people[key].phone });
  await buy(P.other, { customerId: people.otherplatform.id, phone: people.otherplatform.phone });
  await buy(P.console, { customerId: people.demo.id, phone: people.demo.phone }, { isDemo: true });
  await buy(P.case, { guestContactId: guests.g.ids[0], phone: guests.g.phone });
  await buy(P.case, { guestContactId: guests.h.ids[1], phone: guests.h.phone });
  await buy(P.case, { guestContactId: guests.mergedNumber.ids[0], phone: guests.mergedNumber.phone });
  // an order outside the dates
  await buy(P.console, { customerId: people.never.id, phone: people.never.phone }, { placedAt: NOW - 400 * DAY });
  // the capped person already got 2 marketing messages this week
  for (let i = 0; i < SEND_LIMITS.maxPerWindow; i++) await t.db.insert(outbox).values({ id: newId("msg"), channel: "sms", recipient: people.capped.phone, template: "cart_reminder", payload: {}, status: "held", createdAt: NOW - (i + 1) * DAY, customerId: people.capped.id });
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── consent and audiences

describe("audience: only an explicit, current marketing consent; merged, deleted and blocked never", () => {
  test("every rule decides once, in order, on what the records say", async () => {
    const result = await resolveAudience(t.db, { spec: AUDIENCE, channel: "sms", isDemo: false, now: NOW });
    const reached = new Set(result.recipients.map((entry) => entry.recipient));
    expect(reached.has(people.yes.phone)).toBe(true);
    expect(reached.has(guests.g.phone)).toBe(true); // a guest checkout's yes counts for the number
    expect(reached.has(people.laterYes.phone)).toBe(true); // newest answer across the account and its number
    for (const key of ["withdrawn", "never", "merged", "deleted", "blocked", "smsoff", "capped", "otherplatform", "demo"]) expect(reached.has(people[key].phone), key).toBe(false);
    expect(reached.has(guests.h.phone)).toBe(false); // the number's later "no"
    expect(result.excluded.consent_withdrawn).toBe(2); // the account and the number h
    expect(result.excluded.no_consent).toBe(1);
    expect(result.excluded.account_closed).toBe(2); // merged (its number's guest yes folded in) and deleted
    expect(result.excluded.blocked).toBe(1);
    expect(result.excluded.channel_off).toBe(1);
    expect(result.excluded.frequency_cap).toBe(1);
    expect(result.recipients).toHaveLength(3);
    // people without consent are documented (skipped_no_consent), the closed accounts are not
    expect(new Set(result.noConsent.map((entry) => entry.recipient))).toEqual(new Set([people.withdrawn.phone, people.never.phone, guests.h.phone]));
  });

  test("WhatsApp is not switched off for that person; e-mail needs an address (guests have none)", async () => {
    const whatsapp = await resolveAudience(t.db, { spec: AUDIENCE, channel: "whatsapp", isDemo: false, now: NOW });
    expect(whatsapp.recipients.map((entry) => entry.recipient)).toContain(people.smsoff.phone);
    const email = await resolveAudience(t.db, { spec: AUDIENCE, channel: "email", isDemo: false, now: NOW });
    expect(email.recipients).toHaveLength(0);
    expect(email.excluded.no_address).toBeGreaterThanOrEqual(3);
  });

  test("demo people only in demo campaigns; the whole store's consenting people without filters", async () => {
    const demo = await resolveAudience(t.db, { spec: { ...AUDIENCE }, channel: "sms", isDemo: true, now: NOW });
    expect(demo.recipients.map((entry) => entry.recipient)).toContain(people.demo.phone);
    expect(demo.recipients.map((entry) => entry.recipient)).not.toContain(people.yes.phone);
    const everyone = await resolveAudience(t.db, { spec: { ...EMPTY_AUDIENCE }, channel: "sms", isDemo: false, now: NOW });
    const reached = everyone.recipients.map((entry) => entry.recipient);
    expect(reached).toContain(people.yes.phone);
    expect(reached).toContain(people.otherplatform.phone); // no platform filter now
    expect(reached).not.toContain(people.demo.phone);
    expect(everyone.excluded.demo_mismatch).toBeGreaterThanOrEqual(1);
  });

  test("platform and purchase dates narrow it; module 07's stored segment narrows it further", async () => {
    const other = await resolveAudience(t.db, { spec: { ...AUDIENCE, platformIds: [OTHER] }, channel: "sms", isDemo: false, now: NOW });
    expect(other.recipients.map((entry) => entry.recipient)).toEqual([people.otherplatform.phone]);
    const old = await resolveAudience(t.db, { spec: { ...AUDIENCE, boughtFrom: "2025-01-01", boughtTo: "2025-02-01" }, channel: "sms", isDemo: false, now: NOW });
    expect(old.candidates).toBe(0);
    await t.db.insert(customerSegments).values({ id: "seg_test_mkt", key: "test.mkt", name: t3("قسم", "Segment", "بەش"), createdAt: NOW, updatedAt: NOW, memberCount: 1 });
    await t.db.insert(customerSegmentMembers).values({ segmentId: "seg_test_mkt", customerId: people.yes.id, addedAt: NOW });
    const segment = await resolveAudience(t.db, { spec: { ...AUDIENCE, segmentId: "seg_test_mkt" }, channel: "sms", isDemo: false, now: NOW });
    expect(segment.recipients.map((entry) => entry.recipient)).toEqual([people.yes.phone]);
    const noGuests = await resolveAudience(t.db, { spec: { ...AUDIENCE, guests: false }, channel: "sms", isDemo: false, now: NOW });
    expect(noGuests.recipients.map((entry) => entry.recipient)).not.toContain(guests.g.phone);
  });

  test("the explorer (16.03) masks numbers without customer.phone.read_full and reads module 07's segments", async () => {
    const result = await exploreAudience(t.db, marketer, parseAudienceQuery(new URLSearchParams(`platform=${PLT}&from=2026-10-01&to=2026-11-30`)), "ar", NOW);
    expect(result.preview.eligible).toBe(3);
    expect(result.preview.sample.every((row) => row.phone === null || row.phone.full === false)).toBe(true);
    expect(result.preview.sample.every((row) => row.profileId === null)).toBe(true);
    expect(result.byPlatform.find((row) => row.platformId === PLT)?.buyers).toBeGreaterThanOrEqual(10);
    expect(result.segments.some((segment) => segment.id === "seg_test_mkt")).toBe(true);
    const full = await exploreAudience(t.db, m1, parseAudienceQuery(new URLSearchParams(`platform=${PLT}&from=2026-10-01&to=2026-11-30`)), "ar", NOW);
    expect(full.preview.sample.some((row) => row.phone?.full === true)).toBe(true);
    expect(await code(() => exploreAudience(t.db, finance, parseAudienceQuery(new URLSearchParams()), "ar", NOW))).toBe("forbidden");
  });

  test("the same rules inside the write: a withdrawal after the count keeps the message out", async () => {
    const person = await account("race", { consents: [{ granted: true, at: NOW - 10 * DAY }] });
    const spec = (p: { id: string | null; phone: string; guestIds?: string[] }) => ({ recipient: p.phone, phone: p.phone, customerId: p.id, guestIds: p.guestIds ?? [] });
    const passing = async (specs: object[]) =>
      (await t.db.all<{ rc: string }>(sql`SELECT json_extract(r.value, '$.recipient') AS rc FROM json_each(${JSON.stringify(specs)}) AS r WHERE ${recipientGuard(NOW, null)}`)).map((row) => row.rc);
    expect(await passing([spec(person)])).toEqual([person.phone]);
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: person.id, kind: "marketing", granted: false, source: "admin", at: NOW - 1000 });
    expect(await passing([spec(person)])).toEqual([]);
    // a number tied to a merged account, a merged account, the message limit
    expect(await passing([spec({ id: null, phone: people.merged.phone, guestIds: guests.mergedNumber.ids })])).toEqual([]);
    expect(await passing([spec(people.merged)])).toEqual([]);
    expect(await passing([spec(people.capped)])).toEqual([]);
    expect(await passing([spec({ id: null, phone: guests.g.phone, guestIds: guests.g.ids })])).toEqual([guests.g.phone]);
  });
});

// ───────────────────────────────────────────────────────────────── campaigns

describe("campaigns: safe text, a second person, held in the outbox, idempotent", () => {
  let campaignId = "";

  test("a draft: only the safe variables; {link} needs the campaign's link; the key makes it once", async () => {
    const base = { idempotencyKey: "mkt-test-campaign-0001", name: "عرض المنصة", channel: "sms", platformIds: [PLT], boughtFrom: "2026-10-01", boughtTo: "2026-11-30", guests: true, bodyAr: "مرحباً {name}، وصل الجديد إلى {store}." };
    expect((await fields(() => saveCampaign(t.db, m1, { ...base, idempotencyKey: "mkt-test-campaign-bad1", bodyAr: "مرحباً {name} رصيدك {balance}" }, NOW))).bodyAr).toBe("template_variable_unknown");
    expect((await fields(() => saveCampaign(t.db, m1, { ...base, idempotencyKey: "mkt-test-campaign-bad2", bodyAr: "اطلب الآن {link}" }, NOW))).linkId).toBe("link_required");
    expect((await fields(() => saveCampaign(t.db, m1, { ...base, idempotencyKey: "mkt-test-campaign-bad3", bodyAr: "" }, NOW))).bodyAr).toBe("required");
    expect((await fields(() => saveCampaign(t.db, m1, { ...base, idempotencyKey: "mkt-test-campaign-bad4", boughtFrom: "2026-12-01", boughtTo: "2026-11-01" }, NOW))).boughtTo).toBe("range_order");
    const created = await saveCampaign(t.db, m1, base, NOW);
    expect(created.created).toBe(true);
    campaignId = created.campaignId;
    expect((await saveCampaign(t.db, m1, base, NOW)).replayed).toBe(true);
    expect(await code(() => saveCampaign(t.db, m2, base, NOW))).toBe("idempotency_mismatch");
    expect(await code(() => saveCampaign(t.db, finance, base, NOW))).toBe("forbidden");
  });

  test("the requester never decides, nor anyone who wrote it; the decider binds to what they saw", async () => {
    const page = await getCampaign(t.db, m2, campaignId, "ar", NOW, ORIGIN);
    expect(page.preview?.eligible).toBe(3);
    // m2 edits the draft, m1 asks for approval
    await saveCampaign(t.db, m2, { campaignId, expectedUpdatedAt: page.campaign.updatedAt, name: "عرض المنصة", channel: "sms", platformIds: [PLT], boughtFrom: "2026-10-01", boughtTo: "2026-11-30", guests: true, bodyAr: "مرحباً {name}، وصل الجديد إلى {store}." }, NOW + 1000);
    expect(await code(() => submitCampaign(t.db, m1, { campaignId, expectedUpdatedAt: page.campaign.updatedAt, note: "" }, NOW + 2000))).toBe("campaign_changed");
    const fresh = await getCampaign(t.db, m1, campaignId, "ar", NOW, ORIGIN);
    const submitted = await submitCampaign(t.db, m1, { campaignId, expectedUpdatedAt: fresh.campaign.updatedAt, note: "للموافقة" }, NOW + 3000);
    expect(submitted.eligible).toBe(3);
    // nothing can change it while it waits
    expect(await code(() => saveCampaign(t.db, m1, { campaignId, expectedUpdatedAt: fresh.campaign.updatedAt, name: "اسم آخر", channel: "sms", bodyAr: "نص" }, NOW + 4000))).toBe("change_pending");
    const waiting = await getCampaign(t.db, owner, campaignId, "ar", NOW, ORIGIN);
    const approval = waiting.campaign.approval;
    expect(approval?.canDecide).toBe(true);
    expect((await getCampaign(t.db, m1, campaignId, "ar", NOW, ORIGIN)).campaign.approval?.blockedBy).toBe("requester");
    expect((await getCampaign(t.db, m2, campaignId, "ar", NOW, ORIGIN)).campaign.approval?.blockedBy).toBe("editor");
    const decide = (who: Actor, fingerprint: string) => decideCampaign(t.db, who, { campaignId, approvalId: approval?.id, decision: "approve", fingerprint, note: "" }, NOW + 5000);
    expect(await code(() => decide(m1, waiting.campaign.fingerprint))).toBe("approver_is_requester");
    expect(await code(() => decide(m2, waiting.campaign.fingerprint))).toBe("approver_edited");
    expect(await code(() => decide(owner, "0".repeat(64)))).toBe("campaign_changed");
    expect(await code(() => decide(content, waiting.campaign.fingerprint))).toBe("forbidden");
    expect(await countDecidableCampaigns(t.db, owner)).toBe(1);
    expect(await countDecidableCampaigns(t.db, m1)).toBe(0);
    expect(await countDecidableCampaigns(t.db, finance)).toBeNull();
    expect((await listCampaigns(t.db, owner, { view: "decide", q: "", channel: null, demo: false, page: 1 }, NOW)).total).toBe(1);
    expect((await listCampaigns(t.db, m1, { view: "decide", q: "", channel: null, demo: false, page: 1 }, NOW)).total).toBe(0);
    expect((await decide(owner, waiting.campaign.fingerprint)).status).toBe("scheduled");
  });

  test("released: one HELD outbox message per recipient (never sent), people without consent documented, idempotent", async () => {
    expect(await code(() => releaseCampaign(t.db, finance, { campaignId }, NOW + 6000, ORIGIN))).toBe("forbidden");
    const first = await releaseCampaign(t.db, m1, { campaignId }, NOW + 6000, ORIGIN);
    expect(first.held).toBe(3);
    expect(first.skipped).toBe(3);
    const messages = await rows<{ recipient: string; status: string; template: string; payload: string; ref_id: string }>("SELECT recipient, status, template, payload, ref_id FROM outbox WHERE ref_type = 'campaign' AND ref_id = ?", campaignId);
    expect(messages).toHaveLength(3);
    expect(messages.every((row) => row.status === "held" && row.template === "marketing_campaign")).toBe(true);
    const sara = messages.find((row) => row.recipient === people.yes.phone);
    expect(JSON.parse(sara?.payload ?? "{}").text).toBe("مرحباً سارة، وصل الجديد إلى طمطم.");
    const recipients = await rows<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign_id = ? GROUP BY status ORDER BY status", campaignId);
    expect(recipients).toEqual([
      { status: "held", n: 3 },
      { status: "skipped_no_consent", n: 3 },
    ]);
    expect(await rows("SELECT 1 FROM campaign_recipients WHERE campaign_id = ? AND status = 'sent'", campaignId)).toHaveLength(0);
    const again = await releaseCampaign(t.db, m1, { campaignId }, NOW + 7000, ORIGIN);
    expect(again.replayed).toBe(true);
    expect(await rows("SELECT 1 FROM outbox WHERE ref_type = 'campaign' AND ref_id = ?", campaignId)).toHaveLength(3);
    const page = await getCampaign(t.db, m1, campaignId, "ar", NOW + 8000, ORIGIN);
    expect(page.campaign.state).toBe("released");
    expect(page.campaign.can.release).toBe(false);
    expect(page.campaign.content.release?.complete).toBe(true);
    // it can no longer be cancelled (it reached the outbox), only closed
    expect(await code(() => cancelCampaign(t.db, m1, { campaignId, reason: "خطأ" }, NOW + 9000))).toBe("campaign_closed");
  });

  test("an approved campaign is released only when due; a withdrawal and a cancellation close the request", async () => {
    const later = await saveCampaign(t.db, m1, { idempotencyKey: "mkt-test-campaign-0002", name: "لاحقاً", channel: "whatsapp", platformIds: [PLT], boughtFrom: "2026-10-01", boughtTo: "2026-11-30", guests: true, bodyAr: "عرض {store}", scheduledAt: "2026-11-20T10:00" }, NOW);
    let page = await getCampaign(t.db, m1, later.campaignId, "ar", NOW, ORIGIN);
    expect(page.campaign.scheduledAt).toBe(fromLocalInput("2026-11-20T10:00"));
    const request = await submitCampaign(t.db, m1, { campaignId: later.campaignId, expectedUpdatedAt: page.campaign.updatedAt, note: "" }, NOW);
    expect(await code(() => withdrawCampaign(t.db, owner, { campaignId: later.campaignId, approvalId: request.approvalId }, NOW))).toBe("forbidden");
    await withdrawCampaign(t.db, m1, { campaignId: later.campaignId, approvalId: request.approvalId }, NOW);
    page = await getCampaign(t.db, m1, later.campaignId, "ar", NOW, ORIGIN);
    expect(page.campaign.state).toBe("draft");
    const again = await submitCampaign(t.db, m1, { campaignId: later.campaignId, expectedUpdatedAt: page.campaign.updatedAt, note: "" }, NOW);
    page = await getCampaign(t.db, owner, later.campaignId, "ar", NOW, ORIGIN);
    await decideCampaign(t.db, owner, { campaignId: later.campaignId, approvalId: again.approvalId, decision: "approve", fingerprint: page.campaign.fingerprint, note: "" }, NOW);
    expect((await getCampaign(t.db, owner, later.campaignId, "ar", NOW, ORIGIN)).campaign.state).toBe("scheduled");
    expect(await code(() => releaseCampaign(t.db, owner, { campaignId: later.campaignId }, NOW, ORIGIN))).toBe("campaign_not_due");
    expect(await code(() => cancelCampaign(t.db, m1, { campaignId: later.campaignId, reason: "" }, NOW))).toBe("invalid");
    await cancelCampaign(t.db, m1, { campaignId: later.campaignId, reason: "تأجيل العرض" }, NOW);
    expect((await getCampaign(t.db, m1, later.campaignId, "ar", NOW, ORIGIN)).campaign.state).toBe("cancelled");
    // a rejection needs a note
    const rejectMe = await saveCampaign(t.db, m1, { idempotencyKey: "mkt-test-campaign-0003", name: "للرفض", channel: "sms", platformIds: [PLT], guests: true, bodyAr: "نص {name}" }, NOW);
    const draft = await getCampaign(t.db, m1, rejectMe.campaignId, "ar", NOW, ORIGIN);
    const asked = await submitCampaign(t.db, m1, { campaignId: rejectMe.campaignId, expectedUpdatedAt: draft.campaign.updatedAt, note: "" }, NOW);
    const shown = await getCampaign(t.db, owner, rejectMe.campaignId, "ar", NOW, ORIGIN);
    expect(await code(() => decideCampaign(t.db, owner, { campaignId: rejectMe.campaignId, approvalId: asked.approvalId, decision: "reject", fingerprint: shown.campaign.fingerprint, note: "" }, NOW))).toBe("invalid");
    expect((await decideCampaign(t.db, owner, { campaignId: rejectMe.campaignId, approvalId: asked.approvalId, decision: "reject", fingerprint: shown.campaign.fingerprint, note: "النص غير واضح" }, NOW)).status).toBe("draft");
    expect((await getCampaign(t.db, m1, rejectMe.campaignId, "ar", NOW, ORIGIN)).campaign.lastDecision?.status).toBe("rejected");
  });

  test("an audience that reaches nobody is not submitted", async () => {
    const nobody = await saveCampaign(t.db, m1, { idempotencyKey: "mkt-test-campaign-0004", name: "لا أحد", channel: "sms", platformIds: [PLT], boughtFrom: "2025-01-01", boughtTo: "2025-01-02", guests: true, bodyAr: "نص" }, NOW);
    const page = await getCampaign(t.db, m1, nobody.campaignId, "ar", NOW, ORIGIN);
    expect(await code(() => submitCampaign(t.db, m1, { campaignId: nobody.campaignId, expectedUpdatedAt: page.campaign.updatedAt, note: "" }, NOW))).toBe("audience_empty");
  });
});

// ───────────────────────────────────────────────────────────────── spend and performance

describe("spend and the performance report (16.07): entered by staff, never 0 for unknown, no cost", () => {
  test("spend per month: idempotent, corrections, never below zero, never the future, guarded", async () => {
    const ads = await saveCampaign(t.db, m1, { idempotencyKey: "mkt-test-ads-000001", name: "إعلانات إنستغرام", channel: "ads", budgetIqd: "500,000", startsOn: "2026-11-01" }, NOW);
    let page = await getCampaign(t.db, m1, ads.campaignId, "ar", NOW, ORIGIN);
    expect(page.campaign.budgetIqd).toBe(500_000);
    const month = baghdadMonth(NOW);
    const entry = { campaignId: ads.campaignId, period: month, amountIqd: "٣٠٠٬٠٠٠", reference: "INV-77", note: "فاتورة نوفمبر", idempotencyKey: "mkt-test-spend-00001", expectedUpdatedAt: page.campaign.updatedAt };
    const first = await recordSpend(t.db, m1, entry, NOW);
    expect(first.spendIqd).toBe(300_000);
    expect((await recordSpend(t.db, m1, entry, NOW)).replayed).toBe(true);
    expect(await code(() => recordSpend(t.db, m1, { ...entry, idempotencyKey: "mkt-test-spend-00002" }, NOW))).toBe("campaign_changed");
    page = await getCampaign(t.db, m1, ads.campaignId, "ar", NOW, ORIGIN);
    expect((await fields(() => recordSpend(t.db, m1, { ...entry, idempotencyKey: "mkt-test-spend-00003", amountIqd: "-400000", expectedUpdatedAt: page.campaign.updatedAt }, NOW))).amountIqd).toBe("spend_below_zero");
    expect((await fields(() => recordSpend(t.db, m1, { ...entry, idempotencyKey: "mkt-test-spend-00004", period: "2027-05", expectedUpdatedAt: page.campaign.updatedAt }, NOW))).period).toBe("period_future");
    await recordSpend(t.db, m1, { ...entry, idempotencyKey: "mkt-test-spend-00005", amountIqd: "-50000", note: "تصحيح الفاتورة", expectedUpdatedAt: page.campaign.updatedAt }, NOW);
    expect(await code(() => recordSpend(t.db, finance, { ...entry, idempotencyKey: "mkt-test-spend-00006" }, NOW))).toBe("forbidden");
  });

  test("CAC = the month's spend ÷ its new customers; ROAS not available without attribution; LTV from real orders", async () => {
    const range = { from: baghdadMonth(NOW - 40 * DAY), to: baghdadMonth(NOW), demo: false };
    const report = await performanceReport(t.db, finance, range, NOW);
    const month = report.months.find((row) => row.period === baghdadMonth(NOW));
    expect(month?.spendIqd).toBe(250_000);
    expect(month?.spendEntries).toBe(2);
    if (month && month.newCustomers > 0) expect(month.cacIqd).toBe(250_000 / month.newCustomers);
    else expect(month?.cacIqd).toBeNull();
    const earlier = report.months.find((row) => row.period !== baghdadMonth(NOW));
    expect(earlier?.spendIqd).toBeNull();
    expect(earlier?.cacIqd).toBeNull();
    const ads = report.campaigns.find((row) => row.name === "إعلانات إنستغرام");
    expect(ads?.spendIqd).toBe(250_000);
    expect(ads?.roas).toBeNull();
    // LTV: the average of paid − refunded per person over every qualifying order
    const truth = await rows<{ n: number; net: number }>(`
      SELECT COUNT(*) AS n, SUM(net) AS net FROM (SELECT COALESCE(o.customer_id, gc.customer_id, o.contact_phone_e164) AS person, SUM(o.paid_iqd - o.refunded_iqd) AS net
        FROM orders o LEFT JOIN guest_contacts gc ON gc.id = o.guest_contact_id WHERE o.is_demo = 0 AND o.status <> 'cancelled' AND o.paid_iqd > 0 GROUP BY person) WHERE person IS NOT NULL`);
    expect(report.ltv.customers).toBe(truth[0].n);
    if (truth[0].n > 0) expect(report.ltv.avgPaidIqd).toBeCloseTo(truth[0].net / truth[0].n, 6);
    // no cost or profit leaves this report
    expect(JSON.stringify(report)).not.toMatch(/cost|profit|margin/i);
    expect(await code(() => performanceReport(t.db, content, range, NOW))).toBe("forbidden");
  });

  test("ratios are null, never 0, NaN or Infinity, without a denominator; typed numbers accept Arabic-Indic digits", () => {
    expect(ratio(100, 0)).toBeNull();
    expect(ratio(null, 5)).toBeNull();
    expect(ratio(100, 4)).toBe(25);
    expect(parseWhole("٢٥٬٠٠٠")).toBe(25_000);
    expect(parseWhole("۱۲۰")).toBe(120);
    expect(parseWhole("12.5")).toBeNaN();
    expect(parseWhole("-500", { negative: true })).toBe(-500);
  });
});

// ───────────────────────────────────────────────────────────────── carts

describe("abandoned carts (16.02): known, consenting customers; one held reminder per cart", () => {
  const cart = async (customerId: string | null, productId: string, updatedAt: number) => {
    const id = newId("crt");
    await t.db.insert(carts).values({ id, tokenHash: newId("tok"), customerId, createdAt: updatedAt - HOUR, updatedAt });
    await t.db.insert(cartItems).values({ id: newId("cit"), cartId: id, variantId: VAR(productId), qty: 2, addedAt: updatedAt });
    return id;
  };

  test("verdicts, the reminder held in the outbox, nothing twice, the rules again in the write", async () => {
    const ok = await account("cartok", { name: "علي حسن", consents: [{ granted: true, at: NOW - 10 * DAY }] });
    const noConsent = await account("cartno");
    const ordered = await account("cartordered", { consents: [{ granted: true, at: NOW - 10 * DAY }] });
    const soldOut = await account("cartgone", { consents: [{ granted: true, at: NOW - 10 * DAY }] });
    const cOk = await cart(ok.id, P.pad, NOW - 3 * HOUR);
    const cGuest = await cart(null, P.pad, NOW - 3 * HOUR);
    const cNo = await cart(noConsent.id, P.pad, NOW - 3 * HOUR);
    const cOrdered = await cart(ordered.id, P.pad, NOW - 5 * HOUR);
    await buy(P.pad, { customerId: ordered.id, phone: ordered.phone }, { placedAt: NOW - 2 * HOUR, status: "confirmed" });
    const cGone = await cart(soldOut.id, P.gone, NOW - 3 * HOUR);
    const cFresh = await cart(ok.id, P.case, NOW - 30 * 60_000);
    const page = await listAbandonedCarts(t.db, m1, { view: "all", demo: false, page: 1 }, NOW);
    const verdict = (id: string) => page.rows.find((row) => row.id === id)?.verdict;
    expect(verdict(cOk)).toBe("eligible");
    expect(verdict(cGuest)).toBe("guest_cart");
    expect(verdict(cNo)).toBe("no_consent");
    expect(verdict(cOrdered)).toBe("recent_order");
    expect(verdict(cGone)).toBe("nothing_available");
    expect(verdict(cFresh)).toBeUndefined();
    const prepared = await prepareCartReminders(t.db, m1, { cartIds: [cOk, cNo, cGuest], idempotencyKey: "mkt-test-carts-000001" }, NOW, ORIGIN);
    expect(prepared.prepared).toBe(1);
    const reminder = await rows<{ status: string; outbox_id: string; phone_e164: string }>("SELECT status, outbox_id, phone_e164 FROM cart_reminders WHERE cart_id = ?", cOk);
    expect(reminder).toHaveLength(1);
    expect(reminder[0].status).toBe("held");
    const message = await rows<{ status: string; template: string; payload: string }>("SELECT status, template, payload FROM outbox WHERE id = ?", reminder[0].outbox_id);
    expect(message[0].status).toBe("held");
    expect(message[0].template).toBe("cart_reminder");
    const payload = JSON.parse(message[0].payload) as { name: string; items: number; link: string; text: string };
    expect(payload.name).toBe("علي");
    expect(payload.items).toBe(2);
    expect(payload.link).toBe(`${ORIGIN}/cart?utm_source=sms&utm_medium=cart_reminder&utm_campaign=cart_recovery`);
    expect(payload.text).toContain("علي");
    expect((await prepareCartReminders(t.db, m1, { cartIds: [cOk], idempotencyKey: "mkt-test-carts-000001" }, NOW, ORIGIN)).replayed).toBe(true);
    expect(await code(() => prepareCartReminders(t.db, m1, { cartIds: [cOk], idempotencyKey: "mkt-test-carts-000002" }, NOW, ORIGIN))).toBe("nothing_to_prepare");
    expect((await listAbandonedCarts(t.db, m1, { view: "reminded", demo: false, page: 1 }, NOW)).rows.map((row) => row.id)).toContain(cOk);
    expect(await code(() => listAbandonedCarts(t.db, finance, { view: "all", demo: false, page: 1 }, NOW))).toBe("forbidden");
  });

  test("quiet hours: a reminder prepared at night is scheduled for 09:00 Baghdad", () => {
    const night = Date.UTC(2026, 10, 10, 20, 0); // 23:00 Baghdad
    expect(reminderTime(night)).toBe(Date.UTC(2026, 10, 11, 6, 0));
    const early = Date.UTC(2026, 10, 10, 3, 0); // 06:00 Baghdad
    expect(reminderTime(early)).toBe(Date.UTC(2026, 10, 10, 6, 0));
    expect(reminderTime(NOW)).toBe(NOW);
  });
});

// ───────────────────────────────────────────────────────────────── links and attribution

describe("links and attribution (16.04): the CMS's path rules; only orders that carry their source", () => {
  test("a link to a store page; reserved, external and missing pages refused; the URL carries the code", async () => {
    const tracked = await saveCampaign(t.db, m1, { idempotencyKey: "mkt-test-tracked-01", name: "منشورات", channel: "social" }, NOW);
    const link = await createLink(t.db, m1, { targetPath: "/platform/zz-mkt", source: "Instagram", medium: "social", campaignId: tracked.campaignId, idempotencyKey: "mkt-test-link-000001" }, NOW, ORIGIN);
    expect(link.url).toBe(linkUrl(ORIGIN, { targetPath: "/platform/zz-mkt", source: "instagram", medium: "social", campaign: (await rows<{ utm_campaign: string }>("SELECT utm_campaign FROM campaigns WHERE id = ?", tracked.campaignId))[0].utm_campaign, content: null, term: null, code: link.code }));
    expect(link.url).toContain(`tt_l=${link.code}`);
    expect((await createLink(t.db, m1, { targetPath: "/platform/zz-mkt", source: "instagram", medium: "social", idempotencyKey: "mkt-test-link-000001" }, NOW, ORIGIN)).replayed).toBe(true);
    expect((await fields(() => createLink(t.db, m1, { targetPath: "/admin/orders", source: "x", medium: "y", idempotencyKey: "mkt-test-link-000002" }, NOW, ORIGIN))).targetPath).toBe("path_reserved");
    expect((await fields(() => createLink(t.db, m1, { targetPath: "https://example.com", source: "x", medium: "y", idempotencyKey: "mkt-test-link-000003" }, NOW, ORIGIN))).targetPath).toBe("path_external");
    expect((await fields(() => createLink(t.db, m1, { targetPath: "/p/no-such-product", source: "x", medium: "y", idempotencyKey: "mkt-test-link-000004" }, NOW, ORIGIN))).targetPath).toBe("link_missing");
    expect((await fields(() => createLink(t.db, m1, { targetPath: "/", source: "حملة", medium: "y", idempotencyKey: "mkt-test-link-000005" }, NOW, ORIGIN))).source).toBe("utm_invalid");
    expect(await code(() => createLink(t.db, finance, { targetPath: "/", source: "x", medium: "y", idempotencyKey: "mkt-test-link-000006" }, NOW, ORIGIN))).toBe("forbidden");
    // finance reads the links and the attribution, never makes one
    const list = await listLinks(t.db, finance, { q: "", campaign: null, page: 1 }, ORIGIN);
    expect(list.canManage).toBe(false);
    expect(list.rows.some((row) => row.id === link.linkId)).toBe(true);

    // nothing is attributed until an order carries its source; then exactly that order
    const range = { from: "2026-11-01", to: "2026-11-10", demo: false };
    const before = await attributionReport(t.db, finance, range, NOW);
    expect(before.captured).toBe(false);
    expect(before.orders.attributed).toBe(0);
    expect(before.byCampaign).toEqual([]);
    const buyer = await account("attributed", { consents: [] });
    const order = await buy(P.case, { customerId: buyer.id, phone: buyer.phone }, { placedAt: NOW - DAY, status: "delivered", paid: 55_000 });
    await t.d1.prepare("UPDATE orders SET utm_link_id = ? WHERE id = ?").bind(link.linkId, order.orderId).run();
    const after = await attributionReport(t.db, finance, range, NOW);
    expect(after.captured).toBe(true);
    expect(after.orders.attributed).toBe(1);
    expect(after.byCampaign).toEqual([{ campaignId: tracked.campaignId, name: "منشورات", utm: expect.any(String), orders: 1, paidIqd: 55_000, gmvIqd: order.totalIqd }]);
    expect(after.bySource[0]).toMatchObject({ source: "instagram", medium: "social", orders: 1 });
  });
});

// ───────────────────────────────────────────────────────────────── cross-sell

describe("cross-sell (16.05): pin / boost only add-ons VERIFIED on the device", () => {
  test("verified add-ons only; partial, unverified and non-add-ons refused; exclude allowed; the shelf follows", async () => {
    const offer = await deviceAddOns(t.db, m1, DEV, "ar", NOW);
    expect(offer.addOns.map((entry) => entry.productId).sort()).toEqual([P.case, P.gone, P.pad].sort());
    const base = { deviceModelId: DEV, placement: "device_hub:setup", reason: "حقيبة مع الجهاز" };
    const pin = await saveCrossSellRule(t.db, m1, { ...base, kind: "pin", productId: P.case, weight: "5" }, NOW);
    const partial = await (async () => {
      try {
        await saveCrossSellRule(t.db, m1, { ...base, kind: "pin", productId: P.partial }, NOW);
        return null;
      } catch (error) {
        return isAppError(error) ? { code: error.code, field: error.fields?.productId } : null;
      }
    })();
    expect(partial).toEqual({ code: "rule_not_verified", field: "compat_partial" });
    expect(await code(() => saveCrossSellRule(t.db, m1, { ...base, kind: "boost", productId: P.none, weight: "10" }, NOW))).toBe("rule_not_verified");
    expect((await fields(() => saveCrossSellRule(t.db, m1, { ...base, kind: "pin", productId: P.game }, NOW))).productId).toBe("product_not_addon");
    expect((await fields(() => saveCrossSellRule(t.db, m1, { ...base, kind: "boost", productId: P.pad, weight: "0" }, NOW))).weight).toBe("number_invalid");
    expect(await code(() => saveCrossSellRule(t.db, m1, { ...base, kind: "pin", productId: P.case }, NOW))).toBe("rule_changed");
    await saveCrossSellRule(t.db, m1, { ...base, kind: "exclude", productId: P.partial }, NOW);
    expect(await code(() => saveCrossSellRule(t.db, finance, { ...base, kind: "pin", productId: P.pad }, NOW))).toBe("forbidden");

    const shelf = await previewDeviceShelf(t.db, m1, DEV, "ar", NOW);
    expect(shelf?.items[0]?.productId).toBe(P.case);
    expect(shelf?.items[0]?.ruled).toBe("pin");
    expect(shelf?.items.map((item) => item.productId)).not.toContain(P.partial);
    expect(shelf?.items.map((item) => item.productId)).not.toContain(P.gone); // sold out never shows

    let list = await listCrossSellRules(t.db, m1, { device: DEV, kind: null, active: "all", page: 1 }, "ar", NOW);
    expect(list.rows.find((row) => row.id === pin.ruleId)?.effect).toBe("shows");
    expect(list.rows.find((row) => row.productId === P.partial)?.effect).toBe("removes");
    // switched off, then the catalogue downgrades the product: switching on is refused
    await setCrossSellRuleActive(t.db, m1, { ruleId: pin.ruleId, active: "0", reason: "انتهى العرض" }, NOW);
    list = await listCrossSellRules(t.db, m1, { device: DEV, kind: null, active: "all", page: 1 }, "ar", NOW);
    expect(list.rows.find((row) => row.id === pin.ruleId)?.effect).toBe("inactive");
    await t.d1.prepare("UPDATE compatibility_rules SET status = 'partial' WHERE id = 'cr_zm_2'").run();
    expect(await code(() => setCrossSellRuleActive(t.db, m1, { ruleId: pin.ruleId, active: "1", reason: "إعادة" }, NOW))).toBe("rule_not_verified");
    await t.d1.prepare("UPDATE compatibility_rules SET status = 'verified' WHERE id = 'cr_zm_2'").run();
    expect((await setCrossSellRuleActive(t.db, m1, { ruleId: pin.ruleId, active: "1", reason: "إعادة" }, NOW)).changed).toBe(true);
    expect((await setCrossSellRuleActive(t.db, m1, { ruleId: pin.ruleId, active: "1", reason: "إعادة" }, NOW)).changed).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── reviews

describe("reviews (16.06): approve only a verified purchase that holds up; never an invented rating", () => {
  test("approve, reject with a code, stale decisions refused; the storefront counts approved verified reviews only", async () => {
    const buyer = await account("reviewer", { name: "مراجع" });
    const delivered = await buy(P.pad, { customerId: buyer.id, phone: buyer.phone }, { status: "delivered" });
    const pending = await buy(P.case, { customerId: buyer.id, phone: buyer.phone }, { status: "confirmed" });
    const insert = (id: string, productId: string, orderItemId: string | null, verified: boolean, rating: number) =>
      t.db.insert(reviews).values({ id, productId, customerId: buyer.id, orderItemId, rating, title: "رأيي", body: "جيد جداً", isVerifiedPurchase: verified, createdAt: NOW, locale: "ar" });
    await insert("rev_mkt_ok", P.pad, delivered.itemIds[0], true, 4);
    await insert("rev_mkt_notdelivered", P.case, pending.itemIds[0], true, 2);
    await insert("rev_mkt_unverified", P.console, null, false, 1);
    expect((await getReviewSummary(t.db, P.pad)).count).toBe(0);

    const list = await listReviews(t.db, content, { view: "pending", rating: null, verified: "all", q: "", page: 1 }, "ar");
    expect(list.counts.pending).toBe(3);
    // content staff moderate, but never see who wrote it without customers.customer.read
    expect(list.rows.every((row) => row.author.name === null && row.author.profileId === null)).toBe(true);
    expect((await listReviews(t.db, m1, { view: "pending", rating: null, verified: "all", q: "", page: 1 }, "ar")).rows.find((row) => row.id === "rev_mkt_ok")?.author.name).toBe("مراجع");

    await moderateReview(t.db, content, { reviewId: "rev_mkt_ok", decision: "approve", expectedStatus: "pending" }, NOW);
    expect(await getReviewSummary(t.db, P.pad)).toMatchObject({ count: 1, average: 4 });
    expect(await code(() => moderateReview(t.db, content, { reviewId: "rev_mkt_ok", decision: "approve", expectedStatus: "pending" }, NOW))).toBe("review_changed");
    expect(await code(() => moderateReview(t.db, content, { reviewId: "rev_mkt_unverified", decision: "approve", expectedStatus: "pending" }, NOW))).toBe("review_not_verified");
    expect(await code(() => moderateReview(t.db, content, { reviewId: "rev_mkt_notdelivered", decision: "approve", expectedStatus: "pending" }, NOW))).toBe("purchase_not_verified");
    expect((await fields(() => moderateReview(t.db, content, { reviewId: "rev_mkt_unverified", decision: "reject", expectedStatus: "pending" }, NOW))).code).toBe("reason_required");
    expect((await fields(() => moderateReview(t.db, content, { reviewId: "rev_mkt_unverified", decision: "reject", expectedStatus: "pending", code: "other" }, NOW))).note).toBe("reason_required");
    await moderateReview(t.db, content, { reviewId: "rev_mkt_unverified", decision: "reject", expectedStatus: "pending", code: "spam", note: "" }, NOW);
    const rejected = await listReviews(t.db, content, { view: "rejected", rating: null, verified: "all", q: "", page: 1 }, "ar");
    expect(rejected.rows.find((row) => row.id === "rev_mkt_unverified")?.rejectCode).toBe("spam");
    // an approved review taken down again, with its reason
    await moderateReview(t.db, content, { reviewId: "rev_mkt_ok", decision: "reject", expectedStatus: "approved", code: "personal_data", note: "رقم هاتف في النص" }, NOW);
    expect((await getReviewSummary(t.db, P.pad)).count).toBe(0);
    expect(await code(() => moderateReview(t.db, cashier, { reviewId: "rev_mkt_ok", decision: "approve", expectedStatus: "rejected" }, NOW))).toBe("forbidden");
    const audit = await rows<{ action: string }>("SELECT action FROM audit_events WHERE entity_type = 'review' AND entity_id = 'rev_mkt_ok' ORDER BY seq");
    expect(audit.map((row) => row.action)).toEqual(["marketing.review.approve", "marketing.review.reject"]);
  });
});

// ───────────────────────────────────────────────────────────────── authorization

describe("authorization: each section only with its permission", () => {
  test("finance reads reports and links; content reviews; a cashier nothing", async () => {
    const filters = { view: "all" as const, q: "", channel: null, demo: false, page: 1 };
    expect(await code(() => listCampaigns(t.db, finance, filters, NOW))).toBe("forbidden");
    expect(await code(() => listCampaigns(t.db, content, filters, NOW))).toBe("forbidden");
    expect(await code(() => listCampaigns(t.db, cashier, filters, NOW))).toBe("forbidden");
    expect((await listCampaigns(t.db, m1, filters, NOW)).total).toBeGreaterThan(0);
    expect(await code(() => listReviews(t.db, finance, { view: "pending", rating: null, verified: "all", q: "", page: 1 }, "ar"))).toBe("forbidden");
    expect(await code(() => listCrossSellRules(t.db, content, { device: null, kind: null, active: "all", page: 1 }, "ar", NOW))).toBe("forbidden");
    expect(await code(() => performanceReport(t.db, cashier, { from: "2026-11", to: "2026-11", demo: false }, NOW))).toBe("forbidden");
    expect(await code(() => attributionReport(t.db, content, { from: "2026-11-01", to: "2026-11-10", demo: false }, NOW))).toBe("forbidden");
  });

  test("recipient lists mask numbers and hide profile links without the permissions", async () => {
    const list = await listCampaigns(t.db, marketer, { view: "released", q: "", channel: null, demo: false, page: 1 }, NOW);
    expect(list.total).toBe(1);
    const page = await getCampaign(t.db, marketer, list.rows[0].id, "ar", NOW, ORIGIN);
    expect(page.campaign.recipients.held).toBe(3);
    const masked = await listRecipients(t.db, marketer, list.rows[0].id, 1);
    expect(masked.rows).toHaveLength(6);
    expect(masked.rows.every((row) => row.phone !== null && row.phone.full === false && row.phone.display.includes("•"))).toBe(true);
    expect(masked.rows.every((row) => row.profileId === null)).toBe(true);
    const full = await listRecipients(t.db, owner, list.rows[0].id, 1);
    expect(full.rows.some((row) => row.phone?.full === true && row.profileId !== null)).toBe(true);
  });
});
