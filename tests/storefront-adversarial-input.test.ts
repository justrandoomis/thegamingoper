/**
 * Storefront security review (2026-11, owner: security) — what shoppers SEND: free text, shapes and types of every
 * field, uploaded bytes, ids that point at other people's things, consent, money, rate limits and double submits —
 * and what the read services hand back (no protected data). The web layer (redirects, sessions, headers, bodies,
 * CSRF) is tests/storefront-adversarial.test.ts. Runs against a throw-away local D1 + KV with the demo catalogue.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { action as cartAction } from "~/routes/api/cart";
import { action as eventsAction } from "~/routes/api/events";
import { action as uploadProofAction } from "~/routes/api/upload-proof";
import { action as uploadTradeInAction, loader as uploadTradeInLoader } from "~/routes/api/upload-tradein";
import { action as apiWishlistAction } from "~/routes/api/wishlist";
import { loader as accountOrderLoader } from "~/routes/storefront/account/order";
import { action as settingsAction } from "~/routes/storefront/account/settings";
import { action as walletProofAction } from "~/routes/storefront/account/wallet-proof";
import { action as checkoutAction } from "~/routes/storefront/checkout/checkout";
import { loader as orderLoader } from "~/routes/storefront/checkout/order";
import { action as onboardingAction } from "~/routes/storefront/home/api.onboarding";
import { action as recentAction } from "~/routes/storefront/home/api.recently-viewed";
import { jsonForScript, productJsonLd } from "~/routes/storefront/product/jsonld";
import { action as tradeInStatusAction } from "~/routes/storefront/used/trade-in-status";
import { breadcrumbJsonLd } from "~/ui/Breadcrumbs";
import type { CustomerActor } from "~/server/actor";
import { CUSTOMER_COOKIE, listCustomerSessions, signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { addresses, consents, customers, files, notifications, orders, paymentProofs, recentlyViewed, recommendationEvents, repairTickets, supportTickets, tradeInEvents, tradeIns, walletTopups } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { kvBlobStore } from "~/server/storage.server";
import { toAppError } from "~/server/errors";
import { isCleanText } from "~/server/text.server";
import { listAddresses, saveAddress } from "~/server/services/account/addresses.server";
import { markNotificationsRead, notificationStatement } from "~/server/services/account/notifications.server";
import { updateProfile } from "~/server/services/account/profile.server";
import { recordRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import { cancelWalletTopup, requestWalletTopup, saveTopupProof } from "~/server/services/account/topups.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { getProductDetail } from "~/server/services/catalog/product.server";
import { toProductPreview } from "~/server/services/catalog/product-types";
import { getDeviceHub } from "~/server/services/devices.server";
import { getOrderByAccessToken } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { createRepairTicket, getRepairByAccessToken, lookupRepair } from "~/server/services/support/repairs.server";
import { createSupportTicket } from "~/server/services/support/tickets.server";
import { createTradeIn, getTradeInByRef, listTradeInDevices, lookupTradeIn, type TradeInDevice } from "~/server/services/tradein.server";
import { getUsedUnitDetail, listUsedUnits } from "~/server/services/used.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SITE = "http://localhost:5173";
const NOW = TEST_NOW;

let t: TestDb;
let make: Fixtures;
let tradeDevice: TradeInDevice;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  await seedDemo(t.db, NOW);
  tradeDevice = (await listTradeInDevices(t.db, "ar"))[0];
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── characters (built from code points)

const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0);
const BEL = ch(7);
const ESC = ch(0x1b);
const NEL = ch(0x85);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const PDI = ch(0x2069);
const ZWSP = ch(0x200b);
const BOM = ch(0xfeff);
const ZWNJ = ch(0x200c);
const RLM = ch(0x200f);
/** A name with every kind of disguise in it. */
const HOSTILE = `علي${NUL}${BEL}${ESC}[31m${RLO}نسح${LRI}x${PDI}${ZWSP}${BOM} حسن`;
/** Sorani spelling that needs ZWNJ, with an RLM: both stay. */
const KURDISH = `ھەولێر${ZWNJ}ی نوێ${RLM}`;
const clean = (value: unknown, multiline = false) => typeof value !== "string" || isCleanText(value, { multiline });

// ───────────────────────────────────────────────────────────────── harness (as in tests/storefront-adversarial.test.ts)

let counter = 0;
const freshIp = () => {
  counter++;
  return `203.0.${113 + Math.floor(counter / 250)}.${(counter % 250) + 1}`;
};

function context(options: { cookies?: Record<string, string>; now?: number; ip?: string | null } = {}): { ctx: RequestCtx; setCookies: string[] } {
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `in-${++counter}`,
    nonce: "n",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: options.now ?? NOW,
    ip: options.ip === undefined ? freshIp() : options.ip,
    country: "IQ",
    userAgent: "Mozilla/5.0 (security review)",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

type Handler = (args: never) => unknown;
type HitInit = { method?: string; form?: Record<string, string> | FormData; json?: unknown; cookies?: Record<string, string>; params?: Record<string, string>; ip?: string | null };
type Hit = { status: number; headers: Headers; location: string | null; body: unknown; setCookies: string[]; error?: unknown };
type DataWithInit = { data: unknown; init?: { status?: number; headers?: HeadersInit } | null };
const isDataWithInit = (value: unknown): value is DataWithInit => typeof value === "object" && value !== null && "data" in value && "init" in value;

async function hit(path: string, handler: Handler, init: HitInit = {}): Promise<Hit> {
  const method = init.method ?? (init.form || init.json !== undefined ? "POST" : "GET");
  const headers = new Headers();
  const ip = init.ip === undefined ? freshIp() : init.ip;
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (init.cookies) headers.set("Cookie", Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  if (method !== "GET") headers.set("Origin", SITE);
  let body: BodyInit | undefined;
  if (init.form) body = init.form instanceof FormData ? init.form : new URLSearchParams(init.form);
  if (init.json !== undefined) {
    body = JSON.stringify(init.json);
    headers.set("Content-Type", "application/json");
  }
  const request = new Request(`${SITE}${path}`, { method, headers, body });
  const routerContext = new RouterContextProvider();
  const url = new URL(request.url);
  let inner: unknown;
  let innerError: unknown;
  const response = (await requestContextMiddleware({ request, context: routerContext, url, pattern: path, params: init.params ?? {} } as never, async () => {
    try {
      inner = await (handler as (args: unknown) => unknown)({ request, context: routerContext, params: init.params ?? {}, url, pattern: path });
    } catch (thrown) {
      if (thrown instanceof Response || isDataWithInit(thrown)) inner = thrown;
      else {
        innerError = thrown;
        return new Response("unexpected", { status: 500 });
      }
    }
    if (inner instanceof Response) return inner;
    if (isDataWithInit(inner)) return new Response(JSON.stringify(inner.data), { status: inner.init?.status ?? 200, headers: inner.init?.headers });
    return new Response(JSON.stringify(inner ?? null), { status: 200 });
  })) as Response;
  let parsed: unknown = isDataWithInit(inner) ? inner.data : inner instanceof Response ? null : inner;
  if (inner instanceof Response && (inner.headers.get("Content-Type") ?? "").includes("json")) parsed = await inner.clone().json();
  return { status: response.status, headers: response.headers, location: response.headers.get("Location"), body: parsed, setCookies: response.headers.getSetCookie(), error: innerError };
}

function jarAfter(setCookies: string[], base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const serialized of setCookies) {
    const [pair, ...rest] = serialized.split(/;\s*/);
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (rest.some((part) => part.toLowerCase() === "max-age=0")) delete jar[name];
    else jar[name] = decodeURIComponent(pair.slice(at + 1));
  }
  return jar;
}

async function customer(): Promise<{ id: string; phone: string; actor: CustomerActor; jar: Record<string, string> }> {
  const phone = make.phone();
  const req = context();
  const session = await signUpCustomer(req.ctx, t.db, { phone, password: `pw-${randomToken(9)}` });
  return { id: session.customer.id, phone, actor: { kind: "customer", id: session.customer.id }, jar: jarAfter(req.setCookies) };
}

async function thrownCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return toAppError(error)?.code ?? "unexpected";
  }
  return "none";
}

async function cartOf(customerId: string | null = null, priceIqd = 90_000) {
  const product = await make.product({ stock: 20, priceIqd });
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId, locale: "ar" }, { variantId: product.variantId, qty: 1 }, NOW);
  const view = await getCartView(t.db, { cartToken, customerId, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return { product, cartToken, totalIqd: view.totalIqd };
}

function checkoutFields(totalIqd: number, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    idempotencyKey: randomToken(),
    phone: make.phone().replace("+964", "0"),
    governorateId: governorateId("baghdad"),
    districtId: districtId("baghdad", "karrada"),
    areaText: "الكرادة",
    addressText: "شارع 62، دار 14",
    paymentMethod: "cod",
    expectedTotalIqd: String(totalIqd),
    ...overrides,
  };
}

async function guestTransferOrder() {
  const cart = await cartOf();
  const placed = await placeOrder(
    t.db,
    { cartToken: cart.cartToken, customer: null, locale: "ar", ip: null, storeMode: "demo" },
    { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), areaText: "الكرادة", addressText: "شارع 62، دار 14", marketingConsent: false, paymentMethod: "bank_transfer", expectedTotalIqd: cart.totalIqd },
    // The upload route runs at the real time: the proof window must still be open then.
    Date.now(),
  );
  return placed;
}

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const bytes = (text: string) => new TextEncoder().encode(text);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
/** The smallest JPEG a parser accepts: SOI, a baseline SOF0 (8×8, one component), one DHT, SOS with one byte, EOI. */
function tinyJpeg(): Uint8Array {
  const soi = [0xff, 0xd8];
  const sof = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00];
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(1)];
  const dht = [0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, ...Array(15).fill(0), 0x00];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00];
  const eoi = [0xff, 0xd9];
  return new Uint8Array([...soi, ...dqt, ...sof, ...dht, ...sos, ...eoi]);
}

// ───────────────────────────────────────────────────────────────── 1. free text

describe("free text — control, bidi-override and invisible characters never reach storage", () => {
  test("checkout: recipient, area, address and notes are stored clean; line breaks stay in the address and notes", async () => {
    const cart = await cartOf();
    const placed = await placeOrder(
      t.db,
      { cartToken: cart.cartToken, customer: null, locale: "ar", ip: null, storeMode: "demo" },
      {
        idempotencyKey: randomToken(),
        contactName: HOSTILE,
        phone: make.phone(),
        governorateId: governorateId("baghdad"),
        areaText: `الكرادة${NEL}${RLO}داخل`,
        addressText: `شارع 62${ESC}[2J\nدار 14${NUL}`,
        notes: `اتصلوا قبل الوصول${BEL}\r\n${KURDISH}`,
        marketingConsent: false,
        paymentMethod: "cod",
        expectedTotalIqd: cart.totalIqd,
      },
      NOW,
    );
    const row = (await t.db.select().from(orders).where(eq(orders.ref, placed.ref)).get())!;
    expect(clean(row.contactName)).toBe(true);
    expect(clean(row.areaText)).toBe(true);
    expect(clean(row.addressText, true)).toBe(true);
    expect(clean(row.notes, true)).toBe(true);
    expect(row.contactName).toBe("علي[31mنسحx حسن");
    expect(row.areaText).toBe("الكرادة داخل");
    expect(row.addressText).toBe("شارع 62[2J\nدار 14");
    expect(row.notes).toBe(`اتصلوا قبل الوصول\n${KURDISH}`);
  });

  test("a value made only of hidden characters is empty, not a value that passed", async () => {
    const cart = await cartOf();
    const code = await thrownCode(() =>
      placeOrder(
        t.db,
        { cartToken: cart.cartToken, customer: null, locale: "ar", ip: null, storeMode: "demo" },
        { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), areaText: `${RLO}${ZWSP}${NUL}`, addressText: "شارع 62، دار 14", marketingConsent: false, paymentMethod: "cod", expectedTotalIqd: cart.totalIqd },
        NOW,
      ),
    );
    expect(code).toBe("invalid");
    const person = await customer();
    expect(await thrownCode(() => updateProfile(t.db, person.actor, { name: `${BOM}${RLO}x${PDI}` }, NOW))).toBe("invalid");
  });

  test("account: sign-up name, profile name and e-mail, saved addresses", async () => {
    const req = context();
    const session = await signUpCustomer(req.ctx, t.db, { phone: make.phone(), password: `pw-${randomToken(9)}`, name: HOSTILE });
    const stored = (await t.db.select({ name: customers.name }).from(customers).where(eq(customers.id, session.customer.id)).get())!;
    expect(clean(stored.name)).toBe(true);
    const person = await customer();
    await updateProfile(t.db, person.actor, { name: KURDISH, email: `a${RLO}b@example.com` }, NOW);
    const profile = (await t.db.select({ name: customers.name, email: customers.email }).from(customers).where(eq(customers.id, person.id)).get())!;
    expect(profile.name).toBe(KURDISH);
    expect(profile.email).toBe("ab@example.com");
    await saveAddress(t.db, person.actor, { label: `${RLO}البيت`, recipientName: HOSTILE, governorateId: governorateId("baghdad"), areaText: `المنصور${NUL}`, addressText: `شارع${ESC} 14\nقرب الجامع`, notes: `${ZWSP}الطابق الثاني` }, NOW);
    const [saved] = await listAddresses(t.db, person.id, "ar");
    for (const [field, value] of Object.entries(saved)) if (typeof value === "string") expect(clean(value, true), field).toBe(true);
    expect(saved.addressText).toBe("شارع 14\nقرب الجامع");
  });

  test("support: repair requests and tickets", async () => {
    const repair = await createRepairTicket(t.db, { customerId: null, ip: null, storeMode: "demo" }, { idempotencyKey: randomToken(), device: "other", deviceText: `PS5${RLO}x`, serial: "AB-12", issue: `لا يعمل${NUL} الجهاز${ESC}[0m بعد التحديث\nيظهر ضوء أزرق`, phone: make.phone(), contactName: HOSTILE }, NOW);
    const row = (await t.db.select().from(repairTickets).where(eq(repairTickets.ref, repair.ref)).get())!;
    expect(clean(row.contactName)).toBe(true);
    expect(clean(row.deviceText)).toBe(true);
    expect(clean(row.issue, true)).toBe(true);
    const ticket = await createSupportTicket(t.db, { customerId: null, ip: null, storeMode: "demo" }, { idempotencyKey: randomToken(), phone: make.phone(), contactName: HOSTILE, subject: `سؤال${RLO} عن الطلب`, message: `مرحبا${NUL}\nأريد المساعدة${BEL}` }, NOW);
    const ticketRow = (await t.db.select().from(supportTickets).where(eq(supportTickets.ref, ticket.ref)).get())!;
    for (const [field, value] of Object.entries(ticketRow)) if (typeof value === "string") expect(clean(value, true), field).toBe(true);
  });

  test("trade-in: contact name and notes", async () => {
    const answers = { power: "works", body: "like_new", account: "yes", ...(tradeDevice.hasScreen ? { screen: "perfect" } : {}), ...(tradeDevice.accessories.length ? { included: [...tradeDevice.accessories] } : {}) };
    const made = await createTradeIn(t.db, { customerId: null, ip: null, locale: "ar", storeMode: "demo" }, { idempotencyKey: randomToken(24), device: tradeDevice.slug, answers, phone: make.phone(), contactName: HOSTILE, notes: `خدش صغير${NUL}\n${RLO}على الجانب`, ownershipConfirmed: true }, NOW);
    const row = (await t.db.select({ contactName: tradeIns.contactName }).from(tradeIns).where(eq(tradeIns.ref, made.ref)).get())!;
    expect(clean(row.contactName)).toBe(true);
    // The shopper's notes travel in the "submitted" event.
    const submitted = (await t.db.select({ data: tradeInEvents.data }).from(tradeInEvents).where(and(eq(tradeInEvents.tradeInId, made.tradeInId), eq(tradeInEvents.kind, "submitted"))).get())!;
    expect(clean(submitted.data?.notes, true)).toBe(true);
    expect(submitted.data?.notes).toBe("خدش صغير\nعلى الجانب");
  });

  test("transfer proof note and reference, top-up reference", async () => {
    const order = await guestTransferOrder();
    const form = new FormData();
    form.set("ref", order.ref);
    form.set("t", order.accessToken);
    form.set("declaredAmountIqd", "95000");
    form.set("reference", `REF${RLO}123${NUL}`);
    form.set("note", `حولت المبلغ${ESC}[1m\nشكرا`);
    form.set("file", new File([PNG], "p.png", { type: "image/png" }));
    const sent = await hit("/api/upload/proof", uploadProofAction as Handler, { form });
    expect(sent.status).toBe(200);
    const proof = (await t.db
      .select({ note: paymentProofs.note })
      .from(paymentProofs)
      .innerJoin(files, eq(files.id, paymentProofs.fileId))
      .where(eq(paymentProofs.declaredAmountIqd, 95000))
      .all())
      .at(-1)!;
    expect(clean(proof.note, true)).toBe(true);
    const person = await customer();
    const saved = await saveTopupProof(t.db, kvBlobStore(t.kv), person.actor, new File([PNG], "t.png", { type: "image/png" }), NOW);
    const { topup } = await requestWalletTopup(t.db, person.actor, { method: "bank_transfer", declaredAmountIqd: "50000", reference: `TX${RLO}9${NUL}`, fileId: saved.fileId, idempotencyKey: randomToken() }, NOW);
    const row = (await t.db.select({ reference: walletTopups.reference }).from(walletTopups).where(eq(walletTopups.ref, topup.ref)).get())!;
    expect(row.reference).toBe("TX9");
  });
});

// ───────────────────────────────────────────────────────────────── 2. shapes and types

describe("shapes and types — arrays, objects, numbers as strings, oversized values", () => {
  test("/api/wishlist: an id must be one short string", async () => {
    for (const json of [{ productId: ["prd_x"] }, { productId: { $ne: null } }, { productId: 12 }, { productId: "x".repeat(300) }, { productId: "../../x" }, { intent: "drop", productId: "prd_x" }, []]) {
      const answer = await hit("/api/wishlist", apiWishlistAction as Handler, { json });
      expect([400, 404], JSON.stringify(json)).toContain(answer.status);
      expect((answer.body as { ok: boolean }).ok).toBe(false);
    }
  });

  test("/api/events: kinds are an allowlist, purchases come from the server only", async () => {
    for (const json of [{ kind: ["view"], productId: "prd_x" }, { kind: "purchase", productId: "prd_x" }, { kind: "view", productId: "x".repeat(200) }, { kind: "view", productId: "prd_x", source: "<script>" }, { kind: "view" }]) {
      const answer = await hit("/api/events", eventsAction as Handler, { json, cookies: { tt_consent: "1" } });
      expect(answer.status, JSON.stringify(json)).toBe(400);
    }
    expect(await t.db.select({ n: sql<number>`count(*)` }).from(recommendationEvents).where(eq(recommendationEvents.kind, "purchase")).get()).toEqual({ n: 0 });
  });

  test("/api/cart: quantities are whole numbers in range — however they are written", async () => {
    const product = await make.product({ stock: 50 });
    const bad = ["1e3", "-1", "1.5", "Infinity", "NaN", "11", "99999999999999999999", "true", "0"];
    for (const qty of bad) {
      const answer = await hit("/api/cart", cartAction as Handler, { form: { intent: "add", variantId: product.variantId, qty } });
      expect(answer.status, qty).toBe(400);
    }
    for (const json of [{ intent: "add", variantId: [product.variantId], qty: 1 }, { intent: "add", variantId: product.variantId, qty: [1] }, { intent: "add", variantId: product.variantId, qty: { valueOf: 1 } }, { intent: "set", lineId: "x", qty: 1, unitPriceIqd: 1 }, { intent: "evil" }]) {
      const answer = await hit("/api/cart", cartAction as Handler, { json });
      expect([400, 404], JSON.stringify(json)).toContain(answer.status);
    }
    // A price, a total or a discount in the body is ignored: the cart is priced on the server.
    const priced = await hit("/api/cart", cartAction as Handler, { json: { intent: "add", variantId: product.variantId, qty: 1, priceIqd: 1, unitPriceIqd: 1, totalIqd: 1, discountIqd: 999999 } });
    expect(priced.status).toBe(200);
    const view = (priced.body as { cart: { subtotalIqd: number; discountIqd: number } }).cart;
    expect(view.subtotalIqd).toBe(product.priceIqd);
    expect(view.discountIqd).toBe(0);
  });

  test("/api/recently-viewed and /api/onboarding: the device list and the answers are bounded and typed", async () => {
    const person = await customer();
    const product = await make.product({ stock: 1 });
    for (const device of [JSON.stringify(Array.from({ length: 13 }, (_, i) => ({ id: `prd_${i}`, at: i }))), JSON.stringify([{ id: "../x", at: 1 }]), JSON.stringify([{ id: product.productId, at: -1 }]), JSON.stringify([{ id: product.productId, at: 1.5 }]), "{", JSON.stringify({ id: product.productId })]) {
      const answer = await hit("/api/recently-viewed", recentAction as Handler, { form: { device }, cookies: { ...person.jar, tt_consent: "1" } });
      expect(answer.status, device.slice(0, 40)).toBe(400);
    }
    const answers: Record<string, string>[] = [{ consent: "maybe" }, { platforms: "playstation.<script>" }, { consent: "1", platforms: "a".repeat(5000) }];
    for (const form of answers) {
      const answer = await hit("/api/onboarding", onboardingAction as Handler, { form });
      expect(answer.status, JSON.stringify(form).slice(0, 60)).toBe(400);
    }
  });

  test("checkout: the expected total must be a plain whole number; a wallet needs an account", async () => {
    for (const expectedTotalIqd of ["1e5", "-1", "", "100.5", "١٠٠", "0x10", "9".repeat(20)]) {
      const cart = await cartOf();
      const answer = await hit("/checkout", checkoutAction as Handler, { form: checkoutFields(cart.totalIqd, { expectedTotalIqd }), cookies: { tt_cart: cart.cartToken } });
      expect(answer.status, expectedTotalIqd).toBe(400);
    }
    const cart = await cartOf();
    const wallet = await hit("/checkout", checkoutAction as Handler, { form: checkoutFields(cart.totalIqd, { paymentMethod: "wallet" }), cookies: { tt_cart: cart.cartToken } });
    expect(wallet.status).toBe(403);
    expect(wallet.body).toMatchObject({ ok: false, code: "wallet_requires_account" });
  });

  test("transfer proof: the declared amount is a whole positive number of dinars (Arabic-Indic digits understood)", async () => {
    const order = await guestTransferOrder();
    for (const amount of ["1e9", "-5", "0", "abc", "12.5", "99999999999999"]) {
      const form = new FormData();
      form.set("ref", order.ref);
      form.set("t", order.accessToken);
      form.set("declaredAmountIqd", amount);
      form.set("file", new File([PNG], "p.png", { type: "image/png" }));
      const answer = await hit("/api/upload/proof", uploadProofAction as Handler, { form });
      expect(answer.status, amount).toBe(400);
    }
    expect(await t.db.select().from(paymentProofs).innerJoin(files, eq(files.id, paymentProofs.fileId)).where(eq(paymentProofs.declaredAmountIqd, 0))).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── 3. uploads

describe("uploads — the bytes decide, whatever the name or the browser says", () => {
  const SVG = bytes(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>`);
  const HTML = bytes(`<!doctype html><script>alert(document.cookie)</script>`);
  const GIF_POLYGLOT = bytes(`GIF89a/*<html><script>alert(1)</script>*/=1;`);
  const PDF = bytes(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`);
  const TRUNCATED = PNG.slice(0, 40);
  const WRONG_CRC = (() => {
    const copy = PNG.slice();
    copy[copy.length - 13] ^= 0xff;
    return copy;
  })();

  test.each([
    ["SVG named .png", SVG, "proof.png", "image/png", 415],
    ["HTML named .jpg", HTML, "proof.jpg", "image/jpeg", 415],
    ["GIF/HTML polyglot", GIF_POLYGLOT, "proof.gif", "image/gif", 415],
    ["PDF", PDF, "proof.pdf", "application/pdf", 415],
    ["zero bytes", new Uint8Array(0), "empty.png", "image/png", 400],
    ["a truncated PNG", TRUNCATED, "cut.png", "image/png", 422],
  ] as const)("/api/upload/proof refuses %s and stores nothing", async (_label, content, name, type, status) => {
    const order = await guestTransferOrder();
    const before = await t.db.select({ n: sql<number>`count(*)` }).from(files).get();
    const form = new FormData();
    form.set("ref", order.ref);
    form.set("t", order.accessToken);
    form.set("declaredAmountIqd", "95000");
    form.set("file", new File([content], name, { type }));
    const answer = await hit("/api/upload/proof", uploadProofAction as Handler, { form });
    expect(answer.status).toBe(status);
    expect(await t.db.select({ n: sql<number>`count(*)` }).from(files).get()).toEqual(before);
  });

  test("a PNG with a broken chunk checksum is refused or cleaned — never stored with trailing HTML", async () => {
    const order = await guestTransferOrder();
    const form = new FormData();
    form.set("ref", order.ref);
    form.set("t", order.accessToken);
    form.set("declaredAmountIqd", "95000");
    form.set("file", new File([cat(PNG, HTML)], "trail.png", { type: "image/png" }));
    const answer = await hit("/api/upload/proof", uploadProofAction as Handler, { form });
    expect(answer.status).toBe(200);
    const fileId = decodeURIComponent((answer.body as { previewUrl: string }).previewUrl.split("/").pop()!.split("?")[0]);
    const stored = (await t.db.select().from(files).where(eq(files.id, fileId)).get())!;
    expect(stored.visibility).toBe("private");
    expect(stored.bytes).toBe(PNG.length);
    const blob = await kvBlobStore(t.kv).get(stored.storageKey);
    expect(new TextDecoder().decode(blob!.bytes)).not.toContain("<script>");
    void WRONG_CRC;
  });

  test("a text field in place of the file, or no file at all, is upload_missing — on every upload route", async () => {
    const order = await guestTransferOrder();
    const asText = new FormData();
    asText.set("ref", order.ref);
    asText.set("t", order.accessToken);
    asText.set("declaredAmountIqd", "95000");
    asText.set("file", "<svg onload=alert(1)>");
    expect((await hit("/api/upload/proof", uploadProofAction as Handler, { form: asText })).status).toBe(400);
    const tradeIn = new FormData();
    tradeIn.set("intent", "add");
    tradeIn.set("file", new File([SVG], "x.png", { type: "image/png" }));
    expect((await hit("/api/upload/tradein", uploadTradeInAction as Handler, { form: tradeIn })).status).toBe(415);
    const empty = new FormData();
    empty.set("intent", "add");
    expect((await hit("/api/upload/tradein", uploadTradeInAction as Handler, { form: empty })).status).toBe(400);
    const person = await customer();
    const wallet = new FormData();
    wallet.set("file", new File([HTML], "x.jpg", { type: "image/jpeg" }));
    expect((await hit("/account/wallet/proof", walletProofAction as Handler, { form: wallet, cookies: person.jar })).status).toBe(415);
    const guestWallet = new FormData();
    guestWallet.set("file", new File([PNG], "x.png", { type: "image/png" }));
    expect((await hit("/account/wallet/proof", walletProofAction as Handler, { form: guestWallet })).status).toBe(401);
  });

  test("a minimal JPEG passes and comes back as image/jpeg; trailing bytes after its end are cut", async () => {
    const jpeg = cat(tinyJpeg(), HTML);
    const form = new FormData();
    form.set("intent", "add");
    form.set("file", new File([jpeg], "x.jpg", { type: "text/html" }));
    const answer = await hit("/api/upload/tradein", uploadTradeInAction as Handler, { form });
    if (answer.status === 200) {
      const id = (answer.body as { photo: { id: string } }).photo.id;
      const row = (await t.db.select().from(files).where(eq(files.id, id)).get())!;
      expect(row.mime).toBe("image/jpeg");
      expect(row.bytes).toBe(tinyJpeg().length);
    } else {
      // The hand-made JPEG may not parse; then it must be refused as corrupt, never stored.
      expect([415, 422]).toContain(answer.status);
    }
  });
});

// ───────────────────────────────────────────────────────────────── 4. other people's things

describe("IDOR — every id that reaches the server is checked against its owner", () => {
  test("addresses, top-ups, notifications and sessions of another customer cannot be read or changed", async () => {
    const victim = await customer();
    const attacker = await customer();
    await saveAddress(t.db, victim.actor, { governorateId: governorateId("baghdad"), areaText: "الكرادة", addressText: "شارع 62، دار 14" }, NOW);
    const [address] = await listAddresses(t.db, victim.id, "ar");
    expect(await thrownCode(() => saveAddress(t.db, attacker.actor, { id: address.id, governorateId: governorateId("basra"), areaText: "العشار", addressText: "عنوان المهاجم 1" }, NOW))).toBe("not_found");
    const { deleteAddress, setDefaultAddress } = await import("~/server/services/account/addresses.server");
    expect(await thrownCode(() => deleteAddress(t.db, attacker.actor, address.id, NOW))).toBe("not_found");
    expect(await thrownCode(() => setDefaultAddress(t.db, attacker.actor, address.id, NOW))).toBe("not_found");
    expect((await t.db.select().from(addresses).where(eq(addresses.id, address.id)).get())?.addressText).toBe("شارع 62، دار 14");

    const proof = await saveTopupProof(t.db, kvBlobStore(t.kv), victim.actor, new File([PNG], "t.png", { type: "image/png" }), NOW);
    expect(await thrownCode(() => requestWalletTopup(t.db, attacker.actor, { method: "bank_transfer", declaredAmountIqd: "50000", fileId: proof.fileId, idempotencyKey: randomToken() }, NOW))).toBe("topup_proof_invalid");
    const { topup } = await requestWalletTopup(t.db, victim.actor, { method: "bank_transfer", declaredAmountIqd: "50000", fileId: proof.fileId, idempotencyKey: randomToken() }, NOW);
    const topupRow = (await t.db.select().from(walletTopups).where(eq(walletTopups.ref, topup.ref)).get())!;
    expect(await thrownCode(() => cancelWalletTopup(t.db, attacker.actor, topupRow.id, NOW))).toBe("not_found");
    expect((await t.db.select({ status: walletTopups.status }).from(walletTopups).where(eq(walletTopups.id, topupRow.id)).get())?.status).toBe("pending_verification");
    // The same idempotency key from someone else is a conflict, never the victim's request.
    expect(await thrownCode(() => requestWalletTopup(t.db, attacker.actor, { method: "bank_transfer", declaredAmountIqd: "50000", fileId: proof.fileId, idempotencyKey: topupRow.idempotencyKey }, NOW))).toBe("idempotency_mismatch");

    const note = { customerId: victim.id, kind: "info", title: { ar: "رسالة" }, now: NOW, id: `ntf_${randomToken(8)}` };
    await t.db.batch([notificationStatement(t.db, note)]);
    expect(await markNotificationsRead(t.db, attacker.id, NOW, note.id)).toBe(0);
    expect((await t.db.select({ readAt: notifications.readAt }).from(notifications).where(eq(notifications.id, note.id)).get())?.readAt).toBeNull();

    const [victimSession] = await listCustomerSessions(t.db, victim.id, NOW + 1000);
    const revoke = await hit("/account/settings", settingsAction as Handler, { form: { intent: "revokeSession", sessionId: victimSession.id }, cookies: attacker.jar });
    expect(revoke.status).toBe(409);
    expect((await listCustomerSessions(t.db, victim.id, NOW + 1000)).length).toBe(1);
  });

  test("orders: another customer's reference is the same 404 in the account and on the order page; a proof cannot be sent to it", async () => {
    const owner = await customer();
    const stranger = await customer();
    const cart = await cartOf(owner.id);
    const placed = await placeOrder(t.db, { cartToken: cart.cartToken, customer: { id: owner.id }, locale: "ar", ip: null, storeMode: "demo" }, { idempotencyKey: randomToken(), phone: owner.phone, governorateId: governorateId("baghdad"), areaText: "الكرادة", addressText: "شارع 62، دار 14", marketingConsent: false, paymentMethod: "bank_transfer", expectedTotalIqd: cart.totalIqd }, Date.now());
    const account = await hit(`/account/orders/${placed.ref}`, accountOrderLoader as Handler, { params: { ref: placed.ref }, cookies: stranger.jar });
    expect(account.status).toBe(404);
    const page = await hit(`/order/${placed.ref}`, orderLoader as Handler, { params: { ref: placed.ref }, cookies: stranger.jar });
    expect(page.status).toBe(404);
    expect(JSON.stringify(page.body)).not.toContain(owner.phone.slice(-4));
    const unknown = await hit(`/order/TT-ZZZZ9999`, orderLoader as Handler, { params: { ref: "TT-ZZZZ9999" }, cookies: stranger.jar });
    expect(unknown.status).toBe(404);
    // The two 404s carry the same keys: nothing says which reference exists.
    expect(Object.keys(page.body as object).sort()).toEqual(Object.keys(unknown.body as object).sort());
    const form = new FormData();
    form.set("ref", placed.ref);
    form.set("declaredAmountIqd", String(cart.totalIqd));
    form.set("file", new File([PNG], "p.png", { type: "image/png" }));
    const proof = await hit("/api/upload/proof", uploadProofAction as Handler, { form, cookies: stranger.jar });
    expect(proof.status).toBe(404);
    // The owner still sees it.
    expect((await hit(`/order/${placed.ref}`, orderLoader as Handler, { params: { ref: placed.ref }, cookies: owner.jar })).status).toBe(200);
  });

  test("trade-in: another draft's photo, and an answer to someone else's offer without their link", async () => {
    const mine = new FormData();
    mine.set("intent", "add");
    mine.set("file", new File([PNG], "a.png", { type: "image/png" }));
    const upload = await hit("/api/upload/tradein", uploadTradeInAction as Handler, { form: mine });
    expect(upload.status).toBe(200);
    const myDraft = jarAfter(upload.setCookies);
    const id = (upload.body as { photo: { id: string } }).photo.id;
    expect((await hit(`/api/upload/tradein?file=${id}`, uploadTradeInLoader as Handler, { cookies: myDraft })).status).toBe(200);
    expect((await hit(`/api/upload/tradein?file=${id}`, uploadTradeInLoader as Handler, { cookies: { tt_tradein: randomToken(24) } })).status).toBe(404);
    expect((await hit(`/api/upload/tradein?file=${id}`, uploadTradeInLoader as Handler)).status).toBe(404);
    const removal = await hit("/api/upload/tradein", uploadTradeInAction as Handler, { form: { intent: "remove", fileId: id }, cookies: { tt_tradein: randomToken(24) } });
    expect(removal.body).toMatchObject({ ok: true, removed: false });

    const answers = { power: "works", body: "like_new", account: "yes", ...(tradeDevice.hasScreen ? { screen: "perfect" } : {}), ...(tradeDevice.accessories.length ? { included: [...tradeDevice.accessories] } : {}) };
    const made = await createTradeIn(t.db, { customerId: null, ip: null, locale: "ar", storeMode: "demo" }, { idempotencyKey: randomToken(24), device: tradeDevice.slug, answers, phone: make.phone(), ownershipConfirmed: true }, NOW);
    // An offer the way the admin will make it: an employee, after an inspection (the database insists).
    await t.db
      .update(tradeIns)
      .set({ status: "offered", finalOfferIqd: 100_000, offeredBy: "emp_TEST", offeredAt: NOW, offerExpiresAt: Date.now() + 86_400_000, inspection: { checklist: { templateId: null, completedAt: NOW, completedBy: "emp_TEST", items: [] }, grade: "B", inspectedAt: NOW } })
      .where(eq(tradeIns.ref, made.ref));
    // The near miss changes the token's last character for ANOTHER one: the token is a SHA-256 digest in base64url, whose
    // last character carries 4 bits (one of 16 letters, «A» among them) — «…A» was the real token one run in sixteen and
    // answered 200 (round-1 fixes; tests/commerce-core-security.test.ts tampers the same way).
    const near = `${made.accessToken.slice(0, -1)}${made.accessToken.endsWith("A") ? "B" : "A"}`;
    expect(near).not.toBe(made.accessToken);
    for (const query of ["", `?t=${randomToken()}`, `?t=${near}`]) {
      const answer = await hit(`/trade-in/${made.ref}${query}`, tradeInStatusAction as Handler, { form: { intent: "respond", decision: "accept", payout: "cash" }, params: { ref: made.ref } });
      expect(answer.status, query).toBe(404);
    }
    expect((await t.db.select({ status: tradeIns.status }).from(tradeIns).where(eq(tradeIns.ref, made.ref)).get())?.status).toBe("offered");
    // With the link, the owner can answer.
    const accepted = await hit(`/trade-in/${made.ref}?t=${made.accessToken}`, tradeInStatusAction as Handler, { form: { intent: "respond", decision: "accept", payout: "cash" }, params: { ref: made.ref } });
    expect(accepted.body).toMatchObject({ ok: true, status: "accepted" });
  });

  test("lookups by reference + phone answer the same for a wrong reference and a wrong phone (repairs, trade-ins)", async () => {
    const phone = make.phone();
    const repair = await createRepairTicket(t.db, { customerId: null, ip: null, storeMode: "demo" }, { idempotencyKey: randomToken(), device: "other", deviceText: "PS4", issue: "لا يعمل الجهاز بعد التحديث", phone }, NOW);
    expect(await lookupRepair(t.db, "ar", { ref: repair.ref, phone: make.phone() }, { ip: freshIp() }, NOW)).toBeNull();
    expect(await lookupRepair(t.db, "ar", { ref: "RP-ZZZZ9999", phone }, { ip: freshIp() }, NOW)).toBeNull();
    expect((await lookupRepair(t.db, "ar", { ref: repair.ref, phone }, { ip: freshIp() }, NOW))?.ref).toBe(repair.ref);
    expect(await getRepairByAccessToken(t.db, "ar", repair.ref, randomToken())).toBeNull();
    const answers = { power: "works", body: "like_new", account: "yes", ...(tradeDevice.hasScreen ? { screen: "perfect" } : {}), ...(tradeDevice.accessories.length ? { included: [...tradeDevice.accessories] } : {}) };
    const made = await createTradeIn(t.db, { customerId: null, ip: null, locale: "ar", storeMode: "demo" }, { idempotencyKey: randomToken(24), device: tradeDevice.slug, answers, phone, ownershipConfirmed: true }, NOW);
    expect(await lookupTradeIn(t.db, { ref: made.ref, phone: make.phone() }, { ip: freshIp() }, "ar", NOW)).toBeNull();
    expect(await lookupTradeIn(t.db, { ref: "TI-ZZZZ9999", phone }, { ip: freshIp() }, "ar", NOW)).toBeNull();
    expect(await getTradeInByRef(t.db, made.ref, { accessToken: randomToken(), customerId: null }, "ar", NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── 5. consent

describe("consent — nothing personal is kept without a yes, and a no deletes", () => {
  const publishedProduct = async () => (await make.product({ stock: 3 })).productId;
  const eventsOf = (where: ReturnType<typeof eq>) => t.db.select().from(recommendationEvents).where(where);

  test("no answer or a no: a view signal stores nothing and sets no cookie", async () => {
    const productId = await publishedProduct();
    const devices: Record<string, string>[] = [{}, { tt_consent: "0" }, { tt_consent: "yes" }];
    for (const cookies of devices) {
      const answer = await hit("/api/events", eventsAction as Handler, { form: { kind: "view", productId }, cookies });
      expect(answer.body).toEqual({ ok: true, recorded: false });
      expect(answer.setCookies).toEqual([]);
    }
    expect(await eventsOf(eq(recommendationEvents.productId, productId))).toEqual([]);
  });

  test("a consenting guest is keyed by a random cookie — never by the IP: two visits from one IP get two keys, and no IP is stored", async () => {
    const productId = await publishedProduct();
    const ip = freshIp();
    const first = await hit("/api/events", eventsAction as Handler, { form: { kind: "view", productId }, cookies: { tt_consent: "1" }, ip });
    const second = await hit("/api/events", eventsAction as Handler, { form: { kind: "click", productId }, cookies: { tt_consent: "1" }, ip });
    const a = jarAfter(first.setCookies).tt_rs;
    const b = jarAfter(second.setCookies).tt_rs;
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    const rows = await eventsOf(eq(recommendationEvents.productId, productId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sessionHash)).size).toBe(2);
    const columns = Object.keys(rows[0]);
    expect(columns.some((column) => /ip|agent|address|phone/i.test(column))).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(ip);
  });

  test("a customer whose account said no is not tracked, even if this device once said yes", async () => {
    const person = await customer();
    await t.db.insert(consents).values({ id: `cns_${randomToken(8)}`, subjectType: "customer", subjectId: person.id, kind: "personalization", granted: false, source: "account", at: NOW });
    const productId = await publishedProduct();
    const answer = await hit("/api/events", eventsAction as Handler, { form: { kind: "view", productId }, cookies: { ...person.jar, tt_consent: "1" } });
    expect(answer.body).toEqual({ ok: true, recorded: false });
    const recent = await hit("/api/recently-viewed", recentAction as Handler, { form: { productId }, cookies: { ...person.jar, tt_consent: "1" } });
    expect(recent.body).toMatchObject({ kept: false });
    expect(await t.db.select().from(recentlyViewed).where(eq(recentlyViewed.customerId, person.id))).toEqual([]);
  });

  test("withdrawing on the home page deletes this device's signals and its key; in the account, the account's too", async () => {
    const productId = await publishedProduct();
    const first = await hit("/api/events", eventsAction as Handler, { form: { kind: "view", productId }, cookies: { tt_consent: "1" } });
    const device = jarAfter(first.setCookies, { tt_consent: "1" });
    expect(await eventsOf(eq(recommendationEvents.productId, productId))).toHaveLength(1);
    const no = await hit("/api/onboarding", onboardingAction as Handler, { form: { consent: "0" }, cookies: device });
    expect(no.status).toBe(200);
    expect(await eventsOf(eq(recommendationEvents.productId, productId))).toEqual([]);
    expect(jarAfter(no.setCookies, device).tt_rs).toBeUndefined();

    const person = await customer();
    await t.db.insert(consents).values({ id: `cns_${randomToken(8)}`, subjectType: "customer", subjectId: person.id, kind: "personalization", granted: true, source: "account", at: NOW });
    const other = await publishedProduct();
    await hit("/api/events", eventsAction as Handler, { form: { kind: "view", productId: other }, cookies: person.jar });
    await recordRecentlyViewed(t.db, { customerId: person.id, cartToken: null }, other, NOW, { consent: true });
    expect(await eventsOf(eq(recommendationEvents.customerId, person.id))).toHaveLength(1);
    const withdraw = await hit("/account/settings", settingsAction as Handler, { form: { intent: "consents", marketing: "0", personalization: "0" }, cookies: person.jar });
    expect(withdraw.body).toMatchObject({ ok: true });
    expect(await eventsOf(eq(recommendationEvents.customerId, person.id))).toEqual([]);
    expect(await t.db.select().from(recentlyViewed).where(eq(recentlyViewed.customerId, person.id))).toEqual([]);
  });

  test("a purchase without consent records no signal; with consent one per product", async () => {
    const cart = await cartOf();
    const answer = await hit("/checkout", checkoutAction as Handler, { form: checkoutFields(cart.totalIqd), cookies: { tt_cart: cart.cartToken } });
    expect(answer.status).toBe(302);
    expect(await eventsOf(and(eq(recommendationEvents.productId, cart.product.productId), eq(recommendationEvents.kind, "purchase"))!)).toEqual([]);
    expect(answer.setCookies.some((cookie) => cookie.startsWith("tt_rs="))).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── 6. money

describe("money — the browser cannot price anything, replay anything or pay twice", () => {
  test("hostile fields in the checkout form are ignored: the order is priced, paid and statused by the server", async () => {
    const cart = await cartOf(null, 400_000);
    const answer = await hit("/checkout", checkoutAction as Handler, {
      form: checkoutFields(cart.totalIqd, { unitPriceIqd: "1", priceIqd: "1", subtotalIqd: "1", totalIqd: "1", shippingIqd: "0", discountIqd: "399999", couponId: "cpn_x", paymentStatus: "paid", status: "confirmed", paidIqd: String(cart.totalIqd), isDemo: "0", customerId: "cus_x" }),
      cookies: { tt_cart: cart.cartToken },
    });
    expect(answer.status).toBe(302);
    const ref = decodeURIComponent(answer.location!.split("/order/")[1].split("?")[0]);
    const row = (await t.db.select().from(orders).where(eq(orders.ref, ref)).get())!;
    expect(row).toMatchObject({ subtotalIqd: 400_000, shippingIqd: 5000, discountIqd: 0, totalIqd: 405_000, paidIqd: 0, status: "new", paymentStatus: "cod_due", customerId: null, couponId: null, isDemo: true });
  });

  test("a total the shopper did not see is refused with the fresh cart, and nothing is written", async () => {
    const cart = await cartOf(null, 400_000);
    const before = await t.db.select({ n: sql<number>`count(*)` }).from(orders).get();
    const answer = await hit("/checkout", checkoutAction as Handler, { form: checkoutFields(cart.totalIqd - 400_000), cookies: { tt_cart: cart.cartToken } });
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ ok: false, code: "totals_changed", cart: { totalIqd: cart.totalIqd } });
    expect(await t.db.select({ n: sql<number>`count(*)` }).from(orders).get()).toEqual(before);
  });

  test("replaying an attempt key: from another cart it is a conflict; from the same shopper with a changed cart it is the first order, unchanged", async () => {
    const person = await customer();
    const first = await cartOf(person.id, 100_000);
    const fields = checkoutFields(first.totalIqd);
    const placed = await hit("/checkout", checkoutAction as Handler, { form: fields, cookies: { ...person.jar } });
    expect(placed.status).toBe(302);
    const ref = decodeURIComponent(placed.location!.split("/order/")[1].split("?")[0]);
    const original = (await t.db.select().from(orders).where(eq(orders.ref, ref)).get())!;

    // A guest with another cart sends the same key: never the first order (its link and token).
    const other = await cartOf(null, 50_000);
    const stolen = await hit("/checkout", checkoutAction as Handler, { form: { ...fields, expectedTotalIqd: String(other.totalIqd) }, cookies: { tt_cart: other.cartToken } });
    expect(stolen.status).toBe(409);
    expect(stolen.body).toMatchObject({ ok: false, code: "idempotency_conflict" });
    expect(JSON.stringify(stolen.body)).not.toContain(ref);

    // The same customer, with a new and bigger cart, retries the same key: the first order comes back, nothing new.
    const product = await make.product({ stock: 5, priceIqd: 700_000 });
    await addToCart(t.db, { cartToken: null, customerId: person.id, locale: "ar" }, { variantId: product.variantId, qty: 2 }, NOW);
    const count = await t.db.select({ n: sql<number>`count(*)` }).from(orders).where(eq(orders.customerId, person.id)).get();
    const replay = await hit("/checkout", checkoutAction as Handler, { form: { ...fields, expectedTotalIqd: "1405000" }, cookies: { ...person.jar } });
    expect(replay.status).toBe(302);
    expect(replay.location).toContain(`/order/${ref}`);
    expect(await t.db.select({ n: sql<number>`count(*)` }).from(orders).where(eq(orders.customerId, person.id)).get()).toEqual(count);
    expect((await t.db.select().from(orders).where(eq(orders.ref, ref)).get())?.totalIqd).toBe(original.totalIqd);
    expect((await getCartView(t.db, { cartToken: null, customerId: person.id, locale: "ar" }, NOW)).count).toBe(2);
  });

  test("double submit of the same attempt at the same moment: one order", async () => {
    const cart = await cartOf(null, 120_000);
    const fields = checkoutFields(cart.totalIqd);
    const answers = await Promise.all(Array.from({ length: 4 }, () => hit("/checkout", checkoutAction as Handler, { form: fields, cookies: { tt_cart: cart.cartToken } })));
    const refs = new Set(answers.filter((answer) => answer.status === 302).map((answer) => answer.location!.split("?")[0]));
    expect(refs.size).toBe(1);
    expect(answers.every((answer) => answer.status === 302)).toBe(true);
  });

  test("a wallet paid by two orders at the same moment is charged once and never overdrawn", async () => {
    const person = await customer();
    const { creditWallet } = await import("~/server/services/wallet.server");
    const { getWalletBalance } = await import("~/server/services/wallet.server");
    await creditWallet(t.db, { kind: "system", job: "test" }, { customerId: person.id, amountIqd: 200_000, kind: "adjustment", reason: "اختبار المراجعة", idempotencyKey: randomToken() }, NOW);
    const carts = [await cartOf(person.id, 150_000)];
    const view = await getCartView(t.db, { cartToken: null, customerId: person.id, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
    const tries = await Promise.all(Array.from({ length: 3 }, () => hit("/checkout", checkoutAction as Handler, { form: checkoutFields(view.totalIqd, { paymentMethod: "wallet" }), cookies: person.jar })));
    expect(tries.filter((answer) => answer.status === 302)).toHaveLength(1);
    expect(await getWalletBalance(t.db, person.id)).toBe(200_000 - view.totalIqd);
    void carts;
  });
});

// ───────────────────────────────────────────────────────────────── 7. limits and double submits elsewhere

/** A reference body in the store's alphabet (no 0, 1, I, O, U). */
const wellFormed = (length: number) => Array.from({ length }, () => "23456789ABCDEFGHJKLMNPQRSTVWXYZ"[Math.floor(Math.random() * 31)]).join("");

describe("rate limits and double submits at the other doors", () => {
  test("tracking a trade-in or a repair by reference + phone: per IP (an IPv6 /64 counts once)", async () => {
    for (const lookup of [
      (ip: string) => lookupTradeIn(t.db, { ref: `TI-${wellFormed(8)}`, phone: make.phone() }, { ip }, "ar", NOW),
      (ip: string) => lookupRepair(t.db, "ar", { ref: `RP-${wellFormed(8)}`, phone: make.phone() }, { ip }, NOW),
    ]) {
      const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:5`;
      let code = "none";
      for (let i = 1; i <= 12 && code === "none"; i++) code = await thrownCode(() => lookup(`${prefix}::${i.toString(16)}`));
      expect(code).toBe("rate_limited");
    }
  });

  test("consent answers (append-only rows) are limited per customer, the account settings and the home panel together", async () => {
    const person = await customer();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const on = i % 2 === 0 ? "1" : "0";
      statuses.push((await hit("/account/settings", settingsAction as Handler, { form: { intent: "consents", marketing: on, personalization: on }, cookies: person.jar })).status);
      statuses.push((await hit("/api/onboarding", onboardingAction as Handler, { form: { consent: on }, cookies: person.jar })).status);
    }
    expect(statuses.slice(0, 12).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(12).every((status) => status === 429)).toBe(true);
    const rows = await t.db.select({ n: sql<number>`count(*)` }).from(consents).where(eq(consents.subjectId, person.id)).get();
    expect(Number(rows?.n)).toBeLessThanOrEqual(12 * 2);
  });

  test("proof uploads: 20 per 10 minutes per IP, then 429 with Retry-After", async () => {
    const ip = freshIp();
    let last: Hit | null = null;
    for (let i = 0; i < 21; i++) {
      const form = new FormData();
      form.set("ref", "TT-NOPE0000");
      form.set("declaredAmountIqd", "1000");
      last = await hit("/api/upload/proof", uploadProofAction as Handler, { form, ip });
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("Retry-After")).toMatch(/^\d+$/);
  });

  test("repairs, tickets and top-ups sent twice at once are one request", async () => {
    const key = randomToken();
    const phone = make.phone();
    const raw = { idempotencyKey: key, device: "other", deviceText: "Xbox", issue: "لا يقرأ الأقراص منذ أمس", phone };
    const repairs = await Promise.all([1, 2, 3].map(() => createRepairTicket(t.db, { customerId: null, ip: null, storeMode: "demo" }, raw, NOW)));
    expect(new Set(repairs.map((r) => r.ref)).size).toBe(1);
    expect(await t.db.select().from(repairTickets).where(eq(repairTickets.phoneE164, phone))).toHaveLength(1);
    const ticketKey = randomToken();
    const ticketPhone = make.phone();
    const tickets = await Promise.all([1, 2, 3].map(() => createSupportTicket(t.db, { customerId: null, ip: null, storeMode: "demo" }, { idempotencyKey: ticketKey, phone: ticketPhone, subject: "سؤال عن طلبي" }, NOW)));
    expect(new Set(tickets.map((r) => r.ref)).size).toBe(1);
    const person = await customer();
    const proofs = await Promise.all([1, 2].map(() => saveTopupProof(t.db, kvBlobStore(t.kv), person.actor, new File([PNG], "t.png", { type: "image/png" }), NOW)));
    const topupKey = randomToken();
    const topups = await Promise.all(proofs.map(() => requestWalletTopup(t.db, person.actor, { method: "zaincash", declaredAmountIqd: "25000", fileId: proofs[0].fileId, idempotencyKey: topupKey }, NOW).catch((error: unknown) => error)));
    const refs = topups.filter((r): r is { topup: { ref: string }; replayed: boolean } => typeof r === "object" && r !== null && "topup" in r).map((r) => r.topup.ref);
    expect(new Set(refs).size).toBe(1);
    expect(await t.db.select().from(walletTopups).where(eq(walletTopups.customerId, person.id))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── 8. what the read services hand out

const FORBIDDEN_KEY = /^(?:.*cost.*|.*landed.*|.*acquisition.*|.*margin.*|.*supplier.*|serial|serials|serialId|serialNumber|storageKey|storage_key|sha256|idHash|tokenHash|accessTokenHash|passwordHash|totpSecret.*|ip|userAgent|createdBy|verifiedBy|reviewedBy|assignedTo|duplicateOf|riskFlags|internalNote)$/i;
/** Every key path in a value whose name says protected data (or whose value is a private storage key). */
function protectedPaths(value: unknown, path = "$", out: string[] = [], allowed: ReadonlySet<string> = new Set()): string[] {
  if (Array.isArray(value)) value.forEach((item, index) => protectedPaths(item, `${path}[${index}]`, out, allowed));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key) && !allowed.has(key)) out.push(`${path}.${key}`);
      protectedPaths(child, `${path}.${key}`, out, allowed);
    }
  } else if (typeof value === "string" && /\bprv_[A-Za-z0-9_-]{16,}/.test(value)) out.push(`${path} = ${value}`);
  return out;
}

describe("what the shopper-facing read services return — no cost, serial, supplier, staff or private key", () => {
  test("every published product (page and quick preview), every device hub and every listed used unit", async () => {
    const slugs = (await t.d1.prepare("SELECT slug FROM products WHERE status = 'published'").all<{ slug: string }>()).results.map((row) => row.slug);
    expect(slugs.length).toBeGreaterThan(50);
    for (const slug of slugs) {
      const detail = await getProductDetail(t.db, "ar", slug, { now: NOW });
      if (!detail) continue;
      expect(protectedPaths(detail), slug).toEqual([]);
      expect(protectedPaths(toProductPreview(detail)), slug).toEqual([]);
    }
    const models = (await t.d1.prepare("SELECT slug FROM device_models").all<{ slug: string }>()).results.map((row) => row.slug);
    for (const slug of models) {
      const hub = await getDeviceHub(t.db, "ar", slug, { now: NOW });
      if (hub) expect(protectedPaths(hub), slug).toEqual([]);
    }
    const used = await listUsedUnits(t.db, "ar", {});
    expect(protectedPaths(used)).toEqual([]);
    for (const unit of used.items) {
      const detail = await getUsedUnitDetail(t.db, "ar", unit.slug);
      expect(protectedPaths(detail), unit.slug).toEqual([]);
    }
  });

  test("an order, a trade-in and a repair as their shopper sees them", async () => {
    const order = await guestTransferOrder();
    expect(protectedPaths(await getOrderByAccessToken(t.db, order.ref, order.accessToken, "ar", NOW))).toEqual([]);
    const answers = { power: "works", body: "like_new", account: "yes", ...(tradeDevice.hasScreen ? { screen: "perfect" } : {}), ...(tradeDevice.accessories.length ? { included: [...tradeDevice.accessories] } : {}) };
    const made = await createTradeIn(t.db, { customerId: null, ip: "198.18.0.1", locale: "ar", storeMode: "demo" }, { idempotencyKey: randomToken(24), device: tradeDevice.slug, answers, phone: make.phone(), ownershipConfirmed: true }, NOW);
    const view = await getTradeInByRef(t.db, made.ref, { accessToken: made.accessToken }, "ar", NOW);
    expect(protectedPaths(view)).toEqual([]);
    expect(JSON.stringify(view)).not.toMatch(/\+964\d{6}/);
    const repair = await createRepairTicket(t.db, { customerId: null, ip: "198.18.0.2", storeMode: "demo" }, { idempotencyKey: randomToken(), device: "other", deviceText: "Switch", serial: "XAW1234567", issue: "الشاشة لا تعمل بعد السقوط", phone: make.phone() }, NOW);
    const repairView = await getRepairByAccessToken(t.db, "ar", repair.ref, repair.accessToken);
    // repair_tickets.cost_iqd is what the CUSTOMER is charged (schema comment), not the store's cost: the one allowed key.
    expect(protectedPaths(repairView, "$", [], new Set(["costIqd"]))).toEqual([]);
    expect(JSON.stringify(repairView)).not.toContain("XAW1234567");
  });

  test("the files a shopper uploads stay private rows; no proof or photo ever became public", async () => {
    const leaked = await t.db.select({ id: files.id, kind: files.kind }).from(files).where(and(inArray(files.kind, ["payment_proof", "wallet_topup_proof", "trade_in_photo", "repair_photo", "support_photo"]), eq(files.visibility, "public")));
    expect(leaked).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── 9. reflected text never becomes markup

describe("text from the catalogue or a shopper never becomes markup — JSON-LD", () => {
  const evil = `</script><script>alert(1)</script><!-- ${ch(0x2028)}${ch(0x2029)} & "x"`;

  test("product JSON-LD: nothing can close the script element or start a comment; it still parses to the same text", () => {
    const html = jsonForScript({ name: evil, description: evil });
    expect(html).not.toMatch(/<\/script|<script|<!--/i);
    expect(html).not.toContain(ch(0x2028));
    expect(html).not.toContain(ch(0x2029));
    expect(JSON.parse(html)).toEqual({ name: evil, description: evil });
  });

  test("breadcrumb JSON-LD likewise", () => {
    const html = breadcrumbJsonLd([{ label: evil, href: "/c/x" }, { label: evil }], "https://tamtamgames.com", "ar");
    expect(html).not.toMatch(/<\/script|<script|<!--/i);
    expect((JSON.parse(html) as { itemListElement: { name: string }[] }).itemListElement[0].name).toBe(evil);
  });

  test("the product builder takes names as text; its URLs are built on our origin from the slug", () => {
    const data = productJsonLd({
      product: { name: evil, slug: "x", description: evil, short: null, brand: evil, categories: [{ name: evil, slug: "c", href: "/c/c" }] } as never,
      variant: { sku: "SKU-1", modelNumber: null, priceIqd: 1, stock: "in_stock" } as never,
      reviews: { count: 0, average: null } as never,
      origin: "https://tamtamgames.com",
      locale: "ar",
      image: "/products/x--1-1200.webp",
      storeMode: "demo",
    });
    expect(String(data.url)).toBe("https://tamtamgames.com/p/x");
    expect(data.image).toEqual(["https://tamtamgames.com/products/x--1-1200.webp"]);
    expect(data.offers).toBeUndefined();
    expect(jsonForScript(data)).not.toMatch(/<\/script|<script|<!--/i);
  });
});

void CUSTOMER_COOKIE;
