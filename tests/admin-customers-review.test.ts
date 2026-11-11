/**
 * Admin module 07 "customers" — the adversarial review (2026-11-11). Each test here failed on the builder's code:
 *
 *   · field rules: the profile's activity sent wallet and consent events (with their reasons) to staff who may not
 *     read those sections; the merge plan and its candidates sent every customer's wallet balance to anyone who may
 *     merge (and the erasure plan to anyone who handles privacy requests) without customers.wallet.read; a fraud
 *     reason kept a typed phone number in full for staff without customer.phone.read_full, and took card numbers
 *   · business integrity: a merge folded a BLOCKED or FRAUD-FLAGGED duplicate into a clean account, so the block or
 *     the flag (and module 05's review of the person's orders) silently vanished — also when the label landed just
 *     before the merge's batch
 *   · races (the competing request lands just before the service's write batch): an erasure went through while a
 *     return or a repair had just been opened; an address was added past the limit of 10
 *   · privacy: an erasure (and an account's unsubscribe) left the person's checkout answers as a guest "granted" —
 *     the store could still market to the erased number —, kept the guest contact's name and the consented browsing
 *     signals; a finished export request still handed out new copies of the file (the page said it would not); a
 *     withdrawal could still be written on an erased account; a visitor's number could hold several open
 *     unsubscribe requests
 *   · honesty: 07.04 said "implemented" though a deletion request of a customer with money in the wallet cannot be
 *     completed anywhere in the admin (no wallet payout exists)
 */
import { and, desc, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { statusOf } from "~/routes/admin/blueprint-status";
import { contactAction } from "~/routes/admin/customers/actions.server";
import { loader as privacyExportLoader } from "~/routes/admin/customers/privacy-export";
import { type EmployeeActor } from "~/server/actor";
import { signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { addresses, consents, customers, employeeRoles, guestContacts, privacyRequests, recommendationEvents, repairTickets, returns } from "~/server/db/schema";
import { governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { getContactView, saveCustomerAddress, setCustomerChannels } from "~/server/services/admin/customers/contact.server";
import { setFraudFlag } from "~/server/services/admin/customers/flags.server";
import { listCustomers } from "~/server/services/admin/customers/list.server";
import { duplicateCandidates, mergeCustomers, planMerge } from "~/server/services/admin/customers/merge.server";
import {
  buildPrivacyExport,
  completePrivacyRequest,
  createPrivacyRequest,
  erasedPhone,
  executeErasure,
  executeUnsubscribe,
  getPrivacyRequest,
  recordWithdrawal,
  verifyPrivacyRequest,
} from "~/server/services/admin/customers/privacy.server";
import { customerHeader, getCustomerProfile } from "~/server/services/admin/customers/profile.server";
import { MAX_CUSTOMER_ADDRESSES, parseCustomerFilters } from "~/server/services/admin/customers/types";
import { creditWallet } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey, EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "support", "cashier"] as const) staff[key] = await employee(key);
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}

const as = (key: DefaultRoleKey): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
/** The manager's identity with exactly these permissions (a role an owner could build). */
const custom = (permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: as("manager").id, permissions: new Set(permissions), label: "custom" });

/** A hand-made session for the route glue (actions.server.ts), as the builder's tests build it. */
const session = (actor: EmployeeActor): EmployeeSession =>
  ({
    employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
    actor: { ...actor, permissions: new Set(actor.permissions) },
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + DAY, mfaOk: true },
  }) as unknown as EmployeeSession;
const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
};
const ctx = { locale: "ar" as const, now: NOW + 30 };

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (appError) return appError;
    throw error;
  }
  throw new Error("expected a failure");
}

/** A delivered, paid order of the customer. */
async function deliveredOrder(customerId: string, total = 100_000) {
  const product = await make.product({ priceIqd: total });
  return make.order([{ ...product, qty: 1, unitPriceIqd: total }], { customerId, status: "delivered", paymentStatus: "paid", paidIqd: total + 5000, placedAt: NOW - 3 * DAY, isDemo: false });
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

async function verifiedRequest(customerId: string, kind: "export" | "delete" | "unsubscribe") {
  const request = await createPrivacyRequest(t.db, as("manager"), { customerId, kind, idempotencyKey: randomToken() }, NOW);
  await verifyPrivacyRequest(t.db, as("manager"), { ref: request.ref, method: "in_store_id", note: "هوية في المحل" }, NOW);
  return request;
}

async function latestAnswer(subjectType: string, subjectId: string, kind: string) {
  return t.db
    .select()
    .from(consents)
    .where(and(eq(consents.subjectType, subjectType), eq(consents.subjectId, subjectId), eq(consents.kind, kind as "marketing")))
    .orderBy(desc(consents.at), desc(consents.id))
    .get();
}

// ───────────────────────────────────────────────────────────────── signed-in requests (route modules)

/** A signed-in employee (session cookie) with a built-in role. */
async function signedIn(role: DefaultRoleKey): Promise<string> {
  const password = "customers-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("rev")}@customers-review.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
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

/** Runs a loader inside the request middleware; returns what it returned or threw. */
async function run(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { headers: { cookie } });
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
/** Runs an action (a same-origin POST) inside the request middleware. */
async function runPost(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown, body: FormData): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: "POST", headers: { cookie, origin: ORIGIN }, body });
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
const statusOfResponse = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : undefined);

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

// ───────────────────────────────────────────────────────────────── field rules

describe("field rules", () => {
  test("the profile's activity sends wallet and consent events only to staff who may read those sections", async () => {
    const id = await make.customer({ name: "نشاط المحفظة" });
    await creditWallet(t.db, as("manager"), { customerId: id, amountIqd: 15_000, kind: "adjustment", reason: "تعويض عن تأخير الطلب السابق", idempotencyKey: `review:${randomToken()}` }, NOW);
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: id, kind: "marketing", granted: true, source: "checkout", at: NOW - DAY });
    await recordWithdrawal(t.db, as("manager"), { customerId: id, kind: "marketing", reason: "طلب بالهاتف إيقاف العروض" }, NOW);

    const cashier = await getCustomerProfile(t.db, as("cashier"), id, "ar", NOW);
    expect(cashier.wallet).toBeNull();
    expect(cashier.consents).toBeNull();
    const cashierActions = cashier.activity.map((event) => event.action);
    expect(cashierActions).not.toContain("customers.wallet.credit");
    expect(cashierActions).not.toContain("customers.consent.withdraw");
    expect(JSON.stringify(cashier)).not.toMatch(/تعويض عن تأخير|إيقاف العروض/);

    // a wallet reader sees the credit, not the consent; support reads consents, not wallets
    const walletReader = (await getCustomerProfile(t.db, custom(["customers.customer.read", "customers.wallet.read"]), id, "ar", NOW)).activity.map((event) => event.action);
    expect(walletReader).toContain("customers.wallet.credit");
    expect(walletReader).not.toContain("customers.consent.withdraw");
    const support = (await getCustomerProfile(t.db, as("support"), id, "ar", NOW)).activity.map((event) => event.action);
    expect(support).toContain("customers.consent.withdraw");
    expect(support).not.toContain("customers.wallet.credit");
    // audit.read (finance) reads the whole trail in module 21 anyway: everything
    const finance = (await getCustomerProfile(t.db, as("finance"), id, "ar", NOW)).activity.map((event) => event.action);
    expect(finance).toEqual(expect.arrayContaining(["customers.wallet.credit", "customers.consent.withdraw"]));
  });

  test("merge and erasure plans carry wallet balances only for staff who may read wallets", async () => {
    const email = `wallet-${randomToken(4).toLowerCase()}@tamtam.test`;
    const keep = await make.customer({ name: "الباقي", email });
    const dup = await make.customer({ name: "المكرر", email });
    await creditWallet(t.db, as("manager"), { customerId: dup, amountIqd: 7_350, kind: "adjustment", reason: "تعويض", idempotencyKey: `review:${randomToken()}` }, NOW);

    const mergeOnly = custom(["customers.customer.read", "customers.customer.merge"]);
    const plan = await planMerge(t.db, mergeOnly, { keepId: keep, mergeId: dup }, NOW);
    expect(plan.merge.walletIqd).toBeNull();
    expect(plan.keep.walletIqd).toBeNull();
    expect(plan.blockers).toEqual([{ code: "wallet_balance" }]);
    expect(JSON.stringify(plan)).not.toMatch(/7350|7,350/);
    const candidates = await duplicateCandidates(t.db, mergeOnly, keep);
    const candidate = candidates.find((row) => row.customer.id === dup);
    expect(candidate?.reasons).toContain("same_email");
    expect(candidate?.customer.walletIqd).toBeNull();
    // the same plan for someone who reads wallets: the amount, and the same fingerprint
    const managerPlan = await planMerge(t.db, as("manager"), { keepId: keep, mergeId: dup }, NOW);
    expect(managerPlan.merge.walletIqd).toBe(7_350);
    expect(managerPlan.blockers).toEqual([{ code: "wallet_balance", amount: 7_350 }]);
    expect(managerPlan.fingerprint).toBe(plan.fingerprint);

    // the erasure plan of that account, for a privacy handler who may not read wallets
    const request = await verifiedRequest(dup, "delete");
    const privacyOnly = custom(["customers.privacy.manage"]);
    const detail = await getPrivacyRequest(t.db, privacyOnly, request.ref, NOW);
    expect(detail.erasure?.blockers).toEqual([{ code: "wallet_balance", count: 1 }]);
    expect(JSON.stringify(detail)).not.toMatch(/7350/);
    expect((await getPrivacyRequest(t.db, as("manager"), request.ref, NOW)).erasure?.blockers).toEqual([{ code: "wallet_balance", count: 1, amountIqd: 7_350 }]);
  });

  test("a fraud reason never shows a typed phone number to staff without the full-phone permission; card numbers are refused", async () => {
    const id = await make.customer({ name: "سبب الاحتيال" });
    const card = await failureOf(setFraudFlag(t.db, as("manager"), { customerId: id, flagged: true, reason: "حوّل من بطاقة 4111 1111 1111 1111" }, NOW));
    expect(card.fields).toEqual({ reason: "note_has_card_number" });
    await setFraudFlag(t.db, as("manager"), { customerId: id, flagged: true, reason: "يطلب بالرقم 07701239876 نفسه من حسابين" }, NOW);
    const header = await customerHeader(t.db, as("cashier"), id, NOW);
    expect(header.fraudFlag).toBe(true);
    expect(header.fraudReason).toContain("•••");
    expect(JSON.stringify(header)).not.toMatch(/1239876/);
    const list = await listCustomers(t.db, as("cashier"), parseCustomerFilters(new URLSearchParams(`q=${id}`)), NOW);
    expect(list.rows.map((row) => row.id)).toEqual([id]);
    expect(JSON.stringify(list.rows)).not.toMatch(/1239876/);
  });
});

// ───────────────────────────────────────────────────────────────── merge integrity

describe("merge keeps the labels that protect the store", () => {
  const verification = { method: "call_both_numbers" as const, verification: "اتصلت بالرقمين وأكد صاحبهما", reason: "حساب مكرر" };

  test("a blocked or fraud-flagged duplicate is not folded into a clean account; the other way round works", async () => {
    const keep = await make.customer({ name: "حساب سليم" });
    const blocked = await make.customer({ name: "حساب محظور", status: "blocked" });
    const plan = await planMerge(t.db, as("manager"), { keepId: keep, mergeId: blocked }, NOW);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain("duplicate_blocked");
    expect((await failureOf(mergeCustomers(t.db, as("manager"), { keepId: keep, mergeId: blocked, ...verification, fingerprint: plan.fingerprint }, NOW))).code).toBe("merge_blocked");
    expect((await t.db.select().from(customers).where(eq(customers.id, blocked)).get())?.status).toBe("blocked");
    // keeping the blocked account keeps the block
    expect((await planMerge(t.db, as("manager"), { keepId: blocked, mergeId: keep }, NOW)).blockers).toEqual([]);

    const clean = await make.customer({ name: "حساب بلا وسم" });
    const flagged = await make.customer({ name: "حساب موسوم", fraudFlag: true, fraudReason: "إثباتات تحويل مكررة" });
    const flaggedPlan = await planMerge(t.db, as("manager"), { keepId: clean, mergeId: flagged }, NOW);
    expect(flaggedPlan.blockers.map((blocker) => blocker.code)).toContain("duplicate_flagged");
    // once the kept account carries the flag (a person decided, with a reason), the merge may go ahead
    await setFraudFlag(t.db, as("manager"), { customerId: clean, flagged: true, reason: "نفس الشخص الموسوم على حسابه الآخر" }, NOW);
    const ready = await planMerge(t.db, as("manager"), { keepId: clean, mergeId: flagged }, NOW);
    expect(ready.blockers).toEqual([]);
    expect(await mergeCustomers(t.db, as("manager"), { keepId: clean, mergeId: flagged, ...verification, fingerprint: ready.fingerprint }, NOW)).toMatchObject({ replayed: false });
  });

  test("race: the duplicate is blocked just before the merge's batch — the merge is refused and the block stays", async () => {
    const keep = await make.customer({ name: "باقٍ في سباق" });
    const dup = await make.customer({ name: "مكرر في سباق" });
    await deliveredOrder(dup);
    const plan = await planMerge(t.db, as("manager"), { keepId: keep, mergeId: dup }, NOW);
    expect(plan.blockers).toEqual([]);
    const racing = beforeBatch(t.db, 1, () => t.db.update(customers).set({ status: "blocked", updatedAt: NOW + 1 }).where(eq(customers.id, dup)));
    expect((await failureOf(mergeCustomers(racing, as("manager"), { keepId: keep, mergeId: dup, ...verification, fingerprint: plan.fingerprint }, NOW))).code).toBe("merge_blocked");
    expect(await t.db.select({ status: customers.status, mergedIntoId: customers.mergedIntoId }).from(customers).where(eq(customers.id, dup)).get()).toEqual({ status: "blocked", mergedIntoId: null });
  });
});

// ───────────────────────────────────────────────────────────────── erasure

describe("erasure (07.04)", () => {
  test("race: a return or a repair opened just before the erasure's batch stops it", async () => {
    for (const open of ["return", "repair"] as const) {
      const id = await make.customer({ name: `حذف مع ${open}` });
      const order = await deliveredOrder(id);
      const request = await verifiedRequest(id, "delete");
      expect((await getPrivacyRequest(t.db, as("manager"), request.ref, NOW)).can.erase).toBe(true);
      const racing = beforeBatch(t.db, 1, () =>
        open === "return"
          ? t.db.insert(returns).values({ id: newId("ret"), rma: `RMA-${randomToken(5).toUpperCase()}`, orderId: order.orderId, customerId: id, status: "requested", createdAt: NOW })
          : t.db.insert(repairTickets).values({ id: newId("rep"), ref: `RP-${randomToken(5).toUpperCase()}`, customerId: id, phoneE164: "+9647700000099", issue: "لا يشحن", status: "received", createdAt: NOW }),
      );
      expect((await failureOf(executeErasure(racing, as("manager"), { ref: request.ref, reason: "طلب حذف موثّق" }, NOW))).code, open).toBe("erasure_blocked");
      expect((await t.db.select().from(customers).where(eq(customers.id, id)).get())?.status, open).toBe("active");
    }
  });

  test("the person's checkout answers as a guest, the guest contact's name and the browsing signals go too (and the plan says so)", async () => {
    const phone = "+9647812340022";
    const id = await make.customer({ phoneE164: phone, name: "اشترى كزائر ثم سجّل" });
    const guestId = newId("gst");
    await t.db.insert(guestContacts).values({ id: guestId, phoneE164: phone, name: "اشترى كزائر ثم سجّل", createdAt: NOW - 40 * DAY, customerId: id });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "guest_contact", subjectId: guestId, kind: "marketing", granted: true, source: "checkout", at: NOW - 40 * DAY });
    const product = await make.product();
    await t.db.insert(recommendationEvents).values({ id: newId("rce"), customerId: id, kind: "view", productId: product.productId, at: NOW - DAY });
    const request = await verifiedRequest(id, "delete");
    const plan = (await getPrivacyRequest(t.db, as("manager"), request.ref, NOW)).erasure;
    expect(plan?.erased).toMatchObject({ guestContacts: 1, browsing: 1 });

    await executeErasure(t.db, as("manager"), { ref: request.ref, reason: "طلب حذف موثّق" }, NOW);
    expect(await latestAnswer("guest_contact", guestId, "marketing")).toMatchObject({ granted: false, source: "erasure" });
    expect((await t.db.select().from(guestContacts).where(eq(guestContacts.id, guestId)).get())?.name).toBeNull();
    expect(await t.db.select().from(recommendationEvents).where(eq(recommendationEvents.customerId, id)).all()).toEqual([]);
    expect((await t.db.select().from(customers).where(eq(customers.id, id)).get())?.phoneE164).toBe(erasedPhone(id));
  });

  test("erasing an account also anonymizes the duplicates that were merged into it (the same person)", async () => {
    const keep = await make.customer({ name: "الحساب الباقي للحذف", email: `keep-${randomToken(4).toLowerCase()}@tamtam.test` });
    const dupPhone = "+9647812340044";
    const dup = await make.customer({ name: "الحساب المدموج للحذف", email: `dup-${randomToken(4).toLowerCase()}@tamtam.test`, phoneE164: dupPhone, notes: "ملاحظة قديمة عن العميل" });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: dup, kind: "marketing", granted: true, source: "checkout", at: NOW - 30 * DAY });
    const dupGuest = newId("gst");
    await t.db.insert(guestContacts).values({ id: dupGuest, phoneE164: dupPhone, name: "الحساب المدموج للحذف", createdAt: NOW - 60 * DAY });
    const plan = await planMerge(t.db, as("manager"), { keepId: keep, mergeId: dup }, NOW);
    await mergeCustomers(t.db, as("manager"), { keepId: keep, mergeId: dup, method: "in_store_id", verification: "هوية في المحل للحسابين", reason: "حساب مكرر", fingerprint: plan.fingerprint }, NOW);
    const request = await verifiedRequest(keep, "delete");
    expect((await getPrivacyRequest(t.db, as("manager"), request.ref, NOW)).erasure?.erased).toMatchObject({ mergedAccounts: 1, guestContacts: 1 });
    await executeErasure(t.db, as("manager"), { ref: request.ref, reason: "طلب حذف موثّق" }, NOW);
    const row = await t.db.select().from(customers).where(eq(customers.id, dup)).get();
    expect(row).toMatchObject({ name: null, email: null, notes: null, status: "merged", mergedIntoId: keep, phoneE164: erasedPhone(dup) });
    expect(row?.anonymizedAt).toBe(NOW);
    expect(await latestAnswer("customer", dup, "marketing")).toMatchObject({ granted: false, source: "erasure" });
    expect((await t.db.select().from(guestContacts).where(eq(guestContacts.id, dupGuest)).get())?.name).toBeNull();
  });

  test("an erased account takes no new consent rows", async () => {
    const id = newId("cus");
    await make.customer({ id, status: "deleted", name: null, phoneE164: erasedPhone(id), anonymizedAt: NOW - DAY });
    expect((await failureOf(recordWithdrawal(t.db, as("manager"), { customerId: id, kind: "analytics", reason: "طلب بالهاتف" }, NOW))).code).toBe("customer_unavailable");
    expect(await t.db.select().from(consents).where(eq(consents.subjectId, id)).all()).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────── unsubscribe and export

describe("unsubscribe and export (07.04)", () => {
  test("an account's unsubscribe also withdraws what it said at checkout as a guest", async () => {
    const phone = "+9647812340033";
    const id = await make.customer({ phoneE164: phone, name: "يلغي الاشتراك" });
    const guestId = newId("gst");
    await t.db.insert(guestContacts).values({ id: guestId, phoneE164: phone, name: "يلغي الاشتراك", createdAt: NOW - 20 * DAY, customerId: id });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "guest_contact", subjectId: guestId, kind: "marketing", granted: true, source: "checkout", at: NOW - 20 * DAY });
    const request = await verifiedRequest(id, "unsubscribe");
    expect(await executeUnsubscribe(t.db, as("manager"), { ref: request.ref, kinds: ["marketing"], note: "طلب إيقاف العروض" }, NOW)).toEqual({ withdrawn: ["marketing"] });
    expect(await latestAnswer("guest_contact", guestId, "marketing")).toMatchObject({ granted: false, source: "privacy_request" });
    expect(await latestAnswer("customer", id, "marketing")).toMatchObject({ granted: false });
  });

  test("a visitor's number holds one open unsubscribe request at a time", async () => {
    await createPrivacyRequest(t.db, as("manager"), { phone: "07505550099", kind: "unsubscribe", idempotencyKey: randomToken() }, NOW);
    expect((await failureOf(createPrivacyRequest(t.db, as("manager"), { phone: "٠٧٥٠٥٥٥٠٠٩٩", kind: "unsubscribe", idempotencyKey: randomToken() }, NOW))).code).toBe("privacy_open_exists");
    expect((await t.db.select().from(privacyRequests).where(eq(privacyRequests.phoneE164, "+9647505550099")).all()).length).toBe(1);
  });

  test("a finished export request hands out no new copy of the file (service and route); staff's cancel reasons stay out", async () => {
    const id = await make.customer({ name: "نسخة واحدة" });
    await deliveredOrder(id);
    const product = await make.product({ priceIqd: 40_000 });
    await make.order([{ ...product, qty: 1, unitPriceIqd: 40_000 }], { customerId: id, status: "cancelled", cancelledAt: NOW - DAY, cancelReason: "اشتباه احتيال: إثبات معدّل", placedAt: NOW - 2 * DAY, isDemo: false });
    const request = await verifiedRequest(id, "export");
    const file = await buildPrivacyExport(t.db, as("manager"), request.ref, NOW);
    expect(JSON.parse(file.body).orders.length).toBe(2);
    expect(file.body).not.toMatch(/اشتباه احتيال|cancel_reason/);
    await completePrivacyRequest(t.db, as("manager"), { ref: request.ref, note: "سُلّم الملف في المحل" }, NOW);
    expect((await getPrivacyRequest(t.db, as("manager"), request.ref, NOW)).can.export).toBe(false);
    expect((await failureOf(buildPrivacyExport(t.db, as("manager"), request.ref, NOW))).code).toBe("privacy_not_open");
    const cookie = await signedIn("owner");
    const response = await run(cookie, `/admin/customers/privacy/${request.ref}/export`, { ref: request.ref }, privacyExportLoader as never);
    expect(statusOfResponse(response)).toBe(404);
    // a role without the permission still gets 403 (not 404, not 500)
    const cashier = await signedIn("cashier");
    expect(statusOfResponse(await run(cashier, `/admin/customers/privacy/${request.ref}/export`, { ref: request.ref }, privacyExportLoader as never))).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────── addresses

describe("addresses (07.03)", () => {
  test("race: an address saved just before the batch cannot push the customer past the limit", async () => {
    const id = await make.customer({ name: "عناوين كثيرة" });
    const baghdad = governorateId("baghdad");
    await t.db.insert(addresses).values(Array.from({ length: MAX_CUSTOMER_ADDRESSES - 1 }, (_, index) => ({ id: newId("adr"), customerId: id, governorateId: baghdad, areaText: "الكرادة", addressText: `عنوان رقم ${index + 1} قرب الجسر`, isDefault: index === 0 })));
    const racing = beforeBatch(t.db, 1, () => t.db.insert(addresses).values({ id: newId("adr"), customerId: id, governorateId: baghdad, areaText: "المنصور", addressText: "عنوان أضافه موظف آخر الآن", isDefault: false }));
    const failure = await failureOf(saveCustomerAddress(racing, as("manager"), { customerId: id, governorateId: baghdad, areaText: "الجادرية", addressText: "عنوان جديد بعد الحد", reason: "طلب العميل" }, NOW));
    expect(failure.code).toBe("address_limit");
    expect((await t.db.select().from(addresses).where(eq(addresses.customerId, id)).all()).length).toBe(MAX_CUSTOMER_ADDRESSES);
  });

  test("a form read before someone else's change is refused: channels and addresses too, not only the details", async () => {
    const id = await make.customer({ name: "نموذج قديم", updatedAt: NOW });
    const baghdad = governorateId("baghdad");
    const saved = await saveCustomerAddress(t.db, as("manager"), { customerId: id, governorateId: baghdad, areaText: "الكرادة", addressText: "شارع 62 قرب الجسر", reason: "طلب العميل" }, NOW);
    const view = await getContactView(t.db, as("manager"), id, "ar");
    const address = view.addresses.find((row) => row.id === saved.id);
    expect(typeof address?.updatedAt).toBe("number");
    const stale = { channels: String(view.updatedAt), address: String(address?.updatedAt) };
    // someone else changes the channels and the address meanwhile
    await setCustomerChannels(t.db, as("owner"), { customerId: id, sms: true, whatsapp: false, email: false, reason: "طلب العميل بالهاتف", expectedUpdatedAt: stale.channels }, NOW + 10);
    await saveCustomerAddress(t.db, as("owner"), { customerId: id, id: saved.id, governorateId: baghdad, areaText: "الكرادة", addressText: "شارع 62 قرب الجسر، الطابق 3", reason: "تصحيح", expectedUpdatedAt: stale.address }, NOW + 10);
    // the first employee's forms, still showing the old values, are refused through the page's action
    const manager = session(as("manager"));
    expect(await contactAction(ctx, t.db, manager, id, form({ intent: "channels", whatsapp: "on", reason: "من النموذج القديم", expectedUpdatedAt: stale.channels }))).toMatchObject({ ok: false, code: "customer_changed", status: 409 });
    expect(await contactAction(ctx, t.db, manager, id, form({ intent: "address-save", id: saved.id, governorateId: baghdad, areaText: "الكرادة", addressText: "عنوان من النموذج القديم", reason: "تصحيح", expectedUpdatedAt: stale.address }))).toMatchObject({ ok: false, code: "customer_changed", status: 409 });
    expect(await contactAction(ctx, t.db, manager, id, form({ intent: "address-delete", addressId: saved.id, reason: "حذف من النموذج القديم", expectedUpdatedAt: stale.address }))).toMatchObject({ ok: false, code: "customer_changed", status: 409 });
    const row = await t.db.select().from(addresses).where(eq(addresses.id, saved.id)).get();
    expect(row?.addressText).toBe("شارع 62 قرب الجسر، الطابق 3");
    expect((await t.db.select().from(customers).where(eq(customers.id, id)).get())?.notificationPrefs).toMatchObject({ sms: true, whatsapp: false });
  });

  test("race: two first addresses saved at once leave one default", async () => {
    const id = await make.customer({ name: "أول عنوان" });
    const baghdad = governorateId("baghdad");
    const racing = beforeBatch(t.db, 1, () => t.db.insert(addresses).values({ id: newId("adr"), customerId: id, governorateId: baghdad, areaText: "الكرادة", addressText: "عنوان أضافه العميل الآن", isDefault: true }));
    await saveCustomerAddress(racing, as("manager"), { customerId: id, governorateId: baghdad, areaText: "الجادرية", addressText: "عنوان أضافه الموظف", reason: "طلب العميل" }, NOW);
    const rows = await t.db.select().from(addresses).where(eq(addresses.customerId, id)).all();
    expect(rows.length).toBe(2);
    expect(rows.filter((row) => row.isDefault).length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── every page, every role (a guard: no 500 anywhere)

describe("route answers", () => {
  test("every loader answers 200, 403 or 404 for each role — never a crash — and forbidden intents get 403", async () => {
    const id = await make.customer({ name: "جولة الصفحات", email: `sweep-${randomToken(4).toLowerCase()}@tamtam.test` });
    await deliveredOrder(id);
    const request = await verifiedRequest(id, "export");
    const pages = {
      index: { path: "/admin/customers", params: {}, module: await import("~/routes/admin/customers/index") },
      export: { path: "/admin/customers/export", params: {}, module: await import("~/routes/admin/customers/export") },
      segments: { path: "/admin/customers/segments", params: {}, module: await import("~/routes/admin/customers/segments") },
      consents: { path: "/admin/customers/consents", params: {}, module: await import("~/routes/admin/customers/consents") },
      privacy: { path: "/admin/customers/privacy", params: {}, module: await import("~/routes/admin/customers/privacy") },
      request: { path: `/admin/customers/privacy/${request.ref}`, params: { ref: request.ref }, module: await import("~/routes/admin/customers/privacy-request") },
      duplicates: { path: "/admin/customers/duplicates", params: {}, module: await import("~/routes/admin/customers/duplicates") },
      layout: { path: `/admin/customers/${id}`, params: { customerId: id }, module: await import("~/routes/admin/customers/customer-layout") },
      profile: { path: `/admin/customers/${id}`, params: { customerId: id }, module: await import("~/routes/admin/customers/customer") },
      contact: { path: `/admin/customers/${id}/contact`, params: { customerId: id }, module: await import("~/routes/admin/customers/contact") },
      consentsOf: { path: `/admin/customers/${id}/privacy`, params: { customerId: id }, module: await import("~/routes/admin/customers/customer-privacy") },
      messages: { path: `/admin/customers/${id}/messages`, params: { customerId: id }, module: await import("~/routes/admin/customers/customer-messages") },
      merge: { path: `/admin/customers/${id}/merge?with=${id}x`, params: { customerId: id }, module: await import("~/routes/admin/customers/customer-merge") },
      unknown: { path: "/admin/customers/cus_nobody_here", params: { customerId: "cus_nobody_here" }, module: await import("~/routes/admin/customers/customer") },
    } as const;
    const expected: Record<"owner" | "support" | "cashier" | "finance", Record<keyof typeof pages, number>> = {
      owner: { index: 200, export: 200, segments: 200, consents: 200, privacy: 200, request: 200, duplicates: 200, layout: 200, profile: 200, contact: 200, consentsOf: 200, messages: 200, merge: 404, unknown: 404 },
      support: { index: 200, export: 403, segments: 200, consents: 200, privacy: 403, request: 403, duplicates: 403, layout: 200, profile: 200, contact: 200, consentsOf: 200, messages: 200, merge: 403, unknown: 404 },
      cashier: { index: 200, export: 403, segments: 200, consents: 403, privacy: 403, request: 403, duplicates: 403, layout: 200, profile: 200, contact: 200, consentsOf: 403, messages: 403, merge: 403, unknown: 404 },
      finance: { index: 200, export: 403, segments: 200, consents: 403, privacy: 403, request: 403, duplicates: 403, layout: 200, profile: 200, contact: 200, consentsOf: 403, messages: 403, merge: 403, unknown: 404 },
    };
    for (const role of ["owner", "support", "cashier", "finance"] as const) {
      const cookie = await signedIn(role);
      for (const [name, page] of Object.entries(pages) as [keyof typeof pages, (typeof pages)[keyof typeof pages]][]) {
        const out = await run(cookie, page.path, page.params, page.module.loader as never);
        const status = statusOfResponse(out) ?? (out instanceof Error ? 500 : 200);
        expect(status, `${role} ${name}`).toBe(expected[role][name]);
      }
      // a forbidden intent is a 403 before anything is read or parsed
      const post = await runPost(cookie, `/admin/customers/${id}`, { customerId: id }, pages.profile.module.action as never, form({ intent: "block", blocked: "1" }));
      expect(statusOfResponse(post), `${role} block`).toBe(role === "owner" ? 400 : 403);
    }
  });
});

// ───────────────────────────────────────────────────────────────── honesty

describe("blueprint status", () => {
  test("07.04 is partial while a deletion request of a customer holding wallet money cannot be completed in the admin", async () => {
    const id = await make.customer({ name: "في محفظته رصيد" });
    await creditWallet(t.db, as("manager"), { customerId: id, amountIqd: 5_000, kind: "adjustment", reason: "تعويض", idempotencyKey: `review:${randomToken()}` }, NOW);
    const request = await verifiedRequest(id, "delete");
    // refused for the money, and no admin service can pay a wallet out (adjustments are credits, min 1 IQD)
    expect((await failureOf(executeErasure(t.db, as("owner"), { ref: request.ref, reason: "طلب حذف" }, NOW))).code).toBe("erasure_blocked");
    expect(statusOf("07.04").status).toBe("partial");
    expect(statusOf("07.04").note?.en).toMatch(/wallet/i);
  });
});
