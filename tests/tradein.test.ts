/**
 * Trade-in (app/server/services/tradein.server.ts) against a real local D1 with the demo seed.
 *
 * Expectations are derived from the database (the seeded price guides and settings), not from hard-coded prices or
 * slugs: a device is chosen by its properties (a built-in screen or not, accessories in its guide or not).
 *
 * Covered: the device list (active model guides of published models, the guide never leaked; the best-case «حتى …»
 * figure equals the estimate's top) · the wizard's device search and push order · the questionnaire (which
 * questions a device gets, reading answers from a query string and back) · the estimate (grade span, guide prices,
 * deductions, rounding down to 5,000, expiry from settings; "inspection" for faults and damage; refusal for a locked
 * device) · creating a request (validation, stored estimate and history, demo flag, photos moved from the draft) ·
 * idempotency (retry, race, another phone) · rate limits · who may read a request (token, owner, reference + phone)
 * · the draft photos (private, limit, owner-only reads, removal, purge) · the shopper's answer to a final offer
 * (accept / decline, payout rules, closed and expired offers) and what the inspection found beside it (the offered
 * event's snapshot, the checklist in words, no staff-only data) · the database rule that an estimate is not an offer.
 */
import { and, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import { newId, randomToken } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { splitQualifier } from "~/routes/storefront/used/names";
import TradeIn from "~/routes/storefront/used/trade-in";
import TradeInStatus from "~/routes/storefront/used/trade-in-status";
import { loadWizard } from "~/routes/storefront/used/trade-in.server";
import { answeredQuestionSearch, filterGroups, searchText, wizardOrder } from "~/routes/storefront/used/wizard";
import { files, tradeInEvents, tradeIns } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { isDbError } from "~/server/db/tx.server";
import { isAppError } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import {
  ESTIMATE_STEP_IQD,
  TRADE_IN_LIMITS,
  TRADE_IN_PHOTO_LIMIT,
  addTradeInDraftPhoto,
  answerPairs,
  baghdadDay,
  bestCaseIqd,
  computeEstimate,
  createTradeIn,
  estimateTradeIn,
  firstUnanswered,
  getTradeInByRef,
  getTradeInDevice,
  gradeSpan,
  inspectionDays,
  listTradeInDevices,
  listTradeInDraftPhotos,
  lookupTradeIn,
  normalizeTradeInRef,
  purgeStaleTradeInDrafts,
  questionsFor,
  readTradeInAnswers,
  readTradeInDraftPhoto,
  removeTradeInDraftPhoto,
  respondToOffer,
  tradeInIdFor,
  type TradeInAnswers,
  type TradeInDevice,
  type TradeInWho,
} from "~/server/services/tradein.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures } from "./helpers/factories";

let t: TestDb;
let store: BlobStore;
let NOW: number;
let VALID_DAYS: number;

type GuideRow = { slug: string; base_iqd: number; grade_multipliers: string; deductions: string; display: string | null; device_kind: string };
let guides: GuideRow[] = [];
/** A device with a built-in screen and accessories in its guide; one without a screen; one with no accessories (if any). */
let withScreen: TradeInDevice;
let homeConsole: TradeInDevice;

const rows = async <T>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;

/** A tiny valid PNG (1×1). */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

let phoneCounter = 0;
/** A fresh, valid Iraqi mobile number for each request (the per-phone limit is per day). */
const phone = () => `0771${String(1_000_000 + ++phoneCounter).slice(-7)}`;

const who = (overrides: Partial<TradeInWho> = {}): TradeInWho => ({ customerId: null, ip: null, locale: "ar", storeMode: "demo", ...overrides });

/** Complete "best case" answers for a device. */
function bestAnswers(device: TradeInDevice): TradeInAnswers {
  const answers: TradeInAnswers = { power: "works", body: "like_new", account: "yes" };
  if (device.hasScreen) answers.screen = "perfect";
  if (device.accessories.length > 0) answers.included = [...device.accessories];
  return answers;
}

function input(device: TradeInDevice, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { idempotencyKey: randomToken(24), device: device.slug, answers: bestAnswers(device), phone: phone(), ownershipConfirmed: true, ...overrides };
}

async function expectCode(promise: Promise<unknown>, code: string, field?: string, fieldKey?: string) {
  try {
    await promise;
  } catch (error) {
    if (!isAppError(error)) throw error;
    expect(error.code).toBe(code);
    if (field) expect(error.fields?.[field]).toBe(fieldKey);
    return error;
  }
  throw new Error(`expected AppError ${code}`);
}

const floor5k = (value: number) => Math.max(0, Math.floor(value / ESTIMATE_STEP_IQD) * ESTIMATE_STEP_IQD);

beforeAll(async () => {
  t = await createTestDb();
  NOW = t.now;
  await seedDemo(t.db, NOW);
  store = kvBlobStore(t.kv);
  VALID_DAYS = await getSetting(t.db, "tradein.estimate_valid_days");
  guides = await rows<GuideRow>(
    `SELECT dm.slug, g.base_iqd, g.grade_multipliers, g.deductions, json_type(dm.specs, '$.display') AS display, dm.device_kind
       FROM trade_in_price_guides g JOIN device_models dm ON dm.id = g.device_model_id JOIN platforms p ON p.id = dm.platform_id
      WHERE g.is_active = 1 AND g.variant_id IS NULL AND dm.status = 'published' AND p.is_active = 1 ORDER BY dm.slug`,
  );
  const devices = await listTradeInDevices(t.db, "ar");
  withScreen = devices.find((device) => device.hasScreen && device.accessories.length > 0)!;
  homeConsole = devices.find((device) => !device.hasScreen && device.accessories.length > 0)!;
  expect(withScreen).toBeTruthy();
  expect(homeConsole).toBeTruthy();
});

afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── devices and questions

describe("devices the store buys", () => {
  test("exactly the published models with an active model-wide guide, without the guide itself", async () => {
    const devices = await listTradeInDevices(t.db, "ar");
    expect(devices.map((device) => device.slug).sort()).toEqual(guides.map((guide) => guide.slug).sort());
    const text = JSON.stringify(devices);
    // The guide (base price, grade multipliers, deductions) never leaves the server. The one figure that does is the
    // device tile's «حتى … · تقديري» (upToIqd, below) — the same top of the range the wizard shows for the best answers.
    expect(text).not.toMatch(/baseIqd|multiplier|deduction|guide/i);
    for (const device of devices) {
      const guide = guides.find((entry) => entry.slug === device.slug)!;
      expect(device.hasScreen).toBe(guide.device_kind === "handheld_pc" || guide.display === "object");
      const keys = Object.keys(JSON.parse(guide.deductions) as Record<string, number>).filter((key) => key.startsWith("missing_")).map((key) => key.slice(8));
      expect(device.accessories.sort()).toEqual(keys.sort());
      expect(device.image?.artKey ?? "").toMatch(/--\d+$/);
      expect(device.image?.isIllustration).toBe(true);
    }
  });

  test("each device's «حتى …» is exactly the top of the estimate for the best description (or null when unpriced)", async () => {
    const devices = await listTradeInDevices(t.db, "ar");
    for (const device of devices) {
      const best = await estimateTradeIn(t.db, "ar", device.slug, bestAnswers(device), NOW);
      expect(best?.estimate.kind === "range" ? best.estimate.maxIqd : null, device.slug).toBe(device.upToIqd);
      if (device.upToIqd !== null) expect(device.upToIqd % ESTIMATE_STEP_IQD).toBe(0);
    }
    // A guide that cannot price "like new" gives no figure.
    expect(bestCaseIqd({ id: "g", baseIqd: 300_000, multipliers: { B: 7500 }, deductions: {}, updatedAt: 0 }, { hasScreen: false, accessories: [] })).toBeNull();
    expect(bestCaseIqd({ id: "g", baseIqd: 301_234, multipliers: { "A+": 10_000, A: 9_000 }, deductions: { missing_dock: 20_000 }, updatedAt: 0 }, { hasScreen: true, accessories: ["dock"] })).toBe(300_000);
  });

  test("names follow the language; an unknown, malformed or inactive model is not a trade-in device", async () => {
    const en = await getTradeInDevice(t.db, "en", withScreen.slug);
    expect(en?.name).toBeTruthy();
    expect(await getTradeInDevice(t.db, "ar", "no-such-device")).toBeNull();
    expect(await getTradeInDevice(t.db, "ar", "Robert'); DROP TABLE x;--")).toBeNull();
    await t.d1.prepare("UPDATE trade_in_price_guides SET is_active = 0 WHERE device_model_id = (SELECT id FROM device_models WHERE slug = ?)").bind(homeConsole.slug).run();
    expect(await getTradeInDevice(t.db, "ar", homeConsole.slug)).toBeNull();
    await t.d1.prepare("UPDATE trade_in_price_guides SET is_active = 1 WHERE device_model_id = (SELECT id FROM device_models WHERE slug = ?)").bind(homeConsole.slug).run();
    expect(await getTradeInDevice(t.db, "ar", homeConsole.slug)).not.toBeNull();
  });

  test("the questions a device gets: the screen only with a screen, accessories only when its guide lists some", () => {
    expect(questionsFor(withScreen)).toEqual(["power", "body", "screen", "included", "account"]);
    expect(questionsFor(homeConsole)).toEqual(["power", "body", "included", "account"]);
    expect(questionsFor({ hasScreen: true, accessories: [] })).toEqual(["power", "body", "screen", "account"]);
  });

  test("the wizard's device search: every word in the name, slug or platform; the steps' push order", async () => {
    const devices = await listTradeInDevices(t.db, "en");
    const groups = [...new Set(devices.map((device) => device.platformSlug))].map((slug) => ({ platformSlug: slug, platformName: devices.find((device) => device.platformSlug === slug)!.platformName, devices: devices.filter((device) => device.platformSlug === slug) }));
    expect(searchText("  Nintendo Switch – OLED Model ")).toBe("nintendo switch oled model");
    expect(filterGroups(groups, "")).toEqual(groups);
    const oled = filterGroups(groups, "OLED").flatMap((group) => group.devices.map((device) => device.slug));
    expect(oled.length).toBeGreaterThan(0);
    for (const slug of oled) expect(devices.find((device) => device.slug === slug)!.name.toLowerCase()).toContain("oled");
    // Two words narrow; a platform's name finds its devices; nothing found is an empty list.
    expect(filterGroups(groups, "switch oled").flatMap((group) => group.devices).every((device) => /switch/i.test(device.name) && /oled/i.test(device.name))).toBe(true);
    expect(filterGroups(groups, "xbox").every((group) => group.platformSlug === "xbox" || group.devices.every((device) => /xbox/i.test(device.name)))).toBe(true);
    expect(filterGroups(groups, "zzzz")).toEqual([]);
    // Sideways push order: steps by tens, questions inside "condition".
    expect(wizardOrder("")).toBe(0);
    expect(wizardOrder("?step=condition&q=body")).toBe(11);
    expect(wizardOrder("?step=condition&at=power")).toBe(11);
    expect(wizardOrder("?step=estimate")).toBe(30);
  });

  test("answers travel in the query string and back; unknown values and inapplicable questions are dropped", () => {
    const answers = bestAnswers(withScreen);
    const params = new URLSearchParams(answerPairs(answers));
    expect(readTradeInAnswers(params, withScreen)).toEqual(answers);
    const noisy = new URLSearchParams("power=works&body=shiny&screen=perfect&inc=1&included=controller&included=rocket&account=maybe");
    const read = readTradeInAnswers(noisy, homeConsole);
    expect(read).toEqual({ power: "works", included: homeConsole.accessories.filter((key) => key === "controller") });
    // An empty set of check boxes is an answer ("the device alone") only with inc=1.
    expect(readTradeInAnswers(new URLSearchParams("inc=1"), homeConsole).included).toEqual([]);
    expect(readTradeInAnswers(new URLSearchParams(""), homeConsole).included).toBeUndefined();
    expect(firstUnanswered(homeConsole, { power: "works", body: "light" })).toBe("included");
    expect(firstUnanswered(homeConsole, bestAnswers(homeConsole))).toBeNull();
  });

  // Review 2026-11-12: a question's answer lived only in the NEXT step's URL, so the browser's Back showed the question
  // with nothing chosen. Before moving on, the page rewrites its history entry to answeredQuestionSearch(…).
  test("the browser's Back from a question comes back to it with its answer chosen", async () => {
    // What the «body» question's form sends: its hidden fields (earlier answers, `at`) and the choice.
    const sent: [string, string][] = [["step", "condition"], ["device", withScreen.slug], ["power", "works"], ["at", "body"], ["body", "light"]];
    const search = answeredQuestionSearch(sent, "body");
    expect(new URLSearchParams(search).getAll("at")).toEqual([]);
    expect(new URLSearchParams(search).get("q")).toBe("body");
    const back = await loadWizard(t.db, "ar", new URL(`http://tamtam.test/trade-in${search}`), null, NOW);
    expect(back.view).toMatchObject({ step: "condition", question: "body", answers: { power: "works", body: "light" }, missing: false });
    // The accessories question (check boxes) the same way, the "device alone" answer included.
    const alone = await loadWizard(t.db, "ar", new URL(`http://tamtam.test/trade-in${answeredQuestionSearch([["step", "condition"], ["device", homeConsole.slug], ["power", "works"], ["body", "light"], ["at", "included"], ["inc", "1"]], "included")}`), null, NOW);
    expect(alone.view).toMatchObject({ step: "condition", question: "included", answers: { included: [] } });
  });
});

// ───────────────────────────────────────────────────────────────── the estimate

describe("the estimate is a range from the guide — never an offer", () => {
  const guideOf = (slug: string) => {
    const row = guides.find((guide) => guide.slug === slug)!;
    return { base: row.base_iqd, multipliers: JSON.parse(row.grade_multipliers) as Record<string, number>, deductions: JSON.parse(row.deductions) as Record<string, number> };
  };

  test("description → grade span", () => {
    expect(gradeSpan({ body: "like_new" })).toEqual({ low: "A", high: "A+" });
    expect(gradeSpan({ body: "light" })).toEqual({ low: "B", high: "A" });
    expect(gradeSpan({ body: "visible" })).toEqual({ low: "C", high: "B" });
    expect(gradeSpan({ body: "like_new", screen: "scratched" })).toEqual({ low: "B", high: "A" });
    expect(gradeSpan({ body: "damaged" })).toBeNull();
    expect(gradeSpan({ body: "light", screen: "damaged" })).toBeNull();
  });

  test("both ends priced by the guide's base and multipliers, rounded down to 5,000 IQD; valid for the configured days", async () => {
    const { base, multipliers } = guideOf(withScreen.slug);
    const result = await estimateTradeIn(t.db, "ar", withScreen.slug, bestAnswers(withScreen), NOW);
    expect(result?.estimate).toMatchObject({
      kind: "range",
      low: "A",
      high: "A+",
      minIqd: floor5k(Math.floor((base * multipliers.A) / 10_000)),
      maxIqd: floor5k(Math.floor((base * multipliers["A+"]) / 10_000)),
      expiresAt: NOW + VALID_DAYS * 86_400_000,
      deductionsIqd: 0,
      missing: [],
    });
    const estimate = result!.estimate;
    if (estimate.kind !== "range") throw new Error("range expected");
    expect(estimate.minIqd % ESTIMATE_STEP_IQD).toBe(0);
    expect(estimate.maxIqd % ESTIMATE_STEP_IQD).toBe(0);
    expect(estimate.minIqd).toBeLessThanOrEqual(estimate.maxIqd);
    expect(Number.isSafeInteger(estimate.minIqd) && Number.isSafeInteger(estimate.maxIqd)).toBe(true);
  });

  test("every missing accessory takes its guide deduction off both ends", async () => {
    const { base, multipliers, deductions } = guideOf(homeConsole.slug);
    const missing = homeConsole.accessories[0];
    const answers: TradeInAnswers = { ...bestAnswers(homeConsole), body: "visible", included: homeConsole.accessories.filter((key) => key !== missing) };
    const result = await estimateTradeIn(t.db, "ar", homeConsole.slug, answers, NOW);
    const less = deductions[`missing_${missing}`];
    expect(result?.estimate).toMatchObject({
      kind: "range",
      low: "C",
      high: "B",
      missing: [missing],
      deductionsIqd: less,
      minIqd: floor5k(Math.floor((base * multipliers.C) / 10_000) - less),
      maxIqd: floor5k(Math.floor((base * multipliers.B) / 10_000) - less),
    });
  });

  test("a fault, a dead device or damage has no online figure; a locked device is refused", async () => {
    const base = bestAnswers(withScreen);
    expect((await estimateTradeIn(t.db, "ar", withScreen.slug, { ...base, power: "faulty" }, NOW))?.estimate).toEqual({ kind: "inspection", reason: "not_working" });
    expect((await estimateTradeIn(t.db, "ar", withScreen.slug, { ...base, power: "dead" }, NOW))?.estimate).toEqual({ kind: "inspection", reason: "not_working" });
    expect((await estimateTradeIn(t.db, "ar", withScreen.slug, { ...base, body: "damaged" }, NOW))?.estimate).toEqual({ kind: "inspection", reason: "damaged" });
    expect((await estimateTradeIn(t.db, "ar", withScreen.slug, { ...base, screen: "damaged" }, NOW))?.estimate).toEqual({ kind: "inspection", reason: "damaged" });
    expect((await estimateTradeIn(t.db, "ar", withScreen.slug, { ...base, account: "no" }, NOW))?.estimate).toEqual({ kind: "refused", reason: "account_locked" });
  });

  test("a guide without a multiplier for the grade, or deductions above the value, gives no figure", () => {
    const device = { accessories: ["controller"] };
    const answers: TradeInAnswers = { power: "works", body: "light", account: "yes", included: [] };
    expect(computeEstimate({ id: "g", baseIqd: 300_000, multipliers: { A: 9000 }, deductions: {}, updatedAt: 0 }, device, answers, 7, NOW)).toEqual({ kind: "inspection", reason: "unpriced" });
    expect(computeEstimate({ id: "g", baseIqd: 30_000, multipliers: { A: 9000, B: 7500 }, deductions: { missing_controller: 50_000 }, updatedAt: 0 }, device, answers, 7, NOW)).toEqual({ kind: "inspection", reason: "unpriced" });
  });

  test("incomplete answers are refused; an unknown device has no estimate", async () => {
    await expectCode(estimateTradeIn(t.db, "ar", withScreen.slug, { power: "works" }, NOW), "trade_in_answers_incomplete");
    expect(await estimateTradeIn(t.db, "ar", "no-such-device", bestAnswers(withScreen), NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── creating a request

describe("creating a request", () => {
  test("stores the request, its estimate and its history; the link's token opens it", async () => {
    const raw = input(withScreen, { contactName: "  زبون  ", preferredDay: baghdadDay(NOW + 86_400_000), preferredWindow: "evening", notes: "يد التحكم فيها انحراف بسيط" });
    const made = await createTradeIn(t.db, who(), raw, NOW);
    expect(made.replayed).toBe(false);
    expect(made.ref).toMatch(/^TI-[2-9A-HJ-NP-Z]{8}$/);
    expect(made.status).toBe("estimated");
    expect(made.tradeInId).toBe(await tradeInIdFor(raw.idempotencyKey as string));
    const [row] = await rows<Record<string, unknown>>("SELECT * FROM trade_ins WHERE id = ?", made.tradeInId);
    expect(row).toMatchObject({ ref: made.ref, status: "estimated", is_demo: 1, final_offer_iqd: null, offered_by: null, contact_name: "زبون", locale: "ar", phone_e164: `+964${(raw.phone as string).slice(1)}` });
    expect(row.estimate_min_iqd).toBe(made.estimate?.minIqd);
    expect(row.estimate_max_iqd).toBe(made.estimate?.maxIqd);
    expect(row.estimate_expires_at).toBe(NOW + VALID_DAYS * 86_400_000);
    expect(row.access_token_hash).not.toContain(made.accessToken);
    const events = await rows<{ kind: string; data: string; actor_kind: string }>("SELECT kind, data, actor_kind FROM trade_in_events WHERE trade_in_id = ? ORDER BY at, id", made.tradeInId);
    expect(events.map((event) => event.kind).sort()).toEqual(["estimated", "submitted"]);
    const submitted = JSON.parse(events.find((event) => event.kind === "submitted")!.data);
    expect(submitted).toMatchObject({ preferredDay: raw.preferredDay, preferredWindow: "evening", notes: raw.notes, photos: 0, ownershipDeclared: true });

    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "en", NOW);
    expect(view).toMatchObject({ ref: made.ref, status: "estimated", photoCount: 0, offer: null, canRespond: false, preferred: { day: raw.preferredDay, window: "evening" } });
    expect(view?.estimate).toEqual({ minIqd: made.estimate!.minIqd, maxIqd: made.estimate!.maxIqd, expiresAt: NOW + VALID_DAYS * 86_400_000, expired: false });
    expect(view?.answers).toEqual(bestAnswers(withScreen));
    expect(view?.phoneMasked).toMatch(/^0771 ••• ••\d\d$/);
    expect(JSON.stringify(view)).not.toContain(raw.phone as string);
    // Written in one batch with one timestamp, shown in lifecycle order.
    expect(view?.history.map((entry) => entry.kind)).toEqual(["submitted", "estimated"]);
    // The estimate expires; the view says so.
    const later = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW + (VALID_DAYS + 1) * 86_400_000);
    expect(later?.estimate?.expired).toBe(true);
  });

  test("a device priced after the inspection is a 'submitted' request without figures", async () => {
    const made = await createTradeIn(t.db, who(), input(homeConsole, { answers: { ...bestAnswers(homeConsole), power: "faulty" } }), NOW);
    expect(made.status).toBe("submitted");
    expect(made.estimate).toBeNull();
    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW);
    expect(view?.estimate).toBeNull();
    expect(view?.inspectionReason).toBe("not_working");
    expect(view?.history.map((entry) => entry.kind)).toEqual(["submitted"]);
  });

  test("validation: phone, ownership, preferred day, device, answers, refusal — nothing is written", async () => {
    const before = (await rows<{ n: number }>("SELECT COUNT(*) AS n FROM trade_ins"))[0].n;
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { phone: "" }), NOW), "invalid", "phone", "required");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { phone: "0123" }), NOW), "invalid", "phone", "phone_invalid");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { ownershipConfirmed: false }), NOW), "invalid", "ownershipConfirmed", "ownership_required");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { preferredDay: baghdadDay(NOW - 86_400_000) }), NOW), "invalid", "preferredDay", "inspection_day_invalid");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { preferredDay: baghdadDay(NOW + 30 * 86_400_000) }), NOW), "invalid", "preferredDay", "inspection_day_invalid");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { preferredDay: "2026-02-30" }), NOW), "invalid", "preferredDay", "inspection_day_invalid");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { idempotencyKey: "short" }), NOW), "invalid", "idempotencyKey", "invalid");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { notes: "x".repeat(501) }), NOW), "invalid", "notes", "too_long");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { device: "no-such-device" }), NOW), "trade_in_device_unavailable");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { answers: { power: "works" } }), NOW), "trade_in_answers_incomplete");
    await expectCode(createTradeIn(t.db, who(), input(withScreen, { answers: { ...bestAnswers(withScreen), account: "no" } }), NOW), "trade_in_refused");
    // Review 2026-11-12: every field at once (the form's error summary lists them all, also without script) — an
    // unreadable phone used to be reported only after the ownership box was ticked, one round trip later.
    const both = await expectCode(createTradeIn(t.db, who(), input(withScreen, { phone: "0123", ownershipConfirmed: false }), NOW), "invalid");
    expect(both.fields).toMatchObject({ phone: "phone_invalid", ownershipConfirmed: "ownership_required" });
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM trade_ins"))[0].n).toBe(before);
    // The preferred days offered by the page are all accepted.
    for (const day of inspectionDays(NOW)) expect((await createTradeIn(t.db, who(), input(homeConsole, { preferredDay: day }), NOW)).replayed).toBe(false);
  });

  test("idempotent: a retry and a race give the first request; the same key with another phone is refused", async () => {
    const raw = input(homeConsole);
    const first = await createTradeIn(t.db, who(), raw, NOW);
    const again = await createTradeIn(t.db, who(), raw, NOW + 5_000);
    expect(again).toMatchObject({ ref: first.ref, tradeInId: first.tradeInId, accessToken: first.accessToken, replayed: true });
    await expectCode(createTradeIn(t.db, who(), { ...raw, phone: phone() }, NOW), "idempotency_conflict");

    const race = input(withScreen);
    const [a, b] = await Promise.all([createTradeIn(t.db, who(), race, NOW), createTradeIn(t.db, who(), race, NOW)]);
    expect(a.ref).toBe(b.ref);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM trade_ins WHERE id = ?", a.tradeInId))[0].n).toBe(1);
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM trade_in_events WHERE trade_in_id = ? AND kind = 'submitted'", a.tradeInId))[0].n).toBe(1);
  });

  test("rate-limited per phone number (and per IP)", async () => {
    const number = phone();
    for (let i = 0; i < TRADE_IN_LIMITS.perPhone.limit; i++) await createTradeIn(t.db, who(), input(homeConsole, { phone: number }), NOW);
    await expectCode(createTradeIn(t.db, who(), input(homeConsole, { phone: number }), NOW), "rate_limited");
    const ip = "203.0.113.77";
    for (let i = 0; i < TRADE_IN_LIMITS.perIp.limit; i++) await createTradeIn(t.db, who({ ip }), input(homeConsole), NOW);
    await expectCode(createTradeIn(t.db, who({ ip }), input(homeConsole), NOW), "rate_limited");
  });

  test("live mode is not demo; a signed-in customer's request belongs to the account", async () => {
    const customerId = await fixtures(t.db, NOW).customer();
    const made = await createTradeIn(t.db, who({ storeMode: "live", customerId }), input(homeConsole), NOW);
    const [row] = await rows<{ is_demo: number; customer_id: string }>("SELECT is_demo, customer_id FROM trade_ins WHERE id = ?", made.tradeInId);
    expect(row).toEqual({ is_demo: 0, customer_id: customerId });
    // The owner sees it without the link; another customer does not.
    expect(await getTradeInByRef(t.db, made.ref, { customerId }, "ar", NOW)).not.toBeNull();
    expect((await getTradeInByRef(t.db, made.ref, { customerId }, "ar", NOW))?.canChooseCredit).toBe(true);
    expect(await getTradeInByRef(t.db, made.ref, { customerId: "cus_SOMEONEELSE00000000000001" }, "ar", NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── who may read a request

describe("reading a request", () => {
  test("the reference alone, a wrong token or a malformed reference opens nothing", async () => {
    const made = await createTradeIn(t.db, who(), input(withScreen), NOW);
    expect(await getTradeInByRef(t.db, made.ref, {}, "ar", NOW)).toBeNull();
    expect(await getTradeInByRef(t.db, made.ref, { accessToken: randomToken() }, "ar", NOW)).toBeNull();
    expect(await getTradeInByRef(t.db, made.ref.toLowerCase(), { accessToken: made.accessToken }, "ar", NOW)).not.toBeNull();
    expect(await getTradeInByRef(t.db, "TI-1234", { accessToken: made.accessToken }, "ar", NOW)).toBeNull();
    expect(normalizeTradeInRef(" ti-abcdefgh ")).toBe("TI-ABCDEFGH");
    expect(normalizeTradeInRef("TI-ABCDEFG0")).toBeNull();
  });

  test("reference + phone: the same null for a wrong reference and a wrong phone; rate-limited per IP", async () => {
    const raw = input(homeConsole);
    const made = await createTradeIn(t.db, who(), raw, NOW);
    const ip = "198.51.100.9";
    expect((await lookupTradeIn(t.db, { ref: made.ref, phone: raw.phone }, { ip }, "ckb", NOW))?.ref).toBe(made.ref);
    expect((await lookupTradeIn(t.db, { ref: made.ref, phone: `+964${(raw.phone as string).slice(1)}` }, { ip }, "ar", NOW))?.ref).toBe(made.ref);
    expect(await lookupTradeIn(t.db, { ref: made.ref, phone: phone() }, { ip }, "ar", NOW)).toBeNull();
    expect(await lookupTradeIn(t.db, { ref: "TI-ZZZZZZZZ", phone: raw.phone }, { ip }, "ar", NOW)).toBeNull();
    await expectCode(lookupTradeIn(t.db, { ref: made.ref, phone: "12" }, { ip }, "ar", NOW), "invalid", "phone", "phone_invalid");
    await expectCode(lookupTradeIn(t.db, { ref: made.ref, phone: "" }, { ip }, "ar", NOW), "invalid", "phone", "required");
    // Per IP: guessing across references stops at the limit…
    const tight = "198.51.100.10";
    const unknownRef = (i: number) => `TI-${"ABCDEFGHJK"[i % 10]}${"23456789".repeat(1).slice(0, 7)}`;
    for (let i = 0; i < TRADE_IN_LIMITS.lookupIp.limit; i++) expect(await lookupTradeIn(t.db, { ref: unknownRef(i), phone: phone() }, { ip: tight }, "ar", NOW)).toBeNull();
    await expectCode(lookupTradeIn(t.db, { ref: made.ref, phone: raw.phone }, { ip: tight }, "ar", NOW), "rate_limited");
    // …and per reference: guessing the phone of one request from many addresses stops too.
    const target = await createTradeIn(t.db, who(), input(homeConsole), NOW);
    for (let i = 0; i < TRADE_IN_LIMITS.lookupRef.limit; i++) await lookupTradeIn(t.db, { ref: target.ref, phone: phone() }, { ip: `192.0.2.${i + 1}` }, "ar", NOW);
    await expectCode(lookupTradeIn(t.db, { ref: target.ref, phone: phone() }, { ip: "192.0.2.200" }, "ar", NOW), "rate_limited");
  });
});

// ───────────────────────────────────────────────────────────────── photos

describe("draft photos (private)", () => {
  test("stored privately for the draft, readable only by it, limited, removable — and moved to the request", async () => {
    const token = randomToken(24);
    const stranger = randomToken(24);
    const guest = { kind: "guest" as const };
    const first = await addTradeInDraftPhoto(t.db, store, token, new Blob([PNG], { type: "image/png" }), guest, NOW);
    expect(first.count).toBe(1);
    const [record] = await rows<{ visibility: string; kind: string; owner_type: string; storage_key: string }>("SELECT visibility, kind, owner_type, storage_key FROM files WHERE id = ?", first.id);
    expect(record).toMatchObject({ visibility: "private", kind: "trade_in_photo", owner_type: "trade_in_draft" });
    expect(record.storage_key.startsWith("prv_")).toBe(true);
    expect(await readTradeInDraftPhoto(t.db, store, token, first.id)).not.toBeNull();
    expect(await readTradeInDraftPhoto(t.db, store, stranger, first.id)).toBeNull();
    expect(await readTradeInDraftPhoto(t.db, store, null, first.id)).toBeNull();
    expect(await removeTradeInDraftPhoto(t.db, store, stranger, first.id, NOW)).toBe(false);

    for (let i = 1; i < TRADE_IN_PHOTO_LIMIT; i++) await addTradeInDraftPhoto(t.db, store, token, PNG, guest, NOW);
    await expectCode(addTradeInDraftPhoto(t.db, store, token, PNG, guest, NOW), "trade_in_photo_limit");
    await expectCode(addTradeInDraftPhoto(t.db, store, token, new Blob([new TextEncoder().encode("<svg/>")]), guest, NOW), "trade_in_photo_limit");
    expect(await removeTradeInDraftPhoto(t.db, store, token, first.id, NOW)).toBe(true);
    expect(await readTradeInDraftPhoto(t.db, store, token, first.id)).toBeNull();
    expect((await listTradeInDraftPhotos(t.db, token)).length).toBe(TRADE_IN_PHOTO_LIMIT - 1);
    await expectCode(addTradeInDraftPhoto(t.db, store, stranger, new Blob([new TextEncoder().encode("not an image")]), guest, NOW), "upload_type");

    const made = await createTradeIn(t.db, who({ draftToken: token }), input(withScreen), NOW);
    expect(made.photos).toBe(TRADE_IN_PHOTO_LIMIT - 1);
    expect(await listTradeInDraftPhotos(t.db, token)).toEqual([]);
    const moved = await t.db.select({ id: files.id }).from(files).where(and(eq(files.ownerType, "trade_in"), eq(files.ownerId, made.tradeInId)));
    expect(moved.length).toBe(TRADE_IN_PHOTO_LIMIT - 1);
    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW);
    expect(view?.photoCount).toBe(TRADE_IN_PHOTO_LIMIT - 1);
    expect(JSON.stringify(view)).not.toContain("prv_");
  });

  test("abandoned drafts are purged after two days; drafts of a request are not", async () => {
    const token = randomToken(24);
    const photo = await addTradeInDraftPhoto(t.db, store, token, PNG, { kind: "guest" }, NOW - 3 * 86_400_000);
    const removed = await purgeStaleTradeInDrafts(t.db, store, NOW);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await readTradeInDraftPhoto(t.db, store, token, photo.id)).toBeNull();
    expect((await rows<{ n: number }>("SELECT COUNT(*) AS n FROM files WHERE owner_type = 'trade_in' AND deleted_at IS NOT NULL"))[0].n).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── the final offer

describe("the shopper's answer to a final offer", () => {
  /** What the admin will do: inspect and make an offer (the database insists on the inspection and the employee). */
  async function offer(tradeInId: string, amountIqd: number, expiresAt: number | null) {
    await t.db
      .update(tradeIns)
      .set({
        status: "offered",
        finalOfferIqd: amountIqd,
        offeredBy: "emp_TEST",
        offeredAt: NOW,
        offerExpiresAt: expiresAt,
        inspection: { checklist: { templateId: null, completedAt: NOW, completedBy: "emp_TEST", items: [] }, grade: "B", inspectedAt: NOW },
      })
      .where(eq(tradeIns.id, tradeInId));
  }

  test("the database refuses an offer status without a final offer, and a final offer without an inspection", async () => {
    const made = await createTradeIn(t.db, who(), input(homeConsole), NOW);
    const rule = async (write: Promise<unknown>) => {
      const error = await write.then(() => null, (failure: unknown) => failure);
      expect(isDbError(error, "TRADE_IN_OFFER_NOT_ALLOWED")).toBe(true);
    };
    await rule(t.db.update(tradeIns).set({ status: "offered" }).where(eq(tradeIns.id, made.tradeInId)));
    await rule(t.db.update(tradeIns).set({ finalOfferIqd: 100_000, offeredBy: "emp_TEST", offeredAt: NOW }).where(eq(tradeIns.id, made.tradeInId)));
  });

  test("accept with cash: once, only while open, only with the link; the history records it", async () => {
    const made = await createTradeIn(t.db, who(), input(homeConsole), NOW);
    await offer(made.tradeInId, 250_000, NOW + 3 * 86_400_000);
    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW);
    expect(view).toMatchObject({ status: "offered", canRespond: true, canChooseCredit: false, offer: { amountIqd: 250_000, expired: false } });

    await expectCode(respondToOffer(t.db, { ref: made.ref }, { decision: "accept", payout: "cash" }, NOW), "not_found");
    await expectCode(respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept" }, NOW), "invalid", "payout", "payout_required");
    await expectCode(respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "store_credit" }, NOW), "payout_requires_account", "payout", "payout_requires_account");
    expect(await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "cash" }, NOW + 1000)).toEqual({ status: "accepted" });
    await expectCode(respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "decline" }, NOW + 2000), "trade_in_offer_closed");

    const after = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW + 3000);
    expect(after).toMatchObject({ status: "accepted", payoutMethod: "cash", canRespond: false });
    expect(after?.history.at(-1)).toMatchObject({ kind: "accepted", payout: "cash" });
    const accepted = await t.db.select().from(tradeInEvents).where(and(eq(tradeInEvents.tradeInId, made.tradeInId), eq(tradeInEvents.kind, "accepted")));
    expect(accepted.length).toBe(1);
  });

  test("before answering, the shopper sees what the inspection found: the offered event's snapshot and the checklist in words", async () => {
    const made = await createTradeIn(t.db, who(), input(withScreen), NOW);
    // Without an offer there is nothing to show.
    expect((await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "en", NOW))?.inspection).toBeNull();

    // What admin module 13 writes: the recorded inspection (with staff-only notes and a serial) and the "offered" event.
    const [template] = await rows<{ id: string; items: string }>("SELECT id, items FROM inspection_templates WHERE is_active = 1 AND device_kind = ? ORDER BY version DESC LIMIT 1", withScreen.kind);
    const lines = (JSON.parse(template.items) as { key: string; input: string; label: Record<string, string> }[]).filter((item) => item.input === "pass_fail");
    expect(lines.length).toBeGreaterThan(1);
    const checklist = { templateId: template.id, completedAt: NOW, completedBy: "emp_TEST", items: lines.map((line, index) => ({ key: line.key, result: index === 0 ? "fail" : "pass", note: "ملاحظة الفاحص الداخلية" })) };
    await t.db
      .update(tradeIns)
      .set({ status: "offered", finalOfferIqd: 180_000, offeredBy: "emp_TEST", offeredAt: NOW, offerExpiresAt: NOW + 86_400_000, inspection: { checklist, grade: "B", inspectedAt: NOW, notes: "ملاحظات داخلية", serial: "SN-PRIVATE-77" } as never })
      .where(eq(tradeIns.id, made.tradeInId));
    const snapshot = { amountIqd: 180_000, grade: "B", passed: lines.length - 1, failed: 1, included: ["dock", "../etc"], suggestedIqd: 191_000, guideBaseIqd: 987_000, guideBy: "emp_TEST", note: "سبب العرض الداخلي" };
    await t.db.insert(tradeInEvents).values({ id: newId("tie"), tradeInId: made.tradeInId, kind: "offered", data: snapshot, actorKind: "employee", actorId: "emp_TEST", at: NOW + 1 });

    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "en", NOW + 1000);
    expect(view?.inspection).toMatchObject({ grade: "B", passed: lines.length - 1, failed: 1, included: ["dock"] });
    expect(view?.inspection?.checks).toEqual(lines.map((line, index) => ({ key: line.key, label: line.label.en, ok: index !== 0 })));
    // Never the inspector's notes, the serial, the guide or the offer's internal reason.
    const text = JSON.stringify(view);
    for (const secret of ["ملاحظة الفاحص الداخلية", "ملاحظات داخلية", "SN-PRIVATE-77", "سبب العرض الداخلي", "987000", "191000"]) expect(text).not.toContain(secret);

    // The newest "offered" event counts (history is append-only); a snapshot that does not match the recorded lines
    // keeps its counts and shows no lines.
    await t.db.insert(tradeInEvents).values({ id: newId("tie"), tradeInId: made.tradeInId, kind: "offered", data: { ...snapshot, passed: lines.length, failed: 0 }, actorKind: "employee", actorId: "emp_TEST", at: NOW + 2 });
    const stale = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW + 2000);
    expect(stale?.inspection).toMatchObject({ grade: "B", passed: lines.length, failed: 0, checks: [] });
  });

  test("decline; an expired offer cannot be answered", async () => {
    const declined = await createTradeIn(t.db, who(), input(withScreen), NOW);
    await offer(declined.tradeInId, 300_000, null);
    expect(await respondToOffer(t.db, { ref: declined.ref, accessToken: declined.accessToken }, { decision: "decline", reason: "أريد أكثر" }, NOW)).toEqual({ status: "declined" });
    const [row] = await rows<{ status: string; decline_reason: string; declined_at: number }>("SELECT status, decline_reason, declined_at FROM trade_ins WHERE id = ?", declined.tradeInId);
    expect(row).toEqual({ status: "declined", decline_reason: "أريد أكثر", declined_at: NOW });

    const expired = await createTradeIn(t.db, who(), input(withScreen), NOW);
    await offer(expired.tradeInId, 300_000, NOW + 60_000);
    expect((await getTradeInByRef(t.db, expired.ref, { accessToken: expired.accessToken }, "ar", NOW + 120_000))?.canRespond).toBe(false);
    await expectCode(respondToOffer(t.db, { ref: expired.ref, accessToken: expired.accessToken }, { decision: "accept", payout: "cash" }, NOW + 120_000), "trade_in_offer_closed");
  });

  // Review 2026-11-12: the tracking page said «عرض نهائي بانتظار ردك» (and "decide now") for an offer whose date had
  // passed, because the row stays "offered" until the daily expiry job runs. The shopper's view reads it as expired.
  test("an offer past its date reads as expired before the daily job closes it (link and lookup alike)", async () => {
    const shopperPhone = phone();
    const made = await createTradeIn(t.db, who(), input(withScreen, { phone: shopperPhone }), NOW);
    await offer(made.tradeInId, 300_000, NOW + 60_000);
    expect(await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW)).toMatchObject({ status: "offered", canRespond: true, offer: { expired: false } });

    const late = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW + 120_000);
    expect(late).toMatchObject({ status: "expired", canRespond: false, offer: { amountIqd: 300_000, expired: true } });
    const looked = await lookupTradeIn(t.db, { ref: made.ref, phone: shopperPhone }, { ip: `10.9.${++phoneCounter % 250}.7` }, "ar", NOW + 120_000);
    expect(looked).toMatchObject({ status: "expired", canRespond: false });
    // The row itself is the daily job's to close.
    const [row] = await rows<{ status: string }>("SELECT status FROM trade_ins WHERE id = ?", made.tradeInId);
    expect(row.status).toBe("offered");
  });
});

// ───────────────────────────────────────────────────────────────── the pages (rendered)

function renderPage(Component: unknown, path: string, entry: string, loaderData: unknown, locale: Locale): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path, Component: Component as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [entry],
      hydrationData: {
        loaderData: { root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui", "ui-card", "ui-shop", "ui-overlays") }, page: loaderData as never },
      },
    }),
  );
}

async function wizardPage(search: string, locale: Locale = "ar"): Promise<string> {
  const wizard = await loadWizard(t.db, locale, new URL(`http://tamtam.test/trade-in${search}`), null, NOW);
  const prefix = locale === "ar" ? "" : `/${locale}`;
  return renderPage(TradeIn, ":locale?/trade-in", `${prefix}/trade-in${search}`, { ...wizard, meta: { title: "", description: "" }, i18n: messagesFor(locale, "used", "errors") }, locale);
}

describe("the wizard's pages (rendered)", () => {
  // QA 2026-11-12: the tiles' two-line clamp cut «PlayStation 5 Digital Edition (الطراز الأصلي…» — the part that tells
  // the original model from the Slim — and at 1440 in English "· estimate" started a line of its own.
  test("device tiles: a qualifier on its own line under the name; the estimate never splits from its amount", async () => {
    expect(splitQualifier("PlayStation 5 Digital Edition (الطراز الأصلي 2020)")).toEqual({ base: "PlayStation 5 Digital Edition", qualifier: "الطراز الأصلي 2020" });
    expect(splitQualifier("PlayStation 5 (original 2020 model)")).toEqual({ base: "PlayStation 5", qualifier: "original 2020 model" });
    expect(splitQualifier("Nintendo Switch – OLED Model")).toEqual({ base: "Nintendo Switch – OLED Model", qualifier: null });
    expect(splitQualifier("Joy-Con 2 (L)/(R)")).toEqual({ base: "Joy-Con 2 (L)/(R)", qualifier: null });
    expect(splitQualifier("(2020)")).toEqual({ base: "(2020)", qualifier: null });
    for (const locale of ["ar", "en", "ckb"] as const) {
      const devices = await listTradeInDevices(t.db, locale);
      const html = await wizardPage("", locale);
      const names = [...html.matchAll(/class="used-device__name">(.*?)<\/span>/g)].map((match) => match[1]);
      expect(names.length, locale).toBe(devices.length);
      for (const name of names) expect(name, locale).not.toMatch(/[()]/);
      expect(html.match(/class="used-device__meta"/g)?.length ?? 0, locale).toBe(devices.filter((device) => splitQualifier(device.name).qualifier !== null).length);
      // «حتى 300,000 د.ع · تقديري»: the amount is one unbreakable run, and «· تقديري» is bound to it
      const amounts = [...html.matchAll(/class="used-device__up">(.*?)<\/span>/g)].map((match) => match[1]).filter((text) => text.includes("⁨"));
      expect(amounts.length, locale).toBe(devices.filter((device) => device.upToIqd !== null).length);
      for (const text of amounts) {
        expect(text, locale).toMatch(/⁩ · /);
        expect(text.match(/⁨([^⁩]*)⁩/)?.[1], locale).not.toContain(" ");
      }
    }
  });

  // QA 2026-11-12: after «تابع» focus stayed on the task bar's key: nothing told a screen reader the question changed.
  test("every step's heading is the place focus goes after a move between steps", async () => {
    const answers = new URLSearchParams(answerPairs(bestAnswers(homeConsole))).toString();
    const searches = ["", `?step=condition&device=${homeConsole.slug}`, `?step=condition&device=${homeConsole.slug}&q=body`, `?step=photos&device=${homeConsole.slug}&${answers}`, `?step=estimate&device=${homeConsole.slug}&${answers}`, `?step=inspection&device=${homeConsole.slug}&${answers}`];
    for (const search of searches) {
      const html = await wizardPage(search);
      const headings = html.match(/<h1\b[^>]*>/g) ?? [];
      expect(headings.length, search).toBe(1);
      expect(headings[0], search).toMatch(/tabindex="-1"/);
      expect(headings[0], search).toMatch(/data-step-heading=""/);
    }
  });

  // QA 2026-11-12: the tracking page tagged a trade-in request "Demo order" (the generic order tag).
  test("the tracking page tags a demo request as a request", async () => {
    const made = await createTradeIn(t.db, who(), input(homeConsole), NOW);
    for (const [locale, words, never] of [["en", "Demo request", "Demo order"], ["ar", "طلب تجريبي", null], ["ckb", "داواکاری تاقیکاری", null]] as const) {
      const view = (await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, locale, NOW))!;
      const loaderData = { ref: made.ref, view: { ...view, questions: questionsFor(view.device) }, created: false, meta: { title: "" }, i18n: messagesFor(locale, "used", "errors") };
      const html = renderPage(TradeInStatus, ":locale?/trade-in/:ref", `${locale === "ar" ? "" : `/${locale}`}/trade-in/${made.ref}`, loaderData, locale);
      expect(html, locale).toContain(words);
      if (never) expect(html, locale).not.toContain(never);
    }
  });
});
