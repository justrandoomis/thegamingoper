/**
 * Admin module 11 "shipping" (owner: admin shipping) — the services under app/server/services/admin/shipping and the
 * core-level file app/server/services/orders/shipments.server.ts, on a real local D1 with the built-in roles:
 *
 *   · 11.01 the fee rule (setting + overrides) equals checkout's getShippingFee; changes need settings.shipping.manage /
 *     shipping.rate.manage, a reason, a fresh page (fee_changed); history kept; availability, estimates, districts
 *   · 11.02 carriers and rates, the ranked choice (cash fee, COD-capable carriers only for cash parcels), the rule
 *   · 11.03 waybill → pickup (the order ships through the orders module's rules) → courier statuses, scan lookup
 *   · 11.05 failed tries, retry, back at the store (the order returned through the core, goods restocked or scrapped,
 *     cash payment cancelled), a mixed outcome refused
 *   · 11.06 packing photos required for sensitive devices; receiver's name for them; proof files private
 *   · 11.04 settlements: drafts, a parcel settles once, totals, the two-person rule for a difference, cash recorded
 *     through recordCodCollection, the balanced posting (shipping costs, cash over/short), idempotent replays
 *   · authorization per role, profit data only for profit.read, route loaders refusing a role without the permission
 */
import { and, eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import {
  auditEvents,
  codSettlements,
  deliveryAttempts,
  employeeRoles,
  files,
  journalEntries,
  journalLines,
  orders,
  payments,
  serials,
  shipmentEvents,
  shipments,
  stockLevels,
  warranties,
} from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, accountId, districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { changeOrderStatus } from "~/server/services/admin/orders/actions.server";
import { markPacked, packProgress, scanCode, splitParcel } from "~/server/services/admin/orders/fulfillment.server";
import { applyCarrierRate, carrierOptions, listCarriers, saveCarrier, setCarrierActive } from "~/server/services/admin/shipping/carriers.server";
import { createSettlement, discardSettlement, disputeSettlement, eligibleParcels, getSettlement, listSettlements, removeSettlementItems, reopenSettlement, updateSettlementItem } from "~/server/services/admin/shipping/cod.server";
import { shippingFile } from "~/server/services/admin/shipping/files.server";
import { codFeeFor, effectiveFee, feeChanges, parseParcelCode, parseShipmentFilters, settlementTotals, shipmentSearch } from "~/server/services/admin/shipping/rules";
import {
  addDeliveryProof,
  addPackingPhoto,
  assignByRule,
  attemptsQueue,
  deliverShipment,
  getShipment,
  listShipments,
  lookupParcel,
  manifestDocs,
  moveParcels,
  pickupParcels,
  receiveReturn,
  recordAttempt,
  saveWaybill,
  shippingOverview,
  waybillDocs,
} from "~/server/services/admin/shipping/shipments.server";
import { feePolicy, getZone, listZones, saveDistrict, setDistrictActive, setFlatFee, setGovernorateAvailability, setGovernorateEta, setOverrideFee, setOverridesEnabled } from "~/server/services/admin/shipping/zones.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { codSettlementPostingKey, reconcileCodSettlement, submitCodSettlement, syncParcels } from "~/server/services/orders/shipments.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { getShippingFee } from "~/server/services/shipping/fees.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const system = systemActor("test.admin-shipping");

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "manager2" | "finance2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "fulfillment", "support", "inventory", "cashier"] as const) staff[role] = await employee(role);
  staff.manager2 = await employee("manager");
  staff.finance2 = await employee("finance");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(role: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${role} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { kind: "employee", id, permissions: defaultRolePermissions(role), label: role };
}

const as = (role: keyof typeof staff): EmployeeActor => {
  const actor = staff[role];
  if (!actor) throw new Error(`no ${role}`);
  return actor;
};
const custom = (permissions: Permission[], id = as("manager2").id): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

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

async function stocked(priceIqd: number, qty: number, options: { trackSerials?: boolean; kind?: "game" | "accessory" | "console" } = {}) {
  const product = await make.product({ priceIqd, trackSerials: options.trackSerials, kind: options.kind ?? "game" });
  const serialNumbers = options.trackSerials ? Array.from({ length: qty }, (_, i) => `SN-${product.sku}-${i + 1}`) : undefined;
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd: Math.round(priceIqd * 0.7), serials: serialNumbers, ref: `rcv-${product.sku}` }, NOW);
  return product;
}

async function placed(lines: { variantId: string; qty: number }[], method: CheckoutInput["paymentMethod"], gov = "baghdad") {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId: null, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: governorateId(gov) }, NOW);
  return placeOrder(
    t.db,
    { cartToken: token, customer: null, locale: "ar", ip: null, storeMode: "live" },
    {
      idempotencyKey: randomToken(),
      phone: make.phone(),
      governorateId: governorateId(gov),
      districtId: gov === "baghdad" ? districtId("baghdad", "karrada") : undefined,
      areaText: "الكرادة داخل",
      addressText: "شارع 62، قرب الجسر المعلق، عمارة 4",
      marketingConsent: false,
      paymentMethod: method,
      expectedTotalIqd: view.totalIqd,
    },
    NOW,
  );
}

/** Confirms a cash order and packs it completely at the orders module's packing station. */
async function packedOrder(lines: { variantId: string; qty: number }[], method: CheckoutInput["paymentMethod"] = "cod", gov = "baghdad") {
  const order = await placed(lines, method, gov);
  if (method === "cod") await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
  const fulfil = as("fulfillment");
  const progress = await packProgress(t.db, order.orderId);
  for (const line of progress.lines) {
    if (line.serialUnits > line.serialsScanned.length) {
      const free = await t.db.select({ serial: serials.serial }).from(serials).where(and(eq(serials.variantId, line.trackedVariantIds[0]), eq(serials.status, "in_stock"))).limit(line.serialUnits - line.serialsScanned.length);
      for (const row of free) expect((await scanCode(t.db, fulfil, order.orderId, { code: row.serial, scanId: randomToken(12) }, NOW)).ok).toBe(true);
    }
    for (let i = line.scanned; i < line.scanUnits; i++) expect((await scanCode(t.db, fulfil, order.orderId, { code: line.sku, scanId: randomToken(12) }, NOW)).ok).toBe(true);
  }
  await markPacked(t.db, fulfil, order.orderId, NOW);
  const parcel = await t.db.select().from(shipments).where(eq(shipments.orderId, order.orderId)).get();
  if (!parcel) throw new Error("no parcel");
  return { ...order, shipmentId: parcel.id };
}

async function privateFile(kind: string): Promise<string> {
  const id = newId("fil");
  await t.db.insert(files).values({ id, storageKey: `prv_${id}.jpg`, visibility: "private", kind, mime: "image/jpeg", bytes: 1000, sha256: randomToken(), createdAt: NOW });
  return id;
}

async function parcelRow(id: string) {
  const row = await t.db.select().from(shipments).where(eq(shipments.id, id)).get();
  if (!row) throw new Error("parcel missing");
  return row;
}
async function orderRow(id: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, id)).get();
  if (!row) throw new Error("order missing");
  return row;
}

let carrierA = "";
let carrierB = "";
let carrierNoCod = "";

describe("pure rules", () => {
  test("parcel codes, filters in the URL, cash fees and settlement totals", () => {
    expect(parseParcelCode("tt-7k4m2q9x-2")).toEqual({ ref: "TT-7K4M2Q9X", number: 2 });
    expect(parseParcelCode("TT-7K4M2Q9X")).toBeNull();
    const filters = parseShipmentFilters(new URLSearchParams("status=failed&flag=attempts&page=3&carrier=car_1"));
    expect(filters).toMatchObject({ status: "failed", flag: "attempts", page: 3, carrier: "car_1" });
    expect(shipmentSearch(filters)).toBe("?status=failed&carrier=car_1&flag=attempts&page=3");
    expect(parseShipmentFilters(new URLSearchParams("status=nonsense&page=-2"))).toMatchObject({ status: "open", page: 1 });
    expect(codFeeFor(754_000, { codFeeIqd: 1000, codFeeBps: 100 })).toBe(1000 + 7540);
    expect(codFeeFor(0, { codFeeIqd: 1000, codFeeBps: 100 })).toBe(0);
    expect(settlementTotals([{ amountIqd: 100_000, feeIqd: 5_000 }, { amountIqd: 0, feeIqd: 3_000 }], 90_000)).toEqual({ expectedIqd: 100_000, feesIqd: 8_000, netDueIqd: 92_000, varianceIqd: -2_000 });
    expect(settlementTotals([], null).varianceIqd).toBeNull();
    const policy = { flatFeeIqd: 5000, overridesEnabled: false, allOverrideIqd: 6000 };
    expect(effectiveFee(policy, 7000)).toBe(5000);
    expect(effectiveFee({ ...policy, overridesEnabled: true }, 7000)).toBe(7000);
    expect(effectiveFee({ ...policy, overridesEnabled: true }, null)).toBe(6000);
    const zones = [
      { id: "a", name: "A", isActive: true, overrideIqd: 7000 },
      { id: "b", name: "B", isActive: true, overrideIqd: null },
      { id: "c", name: "C", isActive: false, overrideIqd: null },
    ];
    expect(feeChanges(zones, policy, { ...policy, flatFeeIqd: 6000 }).map((row) => row.id)).toEqual(["a", "b"]);
    expect(feeChanges(zones, policy, { ...policy, overridesEnabled: true })).toEqual([
      { id: "a", name: "A", beforeIqd: 5000, afterIqd: 7000 },
      { id: "b", name: "B", beforeIqd: 5000, afterIqd: 6000 },
    ]);
  });
});

describe("11.01 zones, fees and estimates", () => {
  test("the fee shown equals what checkout charges, in every combination of the switch and the overrides", async () => {
    const manager = as("manager");
    const before = await listZones(t.db, manager, "ar");
    expect(before.rows).toHaveLength(19);
    for (const row of before.rows) expect(row.feeIqd).toBe(await getShippingFee(t.db, row.id));
    await setOverrideFee(t.db, manager, { governorateId: governorateId("basra"), feeIqd: 8000, expectedIqd: null, reason: "اتفاق جديد مع شركة التوصيل" }, NOW);
    await setOverrideFee(t.db, manager, { governorateId: null, feeIqd: 6000, expectedIqd: null, reason: "كلفة أعلى خارج بغداد" }, NOW);
    // overrides off: nothing changes at checkout
    for (const row of (await listZones(t.db, manager, "ar")).rows) expect(row.feeIqd).toBe(await getShippingFee(t.db, row.id));
    expect(await getShippingFee(t.db, governorateId("basra"))).toBe(5000);
    const switched = await setOverridesEnabled(t.db, manager, { enabled: true, expected: false, reason: "تفعيل رسوم المحافظات" }, NOW);
    expect(switched.changes.length).toBe(19);
    const after = await listZones(t.db, manager, "ar");
    for (const row of after.rows) expect(row.feeIqd).toBe(await getShippingFee(t.db, row.id));
    expect(after.rows.find((row) => row.id === governorateId("basra"))?.feeIqd).toBe(8000);
    expect(after.rows.find((row) => row.id === governorateId("erbil"))?.feeIqd).toBe(6000);
    // a new override keeps the old row (history), and only the newest applies
    await setOverrideFee(t.db, manager, { governorateId: governorateId("basra"), feeIqd: 9000, expectedIqd: 8000, reason: "رفع رسوم البصرة" }, NOW + 1);
    expect(await getShippingFee(t.db, governorateId("basra"))).toBe(9000);
    const zone = await getZone(t.db, manager, governorateId("basra"), "ar");
    expect(zone.overrideHistory.map((row) => [row.feeIqd, row.isActive])).toEqual([
      [9000, true],
      [8000, false],
    ]);
    // a stale page changes nothing
    expect(await failureOf(setOverrideFee(t.db, manager, { governorateId: governorateId("basra"), feeIqd: 10_000, expectedIqd: 8000, reason: "صفحة قديمة" }, NOW + 2))).toMatchObject({ code: "fee_changed" });
    // back to the flat fee everywhere
    await setOverrideFee(t.db, manager, { governorateId: null, feeIqd: null, expectedIqd: 6000, reason: "إلغاء الرسم العام" }, NOW + 3);
    await setOverrideFee(t.db, manager, { governorateId: governorateId("basra"), feeIqd: null, expectedIqd: 9000, reason: "إلغاء رسم البصرة" }, NOW + 3);
    await setOverridesEnabled(t.db, manager, { enabled: false, expected: true, reason: "العودة للرسم الموحد" }, NOW + 4);
    expect(await getShippingFee(t.db, governorateId("basra"))).toBe(5000);
  });

  test("the flat fee changes checkout's charge through the settings (permission, reason, audit, fresh page)", async () => {
    const fulfillment = as("fulfillment");
    expect(await failureOf(setFlatFee(t.db, fulfillment, { feeIqd: 6000, expectedFeeIqd: 5000, reason: "تجربة" }, NOW))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(setFlatFee(t.db, as("finance"), { feeIqd: 6000, expectedFeeIqd: 5000, reason: "تجربة" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(setFlatFee(t.db, as("manager"), { feeIqd: 6000, expectedFeeIqd: 5000, reason: "" }, NOW))).toMatchObject({ code: "invalid" });
    expect(await failureOf(setFlatFee(t.db, as("manager"), { feeIqd: 6000, expectedFeeIqd: 4000, reason: "صفحة قديمة" }, NOW))).toMatchObject({ code: "fee_changed" });
    const result = await setFlatFee(t.db, as("manager"), { feeIqd: 6000, expectedFeeIqd: 5000, reason: "كلفة الشركة ارتفعت" }, NOW);
    expect(result.changes.length).toBe(19);
    expect(await getShippingFee(t.db, governorateId("najaf"))).toBe(6000);
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "settings.setting.update"), eq(auditEvents.entityId, "shipping.flat_fee_iqd"))).all();
    expect(audit.at(-1)).toMatchObject({ reason: "كلفة الشركة ارتفعت" });
    expect(audit.at(-1)?.before).toEqual({ value: 5000 });
    await setFlatFee(t.db, as("manager"), { feeIqd: 5000, expectedFeeIqd: 6000, reason: "العودة إلى 5000" }, NOW);
    expect((await feePolicy(t.db)).flatFeeIqd).toBe(5000);
  });

  test("pausing a governorate stops checkout there (open orders keep going); estimates and districts", async () => {
    const manager = as("manager");
    const product = await stocked(30_000, 5);
    await placed([{ variantId: product.variantId, qty: 1 }], "cod", "anbar");
    expect(await failureOf(setGovernorateAvailability(t.db, as("support"), { governorateId: governorateId("anbar"), isActive: false, reason: "توقف" }, NOW))).toMatchObject({ code: "forbidden" });
    const paused = await setGovernorateAvailability(t.db, manager, { governorateId: governorateId("anbar"), isActive: false, reason: "الطرق مقطوعة" }, NOW);
    expect(paused.openOrders).toBe(1);
    expect(await failureOf(getShippingFee(t.db, governorateId("anbar")))).toMatchObject({ code: "shipping_unavailable" });
    expect((await listZones(t.db, manager, "ar")).rows.find((row) => row.id === governorateId("anbar"))?.feeIqd).toBeNull();
    await setGovernorateAvailability(t.db, manager, { governorateId: governorateId("anbar"), isActive: true, reason: "عادت الطرق" }, NOW);
    expect(await getShippingFee(t.db, governorateId("anbar"))).toBe(5000);

    expect(await failureOf(setGovernorateEta(t.db, manager, { governorateId: governorateId("anbar"), etaDaysMin: 4, etaDaysMax: 2 }, NOW))).toMatchObject({ code: "invalid" });
    expect(await failureOf(setGovernorateEta(t.db, manager, { governorateId: governorateId("anbar"), etaDaysMin: 1, etaDaysMax: null }, NOW))).toMatchObject({ code: "invalid" });
    await setGovernorateEta(t.db, manager, { governorateId: governorateId("anbar"), etaDaysMin: 2, etaDaysMax: 4 }, NOW);
    expect((await getZone(t.db, manager, governorateId("anbar"), "ar")).zone).toMatchObject({ etaDaysMin: 2, etaDaysMax: 4 });

    const created = await saveDistrict(t.db, manager, { governorateId: governorateId("anbar"), nameAr: "حي تجريبي", nameEn: "Test quarter" }, NOW);
    expect(await failureOf(saveDistrict(t.db, manager, { governorateId: governorateId("anbar"), nameAr: "حي تجريبي" }, NOW))).toMatchObject({ code: "invalid", fields: { nameAr: "district_exists" } });
    // renaming keeps the id (orders point at it)
    await saveDistrict(t.db, manager, { governorateId: governorateId("anbar"), districtId: created.districtId, nameAr: "حي تجريبي جديد" }, NOW);
    const zone = await getZone(t.db, manager, governorateId("anbar"), "en");
    expect(zone.districts.find((row) => row.id === created.districtId)).toMatchObject({ names: { ar: "حي تجريبي جديد" }, seeded: false });
    await setDistrictActive(t.db, manager, { districtId: created.districtId, isActive: false, reason: "لا نوصل إليه" }, NOW);
    expect((await getZone(t.db, manager, governorateId("anbar"), "ar")).districts.find((row) => row.id === created.districtId)?.isActive).toBe(false);
  });
});

describe("11.02 carriers and the choice of a carrier", () => {
  test("carriers, rates per governorate and level, the ranked options and the rule", async () => {
    const manager = as("manager");
    expect(await failureOf(saveCarrier(t.db, as("fulfillment"), { code: "X1", name: "x", kind: "third_party", codSupported: true }, NOW))).toMatchObject({ code: "forbidden" });
    carrierA = (await saveCarrier(t.db, manager, { code: "fast", name: "شركة سريع", kind: "third_party", phone: "07701234567", trackingUrlTemplate: "https://fast.example/track/{tracking_no}", codSupported: true, codFeeIqd: 500, codFeeBps: 100 }, NOW)).carrierId;
    carrierB = (await saveCarrier(t.db, manager, { code: "STORE", name: "سائق المتجر", kind: "in_house", codSupported: true }, NOW)).carrierId;
    carrierNoCod = (await saveCarrier(t.db, manager, { code: "NOCASH", name: "Prepaid only", kind: "third_party", codSupported: false }, NOW)).carrierId;
    expect(await failureOf(saveCarrier(t.db, manager, { code: "FAST", name: "مكرر", kind: "third_party", codSupported: true }, NOW))).toMatchObject({ code: "invalid", fields: { code: "code_taken" } });
    expect(await failureOf(saveCarrier(t.db, manager, { code: "BAD", name: "رابط", kind: "third_party", codSupported: true, trackingUrlTemplate: "http://x.example/{tracking_no}" }, NOW))).toMatchObject({ fields: { trackingUrlTemplate: "tracking_template_invalid" } });
    const all = Object.keys(Object.fromEntries((await listZones(t.db, manager, "ar")).rows.map((row) => [row.id, 1])));
    await applyCarrierRate(t.db, manager, { carrierId: carrierA, governorateIds: all, serviceLevel: "standard", costIqd: 4000, etaDaysMin: 1, etaDaysMax: 3 }, NOW);
    await applyCarrierRate(t.db, manager, { carrierId: carrierA, governorateIds: [governorateId("baghdad")], serviceLevel: "express", costIqd: 7000, etaDaysMin: 0, etaDaysMax: 1 }, NOW);
    await applyCarrierRate(t.db, manager, { carrierId: carrierB, governorateIds: [governorateId("baghdad")], serviceLevel: "standard", costIqd: 4500, etaDaysMin: 0, etaDaysMax: 1 }, NOW);
    await applyCarrierRate(t.db, manager, { carrierId: carrierNoCod, governorateIds: [governorateId("baghdad")], serviceLevel: "standard", costIqd: 2000 }, NOW);
    // a cash parcel of 100,000: fast = 4000 + 500 + 1000 = 5500; the store's driver 4500; the prepaid-only carrier is not eligible
    const options = await carrierOptions(t.db, { governorateId: governorateId("baghdad"), serviceLevel: "standard", codAmountIqd: 100_000 });
    expect(options.map((option) => [option.carrierId, option.totalIqd, option.eligible])).toEqual([
      [carrierB, 4500, true],
      [carrierA, 5500, true],
      [carrierNoCod, 2000, false],
    ]);
    // prepaid: the cheapest is the prepaid-only carrier
    expect((await carrierOptions(t.db, { governorateId: governorateId("baghdad"), serviceLevel: "standard", codAmountIqd: 0 }))[0].carrierId).toBe(carrierNoCod);
    const rows = await listCarriers(t.db, as("fulfillment"));
    expect(rows.find((row) => row.id === carrierA)).toMatchObject({ code: "FAST", zones: 19, phone: "0770 123 4567" });
  });

  test("the rule gives each waiting parcel the cheapest eligible carrier, and leaves the others for a person", async () => {
    const product = await stocked(100_000, 6);
    const one = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod");
    const outside = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod", "basra");
    await applyCarrierRate(t.db, as("manager"), { carrierId: carrierNoCod, governorateIds: [governorateId("basra")], serviceLevel: "express", costIqd: 1000 }, NOW);
    const result = await assignByRule(t.db, as("fulfillment"), { shipmentIds: [one.shipmentId, outside.shipmentId], serviceLevel: "express" }, NOW);
    expect(result.assigned).toBe(1);
    expect(result.skipped).toEqual([expect.objectContaining({ id: outside.shipmentId, reason: "no_carrier" })]);
    expect((await parcelRow(one.shipmentId)).carrierId).toBe(carrierA);
    expect(await failureOf(assignByRule(t.db, as("support"), { shipmentIds: [one.shipmentId], serviceLevel: "standard" }, NOW))).toMatchObject({ code: "forbidden" });
  });
});

describe("11.03 waybill, pickup and courier statuses", () => {
  test("a cash parcel: waybill → pickup ships the order (orders module rules) → in transit → out for delivery → delivered (warranty, revenue)", async () => {
    const fulfil = as("fulfillment");
    const product = await stocked(100_000, 5);
    const order = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod");
    // no waybill yet: pickup refused, nothing moves
    const early = await pickupParcels(t.db, fulfil, { shipmentIds: [order.shipmentId] }, NOW);
    expect(early).toEqual({ shipped: [], failed: [expect.objectContaining({ code: "waybill_missing" })] });
    expect((await orderRow(order.orderId)).status).toBe("preparing");
    // a carrier that does not collect cash is refused for a cash parcel
    expect(await failureOf(saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierNoCod, serviceLevel: "standard" }, NOW))).toMatchObject({ code: "carrier_no_cod" });
    expect(await failureOf(saveWaybill(t.db, as("support"), { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard" }, NOW))).toMatchObject({ code: "forbidden" });
    const waybill = await saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard" }, NOW);
    expect(waybill.trackingNo).toBe(`${order.ref}-1`);
    expect(waybill.costIqd).toBe(4000);
    expect((await saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard" }, NOW)).replayed).toBe(true);
    expect((await parcelRow(order.shipmentId)).codAmountIqd).toBe((await orderRow(order.orderId)).totalIqd);
    // the parcel is found by its waybill code, its tracking number and its order reference
    expect(await lookupParcel(t.db, fulfil, `${order.ref.toLowerCase()}-1`)).toBe(order.shipmentId);
    expect(await lookupParcel(t.db, fulfil, order.ref)).toBe(order.shipmentId);
    // pickup ships the order through the orders module and the core: stock committed, parcel handed over
    const picked = await pickupParcels(t.db, fulfil, { shipmentIds: [order.shipmentId] }, NOW + HOUR);
    expect(picked).toEqual({ shipped: [order.ref], failed: [] });
    expect((await orderRow(order.orderId)).status).toBe("shipped");
    expect((await parcelRow(order.shipmentId)).status).toBe("handed_over");
    // a carrier's own number later: needs a reason now that it is on the road
    expect(await failureOf(saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard", trackingNo: "FAST-99812" }, NOW + HOUR))).toMatchObject({ code: "invalid", fields: { reason: "required" } });
    await saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard", trackingNo: "FAST-99812", reason: "رقم الشركة وصل بعد الاستلام" }, NOW + HOUR);
    expect(await lookupParcel(t.db, fulfil, "fast-99812")).toBe(order.shipmentId);
    // statuses: stale page refused; support cannot move parcels
    expect(await failureOf(moveParcels(t.db, as("support"), { shipmentIds: [order.shipmentId], to: "in_transit" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(moveParcels(t.db, fulfil, { shipmentIds: [order.shipmentId], to: "in_transit", from: "out_for_delivery" }, NOW))).toMatchObject({ code: "shipment_changed" });
    expect((await moveParcels(t.db, fulfil, { shipmentIds: [order.shipmentId], to: "in_transit", from: "handed_over" }, NOW + 2 * HOUR)).moved).toBe(1);
    expect((await moveParcels(t.db, fulfil, { shipmentIds: [order.shipmentId], to: "out_for_delivery" }, NOW + 3 * HOUR)).moved).toBe(1);
    // delivered: the order is delivered by the core (warranty, sale and cost postings), the shopper's message held
    const delivered = await deliverShipment(t.db, fulfil, { shipmentId: order.shipmentId, receivedByName: "أبو علي", from: "out_for_delivery" }, NOW + 4 * HOUR);
    expect(delivered).toEqual({ orderDelivered: true, replayed: false });
    expect((await orderRow(order.orderId)).status).toBe("delivered");
    expect((await parcelRow(order.shipmentId)).status).toBe("delivered");
    expect((await deliverShipment(t.db, fulfil, { shipmentId: order.shipmentId }, NOW + 5 * HOUR)).replayed).toBe(true);
    const events = await t.db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, order.shipmentId)).all();
    expect(events.filter((event) => event.kind === "delivered")).toHaveLength(1);
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining(["waybill", "handed_over", "in_transit", "out_for_delivery", "delivered"]));
    const sale = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `order:${order.orderId}:sale`)).get();
    expect(sale).toBeTruthy();
    const attempt = await t.db.select().from(deliveryAttempts).where(eq(deliveryAttempts.shipmentId, order.shipmentId)).all();
    expect(attempt).toEqual([expect.objectContaining({ attemptNo: 1, outcome: "delivered" })]);
  });

  test("the parcel page: who may do what; the delivery margin only for profit.read; phones masked without the field permission", async () => {
    const product = await stocked(60_000, 3);
    const order = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod");
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard" }, NOW);
    const manager = await getShipment(t.db, as("manager"), order.shipmentId, "ar", NOW);
    expect(manager.deliveryMarginIqd).toBe(5000 - 4000);
    expect(manager.can).toMatchObject({ waybill: true, pickup: true });
    expect(manager.carrierOptions.length).toBeGreaterThan(0);
    const fulfil = await getShipment(t.db, as("fulfillment"), order.shipmentId, "ar", NOW);
    expect("deliveryMarginIqd" in fulfil).toBe(false);
    expect(fulfil.recipient.phone?.full).toBe(true);
    const finance = await getShipment(t.db, as("finance"), order.shipmentId, "ar", NOW);
    expect(finance.recipient.phone?.full).toBe(false);
    expect(JSON.stringify(finance)).not.toContain((await orderRow(order.orderId)).contactPhoneE164!.slice(-6));
    expect(finance.can).toMatchObject({ waybill: false, pickup: false, move: false });
    expect(finance.carrierOptions).toEqual([]);
    expect(await failureOf(getShipment(t.db, as("cashier"), order.shipmentId, "ar", NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(listShipments(t.db, as("cashier"), parseShipmentFilters(new URLSearchParams()), "ar", NOW))).toMatchObject({ code: "forbidden" });
    // the list: filters, saved views, cash column
    const page = await listShipments(t.db, as("support"), parseShipmentFilters(new URLSearchParams(`q=${order.ref}`)), "ar", NOW);
    expect(page.rows.map((row) => row.id)).toEqual([order.shipmentId]);
    expect(page.rows[0].cod).toEqual({ kind: "collect", amountIqd: (await orderRow(order.orderId)).totalIqd });
    expect((await listShipments(t.db, as("support"), parseShipmentFilters(new URLSearchParams(`q=${order.ref}&status=failed`)), "ar", NOW)).rows).toEqual([]);
    // printed waybill: no prices, the cash to collect, the courier's copy
    const [doc] = await waybillDocs(t.db, as("fulfillment"), [order.shipmentId], "ar");
    expect(doc).toMatchObject({ code: `${order.ref}-1`, cod: { kind: "collect" }, shippable: true, carrier: { name: "شركة سريع" } });
    expect(JSON.stringify(doc)).not.toMatch(/cost/i);
    const [manifest] = await manifestDocs(t.db, as("fulfillment"), [order.shipmentId], "ar", NOW);
    expect(manifest.totals).toEqual({ parcels: 1, collectIqd: (await orderRow(order.orderId)).totalIqd });
  });
});

describe("11.05 failed deliveries, retries, back at the store", () => {
  test("three failed tries, the queue, on its way back, back at the store: the order is returned through the core, goods restocked or written off", async () => {
    const fulfil = as("fulfillment");
    const good = await stocked(40_000, 4);
    const fragile = await stocked(20_000, 4, { kind: "accessory" });
    const order = await packedOrder(
      [
        { variantId: good.variantId, qty: 1 },
        { variantId: fragile.variantId, qty: 1 },
      ],
      "cod",
    );
    await saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierB, serviceLevel: "standard" }, NOW);
    await pickupParcels(t.db, fulfil, { shipmentIds: [order.shipmentId] }, NOW);
    const before = await t.db.select().from(stockLevels).where(eq(stockLevels.variantId, good.variantId)).get();
    expect(await failureOf(recordAttempt(t.db, as("support"), { shipmentId: order.shipmentId, outcome: "no_answer" }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(recordAttempt(t.db, fulfil, { shipmentId: order.shipmentId, outcome: "other" }, NOW))).toMatchObject({ fields: { reason: "required" } });
    expect(await failureOf(recordAttempt(t.db, fulfil, { shipmentId: order.shipmentId, outcome: "no_answer", nextAttemptDay: "2026-02-30" }, NOW))).toMatchObject({ fields: { nextAttemptDay: "day_invalid" } });
    for (let n = 1; n <= 3; n++) {
      const result = await recordAttempt(t.db, fulfil, { shipmentId: order.shipmentId, outcome: n === 3 ? "refused" : "no_answer", reason: n === 3 ? "رفض الاستلام" : undefined, nextAttemptDay: "2026-11-12" }, NOW + n * HOUR);
      expect(result).toMatchObject({ attemptNo: n, failedAttempts: n });
      if (n < 3) expect((await moveParcels(t.db, fulfil, { shipmentIds: [order.shipmentId], to: "out_for_delivery", from: "failed" }, NOW + n * HOUR + 1)).moved).toBe(1);
    }
    const queue = await attemptsQueue(t.db, as("support"), "ar");
    const row = queue.find((entry) => entry.id === order.shipmentId);
    expect(row?.attempts.map((attempt) => attempt.outcome)).toEqual(["no_answer", "no_answer", "refused"]);
    expect(row?.recipient.phone?.full).toBe(true);
    await moveParcels(t.db, fulfil, { shipmentIds: [order.shipmentId], to: "returning", note: "ثلاث محاولات" }, NOW + 4 * HOUR);
    expect(await failureOf(receiveReturn(t.db, as("support"), { shipmentId: order.shipmentId, reason: "عاد" }, NOW))).toMatchObject({ code: "forbidden" });
    const items = (await getShipment(t.db, fulfil, order.shipmentId, "ar", NOW)).returnLines;
    const fragileLine = items.find((line) => line.sku === fragile.sku);
    const back = await receiveReturn(
      t.db,
      fulfil,
      { shipmentId: order.shipmentId, reason: "رفض الزبون الاستلام ثلاث مرات", lines: items.map((line) => ({ orderItemId: line.orderItemId, disposition: line.orderItemId === fragileLine?.orderItemId ? "scrap" : "restock" })) },
      NOW + 5 * HOUR,
    );
    expect(back).toEqual({ parcels: 1, replayed: false });
    const after = await orderRow(order.orderId);
    expect(after.status).toBe("returned");
    expect((await parcelRow(order.shipmentId)).status).toBe("returned");
    const cash = await t.db.select().from(payments).where(eq(payments.orderId, order.orderId)).all();
    expect(cash.every((payment) => payment.status === "cancelled")).toBe(true);
    const restocked = await t.db.select().from(stockLevels).where(eq(stockLevels.variantId, good.variantId)).get();
    expect(restocked!.onHand).toBe(before!.onHand + 1);
    const fragileLevel = await t.db.select().from(stockLevels).where(eq(stockLevels.variantId, fragile.variantId)).get();
    expect(fragileLevel!.onHand).toBe(3); // the damaged unit was written off
    expect((await receiveReturn(t.db, fulfil, { shipmentId: order.shipmentId, reason: "تكرار" }, NOW + 6 * HOUR)).replayed).toBe(true);
  });

  test("a mixed outcome (one parcel delivered, the other back) is refused: deliver the order and take the goods back as a return", async () => {
    const fulfil = as("fulfillment");
    const product = await stocked(25_000, 6);
    const order = await placed([{ variantId: product.variantId, qty: 2 }], "cod");
    await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
    const progress = await packProgress(t.db, order.orderId);
    for (let i = 0; i < progress.lines[0].scanUnits; i++) await scanCode(t.db, fulfil, order.orderId, { code: progress.lines[0].sku, scanId: randomToken(12) }, NOW);
    const split = await splitParcel(t.db, fulfil, order.orderId, { lines: [{ orderItemId: progress.lines[0].orderItemId, qty: 1 }] }, NOW);
    await markPacked(t.db, fulfil, order.orderId, NOW);
    const parcels = await t.db.select().from(shipments).where(eq(shipments.orderId, order.orderId)).all();
    const live = parcels.filter((parcel) => parcel.status !== "cancelled");
    expect(live).toHaveLength(2);
    for (const parcel of live) await saveWaybill(t.db, fulfil, { shipmentId: parcel.id, carrierId: carrierB, serviceLevel: "standard" }, NOW);
    await pickupParcels(t.db, fulfil, { shipmentIds: [live[0].id] }, NOW);
    expect((await parcelRow(split.parcelId)).status).toBe("handed_over");
    // parcel 1 delivered: the order stays shipped until parcel 2 is delivered too
    const first = live.find((parcel) => parcel.id !== split.parcelId)!;
    expect(await deliverShipment(t.db, fulfil, { shipmentId: first.id }, NOW + HOUR)).toEqual({ orderDelivered: false, replayed: false });
    expect((await orderRow(order.orderId)).status).toBe("shipped");
    expect(await failureOf(receiveReturn(t.db, fulfil, { shipmentId: split.parcelId, reason: "عاد الطرد الثاني" }, NOW + 2 * HOUR))).toMatchObject({ code: "parcel_partly_delivered" });
    expect(await deliverShipment(t.db, fulfil, { shipmentId: split.parcelId }, NOW + 3 * HOUR)).toEqual({ orderDelivered: true, replayed: false });
    expect((await orderRow(order.orderId)).status).toBe("delivered");
  });

  test("parcels follow an order moved by someone else (syncParcels); an order on hold is not delivered", async () => {
    const fulfil = as("fulfillment");
    const product = await stocked(30_000, 4);
    const order = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod");
    await saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierB, serviceLevel: "standard" }, NOW);
    await pickupParcels(t.db, fulfil, { shipmentIds: [order.shipmentId] }, NOW);
    await t.db.update(orders).set({ reviewStatus: "blocked" }).where(eq(orders.id, order.orderId));
    expect(await failureOf(deliverShipment(t.db, fulfil, { shipmentId: order.shipmentId }, NOW))).toMatchObject({ code: "order_on_hold" });
    await t.db.update(orders).set({ reviewStatus: "cleared" }).where(eq(orders.id, order.orderId));
    // the core alone moves the order (another module): the parcel is out of step until synced
    await transitionOrder(t.db, as("manager"), order.orderId, "delivered", { from: "shipped" }, NOW + HOUR);
    expect((await getShipment(t.db, fulfil, order.shipmentId, "ar", NOW)).outOfStep).toBe(true);
    expect(await syncParcels(t.db, fulfil, order.orderId, NOW + HOUR)).toEqual({ moved: 1 });
    expect((await parcelRow(order.shipmentId)).status).toBe("delivered");
    expect(await syncParcels(t.db, fulfil, order.orderId, NOW + HOUR)).toEqual({ moved: 0 });
  });
});

describe("11.06 documented packing and proof of receipt", () => {
  test("a sensitive device is not picked up without a packing photo, and is delivered only with the receiver's name", async () => {
    const fulfil = as("fulfillment");
    const console_ = await stocked(450_000, 2, { trackSerials: true, kind: "console" });
    const order = await packedOrder([{ variantId: console_.variantId, qty: 1 }], "cod");
    await saveWaybill(t.db, fulfil, { shipmentId: order.shipmentId, carrierId: carrierA, serviceLevel: "standard" }, NOW);
    const detail = await getShipment(t.db, fulfil, order.shipmentId, "ar", NOW);
    expect(detail.sensitive).toBe(true);
    expect(detail.items[0].serials).toHaveLength(1);
    expect("serials" in (await getShipment(t.db, as("finance"), order.shipmentId, "ar", NOW)).items[0]).toBe(false);
    const refused = await pickupParcels(t.db, fulfil, { shipmentIds: [order.shipmentId] }, NOW);
    expect(refused.failed).toEqual([expect.objectContaining({ code: "packing_undocumented" })]);
    expect((await listShipments(t.db, fulfil, parseShipmentFilters(new URLSearchParams(`q=${order.ref}&flag=undocumented`)), "ar", NOW)).rows).toHaveLength(1);
    // a file of another kind is refused; a support employee may not add the photo
    const wrong = await privateFile("payment_proof");
    expect(await failureOf(addPackingPhoto(t.db, fulfil, { shipmentId: order.shipmentId, fileId: wrong }, NOW))).toMatchObject({ fields: { file: "file_invalid" } });
    const photo = await privateFile("packing_photo");
    expect(await failureOf(addPackingPhoto(t.db, as("support"), { shipmentId: order.shipmentId, fileId: photo }, NOW))).toMatchObject({ code: "forbidden" });
    await addPackingPhoto(t.db, fulfil, { shipmentId: order.shipmentId, fileId: photo, note: "ختم رقم 4471" }, NOW);
    expect((await pickupParcels(t.db, fulfil, { shipmentIds: [order.shipmentId] }, NOW)).shipped).toEqual([order.ref]);
    expect(await failureOf(addPackingPhoto(t.db, fulfil, { shipmentId: order.shipmentId, fileId: await privateFile("packing_photo") }, NOW))).toMatchObject({ code: "packing_after_pickup" });
    expect(await failureOf(deliverShipment(t.db, fulfil, { shipmentId: order.shipmentId }, NOW))).toMatchObject({ fields: { receivedByName: "receiver_required" } });
    const proof = await privateFile("delivery_proof");
    await deliverShipment(t.db, fulfil, { shipmentId: order.shipmentId, receivedByName: "حسين كريم", fileId: proof }, NOW + HOUR);
    const parcel = await parcelRow(order.shipmentId);
    expect(parcel).toMatchObject({ status: "delivered", receivedByName: "حسين كريم", proofFileId: proof, packingFileId: photo });
    expect((await orderRow(order.orderId)).status).toBe("delivered");
    void warranties;
    // the files: private, only for shipping readers
    expect(await shippingFile(t.db, as("support"), photo)).toEqual({ id: photo });
    expect(await shippingFile(t.db, as("support"), proof)).toEqual({ id: proof });
    expect(await shippingFile(t.db, as("cashier"), photo)).toBeNull();
    expect(await shippingFile(t.db, as("manager"), wrong)).toBeNull();
    // a later proof of receipt on a delivered parcel
    const later = await privateFile("delivery_proof");
    await addDeliveryProof(t.db, fulfil, { shipmentId: order.shipmentId, fileId: later, receivedByName: "حسين كريم" }, NOW + 2 * HOUR);
    expect((await parcelRow(order.shipmentId)).proofFileId).toBe(later);
  });
});

describe("11.04 cash-on-delivery settlements", () => {
  async function deliveredCod(priceIqd: number, carrierId = carrierA) {
    const product = await stocked(priceIqd, 3);
    const order = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod");
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: order.shipmentId, carrierId, serviceLevel: "standard" }, NOW);
    await pickupParcels(t.db, as("fulfillment"), { shipmentIds: [order.shipmentId] }, NOW);
    await deliverShipment(t.db, as("fulfillment"), { shipmentId: order.shipmentId }, NOW + HOUR);
    return order;
  }

  test("a draft from the carrier's statement, a parcel settles once, a difference needs two people, cash recorded and posted once", async () => {
    const finance = as("finance");
    const a = await deliveredCod(100_000);
    const b = await deliveredCod(200_000);
    expect(await failureOf(eligibleParcels(t.db, as("fulfillment"), carrierA, "ar"))).toMatchObject({ code: "forbidden" });
    const { parcels } = await eligibleParcels(t.db, finance, carrierA, "ar");
    const pa = parcels.find((parcel) => parcel.shipmentId === a.shipmentId)!;
    const totalA = (await orderRow(a.orderId)).totalIqd;
    const totalB = (await orderRow(b.orderId)).totalIqd;
    expect(pa).toMatchObject({ amountIqd: totalA, dueIqd: totalA, paymentStatus: "pending", feeIqd: 4000 + 500 + Math.round(totalA / 100) });
    const key = randomToken(12);
    const draft = await createSettlement(t.db, finance, { carrierId: carrierA, shipmentIds: [a.shipmentId, b.shipmentId], idempotencyKey: key }, NOW + 2 * HOUR);
    expect((await createSettlement(t.db, finance, { carrierId: carrierA, shipmentIds: [a.shipmentId, b.shipmentId], idempotencyKey: key }, NOW + 2 * HOUR)).replayed).toBe(true);
    // a parcel settles once: another draft with it is refused
    expect(await failureOf(createSettlement(t.db, as("finance2"), { carrierId: carrierA, shipmentIds: [a.shipmentId], idempotencyKey: randomToken(12) }, NOW))).toMatchObject({ code: "parcel_not_eligible" });
    // the courier collected 1,000 less on B: a reason is needed in the draft
    expect(await failureOf(updateSettlementItem(t.db, finance, { settlementId: draft.settlementId, shipmentId: b.shipmentId, amountIqd: totalB - 1000, feeIqd: 6000 }, NOW))).toMatchObject({ fields: { reason: "required" } });
    await updateSettlementItem(t.db, finance, { settlementId: draft.settlementId, shipmentId: b.shipmentId, amountIqd: totalB - 1000, feeIqd: 6000, reason: "الزبون دفع أقل بالاتفاق" }, NOW);
    let view = await getSettlement(t.db, finance, draft.settlementId, "ar");
    const feesA = pa.feeIqd;
    expect(view.totals).toMatchObject({ expectedIqd: totalA + totalB - 1000, feesIqd: feesA + 6000 });
    // the carrier remitted 2,000 less than it owes: submitting needs a note
    const net = view.totals.netDueIqd;
    expect(await failureOf(submitCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedIqd: net - 2000 }, NOW))).toMatchObject({ fields: { note: "variance_note_required" } });
    await submitCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedIqd: net - 2000, note: "نقص 2000 في كشف الشركة" }, NOW + 3 * HOUR);
    view = await getSettlement(t.db, finance, draft.settlementId, "ar");
    expect(view.totals.varianceIqd).toBe(-2000);
    expect(view.can).toMatchObject({ reconcile: false, reconcileReason: "self" });
    // the front page counts it only for people who may decide it
    expect((await shippingOverview(t.db, finance, NOW)).toReconcile).toBe(0);
    expect((await shippingOverview(t.db, as("finance2"), NOW)).toReconcile).toBe(1);
    // two people: the preparer cannot reconcile a difference
    expect(await failureOf(reconcileCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "مقبول" }, NOW))).toMatchObject({ code: "settlement_self_reconcile", status: 403 });
    // a second finance employee: recording B's short cash needs orders.payment.override (owner/manager only)
    expect(await failureOf(reconcileCodSettlement(t.db, as("finance2"), { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "مقبول بعد الاتصال" }, NOW))).toMatchObject({ code: "amount_mismatch" });
    // nothing was recorded by that attempt — every parcel's rules are checked before the first cash is recorded
    expect((await t.db.select().from(payments).where(and(eq(payments.orderId, a.orderId), eq(payments.method, "cod"))).get())?.status).toBe("pending");
    expect((await t.db.select().from(codSettlements).where(eq(codSettlements.id, draft.settlementId)).get())?.status).toBe("submitted");
    const done = await reconcileCodSettlement(t.db, as("manager"), { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "مقبول بعد الاتصال", reference: "TRX-7781" }, NOW + 4 * HOUR);
    expect(done.replayed).toBe(false);
    expect(done.journalEntryId).toBeTruthy();
    expect((await reconcileCodSettlement(t.db, as("manager"), { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "مكرر" }, NOW + 5 * HOUR)).replayed).toBe(true);
    // the books: one entry, balanced, shipping costs and the shortfall
    const entry = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, codSettlementPostingKey(draft.settlementId))).get();
    expect(entry?.id).toBe(done.journalEntryId);
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entry!.id)).all();
    const line = (key: string) => lines.filter((row) => row.accountId === key);
    const sum = (rows: typeof lines, side: "debitIqd" | "creditIqd") => rows.reduce((total, row) => total + row[side], 0);
    expect(sum(lines, "debitIqd")).toBe(sum(lines, "creditIqd"));
    expect(sum(line(accountId("shipping_costs")), "debitIqd")).toBe(feesA + 6000);
    expect(sum(line(accountId("cash_over_short")), "debitIqd")).toBe(2000);
    expect(sum(line(accountId("bank_clearing")), "debitIqd")).toBe(net - 2000);
    expect(sum(line(accountId("cash")), "creditIqd")).toBe(totalA + totalB - 1000);
    // both cash payments recorded once, B at the amount the courier brought
    const payB = await t.db.select().from(payments).where(and(eq(payments.orderId, b.orderId), eq(payments.method, "cod"))).get();
    expect(payB).toMatchObject({ status: "paid", amountIqd: totalB - 1000 });
    // parcels settled, their actual carrier charge kept
    expect(await parcelRow(b.shipmentId)).toMatchObject({ costIqd: 6000 });
    expect((await parcelRow(a.shipmentId)).codSettledAt).not.toBeNull();
    expect((await eligibleParcels(t.db, finance, carrierA, "ar")).parcels.some((parcel) => parcel.shipmentId === a.shipmentId)).toBe(false);
    const list = await listSettlements(t.db, finance, { status: "reconciled", carrier: null });
    expect(list.find((row) => row.id === draft.settlementId)).toMatchObject({ parcels: 2, varianceIqd: -2000 });
  });

  test("an exact settlement can be reconciled by its preparer; prepaid parcels add only the carrier's charge; drafts can be emptied, disputed, reopened, discarded", async () => {
    const finance = as("finance");
    const cash = await deliveredCod(50_000, carrierB);
    const draft = await createSettlement(t.db, finance, { carrierId: carrierB, shipmentIds: [cash.shipmentId], idempotencyKey: randomToken(12) }, NOW);
    const view = await getSettlement(t.db, finance, draft.settlementId, "ar");
    expect(view.items[0]).toMatchObject({ amountIqd: (await orderRow(cash.orderId)).totalIqd, feeIqd: 4500 });
    // dispute → reopen → submit exactly → reconcile by the same person (no difference to accept)
    await submitCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedIqd: view.totals.netDueIqd + 500, note: "زيادة غير مفهومة" }, NOW);
    await disputeSettlement(t.db, finance, { settlementId: draft.settlementId, note: "نسأل الشركة عن الزيادة" }, NOW);
    expect((await getSettlement(t.db, finance, draft.settlementId, "ar")).status).toBe("disputed");
    await reopenSettlement(t.db, finance, { settlementId: draft.settlementId, reason: "الشركة صححت الكشف" }, NOW);
    await submitCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedIqd: view.totals.netDueIqd }, NOW);
    const done = await reconcileCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedInto: "cash" }, NOW);
    expect(done.codRecorded).toBe(1);
    // an empty draft cannot be submitted; a draft can be discarded and its parcels come back
    const other = await deliveredCod(30_000, carrierB);
    const second = await createSettlement(t.db, finance, { carrierId: carrierB, shipmentIds: [other.shipmentId], idempotencyKey: randomToken(12) }, NOW);
    await removeSettlementItems(t.db, finance, { settlementId: second.settlementId, shipmentIds: [other.shipmentId] }, NOW);
    expect(await failureOf(submitCodSettlement(t.db, finance, { settlementId: second.settlementId, receivedIqd: 0 }, NOW))).toMatchObject({ code: "settlement_empty" });
    await discardSettlement(t.db, finance, { settlementId: second.settlementId, reason: "مسودة خاطئة" }, NOW);
    expect((await eligibleParcels(t.db, finance, carrierB, "ar")).parcels.some((parcel) => parcel.shipmentId === other.shipmentId)).toBe(true);
    // a parcel that was returned carries no cash: only the carrier's charge
    const product = await stocked(15_000, 2);
    const back = await packedOrder([{ variantId: product.variantId, qty: 1 }], "cod");
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: back.shipmentId, carrierId: carrierB, serviceLevel: "standard" }, NOW);
    await pickupParcels(t.db, as("fulfillment"), { shipmentIds: [back.shipmentId] }, NOW);
    await receiveReturn(t.db, as("fulfillment"), { shipmentId: back.shipmentId, reason: "العنوان خاطئ" }, NOW);
    const third = await createSettlement(t.db, finance, { carrierId: carrierB, shipmentIds: [back.shipmentId], idempotencyKey: randomToken(12) }, NOW);
    expect(await failureOf(updateSettlementItem(t.db, finance, { settlementId: third.settlementId, shipmentId: back.shipmentId, amountIqd: 1000, feeIqd: 3000 }, NOW))).toMatchObject({ fields: { amountIqd: "settlement_no_cash" } });
    // a charge other than the carrier's rate is a hand correction: it needs a reason (review 2026-11-11) …
    expect(await failureOf(updateSettlementItem(t.db, finance, { settlementId: third.settlementId, shipmentId: back.shipmentId, amountIqd: 0, feeIqd: 3000 }, NOW))).toMatchObject({ fields: { reason: "required" } });
    await updateSettlementItem(t.db, finance, { settlementId: third.settlementId, shipmentId: back.shipmentId, amountIqd: 0, feeIqd: 3000, reason: "أجرة الإرجاع في كشف الشركة" }, NOW);
    // the store pays the carrier for the return: a negative remittance
    await submitCodSettlement(t.db, finance, { settlementId: third.settlementId, receivedIqd: -3000 }, NOW);
    // … and makes the reconciliation a second person's, with a reason
    expect(await failureOf(reconcileCodSettlement(t.db, finance, { settlementId: third.settlementId, receivedInto: "cash", reason: "مطابق" }, NOW))).toMatchObject({ code: "settlement_self_reconcile" });
    const paid = await reconcileCodSettlement(t.db, as("finance2"), { settlementId: third.settlementId, receivedInto: "cash", reason: "طابقت كشف الإرجاع" }, NOW);
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, paid.journalEntryId!)).all();
    expect(lines.map((row) => [row.accountId, row.debitIqd, row.creditIqd]).sort()).toEqual(
      [
        [accountId("cash"), 0, 3000],
        [accountId("shipping_costs"), 3000, 0],
      ].sort(),
    );
    // the overview counts what waits
    const overview = await shippingOverview(t.db, as("manager"), NOW);
    expect(overview.carriers).toBeGreaterThanOrEqual(2);
    expect(overview.unsettled).toBeGreaterThanOrEqual(1);
    expect(await failureOf(listSettlements(t.db, as("fulfillment"), { status: "all", carrier: null }))).toMatchObject({ code: "forbidden" });
    void setCarrierActive;
    void sql;
  });
});
