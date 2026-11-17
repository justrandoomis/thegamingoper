/**
 * The scheduled jobs of modules 16 and 19 (polish round 2026-11-13, owner: platform — app/server/jobs.server.ts). The
 * modules built them and they only ever ran by hand:
 *
 *   every five minutes  automation.run                     runAutomation (the active rules; the stock-out scan hourly)
 *                       marketing.campaigns.release         releaseDueCampaigns (approved campaigns whose time came)
 *                       — both before outbox.deliver
 *   every night         marketing.cart_reminders.prepare    prepareCartReminders (one held reminder per abandoned cart;
 *                                                           nightly for its D1 reads, gated by a cheap index check)
 *                       automation.forecasts.store          storeDemandForecasts, before the consistency checks
 *
 * Each one the way the other jobs run: a job_runs row with its counters, a run with nothing to do succeeded, a second
 * run (or two at once) adds nothing, a failing one fails alone, messages held and never sent, demo carts left to the
 * module's own button, and the marketing jobs skipped — never a wrong link — without the store's public origin.
 *
 * Runs against a real local D1 (tests/helpers/db.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { newId } from "~/lib/ids";
import type { L10n } from "~/lib/locales";
import type { EmployeeActor } from "~/server/actor";
import { cartItems, cartReminders, carts, consents, jobRuns, platforms, products, stockLevels, stockMovements, variants } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { CRON_DAILY, CRON_FREQUENT, JOB_NAMES, SCHEDULES, automationScanDue, runJob, runScheduledJobs } from "~/server/jobs.server";
import { defaultRolePermissions } from "~/server/permissions";
import { monthKey, monthStart } from "~/server/services/admin/automation/forecast";
import { listSuggestions } from "~/server/services/admin/automation/suggestions.server";
import { parseSuggestionFilters } from "~/server/services/admin/automation/types";
import { decideCampaign, getCampaign, saveCampaign, submitCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

/** While on, that module's job function throws: only its own job may fail. */
const failing = vi.hoisted(() => ({ automation: false, forecasts: false }));
vi.mock("~/server/services/admin/automation/runner.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/automation/runner.server")>();
  return {
    ...real,
    runAutomation: async (...args: Parameters<typeof real.runAutomation>) => {
      if (failing.automation) throw new Error("the automation runner is down (test)");
      return real.runAutomation(...args);
    },
  };
});
vi.mock("~/server/services/admin/automation/forecast.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/automation/forecast.server")>();
  return {
    ...real,
    storeDemandForecasts: async (...args: Parameters<typeof real.storeDemandForecasts>) => {
      if (failing.forecasts) throw new Error("the forecast store is down (test)");
      return real.storeDemandForecasts(...args);
    },
  };
});

const NOW = TEST_NOW;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ORIGIN = "https://tamtamgames.com";
const ENV = { PUBLIC_ORIGIN: ORIGIN };

let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

const rows = async <T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> => (await t.d1.prepare(query).bind(...params).all<T>()).results;
const t3 = (ar: string, en: string, ckb: string): L10n => ({ ar, en, ckb });
const employee = (id: string, permissions: Iterable<string>): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions), label: id });
const writer = employee("emp_jobs_writer", defaultRolePermissions("manager"));
const owner = employee("emp_jobs_owner", ["*"]);
const key = (label: string) => `jobs-${label}-${newId("k").slice(-10)}`.replace(/[^A-Za-z0-9_-]/g, "x");

/** A platform of its own with one game in stock: its buyers are one campaign's audience. */
async function shelf(tag: string) {
  const platformId = `plt_jobs_${tag}`;
  const productId = `prd_jobs_${tag}`;
  const variantId = `var_jobs_${tag}`;
  const sku = `SKU-JOBS-${tag}`;
  await runBatch(t.db, [
    t.db.insert(platforms).values({ id: platformId, slug: `zz-jobs-${tag}`, name: t3(`منصة ${tag}`, `Platform ${tag}`, `پلاتفۆرم ${tag}`), accent: "nintendo", sort: 95, isActive: true }),
    t.db.insert(products).values({ id: productId, slug: `jobs-game-${tag}`, kind: "game", name: t3(`لعبة ${tag}`, `Game ${tag}`, `یاری ${tag}`), status: "published", platformId, createdAt: NOW, updatedAt: NOW }),
    t.db.insert(variants).values({ id: variantId, productId, sku, priceIqd: 50_000, isDefault: true }),
    t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 20 }),
  ]);
  return { platformId, productId, variantId, sku };
}
type Shelf = Awaited<ReturnType<typeof shelf>>;

/** A customer account, with a "yes" to marketing unless told otherwise. */
async function account(options: { consent?: boolean; isDemo?: boolean } = {}) {
  const phone = make.phone();
  const id = await make.customer({ id: newId("cus"), phoneE164: phone, name: "زبون المهام", isDemo: options.isDemo ?? false });
  if (options.consent !== false) await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: id, kind: "marketing", granted: true, source: "account", at: NOW - 10 * DAY });
  return { id, phone };
}

/** A buyer of the shelf's game (the campaign's audience: people who bought for that platform). */
async function buyer(item: Shelf) {
  const person = await account();
  await make.order([{ variantId: item.variantId, sku: item.sku, unitPriceIqd: 50_000 }], { customerId: person.id, contactPhoneE164: person.phone, placedAt: NOW - 5 * DAY, status: "delivered" });
  return person;
}

/** An SMS campaign written and asked for by one person, approved by a second: due at once, or at `scheduledAt` (Baghdad "YYYY-MM-DDTHH:mm"). */
async function approvedCampaign(name: string, item: Shelf, extra: Record<string, unknown> = {}) {
  const { campaignId } = await saveCampaign(t.db, writer, { idempotencyKey: key("campaign"), name, channel: "sms", platformIds: [item.platformId], guests: true, bodyAr: "مرحباً {name}، عرض جديد في {store}.", ...extra }, NOW);
  const page = await getCampaign(t.db, writer, campaignId, "ar", NOW, ORIGIN);
  const request = await submitCampaign(t.db, writer, { campaignId, expectedUpdatedAt: page.campaign.updatedAt, note: "" }, NOW);
  const shown = await getCampaign(t.db, owner, campaignId, "ar", NOW, ORIGIN);
  await decideCampaign(t.db, owner, { campaignId, approvalId: request.approvalId, decision: "approve", fingerprint: shown.campaign.fingerprint, note: "" }, NOW);
  return campaignId;
}

const campaignStatus = async (campaignId: string) => (await rows<{ status: string }>("SELECT status FROM campaigns WHERE id = ?", campaignId))[0]?.status;
const heldOf = (campaignId: string) => rows<{ status: string; recipient: string }>("SELECT status, recipient FROM outbox WHERE ref_type = 'campaign' AND ref_id = ?", campaignId);

/** A cart of the customer's, with one line, last touched `idleFor` ago. */
async function abandonedCart(customerId: string, item: Shelf, idleFor = 3 * HOUR) {
  const cartId = newId("crt");
  await t.db.insert(carts).values({ id: cartId, tokenHash: newId("tok"), customerId, createdAt: NOW - idleFor - HOUR, updatedAt: NOW - idleFor });
  await t.db.insert(cartItems).values({ id: newId("cit"), cartId, variantId: item.variantId, qty: 1, addedAt: NOW - idleFor });
  return cartId;
}

// ───────────────────────────────────────────────────────────────── the schedules

describe("schedules", () => {
  test("every five minutes the automation rules and the campaigns run before the outbox; every night the cart reminders and the forecasts before the checks", () => {
    expect(SCHEDULES[CRON_FREQUENT]).toEqual([
      "orders.expire_unpaid",
      "inventory.reservations.expire",
      "catalog.publish_due",
      "support.tickets.route",
      "automation.run",
      "marketing.campaigns.release",
      "outbox.deliver",
    ]);
    expect(SCHEDULES[CRON_DAILY].slice(-3)).toEqual(["marketing.cart_reminders.prepare", "automation.forecasts.store", "consistency.daily"]);
    expect(automationScanDue(NOW)).toBe(true);
    expect(automationScanDue(NOW + 5 * 60_000)).toBe(false);
    expect(automationScanDue(NOW + 55 * 60_000)).toBe(false);
    expect(automationScanDue(NOW + HOUR + 4 * 60_000)).toBe(true);
    for (const job of ["automation.run", "marketing.campaigns.release", "marketing.cart_reminders.prepare", "automation.forecasts.store"]) expect(JOB_NAMES).toContain(job);
    expect([...Object.values(SCHEDULES).flat()].sort()).toEqual([...JOB_NAMES].sort());
    // no new trigger: the same two crons wrangler.jsonc already fires
    const wrangler = readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8");
    const crons = JSON.parse(/"crons"\s*:\s*(\[[^\]]*\])/.exec(wrangler)?.[1] ?? "[]") as string[];
    expect([...crons].sort()).toEqual(Object.keys(SCHEDULES).sort());
  });
});

// ───────────────────────────────────────────────────────────────── 19.05 forecasts (nightly)

describe("automation.forecasts.store", () => {
  test("a night with nothing to forecast succeeds with nothing stored; a year of sales is stored for next month, and a second night replaces it", async () => {
    const empty = await runJob(t.db, "automation.forecasts.store", NOW);
    expect(empty).toMatchObject({ status: "succeeded", error: null, stats: { stored: 0 } });

    const product = await make.product({ priceIqd: 70_000, stock: 50 });
    const history: (typeof stockMovements.$inferInsert)[] = [{ id: newId("smv"), variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "receive", qtyDelta: 500, actorKind: "system", at: monthStart(NOW, -14) }];
    for (let offset = 1; offset <= 12; offset++) history.push({ id: newId("smv"), variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -4, actorKind: "system", at: monthStart(NOW, -offset) + DAY });
    for (const movement of history) await t.db.insert(stockMovements).values(movement);

    const night = await runScheduledJobs(t.db, CRON_DAILY, NOW, ENV);
    expect(night.ok).toBe(true);
    const forecast = night.jobs.find((job) => job.job === "automation.forecasts.store");
    expect(forecast).toMatchObject({ status: "succeeded", error: null });
    expect(Number(forecast?.stats.stored)).toBeGreaterThanOrEqual(1);
    const stored = () => rows<{ qty: number }>("SELECT qty_forecast AS qty FROM demand_forecasts WHERE variant_id = ? AND period = ?", product.variantId, monthKey(NOW, 1));
    expect(await stored()).toEqual([{ qty: 4 }]);
    expect(await t.db.select({ status: jobRuns.status }).from(jobRuns).where(eq(jobRuns.id, forecast!.runId)).get()).toEqual({ status: "succeeded" });

    const again = await runJob(t.db, "automation.forecasts.store", NOW + HOUR);
    expect(again.stats.stored).toBe(forecast?.stats.stored);
    expect(await stored()).toHaveLength(1);
  });

  test("a failing forecast fails alone: its own failed run, every other job of the night still runs", async () => {
    failing.forecasts = true;
    try {
      const night = await runScheduledJobs(t.db, CRON_DAILY, NOW + DAY, ENV);
      expect(night.ok).toBe(false);
      expect(night.jobs.filter((job) => job.status === "failed").map((job) => job.job)).toEqual(["automation.forecasts.store"]);
      expect(night.jobs.find((job) => job.job === "consistency.daily")?.status).toBe("succeeded");
      expect(night.jobs.find((job) => job.job === "automation.forecasts.store")?.error).toContain("the forecast store is down");
    } finally {
      failing.forecasts = false;
    }
  });
});

// ───────────────────────────────────────────────────────────────── 19 automation (every five minutes)

describe("automation.run", () => {
  test("the scan runs as the job: a SKU at its reorder point gets one suggestion, and the suggestions page says when it last checked — also when nothing was new", async () => {
    const at = NOW + 2 * DAY;
    const product = await make.product({ priceIqd: 90_000, stock: 2 });
    await t.db.update(stockLevels).set({ reorderPoint: 5, reorderQty: 10 }).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID)));

    const first = await runJob(t.db, "automation.run", at);
    expect(first).toMatchObject({ status: "succeeded", error: null, stats: { scanned: 1 } });
    expect(Number(first.stats.suggestionsCreated)).toBeGreaterThanOrEqual(1);
    expect(await rows("SELECT id FROM reorder_suggestions WHERE variant_id = ?", product.variantId)).toHaveLength(1);
    const filters = parseSuggestionFilters(new URLSearchParams());
    expect((await listSuggestions(t.db, owner, filters, "ar", at)).lastScanAt).toBe(at);

    // D1 reads: the scheduler scans once an hour; five minutes later no scan and no active rule is "skipped", and the
    // page's "last checked" stays on the scan
    const between = await runJob(t.db, "automation.run", at + 5 * 60_000);
    expect(between).toMatchObject({ status: "skipped", stats: { scanned: 0, reason: "no_scan_this_run" } });
    expect((await listSuggestions(t.db, owner, filters, "ar", at + 5 * 60_000)).lastScanAt).toBe(at);
    // a person's run scans whenever it is started
    const manual = await runJob(t.db, "automation.run", at + 10 * 60_000, { origin: "manual" });
    expect(manual).toMatchObject({ status: "succeeded", stats: { scanned: 1 } });

    // the next hour: nothing new and no rule active — runAutomation calls that "skipped", but the check was made
    const quiet = await runJob(t.db, "automation.run", at + HOUR);
    expect(quiet).toMatchObject({ status: "succeeded", stats: { scanned: 1, suggestionsCreated: 0 } });
    expect((await listSuggestions(t.db, owner, filters, "ar", at + HOUR)).lastScanAt).toBe(at + HOUR);
    expect(await rows("SELECT id FROM reorder_suggestions WHERE variant_id = ?", product.variantId)).toHaveLength(1);
    expect(await rows("SELECT actor_kind, actor_id FROM audit_events WHERE entity_type = 'reorder_suggestion' AND actor_kind = 'system'")).toContainEqual({ actor_kind: "system", actor_id: "automation.run" });
  });

  test("a failing automation run fails alone: the marketing jobs and the outbox of the same five minutes still run", async () => {
    failing.automation = true;
    try {
      const run = await runScheduledJobs(t.db, CRON_FREQUENT, NOW + 3 * DAY, ENV);
      expect(run.ok).toBe(false);
      expect(run.jobs.filter((job) => job.status === "failed").map((job) => job.job)).toEqual(["automation.run"]);
      expect(run.jobs.map((job) => job.job)).toEqual(SCHEDULES[CRON_FREQUENT]);
      expect(run.jobs.find((job) => job.job === "marketing.campaigns.release")?.status).toBe("succeeded");
      expect(run.jobs.find((job) => job.job === "outbox.deliver")?.status).toBe("skipped");
    } finally {
      failing.automation = false;
    }
  });
});

// ───────────────────────────────────────────────────────────────── 16.01 campaigns (every five minutes)

describe("marketing.campaigns.release", () => {
  test("an approved campaign whose time came is released by the job as the system — held, never sent; the next run releases nothing", async () => {
    const item = await shelf("due");
    const people = [await buyer(item), await buyer(item)];
    const campaignId = await approvedCampaign("حملة المجدول", item);
    expect(await campaignStatus(campaignId)).toBe("scheduled");

    const run = await runJob(t.db, "marketing.campaigns.release", NOW + 60_000, { env: ENV });
    expect(run).toMatchObject({ status: "succeeded", error: null, stats: { failed: 0 } });
    expect(Number(run.stats.released)).toBeGreaterThanOrEqual(1);
    expect(await campaignStatus(campaignId)).toBe("sending");
    const held = await heldOf(campaignId);
    expect(held.map((row) => row.recipient).sort()).toEqual(people.map((person) => person.phone).sort());
    expect(held.every((row) => row.status === "held")).toBe(true);
    expect(await rows("SELECT actor_kind, actor_id FROM audit_events WHERE action = 'marketing.campaign.release' AND entity_id = ?", campaignId)).toEqual([{ actor_kind: "system", actor_id: "marketing.campaigns.release" }]);

    const next = await runJob(t.db, "marketing.campaigns.release", NOW + 6 * 60_000, { env: ENV });
    expect(next).toMatchObject({ status: "succeeded", stats: { released: 0, failed: 0 } });
    expect(await heldOf(campaignId)).toHaveLength(2);
  });

  test("a campaign set for later waits for its time; two runs at once release it once", async () => {
    const item = await shelf("later");
    await buyer(item);
    await buyer(item);
    // 15:00 in Baghdad on the test day = NOW (09:00 Baghdad) + 6 hours
    const campaignId = await approvedCampaign("حملة المساء", item, { scheduledAt: "2026-11-10T15:00" });
    const early = await runJob(t.db, "marketing.campaigns.release", NOW + 5 * HOUR, { env: ENV });
    expect(early.status).toBe("succeeded");
    expect(await campaignStatus(campaignId)).toBe("scheduled");
    expect(await heldOf(campaignId)).toHaveLength(0);

    const both = await Promise.all([runJob(t.db, "marketing.campaigns.release", NOW + 6 * HOUR + 60_000, { env: ENV }), runJob(t.db, "marketing.campaigns.release", NOW + 6 * HOUR + 60_000, { env: ENV })]);
    expect(both.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(await campaignStatus(campaignId)).toBe("sending");
    expect(await heldOf(campaignId)).toHaveLength(2);
    expect(await rows("SELECT id FROM campaign_recipients WHERE campaign_id = ?", campaignId)).toHaveLength(2);
  });

  test("without the store's public origin the job is skipped and the campaign waits — never released with a wrong link", async () => {
    const item = await shelf("noorigin");
    await buyer(item);
    const campaignId = await approvedCampaign("حملة بلا عنوان", item);
    for (const env of [undefined, { PUBLIC_ORIGIN: "" }, { PUBLIC_ORIGIN: "not a url" }, { PUBLIC_ORIGIN: "javascript:alert(1)" }]) {
      const run = await runJob(t.db, "marketing.campaigns.release", NOW + 60_000, { env });
      expect(run).toMatchObject({ status: "skipped", stats: { reason: "no_public_origin" } });
    }
    expect(await campaignStatus(campaignId)).toBe("scheduled");
    // the next run with the origin releases it
    await runJob(t.db, "marketing.campaigns.release", NOW + 2 * 60_000, { env: ENV });
    expect(await campaignStatus(campaignId)).toBe("sending");
  });

  test("a campaign that cannot be released fails the run, named in its error; the other due campaigns are released", async () => {
    const broken = await shelf("broken");
    await buyer(broken);
    const brokenId = await approvedCampaign("حملة رابطها مفقود", broken);
    // its {link} names a link that is not the campaign's (removed under it): the release refuses it
    await t.d1.prepare("UPDATE campaigns SET content = json_set(content, '$.linkId', 'utm_gone_for_good') WHERE id = ?").bind(brokenId).run();
    const fine = await shelf("fine");
    await buyer(fine);
    const fineId = await approvedCampaign("حملة سليمة", fine);

    const run = await runJob(t.db, "marketing.campaigns.release", NOW + 60_000, { env: ENV });
    expect(run.status).toBe("failed");
    expect(run.stats).toMatchObject({ failed: 1 });
    expect(run.error).toContain(brokenId);
    expect(await campaignStatus(brokenId)).toBe("scheduled");
    expect(await campaignStatus(fineId)).toBe("sending");
    await t.d1.prepare("UPDATE campaigns SET status = 'cancelled' WHERE id = ?").bind(brokenId).run();
  });
});

// ───────────────────────────────────────────────────────────────── 16.02 cart reminders (every five minutes)

describe("marketing.cart_reminders.prepare", () => {
  test("an abandoned cart of a consenting customer gets one held reminder with the store's link; two runs at once and the next run add none; a demo customer's cart is left alone", async () => {
    const item = await shelf("carts");
    const real = await account();
    const demo = await account({ isDemo: true });
    const silent = await account({ consent: false });
    const realCart = await abandonedCart(real.id, item);
    const demoCart = await abandonedCart(demo.id, item);
    const silentCart = await abandonedCart(silent.id, item);
    const fresh = await abandonedCart((await account()).id, item, 30 * 60_000); // touched half an hour ago: not left yet

    const both = await Promise.all([runJob(t.db, "marketing.cart_reminders.prepare", NOW, { env: ENV }), runJob(t.db, "marketing.cart_reminders.prepare", NOW, { env: ENV })]);
    expect(both.every((run) => run.status === "succeeded")).toBe(true);
    const reminders = await t.db.select({ cartId: cartReminders.cartId, status: cartReminders.status, outboxId: cartReminders.outboxId }).from(cartReminders);
    const cartsReminded = reminders.map((row) => row.cartId);
    expect(cartsReminded.filter((id) => id === realCart)).toHaveLength(1);
    for (const left of [demoCart, silentCart, fresh]) expect(cartsReminded).not.toContain(left);
    const reminder = reminders.find((row) => row.cartId === realCart)!;
    expect(reminder.status).toBe("held");
    const [message] = await rows<{ status: string; template: string; payload: string }>("SELECT status, template, payload FROM outbox WHERE id = ?", reminder.outboxId);
    expect(message).toMatchObject({ status: "held", template: "cart_reminder" });
    expect((JSON.parse(message.payload) as { link: string }).link.startsWith(`${ORIGIN}/cart?`)).toBe(true);
    expect(await rows("SELECT actor_kind, actor_id FROM audit_events WHERE action = 'marketing.cart_reminder.prepare' AND actor_kind = 'system'")).toContainEqual({ actor_kind: "system", actor_id: "marketing.cart_reminders.prepare" });

    // nothing more to remind: a run with nothing to do succeeds
    const next = await runJob(t.db, "marketing.cart_reminders.prepare", NOW + 5 * 60_000, { env: ENV });
    expect(next).toMatchObject({ status: "succeeded", error: null, stats: { prepared: 0 } });
    expect((await t.db.select({ cartId: cartReminders.cartId }).from(cartReminders).where(eq(cartReminders.cartId, realCart))).length).toBe(1);
  });

  test("D1 reads: without a cart it could remind (only demo, converted or reminded carts), the run stops at the cheap index check", async () => {
    const later = NOW + 30 * DAY; // every cart of the tests above is older than the 7-day window by then
    const item = await shelf("cartgate");
    const demo = await account({ isDemo: true });
    const demoCart = newId("crt");
    await t.db.insert(carts).values({ id: demoCart, tokenHash: newId("tok"), customerId: demo.id, createdAt: later - 4 * HOUR, updatedAt: later - 3 * HOUR });
    await t.db.insert(cartItems).values({ id: newId("cit"), cartId: demoCart, variantId: item.variantId, qty: 1, addedAt: later - 3 * HOUR });
    const gated = await runJob(t.db, "marketing.cart_reminders.prepare", later, { env: ENV });
    expect(gated).toMatchObject({ status: "succeeded", error: null, stats: { prepared: 0, candidates: 0 } });

    const person = await account();
    const cartId = newId("crt");
    await t.db.insert(carts).values({ id: cartId, tokenHash: newId("tok"), customerId: person.id, createdAt: later - 4 * HOUR, updatedAt: later - 3 * HOUR });
    await t.db.insert(cartItems).values({ id: newId("cit"), cartId, variantId: item.variantId, qty: 1, addedAt: later - 3 * HOUR });
    const open = await runJob(t.db, "marketing.cart_reminders.prepare", later + 60_000, { env: ENV });
    expect(open).toMatchObject({ status: "succeeded", error: null, stats: { prepared: 1 } });
    expect(open.stats.candidates).toBeUndefined();
    expect(await t.db.select().from(cartReminders).where(eq(cartReminders.cartId, cartId))).toHaveLength(1);
  });

  test("without the store's public origin no reminder is prepared", async () => {
    const item = await shelf("cartnoorigin");
    const person = await account();
    const cartId = await abandonedCart(person.id, item);
    const run = await runJob(t.db, "marketing.cart_reminders.prepare", NOW, {});
    expect(run).toMatchObject({ status: "skipped", stats: { reason: "no_public_origin" } });
    expect(await t.db.select().from(cartReminders).where(eq(cartReminders.cartId, cartId))).toHaveLength(0);
  });
});
