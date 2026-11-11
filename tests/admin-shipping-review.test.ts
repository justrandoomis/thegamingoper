/**
 * Admin module 11 "shipping" — the adversarial review (2026-11-11). Each test here failed on the builder's code:
 *
 *   · two people: a parcel whose cash or carrier charge was CORRECTED by hand is a difference too — whoever corrected,
 *     prepared or submitted the settlement does not reconcile it (one person could book a courier's shortfall as a
 *     higher "carrier charge", make the variance 0 and reconcile alone); a charge other than the carrier's rate needs a
 *     reason
 *   · 403, not a crash: the zones and carriers pages for a role that passes the module's gate without their permission
 *   · the permission before the input: a role without the right gets 403, not a field error (waybill cost, fee, estimate,
 *     override), and the parcel page's action needs the page's own permission
 *   · carrier rates and charges (what the store pays its delivery suppliers) reach only the people who choose carriers,
 *     settle with them or see cost — never the support or stock roles that only read parcels
 *   · typed amounts: a decimal mark is refused, never dropped (5000.5 → 50005); the cash fee % accepts the Arabic
 *     decimal separator (١٫٥ → 1.5 %, it became 15 %)
 *   · the pickup manifest marks the parcels that must not be handed over and leaves their cash out of the total
 *   · races (the competing request lands just before the service's write batch): a parcel delivered while its order is
 *     being taken back (the goods were restocked while the customer had them), one tracking number given to two
 *     parcels, a fee override overwritten without notice
 *   · a district of another governorate switched from this governorate's page; a bulk move half done before a 403;
 *     uploads stored before the state refused the action
 */
import { and, eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as carriersLoader } from "~/routes/admin/shipping/carriers";
import { digitsOnly } from "~/routes/admin/shipping/components/kit";
import { action as settlementAction } from "~/routes/admin/shipping/settlement";
import { action as parcelRouteAction } from "~/routes/admin/shipping/shipment";
import { parcelAction } from "~/routes/admin/shipping/shipment.server";
import { amount, carrierFromForm, type ShippingRequest } from "~/routes/admin/shipping/shipping.server";
import { action as zoneAction } from "~/routes/admin/shipping/zone";
import { action as zonesAction, loader as zonesLoader } from "~/routes/admin/shipping/zones";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { codSettlements, districts, employeeRoles, files, orders, payments, rolePermissions, roles, serials, shipments, shippingRates } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { changeOrderStatus } from "~/server/services/admin/orders/actions.server";
import { markPacked, packProgress, scanCode, splitParcel } from "~/server/services/admin/orders/fulfillment.server";
import { applyCarrierRate, getCarrier, listCarriers, saveCarrier } from "~/server/services/admin/shipping/carriers.server";
import { createSettlement, getSettlement, updateSettlementItem } from "~/server/services/admin/shipping/cod.server";
import { deliverShipment, getShipment, manifestDocs, moveParcels, pickupParcels, recordAttempt, saveWaybill, shippingOverview } from "~/server/services/admin/shipping/shipments.server";
import { getZone, setDistrictActive, setOverrideFee } from "~/server/services/admin/shipping/zones.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { placeOrder, type CheckoutInput } from "~/server/services/orders/place.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { deliverParcel, reconcileCodSettlement, returnParcels, submitCodSettlement } from "~/server/services/orders/shipments.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const system = systemActor("test.admin-shipping-review");
const ORIGIN = "http://localhost:5173";
/** A real 1×1 PNG (uploads are decoded and cleaned before they are stored). */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

let t: TestDb;
let make: Fixtures;
let carrierId = "";
const staff: Partial<Record<DefaultRoleKey | "finance2" | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "fulfillment", "support", "inventory"] as const) staff[role] = await employee(role);
  staff.finance2 = await employee("finance");
  staff.manager2 = await employee("manager");
  carrierId = (await saveCarrier(t.db, as("manager"), { code: "REV", name: "Review carrier", kind: "third_party", codSupported: true, codFeeIqd: 500, codFeeBps: 100 }, NOW)).carrierId;
  await applyCarrierRate(t.db, as("manager"), { carrierId, governorateIds: [governorateId("baghdad"), governorateId("basra")], serviceLevel: "standard", costIqd: 4000, etaDaysMin: 1, etaDaysMax: 2 }, NOW);
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

async function stocked(priceIqd: number, qty: number, kind: "game" | "console" = "game") {
  const product = await make.product({ priceIqd, kind });
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd: Math.round(priceIqd * 0.7), ref: `rcv-${product.sku}` }, NOW);
  return product;
}

async function placed(lines: { variantId: string; qty: number }[], method: CheckoutInput["paymentMethod"] = "cod") {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId: null, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return placeOrder(
    t.db,
    { cartToken: token, customer: null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة", addressText: "شارع 62، عمارة 4", marketingConsent: false, paymentMethod: method, expectedTotalIqd: view.totalIqd },
    NOW,
  );
}

/** A cash order packed at the orders module's station (optionally in two parcels): its live parcel ids. */
async function packedOrder(lines: { variantId: string; qty: number }[], options: { split?: boolean } = {}) {
  const order = await placed(lines);
  await changeOrderStatus(t.db, as("manager"), order.orderId, { to: "confirmed", from: "new" }, NOW);
  const fulfil = as("fulfillment");
  const progress = await packProgress(t.db, order.orderId);
  for (const line of progress.lines) {
    if (line.serialUnits > line.serialsScanned.length) {
      const free = await t.db.select({ serial: serials.serial }).from(serials).where(and(eq(serials.variantId, line.trackedVariantIds[0]), eq(serials.status, "in_stock"))).limit(line.serialUnits - line.serialsScanned.length);
      for (const row of free) await scanCode(t.db, fulfil, order.orderId, { code: row.serial, scanId: randomToken(12) }, NOW);
    }
    for (let i = line.scanned; i < line.scanUnits; i++) await scanCode(t.db, fulfil, order.orderId, { code: line.sku, scanId: randomToken(12) }, NOW);
  }
  if (options.split) await splitParcel(t.db, fulfil, order.orderId, { lines: [{ orderItemId: progress.lines[0].orderItemId, qty: 1 }] }, NOW);
  await markPacked(t.db, fulfil, order.orderId, NOW);
  const parcels = (await t.db.select().from(shipments).where(eq(shipments.orderId, order.orderId)).all()).filter((parcel) => parcel.status !== "cancelled");
  return { ...order, parcels: parcels.map((parcel) => parcel.id), shipmentId: parcels[0].id };
}

/** Packed, a waybill on every parcel, handed to the courier. */
async function shippedOrder(lines: { variantId: string; qty: number }[], options: { split?: boolean } = {}) {
  const order = await packedOrder(lines, options);
  for (const id of order.parcels) await saveWaybill(t.db, as("fulfillment"), { shipmentId: id, carrierId, serviceLevel: "standard" }, NOW);
  const picked = await pickupParcels(t.db, as("fulfillment"), { shipmentIds: [order.shipmentId] }, NOW);
  expect(picked.failed).toEqual([]);
  return order;
}

async function deliveredCod(priceIqd: number) {
  const product = await stocked(priceIqd, 2);
  const order = await shippedOrder([{ variantId: product.variantId, qty: 1 }]);
  await deliverShipment(t.db, as("fulfillment"), { shipmentId: order.shipmentId, receivedByName: "أبو حسن" }, NOW + HOUR);
  return order;
}

async function parcelRow(id: string) {
  const row = await t.db.select().from(shipments).where(eq(shipments.id, id)).get();
  if (!row) throw new Error("parcel missing");
  return row;
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

// ───────────────────────────────────────────────────────────────── signed-in requests (route modules)

let roleSeq = 0;
/** A signed-in employee (session cookie) with a built-in role, or a role made of exactly these permissions. */
async function signedIn(role: DefaultRoleKey | Permission[]): Promise<string> {
  const password = "shipping-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("rev")}@shipping-review.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (Array.isArray(role)) {
    const custom = `rol_review_${++roleSeq}`;
    await t.db.insert(roles).values({ id: custom, key: `review_${roleSeq}`, name: { ar: "دور مراجعة", en: "Review role" }, isSystem: false, createdAt: NOW });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
  } else {
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  }
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Runs a loader or an action inside the request middleware; returns what it returned or threw. */
async function run(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown, body?: FormData): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, body ? { method: "POST", headers: { cookie, origin: ORIGIN }, body } : { headers: { cookie } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params, url: new URL(request.url), pattern: path } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}
const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : undefined);
const formOf = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
};

function requestCtx(): RequestCtx {
  return {
    requestId: `review-${randomToken(6)}`,
    nonce: "n",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie: () => {},
  };
}

/** A hand-made request for the parcel page's action glue (as the shipment route builds it). */
function parcelReq(actor: EmployeeActor): ShippingRequest {
  const session = {
    employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
    actor: { ...actor, permissions: new Set(actor.permissions) },
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
  } as unknown as EmployeeSession;
  return { ctx: requestCtx(), db: t.db as never, session, actor: session.actor, locale: "en", now: NOW + HOUR };
}

// ───────────────────────────────────────────────────────────────── the tests

describe("11.04 two people for every difference", () => {
  test("a corrected parcel is a difference too: whoever corrected, prepared or submitted it does not reconcile it", async () => {
    const finance = as("finance");
    const order = await deliveredCod(80_000);
    const draft = await createSettlement(t.db, finance, { carrierId, shipmentIds: [order.shipmentId], idempotencyKey: randomToken(12) }, NOW + 2 * HOUR);
    let view = await getSettlement(t.db, finance, draft.settlementId, "ar");
    const item = view.items[0];
    // the courier remitted 5,000 less than the carrier owes: booking it as a higher carrier charge needs a reason …
    expect(await failureOf(updateSettlementItem(t.db, finance, { settlementId: draft.settlementId, shipmentId: order.shipmentId, amountIqd: item.amountIqd, feeIqd: item.feeIqd + 5000 }, NOW))).toMatchObject({ fields: { reason: "required" } });
    await updateSettlementItem(t.db, finance, { settlementId: draft.settlementId, shipmentId: order.shipmentId, amountIqd: item.amountIqd, feeIqd: item.feeIqd + 5000, reason: "رسوم إضافية في كشف الشركة" }, NOW);
    view = await getSettlement(t.db, finance, draft.settlementId, "ar");
    const before = { mine: (await shippingOverview(t.db, finance, NOW)).toReconcile, other: (await shippingOverview(t.db, as("finance2"), NOW)).toReconcile };
    // … and with the variance now 0, the preparer still cannot reconcile it alone
    await submitCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedIqd: view.totals.netDueIqd }, NOW + 3 * HOUR);
    view = await getSettlement(t.db, finance, draft.settlementId, "ar");
    expect(view.totals.varianceIqd).toBe(0);
    expect(view.can).toMatchObject({ reconcile: false, reconcileReason: "self" });
    expect((await shippingOverview(t.db, finance, NOW)).toReconcile).toBe(before.mine);
    expect((await shippingOverview(t.db, as("finance2"), NOW)).toReconcile).toBe(before.other + 1);
    expect(await failureOf(reconcileCodSettlement(t.db, finance, { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "مقبول" }, NOW + 4 * HOUR))).toMatchObject({ code: "settlement_self_reconcile", status: 403 });
    expect((await t.db.select().from(payments).where(and(eq(payments.orderId, order.orderId), eq(payments.method, "cod"))).get())?.status).toBe("pending");
    expect((await t.db.select().from(codSettlements).where(eq(codSettlements.id, draft.settlementId)).get())?.status).toBe("submitted");
    // a second person decides it (and says why)
    expect(await failureOf(reconcileCodSettlement(t.db, as("finance2"), { settlementId: draft.settlementId, receivedInto: "bank_clearing" }, NOW + 4 * HOUR))).toMatchObject({ fields: { reason: "variance_note_required" } });
    const done = await reconcileCodSettlement(t.db, as("finance2"), { settlementId: draft.settlementId, receivedInto: "bank_clearing", reason: "طابقت كشف الشركة" }, NOW + 4 * HOUR);
    expect(done.replayed).toBe(false);
    // the settled parcel's history never hands the carrier's charge to a role that only reads parcels
    const parcel = await getShipment(t.db, as("support"), order.shipmentId, "ar", NOW);
    expect(parcel.events.find((event) => event.kind === "cod_settled")?.data).not.toHaveProperty("feeIqd");
  });
});

describe("authorization: 403 before anything else", () => {
  test("the zones and carriers pages answer 403, not a crash, to a role that passes the gate without their permission", async () => {
    const codOnly = await signedIn(["dashboard.overview.read", "shipping.cod.settle"]);
    expect(statusOf(await run(codOnly, "/admin/shipping/zones", {}, zonesLoader as never))).toBe(403);
    expect(statusOf(await run(codOnly, "/admin/shipping/carriers", {}, carriersLoader as never))).toBe(403);
  });

  test("actions check the permission before they read the input", async () => {
    const product = await stocked(30_000, 2);
    const order = await packedOrder([{ variantId: product.variantId, qty: 1 }]);
    // support reads parcels but does not make waybills: 403, whatever the cost field says
    const store = () => ({ put: async () => {}, get: async () => null, delete: async () => {} });
    expect(await failureOf(parcelAction(parcelReq(as("support")), order.shipmentId, formOf({ intent: "waybill", carrierId, serviceLevel: "standard", costIqd: "abc" }), store))).toMatchObject({ code: "forbidden" });
    // fulfilment staff do not change fees or estimates
    const fulfilment = await signedIn("fulfillment");
    const baghdad = governorateId("baghdad");
    expect(statusOf(await run(fulfilment, "/admin/shipping/zones", {}, zonesAction as never, formOf({ intent: "flat", feeIqd: "abc", expected: "5000", reason: "x" })))).toBe(403);
    expect(statusOf(await run(fulfilment, "/admin/shipping/zones", {}, zonesAction as never, formOf({ intent: "all", feeIqd: "abc", expected: "", reason: "x" })))).toBe(403);
    expect(statusOf(await run(fulfilment, `/admin/shipping/zones/${baghdad}`, { governorateId: baghdad }, zoneAction as never, formOf({ intent: "eta", etaDaysMin: "x", etaDaysMax: "2" })))).toBe(403);
    expect(statusOf(await run(fulfilment, `/admin/shipping/zones/${baghdad}`, { governorateId: baghdad }, zoneAction as never, formOf({ intent: "override", feeIqd: "x", expected: "", reason: "x" })))).toBe(403);
    // the parcel page's action needs the page's permission before anything is read or looked up
    const codOnly = await signedIn(["dashboard.overview.read", "shipping.cod.settle"]);
    expect(statusOf(await run(codOnly, `/admin/shipping/shipments/${order.shipmentId}`, { shipmentId: order.shipmentId }, parcelRouteAction as never, formOf({ intent: "nonsense" })))).toBe(403);
    expect(statusOf(await run(codOnly, "/admin/shipping/shipments/shp_none_1", { shipmentId: "shp_none_1" }, parcelRouteAction as never, formOf({ intent: "sync" })))).toBe(403);
  });

  test("carrier rates and charges reach only who chooses carriers, settles with them or sees cost", async () => {
    const product = await stocked(45_000, 2);
    const order = await packedOrder([{ variantId: product.variantId, qty: 1 }]);
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: order.shipmentId, carrierId, serviceLevel: "standard" }, NOW);
    const baghdad = governorateId("baghdad");
    for (const role of ["support", "inventory"] as const) {
      const reader = as(role);
      const parcel = await getShipment(t.db, reader, order.shipmentId, "ar", NOW);
      expect(parcel, role).not.toHaveProperty("costIqd");
      const carrier = await getCarrier(t.db, reader, carrierId, "ar");
      const levels = carrier.rates.flatMap((row) => Object.values(row.levels)).filter((level) => level !== null);
      expect(levels.length).toBeGreaterThan(0);
      for (const level of levels) expect(level, role).not.toHaveProperty("costIqd");
      expect(carrier.carrier, role).not.toHaveProperty("codFeeBps");
      expect((await listCarriers(t.db, reader)).find((row) => row.id === carrierId), role).not.toHaveProperty("codFeeIqd");
      const zone = await getZone(t.db, reader, baghdad, "ar");
      expect(zone.carrierRates.length).toBeGreaterThan(0);
      for (const rate of zone.carrierRates) expect(rate, role).not.toHaveProperty("costIqd");
    }
    // the people who choose carriers still see what each charges
    expect((await getShipment(t.db, as("fulfillment"), order.shipmentId, "ar", NOW)).costIqd).toBe(4000);
    expect((await getCarrier(t.db, as("fulfillment"), carrierId, "ar")).rates.find((row) => row.governorateId === baghdad)?.levels.standard).toMatchObject({ costIqd: 4000 });
    expect((await getZone(t.db, as("finance"), baghdad, "ar")).carrierRates[0]).toMatchObject({ costIqd: 4000 });
  });
});

describe("typed amounts", () => {
  test("a decimal mark is refused, never dropped; the cash fee % accepts the Arabic decimal separator", () => {
    expect(digitsOnly("5000.5")).toBe("5000.5");
    expect(digitsOnly("٥٠٠٠٫٥")).toBe("5000.5");
    expect(digitsOnly("٥٬٠٠٠")).toBe("5000");
    expect(digitsOnly("۷۵۴,۰۰۰")).toBe("754000");
    expect(digitsOnly("-3,000", true)).toBe("-3000");
    expect(amount(formOf({ feeIqd: digitsOnly("5000.5") }), "feeIqd")).toBeNaN();
    expect(carrierFromForm(formOf({ codFeePct: "١٫٥" })).codFeeBps).toBe(150);
    expect(carrierFromForm(formOf({ codFeePct: "2.25" })).codFeeBps).toBe(225);
    expect(carrierFromForm(formOf({ codFeePct: "" })).codFeeBps).toBeNull();
  });
});

describe("printed documents", () => {
  test("the pickup manifest marks parcels that must not be handed over and leaves their cash out of the total", async () => {
    const product = await stocked(55_000, 4);
    const ready = await packedOrder([{ variantId: product.variantId, qty: 1 }]);
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: ready.shipmentId, carrierId, serviceLevel: "standard" }, NOW);
    const delivered = await deliveredCod(66_000);
    const [manifest] = await manifestDocs(t.db, as("fulfillment"), [ready.shipmentId, delivered.shipmentId], "ar", NOW);
    const readyTotal = (await t.db.select({ total: orders.totalIqd }).from(orders).where(eq(orders.id, ready.orderId)).get())!.total;
    expect(manifest.rows.find((row) => row.code === `${ready.ref}-1`)).toMatchObject({ shippable: true, collectIqd: readyTotal });
    expect(manifest.rows.find((row) => row.code === `${delivered.ref}-1`)).toMatchObject({ shippable: false, collectIqd: 0 });
    expect(manifest.totals).toEqual({ parcels: 1, collectIqd: readyTotal });
  });
});

describe("races: the competing request lands just before the write batch", () => {
  test("a parcel delivered while its order is taken back: the return is refused and nothing goes back into stock", async () => {
    const product = await stocked(35_000, 4);
    const order = await shippedOrder([{ variantId: product.variantId, qty: 2 }], { split: true });
    expect(order.parcels).toHaveLength(2);
    const [first, second] = order.parcels;
    const racing = beforeBatch(t.db, 1, () => deliverParcel(t.db, as("fulfillment"), { shipmentId: first, receivedByName: "زينب" }, NOW + HOUR));
    expect(await failureOf(returnParcels(racing, as("fulfillment"), { orderId: order.orderId, reason: "الطرد رجع من المندوب" }, NOW + HOUR))).toMatchObject({ code: "parcel_partly_delivered" });
    expect((await t.db.select({ status: orders.status }).from(orders).where(eq(orders.id, order.orderId)).get())?.status).toBe("shipped");
    expect((await parcelRow(first)).status).toBe("delivered");
    expect((await parcelRow(second)).status).not.toBe("returned");
  });

  test("an order taken back by another path while one of its parcels is recorded delivered: the delivery is refused", async () => {
    const product = await stocked(32_000, 4);
    const order = await shippedOrder([{ variantId: product.variantId, qty: 2 }], { split: true });
    const [first] = order.parcels;
    // the orders module (or any caller of the core) moves the order shipped → returned just before the parcel's batch
    const racing = beforeBatch(t.db, 1, () => transitionOrder(t.db, as("manager"), order.orderId, "returned", { reason: "رجع مع المندوب", from: "shipped" }, NOW + HOUR));
    expect(await failureOf(deliverParcel(racing, as("fulfillment"), { shipmentId: first, receivedByName: "علي" }, NOW + HOUR))).toMatchObject({ code: "order_not_shipped" });
    expect((await parcelRow(first)).status).not.toBe("delivered");
  });

  test("one tracking number given to two parcels at the same moment: the second is refused", async () => {
    const product = await stocked(25_000, 4);
    const a = await packedOrder([{ variantId: product.variantId, qty: 1 }]);
    const b = await packedOrder([{ variantId: product.variantId, qty: 1 }]);
    const racing = beforeBatch(t.db, 1, () => saveWaybill(t.db, as("fulfillment"), { shipmentId: a.shipmentId, carrierId, serviceLevel: "standard", trackingNo: "REV-55501" }, NOW));
    expect(await failureOf(saveWaybill(racing, as("fulfillment"), { shipmentId: b.shipmentId, carrierId, serviceLevel: "standard", trackingNo: "rev-55501" }, NOW))).toMatchObject({ fields: { trackingNo: "tracking_taken" } });
    expect((await parcelRow(a.shipmentId)).trackingNo).toBe("REV-55501");
    expect((await parcelRow(b.shipmentId)).carrierId).toBeNull();
  });

  test("a fee override changed by someone else meanwhile is not overwritten without notice", async () => {
    const basra = governorateId("basra");
    const racing = beforeBatch(t.db, 1, () => setOverrideFee(t.db, as("manager"), { governorateId: basra, feeIqd: 7000, expectedIqd: null, reason: "طرق البصرة" }, NOW));
    expect(await failureOf(setOverrideFee(racing, as("manager2"), { governorateId: basra, feeIqd: 8000, expectedIqd: null, reason: "سعر جديد" }, NOW))).toMatchObject({ code: "fee_changed" });
    const active = await t.db.select({ feeIqd: shippingRates.feeIqd }).from(shippingRates).where(and(eq(shippingRates.governorateId, basra), eq(shippingRates.isOverride, true), eq(shippingRates.isActive, true))).all();
    expect(active).toEqual([{ feeIqd: 7000 }]);
  });
});

describe("ids from the form and half-done bulk moves", () => {
  test("a district of another governorate cannot be switched from this governorate's page", async () => {
    const basraDistrict = districtId("basra", "basra");
    expect(await failureOf(setDistrictActive(t.db, as("manager"), { governorateId: governorateId("baghdad"), districtId: basraDistrict, isActive: false, reason: "خارج التغطية" }, NOW))).toMatchObject({ code: "not_found" });
    const manager = await signedIn("manager");
    const baghdad = governorateId("baghdad");
    const result = await run(manager, `/admin/shipping/zones/${baghdad}`, { governorateId: baghdad }, zoneAction as never, formOf({ intent: "district_active", districtId: basraDistrict, isActive: "0", reason: "خارج التغطية" }));
    expect(statusOf(result)).toBe(404);
    expect((await t.db.select({ isActive: districts.isActive }).from(districts).where(eq(districts.id, basraDistrict)).get())?.isActive).toBe(true);
  });

  test("a bulk move that needs a permission the employee lacks moves nothing", async () => {
    const product = await stocked(20_000, 4);
    const one = await shippedOrder([{ variantId: product.variantId, qty: 1 }]);
    const two = await shippedOrder([{ variantId: product.variantId, qty: 1 }]);
    // the parcel read first stays on the road; the other failed at the door (a retry needs shipping.attempt.manage)
    const [onRoad, failedTry] = [one.shipmentId, two.shipmentId].sort();
    await recordAttempt(t.db, as("fulfillment"), { shipmentId: failedTry, outcome: "no_answer" }, NOW + HOUR);
    const noRetry: EmployeeActor = { kind: "employee", id: as("manager2").id, permissions: new Set<Permission>(["shipping.shipment.read", "shipping.shipment.update"]) };
    expect(await failureOf(moveParcels(t.db, noRetry, { shipmentIds: [onRoad, failedTry], to: "out_for_delivery" }, NOW + 2 * HOUR))).toMatchObject({ code: "forbidden" });
    expect((await parcelRow(onRoad)).status).toBe("handed_over");
    expect((await parcelRow(failedTry)).status).toBe("failed");
  });

  test("an upload is refused before it is stored when the state refuses the action", async () => {
    // a sensitive device delivered without the receiver's name: refused, and the photo never reaches storage
    const console_ = await stocked(450_000, 2, "console");
    const order = await packedOrder([{ variantId: console_.variantId, qty: 1 }]);
    await saveWaybill(t.db, as("fulfillment"), { shipmentId: order.shipmentId, carrierId, serviceLevel: "standard" }, NOW);
    const packing = newId("fil");
    await t.db.insert(files).values({ id: packing, storageKey: `prv_${packing}.jpg`, visibility: "private", kind: "packing_photo", mime: "image/jpeg", bytes: 10, sha256: randomToken(), createdAt: NOW });
    await t.db.update(shipments).set({ packingFileId: packing }).where(eq(shipments.id, order.shipmentId));
    expect((await pickupParcels(t.db, as("fulfillment"), { shipmentIds: [order.shipmentId] }, NOW)).failed).toEqual([]);
    let stored = 0;
    const store = () => ({ put: async () => void stored++, get: async () => null, delete: async () => {} });
    const deliver = formOf({ intent: "deliver", from: "handed_over" });
    deliver.append("file", new File([PNG], "proof.png", { type: "image/png" }));
    expect(await failureOf(parcelAction(parcelReq(as("fulfillment")), order.shipmentId, deliver, store))).toMatchObject({ fields: { receivedByName: "receiver_required" } });
    expect(stored).toBe(0);
    // a statement on a settlement already in the books: refused before the file is kept
    const cash = await deliveredCod(70_000);
    const draft = await createSettlement(t.db, as("finance"), { carrierId, shipmentIds: [cash.shipmentId], idempotencyKey: randomToken(12) }, NOW);
    const settlement = await getSettlement(t.db, as("finance"), draft.settlementId, "ar");
    await submitCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedIqd: settlement.totals.netDueIqd }, NOW);
    await reconcileCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedInto: "cash" }, NOW);
    const finance = await signedIn("finance");
    const upload = formOf({ intent: "statement" });
    upload.append("file", new File([PNG], "statement.png", { type: "image/png" }));
    const result = await run(finance, `/admin/shipping/cod/${draft.settlementId}`, { settlementId: draft.settlementId }, settlementAction as never, upload);
    expect(statusOf(result)).toBe(409);
    const kept = await t.db.select({ n: sql<number>`count(*)` }).from(files).where(and(eq(files.kind, "cod_statement"), eq(files.ownerId, draft.settlementId))).get();
    expect(Number(kept?.n ?? 0)).toBe(0);
  });
});
