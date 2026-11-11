/**
 * Admin module 13 "devices" (owner: admin devices) — the trade-in pipeline and the module's rules, on a real local D1
 * with the demo catalogue (createTestDb + seedDemo) and the built-in roles. Fixtures are chosen by their properties
 * (a device model the store buys, a serial-tracked variant of it), never by slug.
 *
 *   · the workflow end to end: a storefront request → appointment → inspection (checklist, grade, variant, serial,
 *     ownership and account lock) → final offer (made by a person; the estimate is never one) → the shopper's own
 *     answer (respondToOffer) → data wipe → payout as store credit (creditWallet: wallet + Dr inventory / Cr wallet)
 *     or cash (Dr inventory / Cr cash) → the used unit with its acquisition cost [P] and the registry serial; the
 *     tracking page reads the history events this module writes
 *   · refusals: no offer before a complete inspection, ownership and a free account lock; an open offer never changes
 *     under the customer; no payout before acceptance and the wipe; store credit needs an account
 *   · idempotency: a repeated payout pays once (one wallet entry, one unit); a repeated counter trade-in opens one
 *   · four eyes on exceptions: an offer above the guide (or without a guide) is paid out by someone else
 *   · cancel refused once money went out; expiry of offers; a serial the store sold before comes back released
 *   · authorization per role (manager, inventory, support, content, cashier) and the route action's intent checks;
 *     Arabic-Indic digits in money fields
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { tradeInAction } from "~/routes/admin/devices/trade-in.server";
import { type EmployeeActor } from "~/server/actor";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, journalEntries, journalLines, orderItemSerials, products, serials, tradeInEvents, tradeIns, usedUnits, variants, walletLedger, warranties } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { accountId, DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { isDbError } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { activeTemplates, buildChecklist } from "~/server/services/admin/devices/shared.server";
import {
  cancelTradeIn,
  confirmWipe,
  CounterTradeInInput,
  counterTradeInId,
  deviceQueueCounts,
  expireTradeInOffers,
  getTradeInDetail,
  listTradeIns,
  makeOffer,
  openCounterTradeIn,
  payOut,
  payoutWalletKey,
  priceDifference,
  recordAnswer,
  recordInspection,
  scheduleInspection,
  valuationOf,
} from "~/server/services/admin/devices/tradeins.server";
import { baghdadParts, pipelineStep, parseTradeInFilters, parseWhole, type TemplateOption } from "~/server/services/admin/devices/types";
import { getUsedUnitDetail, listUsedUnits } from "~/server/services/admin/devices/used.server";
import { createTradeIn, getTradeInByRef, listTradeInDevices, respondToOffer, type TradeInAnswers, type TradeInDevice } from "~/server/services/tradein.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { kvBlobStore, type BlobStore } from "~/server/storage.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MIN = 60_000;
const DAY = 86_400_000;
const urls = { file: (id: string) => `/admin/devices/files/${id}` };

let t: TestDb;
let make: Fixtures;
let store: BlobStore;
let device: TradeInDevice;
let template: TemplateOption;
let variant: { id: string; trackSerials: boolean; sku: string };
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  store = kvBlobStore(t.kv);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "fulfillment", "support", "inventory", "cashier", "content"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
  // A device the store buys: a home console (no built-in screen) whose guide prices accessories, with a serial-tracked variant.
  const devices = await listTradeInDevices(t.db, "ar");
  const templates = await activeTemplates(t.db, "ar");
  for (const candidate of devices) {
    const found = await t.db
      .select({ id: variants.id, trackSerials: variants.trackSerials, sku: variants.sku })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(eq(products.deviceModelId, candidate.id), eq(variants.trackSerials, true), eq(products.kind, "console")))
      .get();
    const tpl = templates.find((entry) => entry.kind === candidate.kind);
    if (found && tpl && !candidate.hasScreen && candidate.accessories.length > 0) {
      device = candidate;
      variant = found;
      template = tpl;
      break;
    }
  }
  if (!device) throw new Error("the demo seed has no home console with a guide and a serial-tracked variant");
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
const custom = (permissions: Permission[], id = as("manager").id): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

let phones = 0;
const phone = () => `0772${String(1_000_000 + ++phones).slice(-7)}`;
let serialNo = 0;
const serial = () => `TI-SN-${String(++serialNo).padStart(5, "0")}`;

function answersFor(d: TradeInDevice): TradeInAnswers {
  return { power: "works", body: "like_new", ...(d.hasScreen ? { screen: "perfect" as const } : {}), included: [...d.accessories], account: "yes" };
}

/** Every item answered so the checklist is complete: pass, 90 %, or a word. */
function passing(tpl: TemplateOption): Record<string, { result?: string; value?: string }> {
  return Object.fromEntries(tpl.items.map((item) => [item.key, item.input === "percent" ? { value: "90" } : item.input === "text" ? { value: "ok" } : { result: "pass" }]));
}

async function storefrontRequest(options: { customerId?: string | null; storeMode?: "demo" | "live" } = {}) {
  return createTradeIn(t.db, { customerId: options.customerId ?? null, ip: null, locale: "ar", storeMode: options.storeMode ?? "demo" }, { idempotencyKey: randomToken(), device: device.slug, answers: answersFor(device), contactName: "زبون المقايضة", phone: phone(), ownershipConfirmed: true }, NOW);
}

async function inspected(options: { customerId?: string | null; storeMode?: "demo" | "live"; grade?: "A+" | "A" | "B" | "C" } = {}) {
  const made = await storefrontRequest(options);
  await recordInspection(
    t.db,
    as("manager"),
    { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: serial(), grade: options.grade ?? "A", answers: passing(template), included: [...device.accessories], ownershipOk: true, accountLockOk: true },
    NOW + MIN,
  );
  return made;
}

async function suggestion(ref: string): Promise<number> {
  const detail = await getTradeInDetail(t.db, as("manager"), ref, "ar", NOW + 2 * MIN, urls);
  if (detail.valuation?.suggestedIqd == null) throw new Error("no suggestion");
  return detail.valuation.suggestedIqd;
}

/** Inspected → offered at the guide's suggestion (or `amount`) → accepted by the shopper → wiped. */
async function acceptedAndWiped(options: { customerId?: string | null; payout?: "cash" | "store_credit"; amount?: number; offerBy?: EmployeeActor; storeMode?: "demo" | "live" } = {}) {
  const made = await inspected(options);
  const amount = options.amount ?? (await suggestion(made.ref));
  await makeOffer(t.db, options.offerBy ?? as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 7 }, NOW + 2 * MIN);
  await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: options.payout ?? "cash" }, NOW + 3 * MIN);
  await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
  return { ...made, amount };
}

describe("the trade-in workflow", () => {
  test("a storefront request goes through every step; the tracking page reads the history this module writes", async () => {
    const customerId = await make.customer();
    const made = await storefrontRequest({ customerId });
    const at = NOW + 2 * DAY;
    const day = new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
    await scheduleInspection(t.db, as("manager"), { tradeInId: made.tradeInId, day, time: "14:30", note: "اتصلنا بالعميل" }, NOW + MIN);
    let row = await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get();
    expect(row?.status).toBe("inspection_scheduled");
    const scheduledAt = row?.inspectionScheduledAt ?? 0;
    expect(new Date(scheduledAt + 3 * 3_600_000).toISOString().slice(11, 16)).toBe("14:30");

    await recordInspection(t.db, as("manager"), { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: " ti-sn-flow 1 ", grade: "A", answers: passing(template), included: [...device.accessories], ownershipOk: true, accountLockOk: true }, NOW + 2 * MIN);
    row = await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get();
    expect(row?.status).toBe("inspected");
    expect((row?.inspection as { serial?: string })?.serial).toBe("TI-SN-FLOW1");
    expect(row?.inspection?.checklist.completedAt).toBe(NOW + 2 * MIN);

    const detail = await getTradeInDetail(t.db, as("manager"), made.ref, "ar", NOW + 2 * MIN, urls);
    expect(detail.offerBlockers).toEqual([]);
    const amount = detail.valuation?.suggestedIqd as number;
    expect(amount).toBeGreaterThan(0);
    expect(amount % 1000).toBe(0);
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 5 }, NOW + 3 * MIN);

    // the shopper answers on the tracking page (the storefront's own service)
    await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "store_credit" }, NOW + 4 * MIN);
    expect(await failureOf(payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN))).toMatchObject({ code: "payout_wipe_required" });
    await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId, note: "سجّل العميل خروجه وأعدنا الضبط" }, NOW + 5 * MIN);
    const paid = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN);
    expect(paid).toMatchObject({ replayed: false, method: "store_credit" });

    // money: the wallet holds the offer, the books Dr inventory / Cr wallet liability
    expect(await getWalletBalance(t.db, customerId)).toBe(amount);
    const entry = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, payoutWalletKey(made.tradeInId))).get();
    expect(entry).toMatchObject({ kind: "trade_in_credit", amountIqd: amount, refType: "trade_in", refId: made.tradeInId });
    // stock: a used unit with its acquisition cost, its registry serial in stock
    const unit = await t.db.select().from(usedUnits).where(eq(usedUnits.tradeInId, made.tradeInId)).get();
    expect(unit).toMatchObject({ acquisitionCostIqd: amount, grade: "A", priceIqd: 0, source: "trade_in", variantId: variant.id, status: "ready", isDemo: true });
    expect(unit?.ownershipCheckedAt).not.toBeNull();
    expect(unit?.dataWipedAt).toBe(NOW + 5 * MIN);
    const sn = await t.db.select().from(serials).where(eq(serials.id, unit?.serialId as string)).get();
    expect(sn).toMatchObject({ serial: "TI-SN-FLOW1", status: "in_stock", source: "trade_in", sourceRef: made.tradeInId, costIqd: amount });

    // the shopper's tracking page shows the staff steps
    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW + 7 * MIN);
    const kinds = view?.history.map((entry) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "paid"]));
    expect(view?.history.find((entry) => entry.kind === "inspection_scheduled")?.scheduledAt).toBe(scheduledAt);
    expect(view?.history.find((entry) => entry.kind === "offered")?.amountIqd).toBe(amount);
    expect(view?.status).toBe("paid");
    // staff-internal events never reach the shopper
    expect(kinds).not.toContain("data_wiped");
    // the pipeline: paid, unit not listed yet → the relisting step
    expect(pipelineStep({ status: "paid", inspected: true, dataWiped: true, unitListed: false })).toBe(6);
  });

  test("a cash payout posts Dr inventory / Cr cash once; a repeat pays nothing again", async () => {
    const made = await acceptedAndWiped({ payout: "cash" });
    const first = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN);
    const again = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 7 * MIN);
    expect(again).toMatchObject({ replayed: true, usedUnitId: first.usedUnitId });
    const entries = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `trade_in:${made.tradeInId}:payout`));
    expect(entries).toHaveLength(1);
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entries[0].id));
    expect(lines.find((line) => line.accountId === accountId("inventory"))?.debitIqd).toBe(made.amount);
    expect(lines.find((line) => line.accountId === accountId("cash"))?.creditIqd).toBe(made.amount);
    expect(await t.db.select().from(usedUnits).where(eq(usedUnits.tradeInId, made.tradeInId))).toHaveLength(1);
  });

  test("store credit needs an account; a guest's acceptance pays cash", async () => {
    const made = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: await suggestion(made.ref) }, NOW + 2 * MIN);
    expect(await failureOf(recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "accept", payout: "store_credit" }, NOW + 3 * MIN))).toMatchObject({ code: "payout_requires_account" });
    await recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    const event = await t.db.select().from(tradeInEvents).where(and(eq(tradeInEvents.tradeInId, made.tradeInId), eq(tradeInEvents.kind, "accepted"))).get();
    expect(event?.data).toMatchObject({ payout: "cash", inPerson: true, grade: "A" });
    await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
    expect(await failureOf(payOut(t.db, as("owner"), { tradeInId: made.tradeInId, method: "store_credit", locationId: DEFAULT_LOCATION_ID, reason: "طلب العميل" }, NOW + 5 * MIN))).toMatchObject({ code: "payout_requires_account" });
    // another method than the customer's needs a reason
    const customerId = await make.customer();
    const other = await acceptedAndWiped({ customerId, payout: "store_credit" });
    expect(await failureOf(payOut(t.db, as("owner"), { tradeInId: other.tradeInId, method: "cash", locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN))).toMatchObject({ code: "invalid", fields: { reason: "reason_required" } });
    expect(await payOut(t.db, as("owner"), { tradeInId: other.tradeInId, method: "cash", locationId: DEFAULT_LOCATION_ID, reason: "فضّل النقد عند الاستلام" }, NOW + 6 * MIN)).toMatchObject({ method: "cash" });
  });

  test("no offer before a complete inspection with ownership and no account lock; the database refuses an offer without one", async () => {
    const made = await storefrontRequest();
    expect(await failureOf(makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 100_000 }, NOW + MIN))).toMatchObject({ code: "trade_in_not_open" });
    // incomplete checklist, no ownership
    await recordInspection(t.db, as("manager"), { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: serial(), grade: "B", answers: {}, included: [], ownershipOk: false, accountLockOk: true }, NOW + MIN);
    expect(await failureOf(makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 100_000 }, NOW + 2 * MIN))).toMatchObject({ code: "offer_ownership" });
    await recordInspection(t.db, as("manager"), { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: serial(), grade: "B", answers: {}, included: [], ownershipOk: true, accountLockOk: false }, NOW + 2 * MIN);
    expect(await failureOf(makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 100_000 }, NOW + 3 * MIN))).toMatchObject({ code: "offer_account_lock" });
    await recordInspection(t.db, as("manager"), { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: serial(), grade: "B", answers: {}, included: [], ownershipOk: true, accountLockOk: true }, NOW + 3 * MIN);
    expect(await failureOf(makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 100_000 }, NOW + 4 * MIN))).toMatchObject({ code: "offer_checklist_incomplete" });
    // the database's own rule: a final offer needs offered_by, offered_at and a recorded inspection
    const raw = await storefrontRequest();
    const refused = await t.db
      .update(tradeIns)
      .set({ finalOfferIqd: 50_000, offeredBy: as("manager").id, offeredAt: NOW, status: "offered" })
      .where(eq(tradeIns.id, raw.tradeInId))
      .then(() => null, (error: unknown) => error);
    expect(isDbError(refused, "TRADE_IN_OFFER_NOT_ALLOWED")).toBe(true);
    // offers are whole thousands, Arabic-Indic digits accepted
    const ok = await inspected();
    expect(await failureOf(makeOffer(t.db, as("manager"), { tradeInId: ok.tradeInId, amountIqd: "250500" }, NOW + 2 * MIN))).toMatchObject({ code: "invalid", fields: { amountIqd: "offer_step" } });
    await makeOffer(t.db, as("manager"), { tradeInId: ok.tradeInId, amountIqd: "٢٥٠٬٠٠٠" }, NOW + 2 * MIN);
    expect((await t.db.select().from(tradeIns).where(eq(tradeIns.id, ok.tradeInId)).get())?.finalOfferIqd).toBe(250_000);
    expect(parseWhole("١٣١٠.٥")).toBeNaN();
  });

  test("an open offer never changes under the customer; a declined or expired one is replaced by a new offer", async () => {
    const made = await inspected();
    const amount = await suggestion(made.ref);
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 1 }, NOW + 2 * MIN);
    expect(await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 1 }, NOW + 2 * MIN)).toMatchObject({ replayed: true });
    expect(await failureOf(makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount + 1000 }, NOW + 3 * MIN))).toMatchObject({ code: "offer_open" });
    // a day later the offer is past its validity: the shopper cannot accept, staff can replace it
    const later = NOW + 2 * MIN + DAY + MIN;
    await expect(respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "cash" }, later)).rejects.toMatchObject({ code: "trade_in_offer_closed" });
    expect((await listTradeIns(t.db, as("manager"), parseTradeInFilters(new URLSearchParams(`q=${made.ref}`)), "ar", later)).rows[0]).toMatchObject({ offerExpired: true });
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount - 1000, validDays: 3 }, later);
    const events = await t.db.select({ kind: tradeInEvents.kind }).from(tradeInEvents).where(eq(tradeInEvents.tradeInId, made.tradeInId));
    expect(events.map((event) => event.kind).filter((kind) => kind === "offered" || kind === "expired")).toEqual(["offered", "expired", "offered"]);
    // decline in person, then a new offer
    await recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "decline", reason: "يريد سعراً أعلى" }, later + MIN);
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 3 }, later + 2 * MIN);
    expect((await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get())?.status).toBe("offered");
  });

  test("expireTradeInOffers closes offers past their date (the job), with an expired event", async () => {
    const made = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: 90_000, validDays: 1 }, NOW + 2 * MIN);
    expect((await expireTradeInOffers(t.db, NOW + 3 * MIN)).expired).toBe(0);
    const result = await expireTradeInOffers(t.db, NOW + 2 * DAY);
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect((await t.db.select().from(tradeIns).where(eq(tradeIns.id, made.tradeInId)).get())?.status).toBe("expired");
  });

  test("four eyes on exceptions: an offer above the guide is paid out by another employee", async () => {
    const made = await inspected();
    const suggested = await suggestion(made.ref);
    await makeOffer(t.db, as("manager"), { tradeInId: made.tradeInId, amountIqd: suggested + 20_000 }, NOW + 2 * MIN);
    await recordAnswer(t.db, as("manager"), { tradeInId: made.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
    const detail = await getTradeInDetail(t.db, as("manager"), made.ref, "ar", NOW + 5 * MIN, urls);
    expect(detail.can.payoutNeedsSecond).toBe(true);
    expect(detail.payoutBlockers).toContain("payout_second_person");
    expect(await failureOf(payOut(t.db, as("manager"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN))).toMatchObject({ code: "payout_second_person", status: 403 });
    expect(await payOut(t.db, as("manager2"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN)).toMatchObject({ replayed: false });
    // within the guide, the person who made the offer may pay it out
    const within = await acceptedAndWiped({ payout: "cash" });
    expect(await payOut(t.db, as("manager"), { tradeInId: within.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN)).toMatchObject({ replayed: false });
  });

  test("cancelling: before an offer the inspector may; never once money went out", async () => {
    const made = await storefrontRequest();
    expect(await failureOf(cancelTradeIn(t.db, as("support"), { tradeInId: made.tradeInId, reason: "لم يحضر" }, NOW + MIN))).toMatchObject({ code: "forbidden" });
    await cancelTradeIn(t.db, custom(["devices.tradein.inspect"]), { tradeInId: made.tradeInId, reason: "لم يحضر العميل" }, NOW + MIN);
    expect((await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW + 2 * MIN))?.status).toBe("cancelled");
    // an offered one needs devices.tradein.offer
    const offered = await inspected();
    await makeOffer(t.db, as("manager"), { tradeInId: offered.tradeInId, amountIqd: 80_000 }, NOW + 2 * MIN);
    expect(await failureOf(cancelTradeIn(t.db, custom(["devices.tradein.inspect"]), { tradeInId: offered.tradeInId, reason: "تراجع العميل" }, NOW + 3 * MIN))).toMatchObject({ code: "forbidden" });
    // a credit already written for the trade-in (a payout stopped half way) blocks the cancel
    const customerId = await make.customer();
    const halfway = await acceptedAndWiped({ customerId, payout: "store_credit" });
    await t.db.insert(walletLedger).values({ id: `wal_${randomToken(8)}`, customerId, amountIqd: halfway.amount, kind: "trade_in_credit", refType: "trade_in", refId: halfway.tradeInId, actorKind: "system", actorId: "test", idempotencyKey: payoutWalletKey(halfway.tradeInId), at: NOW });
    expect(await failureOf(cancelTradeIn(t.db, as("manager"), { tradeInId: halfway.tradeInId, reason: "تراجع العميل" }, NOW + 6 * MIN))).toMatchObject({ code: "payout_started" });
    // …and the payout then completes without crediting twice
    expect(await payOut(t.db, as("owner"), { tradeInId: halfway.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 7 * MIN)).toMatchObject({ method: "store_credit" });
    expect(await getWalletBalance(t.db, customerId)).toBe(halfway.amount);
  });

  test("a counter trade-in: idempotent on the form key; a game by SKU has no guide and needs a second person to pay", async () => {
    const key = randomToken(18);
    const raw = { idempotencyKey: key, phone: "0770 ٣٢١ ٤٥٦٧", contactName: "زبون المحل", deviceModelId: device.id, ownershipDeclared: true };
    const first = await openCounterTradeIn(t.db, as("manager"), raw, NOW, "demo");
    const again = await openCounterTradeIn(t.db, as("manager"), raw, NOW + MIN, "demo");
    expect(again).toMatchObject({ replayed: true, ref: first.ref, tradeInId: await counterTradeInId(key) });
    expect(await failureOf(openCounterTradeIn(t.db, as("manager"), { ...raw, phone: "07709998877" }, NOW, "demo"))).toMatchObject({ code: "idempotency_conflict" });
    expect(await failureOf(openCounterTradeIn(t.db, as("manager"), { ...raw, idempotencyKey: randomToken(18), deviceModelId: undefined }, NOW, "demo"))).toMatchObject({ code: "invalid" });
    expect(await failureOf(openCounterTradeIn(t.db, as("support"), { ...raw, idempotencyKey: randomToken(18) }, NOW, "demo"))).toMatchObject({ code: "forbidden" });
    const event = await t.db.select().from(tradeInEvents).where(and(eq(tradeInEvents.tradeInId, first.tradeInId), eq(tradeInEvents.kind, "submitted"))).get();
    expect(event).toMatchObject({ actorKind: "employee", actorId: as("manager").id });

    // a used game: a catalogue SKU, the game checklist, no guide → no suggestion → a second person pays
    const game = await t.db.select({ id: variants.id, sku: variants.sku }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(and(eq(products.kind, "game"), eq(products.mediaFormat, "physical"))).get();
    if (!game) throw new Error("no physical game in the demo seed");
    const opened = await openCounterTradeIn(t.db, as("manager"), { idempotencyKey: randomToken(18), phone: phone(), code: game.sku.toLowerCase(), ownershipDeclared: true }, NOW, "demo");
    const gameTemplate = (await activeTemplates(t.db, "ar")).find((entry) => entry.kind === "game") as TemplateOption;
    expect(gameTemplate.items.map((item) => item.key)).toEqual(expect.arrayContaining(["media", "case", "region"]));
    await recordInspection(t.db, as("manager"), { tradeInId: opened.tradeInId, templateId: gameTemplate.id, variantId: game.id, grade: "A", answers: passing(gameTemplate), included: [], ownershipOk: true, accountLockOk: true }, NOW + MIN);
    const detail = await getTradeInDetail(t.db, as("manager"), opened.ref, "ar", NOW + MIN, urls);
    expect(detail.device.kind).toBe("game");
    expect(detail.valuation).toBeNull();
    await makeOffer(t.db, as("manager"), { tradeInId: opened.tradeInId, amountIqd: 15_000 }, NOW + 2 * MIN);
    await recordAnswer(t.db, as("manager"), { tradeInId: opened.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    await confirmWipe(t.db, as("manager"), { tradeInId: opened.tradeInId, note: "لا بيانات للمسح" }, NOW + 4 * MIN);
    expect(await failureOf(payOut(t.db, as("manager"), { tradeInId: opened.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN))).toMatchObject({ code: "payout_second_person" });
    const paid = await payOut(t.db, as("owner"), { tradeInId: opened.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
    const unit = await t.db.select().from(usedUnits).where(eq(usedUnits.id, paid.usedUnitId)).get();
    expect(unit).toMatchObject({ serialId: null, acquisitionCostIqd: 15_000, variantId: game.id });
  });

  test("a unit the store sold before comes back: its old sale lets the serial go and its running warranty ends", async () => {
    const product = await make.product({ trackSerials: true, priceIqd: 600_000 });
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], { status: "delivered" });
    const serialId = `ser_${randomToken(8)}`;
    await t.db.insert(serials).values({ id: serialId, serial: "RE-SOLD-777", variantId: product.variantId, status: "sold", source: "purchase", sourceRef: "rcv-x", createdAt: NOW, updatedAt: NOW });
    await t.db.insert(orderItemSerials).values({ orderItemId: order.itemIds[0], serialId, attachedAt: NOW });
    await t.db.insert(warranties).values({ id: `wty_${randomToken(8)}`, orderItemId: order.itemIds[0], serialId, startsAt: NOW - 30 * DAY, endsAt: NOW + 300 * DAY, status: "active" });
    const opened = await openCounterTradeIn(t.db, as("manager"), { idempotencyKey: randomToken(18), phone: phone(), code: product.sku, ownershipDeclared: true }, NOW, "demo");
    const consoleTemplate = (await activeTemplates(t.db, "ar")).find((entry) => entry.kind === "console") as TemplateOption;
    // a serial of another variant is refused
    const other = await make.product({ trackSerials: true });
    expect(await failureOf(recordInspection(t.db, as("manager"), { tradeInId: opened.tradeInId, templateId: consoleTemplate.id, variantId: other.variantId, serial: "RE-SOLD-777", grade: "B", answers: passing(consoleTemplate), included: [], ownershipOk: true, accountLockOk: true }, NOW + MIN))).toMatchObject({ code: "invalid" });
    await recordInspection(t.db, as("manager"), { tradeInId: opened.tradeInId, templateId: consoleTemplate.id, variantId: product.variantId, serial: "re-sold-777", grade: "B", answers: passing(consoleTemplate), included: [], ownershipOk: true, accountLockOk: true }, NOW + MIN);
    const detail = await getTradeInDetail(t.db, as("manager"), opened.ref, "ar", NOW + MIN, urls);
    expect(detail.serialOrigin).toMatchObject({ status: "sold", orderRef: order.ref });
    await makeOffer(t.db, as("manager"), { tradeInId: opened.tradeInId, amountIqd: 300_000 }, NOW + 2 * MIN);
    await recordAnswer(t.db, as("manager"), { tradeInId: opened.tradeInId, decision: "accept", payout: "cash" }, NOW + 3 * MIN);
    await confirmWipe(t.db, as("manager"), { tradeInId: opened.tradeInId }, NOW + 4 * MIN);
    await payOut(t.db, as("owner"), { tradeInId: opened.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 5 * MIN);
    expect(await t.db.select().from(serials).where(eq(serials.id, serialId)).get()).toMatchObject({ status: "in_stock", source: "trade_in", sourceRef: opened.tradeInId, costIqd: 300_000 });
    expect((await t.db.select().from(orderItemSerials).where(eq(orderItemSerials.serialId, serialId)).get())?.releasedAt).toBe(NOW + 5 * MIN);
    expect(await t.db.select().from(warranties).where(eq(warranties.serialId, serialId)).get()).toMatchObject({ status: "void", voidReason: `traded_in:${opened.ref}` });
    // the same serial cannot be taken in twice while the store holds it
    const again = await openCounterTradeIn(t.db, as("manager"), { idempotencyKey: randomToken(18), phone: phone(), code: product.sku, ownershipDeclared: true }, NOW, "demo");
    expect(await failureOf(recordInspection(t.db, as("manager"), { tradeInId: again.tradeInId, templateId: consoleTemplate.id, variantId: product.variantId, serial: "RE-SOLD-777", grade: "B", answers: passing(consoleTemplate), included: [], ownershipOk: true, accountLockOk: true }, NOW + 6 * MIN))).toMatchObject({ code: "invalid", fields: { serial: "serial_in_stock" } });
  });

  test("one serial in one open trade-in", async () => {
    const a = await storefrontRequest();
    const b = await storefrontRequest();
    await recordInspection(t.db, as("manager"), { tradeInId: a.tradeInId, templateId: template.id, variantId: variant.id, serial: "DUP-SN-1", grade: "A", answers: passing(template), included: [], ownershipOk: true, accountLockOk: true }, NOW + MIN);
    expect(await failureOf(recordInspection(t.db, as("manager"), { tradeInId: b.tradeInId, templateId: template.id, variantId: variant.id, serial: "dup-sn-1", grade: "A", answers: passing(template), included: [], ownershipOk: true, accountLockOk: true }, NOW + MIN))).toMatchObject({ code: "invalid", fields: { serial: "serial_in_trade_in" } });
  });
});

describe("valuation and the price difference (pure)", () => {
  test("grade share of the base, less missing accessories, rounded down to thousands; never negative", () => {
    const guide = { id: "g", baseIqd: 401_234, multipliers: { "A+": 10_000, A: 9_000, B: 7_500 }, deductions: { missing_controller: 40_000, missing_hdmi_cable: 5_000 }, updatedAt: NOW };
    expect(valuationOf(guide, "A", ["hdmi_cable"])).toMatchObject({ gradeValueIqd: 361_110, deductions: [{ key: "controller", amountIqd: 40_000 }], suggestedIqd: 321_000 });
    expect(valuationOf(guide, "C", []).suggestedIqd).toBeNull();
    expect(valuationOf({ ...guide, baseIqd: 10_000 }, "B", []).suggestedIqd).toBe(0);
    expect(priceDifference({ kind: "new", label: "x", sku: "X", priceIqd: 500_000 }, 321_000)).toMatchObject({ differenceIqd: 179_000, covered: false });
    expect(priceDifference({ kind: "used", label: "x", sku: "X", priceIqd: 300_000 }, 321_000)).toMatchObject({ differenceIqd: -21_000, covered: true });
  });

  test("the checklist is complete only when every required item is answered; percents accept Arabic-Indic digits", () => {
    const tpl = { id: "itpl_x", items: [{ key: "power", label: { ar: "تشغيل" }, input: "pass_fail" as const, required: true }, { key: "battery", label: { ar: "بطارية" }, input: "percent" as const, required: true }, { key: "notes", label: { ar: "ملاحظة" }, input: "text" as const, required: false }] };
    const clean = (value: string) => value;
    expect(buildChecklist(tpl, { power: { result: "pass" } }, "e", NOW, clean).complete).toBe(false);
    const done = buildChecklist(tpl, { power: { result: "pass" }, battery: { value: "٨٧" } }, "e", NOW, clean);
    expect(done).toMatchObject({ complete: true, batteryPct: 87 });
    expect(done.checklist.completedAt).toBe(NOW);
    expect(() => buildChecklist(tpl, { battery: { value: "120" } }, "e", NOW, clean)).toThrow();
    expect(() => buildChecklist(tpl, { power: { result: "maybe" } }, "e", NOW, clean)).toThrow();
  });

  test("the counter form marks every missing field at once; appointments are edited in Baghdad wall-clock time", () => {
    const empty = CounterTradeInInput.safeParse({ idempotencyKey: "k".repeat(18), phone: "", contactName: "", notes: "" });
    const issues = empty.success ? [] : empty.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
    expect(issues).toEqual(expect.arrayContaining(["phone:required", "device:device_required", "ownershipDeclared:ownership_required"]));
    const both = CounterTradeInInput.safeParse({ idempotencyKey: "k".repeat(18), phone: "07901234567", deviceModelId: "dm_x", code: "PS5-PRO-2TB", ownershipDeclared: true });
    expect(both.success ? [] : both.error.issues.map((issue) => issue.path.join("."))).toContain("device");
    // 21:30 UTC is already the next day in Baghdad (UTC+3, no daylight saving).
    expect(baghdadParts(Date.UTC(2026, 10, 11, 21, 30))).toEqual({ day: "2026-11-12", time: "00:30" });
  });
});

describe("authorization and protected fields", () => {
  test("each role sees only what it may: support reads trade-ins, inventory works on units, content and cashier nothing", async () => {
    const made = await inspected();
    expect((await listTradeIns(t.db, as("support"), parseTradeInFilters(new URLSearchParams()), "ar", NOW)).total).toBeGreaterThan(0);
    for (const key of ["inventory", "content", "cashier", "fulfillment"] as const) {
      expect(await failureOf(listTradeIns(t.db, as(key), parseTradeInFilters(new URLSearchParams()), "ar", NOW))).toMatchObject({ code: "forbidden", status: 403 });
      expect(await failureOf(getTradeInDetail(t.db, as(key), made.ref, "ar", NOW, urls))).toMatchObject({ code: "forbidden" });
    }
    expect(await failureOf(makeOffer(t.db, as("support"), { tradeInId: made.tradeInId, amountIqd: 50_000 }, NOW + 2 * MIN))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(recordInspection(t.db, as("support"), { tradeInId: made.tradeInId, templateId: template.id, answers: {}, included: [], ownershipOk: true, accountLockOk: true }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(payOut(t.db, as("finance"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW))).toMatchObject({ code: "forbidden" });
    // the support role sees the phone masked; the detail never carries a [P] field
    const detail = await getTradeInDetail(t.db, as("support"), made.ref, "ar", NOW, urls);
    expect(detail.customer.phone?.full).toBe(true); // support holds customer.phone.read_full
    const masked = await getTradeInDetail(t.db, custom(["devices.tradein.read"]), made.ref, "ar", NOW, urls);
    expect(masked.customer.phone?.full).toBe(false);
    expect(masked.customer.phone?.display).toMatch(/•/);
    expect(JSON.stringify(masked)).not.toMatch(/acquisitionCost|costIqd/);
    expect(masked.can).toMatchObject({ inspect: false, offer: false, payout: false });
    // queue counts: null for what the employee cannot act on
    const counts = await deviceQueueCounts(t.db, as("inventory"), NOW);
    expect(counts).toMatchObject({ toInspect: null, toOffer: null, toPay: null });
    expect(typeof counts.unitsToInspect).toBe("number");
    expect(counts.toList).toBeNull();
  });

  test("the acquisition cost is absent without cost.read, the margin without profit.read (lists and detail)", async () => {
    const made = await acceptedAndWiped({ payout: "cash" });
    const paid = await payOut(t.db, as("owner"), { tradeInId: made.tradeInId, locationId: DEFAULT_LOCATION_ID }, NOW + 6 * MIN);
    const inventoryList = await listUsedUnits(t.db, as("inventory"), { view: "all", q: "", status: null, grade: null, page: 1 }, "ar");
    expect(inventoryList.withCost).toBe(false);
    expect(inventoryList.rows.every((row) => !("acquisitionCostIqd" in row))).toBe(true);
    const managerList = await listUsedUnits(t.db, as("manager"), { view: "all", q: "", status: null, grade: null, page: 1 }, "ar");
    expect(managerList.rows.find((row) => row.id === paid.usedUnitId)?.acquisitionCostIqd).toBe(made.amount);
    const blind = await getUsedUnitDetail(t.db, as("inventory"), paid.usedUnitId, "ar", urls);
    expect("acquisitionCostIqd" in blind).toBe(false);
    expect("marginBps" in blind).toBe(false);
    expect(JSON.stringify(blind)).not.toContain(String(made.amount));
    const costOnly = await getUsedUnitDetail(t.db, custom(["devices.registry.read", "cost.read"]), paid.usedUnitId, "ar", urls);
    expect(costOnly.acquisitionCostIqd).toBe(made.amount);
    expect("marginBps" in costOnly).toBe(false);
    const both = await getUsedUnitDetail(t.db, as("manager"), paid.usedUnitId, "ar", urls);
    expect("marginBps" in both).toBe(true);
    // a role with no devices permission cannot open the unit at all
    expect(await failureOf(getUsedUnitDetail(t.db, as("content"), paid.usedUnitId, "ar", urls))).toMatchObject({ code: "forbidden" });
  });

  test("the route action checks each intent's permission before reading anything; unknown intents are 400", async () => {
    const made = await inspected();
    const session = (actor: EmployeeActor): EmployeeSession =>
      ({
        employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
        actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
        roles: [],
        session: { id: "s", createdAt: NOW, expiresAt: NOW + DAY, mfaOk: true },
      }) as EmployeeSession;
    const form = (entries: Record<string, string>) => {
      const data = new FormData();
      for (const [key, value] of Object.entries(entries)) data.set(key, value);
      return data;
    };
    const ctx = { locale: "en" as const, now: NOW + 2 * MIN };
    expect(await tradeInAction(ctx, t.db, session(as("support")), made.ref, form({ intent: "offer", amountIqd: "100000" }), () => store)).toMatchObject({ ok: false, code: "forbidden", status: 403 });
    expect(await tradeInAction(ctx, t.db, session(as("inventory")), "TI-ZZZZZZZZ", form({ intent: "payout" }), () => store)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await tradeInAction(ctx, t.db, session(as("manager")), "TI-ZZZZZZZZ", form({ intent: "offer", amountIqd: "100000" }), () => store)).toMatchObject({ ok: false, code: "not_found", status: 404 });
    expect(await tradeInAction(ctx, t.db, session(as("manager")), made.ref, form({ intent: "drop-table" }), () => store)).toMatchObject({ ok: false, code: "invalid", status: 400 });
    const missing = await tradeInAction(ctx, t.db, session(as("manager")), made.ref, form({ intent: "inspect", templateId: template.id }), () => store);
    expect(missing).toMatchObject({ ok: false, code: "invalid", fields: { ownershipOk: "required", accountLockOk: "required" } });
    const offered = await tradeInAction(ctx, t.db, session(as("manager")), made.ref, form({ intent: "offer", amountIqd: "١٠٠٬٠٠٠", validDays: "٥" }), () => store);
    expect(offered).toMatchObject({ ok: true, intent: "offer" });
    const wrong = await tradeInAction(ctx, t.db, session(as("manager")), made.ref, form({ intent: "offer", amountIqd: "120000" }), () => store);
    expect(wrong).toMatchObject({ ok: false, code: "offer_open", message: expect.stringMatching(/open/i) });
  });
});
