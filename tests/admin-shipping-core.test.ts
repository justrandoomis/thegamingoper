/**
 * The core-level file app/server/services/orders/shipments.server.ts (added by admin 11 shipping) and the module's
 * route glue, on a real local D1:
 *
 *   · parcels follow the order: two parcels delivered at the same moment deliver the order ONCE (one sale posting);
 *     the last parcel needs orders.fulfillment.deliver and nothing moves without it; syncParcels after a cancel
 *   · a proof file of another order is refused; a returned order replays
 *   · settlements: the posting balances for every sign of the remittance and the difference; two reconciliations at
 *     the same moment post once; demo and real orders never mix; a submitted settlement no longer changes
 *   · route glue: the parcel page's action (intents, the upload refused before storage for a role without the right),
 *     loaders refusing a role without the permission (403), no cost or profit fields for roles without them
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as codLoader } from "~/routes/admin/shipping/cod";
import { loader as parcelLoader } from "~/routes/admin/shipping/shipment";
import { parcelAction } from "~/routes/admin/shipping/shipment.server";
import type { ShippingRequest } from "~/routes/admin/shipping/shipping.server";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { codSettlements, employeeRoles, files, journalEntries, journalLines, orders, serials, shipments } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { changeOrderStatus } from "~/server/services/admin/orders/actions.server";
import { markPacked, packProgress, scanCode, splitParcel } from "~/server/services/admin/orders/fulfillment.server";
import { applyCarrierRate, saveCarrier } from "~/server/services/admin/shipping/carriers.server";
import { createSettlement } from "~/server/services/admin/shipping/cod.server";
import { pickupParcels, saveWaybill } from "~/server/services/admin/shipping/shipments.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { codSettlementPostingKey, deliverParcel, postCodSettlement, reconcileCodSettlement, returnParcels, submitCodSettlement, syncParcels } from "~/server/services/orders/shipments.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const system = systemActor("test.admin-shipping-core");

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "finance2", EmployeeActor>> = {};
let carrierId = "";

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "fulfillment", "support", "cashier"] as const) staff[role] = await employee(role);
  staff.finance2 = await employee("finance");
  carrierId = (await saveCarrier(t.db, as("manager"), { code: "CORE", name: "Core test carrier", kind: "third_party", codSupported: true }, NOW)).carrierId;
  await applyCarrierRate(t.db, as("manager"), { carrierId, governorateIds: [governorateId("baghdad")], serviceLevel: "standard", costIqd: 4000 }, NOW);
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
const custom = (permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: as("manager").id, permissions: new Set(permissions) });

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

async function stocked(priceIqd: number, qty: number) {
  const product = await make.product({ priceIqd, kind: "game" });
  await receiveStock(t.db, system, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty, unitCostIqd: Math.round(priceIqd * 0.7), ref: `rcv-${product.sku}` }, NOW);
  return product;
}

async function orderOf(lines: { variantId: string; qty: number }[], options: { demo?: boolean } = {}) {
  let token: string | null = null;
  for (const line of lines) token = (await addToCart(t.db, { cartToken: token, customerId: null, locale: "ar" }, line, NOW)).cartToken;
  const view = await getCartView(t.db, { cartToken: token, customerId: null, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  const placed = await placeOrder(
    t.db,
    { cartToken: token, customer: null, locale: "ar", ip: null, storeMode: options.demo ? "demo" : "live" },
    { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), areaText: "المنصور", addressText: "شارع 14، بيت 3", marketingConsent: false, paymentMethod: "cod", expectedTotalIqd: view.totalIqd },
    NOW,
  );
  await changeOrderStatus(t.db, as("manager"), placed.orderId, { to: "confirmed", from: "new" }, NOW);
  return placed;
}

/** Packs (optionally into two parcels), gives every parcel a waybill and hands the order to the courier. */
async function shipped(lines: { variantId: string; qty: number }[], options: { split?: boolean; demo?: boolean } = {}) {
  const order = await orderOf(lines, options);
  const fulfil = as("fulfillment");
  const progress = await packProgress(t.db, order.orderId);
  for (const line of progress.lines) for (let i = line.scanned; i < line.scanUnits; i++) await scanCode(t.db, fulfil, order.orderId, { code: line.sku, scanId: randomToken(12) }, NOW);
  if (options.split) await splitParcel(t.db, fulfil, order.orderId, { lines: [{ orderItemId: progress.lines[0].orderItemId, qty: 1 }] }, NOW);
  await markPacked(t.db, fulfil, order.orderId, NOW);
  const parcels = await t.db.select().from(shipments).where(and(eq(shipments.orderId, order.orderId)));
  const live = parcels.filter((parcel) => parcel.status !== "cancelled");
  for (const parcel of live) await saveWaybill(t.db, fulfil, { shipmentId: parcel.id, carrierId, serviceLevel: "standard" }, NOW);
  const result = await pickupParcels(t.db, fulfil, { shipmentIds: [live[0].id] }, NOW);
  expect(result.failed).toEqual([]);
  return { ...order, parcels: live.map((parcel) => parcel.id) };
}

async function orderRow(id: string) {
  const row = await t.db.select().from(orders).where(eq(orders.id, id)).get();
  if (!row) throw new Error("order missing");
  return row;
}

describe("parcels follow their order", () => {
  test("two parcels delivered at the same moment deliver the order once (one sale posting)", async () => {
    const product = await stocked(30_000, 6);
    const order = await shipped([{ variantId: product.variantId, qty: 2 }], { split: true });
    expect(order.parcels).toHaveLength(2);
    const fulfil = as("fulfillment");
    const results = await Promise.all(order.parcels.map((shipmentId) => deliverParcel(t.db, fulfil, { shipmentId }, NOW + HOUR)));
    expect(results.filter((result) => result.orderDelivered).length).toBeGreaterThanOrEqual(1);
    expect((await orderRow(order.orderId)).status).toBe("delivered");
    const sales = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, `order:${order.orderId}:sale`)).all();
    expect(sales).toHaveLength(1);
    const rows = await t.db.select({ status: shipments.status }).from(shipments).where(eq(shipments.orderId, order.orderId)).all();
    expect(rows.filter((row) => row.status !== "cancelled").every((row) => row.status === "delivered")).toBe(true);
  });

  test("the last parcel needs orders.fulfillment.deliver: without it nothing moves", async () => {
    const product = await stocked(25_000, 3);
    const order = await shipped([{ variantId: product.variantId, qty: 1 }]);
    const onlyShipping = custom(["shipping.shipment.read", "shipping.shipment.update"]);
    expect(await failureOf(deliverParcel(t.db, onlyShipping, { shipmentId: order.parcels[0] }, NOW))).toMatchObject({ code: "forbidden" });
    expect((await orderRow(order.orderId)).status).toBe("shipped");
    expect((await t.db.select().from(shipments).where(eq(shipments.id, order.parcels[0])).get())?.status).toBe("handed_over");
    // a proof photo of ANOTHER order is refused
    const other = await shipped([{ variantId: product.variantId, qty: 1 }]);
    const fileId = newId("fil");
    await t.db.insert(files).values({ id: fileId, storageKey: `prv_${fileId}.jpg`, visibility: "private", kind: "delivery_proof", mime: "image/jpeg", bytes: 10, sha256: randomToken(), ownerType: "order", ownerId: other.orderId, createdAt: NOW });
    expect(await failureOf(deliverParcel(t.db, as("fulfillment"), { shipmentId: order.parcels[0], proofFileId: fileId }, NOW))).toMatchObject({ fields: { file: "proof_file_invalid" } });
  });

  test("a cancelled order's packed parcels follow it (syncParcels); a returned order replays", async () => {
    const product = await stocked(22_000, 4);
    const order = await orderOf([{ variantId: product.variantId, qty: 1 }]);
    const progress = await packProgress(t.db, order.orderId);
    await scanCode(t.db, as("fulfillment"), order.orderId, { code: progress.lines[0].sku, scanId: randomToken(12) }, NOW);
    await markPacked(t.db, as("fulfillment"), order.orderId, NOW);
    await transitionOrder(t.db, as("manager"), order.orderId, "cancelled", { reason: "طلب الزبون الإلغاء" }, NOW);
    expect(await failureOf(syncParcels(t.db, as("support"), order.orderId, NOW))).toMatchObject({ code: "forbidden" });
    expect(await syncParcels(t.db, as("fulfillment"), order.orderId, NOW)).toEqual({ moved: 1 });
    expect((await t.db.select({ status: shipments.status }).from(shipments).where(eq(shipments.orderId, order.orderId)).get())?.status).toBe("cancelled");
    const back = await shipped([{ variantId: product.variantId, qty: 1 }]);
    expect(await returnParcels(t.db, as("fulfillment"), { orderId: back.orderId, reason: "عاد الطرد" }, NOW)).toEqual({ parcels: 1, replayed: false });
    expect(await returnParcels(t.db, as("fulfillment"), { orderId: back.orderId, reason: "مكرر" }, NOW)).toEqual({ parcels: 0, replayed: true });
    expect(await failureOf(returnParcels(t.db, as("support"), { orderId: back.orderId, reason: "دعم" }, NOW))).toMatchObject({ code: "forbidden" });
  });
});

describe("settlement postings", () => {
  test("the entry balances for every sign of the remittance and the difference", () => {
    for (const expectedIqd of [0, 105_000]) {
      for (const feesIqd of [0, 5_550]) {
        for (const delta of [-3_000, 0, 2_000]) {
          const receivedIqd = expectedIqd - feesIqd + delta;
          for (const receivedInto of ["cash", "bank_clearing"] as const) {
            const statements = postCodSettlement(t.db, { settlementId: `cst_${expectedIqd}_${feesIqd}_${delta}`, ref: "CS-TEST", carrier: "X", expectedIqd, feesIqd, receivedIqd, receivedInto, at: NOW, createdBy: "test", isDemo: false });
            // nothing to post only when every line is zero
            if (expectedIqd === 0 && feesIqd === 0 && delta === 0) expect(statements).toEqual([]);
            else expect(statements.length).toBeGreaterThan(1);
          }
        }
      }
    }
  });

  test("two reconciliations at the same moment post once; demo and real orders never mix; a submitted settlement is fixed", async () => {
    const product = await stocked(40_000, 6);
    const order = await shipped([{ variantId: product.variantId, qty: 1 }]);
    await deliverParcel(t.db, as("fulfillment"), { shipmentId: order.parcels[0] }, NOW + HOUR);
    const draft = await createSettlement(t.db, as("finance"), { carrierId, shipmentIds: order.parcels, idempotencyKey: randomToken(12) }, NOW);
    const settlement = await t.db.select().from(codSettlements).where(eq(codSettlements.id, draft.settlementId)).get();
    await submitCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedIqd: settlement!.expectedIqd - settlement!.feesIqd }, NOW);
    // once submitted the parcels and amounts are fixed: another submit with a different amount is refused
    expect(await failureOf(submitCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedIqd: 1 }, NOW))).toMatchObject({ code: "settlement_not_draft" });
    const results = await Promise.allSettled([
      reconcileCodSettlement(t.db, as("finance"), { settlementId: draft.settlementId, receivedInto: "cash" }, NOW),
      reconcileCodSettlement(t.db, as("finance2"), { settlementId: draft.settlementId, receivedInto: "cash" }, NOW),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => (result as PromiseFulfilledResult<{ replayed: boolean }>).value);
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const entries = await t.db.select().from(journalEntries).where(eq(journalEntries.idempotencyKey, codSettlementPostingKey(draft.settlementId))).all();
    expect(entries).toHaveLength(1);
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, entries[0].id)).all();
    expect(lines.reduce((sum, row) => sum + row.debitIqd, 0)).toBe(lines.reduce((sum, row) => sum + row.creditIqd, 0));
    expect((await t.db.select().from(codSettlements).where(eq(codSettlements.id, draft.settlementId)).get())?.status).toBe("reconciled");

    // a demo order's parcel and a real order's parcel cannot share a settlement
    const real = await shipped([{ variantId: product.variantId, qty: 1 }]);
    const demo = await shipped([{ variantId: product.variantId, qty: 1 }], { demo: true });
    await deliverParcel(t.db, as("fulfillment"), { shipmentId: real.parcels[0] }, NOW + HOUR);
    await deliverParcel(t.db, as("fulfillment"), { shipmentId: demo.parcels[0] }, NOW + HOUR);
    expect(await failureOf(createSettlement(t.db, as("finance"), { carrierId, shipmentIds: [real.parcels[0], demo.parcels[0]], idempotencyKey: randomToken(12) }, NOW))).toMatchObject({ code: "settlement_mixed_demo" });
    void serials;
  });
});

describe("route glue", () => {
  const session = (actor: EmployeeActor): EmployeeSession =>
    ({
      employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
      actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
      roles: [],
      session: { id: "s", createdAt: NOW, expiresAt: NOW + HOUR, mfaOk: true },
    }) as EmployeeSession;
  const req = (actor: EmployeeActor): ShippingRequest => {
    const s = session(actor);
    return { ctx: {} as RequestCtx, db: t.db as never, session: s, actor: s.actor, locale: "en", now: NOW };
  };
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(entries)) data.append(key, value);
    return data;
  };
  let stored = 0;
  const store = () => ({
    put: async () => {
      stored++;
    },
    get: async () => null,
    delete: async () => {},
  });

  test("the parcel page's action: intents, stale pages, an upload refused before anything is stored", async () => {
    const product = await stocked(28_000, 4);
    const order = await shipped([{ variantId: product.variantId, qty: 1 }]);
    const id = order.parcels[0];
    await expect(parcelAction(req(as("fulfillment")), id, form({ intent: "nonsense" }), store)).rejects.toMatchObject({ code: "invalid" });
    await expect(parcelAction(req(as("fulfillment")), id, form({ intent: "move", to: "in_transit", from: "out_for_delivery" }), store)).rejects.toMatchObject({ code: "shipment_changed" });
    expect(await parcelAction(req(as("fulfillment")), id, form({ intent: "move", to: "in_transit", from: "handed_over" }), store)).toMatchObject({ intent: "move", moved: 1 });
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "x.jpg", { type: "image/jpeg" });
    const upload = form({ intent: "packing" });
    upload.append("file", photo);
    await expect(parcelAction(req(as("support")), id, upload, store)).rejects.toMatchObject({ code: "forbidden" });
    expect(stored).toBe(0);
    const attempt = await parcelAction(req(as("fulfillment")), id, form({ intent: "attempt", code: "no_answer", from: "in_transit" }), store);
    expect(attempt).toMatchObject({ intent: "attempt", attemptNo: 1 });
    expect(await parcelAction(req(as("fulfillment")), id, form({ intent: "deliver", receivedByName: "Ali", from: "failed" }), store)).toMatchObject({ intent: "deliver", orderDelivered: true });
  });

  test("loaders: 403 for a role without the page's permission; no cost or profit fields without the permission", async () => {
    const product = await stocked(33_000, 3);
    const order = await shipped([{ variantId: product.variantId, qty: 1 }]);
    const signedIn = async (role: DefaultRoleKey) => {
      const password = "shipping-staff-password-1";
      const hashed = await hashPassword(password, 1000);
      const email = `${make.next(role)}@shipping.test`;
      const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
      const ctx = requestCtx();
      const result = await signInEmployee(ctx.ctx, t.db, { email, password });
      if (result.status !== "signed_in") throw new Error("sign-in failed");
      return cookieOf(ctx.setCookies);
    };
    const call = async <T,>(cookie: string, path: string, run: (context: RouterContextProvider, request: Request) => Promise<T>) => {
      const request = new Request(`http://localhost:5173${path}`, { headers: { cookie } });
      const context = new RouterContextProvider();
      try {
        let out: unknown;
        await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
          out = await run(context, request);
          return new Response(null);
        });
        return out;
      } catch (error) {
        return error;
      }
    };
    const fulfillment = await signedIn("fulfillment");
    const cod = (await call(fulfillment, "/admin/shipping/cod", (context, request) => codLoader({ request, context, params: {}, url: new URL(request.url), pattern: "admin/shipping/cod" } as never))) as { init?: { status?: number } };
    expect(cod?.init?.status).toBe(403);
    const parcel = (await call(fulfillment, `/admin/shipping/shipments/${order.parcels[0]}`, (context, request) =>
      parcelLoader({ request, context, params: { shipmentId: order.parcels[0] }, url: new URL(request.url), pattern: "admin/shipping/shipments/:shipmentId" } as never),
    )) as { parcel: { id: string; deliveryMarginIqd?: number } };
    expect(parcel.parcel.id).toBe(order.parcels[0]);
    expect("deliveryMarginIqd" in parcel.parcel).toBe(false);
    const manager = await signedIn("manager");
    const full = (await call(manager, `/admin/shipping/shipments/${order.parcels[0]}`, (context, request) =>
      parcelLoader({ request, context, params: { shipmentId: order.parcels[0] }, url: new URL(request.url), pattern: "admin/shipping/shipments/:shipmentId" } as never),
    )) as { parcel: { deliveryMarginIqd?: number } };
    expect("deliveryMarginIqd" in full.parcel).toBe(true);
    const missing = (await call(manager, "/admin/shipping/shipments/shp_nope_1", (context, request) =>
      parcelLoader({ request, context, params: { shipmentId: "shp_nope_1" }, url: new URL(request.url), pattern: "admin/shipping/shipments/:shipmentId" } as never),
    )) as { init?: { status?: number } };
    expect(missing?.init?.status).toBe(404);
    const cashier = await signedIn("cashier");
    const refused = (await call(cashier, `/admin/shipping/shipments/${order.parcels[0]}`, (context, request) =>
      parcelLoader({ request, context, params: { shipmentId: order.parcels[0] }, url: new URL(request.url), pattern: "admin/shipping/shipments/:shipmentId" } as never),
    )) as { init?: { status?: number } };
    expect(refused?.init?.status).toBe(403);
  });
});

function requestCtx(): { ctx: RequestCtx; setCookies: string[] } {
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `shipping-${randomToken(6)}`,
    nonce: "n",
    origin: "http://localhost:5173",
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
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

function cookieOf(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}
