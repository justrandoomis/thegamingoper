/**
 * Content area (~/server/services/content.server): policies (approved CMS pages, else drafts filled with the store's
 * live settings), contact details, the about page's facts, the sitemap and robots.txt — against a real local D1 with
 * the demo catalogue. Expectations are derived from the database or from the settings written here, never from a
 * demo slug, so the tests keep holding when the catalogue changes.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCALE_CODES, pick, type L10n, type Locale } from "~/lib/locales";
import { POLICY_SLUGS, aboutLinks, type PolicyView } from "~/routes/storefront/content/content-model";
import { categories, governorates, knowledgeArticles, pages, products, settings, shippingRates, usedUnits, variants, type LocalizedBlocks } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { RETENTION_DAYS } from "~/server/jobs.server";
import { CUSTOMER_COOKIE, CUSTOMER_SESSION_DAYS } from "~/server/auth/customer.server";
import { CART_COOKIE } from "~/server/shell.server";
import { RECENT_DAYS as SEARCH_RECENT_DAYS } from "~/routes/storefront/catalog/components/recent-searches";
import { INTRO_COOKIE, PLATFORMS_COOKIE, PREF_MAX_AGE_SEC, RECENT_DAYS as HOME_RECENT_DAYS } from "~/routes/storefront/home/personal";
import { CONSENT_COOKIE, CONSENT_COOKIE_MAX_AGE_SEC } from "~/server/services/account/preferences.server";
import { RECOMMENDATION_EVENT_RETENTION_DAYS, REC_SESSION_COOKIE, REC_SESSION_MAX_AGE_SEC } from "~/server/services/recommendations.server";
import { TRADE_IN_DRAFT_COOKIE, TRADE_IN_DRAFT_MAX_AGE_SEC } from "~/server/services/tradein.server";
import { WISH_COOKIE, WISH_COOKIE_MAX_AGE_SEC } from "~/server/services/wishlist.server";
import contentStrings from "~/i18n/messages/content";
import {
  POLICY_DRAFTS_REVISED_AT,
  PRIVACY_COOKIES,
  PRIVACY_STORAGE_DAYS,
  buildRobotsTxt,
  buildSitemapXml,
  contactView,
  contentMessages,
  getCmsText,
  getContactDetails,
  getPolicy,
  getPolicyDraftL10n,
  getSitemapEntries,
  getStoreFacts,
  listPolicies,
  resolvePublicOrigin,
  robotsIndexable,
  type SitemapEntry,
} from "~/server/services/content.server";
import { settingDefault, type SettingKey } from "~/server/settings.server";
import { parseBlocks, type Block } from "~/ui/Blocks";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
const NOW = Date.UTC(2026, 10, 11, 9, 0, 0);

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
}, 120_000);

afterAll(async () => {
  await t?.dispose();
});

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;

/** Store a setting for the duration of a test (validated by the same registry the app reads with). */
async function setSettingRow(key: SettingKey, value: unknown) {
  await t.db.insert(settings).values({ key, value, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: NOW } });
}
async function resetSettings() {
  for (const key of ["shipping.flat_fee_iqd", "shipping.overrides_enabled", "payments.cod", "payments.wallet", "payments.bank_transfer", "payments.zaincash", "checkout.transfer_proof_hours", "returns.window_days", "tradein.estimate_valid_days", "store.contact"] as const) {
    await setSettingRow(key, settingDefault(key));
  }
}

/** Every string a list of blocks shows. */
function textOf(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block): string[] => {
    switch (block.type) {
      case "h2":
      case "p":
        return [block.text];
      case "ul":
      case "ol":
        return block.items;
      case "steps":
        return block.items.flatMap((item) => [item.title, item.text ?? ""]);
      case "callout":
        return [block.title ?? "", block.text];
      case "table":
        return [...block.head, ...block.rows.flat()];
      case "art":
        return [block.alt];
    }
  });
}
/** The visible text (bidi isolation marks removed: U+2066 … U+2069 keep numbers and Latin names in place). */
const visible = (text: string) => text.replace(/[⁦-⁩]/g, "");
const joined = (policy: PolicyView) => visible(textOf(policy.blocks).join("\n"));
/** The shape of a block list without its words: types and list lengths. */
const shape = (blocks: readonly Block[]) =>
  blocks.map((block) => `${block.type}:${"items" in block ? block.items.length : "rows" in block ? `${block.head.length}x${block.rows.length}` : "-"}`);

async function policy(slug: string, locale: Locale = "ar", options: { now?: number; storeMode?: "demo" | "live" } = {}) {
  return getPolicy(t.db, locale, slug, { now: NOW, storeMode: "demo", ...options });
}

// ───────────────────────────────────────────────────────────────── drafts

describe("policy drafts (no approved CMS page)", () => {
  beforeEach(resetSettings);

  it("exist for every known policy in ar, en and ckb, flagged as unapproved drafts, with the same structure in each language", async () => {
    for (const slug of POLICY_SLUGS) {
      const shapes = new Map<Locale, string[]>();
      for (const locale of LOCALE_CODES) {
        const view = await policy(slug, locale);
        expect(view, `${slug} ${locale}`).not.toBeNull();
        // v2 §6.15: a draft says «آخر تحديث» too — never earlier than the drafts' last revision in code
        expect(view).toMatchObject({ slug, source: "draft", approved: false, noindex: true, textLocale: locale, updatedAt: expect.any(Number) });
        expect(view!.updatedAt).toBeGreaterThanOrEqual(POLICY_DRAFTS_REVISED_AT);
        expect(view!.title.trim()).not.toBe("");
        expect(view!.summary.trim()).not.toBe("");
        expect(view!.blocks.length).toBeGreaterThan(3);
        // every block survives the renderer's own parser (no empty list, no malformed block)
        expect(parseBlocks(view!.blocks)).toEqual(view!.blocks);
        shapes.set(locale, shape(view!.blocks));
      }
      expect(shapes.get("en"), slug).toEqual(shapes.get("ar"));
      expect(shapes.get("ckb"), slug).toEqual(shapes.get("ar"));
    }
  });

  it("leave no placeholder unfilled and no missing key behind", async () => {
    for (const slug of POLICY_SLUGS) {
      for (const locale of LOCALE_CODES) {
        const view = (await policy(slug, locale))!;
        const text = [view.title, view.summary, ...textOf(view.blocks)].join("\n");
        expect(text, `${slug} ${locale}`).not.toMatch(/\{\w+\}/);
        expect(text).not.toMatch(/drafts\.|units\.|undefined|NaN/);
      }
    }
  });

  it("state the delivery fee from settings, and follow a change", async () => {
    expect(joined((await policy("shipping", "en"))!)).toContain("5,000 IQD");
    expect(joined((await policy("terms", "ar"))!)).toContain("5,000 د.ع");
    await setSettingRow("shipping.flat_fee_iqd", 6_500);
    const shipping = (await policy("shipping", "en"))!;
    expect(joined(shipping)).toContain("6,500 IQD");
    expect(joined(shipping)).not.toContain("5,000");
    expect(shipping.facts).toContainEqual({ kind: "delivery_fee", amountIqd: 6_500, varies: false });
    expect(joined((await policy("terms", "ckb"))!)).toContain("6,500");
  });

  it("list every active governorate by name without a count, and say when delivery is paused somewhere", async () => {
    const active = await rows<{ id: string; name: string }>("SELECT id, name FROM governorates WHERE is_active = 1 ORDER BY sort, slug");
    expect(active.length).toBeGreaterThan(10);
    const names = active.map((row) => pick(JSON.parse(row.name) as L10n, "en"));
    const shipping = (await policy("shipping", "en"))!;
    const list = shipping.blocks.find((block): block is Extract<Block, { type: "p" }> => block.type === "p" && block.text.includes(names[0]));
    expect(list?.text).toBe(names.join(", "));
    // v2 §13 #6: how many governorates there are is the owner's to say — the policy names them, it does not count them
    expect(joined(shipping)).not.toContain(`${active.length} governorates`);
    expect(joined((await policy("shipping", "ar"))!)).not.toMatch(new RegExp(`${active.length}\\s*محافظ`));
    // every governorate served: the fee line («لكل المحافظات») says it, so no coverage fact
    expect(shipping.facts.map((fact) => fact.kind)).toEqual(["delivery_fee", "track"]);

    await t.db.update(governorates).set({ isActive: false }).where(eq(governorates.id, active[0].id));
    try {
      const paused = (await policy("shipping", "en"))!;
      expect(joined(paused)).not.toContain(names[0]);
      expect(paused.facts).toContainEqual({ kind: "coverage_paused", all: false });
    } finally {
      await t.db.update(governorates).set({ isActive: true }).where(eq(governorates.id, active[0].id));
    }
  });

  it("date a draft by its last revision, or by the last change to a setting it quotes", async () => {
    // the warranty draft quotes no setting: its date is the drafts' revision
    expect((await policy("warranty", "en"))!.updatedAt).toBe(POLICY_DRAFTS_REVISED_AT);
    const later = NOW + 5 * 86_400_000;
    await t.db.insert(settings).values({ key: "returns.window_days", value: 10, updatedAt: later }).onConflictDoUpdate({ target: settings.key, set: { value: 10, updatedAt: later } });
    expect((await policy("returns", "en"))!.updatedAt).toBe(later);
    // a setting the privacy draft does not quote leaves it alone
    expect((await policy("privacy", "en"))!.updatedAt).toBe(POLICY_DRAFTS_REVISED_AT);
  });

  it("show per-governorate fees only while overrides are on and an override changes a fee", async () => {
    const [first] = await rows<{ id: string; name: string }>("SELECT id, name FROM governorates WHERE is_active = 1 ORDER BY sort, slug LIMIT 1");
    const firstName = pick(JSON.parse(first.name) as L10n, "en");
    await t.db.insert(shippingRates).values({ id: "shr_content_test", governorateId: first.id, feeIqd: 8_000, isOverride: true, isActive: true, updatedAt: NOW });
    try {
      // switch off: the row is ignored, the policy stays flat
      let shipping = (await policy("shipping", "en"))!;
      expect(shipping.blocks.some((block) => block.type === "table")).toBe(false);

      await setSettingRow("shipping.overrides_enabled", true);
      shipping = (await policy("shipping", "en"))!;
      const tableBlock = shipping.blocks.find((block): block is Extract<Block, { type: "table" }> => block.type === "table");
      expect(tableBlock).toBeDefined();
      expect(tableBlock!.rows).toContainEqual([firstName, expect.stringContaining("8,000 IQD")]);
      expect(tableBlock!.rows.filter((row) => row[1].includes("5,000 IQD")).length).toBe(tableBlock!.rows.length - 1);
      expect(shipping.facts).toContainEqual({ kind: "delivery_fee", amountIqd: 5_000, varies: true });
      // the terms and the about page say the fee depends on the governorate
      expect(joined((await policy("terms", "en"))!)).not.toContain("5,000");
      expect(await getStoreFacts(t.db, "en")).toMatchObject({ deliveryVaries: true });
    } finally {
      await t.db.delete(shippingRates).where(eq(shippingRates.id, "shr_content_test"));
    }
    expect((await getStoreFacts(t.db, "en")).deliveryVaries).toBe(false);
  });

  it("state the return window from settings, including a closed window", async () => {
    expect((await policy("returns", "en"))!.facts).toEqual([{ kind: "return_window", days: settingDefault("returns.window_days") }]);
    await setSettingRow("returns.window_days", 14);
    const returns = (await policy("returns", "en"))!;
    expect(joined(returns)).toContain("within 14 days of receiving it");
    expect(joined((await policy("returns", "ar"))!)).toContain("14 يوماً");
    await setSettingRow("returns.window_days", 0);
    const closed = (await policy("returns", "en"))!;
    expect(joined(closed)).toContain("aren't available");
    expect(closed.facts).toEqual([{ kind: "return_window", days: 0 }]);
  });

  it("list only the payment methods that are switched on, with the card and Zain Cash numbers from settings", async () => {
    const card = settingDefault("payments.bank_transfer");
    let payment = (await policy("payment", "en"))!;
    expect(joined(payment)).toContain(card.account_number);
    expect(joined(payment)).toContain(card.recipient_name);
    expect(joined(payment)).toContain("0771 906 1852");
    expect(payment.facts[0]).toEqual({ kind: "payment_methods", methods: ["cod", "wallet", "card", "zaincash"] });

    await setSettingRow("payments.zaincash", { enabled: false, number: "07719061852" });
    await setSettingRow("checkout.transfer_proof_hours", 48);
    payment = (await policy("payment", "en"))!;
    expect(joined(payment)).not.toContain("0771 906 1852");
    expect(joined(payment)).toContain("48 hours");
    expect(payment.facts).toContainEqual({ kind: "proof_window", hours: 48 });

    await setSettingRow("payments.bank_transfer", { ...card, enabled: false });
    payment = (await policy("payment", "en"))!;
    expect(joined(payment)).not.toContain(card.account_number);
    expect(payment.blocks.some((block) => block.type === "steps")).toBe(false);
    expect(payment.facts.map((fact) => fact.kind)).toEqual(["payment_methods"]);
    // the delivery policy no longer talks about checking transfer photos
    expect(joined((await policy("shipping", "en"))!)).not.toContain("transfer photo");

    for (const key of ["payments.cod", "payments.wallet"] as const) await setSettingRow(key, { enabled: false });
    payment = (await policy("payment", "en"))!;
    expect(joined(payment)).toContain("No payment method is switched on");
    expect(payment.facts).toEqual([{ kind: "payment_methods", methods: [] }]);
  });

  it("state the warranty as a fact or a question — never invent the store's terms or a maker's warranty for every product", async () => {
    for (const locale of LOCALE_CODES) {
      const warranty = (await policy("warranty", locale))!;
      expect(warranty.blocks[0]).toMatchObject({ type: "callout", tone: "info" });
      // v2 §9.6, §13 #4: where the maker's warranty is written (when known), where a used unit's is, then ask us
      expect(warranty.facts.map((fact) => fact.kind)).toEqual(["maker_warranty", "used_warranty", "store_warranty_pending"]);
    }
    const en = joined((await policy("warranty", "en"))!);
    // the store's own terms are the owner's to set (STATUS open item 15): the page asks, it does not decide them
    expect(en).toContain("Ask us about the store's warranty terms");
    expect(en).not.toMatch(/gives no warranty|the maker's warranty applies/i);
    // the maker's warranty only where it is known (a grey import may carry none in Iraq)
    expect(en).toContain("when we know it");
    expect(en).toContain("That warranty is not the store's warranty");
    const ar = joined((await policy("warranty", "ar"))!);
    expect(ar).toContain("اسألنا عن شروط ضمان المتجر");
    expect(ar).not.toMatch(/لا يقدّم المتجر|يسري عليها ضمان/);
    // and nothing in the catalogue claims a store warranty while the owner has not decided one
    expect(await rows("SELECT id FROM products WHERE warranty_months IS NOT NULL")).toEqual([]);
  });

  it("name every cookie the storefront sets, and the retention windows the daily job applies", async () => {
    const privacy = (await policy("privacy", "en"))!;
    const cookies = privacy.blocks.find((block): block is Extract<Block, { type: "table" }> => block.type === "table")!;
    expect(cookies.rows.map((row) => visible(row[0]))).toEqual(PRIVACY_COOKIES.map((cookie) => cookie.name));
    const lifetime = (name: string) => visible(cookies.rows.find((row) => visible(row[0]) === name)![2]);
    expect(lifetime("tt_prefs")).toBe("1 year");
    expect(lifetime(CART_COOKIE)).toBe("60 days");
    expect(lifetime(CUSTOMER_COOKIE)).toBe(`${CUSTOMER_SESSION_DAYS} days from your last visit`);
    expect(lifetime("tt_tradein")).toBe("2 days");
    const text = joined(privacy);
    expect(text).toContain(`${RETENTION_DAYS.authEvents} days`);
    expect(text).toContain(`${RETENTION_DAYS.sessions} days`);
    expect(text).toContain(`${RETENTION_DAYS.otpCodes} days`);
    expect(text).toContain(`after ${RECOMMENDATION_EVENT_RETENTION_DAYS} days`);
  });

  it("mirror the other areas' cookie names and lifetimes exactly (a change there must update the privacy draft)", () => {
    const byName = new Map(PRIVACY_COOKIES.map((cookie) => [cookie.name, cookie.days]));
    const days = (seconds: number) => seconds / 86_400;
    expect(byName.get(WISH_COOKIE)).toBe(days(WISH_COOKIE_MAX_AGE_SEC));
    expect(byName.get(TRADE_IN_DRAFT_COOKIE)).toBe(days(TRADE_IN_DRAFT_MAX_AGE_SEC));
    expect(byName.get(INTRO_COOKIE)).toBe(days(PREF_MAX_AGE_SEC));
    expect(byName.get(PLATFORMS_COOKIE)).toBe(days(PREF_MAX_AGE_SEC));
    expect(byName.get(CONSENT_COOKIE)).toBe(days(CONSENT_COOKIE_MAX_AGE_SEC));
    expect(byName.get(REC_SESSION_COOKIE)).toBe(days(REC_SESSION_MAX_AGE_SEC));
    expect(PRIVACY_STORAGE_DAYS).toEqual({ recentlyViewed: HOME_RECENT_DAYS, recentSearches: SEARCH_RECENT_DAYS, recommendationSignals: RECOMMENDATION_EVENT_RETENTION_DAYS });
  });

  it("carry the demo notice in the terms only while the store is in demo mode", async () => {
    const demo = (await policy("terms", "en", { storeMode: "demo" }))!;
    const live = (await policy("terms", "en", { storeMode: "live" }))!;
    // the glossary term (v2 §9): «متجر تجريبي» / "Demo store"
    expect(demo.blocks[0]).toMatchObject({ type: "callout", title: "Demo store" });
    expect(live.blocks.some((block) => block.type === "callout" && block.title === "Demo store")).toBe(false);
    expect(live.facts).toContainEqual({ kind: "estimate_valid", days: settingDefault("tradein.estimate_valid_days") });
  });

  it("can be exported in all three languages for the admin's 'start from the draft'", async () => {
    const draft = await getPolicyDraftL10n(t.db, "returns");
    expect(Object.keys(draft.title).sort()).toEqual([...LOCALE_CODES].sort());
    expect(shape(draft.body.en)).toEqual(shape(draft.body.ar));
    expect(shape(draft.body.ckb)).toEqual(shape(draft.body.ar));
  });
});

// ───────────────────────────────────────────────────────────────── CMS

describe("policies from the CMS", () => {
  const body = (text: string): LocalizedBlocks => ({ ar: [{ type: "h2", text: `${text} ar` }, { type: "p", text: "نص" }], en: [{ type: "p", text: `${text} en` }] });
  const insertPage = async (id: string, values: Partial<typeof pages.$inferInsert>) => {
    await t.db.insert(pages).values({ id, slug: "returns", kind: "policy", title: { ar: "سياسة معتمدة", en: "Approved policy" }, body: body("approved"), status: "published", publishedAt: NOW - 86_400_000, createdAt: NOW - 90_000_000, updatedAt: NOW - 86_400_000, ...values });
  };
  const clear = () => t.db.delete(pages).where(inArray(pages.kind, ["policy", "about", "contact"]));
  beforeEach(clear);
  afterAll(clear);

  it("an approved page replaces the draft and turns the draft notice off", async () => {
    await insertPage("pg_c_1", { seo: { description: { ar: "وصف", en: "A summary" } } });
    const en = (await policy("returns", "en"))!;
    expect(en).toMatchObject({ source: "cms", approved: true, noindex: false, title: "Approved policy", summary: "A summary", textLocale: "en", updatedAt: NOW - 86_400_000 });
    expect(joined(en)).toBe("approved en");
    // the live facts stay, whatever the text says
    expect(en.facts).toEqual([{ kind: "return_window", days: settingDefault("returns.window_days") }]);
    // no Kurdish text: shown in Arabic, and the page says so (textLocale)
    const ckb = (await policy("returns", "ckb"))!;
    expect(ckb).toMatchObject({ approved: true, textLocale: "ar", title: "سياسة معتمدة" });
    expect(textOf(ckb.blocks)[0]).toBe("approved ar");
    // the index knows it is approved
    const list = await listPolicies(t.db, "en", { now: NOW });
    expect(list.map((item) => item.slug)).toEqual([...POLICY_SLUGS]);
    expect(list.find((item) => item.slug === "returns")).toMatchObject({ approved: true, title: "Approved policy" });
    expect(list.filter((item) => item.approved).map((item) => item.slug)).toEqual(["returns"]);
  });

  it("an unpublished, demo, expired, not-yet-due or unreadable page does not count", async () => {
    const cases: [string, Partial<typeof pages.$inferInsert>][] = [
      ["draft status", { status: "draft" }],
      ["archived", { status: "archived" }],
      ["demo row", { isDemo: true }],
      ["ended", { endsAt: NOW - 1 }],
      ["starts later", { startsAt: NOW + 60_000 }],
      ["scheduled, not due", { status: "scheduled", startsAt: NOW + 60_000 }],
      ["no readable Arabic blocks", { body: { ar: [{ type: "p" }], en: [{ type: "p", text: "only English" }] } as never }],
    ];
    for (const [label, values] of cases) {
      await clear();
      await insertPage(`pg_c_${label.replace(/\W/g, "_")}`, values);
      const view = (await policy("returns", "en"))!;
      expect(view.source, label).toBe("draft");
      expect(view.approved, label).toBe(false);
    }
    await clear();
    await insertPage("pg_c_due", { status: "scheduled", startsAt: NOW - 1 });
    expect((await policy("returns", "en"))!.approved).toBe(true);
  });

  it("a policy the owner added under a new slug is served and listed; unknown or malformed slugs are not", async () => {
    await insertPage("pg_c_cookies", { slug: "cookies", title: { ar: "ملفات تعريف الارتباط" } });
    const cookies = (await policy("cookies", "en"))!;
    expect(cookies).toMatchObject({ slug: "cookies", approved: true, facts: [], textLocale: "en" });
    expect((await listPolicies(t.db, "en", { now: NOW })).at(-1)).toMatchObject({ slug: "cookies", approved: true, icon: "file-text" });
    expect(await policy("refund-terms", "en")).toBeNull();
    for (const bad of ["Shipping", "../terms", "", "a b", "x".repeat(81)]) expect(await policy(bad, "en"), bad).toBeNull();
  });

  it("about and contact pages from the CMS are read the same way", async () => {
    expect(await getCmsText(t.db, "en", "about", { now: NOW })).toBeNull();
    await insertPage("pg_c_about", { slug: "about", kind: "about", title: { ar: "عن المتجر", en: "About the shop" } });
    expect(await getCmsText(t.db, "en", "about", { now: NOW })).toMatchObject({ title: "About the shop", textLocale: "en" });
    expect(await getCmsText(t.db, "en", "contact", { now: NOW })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── contact

describe("contact details", () => {
  beforeEach(resetSettings);

  it("are empty — and the card is null, so the page leads with «اكتب لموظف» — until the owner fills them in", async () => {
    expect(await getContactDetails(t.db, "ar")).toEqual({ channels: [], address: null, hours: null, card: null, isEmpty: true });
  });

  it("show only what the owner filled in, ready to call, message or open", async () => {
    await setSettingRow("store.contact", {
      phone: "07701234567",
      whatsapp: "0780 123 4567",
      email: "help@example.com",
      instagram: "https://www.instagram.com/tamtam.example/",
      map_url: "https://maps.example.com/place/1",
      address: { ar: "بغداد، الكرادة", en: "Karrada, Baghdad" },
      hours: { ar: "كل يوم 10–22" },
    });
    const en = await getContactDetails(t.db, "en");
    expect(en.isEmpty).toBe(false);
    expect(en.channels).toEqual([
      { kind: "phone", value: "0770 123 4567", href: "tel:+9647701234567", external: false },
      { kind: "whatsapp", value: "0780 123 4567", href: "https://wa.me/9647801234567", external: true },
      { kind: "email", value: "help@example.com", href: "mailto:help@example.com", external: false },
      { kind: "instagram", value: "instagram.com/tamtam.example", href: "https://www.instagram.com/tamtam.example/", external: true },
      { kind: "map", value: "maps.example.com/place/1", href: "https://maps.example.com/place/1", external: true },
    ]);
    expect(en.address).toBe("Karrada, Baghdad");
    expect(en.hours).toBe("كل يوم 10–22"); // no English hours: the Arabic source
    // the kit's <ContactCard> shape: WhatsApp as international digits, the phone in E.164, the owner's words for the
    // hours and no schedule (so no invented open / closed state); the e-mail address and the store's pages elsewhere by
    // their sites' names (the kit's `email` / `links`, drawn by the card itself since wave G)
    expect(en.card).toEqual({
      whatsapp: "9647801234567",
      phone: "+9647701234567",
      address: "Karrada, Baghdad",
      mapsUrl: "https://maps.example.com/place/1",
      hours: null,
      hoursText: "كل يوم 10–22",
      replyTime: null,
      email: "help@example.com",
      links: [{ label: "Instagram", url: "https://www.instagram.com/tamtam.example/" }],
    });
    expect(contactView({ address: { ar: "الموصل" } }, "ckb")).toEqual({
      channels: [],
      address: "الموصل",
      hours: null,
      card: { whatsapp: null, phone: null, address: "الموصل", mapsUrl: null, hours: null, hoursText: null, replyTime: null, email: null, links: [] },
      isEmpty: false,
    });
    // only social pages: the card draws them (its `links`); nothing else is invented
    expect(contactView({ instagram: "https://instagram.com/x" }, "en")).toMatchObject({ card: { whatsapp: null, phone: null, address: null, email: null, links: [{ label: "Instagram", url: "https://instagram.com/x" }] }, isEmpty: false });
  });
});

// ───────────────────────────────────────────────────────────────── sitemap and robots

describe("sitemap", () => {
  const FIX = { draft: "prd_c_draft", archived: "prd_c_archived", inactive: "prd_c_inactive", noindex: "prd_c_noindex" };
  beforeAll(async () => {
    const product = (id: string, slug: string, extra: Partial<typeof products.$inferInsert>) =>
      t.db.insert(products).values({ id, slug, kind: "accessory", name: { ar: "اختبار" }, status: "published", createdAt: NOW, updatedAt: NOW, ...extra });
    await product(FIX.draft, "zz-content-draft", { status: "draft" });
    await product(FIX.archived, "zz-content-archived", { status: "archived" });
    await product(FIX.inactive, "zz-content-inactive", {});
    await product(FIX.noindex, "zz-content-noindex", { seo: { noindex: true } });
    await t.db.insert(variants).values([
      { id: "var_c_draft", productId: FIX.draft, sku: "ZZ-C-DRAFT", priceIqd: 1_000, isDefault: true },
      { id: "var_c_archived", productId: FIX.archived, sku: "ZZ-C-ARCH", priceIqd: 1_000, isDefault: true },
      { id: "var_c_inactive", productId: FIX.inactive, sku: "ZZ-C-INACT", priceIqd: 1_000, isDefault: true, isActive: false },
      { id: "var_c_noindex", productId: FIX.noindex, sku: "ZZ-C-NOIDX", priceIqd: 1_000, isDefault: true },
    ]);
    await t.db.insert(knowledgeArticles).values([
      { id: "ka_c_internal", slug: "zz-content-internal", kind: "guide", title: { ar: "داخلي" }, body: { ar: [] }, audience: "internal", status: "approved", updatedAt: NOW },
      { id: "ka_c_draft", slug: "zz-content-draft-article", kind: "guide", title: { ar: "مسودة" }, body: { ar: [] }, audience: "public", status: "draft", updatedAt: NOW },
    ]);
  });

  let entries: SitemapEntry[];
  beforeEach(async () => {
    entries = await getSitemapEntries(t.db, NOW);
  });
  const paths = () => new Set(entries.map((entry) => entry.path));

  it("lists every product the catalogue lists, and no other", async () => {
    const listed = await rows<{ slug: string }>(
      "SELECT p.slug FROM products p WHERE p.status = 'published' AND EXISTS (SELECT 1 FROM variants v WHERE v.product_id = p.id AND v.is_active = 1) AND p.id <> ? ORDER BY p.slug",
      FIX.noindex,
    );
    expect(listed.length).toBeGreaterThan(50);
    const productPaths = entries.filter((entry) => entry.path.startsWith("/p/")).map((entry) => entry.path).sort();
    expect(productPaths).toEqual(listed.map((row) => `/p/${row.slug}`).sort());
    for (const slug of ["zz-content-draft", "zz-content-archived", "zz-content-inactive", "zz-content-noindex"]) expect(paths().has(`/p/${slug}`), slug).toBe(false);
    expect(entries.find((entry) => entry.path.startsWith("/p/"))?.lastmod).toBeTypeOf("number");
  });

  it("lists listed used units, approved public articles, published devices on active platforms, platforms and categories in use", async () => {
    const used = await rows<{ slug: string }>("SELECT slug FROM used_units WHERE status = 'listed'");
    const notListed = await rows<{ slug: string }>("SELECT slug FROM used_units WHERE status <> 'listed'");
    for (const unit of used) expect(paths().has(`/used/${unit.slug}`)).toBe(true);
    for (const unit of notListed) expect(paths().has(`/used/${unit.slug}`)).toBe(false);

    const articles = await rows<{ slug: string }>("SELECT slug FROM knowledge_articles WHERE status = 'approved' AND audience = 'public'");
    expect(entries.filter((entry) => entry.path.startsWith("/support/article/")).map((entry) => entry.path).sort()).toEqual(articles.map((row) => `/support/article/${row.slug}`).sort());

    const devices = await rows<{ slug: string }>("SELECT d.slug FROM device_models d JOIN platforms p ON p.id = d.platform_id WHERE d.status = 'published' AND p.is_active = 1");
    const offPlatform = await rows<{ slug: string }>("SELECT d.slug FROM device_models d JOIN platforms p ON p.id = d.platform_id WHERE p.is_active = 0");
    expect(entries.filter((entry) => entry.path.startsWith("/device/")).map((entry) => entry.path).sort()).toEqual(devices.map((row) => `/device/${row.slug}`).sort());
    for (const device of offPlatform) expect(paths().has(`/device/${device.slug}`)).toBe(false);

    const activePlatforms = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 1");
    const inactivePlatforms = await rows<{ slug: string }>("SELECT slug FROM platforms WHERE is_active = 0");
    for (const platform of activePlatforms) expect(paths().has(`/platform/${platform.slug}`), platform.slug).toBe(true);
    for (const platform of inactivePlatforms) expect(paths().has(`/platform/${platform.slug}`)).toBe(false);

    const categoryPaths = entries.filter((entry) => entry.path.startsWith("/c/"));
    expect(categoryPaths.length).toBeGreaterThan(3);
    for (const { path } of categoryPaths) {
      const [row] = await rows<{ is_active: number }>("SELECT is_active FROM categories WHERE slug = ?", path.slice(3));
      expect(row?.is_active, path).toBe(1);
    }
  });

  it("follows the catalogue: a deactivated category and an unlisted unit disappear", async () => {
    const category = entries.find((entry) => entry.path.startsWith("/c/"))!.path.slice(3);
    const unit = entries.find((entry) => entry.path.startsWith("/used/"))!.path.slice(6);
    await t.db.update(categories).set({ isActive: false }).where(eq(categories.slug, category));
    await t.db.update(usedUnits).set({ status: "reserved" }).where(eq(usedUnits.slug, unit));
    try {
      const after = new Set((await getSitemapEntries(t.db, NOW)).map((entry) => entry.path));
      expect(after.has(`/c/${category}`)).toBe(false);
      expect(after.has(`/used/${unit}`)).toBe(false);
    } finally {
      await t.db.update(categories).set({ isActive: true }).where(eq(categories.slug, category));
      await t.db.update(usedUnits).set({ status: "listed" }).where(eq(usedUnits.slug, unit));
    }
  });

  it("lists the static pages, approved policies only, and every path once", async () => {
    for (const path of ["/", "/used", "/trade-in", "/support", "/policies", "/about", "/contact", "/accessibility"]) expect(paths().has(path), path).toBe(true);
    expect(entries.some((entry) => entry.path.startsWith("/policies/"))).toBe(false); // all drafts
    await t.db.insert(pages).values({ id: "pg_c_sitemap", slug: "privacy", kind: "policy", title: { ar: "الخصوصية" }, body: { ar: [{ type: "p", text: "نص" }] }, status: "published", publishedAt: NOW - 1000, createdAt: NOW, updatedAt: NOW });
    try {
      const after = await getSitemapEntries(t.db, NOW);
      expect(after.filter((entry) => entry.path.startsWith("/policies/"))).toEqual([{ path: "/policies/privacy", lastmod: NOW - 1000 }]);
    } finally {
      await t.db.delete(pages).where(eq(pages.id, "pg_c_sitemap"));
    }
    expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
    for (const { path } of entries) expect(path).toMatch(/^\/[a-z0-9/._-]*$/);
  });

  it("writes every page in three languages with hreflang alternates and x-default", () => {
    const sample: SitemapEntry[] = [
      { path: "/", lastmod: null },
      { path: "/p/ps5-pro", lastmod: Date.UTC(2026, 10, 1) },
      { path: "/c/a&b", lastmod: null },
    ];
    const xml = buildSitemapXml(sample, "https://tamtamgames.com/");
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">')).toBe(true);
    expect(xml.match(/<url>/g)).toHaveLength(9);
    expect(xml.match(/<xhtml:link /g)).toHaveLength(36);
    for (const loc of ["https://tamtamgames.com/", "https://tamtamgames.com/en", "https://tamtamgames.com/ckb", "https://tamtamgames.com/en/p/ps5-pro", "https://tamtamgames.com/ckb/c/a&amp;b"]) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="ckb-IQ" href="https://tamtamgames.com/ckb/p/ps5-pro"/>');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://tamtamgames.com/p/ps5-pro"/>');
    expect(xml.match(/<lastmod>2026-11-01T00:00:00\.000Z<\/lastmod>/g)).toHaveLength(3);
    expect(xml).not.toContain("a&b");
  });
});

describe("robots.txt", () => {
  it("closes everything outside a live store on its canonical host", () => {
    expect(robotsIndexable({ storeMode: "demo", requestOrigin: "https://tamtamgames.com", publicOrigin: "https://tamtamgames.com" })).toBe(false);
    expect(robotsIndexable({ storeMode: "live", requestOrigin: "https://tamtam-games.example.workers.dev", publicOrigin: "https://tamtam-games.example.workers.dev" })).toBe(false);
    expect(robotsIndexable({ storeMode: "live", requestOrigin: "https://staging.example.com", publicOrigin: "https://tamtamgames.com" })).toBe(false);
    expect(robotsIndexable({ storeMode: "live", requestOrigin: "not a url", publicOrigin: "https://tamtamgames.com" })).toBe(false);
    expect(robotsIndexable({ storeMode: "live", requestOrigin: "https://tamtamgames.com", publicOrigin: "https://tamtamgames.com" })).toBe(true);

    const closed = buildRobotsTxt({ indexable: false, origin: "https://tamtamgames.com" });
    expect(closed.split("\n")).toEqual(expect.arrayContaining(["User-agent: *", "Disallow: /", "Disallow: /admin", "Disallow: /api/"]));
    expect(closed).not.toContain("Allow: /\n");
    expect(closed).not.toContain("Sitemap:");
  });

  it("opens a live store, keeps admin, API and private pages closed in every language, and names the sitemap", () => {
    const open = buildRobotsTxt({ indexable: true, origin: "https://tamtamgames.com/" }).split("\n");
    expect(open).toContain("Allow: /");
    expect(open).not.toContain("Disallow: /");
    for (const line of ["Disallow: /admin", "Disallow: /api/", "Disallow: /cart", "Disallow: /en/cart", "Disallow: /ckb/checkout", "Disallow: /order/", "Disallow: /en/account", "Disallow: /ckb/trade-in/"]) {
      expect(open, line).toContain(line);
    }
    // the public trade-in page itself stays open: only /trade-in/<ref> follow-up pages are closed
    expect(open).not.toContain("Disallow: /trade-in");
    expect(open).toContain("Sitemap: https://tamtamgames.com/sitemap.xml");
  });

  it("uses PUBLIC_ORIGIN when it is a URL, else the request's origin", () => {
    expect(resolvePublicOrigin("https://tamtamgames.com/", "http://localhost:5173")).toBe("https://tamtamgames.com");
    expect(resolvePublicOrigin("not a url", "http://localhost:5173")).toBe("http://localhost:5173");
    expect(resolvePublicOrigin(undefined, "http://localhost:5173")).toBe("http://localhost:5173");
    expect(resolvePublicOrigin("ftp://x.example", "http://localhost:5173")).toBe("http://localhost:5173");
  });
});

// ───────────────────────────────────────────────────────────────── strings

describe("the pages' ways to reach a person (v2 §6.15)", () => {
  it("/about lists /contact only once a channel exists, and never repeats the «اكتب لموظف» card above the list", () => {
    // no channel: the aside's hand-off card is the way to a person, so «اعرف أكثر» does not offer it a second time
    expect(aboutLinks(false)).toEqual(["policies", "accessibility"]);
    expect(aboutLinks(true)).toEqual(["policies", "contact", "accessibility"]);
  });

  it("/contact without a channel does not ask the shopper to choose a way — there is one, the hand-off", () => {
    const lead = (locale: Locale) => (contentStrings as Record<Locale, { contact: { lead: string; leadHandoff: string } }>)[locale].contact;
    for (const locale of LOCALE_CODES) {
      expect(lead(locale).leadHandoff, locale).toBeTruthy();
      expect(lead(locale).leadHandoff, locale).not.toBe(lead(locale).lead);
    }
    expect(lead("ar").leadHandoff).not.toMatch(/اختر|الطريقة الأسهل/);
    expect(lead("en").leadHandoff).not.toMatch(/pick|choose|whichever/i);
  });
});

describe("strings sent to the browser", () => {
  it("are the content namespace without the policy drafts", () => {
    for (const locale of LOCALE_CODES) {
      const tree = contentMessages(locale).content as Record<string, unknown>;
      expect(tree.drafts).toBeUndefined();
      expect(Object.keys(tree).sort()).toEqual(["a11y", "about", "common", "contact", "facts", "handoff", "index", "links", "pay", "units"]);
    }
  });
});

describe("copy (Design System v2 §9)", () => {
  /** Every string of a language, page copy and drafts, with the bidi isolation marks removed. */
  const strings = (locale: Locale): string[] => {
    const out: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === "string") out.push(visible(node));
      else if (node && typeof node === "object") for (const value of Object.values(node)) walk(value);
    };
    walk((contentStrings as Record<Locale, unknown>)[locale]);
    return out;
  };

  it("promises no call, makes no «دورك.» joke and says no «قريباً» about contact details, in any language", () => {
    const ar = strings("ar").join("\n");
    expect(ar).not.toMatch(/نتصل|سنتصل|نتواصل معك|دورك/);
    expect(ar).not.toMatch(/بيانات التواصل قريباً/);
    expect(strings("en").join("\n")).not.toMatch(/\bcall you\b|we call|get in touch|coming soon/i);
    expect(strings("ckb").join("\n")).not.toMatch(/پەیوەندیت پێوە دەکەین|بەم زووانە/);
  });

  it("has no builder's voice: no draft tags, no «awaiting the owner», one term per concept", () => {
    const ar = strings("ar").join("\n");
    // «مسودة» tags and the owner's approval are gone from shopper copy (the status line is «نسخة أولى»)
    expect(ar).not.toMatch(/مسودة|صاحب المتجر|بانتظار قرار/);
    expect(strings("en").join("\n")).not.toMatch(/\bdraft\b|store owner|awaiting the/i);
    // glossary: the phone field is «رقم الموبايل», the support area «مركز الدعم», human help «تحدّث مع موظف»
    expect(ar).not.toMatch(/رقم الهاتف|رقم هاتف|مركز المساعدة|المساعدة والصيانة|تحدّث مع شخص/);
    expect(strings("en").join("\n")).not.toMatch(/phone number|help centre/i);
    expect(ar).toContain("تحدّث مع موظف");
    expect(ar).toContain("نسخة أولى — قد تتغيّر قبل الإطلاق.");
  });
});
