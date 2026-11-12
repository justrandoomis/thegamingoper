/**
 * The account area's services (app/server/services/account/**) on a real local D1 with the demo catalogue.
 *
 * Covered: profile (validation, audit); addresses (default rules, geography checks, limit, ownership); saved devices;
 * notification channels and consents (append-only, never assumed); notifications (paging, read, safe links);
 * recently viewed (consent gate, cap, merge); wallet top-up REQUESTS (private proof, pending only, idempotency,
 * pending limit, proof ownership, the wallet ledger untouched, cancel); one-time codes (the SMS boundary: unavailable
 * in production, dev code in development; reset and phone confirmation); sign-in merges; the overview counts;
 * after-sales reads (warranties started by a real delivery, RMAs, the return window).
 * Fixtures are chosen by their properties, never by a demo slug.
 */
import { and, eq, sql } from "drizzle-orm";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { systemActor, type CustomerActor } from "~/server/actor";
import { getCustomer, signInCustomer, signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { auditEvents, consents, customers, customerSessions, deviceModels, notifications, platforms, recentlyViewed, returns, usedUnits, walletLedger, walletTopups, wishlistItems } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { districtId, governorateId } from "~/server/db/seed/reference";
import { AppError, toAppError } from "~/server/errors";
import { setSetting } from "~/server/settings.server";
import { kvBlobStore } from "~/server/storage.server";
import { deleteAddress, listAddresses, listGeography, MAX_ADDRESSES, saveAddress, setDefaultAddress } from "~/server/services/account/addresses.server";
import { listReturnableOrders, listReturnRequests, listWarranties } from "~/server/services/account/aftersales.server";
import { codeDelivery, confirmPhoneCode, requestPasswordResetCode, requestPhoneCode, resetPasswordWithCode } from "~/server/services/account/codes.server";
import { countUnreadNotifications, listNotifications, markNotificationsRead, notificationStatement } from "~/server/services/account/notifications.server";
import { getConsent, getPreferences, recordConsent, setNotificationChannels } from "~/server/services/account/preferences.server";
import { getProfile, updateProfile } from "~/server/services/account/profile.server";
import { clearRecentlyViewed, listRecentlyViewed, listRecentlyViewedIds, MAX_RECENTLY_VIEWED, recordRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import { listDeviceOptions, listSavedDeviceIds, listSavedDevices, MAX_SAVED_DEVICES, setSavedDevice } from "~/server/services/account/saved-devices.server";
import { afterSignIn, getAccountCounts } from "~/server/services/account/session.server";
import { cancelWalletTopup, getPendingTopupTotal, getTopupProofForCustomer, listWalletTopups, MAX_PENDING_TOPUPS, requestWalletTopup, saveTopupProof } from "~/server/services/account/topups.server";
import { ACCOUNT_ERROR_KEYS } from "~/server/services/account/types";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { transitionOrder } from "~/server/services/orders/manage.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { getWishlistIds, setWished } from "~/server/services/wishlist.server";
import accountMessages from "~/i18n/messages/account";
import { action as loginAction, loader as loginLoader } from "~/routes/storefront/account/login";
import { action as logoutAction } from "~/routes/storefront/account/logout";
import { loader as ordersLoader } from "~/routes/storefront/account/orders";
import AddressesPage from "~/routes/storefront/account/addresses";
import DevicesPage from "~/routes/storefront/account/devices";
import ProfilePage from "~/routes/storefront/account/profile";
import { action as signupAction } from "~/routes/storefront/account/signup";
import { railIndex, splitOption } from "~/routes/storefront/account/components/OrderBits";
import { addressFieldIssue, addressIssues } from "~/routes/storefront/account/components/address-checks";
import { accountFailure } from "~/routes/storefront/account/account.server";
import { AddressInput } from "~/server/services/account/addresses.server";
import { messagesFor } from "~/i18n/i18n.server";
import type { Locale } from "~/lib/locales";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import checkoutMessages from "~/i18n/messages/checkout";
import errorMessages from "~/i18n/messages/errors";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
const NOW = TEST_NOW;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SYSTEM = systemActor("test.account");
/** A real 1×1 PNG (the upload pipeline parses it). */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
  await seedDemo(t.db, NOW);
}, 180_000);
afterAll(async () => {
  await t.dispose();
});

let requestCount = 0;
type TestRequest = { ctx: RequestCtx; setCookies: string[] };
function request(options: { now?: number; cookies?: Record<string, string>; isDev?: boolean } = {}): TestRequest {
  const n = ++requestCount;
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `acc-${n}`,
    nonce: "n",
    origin: "http://localhost:5173",
    isHttps: false,
    isDev: options.isDev ?? true,
    now: options.now ?? NOW,
    ip: `198.18.${Math.floor(n / 250)}.${n % 250}`,
    country: "IQ",
    userAgent: "vitest",
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

function cookiesAfter(previous: TestRequest, base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const serialized of previous.setCookies) {
    const [pair, ...rest] = serialized.split("; ");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (rest.some((part) => part.toLowerCase() === "max-age=0")) delete jar[name];
    else jar[name] = decodeURIComponent(pair.slice(at + 1));
  }
  return jar;
}

async function failure(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    const appError = error instanceof AppError ? error : toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("Expected the call to fail, but it succeeded");
}

async function customer(overrides: Parameters<Fixtures["customer"]>[0] = {}): Promise<{ id: string; actor: CustomerActor }> {
  const id = await make.customer(overrides);
  return { id, actor: { kind: "customer", id } };
}

const otp = () => ({ secret: (t.env as unknown as { SESSION_SECRET?: string }).SESSION_SECRET });
const store = () => kvBlobStore(t.kv);

// ───────────────────────────────────────────────────────────────── profile

describe("profile", () => {
  test("name, e-mail and message language change together; blank removes; bad values are field errors; changes are audited", async () => {
    const { id, actor } = await customer({ name: "علي" });
    const updated = await updateProfile(t.db, actor, { name: "  نور  ", email: "Noor@Example.IQ", locale: "en" }, NOW);
    expect(updated).toMatchObject({ name: "نور", email: "noor@example.iq", locale: "en", phoneVerified: false });
    expect(updated.phoneMasked).toMatch(/^07\d\d ••• ••\d\d$/);
    expect(await getProfile(t.db, id)).toMatchObject({ name: "نور", email: "noor@example.iq", locale: "en" });
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "customers.profile.update"))).get();
    expect(audit).toMatchObject({ actorKind: "customer", actorId: id });

    expect(await failure(() => updateProfile(t.db, actor, { email: "not-an-email" }, NOW))).toMatchObject({ code: "invalid", fields: { email: "email_invalid" } });
    expect(await failure(() => updateProfile(t.db, actor, { name: "x" }, NOW))).toMatchObject({ code: "invalid", fields: { name: "too_short" } });
    expect(await failure(() => updateProfile(t.db, actor, { locale: "fr" as never }, NOW))).toMatchObject({ code: "invalid", fields: { locale: "invalid" } });
    expect(await updateProfile(t.db, actor, { email: "" }, NOW)).toMatchObject({ email: null, name: "نور" });
    // Nothing new: no second audit row.
    const before = await t.db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(eq(auditEvents.entityId, id)).get();
    await updateProfile(t.db, actor, { name: "نور" }, NOW);
    const after = await t.db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(eq(auditEvents.entityId, id)).get();
    expect(after?.n).toBe(before?.n);
  });

  test("only customers can change a profile, and a merged account cannot", async () => {
    expect(await failure(() => updateProfile(t.db, { kind: "guest" } as never, { name: "اسم" }, NOW))).toMatchObject({ code: "unauthorized", status: 401 });
    const { actor } = await customer({ status: "merged" });
    expect(await failure(() => updateProfile(t.db, actor, { name: "اسم جديد" }, NOW))).toMatchObject({ code: "customer_unavailable", status: 409 });
  });
});

// ───────────────────────────────────────────────────────────────── addresses

describe("addresses", () => {
  const BAGHDAD = governorateId("baghdad");
  const KARRADA = districtId("baghdad", "karrada");
  const base = { governorateId: BAGHDAD, areaText: "الكرادة", addressText: "شارع 62، قرب الجسر المعلق" };

  test("the first address becomes the default; choosing another moves it; deleting the default passes it on", async () => {
    const { id, actor } = await customer();
    const home = await saveAddress(t.db, actor, { ...base, label: "البيت", districtId: KARRADA, phone: "0770 123 4567" }, NOW);
    const work = await saveAddress(t.db, actor, { ...base, label: "العمل" }, NOW + MINUTE);
    let list = await listAddresses(t.db, id, "ar");
    expect(list.map((address) => [address.id, address.isDefault])).toEqual([
      [home.id, true],
      [work.id, false],
    ]);
    expect(list[0]).toMatchObject({ phoneE164: "+9647701234567", districtId: KARRADA, governorateName: expect.any(String), districtName: expect.any(String) });

    await setDefaultAddress(t.db, actor, work.id, NOW + 2 * MINUTE);
    list = await listAddresses(t.db, id, "en");
    expect(list.filter((address) => address.isDefault).map((address) => address.id)).toEqual([work.id]);

    const third = await saveAddress(t.db, actor, { ...base, label: "بيت أهلي", makeDefault: true }, NOW + 3 * MINUTE);
    expect((await listAddresses(t.db, id, "ar")).filter((address) => address.isDefault).map((address) => address.id)).toEqual([third.id]);

    await deleteAddress(t.db, actor, third.id, NOW + 4 * MINUTE);
    list = await listAddresses(t.db, id, "ar");
    expect(list).toHaveLength(2);
    expect(list.filter((address) => address.isDefault)).toHaveLength(1);

    // Editing keeps the id and changes the fields.
    await saveAddress(t.db, actor, { ...base, id: home.id, label: "البيت الجديد", notes: "اتصل قبل الوصول" }, NOW + 5 * MINUTE);
    expect((await listAddresses(t.db, id, "ar")).find((address) => address.id === home.id)).toMatchObject({ label: "البيت الجديد", notes: "اتصل قبل الوصول" });
  });

  test("validation follows the checkout: required fields, a district of the chosen governorate, an active governorate, an Iraqi phone", async () => {
    const { actor } = await customer();
    // Every problem at once (the phone too), so the form can mark them all.
    expect(await failure(() => saveAddress(t.db, actor, { areaText: "", addressText: "", phone: "12345" } as never, NOW))).toMatchObject({ code: "invalid", fields: { governorateId: "required", areaText: "required", addressText: "required", phone: "phone_invalid" } });
    expect(await failure(() => saveAddress(t.db, actor, { ...base, addressText: "قصير" }, NOW))).toMatchObject({ fields: { addressText: "too_short" } });
    expect(await failure(() => saveAddress(t.db, actor, { ...base, districtId: districtId("basra", "zubair") }, NOW))).toMatchObject({ fields: { districtId: "district_invalid" } });
    expect(await failure(() => saveAddress(t.db, actor, { ...base, governorateId: "gov_nowhere" }, NOW))).toMatchObject({ fields: { governorateId: "shipping_unavailable" } });
    expect(await failure(() => saveAddress(t.db, actor, { ...base, phone: "12345" }, NOW))).toMatchObject({ fields: { phone: "phone_invalid" } });
  });

  test(`at most ${MAX_ADDRESSES} addresses; another customer's address is simply not found`, async () => {
    const { id, actor } = await customer();
    for (let i = 0; i < MAX_ADDRESSES; i++) await saveAddress(t.db, actor, { ...base, label: `عنوان ${i}` }, NOW + i);
    expect(await failure(() => saveAddress(t.db, actor, base, NOW))).toMatchObject({ code: "address_limit", status: 409 });
    const mine = (await listAddresses(t.db, id, "ar"))[0];
    const other = await customer();
    expect(await failure(() => saveAddress(t.db, other.actor, { ...base, id: mine.id }, NOW))).toMatchObject({ code: "not_found", status: 404 });
    expect(await failure(() => deleteAddress(t.db, other.actor, mine.id, NOW))).toMatchObject({ code: "not_found" });
    expect(await failure(() => setDefaultAddress(t.db, other.actor, mine.id, NOW))).toMatchObject({ code: "not_found" });
  });

  test("the form's geography: every active governorate with its districts", async () => {
    const geography = await listGeography(t.db, "ar");
    expect(geography.length).toBeGreaterThanOrEqual(18);
    const baghdad = geography.find((item) => item.id === BAGHDAD);
    expect(baghdad?.districts.map((district) => district.id)).toContain(KARRADA);
  });
});

// ───────────────────────────────────────────────────────────────── saved devices

describe("saved devices", () => {
  test("customers keep the published models they own; adding twice keeps one; unknown models are refused", async () => {
    const options = await listDeviceOptions(t.db, "en");
    expect(options.length).toBeGreaterThan(5);
    expect(new Set(options.map((option) => option.platformSlug)).size).toBeGreaterThan(2);
    const [first, second] = options;
    const { id, actor } = await customer();
    await setSavedDevice(t.db, actor, first.id, true, NOW);
    await setSavedDevice(t.db, actor, first.id, true, NOW + 1);
    await setSavedDevice(t.db, actor, second.id, true, NOW + 2);
    expect(await listSavedDeviceIds(t.db, id)).toEqual([second.id, first.id]);
    expect((await listSavedDevices(t.db, id, "ar")).map((device) => device.id)).toEqual([second.id, first.id]);
    await setSavedDevice(t.db, actor, second.id, false, NOW + 3);
    expect(await listSavedDeviceIds(t.db, id)).toEqual([first.id]);
    expect(await failure(() => setSavedDevice(t.db, actor, "dm_does_not_exist", true, NOW))).toMatchObject({ code: "device_unknown", status: 404 });
  });

  test(`at most ${MAX_SAVED_DEVICES} devices; drafts cannot be saved`, async () => {
    const platform = await t.db.select({ id: platforms.id }).from(platforms).limit(1).get();
    const ids = Array.from({ length: MAX_SAVED_DEVICES + 1 }, () => newId("dm"));
    for (const [index, id] of ids.entries()) {
      await t.db.insert(deviceModels).values({ id, platformId: platform!.id, slug: `test-device-${id.slice(-8).toLowerCase()}`, name: { ar: `جهاز ${index}` }, status: index === 0 ? "draft" : "published" });
    }
    const { actor } = await customer();
    expect(await failure(() => setSavedDevice(t.db, actor, ids[0], true, NOW))).toMatchObject({ code: "device_unknown" });
    const published = ids.slice(1);
    for (const id of published.slice(0, MAX_SAVED_DEVICES)) await setSavedDevice(t.db, actor, id, true, NOW);
    const options = await listDeviceOptions(t.db, "ar");
    expect(options.some((option) => option.id === ids[0])).toBe(false);
    const extra = options.find((option) => !published.slice(0, MAX_SAVED_DEVICES).includes(option.id));
    expect(await failure(() => setSavedDevice(t.db, actor, extra!.id, true, NOW))).toMatchObject({ code: "device_limit", status: 409 });
  });
});

// ───────────────────────────────────────────────────────────────── preferences and consents

describe("preferences and consents", () => {
  test("nothing is assumed: no channels, no marketing, no personalization; no provider can deliver", async () => {
    const { id } = await customer();
    expect(await getPreferences(t.db, id)).toEqual({
      channels: { sms: false, whatsapp: false, email: false },
      providers: { sms: false, whatsapp: false, email: false },
      marketing: null,
      personalization: null,
    });
  });

  test("channels are stored as chosen (unticked = no); consents are an append-only history written only on change", async () => {
    const { id, actor } = await customer();
    expect(await setNotificationChannels(t.db, actor, { sms: "1", email: "on" }, NOW)).toEqual({ sms: true, whatsapp: false, email: true });
    expect((await getPreferences(t.db, id)).channels).toEqual({ sms: true, whatsapp: false, email: true });

    const subject = { subjectType: "customer" as const, subjectId: id };
    expect(await recordConsent(t.db, { ...subject, kind: "marketing", granted: true, source: "signup", now: NOW })).toBe(true);
    expect(await recordConsent(t.db, { ...subject, kind: "marketing", granted: true, source: "account", now: NOW + 1 })).toBe(false);
    expect(await recordConsent(t.db, { ...subject, kind: "marketing", granted: false, source: "account", now: NOW + 2 })).toBe(true);
    expect(await getConsent(t.db, subject, "marketing")).toBe(false);
    expect(await getConsent(t.db, subject, "personalization")).toBeNull();
    const history = await t.db.select().from(consents).where(and(eq(consents.subjectId, id), eq(consents.kind, "marketing")));
    expect(history.map((row) => row.granted)).toEqual([true, false]);
  });
});

// ───────────────────────────────────────────────────────────────── notifications

describe("notifications", () => {
  test("newest first, in the request's language, keyset pages; read one or all; another customer's id changes nothing", async () => {
    const { id } = await customer();
    const other = await customer();
    const statements = Array.from({ length: 5 }, (_, i) =>
      notificationStatement(t.db, { customerId: id, kind: "test", title: { ar: `إشعار ${i}`, en: `Notice ${i}` }, body: { ar: "نص" }, link: i === 0 ? "//evil.example" : `/account/orders`, now: NOW + i * MINUTE }),
    );
    await t.db.batch(statements as never);
    const first = await listNotifications(t.db, id, "en", { limit: 3 });
    expect(first.total).toBe(5);
    expect(first.items.map((item) => item.title)).toEqual(["Notice 4", "Notice 3", "Notice 2"]);
    expect(first.items[0].body).toBe("نص");
    const second = await listNotifications(t.db, id, "en", { limit: 3, cursor: first.nextCursor });
    expect(second.items.map((item) => item.title)).toEqual(["Notice 1", "Notice 0"]);
    expect(second.nextCursor).toBeNull();
    // A link that leaves the store is dropped when written.
    expect(second.items[1].link).toBeNull();

    expect(await countUnreadNotifications(t.db, id)).toBe(5);
    expect(await markNotificationsRead(t.db, other.id, NOW, first.items[0].id)).toBe(0);
    expect(await markNotificationsRead(t.db, id, NOW, first.items[0].id)).toBe(1);
    expect(await countUnreadNotifications(t.db, id)).toBe(4);
    expect(await markNotificationsRead(t.db, id, NOW)).toBe(4);
    expect(await countUnreadNotifications(t.db, id)).toBe(0);
    const rows = await t.db.select().from(notifications).where(eq(notifications.customerId, id));
    expect(rows.every((row) => row.readAt === NOW)).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── recently viewed

describe("recently viewed", () => {
  test("nothing is kept without consent; with it, views are kept once, newest first, capped, and can be cleared", async () => {
    const { id } = await customer();
    const who = { customerId: id, cartToken: null };
    const productIds: string[] = [];
    for (let i = 0; i < MAX_RECENTLY_VIEWED + 2; i++) productIds.push((await make.product({ stock: 1 })).productId);

    expect(await recordRecentlyViewed(t.db, who, productIds[0], NOW, { consent: false })).toBe(false);
    expect(await listRecentlyViewedIds(t.db, who)).toEqual([]);

    for (const [i, productId] of productIds.entries()) await recordRecentlyViewed(t.db, who, productId, NOW + i, { consent: true });
    await recordRecentlyViewed(t.db, who, productIds[MAX_RECENTLY_VIEWED], NOW + 1000, { consent: true });
    const ids = await listRecentlyViewedIds(t.db, who, MAX_RECENTLY_VIEWED);
    expect(ids).toHaveLength(MAX_RECENTLY_VIEWED);
    expect(ids[0]).toBe(productIds[MAX_RECENTLY_VIEWED]);
    expect(ids).not.toContain(productIds[0]);
    const cards = await listRecentlyViewed(t.db, who, "en", NOW, 4);
    expect(cards).toHaveLength(4);

    expect(await clearRecentlyViewed(t.db, who)).toBe(MAX_RECENTLY_VIEWED);
    expect(await listRecentlyViewedIds(t.db, who)).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── wallet top-up requests

describe("wallet top-up requests", () => {
  async function proofFor(actor: CustomerActor) {
    return saveTopupProof(t.db, store(), actor, new Blob([PNG], { type: "image/png" }), NOW);
  }

  test("a request is filed pending with a private proof; the wallet ledger is not touched; retries replay", async () => {
    const { id, actor } = await customer();
    const proof = await proofFor(actor);
    expect(proof.previewPath).toBe(`/account/wallet/proof/${proof.fileId}`);
    const key = randomToken();
    const { topup, replayed } = await requestWalletTopup(t.db, actor, { method: "zaincash", declaredAmountIqd: "150,000", reference: " 778899 ", fileId: proof.fileId, idempotencyKey: key }, NOW);
    expect(replayed).toBe(false);
    expect(topup).toMatchObject({ method: "zaincash", declaredAmountIqd: 150_000, amountIqd: 150_000, reference: "778899", status: "pending_verification", rejectReason: null, proofPath: proof.previewPath });
    expect(topup.ref).toMatch(/^TU-[A-Z0-9]{8}$/);
    const row = await t.db.select().from(walletTopups).where(eq(walletTopups.id, topup.id)).get();
    expect(row?.sha256).toBe(await sha256Hex(PNG));
    expect(await getWalletBalance(t.db, id)).toBe(0);
    expect(await t.db.select().from(walletLedger).where(eq(walletLedger.customerId, id))).toHaveLength(0);
    expect(await getPendingTopupTotal(t.db, id)).toBe(150_000);

    const again = await requestWalletTopup(t.db, actor, { method: "zaincash", declaredAmountIqd: 150_000, fileId: proof.fileId, idempotencyKey: key }, NOW + 1);
    expect(again).toMatchObject({ replayed: true, topup: { id: topup.id } });
    const other = await customer();
    expect(await failure(() => requestWalletTopup(t.db, other.actor, { method: "zaincash", declaredAmountIqd: 1000, fileId: proof.fileId, idempotencyKey: key }, NOW))).toMatchObject({ code: "idempotency_mismatch", status: 409 });
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, topup.id), eq(auditEvents.action, "customers.wallet.topup_request")))).toHaveLength(1);
  });

  test("the proof must be the customer's own, unused, and is only shown to its owner", async () => {
    const owner = await customer();
    const stranger = await customer();
    const proof = await proofFor(owner.actor);
    expect(await getTopupProofForCustomer(t.db, store(), owner.id, proof.fileId)).toMatchObject({ record: { kind: "wallet_topup_proof", visibility: "private" } });
    expect(await getTopupProofForCustomer(t.db, store(), stranger.id, proof.fileId)).toBeNull();
    expect(await failure(() => requestWalletTopup(t.db, stranger.actor, { method: "bank_transfer", declaredAmountIqd: 5000, fileId: proof.fileId, idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "topup_proof_invalid", fields: { fileId: "topup_proof_invalid" } });
    await requestWalletTopup(t.db, owner.actor, { method: "bank_transfer", declaredAmountIqd: 5000, fileId: proof.fileId, idempotencyKey: randomToken() }, NOW);
    expect(await failure(() => requestWalletTopup(t.db, owner.actor, { method: "bank_transfer", declaredAmountIqd: 5000, fileId: proof.fileId, idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "topup_proof_invalid" });
  });

  test("validation: amount bounds and digits, method, the proof; a switched-off method is refused", async () => {
    const { actor } = await customer();
    const proof = await proofFor(actor);
    const base = { method: "bank_transfer", fileId: proof.fileId, idempotencyKey: randomToken() };
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, declaredAmountIqd: 500 } as never, NOW))).toMatchObject({ code: "invalid", fields: { declaredAmountIqd: "too_small" } });
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, declaredAmountIqd: 99_000_000 } as never, NOW))).toMatchObject({ fields: { declaredAmountIqd: "too_big" } });
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, declaredAmountIqd: "1.5" } as never, NOW))).toMatchObject({ fields: { declaredAmountIqd: "invalid" } });
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, declaredAmountIqd: "" } as never, NOW))).toMatchObject({ fields: { declaredAmountIqd: "required" } });
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, method: "cash", declaredAmountIqd: 5000 } as never, NOW))).toMatchObject({ fields: { method: "invalid" } });
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, method: "", declaredAmountIqd: 5000 } as never, NOW))).toMatchObject({ fields: { method: "required" } });
    expect(await failure(() => requestWalletTopup(t.db, actor, { ...base, fileId: "", declaredAmountIqd: 5000 } as never, NOW))).toMatchObject({ fields: { fileId: "topup_proof_invalid" } });
    // Arabic-Indic digits and the Arabic thousands separator are understood.
    expect((await requestWalletTopup(t.db, actor, { ...base, declaredAmountIqd: "٢٥٬٠٠٠" } as never, NOW)).topup.declaredAmountIqd).toBe(25_000);

    await setSetting(t.db, SYSTEM, "payments.zaincash", { enabled: false, number: "07719061852" }, "test: zain cash paused", NOW);
    const second = await proofFor(actor);
    expect(await failure(() => requestWalletTopup(t.db, actor, { method: "zaincash", declaredAmountIqd: 5000, fileId: second.fileId, idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "topup_method_unavailable", fields: { method: "topup_method_unavailable" } });
    await setSetting(t.db, SYSTEM, "payments.zaincash", { enabled: true, number: "07719061852" }, "test: zain cash back", NOW);
  });

  test(`at most ${MAX_PENDING_TOPUPS} pending at once; cancelling one frees a place and cannot be repeated`, async () => {
    const { id, actor } = await customer();
    const filed: Awaited<ReturnType<typeof requestWalletTopup>>["topup"][] = [];
    for (let i = 0; i < MAX_PENDING_TOPUPS; i++) {
      const proof = await proofFor(actor);
      filed.push((await requestWalletTopup(t.db, actor, { method: "bank_transfer", declaredAmountIqd: 10_000, fileId: proof.fileId, idempotencyKey: randomToken() }, NOW + i)).topup);
    }
    const extra = await proofFor(actor);
    expect(await failure(() => requestWalletTopup(t.db, actor, { method: "bank_transfer", declaredAmountIqd: 10_000, fileId: extra.fileId, idempotencyKey: randomToken() }, NOW))).toMatchObject({ code: "topup_pending_limit", status: 409 });
    expect(await getPendingTopupTotal(t.db, id)).toBe(30_000);

    const other = await customer();
    expect(await failure(() => cancelWalletTopup(t.db, other.actor, filed[0].id, NOW))).toMatchObject({ code: "not_found" });
    await cancelWalletTopup(t.db, actor, filed[0].id, NOW);
    expect(await failure(() => cancelWalletTopup(t.db, actor, filed[0].id, NOW))).toMatchObject({ code: "topup_not_pending", status: 409 });
    expect(await getPendingTopupTotal(t.db, id)).toBe(20_000);
    expect((await listWalletTopups(t.db, id)).map((topup) => topup.status).sort()).toEqual(["cancelled", "pending_verification", "pending_verification"]);
    await requestWalletTopup(t.db, actor, { method: "bank_transfer", declaredAmountIqd: 10_000, fileId: extra.fileId, idempotencyKey: randomToken() }, NOW);
  });

  test("only the reject reason of a rejected request reaches the customer", async () => {
    const { id, actor } = await customer();
    const proof = await proofFor(actor);
    const { topup } = await requestWalletTopup(t.db, actor, { method: "bank_transfer", declaredAmountIqd: 20_000, fileId: proof.fileId, idempotencyKey: randomToken() }, NOW);
    await t.db.update(walletTopups).set({ status: "rejected", rejectReason: "المبلغ في الصورة لا يطابق." }).where(eq(walletTopups.id, topup.id));
    expect((await listWalletTopups(t.db, id))[0]).toMatchObject({ status: "rejected", rejectReason: "المبلغ في الصورة لا يطابق." });
    expect(await getPendingTopupTotal(t.db, id)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── one-time codes (the SMS boundary)

describe("one-time codes", () => {
  test("production has no SMS provider: codes are unavailable and nothing is generated", async () => {
    expect(codeDelivery(false)).toBe("unavailable");
    expect(codeDelivery(true)).toBe("dev");
    const req = request({ isDev: false });
    expect(await failure(() => requestPasswordResetCode(req.ctx, t.db, { phone: "0770 555 1234" }, otp()))).toMatchObject({ code: "otp_unavailable", status: 503 });
    expect(await failure(() => resetPasswordWithCode(req.ctx, t.db, { phone: "0770 555 1234", code: "123456", password: "a-new-password" }, otp()))).toMatchObject({ code: "otp_unavailable" });
  });

  test("development: the reset code resets the password and signs every device out; a wrong code or an unknown number fail alike", async () => {
    const phone = "07705551234";
    const signup = request();
    const session = await signUpCustomer(signup.ctx, t.db, { phone, password: "first-password" });
    const sent = await requestPasswordResetCode(request().ctx, t.db, { phone }, otp());
    expect(sent).toMatchObject({ delivery: "dev", phoneMasked: "0770 ••• ••34" });
    expect(sent.devCode).toMatch(/^\d{6}$/);

    expect(await failure(() => resetPasswordWithCode(request().ctx, t.db, { phone, code: "000000", id: sent.id, password: "second-password" }, otp()))).toMatchObject({ code: "otp_invalid" });
    expect(await failure(() => resetPasswordWithCode(request().ctx, t.db, { phone, code: sent.devCode, id: sent.id, password: "short" }, otp()))).toMatchObject({ code: "invalid", fields: { password: "password_too_short" } });
    await resetPasswordWithCode(request().ctx, t.db, { phone, code: sent.devCode, id: sent.id, password: "second-password" }, otp());
    const revoked = await t.db.select().from(customerSessions).where(eq(customerSessions.customerId, session.customer.id));
    expect(revoked.every((row) => row.revokedAt !== null)).toBe(true);
    expect((await signInCustomer(request().ctx, t.db, { phone, password: "second-password" })).customer.id).toBe(session.customer.id);
    expect(await failure(() => signInCustomer(request().ctx, t.db, { phone, password: "first-password" }))).toMatchObject({ code: "invalid_credentials" });

    // A number without an account: a code is "sent" (same answer), and the reset fails like a wrong code.
    const ghost = await requestPasswordResetCode(request().ctx, t.db, { phone: "07705559876" }, otp());
    expect(await failure(() => resetPasswordWithCode(request().ctx, t.db, { phone: "07705559876", code: ghost.devCode, id: ghost.id, password: "whatever-password" }, otp()))).toMatchObject({ code: "otp_invalid" });
  });

  test("development: the signed-in customer confirms their number with a code", async () => {
    const signup = request();
    await signUpCustomer(signup.ctx, t.db, { phone: "07705550001", password: "a-good-password" });
    const cookies = cookiesAfter(signup);
    const sent = await requestPhoneCode(request({ cookies }).ctx, t.db, otp());
    expect(sent.devCode).toMatch(/^\d{6}$/);
    expect(await failure(() => confirmPhoneCode(request({ cookies }).ctx, t.db, { code: "" }, otp()))).toMatchObject({ code: "invalid", fields: { code: "required" } });
    // Confirming the number moves this device to a new session token (SECURITY §6): read on with the new cookie.
    const confirm = request({ cookies });
    await confirmPhoneCode(confirm.ctx, t.db, { code: sent.devCode, id: sent.id }, otp());
    const rotated = cookiesAfter(confirm, cookies);
    expect(rotated.tt_sid).toBeTruthy();
    expect(rotated.tt_sid).not.toBe(cookies.tt_sid);
    expect((await getCustomer(request({ cookies: rotated }).ctx, t.db))?.customer.phoneVerified).toBe(true);
    expect(await getCustomer(request({ cookies }).ctx, t.db)).toBeNull();
    expect(await failure(() => requestPhoneCode(request().ctx, t.db, otp()))).toMatchObject({ code: "unauthorized" });
  });
});

// ───────────────────────────────────────────────────────────────── sign-in merges, overview, after-sales

describe("signing in brings the guest's things along", () => {
  async function inStock() {
    return make.product({ stock: 5, priceIqd: 90_000 });
  }

  test("cart, favourites and — with consent — history join the account; without consent the guest history is dropped", async () => {
    const { id } = await customer();
    const item = await inStock();
    const added = await addToCart(t.db, { cartToken: null, customerId: null, locale: "en" }, { variantId: item.variantId, qty: 2 }, NOW);
    const bridge = randomToken();
    await setWished(t.db, { customerId: null, cartToken: null, wishToken: bridge }, item.productId, true, NOW);
    const seen = await inStock();
    await recordRecentlyViewed(t.db, { customerId: null, cartToken: added.cartToken }, seen.productId, NOW, { consent: true });

    expect(await afterSignIn(t.db, { customerId: id, cartToken: added.cartToken, wishToken: bridge, devicePersonalization: true }, NOW + 1)).toEqual({ personalization: null });
    expect((await getCartView(t.db, { cartToken: null, customerId: id, locale: "en" }, NOW + 2)).count).toBe(2);
    expect(await getWishlistIds(t.db, { customerId: id, cartToken: null })).toEqual([item.productId]);
    expect(await listRecentlyViewedIds(t.db, { customerId: id, cartToken: null })).toEqual([seen.productId]);
    expect(await t.db.select().from(wishlistItems).where(eq(wishlistItems.cartTokenHash, await sha256Hex(bridge)))).toHaveLength(0);

    // The account said no to personalization: the guest's history is not kept.
    const other = await customer();
    await recordConsent(t.db, { subjectType: "customer", subjectId: other.id, kind: "personalization", granted: false, source: "account", now: NOW });
    const cart = (await addToCart(t.db, { cartToken: null, customerId: null, locale: "en" }, { variantId: item.variantId, qty: 1 }, NOW)).cartToken;
    await recordRecentlyViewed(t.db, { customerId: null, cartToken: cart }, seen.productId, NOW, { consent: true });
    expect(await afterSignIn(t.db, { customerId: other.id, cartToken: cart, wishToken: null, devicePersonalization: true }, NOW)).toEqual({ personalization: false });
    expect(await listRecentlyViewedIds(t.db, { customerId: other.id, cartToken: null })).toEqual([]);
    expect(await t.db.select().from(recentlyViewed).where(eq(recentlyViewed.cartTokenHash, await sha256Hex(cart)))).toHaveLength(0);
  });
});

describe("the account overview and after-sales", () => {
  test("counts; a real delivered order starts warranties and opens the return window; RMAs are listed without staff notes", async () => {
    const { id } = await customer();
    // A listed used unit with a warranty (picked by its properties): it is reserved, shipped and delivered for real.
    const unit = await t.db
      .select()
      .from(usedUnits)
      .where(and(eq(usedUnits.status, "listed"), sql`${usedUnits.warrantyDays} > 0`))
      .limit(1)
      .get();
    expect(unit).toBeDefined();
    const added = await addToCart(t.db, { cartToken: null, customerId: id, locale: "en" }, { usedUnitId: unit!.id }, NOW);
    const total = (await getCartView(t.db, { cartToken: added.cartToken, customerId: id, locale: "en", governorateId: governorateId("baghdad") }, NOW)).totalIqd;
    const placed = await placeOrder(
      t.db,
      { cartToken: added.cartToken, customer: { id }, locale: "en", ip: null, storeMode: "live" },
      { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), areaText: "الكرادة", addressText: "شارع 62، قرب الجسر المعلق", marketingConsent: false, paymentMethod: "cod", expectedTotalIqd: total },
      NOW,
    );
    let counts = await getAccountCounts(t.db, id);
    expect(counts).toMatchObject({ orders: 1, openOrders: 1 });

    await transitionOrder(t.db, SYSTEM, placed.orderId, "confirmed", {}, NOW + MINUTE);
    await transitionOrder(t.db, SYSTEM, placed.orderId, "shipped", {}, NOW + 2 * MINUTE);
    await transitionOrder(t.db, SYSTEM, placed.orderId, "delivered", {}, NOW + DAY);
    counts = await getAccountCounts(t.db, id);
    expect(counts).toMatchObject({ orders: 1, openOrders: 0 });

    const warranties = await listWarranties(t.db, id, "en", NOW + 2 * DAY);
    expect(warranties).toHaveLength(1);
    expect(warranties[0]).toMatchObject({ orderRef: placed.ref, state: "active", startsAt: NOW + DAY, endsAt: NOW + DAY + unit!.warrantyDays * DAY });
    expect((await listWarranties(t.db, id, "en", NOW + DAY + unit!.warrantyDays * DAY + 1))[0].state).toBe("expired");
    expect(await listWarranties(t.db, (await customer()).id, "en", NOW)).toEqual([]);

    const window = await listReturnableOrders(t.db, id, "en", NOW + 2 * DAY);
    expect(window.windowDays).toBeGreaterThan(0);
    expect(window.orders).toEqual([expect.objectContaining({ ref: placed.ref, deliveredAt: NOW + DAY, windowEndsAt: NOW + DAY + window.windowDays * DAY, itemCount: 1 })]);
    expect((await listReturnableOrders(t.db, id, "en", NOW + DAY + (window.windowDays + 1) * DAY)).orders).toEqual([]);

    await t.db.insert(returns).values({ id: newId("rma"), rma: "RMA-TEST0001", orderId: placed.orderId, customerId: id, status: "rejected", reasonCode: "changed_mind", staffNote: "internal: customer was rude", rejectReason: "انتهت مدة الإرجاع.", createdAt: NOW + 3 * DAY });
    const requests = await listReturnRequests(t.db, id);
    expect(requests).toEqual([expect.objectContaining({ rma: "RMA-TEST0001", orderRef: placed.ref, status: "rejected", rejectReason: "انتهت مدة الإرجاع." })]);
    expect(JSON.stringify(requests)).not.toContain("internal");
  });

  test("every account error key has a sentence in ar, en and ckb (in the account namespace or the shared one)", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const own = (accountMessages[locale] as { errors: Record<string, string> }).errors;
      const shared = (errorMessages[locale] as { errors: Record<string, string> }).errors;
      for (const key of [...ACCOUNT_ERROR_KEYS, "invalid_credentials", "phone_taken", "otp_invalid", "rate_limited", "email_invalid", "district_invalid", "shipping_unavailable", "idempotency_mismatch", "customer_unavailable"]) {
        expect(own[key] ?? shared[key], `${locale}: errors.${key}`).toEqual(expect.any(String));
      }
    }
  });

  test("a customer without anything has zero everywhere", async () => {
    const { id } = await customer();
    expect(await getAccountCounts(t.db, id)).toEqual({ orders: 0, openOrders: 0, addresses: 0, savedDevices: 0, unreadNotifications: 0, wishlist: 0, pendingTopups: 0 });
    expect(await t.db.select().from(customers).where(eq(customers.id, id))).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────── the routes, behind the real root middleware


const SITE = "http://localhost:5173";
type RouteResult = { status: number; location: string | null; data: unknown; setCookies: string[] };

/** Runs a loader or action the way React Router does: root middleware (context, CSRF, cookies) first. */
async function viaRoot(path: string, handler: (args: never) => Promise<unknown>, init: { method?: string; form?: Record<string, string>; cookies?: Record<string, string> } = {}): Promise<RouteResult> {
  const headers: Record<string, string> = { "CF-Connecting-IP": `203.0.113.${++requestCount % 250}` };
  if (init.cookies) headers.Cookie = Object.entries(init.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  if (init.form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (init.method === "POST") headers.Origin = SITE;
  const request = new Request(`${SITE}${path}`, { method: init.method ?? "GET", headers, body: init.form ? new URLSearchParams(init.form) : undefined });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let value: unknown;
  const response = (await requestContextMiddleware({ request, context, url, pattern: path, params: {} } as never, async () => {
    try {
      value = await handler({ request, context, params: {}, url, pattern: path } as never);
    } catch (thrown) {
      value = thrown;
    }
    if (value instanceof Response) return value;
    const init = (value as { init?: { status?: number; headers?: HeadersInit } }).init;
    return new Response(null, { status: init?.status ?? 200, headers: init?.headers });
  })) as Response;
  const data = value instanceof Response ? null : ((value as { data?: unknown }).data ?? value);
  return { status: response.status, location: response.headers.get("Location"), data, setCookies: response.headers.getSetCookie() };
}

describe("routes", () => {
  test("sign-in: a wrong password answers one translated sentence (401); the right one signs in, merges the guest cart and goes to next", async () => {
    const phone = "07705550202";
    await signUpCustomer(request().ctx, t.db, { phone, password: "route-password-1" });
    const wrong = await viaRoot("/account/login", loginAction as never, { method: "POST", form: { phone, password: "nope-nope-nope", next: "/account/wallet" } });
    expect(wrong.status).toBe(401);
    expect(wrong.data).toMatchObject({ ok: false, code: "invalid_credentials", phone, message: expect.stringContaining("بيانات الدخول غير صحيحة") });
    expect(wrong.setCookies.some((c) => c.startsWith("tt_sid=") && !/Max-Age=0/.test(c))).toBe(false);

    const item = await make.product({ stock: 3 });
    const guestCart = (await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId: item.variantId, qty: 1 }, NOW)).cartToken;
    const right = await viaRoot("/account/login", loginAction as never, { method: "POST", form: { phone, password: "route-password-1", next: "https://evil.example/" }, cookies: { tt_cart: guestCart } });
    expect(right.status).toBe(302);
    // An outside `next` is refused: the account instead.
    expect(right.location).toBe("/account");
    const sid = right.setCookies.find((c) => c.startsWith("tt_sid="));
    expect(sid).toMatch(/HttpOnly/);
    const token = decodeURIComponent(sid!.split(";")[0].slice("tt_sid=".length));
    const session = await getCustomer(request({ cookies: { tt_sid: token } }).ctx, t.db);
    expect((await getCartView(t.db, { cartToken: null, customerId: session!.customer.id, locale: "ar" }, NOW)).count).toBe(1);

    // Signed in: the sign-in page sends straight on (checkout never asks twice).
    const again = await viaRoot("/en/account/login?next=%2Fcheckout", loginLoader as never, { cookies: { tt_sid: token } });
    expect(again).toMatchObject({ status: 302, location: "/en/checkout" });

    // Signing out ends the session and drops the cart cookie for the next person on the device.
    const out = await viaRoot("/account/logout", logoutAction as never, { method: "POST", cookies: { tt_sid: token, tt_cart: guestCart } });
    expect(out).toMatchObject({ status: 302, location: "/account/login?signedout=1" });
    expect(out.setCookies.some((c) => c.startsWith("tt_sid=;") && /Max-Age=0/.test(c))).toBe(true);
    expect(out.setCookies.some((c) => c.startsWith("tt_cart=;") && /Max-Age=0/.test(c))).toBe(true);
    expect(await getCustomer(request({ cookies: { tt_sid: token } }).ctx, t.db)).toBeNull();
  });

  test("account pages send guests to sign in with the page as next, in their language", async () => {
    const guest = await viaRoot("/ckb/account/orders?cursor=1", ordersLoader as never);
    expect(guest).toMatchObject({ status: 302, location: "/ckb/account/login?next=%2Faccount%2Forders%3Fcursor%3D1" });
  });

  test("cross-site posts to the sign-in action are refused before anything runs", async () => {
    const request = new Request(`${SITE}/account/login`, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ phone: "07705550202", password: "route-password-1" }) });
    let ran = false;
    const outcome = await Promise.resolve(
      requestContextMiddleware({ request, context: new RouterContextProvider(), url: new URL(request.url), pattern: "/account/login", params: {} } as never, async () => {
        ran = true;
        return new Response(null);
      }),
    ).catch((error: unknown) => error);
    expect(ran).toBe(false);
    expect((outcome as { init?: { status?: number } }).init?.status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────── Design System v2 screens: pure helpers and copy rules

describe("v2 account screens", () => {
  test("an order line's name as sold splits into the product's name and the option value (§4.13)", () => {
    expect(splitOption("PlayStation 5 Slim (نسخة الأقراص) – 1TB — نسخة الأقراص 1TB")).toEqual({ name: "PlayStation 5 Slim (نسخة الأقراص) – 1TB", option: "نسخة الأقراص 1TB" });
    expect(splitOption("Nintendo Switch")).toEqual({ name: "Nintendo Switch", option: null });
    expect(splitOption("DualSense — ")).toEqual({ name: "DualSense", option: null });
  });

  test("the order rail places every status on the five real states; a closed order leaves it (§6.11)", () => {
    const statuses = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped", "delivered", "cancelled", "returned"] as const;
    expect(statuses.map(railIndex)).toEqual([0, 0, 0, 1, 2, 3, 4, null, null]);
  });

  test("the copy follows the v2 voice in ar, en and ckb (§9): no game-turn line, no call promise, no builder's voice", () => {
    const strings = (tree: unknown, out: string[] = []): string[] => {
      if (typeof tree === "string") out.push(tree);
      else if (tree && typeof tree === "object") for (const value of Object.values(tree)) strings(value, out);
      return out;
    };
    for (const locale of ["ar", "en", "ckb"] as const) {
      const text = strings(accountMessages[locale]).join("\n");
      expect(text, locale).not.toMatch(/دورك\.|نۆرەی تۆیە|Your turn/);
      expect(text, locale).not.toMatch(/نتصل|call you|we call|پەیوەندیت پێوە دەکەین/i);
      expect(text, locale).not.toMatch(/وضع التطوير|Development only|دۆخی گەشەپێدان/);
      expect(text, locale).not.toMatch(/تحويل بطاقة مصرفية|ماستر كارد|Bank card transfer/);
      // Zero is one pattern in every language: «لا طلبات بعد», "No orders yet" — never "0 orders".
      const overview = (accountMessages[locale] as unknown as { overview: Record<string, { zero?: string }> }).overview;
      for (const key of ["hintOrders", "hintAddresses", "hintDevices", "hintWishlist"]) expect(overview[key].zero, `${locale} overview.${key}.zero`).toEqual(expect.any(String));
    }
    expect(accountMessages.ar.methods.bank_transfer).toBe("تحويل إلى بطاقة ماستركارد");
    expect(accountMessages.en.payment.cod_due).toBe("Due on delivery");
    expect(accountMessages.ar.order.preferredNote).toBe("وقت مفضّل وليس موعداً مؤكداً.");
    expect(accountMessages.ar.orders.total).toBe("الإجمالي");
    // The offers consent is the checkout's sentence.
    expect(accountMessages.ar.signup.marketing).toBe("أرسل لي العروض على هذا الرقم");
    expect(accountMessages.ar.settings.marketing).toBe(accountMessages.ar.signup.marketing);
  });
});

// ───────────────────────────────────────────────────────────────── review fixes (design v2, P7 review)

/**
 * An account page as the server renders it — what a shopper without script gets, and what the browser shows before
 * hydration — with its loader's data and the strings the account layout would carry.
 */
function renderAccountPage(Component: unknown, url: string, loaderData: Record<string, unknown>, locale: Locale = "ar", actionData?: unknown): string {
  const path = url.split("?")[0].replace(/^\//, "");
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path, Component: Component as never }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: [url],
      hydrationData: {
        loaderData: {
          root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui", "ui-card", "ui-shop", "ui-overlays") },
          page: { ...loaderData, i18n: messagesFor(locale, "account") },
        },
        ...(actionData ? { actionData: { page: actionData as never } } : {}),
      },
    }),
  );
}

/** The <noscript> parts of server HTML, and the rest. */
function splitNoscript(html: string): { noscript: string; rest: string } {
  const noscript = [...html.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map((match) => match[1]).join("\n");
  return { noscript, rest: html.replace(/<noscript>[\s\S]*?<\/noscript>/g, "") };
}

describe("forms that worked without script still do (P7 review)", () => {
  test("an address can be saved without script: the governorate is a native select, and the picker sends nothing before script", async () => {
    const geography = await listGeography(t.db, "ar");
    const html = renderAccountPage(AddressesPage, "/account/addresses?new=1", { addresses: [], geography, max: MAX_ADDRESSES });
    const { noscript, rest } = splitNoscript(html);
    // Exactly one governorateId in the form: the native select inside <noscript>, with every governorate.
    expect(html.match(/name="governorateId"/g)).toHaveLength(1);
    expect(noscript).toMatch(/<select[^>]*name="governorateId"/);
    for (const governorate of geography) expect(noscript).toContain(`value="${governorate.id}"`);
    // The script picker is there for script (hidden without it), without a hidden field of its own yet.
    expect(rest).not.toMatch(/type="hidden" name="governorateId"/);
    expect(rest).toMatch(/class="field noscript:hidden/);
    // Without script the district list cannot follow a governorate: every district is offered, under its governorate.
    expect(rest).toContain(`<optgroup label="${geography[0].name}"`);
  });

  test("a device can be owned without script: each one has a plain form with a toggle key", async () => {
    const options = (await listDeviceOptions(t.db, "ar")).slice(0, 3);
    const html = renderAccountPage(DevicesPage, "/account/devices", { options, savedIds: [options[0].id] });
    const { noscript } = splitNoscript(html);
    expect(noscript.match(/<form method="post">/g)).toHaveLength(options.length);
    for (const option of options) expect(noscript).toContain(`name="deviceModelId" value="${option.id}"`);
    // The owned device's key is held and sends "0" (remove); the others send "1" (own).
    expect(noscript.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(noscript.match(/name="saved" value="0"/g)).toHaveLength(1);
    expect(noscript.match(/name="saved" value="1"/g)).toHaveLength(options.length - 1);
  });

  test("the messages language can be changed without script: native radios, and no hidden value from the segmented control", async () => {
    const { id } = await customer();
    const profile = await getProfile(t.db, id);
    const html = renderAccountPage(ProfilePage, "/account/profile", { profile: { ...profile, locale: "en" } });
    const { noscript, rest } = splitNoscript(html);
    expect(noscript.match(/type="radio"[^>]*name="locale"/g)).toHaveLength(3);
    expect(noscript).toMatch(/<input(?=[^>]*value="en")(?=[^>]*checked)[^>]*>/);
    expect(noscript).not.toMatch(/<input(?=[^>]*value="ar")(?=[^>]*checked)[^>]*>/);
    expect(rest).not.toMatch(/name="locale"/);
  });
});

describe("sign-up says everything that is wrong at once (P7 review)", () => {
  test("a short password and a mistyped number are both field errors in one answer", async () => {
    // The server core checks the number only after the other fields: alone, it names the password first.
    const core = await failure(() => signUpCustomer(request().ctx, t.db, { phone: "0770", password: "abc" }));
    expect(Object.keys(core.fields ?? {})).toEqual(["password"]);
    const answer = await viaRoot("/account/signup", signupAction as never, { method: "POST", form: { phone: "0770", password: "abc" } });
    expect(answer.status).toBe(400);
    const fields = (answer.data as { fields?: Record<string, string> }).fields ?? {};
    expect(Object.keys(fields).sort()).toEqual(["password", "phone"]);
    expect(fields.phone).toEqual(expect.any(String));
    expect(fields.phone).not.toBe("phone_invalid");
    // A number that is fine adds nothing.
    const fine = await viaRoot("/account/signup", signupAction as never, { method: "POST", form: { phone: "07705550399", password: "abc" } });
    expect(Object.keys((fine.data as { fields?: Record<string, string> }).fields ?? {})).toEqual(["password"]);
  });
});

describe("honest copy (P7 review)", () => {
  test("the reset page never promises that a person resets the password (no staff tool does), in any language", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const forgot = accountMessages[locale].forgot;
      const text = `${forgot.unavailableTitle} ${forgot.unavailableText}`;
      expect(text, locale).not.toMatch(/يساعدك في الدخول|نستعيد كلمة المرور مع|resets your password|help you sign in|یارمەتیت دەدات بچیتە ژوورەوە|دەگەڕێنێتەوە/);
    }
  });

  test("the viewing-history switch says it also shapes suggestions; the language hint does not point at a place that phones lack", () => {
    expect(accountMessages.ar.settings.personalizationHint).toContain("نقترح");
    expect(accountMessages.en.settings.personalizationHint).toMatch(/suggestions/);
    for (const locale of ["ar", "en", "ckb"] as const) expect(accountMessages[locale].profile.localeHint, locale).not.toMatch(/أعلى الصفحة|top of the page|سەرەوەی پەڕەکە/);
  });

  test("the returns policy is named once, as the link inside the sentence", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const lead = accountMessages[locale].returns.lead as Record<string, string>;
      for (const form of Object.values(lead)) {
        expect(form, locale).toContain("{policy}");
        expect(form, locale).not.toContain(accountMessages[locale].returns.policy);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── QA fixes (the transaction matrix, 2026-11-12)

describe("the address book checks an address as the checkout does (QA 2026-11-12)", () => {
  const EMPTY = { label: "", recipientName: "", phone: "", governorateId: "", districtId: "", areaText: "", addressText: "", notes: "" };

  test("each problem is found on the page before any request, and said in the checkout's own words", () => {
    // Found in the browser: «احفظ العنوان» with empty fields went to the server (400) and came back as three «هذا الحقل
    // مطلوب.», while the checkout says «اكتب المنطقة أو الحي.» on blur — one address, two kinds of errors.
    expect(addressIssues(EMPTY)).toEqual({ governorateId: { code: "required" }, areaText: { code: "required" }, addressText: { code: "required" } });
    expect(addressIssues({ ...EMPTY, governorateId: governorateId("baghdad"), recipientName: "ع", phone: "0770 123", areaText: "ك", addressText: "شارع" })).toEqual({
      recipientName: { code: "too_short" },
      phone: { code: "short", count: 4 },
      areaText: { code: "too_short" },
      addressText: { code: "too_short" },
    });
    // the recipient's number is optional: empty is fine, anything typed is checked like the checkout's
    expect(addressFieldIssue("phone", "")).toBeNull();
    expect(addressFieldIssue("phone", "0770 123 4567")).toBeNull();
    for (const locale of ["ar", "en", "ckb"] as const) {
      const own = accountMessages[locale].addresses.fields;
      const checkout = checkoutMessages[locale].fields;
      expect(own.governorateId.required, locale).toBe(checkout.governorateId.required);
      expect(own.areaText.required, locale).toBe(checkout.areaText.required);
      expect(own.areaText.too_short, locale).toBe(checkout.areaText.too_short);
      expect(own.addressText.required, locale).toBe(checkout.addressText.required);
      expect(own.addressText.too_short, locale).toBe(checkout.addressText.too_short);
      expect(own.phone, locale).toEqual(checkout.phone);
    }
  });

  test("the page's checks are the address service's rules: the same answer at every edge", () => {
    const base = { governorateId: governorateId("baghdad"), areaText: "الكرادة", addressText: "شارع 62، دار 14" };
    const cases: Array<[keyof typeof EMPTY, string]> = [
      ["areaText", "ك"],
      ["areaText", "كك"],
      ["areaText", "ك".repeat(120)],
      ["areaText", "ك".repeat(121)],
      ["addressText", "شارع"],
      ["addressText", "شارع 6"],
      ["addressText", "ش".repeat(300)],
      ["addressText", "ش".repeat(301)],
      ["notes", "ن".repeat(300)],
      ["notes", "ن".repeat(301)],
      ["label", "ب".repeat(40)],
      ["label", "ب".repeat(41)],
      ["recipientName", "ع"],
      ["recipientName", "عل"],
      ["recipientName", "ع".repeat(80)],
      ["recipientName", "ع".repeat(81)],
      ["phone", "0770 123 4567"],
      ["phone", "0770 123"],
      ["phone", "0660 123 4567"],
      ["phone", "   "],
      ["governorateId", ""],
    ];
    for (const [field, value] of cases) {
      const server = AddressInput.safeParse({ ...base, [field]: value });
      const serverSays = server.success ? null : (server.error.issues.find((issue) => issue.path[0] === field)?.message ?? "other");
      const pageSays = addressFieldIssue(field, value);
      expect(pageSays === null, `${field} (${value.length} characters): the service says ${serverSays}, the page ${JSON.stringify(pageSays)}`).toBe(serverSays === null);
    }
  });

  test("a save posted without script names each problem in the page's words, not «هذا الحقل مطلوب.», with the summary", async () => {
    const { actor } = await customer();
    const values = { intent: "save", ...EMPTY };
    const error = await failure(() => saveAddress(t.db, actor, values as never, NOW));
    const answer = { ...accountFailure(error, "ar"), intent: "save", values };
    const geography = await listGeography(t.db, "ar");
    const html = renderAccountPage(AddressesPage, "/account/addresses?new=1", { addresses: [], geography, max: MAX_ADDRESSES }, "ar", answer);
    for (const sentence of ["اختر المحافظة التي نوصل إليها.", "اكتب المنطقة أو الحي.", "اكتب العنوان بالتفصيل: الشارع والمحلة وأقرب نقطة دالة."]) expect(html).toContain(sentence);
    expect(html).not.toContain("هذا الحقل مطلوب.");
    expect(html).toMatch(/role="alert"[\s\S]*?href="#address-governorate"[\s\S]*?href="#address-area"[\s\S]*?href="#address-text"/);
  });

  test("with script the form checks a field when it is left, and every field before it is sent", () => {
    const source = readFileSync(new URL("../app/routes/storefront/account/addresses.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/onBlur[:=]\s*\(?\{?\s*\(?event/);
    expect(source).toMatch(/onSubmit=\{/);
    expect(source).toMatch(/addressIssues\(/);
    expect(source).toMatch(/<FormErrorSummary\b/);
  });
});

describe("a privacy request's confirmation (QA 2026-11-12)", () => {
  test("promises no contact: a staff member checks who you are, and the request's state is on this page", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const sent = accountMessages[locale].privacy.sent;
      expect(sent, locale).toContain("{ref}");
      expect(sent, locale).not.toMatch(/يتواصل|نتواصل|نتصل|سنتصل|contact|call you|پەیوەندی/);
    }
    expect(accountMessages.ar.privacy.sent).toBe("استلمنا طلبك {ref}. يتحقق موظف من هويتك قبل أي إجراء، وتجد حالة الطلب هنا.");
  });
});
