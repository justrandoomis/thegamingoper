/**
 * Admin module 13 "devices" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · `toPay` (the module's "to pay" card) counted every accepted trade-in for anyone holding the payout or the verify
 *     permission: a wipe they cannot confirm, a payout before the wipe, their own above-guide offer that only a
 *     second person may pay. It now counts per person (payoutsWhere — the bell's rule, now the module's)
 *   · support staff (devices.tradein.read) saw every offer, valuation and payout amount — a paid offer IS the used
 *     unit's purchase cost. Only cost.read and the people who work the offer / payout see trade-in money now
 *   · a counter trade-in linked whichever store account had the typed number, unverified — store credit could then
 *     be paid into a stranger's wallet. It links only when the employee confirms the customer showed it is theirs
 *   · (POS 06) a cash trade-in payout taken from a till drawer never reached that drawer's figures: its blind count
 *     came out short by the payout. The payer may now pay from their own open shift — a drawer pay-out in the batch
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { cashMovements, employeeRoles, inventoryLocations, products, tradeIns, variants } from "~/server/db/schema";
import { newId } from "~/lib/ids";
import { saveRegister } from "~/server/services/admin/pos/registers.server";
import { closeShift, openShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { seedDemo } from "~/server/db/seed/demo";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { activeTemplates } from "~/server/services/admin/devices/shared.server";
import { confirmWipe, deviceQueueCounts, getTradeInDetail, listTradeIns, makeOffer, openCounterTradeIn, payOut, payoutDrawerKey, recordInspection } from "~/server/services/admin/devices/tradeins.server";
import { parseTradeInFilters, type TemplateOption } from "~/server/services/admin/devices/types";
import { createTradeIn, listTradeInDevices, respondToOffer, type TradeInAnswers, type TradeInDevice } from "~/server/services/tradein.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MIN = 60_000;
const urls = { file: (id: string) => `/admin/devices/files/${id}` };

let t: TestDb;
let make: Fixtures;
let device: TradeInDevice;
let template: TemplateOption;
let variant: { id: string; trackSerials: boolean; sku: string };
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedDemo(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "inventory", "support"] as const) staff[key] = await employee(key);
  staff.manager2 = await employee("manager");
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
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key, branchId: null };
}
const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const custom = (permissions: Permission[], id: string): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions), branchId: null });
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
const phone = () => `0775${String(2_000_000 + ++phones).slice(-7)}`;
let serialNo = 0;
const serial = () => `FU-SN-${String(++serialNo).padStart(5, "0")}`;
const answersFor = (d: TradeInDevice): TradeInAnswers => ({ power: "works", body: "like_new", ...(d.hasScreen ? { screen: "perfect" as const } : {}), included: [...d.accessories], account: "yes" });
const passing = (tpl: TemplateOption) => Object.fromEntries(tpl.items.map((item) => [item.key, item.input === "percent" ? { value: "90" } : item.input === "text" ? { value: "ok" } : { result: "pass" }]));

/** A storefront request, inspected and offered (at the guide's suggestion, or `amount`) by `offerBy`, then accepted by the shopper. */
async function accepted(options: { offerBy?: EmployeeActor; amount?: number } = {}) {
  const made = await createTradeIn(t.db, { customerId: null, ip: null, locale: "ar", storeMode: "demo" }, { idempotencyKey: randomToken(), device: device.slug, answers: answersFor(device), contactName: "زبون المتابعة", phone: phone(), ownershipConfirmed: true }, NOW);
  await recordInspection(t.db, as("manager"), { tradeInId: made.tradeInId, templateId: template.id, variantId: variant.id, serial: serial(), grade: "A", answers: passing(template), included: [...device.accessories], ownershipOk: true, accountLockOk: true }, NOW + MIN);
  const detail = await getTradeInDetail(t.db, as("manager"), made.ref, "ar", NOW + 2 * MIN, urls);
  const amount = options.amount ?? detail.valuation?.suggestedIqd;
  if (!amount) throw new Error("no suggestion");
  await makeOffer(t.db, options.offerBy ?? as("manager"), { tradeInId: made.tradeInId, amountIqd: amount, validDays: 7 }, NOW + 2 * MIN);
  await respondToOffer(t.db, { ref: made.ref, accessToken: made.accessToken }, { decision: "accept", payout: "cash" }, NOW + 3 * MIN);
  return { ...made, amount };
}

describe("admin 13 devices — follow-up", () => {
  test("toPay counts what this person can do on the trade-in page: the wipe, then the payout — never their own offer a second person pays", async () => {
    const verifier = custom(["devices.tradein.read", "devices.ownership.verify"], as("inventory").id);
    const payer = custom(["devices.tradein.read", "devices.tradein.payout"], as("support").id);
    const at = NOW + 5 * MIN;
    const base = { verifier: (await deviceQueueCounts(t.db, verifier, at)).toPay ?? 0, payer: (await deviceQueueCounts(t.db, payer, at)).toPay ?? 0, offerer: (await deviceQueueCounts(t.db, as("manager"), at)).toPay ?? 0, other: (await deviceQueueCounts(t.db, as("manager2"), at)).toPay ?? 0 };

    // accepted, not wiped: the verifier's step only (the payer cannot pay before the wipe)
    const first = await accepted();
    expect((await deviceQueueCounts(t.db, verifier, at)).toPay).toBe(base.verifier + 1);
    expect((await deviceQueueCounts(t.db, payer, at)).toPay).toBe(base.payer);
    // wiped: now the payer's, no longer the verifier's
    await confirmWipe(t.db, as("manager"), { tradeInId: first.tradeInId }, NOW + 4 * MIN);
    expect((await deviceQueueCounts(t.db, verifier, at)).toPay).toBe(base.verifier);
    expect((await deviceQueueCounts(t.db, payer, at)).toPay).toBe(base.payer + 1);

    // an offer above the guide's suggestion, wiped: its offerer may not pay it (payout_second_person) — a second payer may
    const second = await accepted({ offerBy: as("manager"), amount: first.amount + 10_000 });
    await confirmWipe(t.db, as("manager"), { tradeInId: second.tradeInId }, NOW + 4 * MIN);
    const offerer = (await deviceQueueCounts(t.db, as("manager"), at)).toPay ?? 0;
    const other = (await deviceQueueCounts(t.db, as("manager2"), at)).toPay ?? 0;
    expect(other - base.other).toBe(2);
    expect(offerer - base.offerer).toBe(1);
    expect((await getTradeInDetail(t.db, as("manager"), second.ref, "ar", at, urls)).payoutBlockers).toContain("payout_second_person");
  });

  test("review 2026-11-12: the 'to pay' card opens a list that holds exactly what it counts, for each person", async () => {
    // the module's rule (types.ts): "a card never counts what its list does not show" — toPay counts per person now,
    // so its card links to the per-person view ?view=to_pay (the "accepted" view keeps every accepted trade-in)
    const verifier = custom(["devices.tradein.read", "devices.ownership.verify"], as("inventory").id);
    const payer = custom(["devices.tradein.read", "devices.tradein.payout"], as("support").id);
    const at = NOW + 5 * MIN;
    const made = await accepted({ offerBy: as("manager") });
    const above = await accepted({ offerBy: as("manager"), amount: made.amount + 20_000 });
    await confirmWipe(t.db, as("manager"), { tradeInId: above.tradeInId }, NOW + 4 * MIN);
    const view = parseTradeInFilters(new URLSearchParams("view=to_pay"));
    expect(view.view).toBe("to_pay");
    for (const actor of [verifier, payer, as("manager"), as("manager2")]) {
      const counted = (await deviceQueueCounts(t.db, actor, at)).toPay;
      const listed = await listTradeIns(t.db, actor, view, "ar", at);
      expect(listed.total, actor.id).toBe(counted);
      expect(listed.rows.every((row) => row.status === "accepted")).toBe(true);
    }
    // the offerer's own above-guide offer is not theirs to pay: not in their list, in the second payer's
    const mine = await listTradeIns(t.db, as("manager"), view, "ar", at);
    const theirs = await listTradeIns(t.db, as("manager2"), view, "ar", at);
    expect(mine.rows.map((row) => row.ref)).not.toContain(above.ref);
    expect(theirs.rows.map((row) => row.ref)).toContain(above.ref);
    // someone with neither the payout nor the verify permission has nothing there
    expect((await listTradeIns(t.db, as("support"), view, "ar", at)).total).toBe(0);
  });

  test("support staff never see a trade-in's money (a paid offer is the unit's purchase cost); the offer's makers and cost readers do", async () => {
    const made = await accepted();
    const forSupport = await getTradeInDetail(t.db, as("support"), made.ref, "ar", NOW + 5 * MIN, urls);
    expect(forSupport.money).toBe(false);
    expect(forSupport.offer?.amountIqd).toBeNull();
    expect(forSupport.valuation).toBeNull();
    expect(forSupport.references).toEqual([]);
    expect(JSON.stringify(forSupport.history)).not.toContain(String(made.amount));
    expect(forSupport.history.find((entry) => entry.kind === "offered")?.data).toMatchObject({ amountHidden: true });
    const rows = await listTradeIns(t.db, as("support"), parseTradeInFilters(new URLSearchParams(`q=${made.ref}`)), "ar", NOW + 5 * MIN);
    expect(rows.rows.find((row) => row.ref === made.ref)?.offerIqd).toBeNull();

    const forManager = await getTradeInDetail(t.db, as("manager"), made.ref, "ar", NOW + 5 * MIN, urls);
    expect(forManager).toMatchObject({ money: true, offer: { amountIqd: made.amount } });
    expect(forManager.valuation?.suggestedIqd).toBe(made.amount);
    const managerRows = await listTradeIns(t.db, as("manager"), parseTradeInFilters(new URLSearchParams(`q=${made.ref}`)), "ar", NOW + 5 * MIN);
    expect(managerRows.rows.find((row) => row.ref === made.ref)?.offerIqd).toBe(made.amount);
  });

  test("a counter trade-in links a store account only when the employee confirms it is the customer's own", async () => {
    const number = phone();
    const customerId = await make.customer({ phoneE164: `+964${number.slice(1)}` });
    const form = (extra: Record<string, unknown> = {}) => ({ idempotencyKey: randomToken(), phone: number, contactName: "زبون في المحل", code: variant.sku, notes: "", ownershipDeclared: true, ...extra });
    const typed = await openCounterTradeIn(t.db, as("manager"), form(), NOW, "demo");
    expect((await t.db.select({ customerId: tradeIns.customerId }).from(tradeIns).where(eq(tradeIns.id, typed.tradeInId)).get())?.customerId).toBeNull();
    const confirmed = await openCounterTradeIn(t.db, as("manager"), form({ accountConfirmed: true }), NOW, "demo");
    expect((await t.db.select({ customerId: tradeIns.customerId }).from(tradeIns).where(eq(tradeIns.id, confirmed.tradeInId)).get())?.customerId).toBe(customerId);
    // confirming an account that does not exist is a field error, never a silent cash-only trade-in
    const nobody = await failureOf(openCounterTradeIn(t.db, as("manager"), { ...form({ accountConfirmed: true }), phone: phone() }, NOW, "demo"));
    expect(nobody.fields).toMatchObject({ accountConfirmed: "no_account_for_phone" });
  });
});

describe("admin 06 pos ← 13 devices — follow-up: a trade-in paid from the till", () => {
  test("a cash payout from the payer's own open drawer counts in that shift's expected cash; from the safe it does not", async () => {
    const storeId = newId("loc");
    await t.db.insert(inventoryLocations).values({ id: storeId, code: `FU-SHOP-${randomToken(4)}`, name: "Shop", kind: "store", isSellable: true });
    const register = await saveRegister(t.db, as("owner"), { code: `FU-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`, name: "Till", locationId: storeId, isActive: true }, NOW);
    const shift = await openShift(t.db, as("manager2"), { registerId: register.registerId, openingFloatIqd: 5_000_000, idempotencyKey: randomToken(16) }, NOW);
    // accepted and wiped (a manager offered at the guide's suggestion: anyone may pay it)
    const made = await accepted();
    await confirmWipe(t.db, as("manager"), { tradeInId: made.tradeInId }, NOW + 4 * MIN);
    const detail = await getTradeInDetail(t.db, as("manager2"), made.ref, "ar", NOW + 5 * MIN, urls);
    expect(detail.drawer).toEqual({ shiftId: shift.shiftId, register: expect.any(String) });
    await payOut(t.db, as("manager2"), { tradeInId: made.tradeInId, method: "cash", locationId: DEFAULT_LOCATION_ID, shiftId: shift.shiftId }, NOW + 5 * MIN);
    const moves = await t.db.select().from(cashMovements).where(eq(cashMovements.idempotencyKey, payoutDrawerKey(made.tradeInId)));
    expect(moves).toEqual([expect.objectContaining({ shiftId: shift.shiftId, kind: "pay_out", amountIqd: -made.amount })]);
    // the drawer's owner counts the float less the payout: no difference
    expect(await closeShift(t.db, as("manager2"), { shiftId: shift.shiftId, countedCashIqd: 5_000_000 - made.amount }, NOW + 6 * MIN)).toMatchObject({ needsReview: false });
    expect((await shiftReport(t.db, as("owner"), shift.shiftId, "ar")).varianceIqd).toBe(0);
    // a closed shift is no drawer to pay from
    const other = await accepted();
    await confirmWipe(t.db, as("manager"), { tradeInId: other.tradeInId }, NOW + 7 * MIN);
    const refused = await failureOf(payOut(t.db, as("manager2"), { tradeInId: other.tradeInId, method: "cash", locationId: DEFAULT_LOCATION_ID, shiftId: shift.shiftId }, NOW + 8 * MIN));
    expect(refused).toMatchObject({ code: "payout_drawer_invalid", fields: { shiftId: "payout_drawer_invalid" } });
    // from the safe: no drawer movement
    await payOut(t.db, as("manager2"), { tradeInId: other.tradeInId, method: "cash", locationId: DEFAULT_LOCATION_ID }, NOW + 9 * MIN);
    expect(await t.db.select().from(cashMovements).where(eq(cashMovements.idempotencyKey, payoutDrawerKey(other.tradeInId)))).toHaveLength(0);
  });
});
