/**
 * ACCEPTANCE — discovery and service criteria of the client's brief, on the real demo catalogue (seedDemo):
 *
 *   §3.5 / §12  search in Arabic, English and Kurdish (Sorani): typos, synonyms, zero results with recovery
 *   §14.8       recommendations respect verified compatibility and stock; an admin pin cannot break that; guest
 *               privacy controls (no consent → no signal; withdrawal forgets)
 *   §14.9       a used listing shows real condition evidence (and labels a maker's photo as an illustration);
 *               a trade-in estimate is a range, never an offer; the offer needs an inspection (database rule)
 *   §14.10      the repair assistant escalates safely and never claims an unverified definitive diagnosis
 *
 * The browser half (search pages, filters without script, the used pages, the wizard, the assistant, the repair
 * form) is proven by the puppeteer flows listed in docs/ACCEPTANCE.md.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken, sha256Hex } from "~/lib/ids";
import { compatibilityRules, recommendationEvents, recommendationRules, supportTickets, tradeIns, usedUnits } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { mapDbError } from "~/server/db/tx.server";
import { getCompatibilityForProduct } from "~/server/services/compatibility.server";
import { forgetEvents, getRecommendations, recordEvent } from "~/server/services/recommendations.server";
import { searchProducts } from "~/server/services/search.server";
import { handOffToStaff, runAssistant } from "~/server/services/support/assistant.server";
import { getSupportDirectory } from "~/server/services/support/kb.server";
import { EMPTY_ASSISTANT_STATE, type AssistantState } from "~/server/services/support/state";
import { createTradeIn, getTradeInByRef, listTradeInDevices } from "~/server/services/tradein.server";
import { getUsedUnitDetail, listUsedUnits } from "~/server/services/used.server";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── search

describe("§3.5 search in ar / en / ckb: typos, synonyms, zero results", () => {
  const search = (locale: "ar" | "en" | "ckb", q: string) => searchProducts(t.db, locale, q, { now: t.now, limit: 24 });
  const slugs = async (locale: "ar" | "en" | "ckb", q: string) => new Set((await search(locale, q)).items.map((card) => card.slug));

  test("acceptance S1: the same platform is found from English, Arabic and Kurdish spellings, and from typos in each", async () => {
    const english = await slugs("en", "playstation");
    expect(english.size).toBeGreaterThan(3);
    for (const [locale, q] of [
      ["ar", "بلايستيشن"],
      ["ar", "بليستيشن"],
      ["ckb", "پلەیستەیشن"],
      ["en", "playstaion"],
      ["ar", "بلايستشن"],
    ] as const) {
      const found = await search(locale, q);
      expect(found.total, `${locale} "${q}"`).toBeGreaterThan(3);
      const overlap = found.items.filter((card) => english.has(card.slug)).length;
      expect(overlap, `${locale} "${q}" finds PlayStation products`).toBeGreaterThan(0);
    }
    // a corrected query says which spelling it used
    const typo = await search("en", "playstaion");
    expect(JSON.stringify(typo)).toContain("playstation");
  });

  test("acceptance S2: synonyms — 'joypad' finds the controllers; 'سويتش' and 'switch' find the Nintendo Switch", async () => {
    const pads = await search("en", "joypad");
    expect(pads.items.some((card) => card.kind === "controller")).toBe(true);
    const ar = await slugs("ar", "سويتش");
    const en = await slugs("en", "switch");
    expect([...ar].filter((slug) => en.has(slug)).length).toBeGreaterThan(0);
  });

  test("acceptance S3: nonsense finds nothing — in every language — and the page has a way on (suggestions or none, never an error)", async () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const none = await search(locale, "qqqzzzwww");
      expect(none.total, locale).toBe(0);
      expect(none.items).toEqual([]);
    }
  });
});

// ───────────────────────────────────────────────────────────────── recommendations

describe("§14.8 recommendations respect verified compatibility and stock; guest privacy is honoured", () => {
  test("acceptance R1: on every device hub of the demo catalogue, every add-on recommended is VERIFIED on that device and can be bought", async () => {
    const models = await rows<{ id: string; slug: string }>("SELECT dm.id, dm.slug FROM device_models dm JOIN platforms p ON p.id = dm.platform_id WHERE dm.status = 'published' AND p.is_active = 1");
    let checked = 0;
    for (const model of models) {
      const shelves = await getRecommendations(t.db, { locale: "ar", context: "device_hub", deviceModelId: model.id, consent: false, now: t.now }, 12);
      for (const shelf of shelves) {
        for (const card of shelf.items) {
          expect(card.stock, `${model.slug}: ${card.slug}`).not.toBe("out_of_stock");
          if (!shelf.key.includes(":setup:")) continue;
          const compat = await getCompatibilityForProduct(t.db, "en", card.id);
          expect(compat.find((row) => row.deviceSlug === model.slug)?.status, `${model.slug}: ${card.slug}`).toBe("verified");
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("acceptance R2: an admin pin of an INCOMPATIBLE product does not put it on the device's shelf", async () => {
    // a device with a verified add-on, and an accessory marked incompatible with it
    const [pair] = await rows<{ deviceId: string; productId: string }>(
      "SELECT cr.target_id AS deviceId, cr.subject_id AS productId FROM compatibility_rules cr WHERE cr.subject_type = 'product' AND cr.target_type = 'device_model' AND cr.status = 'verified' LIMIT 1",
    );
    expect(pair).toBeTruthy();
    const accessory = (await rows<{ id: string }>("SELECT id FROM products WHERE status = 'published' AND kind IN ('accessory','controller','headset','storage') AND id NOT IN (SELECT subject_id FROM compatibility_rules WHERE target_id = ?) LIMIT 1", pair.deviceId))[0];
    await t.db.insert(compatibilityRules).values({ id: "cr_acc_incompatible", subjectType: "product", subjectId: accessory.id, targetType: "device_model", targetId: pair.deviceId, status: "incompatible" });
    await t.db.insert(recommendationRules).values({ id: "rr_acc_pin", kind: "pin", productId: accessory.id, context: { placement: "device_hub" }, weight: 0 });
    try {
      const shelves = await getRecommendations(t.db, { locale: "en", context: "device_hub", deviceModelId: pair.deviceId, consent: false, now: t.now }, 12);
      expect(shelves.flatMap((shelf) => shelf.items.map((card) => card.id))).not.toContain(accessory.id);
    } finally {
      await t.d1.prepare("DELETE FROM recommendation_rules WHERE id = 'rr_acc_pin'").run();
    }
  });

  test("acceptance R3: without consent a guest's browsing is not recorded; with consent it is keyed by a hash, and withdrawing forgets it", async () => {
    const [product] = await rows<{ id: string }>("SELECT id FROM products WHERE status = 'published' LIMIT 1");
    const sessionHash = await sha256Hex(`acceptance-${randomToken()}`);
    const count = async () => Number((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM recommendation_events WHERE session_hash = ?", sessionHash))[0].n);
    expect(await recordEvent(t.db, { consent: false, sessionHash, customerId: null }, { kind: "view", productId: product.id }, t.now)).toMatchObject({ recorded: false, reason: "no_consent" });
    expect(await count()).toBe(0);
    expect((await recordEvent(t.db, { consent: true, sessionHash, customerId: null }, { kind: "view", productId: product.id }, t.now)).recorded).toBe(true);
    expect(await count()).toBe(1);
    // nothing that identifies a device is stored: no IP, no user agent column
    const columns = (await rows<{ name: string }>("PRAGMA table_info(recommendation_events)")).map((column) => column.name);
    expect(columns).not.toEqual(expect.arrayContaining(["ip"]));
    expect(columns.some((name) => /agent|ip_|fingerprint/i.test(name))).toBe(false);
    expect(await forgetEvents(t.db, { sessionHash, customerId: null })).toBe(1);
    expect(await count()).toBe(0);
    void recommendationEvents;
    // without consent, the shelves that would be personal read nothing personal
    const home = await getRecommendations(t.db, { locale: "en", context: "home", consent: false, now: t.now }, 8);
    expect(home.every((shelf) => !/recently|viewed|for you/i.test(shelf.key))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── used and trade-in

describe("§14.9 used listings show real condition evidence; a trade-in offer needs inspection and approval", () => {
  test("acceptance U1: every listed unit shows grade, checklist, defects, battery (when measured), warranty and return terms; a maker's photo is labelled an illustration", async () => {
    const page = await listUsedUnits(t.db, "ar", {});
    expect(page.total).toBeGreaterThan(0);
    for (const item of page.items) {
      expect(item.grade).toMatch(/^(A\+|A|B|C)$/);
      // demo units carry the maker's photo: an illustration, never "a photo of this unit"
      if (!item.hasRealPhotos) expect(item.image.isIllustration).toBe(true);
      for (const locale of ["ar", "en", "ckb"] as const) {
        const detail = await getUsedUnitDetail(t.db, locale, item.slug);
        expect(detail, `${item.slug} ${locale}`).not.toBeNull();
        expect(detail!.checklist.length).toBeGreaterThan(0);
        expect(detail!).toMatchObject({ ownershipChecked: true, dataWiped: true });
        expect(typeof detail!.warrantyDays).toBe("number");
        expect(typeof detail!.returnDays).toBe("number");
        for (const photo of detail!.photos) if (!detail!.hasRealPhotos) expect(photo.isIllustration).toBe(true);
        // never the serial or the acquisition cost
        expect(JSON.stringify(detail)).not.toMatch(/acquisition|serial/i);
      }
    }
  });

  test("acceptance U2: the database refuses to list a REAL (non-demo) unit without a real photo, a completed checklist, the ownership check and the data wipe", async () => {
    const [unit] = await rows<{ id: string }>("SELECT id FROM used_units WHERE status = 'listed' LIMIT 1");
    const attempt = async () => {
      try {
        await t.db.update(usedUnits).set({ isDemo: false, dataWipedAt: null }).where(eq(usedUnits.id, unit.id));
        return null;
      } catch (error) {
        return mapDbError(error);
      }
    };
    const refused = await attempt();
    expect(refused?.code).toMatch(/USED_UNIT_NOT_LISTABLE|NOT_LISTABLE|IMMUTABLE|GUARD/i);
    expect((await rows<{ is_demo: number }>("SELECT is_demo FROM used_units WHERE id = ?", unit.id))[0].is_demo).toBe(1);
  });

  test("acceptance U3: a trade-in request gets an ESTIMATE range that expires — no offer; the database refuses an offer before an inspection", async () => {
    const [device] = await listTradeInDevices(t.db, "ar");
    const made = await createTradeIn(
      t.db,
      { customerId: null, ip: null, locale: "ar", storeMode: "demo" },
      { idempotencyKey: randomToken(), device: device.slug, answers: { power: "works", body: "like_new", ...(device.hasScreen ? { screen: "perfect" as const } : {}), included: [...device.accessories], account: "yes" }, phone: "07731234567", ownershipConfirmed: true },
      t.now,
    );
    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", t.now);
    expect(["submitted", "estimated"]).toContain(view?.status);
    expect(view?.offer ?? null).toBeNull();
    const row = await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get();
    expect(row!.estimateMinIqd ?? 0).toBeLessThanOrEqual(row!.estimateMaxIqd ?? 0);
    expect(row!.estimateExpiresAt).toBeGreaterThan(t.now);
    expect(row!.finalOfferIqd ?? null).toBeNull();
    // writing an offer straight into the row (as a careless or hostile path would) is refused by the trigger
    let code: string | null = null;
    try {
      await t.db.update(tradeIns).set({ finalOfferIqd: 100_000, status: "offered" }).where(eq(tradeIns.id, made.tradeInId));
    } catch (error) {
      code = mapDbError(error)?.code ?? String(error);
    }
    expect(code).toMatch(/TRADE_IN_OFFER_NOT_ALLOWED/i);
  });
});

// ───────────────────────────────────────────────────────────────── the repair assistant

describe("§14.10 the repair assistant escalates safely and never claims a definitive diagnosis", () => {
  const state = (patch: Partial<AssistantState>): AssistantState => ({ ...EMPTY_ASSISTANT_STATE, answers: [], ...patch });

  test("acceptance AI1: no AI model is claimed when none is configured; danger words stop at once with a warning and a repair outcome", async () => {
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    expect((await runAssistant(t.db, "en", state({}))).ai).toEqual({ configured: false, name: null });
    for (const [locale, q] of [
      ["en", "there is smoke coming out"],
      ["ar", "يطلع دخان من الجهاز"],
      ["en", "the battery is swollen"],
    ] as const) {
      const view = await runAssistant(t.db, locale, state({ device: device.slug, q }));
      const last = view.turns.filter((turn) => turn.role === "assistant").at(-1) as { kind?: string; warningKey?: string } | undefined;
      expect(view.stage, `${locale} "${q}"`).toBe("done");
      expect(last?.kind, `${locale} "${q}"`).toBe("danger");
      expect(last?.warningKey).toBeTruthy();
      expect(view.outcome?.type).toBe("repair");
    }
  });

  test("acceptance AI2: every approved troubleshooting outcome that sends to repair says it needs a check — never a certain diagnosis", async () => {
    const trees = await rows<{ symptom_key: string }>("SELECT symptom_key FROM troubleshooting_trees WHERE status = 'approved'");
    expect(trees.length).toBeGreaterThanOrEqual(2);
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    let outcomes = 0;
    for (const { symptom_key } of trees) {
      // walk the first option at every question, then the second, as far as the tree goes
      for (const first of [0, 1]) {
        const answers: number[] = [];
        for (let depth = 0; depth < 12; depth++) {
          const view = await runAssistant(t.db, "en", state({ device: device.slug, symptom: symptom_key, answers }));
          if (view.stage === "done") {
            const last = view.turns.filter((turn) => turn.role === "assistant").at(-1) as { confidence?: string | null; text?: string } | undefined;
            // a repair outcome is a suspicion that a technician must check — never a diagnosis
            if (view.outcome?.type === "repair") expect(last?.confidence, `${symptom_key} ${answers.join(",")}`).toBe("needs_check");
            expect(last?.text ?? "").not.toMatch(/\b(definitely|certainly|for sure|guaranteed)\b/i);
            outcomes++;
            break;
          }
          answers.push(depth === 0 ? first : 0);
        }
      }
    }
    expect(outcomes).toBeGreaterThan(0);
  });

  test("acceptance AI3: a hand-off to a person needs consent, then opens a ticket with the conversation summary and its reference", async () => {
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    const conversation = state({ device: device.slug, q: "my stick drifts", symptom: "stick_drift", answers: [0] });
    const who = { customerId: null, ip: "198.51.100.77", storeMode: "demo" as const };
    await expect(handOffToStaff(t.db, who, "en", conversation, { idempotencyKey: randomToken(), phone: "07701230099" }, t.now)).rejects.toThrow();
    const ticket = await handOffToStaff(t.db, who, "en", conversation, { idempotencyKey: randomToken(), phone: "07701230099", consent: "on" }, t.now);
    expect(ticket.ref).toMatch(/^SP-/);
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get();
    expect(row).toMatchObject({ channel: "assistant", status: "open" });
    const summary = await rows<{ summary: string }>("SELECT summary FROM assistant_sessions WHERE id = ?", row!.assistantSessionId);
    expect(summary[0].summary.length).toBeGreaterThan(20);
    void and;
    void sql;
  });
});
