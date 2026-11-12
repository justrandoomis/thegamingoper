/**
 * The integration pass after admin wave C (2026-11-11): what the finished modules take from each other — settings that
 * replaced module constants (shipping's guarded fee changes, pricing's cut limit in its words, returns' service
 * targets, the POS discount limit), the home counts the bell shares (finance's expenses, shipping's settlements,
 * returns' queues), and customer names that open the customer's profile for staff who may open it.
 *
 * Real local D1 (tests/helpers/db.ts); services first, the pages' loaders where the page itself is the contract.
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import pricingMessages from "~/i18n/messages/admin-pricing";
import settingsMessages from "~/i18n/messages/admin-settings";
import { translate, type MessageTree } from "~/i18n/translate";
import { loader as financeHomeLoader } from "~/routes/admin/finance/index";
import { loader as topupPageLoader } from "~/routes/admin/finance/topup";
import { loader as walletPageLoader } from "~/routes/admin/finance/wallet";
import { loader as pricingLayoutLoader } from "~/routes/admin/pricing/layout";
import { loader as returnsHomeLoader } from "~/routes/admin/returns/index";
import { loader as quarantineLoader } from "~/routes/admin/returns/quarantine";
import { queueHref } from "~/routes/admin/shell/queues.server";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import { signInEmployee } from "~/server/auth/admin.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { createDb } from "~/server/db/drizzle.server";
import { carriers, codSettlementItems, codSettlements, employeeRoles, fiscalPeriods, repairTickets, returns, rolePermissions, roles, shipments, walletTopups, warranties } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { createExpense } from "~/server/services/accounting/expenses.server";
import { countDecidableExpenses } from "~/server/services/admin/finance/expense-views.server";
import { getOrderDetail } from "~/server/services/admin/orders/detail.server";
import { listOrders } from "~/server/services/admin/orders/list.server";
import { getProofReview } from "~/server/services/admin/orders/queues.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { getRepair, listRepairs } from "~/server/services/admin/returns/repair.server";
import { getReturnDetail, listReturns, queueCounts as returnsQueueCounts } from "~/server/services/admin/returns/rma.server";
import { parseRepairFilters, parseRmaFilters, parseWarrantyFilters } from "~/server/services/admin/returns/types";
import { getWarranty, listWarranties } from "~/server/services/admin/returns/warranty.server";
import { toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { getSetting, setSetting, SETTING_KEYS } from "~/server/settings.server";
import { countSettlementsToReconcile } from "~/server/services/admin/shipping/cod.server";
import { shippingOverview } from "~/server/services/admin/shipping/shipments.server";
import { setFlatFee, setOverridesEnabled } from "~/server/services/admin/shipping/zones.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;

let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

const actorWith = async (permissions: readonly Permission[]): Promise<EmployeeActor> => ({ kind: "employee", id: await make.employee(), permissions });

// ───────────────────────────────────────────────────────────────── signed-in pages

let signIns = 0;

/** A request context as the root middleware builds it (the real clock: the pages below run behind that middleware). */
function requestCtx(setCookie: (serialized: string) => void = () => undefined): RequestCtx {
  const n = ++signIns;
  return {
    requestId: `integration-${n}`,
    nonce: "test-nonce",
    origin: "http://localhost:5173",
    isHttps: false,
    isDev: true,
    now: Date.now(),
    // one address per sign-in: the per-address sign-in limit is not what these tests are about
    ip: `203.0.113.${n % 250}`,
    country: "IQ",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie,
  };
}

type Signed = { id: string; actor: EmployeeActor; cookies: Record<string, string> };

/** An employee whose one role grants exactly these permissions (a role made in the editor), signed in. */
async function signedInWith(permissions: readonly Permission[]): Promise<Signed> {
  const password = "integration-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("int")}@integration.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  const role = `rol_${make.next("int").replace(/[^a-z0-9]/gi, "_")}`;
  await t.db.insert(roles).values({ id: role, key: role, name: { ar: "دور للاختبار", en: "Test role" }, createdAt: NOW });
  await t.db.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: role, permission })));
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
  const set: string[] = [];
  const result = await signInEmployee(requestCtx((serialized) => set.push(serialized)), t.db, { email, password });
  if (result.status !== "signed_in") throw new Error(`expected a full sign-in, got ${result.status}`);
  const cookies: Record<string, string> = {};
  for (const serialized of set) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    cookies[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1));
  }
  return { id, actor: result.session.actor, cookies };
}

type PageLoader = (args: never) => Promise<unknown>;

/** A page's loader for a signed-in employee, behind the real root middleware: its data, or the status it refused with. */
async function openPage(loader: PageLoader, path: string, who: Signed, params: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
  const cookie = Object.entries(who.cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  const request = new Request(`http://localhost:5173${path}`, { headers: { Cookie: cookie } });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let data: unknown = null;
  try {
    const response = await requestContextMiddleware({ request, context, url, pattern: "/", params: {} }, async () => {
      data = await loader({ request, context, params, url, pattern: url.pathname } as never);
      return new Response(null);
    });
    return { status: (response as Response).status, data };
  } catch (error) {
    if (error instanceof Response) return { status: error.status, data: null };
    const init = (error as { type?: string; init?: { status?: number } }) ?? {};
    if (init.type === "DataWithResponseInit") return { status: init.init?.status ?? 500, data: null };
    throw error;
  }
}

const dig = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined), value);

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to fail, but it succeeded");
}

/**
 * A D1 binding on which `meanwhile` runs once, right before the first statement with this exact SQL text and this bound
 * value: another person's change landing between a service's read of the screen's state and its own write.
 */
function racingD1(real: D1Database, sqlText: string, value: unknown, meanwhile: () => Promise<unknown>): D1Database {
  const REAL = Symbol("the real statement");
  let fired = false;
  const before = async (hit: boolean) => {
    if (hit && !fired) {
      fired = true;
      await meanwhile();
    }
  };
  const wrap = (statement: D1PreparedStatement, text: string, params: unknown[]): D1PreparedStatement => {
    const hit = text === sqlText && params.includes(value);
    return {
      [REAL]: statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values), text, values),
      all: async () => (await before(hit), statement.all()),
      raw: async (options?: { columnNames?: boolean }) => (await before(hit), (statement.raw as (options?: { columnNames?: boolean }) => Promise<unknown>)(options)),
      first: async (column?: string) => (await before(hit), column === undefined ? statement.first() : statement.first(column)),
      run: async () => (await before(hit), statement.run()),
    } as unknown as D1PreparedStatement;
  };
  const unwrap = (statement: D1PreparedStatement) => (statement as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? statement;
  return {
    prepare: (text: string) => wrap(real.prepare(text), text, []),
    batch: (statements: D1PreparedStatement[]) => real.batch(statements.map(unwrap)),
    exec: (text: string) => real.exec(text),
  } as unknown as D1Database;
}

/** What setSetting reads once, right before it compares with `expected` and builds its batch. */
const SETTING_READ = "SELECT value FROM settings WHERE key = ?";

/** A D1 binding that counts the statements sent through it (a batch counts once). */
function countingD1(real: D1Database): { d1: D1Database; statements: () => number } {
  const REAL = Symbol("the real statement");
  let sent = 0;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    ({
      [REAL]: statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: () => (sent++, statement.all()),
      raw: (options?: { columnNames?: boolean }) => (sent++, (statement.raw as (options?: { columnNames?: boolean }) => Promise<unknown>)(options)),
      first: (column?: string) => (sent++, column === undefined ? statement.first() : statement.first(column)),
      run: () => (sent++, statement.run()),
    }) as unknown as D1PreparedStatement;
  const unwrap = (statement: D1PreparedStatement) => (statement as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? statement;
  const d1 = {
    prepare: (text: string) => wrap(real.prepare(text)),
    batch: (statements: D1PreparedStatement[]) => (sent++, real.batch(statements.map(unwrap))),
    exec: (text: string) => real.exec(text),
  } as unknown as D1Database;
  return { d1, statements: () => sent };
}

// ───────────────────────────────────────────────────────────────── shipping 11: the fee is changed on what was seen

describe("shipping: the delivery fee and the per-governorate switch change only from the value the person saw", () => {
  test("a change landing between the page's read and the save is never overwritten (setSetting { expected }, inside the batch)", async () => {
    const manager = await actorWith(["settings.shipping.manage", "shipping.rate.manage", "shipping.zone.manage"]);
    const otherTab = systemActor("test.other-tab");

    const fee = await getSetting(t.db, "shipping.flat_fee_iqd");
    const feeRace = createDb(racingD1(t.d1, SETTING_READ, "shipping.flat_fee_iqd", () => setSetting(t.db, otherTab, "shipping.flat_fee_iqd", fee + 2000, "تغيير من نافذة أخرى", NOW)));
    expect(toAppError(await thrown(() => setFlatFee(feeRace, manager, { feeIqd: fee + 1000, expectedFeeIqd: fee, reason: "كلفة الشركة ارتفعت" }, NOW)))).toMatchObject({ code: "fee_changed", status: 409 });
    expect(await getSetting(t.db, "shipping.flat_fee_iqd")).toBe(fee + 2000);

    const switched = await getSetting(t.db, "shipping.overrides_enabled");
    const switchRace = createDb(racingD1(t.d1, SETTING_READ, "shipping.overrides_enabled", () => setSetting(t.db, otherTab, "shipping.overrides_enabled", !switched, "تغيير من نافذة أخرى", NOW)));
    // The other tab switched it already; this one saw the old state and asks for the same new one — "already done" is not
    // an answer the person can trust here (their impact preview was of the old state), so it is refused too.
    expect(toAppError(await thrown(() => setOverridesEnabled(switchRace, manager, { enabled: !switched, expected: switched, reason: "تفعيل رسوم المحافظات" }, NOW)))).toMatchObject({ code: "fee_changed", status: 409 });
    expect(await getSetting(t.db, "shipping.overrides_enabled")).toBe(!switched);

    // Without a race both still work, from the value in force.
    const now = await getSetting(t.db, "shipping.flat_fee_iqd");
    expect((await setFlatFee(t.db, manager, { feeIqd: now - 1000, expectedFeeIqd: now, reason: "العودة إلى الرسم السابق" }, NOW)).replayed).toBe(false);
    expect(await getSetting(t.db, "shipping.flat_fee_iqd")).toBe(now - 1000);
  });

  test("the shipping home counts the settlements to reconcile as the bell does: one query, and not one carrying cash for who may not record it", async () => {
    const preparer = await actorWith(["shipping.cod.settle", "shipping.shipment.read", "orders.payment.record"]);
    const bookkeeper = await actorWith(["shipping.cod.settle", "shipping.shipment.read", "orders.payment.record"]);
    // settles carriers' cash without the right to record a cash-on-delivery payment
    const clerk = await actorWith(["shipping.cod.settle", "shipping.shipment.read"]);
    const tag = make.next("cod").replace(/[^a-z0-9]/gi, "_");
    await t.db.insert(carriers).values({ id: `car_${tag}`, code: `CAR-${tag}`, name: "شركة شحن للاختبار", createdAt: NOW });
    const product = await make.product({ priceIqd: 70_000, stock: 3 });
    const cash = await make.order([{ ...product, qty: 1 }], { paymentMethod: "cod" });
    await make.payment(cash.orderId, cash.totalIqd, { method: "cod", status: "pending" });
    await t.db.insert(shipments).values({ id: `shp_${tag}_cash`, orderId: cash.orderId, carrierId: `car_${tag}`, status: "delivered", deliveredAt: NOW, createdAt: NOW, updatedAt: NOW });
    const settlement = (suffix: string, extra: Partial<typeof codSettlements.$inferInsert> = {}) => ({ id: `cod_${tag}_${suffix}`, ref: `COD-${tag}-${suffix}`.toUpperCase(), carrierId: `car_${tag}`, status: "submitted" as const, createdBy: preparer.id, createdAt: NOW, ...extra });
    await t.db.insert(codSettlements).values([settlement("cash", { expectedIqd: cash.totalIqd, receivedIqd: cash.totalIqd }), settlement("fees", { feesIqd: 2000, receivedIqd: -2000 })]);
    await t.db.insert(codSettlementItems).values({ settlementId: `cod_${tag}_cash`, shipmentId: `shp_${tag}_cash`, amountIqd: cash.totalIqd, feeIqd: 0 });
    for (const suffix of ["cash", "fees"]) await audit(t.db, { actor: preparer, action: "shipping.cod.submit", entityType: "cod_settlement", entityId: `cod_${tag}_${suffix}`, at: NOW });

    for (const who of [bookkeeper, clerk]) expect((await shippingOverview(t.db, who, NOW)).toReconcile, who.id).toBe(await countSettlementsToReconcile(t.db, who));
    const clerkCount = (await shippingOverview(t.db, clerk, NOW)).toReconcile;
    expect((await shippingOverview(t.db, bookkeeper, NOW)).toReconcile - clerkCount).toBe(1);

    // However many settlements wait, the home reads them with the same statements.
    const counting = countingD1(t.d1);
    await shippingOverview(createDb(counting.d1), bookkeeper, NOW);
    const before = counting.statements();
    await t.db.insert(codSettlements).values(Array.from({ length: 8 }, (_, i) => settlement(`more${i}`)));
    for (let i = 0; i < 8; i++) await audit(t.db, { actor: preparer, action: "shipping.cod.submit", entityType: "cod_settlement", entityId: `cod_${tag}_more${i}`, at: NOW });
    const again = countingD1(t.d1);
    await shippingOverview(createDb(again.d1), bookkeeper, NOW);
    expect(again.statements()).toBe(before);
  });
});

// ───────────────────────────────────────────────────────────────── returns 12: targets and queues

describe("returns: the service targets are the setting's, and the list's queues are counted only for who may open the list", () => {
  test("the RMA home and the quarantine page name the targets in force (setting returns.sla), not the module's constants", async () => {
    await setSetting(t.db, systemActor("test.settings"), "returns.sla", { decision_hours: 24, inspection_hours: 36, repair_days: 5, quarantine_days: 21, warranty_ending_days: 45 }, "أهداف خدمة جديدة", NOW);
    const clerk = await signedInWith(["returns.rma.read", "returns.rma.inspect", "returns.warranty.read"]);
    const home = await openPage(returnsHomeLoader, "/admin/returns", clerk);
    expect(home.status).toBe(200);
    expect(dig(home.data, "sla")).toMatchObject({ warrantyEndingDays: 45, quarantineDays: 21, decisionHours: 24 });
    const quarantine = await openPage(quarantineLoader, "/admin/returns/quarantine", clerk);
    expect(quarantine.status).toBe(200);
    expect(dig(quarantine.data, "sla")).toMatchObject({ quarantineDays: 21 });
  });

  test("the RMAs to decide, receive and inspect count only for staff who hold returns.rma.read (without it the list shows only their own)", async () => {
    const product = await make.product({ priceIqd: 50_000, stock: 2 });
    const order = await make.order([{ ...product, qty: 1 }]);
    const tag = make.next("ret").replace(/[^a-z0-9]/gi, "").toUpperCase();
    await t.db.insert(returns).values([
      { id: `ret_${tag}_ask`, rma: `RMA-${tag}A`, orderId: order.orderId, status: "requested", createdAt: NOW },
      { id: `ret_${tag}_way`, rma: `RMA-${tag}B`, orderId: order.orderId, status: "approved", createdAt: NOW },
      { id: `ret_${tag}_back`, rma: `RMA-${tag}C`, orderId: order.orderId, status: "received", receivedAt: NOW, createdAt: NOW },
    ]);
    const deciding = ["returns.rma.approve", "returns.rma.inspect"] as const;
    const blind = await returnsQueueCounts(t.db, await actorWith([...deciding, "returns.rma.create"]), NOW);
    expect(blind).toMatchObject({ decide: null, receive: null, inspect: null });
    const reading = await returnsQueueCounts(t.db, await actorWith([...deciding, "returns.rma.read"]), NOW);
    expect(reading.decide).toBeGreaterThanOrEqual(1);
    expect(reading.receive).toBeGreaterThanOrEqual(1);
    expect(reading.inspect).toBeGreaterThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────── pricing 03: the cut limit in words

describe("pricing: the words that name the cut limit say the setting's value, not a fixed 10 %", () => {
  test("drop_over_limit and the used devices' lead take the limit in force, which the module's frame sends", async () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const tree = pricingMessages[locale] as unknown as { reason: Record<string, string>; special: Record<string, string> };
      for (const text of [tree.reason.drop_over_limit, tree.special.usedLead]) {
        expect(text, locale).toContain("{pct}%");
        expect(text, locale).not.toMatch(/\b10\s?%/);
      }
    }
    expect(translate(pricingMessages.en as unknown as MessageTree, "en", "reason.drop_over_limit", { pct: "12.5" })).toBe("A cut of more than 12.5% from the highest price of the last 30 days");

    await setSetting(t.db, systemActor("test.settings"), "pricing.drop_approval_bps", 1250, "تخفيضات الموسم", NOW);
    try {
      const pricer = await signedInWith(["pricing.price.update"]);
      const frame = await openPage(pricingLayoutLoader, "/admin/pricing", pricer);
      expect(frame.status).toBe(200);
      expect(dig(frame.data, "dropLimitBps")).toBe(1250);
    } finally {
      await setSetting(t.db, systemActor("test.settings"), "pricing.drop_approval_bps", 1000, "إعادة الحد", NOW);
    }
  });
});

// ───────────────────────────────────────────────────────────────── settings 22: a key added for another module

describe("settings: every key the settings screens list carries its words, the POS discount limit included", () => {
  test("each key has its help text in ar, en and ckb (the settings home and the key's page show it under the name)", () => {
    expect(SETTING_KEYS).toContain("pos.discount_limit_bps");
    for (const key of SETTING_KEYS) {
      for (const locale of ["ar", "en", "ckb"] as const) {
        const help = translate(settingsMessages[locale] as unknown as MessageTree, locale, `help.${key.replace(/\./g, "_")}`);
        expect(help, `${locale} ${key}`).toBeTruthy();
        // the limit is the setting's own value: its words never name a fixed one
        if (key === "pos.discount_limit_bps") expect(help, `${locale} ${key}`).not.toMatch(/\d\s?%/);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── finance 10: the expenses to approve

describe("finance: the drafts to approve leave closed months out, and the home's card opens what it counts", () => {
  test("a draft of a closed month (refused period_closed on approval) is no decision; the home card links like the bell", async () => {
    const recorder = await actorWith(["finance.expense.manage"]);
    const approver = await actorWith(["finance.expense.manage"]);
    const paid = { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash") };
    const before = Number(await countDecidableExpenses(t.db, approver, NOW));
    await createExpense(t.db, recorder, { ...paid, amountIqd: 40_000, description: "صيانة أيلول", incurredOn: "2026-09-15", idempotencyKey: `${make.next("exp")}-september` }, NOW);
    await createExpense(t.db, recorder, { ...paid, amountIqd: 25_000, description: "قرطاسية تشرين", incurredOn: "2026-11-05", idempotencyKey: `${make.next("exp")}-november` }, NOW);
    expect(await countDecidableExpenses(t.db, approver, NOW)).toBe(before + 2);
    // September is closed: approving its draft would be refused (period_closed), so it is not asked of anyone.
    await t.db.insert(fiscalPeriods).values({ period: "2026-09", status: "closed", closedAt: NOW, closedBy: approver.id, note: "إقفال للاختبار" });
    expect(await countDecidableExpenses(t.db, approver, NOW)).toBe(before + 1);
    // (a month before the last closed one is final too)
    await t.db.insert(fiscalPeriods).values({ period: "2026-10", status: "closed", closedAt: NOW, closedBy: approver.id, note: "إقفال للاختبار" });
    expect(await countDecidableExpenses(t.db, approver, NOW)).toBe(before + 1);

    const bookkeeper = await signedInWith(["finance.expense.manage"]);
    const home = await openPage(financeHomeLoader, "/admin/finance", bookkeeper);
    expect(home.status).toBe(200);
    // the bell's link: the list's longest range up to today, demo rows too, drafts — not this month's real expenses only
    expect(dig(home.data, "expensesHref")).toBe(queueHref("expenses", Date.now()));
    expect(String(dig(home.data, "expensesHref"))).toMatch(/^\/admin\/finance\/expenses\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&demo=1&status=draft$/);
  });
});

// ───────────────────────────────────────────────────────────────── customer names → the customer's profile

describe("a customer's name opens their profile in orders, returns and finance — for staff who may open it, text for the rest", () => {
  test("the pages send the profile only with customers.customer.read, and never for a guest", async () => {
    const READS: Permission[] = ["orders.order.read", "orders.payment.verify", "returns.rma.read", "returns.repair.manage", "returns.warranty.read", "finance.wallet.read"];
    const reader = await actorWith([...READS, "customers.customer.read"]);
    const blind = await actorWith(READS);
    const customerId = await make.customer({ name: "زبون الروابط" });
    const product = await make.product({ priceIqd: 80_000, stock: 3 });
    const order = await make.order([{ ...product, qty: 1 }], { customerId, contactName: "زبون الروابط", paymentMethod: "bank_transfer" });
    const guest = await make.order([{ ...product, qty: 1 }], { contactName: "زائر" });
    const paymentId = await make.payment(order.orderId, order.totalIqd, { method: "bank_transfer", status: "pending_verification" });
    const tag = make.next("link").replace(/[^a-z0-9]/gi, "").toUpperCase();
    await t.db.insert(returns).values([
      { id: `ret_${tag}_c`, rma: `RMA-${tag}C`, orderId: order.orderId, customerId, status: "requested", createdAt: NOW },
      { id: `ret_${tag}_g`, rma: `RMA-${tag}G`, orderId: guest.orderId, status: "requested", createdAt: NOW },
    ]);
    await t.db.insert(repairTickets).values({ id: `rep_${tag}`, ref: `RP-${tag}`, customerId, contactName: "زبون الروابط", phoneE164: "+9647705556677", issue: "لا يشحن", source: "store", status: "received", createdAt: NOW, updatedAt: NOW });
    await t.db.insert(warranties).values({ id: `wty_${tag}`, orderItemId: order.itemIds[0], customerId, phoneE164: "+9647705556677", startsAt: NOW, endsAt: NOW + 365 * 24 * 60 * 60 * 1000, createdAt: NOW });
    const noUrls = { proofImage: () => "", deliveryProof: () => "" };

    for (const [who, actor, expected] of [
      ["reader", reader, customerId],
      ["blind", blind, null],
    ] as const) {
      // orders 05: the order's page, the list, the transfer proof's review
      expect((await getOrderDetail(t.db, actor, order.ref, "ar", NOW, noUrls)).customer.profileId, who).toBe(expected);
      const list = await listOrders(t.db, actor, parseListFilters(new URLSearchParams()), "ar", NOW);
      expect(list.rows.find((row) => row.ref === order.ref)?.customerProfileId, who).toBe(expected);
      expect(list.rows.find((row) => row.ref === guest.ref)?.customerProfileId, who).toBeNull();
      expect((await getProofReview(t.db, actor, paymentId, () => "")).order.customerProfileId, who).toBe(expected);
      // returns 12: an RMA's page and the list, a repair, a warranty
      expect((await getReturnDetail(t.db, actor, `RMA-${tag}C`, "ar", NOW, { photo: () => "" })).customer.profileId, who).toBe(expected);
      expect((await getReturnDetail(t.db, actor, `RMA-${tag}G`, "ar", NOW, { photo: () => "" })).customer.profileId, who).toBeNull();
      const rmas = await listReturns(t.db, actor, parseRmaFilters(new URLSearchParams()), "ar", NOW);
      expect(rmas.rows.find((row) => row.rma === `RMA-${tag}C`)?.customerProfileId, who).toBe(expected);
      expect((await getRepair(t.db, actor, `RP-${tag}`, "ar", NOW, { file: () => "" })).customer.profileId, who).toBe(expected);
      const repairs = await listRepairs(t.db, actor, parseRepairFilters(new URLSearchParams()), "ar", NOW);
      expect(repairs.rows.find((row) => row.ref === `RP-${tag}`)?.customerProfileId, who).toBe(expected);
      expect((await getWarranty(t.db, actor, `wty_${tag}`, "ar", NOW)).customerProfileId, who).toBe(expected);
      const covered = await listWarranties(t.db, actor, parseWarrantyFilters(new URLSearchParams()), "ar", NOW);
      expect(covered.rows.find((row) => row.id === `wty_${tag}`)?.customerProfileId, who).toBe(expected);
    }

    // finance 10: the customer's wallet and a top-up request (their pages)
    const signedReader = await signedInWith([...READS, "customers.customer.read"]);
    const signedBlind = await signedInWith(READS);
    await t.db.insert(walletTopups).values({ id: `wtu_${tag}`, ref: `TU-${tag}`, customerId, method: "bank_transfer", amountIqd: 30_000, idempotencyKey: `link-${tag}`, createdAt: NOW });
    for (const [who, expected] of [
      [signedReader, customerId],
      [signedBlind, null],
    ] as const) {
      const wallet = await openPage(walletPageLoader, `/admin/finance/wallets/${customerId}`, who, { customerId });
      expect(wallet.status).toBe(200);
      expect(dig(wallet.data, "customerProfileId")).toBe(expected);
      const topup = await openPage(topupPageLoader, `/admin/finance/wallets/topups/wtu_${tag}`, who, { topupId: `wtu_${tag}` });
      expect(topup.status).toBe(200);
      expect(dig(topup.data, "customerProfileId")).toBe(expected);
    }
  });
});
