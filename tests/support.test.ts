/**
 * Support area — knowledge base, the maintenance assistant, support tickets and repair requests
 * (app/server/services/support/**), against a real local D1 with the DEMO catalogue (seedDemo).
 *
 * Fixtures are chosen by their properties (an approved troubleshooting tree, a device with its own guides, a device
 * with only platform-wide guides), not by hard-coded slugs, wherever the seed allows it.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { randomToken } from "~/lib/ids";
import { seedDemo } from "~/server/db/seed/demo";
import {
  assistantMessages,
  assistantSessions,
  auditEvents,
  consents,
  deviceModels,
  files,
  knowledgeArticles,
  platforms,
  repairEvents,
  repairTickets,
  serials,
  supportTickets,
  ticketMessages,
  troubleshootingTrees,
  type TroubleshootingNode,
  type TroubleshootingTree,
} from "~/server/db/schema";
import { isAppError } from "~/server/errors";
import { kvBlobStore } from "~/server/storage.server";
import { baghdadDay, nextDays, normalizeSupportRef, validPreferredDay, type SupportWho } from "~/server/services/support/common.server";
import { checkTree, handOffToStaff, runAssistant, type AssistantModel } from "~/server/services/support/assistant.server";
import { findArticlesMentioning, getArticle, getSupportDirectory, listArticlesForDevice, listHelpArticles, listRelatedArticles } from "~/server/services/support/kb.server";
import { findErrorCode, interpretText, normalizeForMatch } from "~/server/services/support/matcher";
import { createRepairTicket, getRepairByAccessToken, lookupRepair, normalizeSerial } from "~/server/services/support/repairs.server";
import { EMPTY_ASSISTANT_STATE, assistantSearch, cleanQuestion, parseAssistantState, type AssistantState } from "~/server/services/support/state";
import { summarizeConversation } from "~/server/services/support/summary";
import { createSupportTicket, SUPPORT_ERROR_KEYS } from "~/server/services/support/tickets.server";
import type { AssistantBotTurn, AssistantView } from "~/server/services/support/types";
import errorsMessages from "~/i18n/messages/errors";
import supportMessages from "~/i18n/messages/support";
import { makeT } from "~/i18n/translate";
import { createTestDb, type TestDb } from "./helpers/db";

let t: TestDb;
let ipCounter = 0;
/** A fresh IP per test, so the per-IP limits of one test never block another. */
const freshIp = () => `198.51.100.${++ipCounter}`;
let phoneCounter = 0;
const freshPhone = () => `07701${String(100_000 + ++phoneCounter).slice(-6)}`;
const key = () => randomToken();
const who = (overrides: Partial<SupportWho> = {}): SupportWho => ({ customerId: null, ip: freshIp(), storeMode: "demo", ...overrides });
const state = (patch: Partial<AssistantState>): AssistantState => ({ ...EMPTY_ASSISTANT_STATE, answers: [], ...patch });

/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const png = (name = "photo.png") => new File([PNG], name, { type: "image/png" });

const tAr = makeT(supportMessages.ar, "ar", "support");
const tEn = makeT(supportMessages.en, "en", "support");

async function expectAppError(promise: Promise<unknown>, code: string, field?: string, fieldCode?: string) {
  try {
    await promise;
  } catch (error) {
    expect(isAppError(error), String(error)).toBe(true);
    const appError = error as { code: string; fields?: Record<string, string> };
    expect(appError.code).toBe(code);
    if (field) expect(appError.fields?.[field]).toEqual(fieldCode ?? expect.any(String));
    return appError;
  }
  throw new Error(`expected AppError ${code}`);
}

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── pure helpers

describe("conversation state and references (pure)", () => {
  test("the URL state round-trips and drops anything malformed", () => {
    const parsed = parseAssistantState(new URLSearchParams("device=ps5-slim&symptom=no_power&a=1&a=0&a=x&a=3&q=%20%20my%20%20ps5%0Awon%27t%20start%20&handoff=1&platform=Bad Slug"));
    expect(parsed).toEqual({ platform: null, device: "ps5-slim", q: "my ps5 won't start", symptom: "no_power", answers: [1, 0], handoff: true });
    expect(assistantSearch(parsed)).toBe("?device=ps5-slim&q=my+ps5+won%27t+start&symptom=no_power&a=1&a=0&handoff=1");
    expect(parseAssistantState(new URLSearchParams(assistantSearch(parsed).slice(1)))).toEqual(parsed);
    // answers without a tree or words mean nothing
    expect(parseAssistantState(new URLSearchParams("device=x&a=1")).answers).toEqual([]);
    expect(parseAssistantState(new URLSearchParams("symptom=No-Power")).symptom).toBeNull();
    expect(cleanQuestion("a".repeat(500))?.length).toBe(300);
    expect(cleanQuestion("   ")).toBeNull();
  });

  test("references are forgiving to type and strict to match", () => {
    expect(normalizeSupportRef(" rp-7k4m2q9x ", "RP")).toBe("RP-7K4M2Q9X");
    expect(normalizeSupportRef("RP7K4M2Q9X", "RP")).toBe("RP-7K4M2Q9X");
    expect(normalizeSupportRef("SP-7K4M2Q9X", "RP")).toBeNull();
    expect(normalizeSupportRef("RP-12", "RP")).toBeNull();
    expect(normalizeSupportRef("RP-0OO1IIUU", "RP")).toBeNull();
    expect(normalizeSerial(" e 123-abc ")).toBe("E123-ABC");
    expect(normalizeSerial("x")).toBe("invalid");
    expect(normalizeSerial("سيريال")).toBe("invalid");
  });

  test("preferred days run from today to 30 days ahead on the Baghdad calendar", () => {
    const now = Date.UTC(2026, 10, 10, 22, 30); // 01:30 on 11 November in Baghdad
    expect(baghdadDay(now)).toBe("2026-11-11");
    expect(validPreferredDay("2026-11-11", now)).toBe(true);
    expect(validPreferredDay("2026-11-10", now)).toBe(false);
    expect(validPreferredDay("2026-12-11", now)).toBe(true);
    expect(validPreferredDay("2026-12-12", now)).toBe(false);
    expect(validPreferredDay("2026-02-30", now)).toBe(false);
    expect(nextDays(now, 3)).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
  });

  test("the keyword matcher routes words in three languages, danger first, and finds error codes", () => {
    const symptoms = ["stick_drift", "no_power"];
    expect(interpretText("my left stick is drifting", { symptoms })).toEqual({ kind: "symptom", symptomKey: "stick_drift" });
    expect(interpretText("العصا تتحرك وحدها", { symptoms })).toEqual({ kind: "symptom", symptomKey: "stick_drift" });
    expect(interpretText("جۆیستیکەکە لادەدات", { symptoms })).toEqual({ kind: "symptom", symptomKey: "stick_drift" });
    expect(interpretText("الجهاز ما يشتغل", { symptoms })).toEqual({ kind: "symptom", symptomKey: "no_power" });
    expect(interpretText("PS5 won't turn on", { symptoms })).toEqual({ kind: "symptom", symptomKey: "no_power" });
    expect(interpretText("ئامێرەکە داناگیرسێت", { symptoms })).toEqual({ kind: "symptom", symptomKey: "no_power" });
    // a symptom without an approved tree for this device is not offered
    expect(interpretText("stick drift", { symptoms: ["no_power"] }).kind).not.toBe("symptom");
    // danger words win over everything
    expect(interpretText("it won't turn on and smells of burning", { symptoms })).toEqual({ kind: "danger" });
    expect(interpretText("البطارية منتفخة", { symptoms })).toEqual({ kind: "danger" });
    expect(interpretText("دووکەڵی لێ دێت", { symptoms })).toEqual({ kind: "danger" });
    expect(interpretText("error CE-108255-1 when I start a game", { symptoms })).toEqual({ kind: "code", code: "CE-108255-1" });
    expect(findErrorCode("كود 0x80070005")).toBe("0x80070005");
    expect(findErrorCode("2123-1502")).toBe("2123-1502");
    expect(findErrorCode("no code here")).toBeNull();
    expect(interpretText("the fan is very loud", { symptoms })).toEqual({ kind: "topic", topic: "overheating" });
    expect(interpretText("asdf qwerty", { symptoms })).toEqual({ kind: "none" });
    expect(normalizeForMatch("إنّ الشّاشة")).toBe("ان الشاشه");
  });
});

// ───────────────────────────────────────────────────────────────── knowledge base

describe("knowledge base", () => {
  test("the device directory holds published models of active platforms only", async () => {
    const groups = await getSupportDirectory(t.db, "en");
    expect(groups.length).toBeGreaterThanOrEqual(4);
    const inactive = await t.db.select({ id: platforms.id }).from(platforms).where(eq(platforms.isActive, false));
    for (const group of groups) {
      expect(inactive.map((row) => row.id)).not.toContain(group.id);
      expect(group.devices.length).toBeGreaterThan(0);
      for (const device of group.devices) expect(device.platform.id).toBe(group.id);
    }
  });

  test("a device's guides: its own first, then its platform's; related only on request", async () => {
    const withOwn = await t.db.select({ id: knowledgeArticles.deviceModelId }).from(knowledgeArticles).where(and(eq(knowledgeArticles.status, "approved"), eq(knowledgeArticles.audience, "public"))).all();
    const deviceId = withOwn.find((row) => row.id !== null)?.id as string;
    const own = await listArticlesForDevice(t.db, "en", deviceId);
    expect(own.length).toBeGreaterThan(0);
    expect(own[0].scope).toBe("device");
    expect(own.every((article) => article.scope !== "related")).toBe(true);

    // a model of the same platform without its own guides gets platform-wide ones only, plus related on request
    const owner = await t.db.select({ platformId: deviceModels.platformId }).from(deviceModels).where(eq(deviceModels.id, deviceId)).get();
    const siblings = await t.db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.platformId, owner!.platformId)).all();
    const sibling = siblings.find((row) => !withOwn.some((article) => article.id === row.id));
    if (sibling) {
      const plain = await listArticlesForDevice(t.db, "en", sibling.id);
      expect(plain.every((article) => article.scope === "platform")).toBe(true);
      const near = await listArticlesForDevice(t.db, "en", sibling.id, { related: true });
      expect(near.some((article) => article.scope === "related")).toBe(true);
    }
    expect(await listArticlesForDevice(t.db, "en", "dvm_does-not-exist")).toEqual([]);
  });

  test("only approved public articles exist for the storefront", async () => {
    const base = { kind: "guide" as const, title: { ar: "مسودة", en: "Draft" }, body: { ar: [{ type: "p" as const, text: "سر" }] }, updatedAt: t.now, createdAt: t.now };
    await t.db.insert(knowledgeArticles).values([
      { ...base, id: "kba_draft", slug: "test-draft-article", status: "draft" },
      { ...base, id: "kba_internal", slug: "test-internal-article", status: "approved", audience: "internal" },
      { ...base, id: "kba_review", slug: "test-review-article", status: "review" },
    ]);
    for (const slug of ["test-draft-article", "test-internal-article", "test-review-article"]) expect(await getArticle(t.db, "en", slug)).toBeNull();
    const all = await listHelpArticles(t.db, "en");
    expect(all.some((article) => article.slug.startsWith("test-"))).toBe(false);
    expect(await findArticlesMentioning(t.db, "en", "سر")).toEqual([]);
    expect(await getArticle(t.db, "en", "../etc/passwd")).toBeNull();
  });

  test("an article reads in the shopper's language and falls back to Arabic, saying so", async () => {
    const [first] = await listHelpArticles(t.db, "ckb");
    const article = await getArticle(t.db, "ckb", first.slug);
    expect(article?.blocks.length).toBeGreaterThan(0);
    expect(article?.fallback).toBe(false);
    expect(article?.reviewed).toBe(false); // seeded: approved without a reviewer
    expect(article?.isDemo).toBe(true);

    await t.db.insert(knowledgeArticles).values({ id: "kba_ar_only", slug: "test-arabic-only", kind: "faq", title: { ar: "عربي فقط" }, body: { ar: [{ type: "p", text: "نص" }] }, status: "approved", updatedAt: t.now, createdAt: t.now });
    const arabicOnly = await getArticle(t.db, "en", "test-arabic-only");
    expect(arabicOnly?.fallback).toBe(true);
    expect(arabicOnly?.title).toBe("عربي فقط");
    expect(arabicOnly?.blocks).toEqual([{ type: "p", text: "نص" }]);

    const related = await listRelatedArticles(t.db, "en", article!);
    expect(related.some((entry) => entry.id === article!.id)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── assistant

/** Approved trees of the seed, parsed. */
async function approvedTrees() {
  const rows = await t.db.select().from(troubleshootingTrees).where(eq(troubleshootingTrees.status, "approved")).all();
  return rows.map((row) => ({ row, checked: checkTree(row.tree)! }));
}

const bot = (view: AssistantView) => view.turns.filter((turn): turn is AssistantBotTurn => turn.role === "assistant");

describe("maintenance assistant", () => {
  test("no AI model is configured, and the conversation starts by asking for the device", async () => {
    const view = await runAssistant(t.db, "en", state({}));
    expect(view.ai).toEqual({ configured: false, name: null });
    expect(view.stage).toBe("device");
    expect(view.prompt?.kind).toBe("platforms");
    if (view.prompt?.kind !== "platforms") throw new Error("prompt");
    expect(view.prompt.platforms.map((entry) => entry.slug)).not.toContain("pc");
    expect(view.prompt.otherHref).toBe("?device=other");

    const models = await runAssistant(t.db, "en", state({ platform: view.prompt.platforms[0].slug }));
    expect(models.prompt?.kind).toBe("models");
    expect(models.turns.map((turn) => turn.role)).toEqual(["assistant", "user", "assistant"]);
  });

  test("every approved tree is well formed and every path ends in a safe outcome", async () => {
    const trees = await approvedTrees();
    expect(trees.length).toBeGreaterThanOrEqual(2);
    for (const { row, checked } of trees) {
      expect(checked, row.symptomKey).not.toBeNull();
      // walk every path: no loops, every leaf an outcome, repairs never claim a certain diagnosis
      const seen = new Set<string>();
      const walk = (id: string, depth: number) => {
        expect(depth).toBeLessThan(30);
        const node = checked.nodes.get(id) as TroubleshootingNode;
        seen.add(id);
        if (node.kind === "outcome") {
          if (node.outcome?.type === "repair") expect(`${node.text.en} ${node.warning?.en ?? ""}`).toMatch(/cannot|most likely|usually|stop|do not/i);
          return;
        }
        for (const option of node.options ?? []) walk(option.next, depth + 1);
      };
      walk((row.tree as TroubleshootingTree).start, 0);
      expect(seen.size).toBe(checked.nodes.size);
    }
  });

  test("a symptom is replayed through its tree from the URL; a bad answer ends the replay", async () => {
    const [{ row, checked }] = await approvedTrees();
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    const start = await runAssistant(t.db, "en", state({ device: device.slug }));
    expect(start.stage).toBe("problem");
    if (start.prompt?.kind !== "problems") throw new Error("prompt");
    expect(start.prompt.symptoms.length).toBeGreaterThanOrEqual(2);

    const first = await runAssistant(t.db, "en", state({ device: device.slug, symptom: row.symptomKey }));
    const firstNode = checked.nodes.get((row.tree as TroubleshootingTree).start)!;
    expect(first.stage).toBe(firstNode.kind === "outcome" ? "done" : "steps");
    expect(bot(first).at(-1)?.text).toBe(firstNode.text.en);
    expect(bot(first).at(-1)?.sources).toEqual([{ type: "tree", id: row.id, nodeId: firstNode.id }]);
    if (first.prompt?.kind !== "choices") throw new Error("choices");
    expect(first.prompt.choices[0].href).toContain(`symptom=${row.symptomKey}`);
    expect(first.prompt.choices[0].href).toContain("a=0");

    const bad = await runAssistant(t.db, "en", state({ device: device.slug, symptom: row.symptomKey, answers: [17, 0] }));
    expect(bad.search).toBe(`?device=${device.slug}&symptom=${row.symptomKey}`);
    expect(bot(bad).at(-1)?.text).toBe(firstNode.text.en);
  });

  test("the power tree asks about danger first and stops with a warning; a guided path reaches a device guide", async () => {
    const trees = await approvedTrees();
    const power = trees.find(({ checked, row }) => checked.nodes.get((row.tree as TroubleshootingTree).start)?.options?.length === 2 && [...checked.nodes.values()].some((node) => node.outcome?.type === "article"));
    expect(power, "a tree that starts with a yes/no question and can end in an article").toBeTruthy();
    const { row, checked } = power!;
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];

    // option 0 of the first question leads to an outcome with a safety warning
    const startNode = checked.nodes.get((row.tree as TroubleshootingTree).start)!;
    const firstNext = checked.nodes.get(startNode.options![0].next)!;
    const stop = await runAssistant(t.db, "en", state({ device: device.slug, symptom: row.symptomKey, answers: [0] }));
    if (firstNext.kind === "outcome") {
      expect(stop.stage).toBe("done");
      expect(bot(stop).at(-1)?.warning).toBeTruthy();
      // a stop never sounds like a diagnosis: only a technician checking the device can tell
      if (firstNext.outcome?.type === "repair") expect(bot(stop).at(-1)?.confidence).toBe("needs_check");
    }

    // find any path that ends in an article outcome, by search
    const pathTo = (id: string, path: number[]): number[] | null => {
      const node = checked.nodes.get(id)!;
      if (node.kind === "outcome") return node.outcome?.type === "article" ? path : null;
      for (const [index, option] of (node.options ?? []).entries()) {
        const found = pathTo(option.next, [...path, index]);
        if (found) return found;
      }
      return null;
    };
    const path = pathTo((row.tree as TroubleshootingTree).start, [])!;
    const guided = await runAssistant(t.db, "en", state({ device: device.slug, symptom: row.symptomKey, answers: path }));
    expect(guided.stage).toBe("done");
    expect(guided.outcome?.type).toBe("article");
    expect(guided.outcome?.article?.slug).toBeTruthy();
    expect(bot(guided).at(-1)?.confidence).toBe("uncertain");
    expect(bot(guided).filter((turn) => turn.kind === "step").map((turn) => turn.stepNumber)).toEqual(bot(guided).filter((turn) => turn.kind === "step").map((_, index) => index + 1));
    // the summary carries the steps and the result
    const summary = summarizeConversation(guided, tEn);
    expect(summary).toContain(`Device: ${device.name}`);
    expect(summary).toContain("Result: sent to the device's guide.");
    expect(summary).toContain("→");
    // a picked reply is never quoted as the customer's own words
    expect(summary).not.toContain("Customer's words");
  });

  test("the shopper's own words: danger stops at once, a code is answered honestly, a symptom starts its tree", async () => {
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    const danger = await runAssistant(t.db, "en", state({ device: device.slug, q: "there is smoke coming out" }));
    expect(danger.stage).toBe("done");
    expect(bot(danger).at(-1)?.kind).toBe("danger");
    expect(bot(danger).at(-1)?.warningKey).toBe("assistant.danger.warning");
    expect(danger.outcome?.type).toBe("repair");

    const code = await runAssistant(t.db, "en", state({ device: device.slug, q: "CE-108255-1" }));
    expect(bot(code).at(-1)?.kind).toBe("code");
    expect(bot(code).at(-1)?.params.code).toBe("CE-108255-1");
    expect(code.stage).toBe("problem"); // the shopper can still pick a problem
    expect(summarizeConversation(code, tEn)).toContain("Error code: CE-108255-1");

    const drift = await runAssistant(t.db, "ar", state({ device: device.slug, q: "العصا اليسرى تنحرف" }));
    expect(bot(drift).map((turn) => turn.kind)).toContain("matched");
    expect(drift.symptom?.key).toBe("stick_drift");
    expect(drift.stage).toBe("steps");

    const lost = await runAssistant(t.db, "en", state({ device: device.slug, q: "zzzz qqqq" }));
    expect(bot(lost).at(-1)?.kind).toBe("unmatched");
    expect(lost.prompt?.kind).toBe("problems");

    // typed words, then a problem picked from the list: both are in the transcript
    const picked = await runAssistant(t.db, "en", state({ device: device.slug, q: "zzzz qqqq", symptom: "no_power" }));
    expect(picked.turns.filter((turn) => turn.role === "user").map((turn) => turn.text).slice(-2)).toEqual(["zzzz qqqq", picked.symptom?.title]);
  });

  test("a configured model may only choose existing keys; danger is never left to it", async () => {
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    const model: AssistantModel = { name: "test-model", interpret: async () => ({ symptomKey: "made_up_key", topic: "made_up_topic" }) };
    const view = await runAssistant(t.db, "en", state({ device: device.slug, q: "zzzz" }), { model });
    expect(view.ai).toEqual({ configured: true, name: "test-model" });
    expect(bot(view).at(-1)?.kind).toBe("unmatched");
    const chooser: AssistantModel = { name: "test-model", interpret: async () => ({ symptomKey: "stick_drift" }) };
    expect((await runAssistant(t.db, "en", state({ device: device.slug, q: "zzzz" }), { model: chooser })).symptom?.key).toBe("stick_drift");
    expect((await runAssistant(t.db, "en", state({ device: device.slug, q: "smoke" }), { model: chooser })).outcome?.type).toBe("repair");
  });

  test("malformed or unapproved trees are never walked", async () => {
    await t.db.insert(troubleshootingTrees).values([
      { id: "tst_broken", symptomKey: "broken_tree", title: { ar: "شجرة معطوبة", en: "Broken" }, tree: { start: "a", nodes: [{ id: "a", kind: "question", text: { ar: "؟" }, options: [{ label: { ar: "نعم" }, next: "nowhere" }] }] }, status: "approved", updatedAt: t.now },
      { id: "tst_draft", symptomKey: "draft_tree", title: { ar: "مسودة", en: "Draft" }, tree: { start: "a", nodes: [{ id: "a", kind: "outcome", text: { ar: "نص" }, outcome: { type: "resolved" } }] }, status: "draft", updatedAt: t.now },
    ]);
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    const view = await runAssistant(t.db, "en", state({ device: device.slug }));
    if (view.prompt?.kind !== "problems") throw new Error("prompt");
    const keys = view.prompt.symptoms.map((choice) => new URLSearchParams(choice.href.slice(1)).get("symptom"));
    expect(keys).not.toContain("broken_tree");
    expect(keys).not.toContain("draft_tree");
    expect((await runAssistant(t.db, "en", state({ device: device.slug, symptom: "draft_tree" }))).stage).toBe("problem");
  });
});

// ───────────────────────────────────────────────────────────────── handoff and tickets

describe("talking to staff", () => {
  test("a handoff needs consent and a valid phone; nothing is stored without them", async () => {
    const before = (await t.db.select().from(assistantSessions).all()).length;
    await expectAppError(handOffToStaff(t.db, who(), "ar", state({ device: "other" }), { idempotencyKey: key(), phone: freshPhone() }, t.now), "invalid", "consent", "required");
    await expectAppError(handOffToStaff(t.db, who(), "ar", state({ device: "other" }), { idempotencyKey: key(), phone: "0770 12", consent: "on" }, t.now), "invalid", "phone", "phone_invalid");
    await expectAppError(handOffToStaff(t.db, who(), "ar", state({ device: "other" }), { idempotencyKey: "short", phone: freshPhone(), consent: "on" }, t.now), "invalid", "idempotencyKey");
    expect((await t.db.select().from(assistantSessions).all()).length).toBe(before);
  });

  test("a handoff stores the conversation with consent and opens a ticket with the summary for staff", async () => {
    const device = (await getSupportDirectory(t.db, "en"))[0].devices[0];
    const conversation = state({ device: device.slug, q: "my stick drifts", symptom: "stick_drift", answers: [0] });
    const formKey = key();
    const phone = freshPhone();
    const ticket = await handOffToStaff(t.db, who(), "en", conversation, { idempotencyKey: formKey, phone, contactName: "Ali", note: "Started last week", consent: "on" }, t.now, { store: kvBlobStore(t.kv), photos: [png()] });
    expect(ticket.ref).toMatch(/^SP-[2-9A-Z]{8}$/);
    expect(ticket.replayed).toBe(false);

    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get();
    expect(row).toMatchObject({ channel: "assistant", category: "repair", status: "open", phoneE164: `+964${phone.slice(1)}`, contactName: "Ali", locale: "en", isDemo: true });
    expect(row?.subject).toContain(device.name);
    const session = await t.db.select().from(assistantSessions).where(eq(assistantSessions.id, row!.assistantSessionId!)).get();
    expect(session).toMatchObject({ status: "escalated", logConsent: true, symptomKey: "stick_drift", deviceModelId: device.id });
    expect(session?.summary).toContain("الجهاز:"); // staff read Arabic
    const messages = await t.db.select().from(assistantMessages).where(eq(assistantMessages.sessionId, session!.id)).all();
    const replay = await runAssistant(t.db, "en", conversation);
    expect(messages.length).toBe(replay.turns.length);
    expect(messages.some((message) => message.role === "user" && message.content === "my stick drifts")).toBe(true);
    const consent = await t.db.select().from(consents).where(eq(consents.subjectId, session!.id)).get();
    expect(consent).toMatchObject({ kind: "support_log", granted: true, source: "assistant" });

    const notes = await t.db.select().from(ticketMessages).where(eq(ticketMessages.ticketId, ticket.ticketId)).all();
    const customer = notes.find((note) => !note.isInternal);
    const internal = notes.find((note) => note.isInternal);
    expect(customer?.body).toBe("Started last week");
    expect(customer?.attachments).toHaveLength(1);
    expect(internal?.body).toBe(session?.summary);
    const photo = await t.db.select().from(files).where(eq(files.id, customer!.attachments![0])).get();
    expect(photo).toMatchObject({ visibility: "private", kind: "support_photo", ownerType: "support_ticket", ownerId: ticket.ticketId });
    expect(photo?.storageKey.startsWith("prv_")).toBe(true);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, ticket.ticketId), eq(auditEvents.action, "support.ticket.create"))).get();
    expect(audit).toBeTruthy();

    // the same form sent again: the same ticket, nothing new
    const again = await handOffToStaff(t.db, who(), "en", conversation, { idempotencyKey: formKey, phone, consent: "on" }, t.now);
    expect(again).toMatchObject({ ref: ticket.ref, replayed: true });
    expect((await t.db.select().from(supportTickets).where(eq(supportTickets.accessTokenHash, row!.accessTokenHash!)).all()).length).toBe(1);
    // …but not with someone else's number
    await expectAppError(handOffToStaff(t.db, who(), "en", conversation, { idempotencyKey: formKey, phone: freshPhone(), consent: "on" }, t.now), "idempotency_conflict");
  });

  test("two simultaneous submissions of one form create one ticket", async () => {
    const formKey = key();
    const phone = freshPhone();
    const input = { idempotencyKey: formKey, phone, subject: "Question about a repair", message: "Hello" };
    const results = await Promise.allSettled([createSupportTicket(t.db, who(), input, t.now), createSupportTicket(t.db, who(), input, t.now)]);
    const refs = results.filter((result) => result.status === "fulfilled").map((result) => (result as PromiseFulfilledResult<{ ref: string }>).value.ref);
    expect(new Set(refs).size).toBe(1);
    const count = await t.db.select().from(supportTickets).where(eq(supportTickets.phoneE164, `+964${phone.slice(1)}`)).all();
    expect(count.length).toBe(1);
  });

  test("bad photos are refused before anything is stored; too many photos too", async () => {
    const store = kvBlobStore(t.kv);
    const fake = new File([new TextEncoder().encode("<svg onload=alert(1)>")], "x.png", { type: "image/png" });
    await expectAppError(createSupportTicket(t.db, who(), { idempotencyKey: key(), phone: freshPhone(), subject: "Photo test" }, t.now, { store, photos: [fake] }), "invalid", "photos", "upload_type");
    await expectAppError(createSupportTicket(t.db, who(), { idempotencyKey: key(), phone: freshPhone(), subject: "Photo test" }, t.now, { store, photos: [png(), png(), png(), png()] }), "invalid", "photos", "too_big");
  });

  test("ticket creation is rate limited per phone", async () => {
    const phone = freshPhone();
    for (let i = 0; i < 5; i++) await createSupportTicket(t.db, who(), { idempotencyKey: key(), phone, subject: `Question ${i}` }, t.now);
    await expectAppError(createSupportTicket(t.db, who(), { idempotencyKey: key(), phone, subject: "One more" }, t.now), "rate_limited");
  });

  test("every error code the services throw has words in the errors namespace", () => {
    const words = errorsMessages.ar.errors as Record<string, unknown>;
    for (const code of SUPPORT_ERROR_KEYS) expect(words[code], code).toBeTypeOf("string");
  });

  test("every turn kind and summary key the services use has words in all three languages", () => {
    const kinds = ["ask_device", "ask_model", "ask_problem", "matched", "unmatched", "code", "code_found", "topic", "danger"];
    for (const locale of ["ar", "en", "ckb"] as const) {
      const tr = makeT(supportMessages[locale], locale, "support");
      for (const kind of kinds) expect(tr(`assistant.turn.${kind}`)).not.toBe(`assistant.turn.${kind}`);
      for (const key of ["assistant.deviceOther", "assistant.danger.warning", "assistant.battery.warning", "handoff.subject", "handoff.noProblem", "handoff.noDevice", "summary.unfinished", "summary.outcome.repair"]) expect(tr(key)).not.toBe(key);
    }
    expect(tAr("summary.device", { device: "X" })).toBe("الجهاز: X");
  });
});

// ───────────────────────────────────────────────────────────────── repairs

describe("repair requests", () => {
  const validRepair = async (overrides: Record<string, unknown> = {}) => {
    const [group] = await getSupportDirectory(t.db, "en");
    return { idempotencyKey: key(), device: group.devices[0].slug, issue: "It shuts down after ten minutes of play.", phone: freshPhone(), ...overrides };
  };

  test("validation: every field problem at once, with this area's codes", async () => {
    const error = await expectAppError(
      createRepairTicket(t.db, who(), { idempotencyKey: key(), device: "not-a-device", serial: "x", issue: "short", phone: "123", handover: "teleport", preferredDay: "2020-01-01" }, t.now),
      "invalid",
    );
    expect(error.fields).toMatchObject({ device: "invalid", issue: "too_short", phone: "phone_invalid", handover: "invalid" });
    await expectAppError(createRepairTicket(t.db, who(), await validRepair({ device: "other" }), t.now), "invalid", "deviceText", "required");
    await expectAppError(createRepairTicket(t.db, who(), await validRepair({ serial: "!!" }), t.now), "invalid", "serial", "invalid");
    await expectAppError(createRepairTicket(t.db, who(), await validRepair({ preferredDay: baghdadDay(t.now - 86_400_000) }), t.now), "invalid", "preferredDay", "preferred_day_invalid");
  });

  test("a request stores the device, private serial, photos and preferences, and links our own unit", async () => {
    const unit = await t.db.select({ id: serials.id, serial: serials.serial }).from(serials).get();
    const input = await validRepair({ serial: unit!.serial.toLowerCase(), contactName: "Sara", handover: "pickup", preferredDay: baghdadDay(t.now + 86_400_000), preferredWindow: "evening", source: "assistant" });
    const created = await createRepairTicket(t.db, who(), input, t.now, { store: kvBlobStore(t.kv), photos: [png("front.png"), png("back.png")] });
    expect(created.ref).toMatch(/^RP-[2-9A-Z]{8}$/);

    const row = await t.db.select().from(repairTickets).where(eq(repairTickets.id, created.ticketId)).get();
    expect(row).toMatchObject({ status: "submitted", source: "assistant", serialText: unit!.serial.toUpperCase(), serialId: unit!.id, contactName: "Sara", isDemo: true, isWarranty: false });
    const event = await t.db.select().from(repairEvents).where(eq(repairEvents.ticketId, created.ticketId)).get();
    expect(event?.data).toMatchObject({ status: "submitted", handover: "pickup", preferredWindow: "evening", source: "assistant" });
    expect((event?.data as { photos: string[] }).photos).toHaveLength(2);

    // the status page by token shows what the shopper may see — never the serial
    const view = await getRepairByAccessToken(t.db, "en", created.ref, created.accessToken);
    expect(view).toMatchObject({ ref: created.ref, status: "submitted", handover: "pickup", preferredWindow: "evening", photoCount: 2, quoteIqd: null, isDemo: true });
    expect(JSON.stringify(view)).not.toContain(unit!.serial.toUpperCase());
    expect(view?.timeline).toEqual([{ status: "submitted", at: t.now }]);
    expect(await getRepairByAccessToken(t.db, "en", created.ref, "x".repeat(43))).toBeNull();
    expect(await getRepairByAccessToken(t.db, "en", created.ref, "bad token")).toBeNull();

    // the same form again: the same request
    const again = await createRepairTicket(t.db, who(), input, t.now);
    expect(again).toMatchObject({ ref: created.ref, replayed: true, accessToken: created.accessToken });
  });

  test("status by reference and phone: same answer for a wrong ref and a wrong phone, rate limited", async () => {
    const input = await validRepair();
    const created = await createRepairTicket(t.db, who(), input, t.now);
    const ip = freshIp();
    expect((await lookupRepair(t.db, "ar", { ref: created.ref.toLowerCase(), phone: input.phone }, { ip }, t.now))?.ref).toBe(created.ref);
    expect(await lookupRepair(t.db, "ar", { ref: created.ref, phone: freshPhone() }, { ip }, t.now)).toBeNull();
    expect(await lookupRepair(t.db, "ar", { ref: "RP-ZZZZZZZZ", phone: input.phone }, { ip }, t.now)).toBeNull();
    await expectAppError(lookupRepair(t.db, "ar", { ref: "nope", phone: "" }, { ip }, t.now), "invalid", "ref", "invalid");
    for (let i = 0; i < 7; i++) await lookupRepair(t.db, "ar", { ref: "RP-ZZZZZZZZ", phone: input.phone }, { ip }, t.now);
    await expectAppError(lookupRepair(t.db, "ar", { ref: created.ref, phone: input.phone }, { ip }, t.now), "rate_limited");
  });

  test("staff status changes and a quote appear on the status page; notes do not", async () => {
    const created = await createRepairTicket(t.db, who(), await validRepair(), t.now);
    await t.db.insert(repairEvents).values([
      { id: "rev_test_1", ticketId: created.ticketId, kind: "status", note: "internal: customer was rude", data: { from: "submitted", to: "received" }, actorKind: "employee", actorId: "emp_x", at: t.now + 1000 },
      { id: "rev_test_2", ticketId: created.ticketId, kind: "note", note: "secret", data: { to: "ready" }, actorKind: "employee", actorId: "emp_x", at: t.now + 2000 },
    ]);
    await t.db.update(repairTickets).set({ status: "awaiting_approval", quoteIqd: 45_000, updatedAt: t.now + 3000 }).where(eq(repairTickets.id, created.ticketId));
    const view = await getRepairByAccessToken(t.db, "en", created.ref, created.accessToken);
    expect(view?.timeline.map((entry) => entry.status)).toEqual(["submitted", "received", "awaiting_approval"]);
    expect(view).toMatchObject({ status: "awaiting_approval", quoteIqd: 45_000, quoteApproved: false });
    expect(JSON.stringify(view)).not.toContain("rude");
    expect(JSON.stringify(view)).not.toContain("secret");
  });
});
