/**
 * ACCEPTANCE — the admin control center (brief §8, §14 "Admin roles cannot see hidden supplier costs through UI, export
 * or API", §12 "unauthorized" state):
 *
 *   A. the 23 modules through the REAL admin gate (app/routes/admin/shell/gate.server.ts) with REAL staff sessions
 *      (signInEmployee): each module opens for the built-in role that owns it and answers 403 to a role without it,
 *      before any of the module's code runs; the owner sees all 23.
 *   B. each module's main workflow once, as its owning role, through the service the module's pages call — and the
 *      same action refused (403) to a role without the permission. Modules whose main workflow is a blueprint workflow
 *      or a §14 criterion are walked end to end in tests/acceptance-workflows.test.ts / acceptance-checkout.test.ts;
 *      they get a short own check here too.
 *   C. §14.11 supplier cost and margin: absent (not null, not 0) from what the pages receive, from exports and from the
 *      read API for roles without cost.read.
 *
 * Roles hold exactly the default permissions of ~/server/permissions (seedRoles); docs/ACCEPTANCE.md maps each test.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { loader as orderLoader } from "~/routes/admin/orders/order";
import { adminGate } from "~/routes/admin/shell/gate.server";
import { ADMIN_MODULE_SLUGS } from "~/routes/admin/shell/modules";
import { type EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { auditEvents, categories, employeeRoles, stockLevels, variantCosts, workflows } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { DEFAULT_LOCATION_ID, districtId, governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { saveRule, dryRunRule } from "~/server/services/admin/automation/rules.server";
import { createProduct, parseProductFilters } from "~/server/services/admin/catalog/product.server";
import { exportVariantsCsv } from "~/server/services/admin/catalog/import.server";
import { parseCsv } from "~/server/services/admin/catalog/csv";
import { createApiKey } from "~/server/services/admin/channels/apikeys.server";
import { handleApiRequest } from "~/server/services/admin/channels/api.server";
import { createBranch } from "~/server/services/admin/channels/branches.server";
import { saveBanner } from "~/server/services/admin/cms/banners.server";
import { addCustomerNote } from "~/server/services/admin/customers/profile.server";
import { salesCard } from "~/server/services/admin/dashboard/kpis.server";
import { inventoryReportCsv } from "~/server/services/admin/inventory/analytics.server";
import { adjustFromAdmin } from "~/server/services/admin/inventory/stock.server";
import { saveCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { createIncident } from "~/server/services/admin/ops/incidents.server";
import { getOrderDetail } from "~/server/services/admin/orders/detail.server";
import { exportOrdersCsv } from "~/server/services/admin/orders/export.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { requestPriceChange } from "~/server/services/admin/pricing/prices.server";
import { saveCoupon } from "~/server/services/admin/promotions/coupons.server";
import { verifyChain } from "~/server/services/admin/security/audit-log.server";
import { proposeSettingChange } from "~/server/services/admin/settings/changes.server";
import { hireEmployee } from "~/server/services/admin/staff/employees.server";
import { openStaffTicket } from "~/server/services/admin/support/tickets.server";
import { addToCart, getCartView } from "~/server/services/cart.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { placeOrder } from "~/server/services/orders/place.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "http://localhost:5173";
const ROLES = ["owner", "manager", "finance", "inventory", "fulfillment", "support", "cashier", "content"] as const;

let t: TestDb;
let make: Fixtures;
const actors = {} as Record<DefaultRoleKey | "manager2", EmployeeActor>;
const cookies = {} as Record<DefaultRoleKey, string>;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedDemo(t.db, NOW - 30 * DAY);
  await seedRoles(t.db, NOW);
  for (const role of ROLES) {
    const made = await staff(role);
    actors[role] = made.actor;
    cookies[role] = made.cookie;
  }
  actors.manager2 = (await staff("manager")).actor;
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

/** What the root middleware builds, for the sign-in service. */
function signInCtx(set: string[]): RequestCtx {
  return {
    requestId: "acceptance-admin",
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
    setCookie: (serialized) => {
      set.push(serialized);
    },
  };
}

/** A real employee of a built-in role, signed in through the auth service: its actor and its session cookie. */
async function staff(role: DefaultRoleKey): Promise<{ actor: EmployeeActor; cookie: string }> {
  const password = "acceptance-admin-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(role)}@acceptance.test`;
  const id = await make.employee({ email, name: `${role} ${make.next("n")}`, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const set: string[] = [];
  const result = await signInEmployee(signInCtx(set), t.db, { email, password });
  if (result.status !== "signed_in") throw new Error(`sign-in failed for ${role}`);
  const cookie = set.map((line) => line.split(";")[0]).find((pair) => pair.startsWith("tt_adm=") && pair.length > "tt_adm=".length);
  if (!cookie) throw new Error("no session cookie");
  return { actor: { kind: "employee", id, permissions: defaultRolePermissions(role), label: role }, cookie };
}

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

/** Status of a thrown or returned data()/Response. */
function statusOf(value: unknown): number {
  if (value instanceof Response) return value.status;
  const init = value as { type?: string; init?: { status?: number } } | null;
  if (init?.type === "DataWithResponseInit") return init.init?.status ?? 200;
  return 200;
}

/** One request through the root middleware and the admin gate; `ran` = the module's code was reached. */
async function throughGate(cookie: string, pattern: string): Promise<{ status: number; ran: boolean }> {
  const request = new Request(`${ORIGIN}/${pattern}`, { headers: { Cookie: cookie } });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let ran = false;
  try {
    const response = await requestContextMiddleware({ request, context, url, pattern, params: {} }, async () =>
      (await adminGate({ request, context, url, pattern, params: {} }, async () => {
        ran = true;
        return new Response("module page");
      })) as Response,
    );
    return { status: statusOf(response), ran };
  } catch (error) {
    return { status: statusOf(error), ran };
  }
}

/** Runs a route loader behind the root middleware with a session cookie. */
async function load(cookie: string, path: string, pattern: string, params: Record<string, string>, loader: (args: never) => Promise<unknown>) {
  const request = new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let out: unknown;
  try {
    await requestContextMiddleware({ request, context, url, pattern, params }, async () => {
      out = await loader({ request, context, params, url, pattern } as never);
      return new Response(null);
    });
  } catch (error) {
    return error;
  }
  return out;
}

async function placedOrder(variantId: string, method: "cod" | "bank_transfer" = "cod") {
  const { cartToken } = await addToCart(t.db, { cartToken: null, customerId: null, locale: "ar" }, { variantId, qty: 1 }, NOW);
  const view = await getCartView(t.db, { cartToken, customerId: null, locale: "ar", governorateId: governorateId("baghdad") }, NOW);
  return placeOrder(
    t.db,
    { cartToken, customer: null, locale: "ar", ip: null, storeMode: "live" },
    { idempotencyKey: randomToken(), phone: make.phone(), governorateId: governorateId("baghdad"), districtId: districtId("baghdad", "karrada"), areaText: "الكرادة", addressText: "شارع 62، عمارة 4", marketingConsent: false, paymentMethod: method, expectedTotalIqd: view.totalIqd },
    NOW,
  );
}

/** A costed product in stock: unit cost 70,000 on a 100,000 price. */
async function costed(priceIqd = 100_000, unitCostIqd = 70_000) {
  const product = await make.product({ priceIqd });
  await receiveStock(t.db, actors.inventory, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 10, unitCostIqd, ref: `acc-${product.sku}` }, NOW);
  await t.db.insert(variantCosts).values({ variantId: product.variantId, unitCostMinor: unitCostIqd, landedCostIqd: unitCostIqd, updatedAt: NOW }).onConflictDoNothing();
  return product;
}

// ───────────────────────────────────────────────────────────────── A. the gate

/** module → [the built-in role that owns its main workflow, a built-in role without any of its permissions]. */
const OWNERSHIP: Record<string, [DefaultRoleKey, DefaultRoleKey | null]> = {
  dashboard: ["manager", null], // every role holds dashboard.overview.read; the sales figures are the gated part (B)
  catalog: ["content", "fulfillment"],
  pricing: ["manager", "support"],
  inventory: ["inventory", "content"],
  orders: ["fulfillment", "content"],
  pos: ["cashier", "support"],
  customers: ["support", "content"],
  promotions: ["manager", "support"],
  purchasing: ["manager", "support"],
  finance: ["finance", "fulfillment"],
  shipping: ["fulfillment", "content"],
  returns: ["support", "content"],
  devices: ["inventory", "cashier"],
  support: ["support", "cashier"],
  staff: ["owner", "fulfillment"],
  marketing: ["manager", "cashier"],
  cms: ["content", "cashier"],
  reports: ["finance", "fulfillment"],
  automation: ["manager", "cashier"],
  security: ["owner", "cashier"],
  channels: ["owner", "cashier"],
  settings: ["owner", "cashier"],
  ops: ["manager", "cashier"],
};

describe("A. §8 / §12 unauthorized — every module through the real admin gate with real sessions", () => {
  test("acceptance A1: the 23 blueprint modules are all routed and each has an owning role", () => {
    expect(ADMIN_MODULE_SLUGS).toHaveLength(23);
    expect(Object.keys(OWNERSHIP).sort()).toEqual([...ADMIN_MODULE_SLUGS].sort());
  });

  test("acceptance A2: each module opens for its owning role and answers 403 to a role without it — before any module code runs", async () => {
    const failures: string[] = [];
    for (const [module, [owner, without]] of Object.entries(OWNERSHIP)) {
      const pattern = module === "dashboard" ? "admin/dashboard/activity" : `admin/${module}`;
      const opened = await throughGate(cookies[owner], pattern);
      if (!(opened.status === 200 && opened.ran)) failures.push(`${module}: ${owner} got ${opened.status}`);
      if (without) {
        const refused = await throughGate(cookies[without], pattern);
        if (!(refused.status === 403 && !refused.ran)) failures.push(`${module}: ${without} got ${refused.status} (ran ${refused.ran})`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("acceptance A3: the owner opens all 23; the cashier exactly the six its role needs; nobody signed in is sent to sign-in", async () => {
    for (const module of ADMIN_MODULE_SLUGS) expect((await throughGate(cookies.owner, `admin/${module}`)).status, module).toBe(200);
    const cashierOpens: string[] = [];
    for (const module of ADMIN_MODULE_SLUGS) if ((await throughGate(cookies.cashier, `admin/${module}`)).status === 200) cashierOpens.push(module);
    expect(cashierOpens.sort()).toEqual(["catalog", "customers", "dashboard", "inventory", "pos", "returns"]);
    const anonymous = await throughGate("", "admin/orders");
    expect(anonymous.ran).toBe(false);
    expect([302, 303]).toContain(anonymous.status);
  });
});

// ───────────────────────────────────────────────────────────────── B. main workflow per module

describe("B. §8 each module's main workflow as its owning role; the same action is 403 for a role without it", () => {
  test("acceptance B01 dashboard: the manager reads today's sales KPIs (finite); the cashier's role has no sales figures (403)", async () => {
    const filters = { period: "today", view: "overview", demo: false, branch: null } as const;
    const card = await salesCard(t.db, actors.manager, filters as never, NOW);
    expect(JSON.stringify(card)).not.toMatch(/NaN|Infinity/);
    expect((await failureOf(salesCard(t.db, actors.cashier, filters as never, NOW))).status).toBe(403);
  });

  test("acceptance B02 catalog: content creates a draft product (audited); fulfillment cannot", async () => {
    const category = (await t.db.select().from(categories).where(eq(categories.isActive, true)).get())!;
    const slug = `acceptance-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "x")}`;
    const input = { kind: "accessory", slug, name: { ar: "منتج فحص القبول", en: "Acceptance product" }, categoryId: category.id, sku: `ACC-${randomToken(5)}` };
    expect((await failureOf(createProduct(t.db, actors.fulfillment, input, NOW))).status).toBe(403);
    const { productId } = await createProduct(t.db, actors.content, input, NOW);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, productId)).all()).not.toHaveLength(0);
  });

  test("acceptance B03 pricing: the manager changes a price within the limits (history + audit); support cannot", async () => {
    const product = await costed(100_000, 70_000);
    const input = { variantId: product.variantId, newPriceIqd: "95,000", newCompareAtIqd: "", reason: "سعر المنافس", idempotencyKey: `k_${randomToken(10)}` };
    expect((await failureOf(requestPriceChange(t.db, actors.support, input, "ar", NOW))).status).toBe(403);
    expect(await requestPriceChange(t.db, actors.manager, input, "ar", NOW)).toMatchObject({ status: "applied" });
  });

  test("acceptance B04 inventory: inventory records a damaged unit; taking units that orders hold needs the oversell authorization (§14.12)", async () => {
    const product = await make.product({ priceIqd: 50_000 });
    await receiveStock(t.db, actors.inventory, { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, qty: 3, unitCostIqd: 30_000, ref: "acc-b04" }, NOW);
    const base = { variantId: product.variantId, locationId: DEFAULT_LOCATION_ID, kind: "damage" as const, direction: "remove" as const, qty: 1, reason: "علبة مكسورة في المخزن" };
    expect((await failureOf(adjustFromAdmin(t.db, actors.content, { ...base, idempotencyKey: `k_${randomToken(10)}` }, NOW))).status).toBe(403);
    expect(await adjustFromAdmin(t.db, actors.inventory, { ...base, idempotencyKey: `k_${randomToken(10)}` }, NOW)).toEqual({ replayed: false });
    // two orders now hold the last two units: removing one more would leave orders without stock
    await placedOrder(product.variantId);
    await placedOrder(product.variantId);
    const held = { ...base, kind: "adjust" as const, reason: "وحدة تالفة رغم الحجز" };
    expect((await failureOf(adjustFromAdmin(t.db, actors.inventory, { ...held, idempotencyKey: `k_${randomToken(10)}` }, NOW))).code).toBe("insufficient_stock");
    expect((await failureOf(adjustFromAdmin(t.db, actors.inventory, { ...held, allowOversell: true, idempotencyKey: `k_${randomToken(10)}` }, NOW))).code).toBe("forbidden");
    // never below zero on hand, whoever asks
    expect((await failureOf(adjustFromAdmin(t.db, actors.owner, { ...held, qty: 5, allowOversell: true, idempotencyKey: `k_${randomToken(10)}` }, NOW))).code).toBe("insufficient_stock");
    // the manager holds inventory.oversell.authorize: allowed, explicit, audited
    expect(await adjustFromAdmin(t.db, actors.manager, { ...held, allowOversell: true, idempotencyKey: `k_${randomToken(10)}` }, NOW)).toEqual({ replayed: false });
    const level = await t.db.select().from(stockLevels).where(and(eq(stockLevels.variantId, product.variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID))).get();
    expect(level).toMatchObject({ onHand: 1, reserved: 2, allowOversell: true });
  });

  test("acceptance B05 orders: fulfillment opens an order's page; content's role gets 403 (pack → ship → deliver: workflow W1)", async () => {
    const product = await costed();
    const order = await placedOrder(product.variantId);
    const detail = await getOrderDetail(t.db, actors.fulfillment, order.ref, "ar", NOW, { proofImage: (id: string) => id, deliveryProof: (id: string) => id });
    expect(detail.ref).toBe(order.ref);
    expect((await failureOf(getOrderDetail(t.db, actors.content, order.ref, "ar", NOW, { proofImage: (id: string) => id, deliveryProof: (id: string) => id }))).status).toBe(403);
  });

  test("acceptance B07 customers: support writes a note on a customer; content cannot", async () => {
    const customerId = await make.customer();
    expect((await failureOf(addCustomerNote(t.db, actors.content, { customerId, text: "اتصل يسأل عن موعد التوصيل" }, NOW))).status).toBe(403);
    expect((await addCustomerNote(t.db, actors.support, { customerId, text: "اتصل يسأل عن موعد التوصيل" }, NOW)).noteId).toBeTruthy();
  });

  test("acceptance B08 promotions: the manager creates a coupon; support cannot", async () => {
    const input = { code: `ACC${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`, kind: "fixed", value: "5000", usageLimit: "10", activate: "on" };
    expect((await failureOf(saveCoupon(t.db, actors.support, input, NOW))).status).toBe(403);
    expect((await saveCoupon(t.db, actors.manager, input, NOW)).couponId).toBeTruthy();
  });

  test("acceptance B14 support: support opens a ticket for a caller; the cashier cannot", async () => {
    const input = { channel: "phone" as const, phone: "07701234123", subject: "سؤال عن الطلب", idempotencyKey: randomToken() };
    expect((await failureOf(openStaffTicket(t.db, actors.cashier, input, NOW))).status).toBe(403);
    expect((await openStaffTicket(t.db, actors.support, input, NOW)).ref).toMatch(/^SP-/);
  });

  test("acceptance B15 staff: the owner hires an employee (a one-time password link, no password stored); fulfillment cannot", async () => {
    const input = { name: "موظف فحص القبول", email: `${make.next("hire")}@acceptance.test`, roleIds: [roleId("support")], reason: "تعيين لفحص القبول" };
    expect((await failureOf(hireEmployee(t.db, actors.fulfillment, input, NOW))).status).toBe(403);
    const hired = await hireEmployee(t.db, actors.owner, input, NOW, { demo: true });
    expect(hired.employeeId).toBeTruthy();
    expect(hired.link).toBeTruthy();
  });

  test("acceptance B16 marketing: the manager drafts an SMS campaign; the cashier cannot", async () => {
    const input = { idempotencyKey: `campaign-${randomToken(8)}`, name: "حملة فحص القبول", channel: "sms", guests: true, bodyAr: "مرحباً {name}، عرض جديد في {store}." };
    expect((await failureOf(saveCampaign(t.db, actors.cashier, input, NOW))).status).toBe(403);
    expect((await saveCampaign(t.db, actors.manager, input, NOW, { demo: true })).campaignId).toBeTruthy();
  });

  test("acceptance B17 cms: content saves a banner; the cashier cannot", async () => {
    const input = { placement: "cart", title: { ar: "عرض الأسبوع" }, link: "/c/controllers" };
    expect((await failureOf(saveBanner(t.db, actors.cashier, input, NOW))).status).toBe(403);
    expect((await saveBanner(t.db, actors.content, input, NOW)).bannerId).toBeTruthy();
  });

  test("acceptance B19 automation: the manager saves a rule and dry-runs it; the cashier cannot", async () => {
    const definition = { name: `طلبات كبيرة ${make.next("rule")}`, event: "order.placed", match: { channel: "web", paymentMethods: ["cod"], minTotal: "500000" }, actions: { notify: { audience: "automation.workflow.read" }, flag_order: true } };
    expect((await failureOf(saveRule(t.db, actors.cashier, { definition, idempotencyKey: `k_${randomToken(10)}` } as never, NOW))).status).toBe(403);
    const { ruleId } = await saveRule(t.db, actors.manager, { definition, idempotencyKey: `k_${randomToken(10)}` } as never, NOW);
    const row = await t.db.select().from(workflows).where(eq(workflows.id, ruleId)).get();
    const dry = await dryRunRule(t.db, actors.manager, { ruleId, days: 7, expectedUpdatedAt: row?.updatedAt }, NOW);
    expect(dry).toBeTruthy();
  });

  test("acceptance B20 security: the owner verifies the audit chain; the cashier cannot", async () => {
    expect((await failureOf(verifyChain(t.db, actors.cashier, NOW))).status).toBe(403);
    expect((await verifyChain(t.db, actors.owner, NOW)).ok).toBe(true);
  });

  test("acceptance B21 channels: the owner opens a branch; the cashier cannot", async () => {
    const input = { code: `ACC-${randomToken(3).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`, nameAr: "فرع فحص القبول", idempotencyKey: `branch-form-${randomToken(8)}` };
    expect((await failureOf(createBranch(t.db, actors.cashier, input, NOW))).status).toBe(403);
    expect((await createBranch(t.db, actors.owner, input, NOW)).branchId).toBeTruthy();
  });

  test("acceptance B22 settings: the owner changes a setting (audited, with its reason); the cashier cannot", async () => {
    const input = { key: "tradein.estimate_valid_days", value: 10, expected: 7, reason: "مدة أطول للتقدير", idempotencyKey: `k_${randomToken(10)}` };
    expect((await failureOf(proposeSettingChange(t.db, actors.cashier, input, NOW))).status).toBe(403);
    expect((await proposeSettingChange(t.db, actors.owner, input, NOW)).status).toMatch(/applied|requested/);
  });

  test("acceptance B23 ops: the manager opens an incident; the cashier cannot", async () => {
    const input = { title: "Proof queue slow", severity: "sev2", summary: "Staff report the proof queue takes 20 seconds to open.", ownerId: actors.manager.id, targetDay: new Date(NOW + DAY + 3 * 3_600_000).toISOString().slice(0, 10), idempotencyKey: `k_${randomToken(10)}` };
    expect((await failureOf(createIncident(t.db, actors.cashier, input, NOW))).status).toBe(403);
    expect((await createIncident(t.db, actors.manager, input, NOW)).ref).toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────── C. §14.11 cost privacy

describe("C. §14.11 supplier cost is never shown to a role without cost.read — UI, export or API", () => {
  test("acceptance C1 (UI): the order page's data carries cost and margin for the manager and NO cost key at all for fulfillment, support and inventory", async () => {
    const product = await costed(100_000, 70_000);
    const order = await placedOrder(product.variantId);
    const urls = { proofImage: (id: string) => id, deliveryProof: (id: string) => id };
    expect((await getOrderDetail(t.db, actors.manager, order.ref, "ar", NOW, urls)).costIqd).toBe(70_000);
    for (const role of ["fulfillment", "support", "inventory"] as const) {
      const detail = await getOrderDetail(t.db, actors[role], order.ref, "ar", NOW, urls);
      expect("costIqd" in detail, role).toBe(false);
      expect(JSON.stringify(detail), role).not.toMatch(/70000|costIqd|marginIqd|unitCostIqd/);
    }
    // the route itself, behind the root middleware with a real session (what the browser receives)
    const page = await load(cookies.fulfillment, `/admin/orders/${order.ref}`, "admin/orders/:ref", { ref: order.ref }, orderLoader as never);
    expect(JSON.stringify(page)).toContain(order.ref);
    expect(JSON.stringify(page)).not.toMatch(/70000|costIqd|marginIqd|unitCostIqd|landed/i);
  });

  test("acceptance C2 (export): CSV exports have cost columns only for cost.read — catalogue variants, orders, inventory value", async () => {
    await costed(100_000, 70_000);
    // one product kind (the whole-catalogue sheet is the known failure below)
    const filters = parseProductFilters(new URLSearchParams("kind=headset"));
    const withCost = parseCsv(await exportVariantsCsv(t.db, actors.manager, filters, "en", NOW));
    expect(withCost.header).toEqual(expect.arrayContaining(["landed_cost_iqd"]));
    // no built-in role exports the catalogue without cost.read: a custom "exporter" role the owner could create
    expect((await failureOf(exportVariantsCsv(t.db, actors.content, filters, "en", NOW))).status).toBe(403);
    const exporter: EmployeeActor = { kind: "employee", id: actors.content.id, permissions: new Set(["catalog.product.read", "catalog.product.export"]), label: "exporter" };
    const content = parseCsv(await exportVariantsCsv(t.db, exporter, filters, "en", NOW));
    expect(content.rows.length).toBe(withCost.rows.length);
    expect(content.header).not.toContain("landed_cost_iqd");
    expect(content.header.join(",")).not.toMatch(/cost|margin/i);
    const orderFilters = parseListFilters(new URLSearchParams());
    const headers = { costIqd: "COST", marginIqd: "MARGIN" };
    expect((await exportOrdersCsv(t.db, actors.finance, orderFilters, headers, "en", NOW)).csv.split("\r\n")[0]).toContain("COST");
    expect((await failureOf(exportOrdersCsv(t.db, actors.support, orderFilters, headers, "en", NOW))).status).toBe(403);
    const columns = { sku: "sku", product: "p", onHand: "o", lastSale: "l", lastReceipt: "r", valueIqd: "VALUE", unlayered: "UNLAYERED" };
    const inventory = await inventoryReportCsv(t.db, actors.inventory, { report: "dead", days: 30 }, "ar", NOW, columns);
    expect(JSON.stringify(inventory)).not.toContain("VALUE");
  });

  /**
   * KNOWN FAILURE (owner: admin module 02 catalog — app/server/services/admin/catalog/import.server.ts, exportVariantsCsv).
   * For a role with cost.read the variant sheet selects the costs with ONE `inArray(variant_costs.variant_id, ids)` over
   * every variant of the export: on the demo catalogue (245 variants) D1 refuses it ("too many SQL variables" — D1 binds
   * at most 100 parameters a statement), so «Export variants» with no filter answers 500 for the owner, the manager and
   * finance. The roles WITHOUT cost.read are not affected (no cost query). Fix: chunk the ids (chunkRows) or select
   * through json_each like the rows query above it. This test pins today's refusal so the suite stays green; when the
   * export is fixed it fails — then replace it with `expect(sheet.rows.length).toBeGreaterThan(100)`.
   */
  test("acceptance C2b: the whole-catalogue variant sheet exports for a cost.read holder too (it was refused by D1's 100-parameter limit)", async () => {
    const all = parseProductFilters(new URLSearchParams());
    const withCost = parseCsv(await exportVariantsCsv(t.db, actors.manager, all, "en", NOW));
    expect(withCost.rows.length).toBeGreaterThan(100);
    expect(withCost.header).toContain("landed_cost_iqd");
    // the same sheet without cost.read exports every variant, without the cost column
    const exporter: EmployeeActor = { kind: "employee", id: actors.content.id, permissions: new Set(["catalog.product.read", "catalog.product.export"]), label: "exporter" };
    expect(parseCsv(await exportVariantsCsv(t.db, exporter, all, "en", NOW)).rows.length).toBeGreaterThan(100);
  });

  test("acceptance C3 (API): the read API's products and orders carry no cost, margin or landed cost", async () => {
    const product = await costed(250_000, 180_000);
    await placedOrder(product.variantId);
    const { key } = await createApiKey(t.db, actors.owner, { name: "Acceptance sync", scopes: ["catalog.product.read", "orders.order.read"], reason: "مزامنة", idempotencyKey: `k_${randomToken(10)}` }, NOW);
    const call = (resource: string) => handleApiRequest(t.db, new Request(`${ORIGIN}/api/v1/${resource}?limit=100`, { headers: { authorization: `Bearer ${key}` } }), { ip: null, requestId: "acceptance", now: NOW }, resource);
    for (const resource of ["products", "orders"]) {
      const response = await call(resource);
      expect(response.status, resource).toBe(200);
      const text = await response.text();
      expect(text, resource).not.toMatch(/cost|margin|landed|180000/i);
    }
    // a key never gets cost.read as a scope
    expect((await failureOf(createApiKey(t.db, actors.owner, { name: "ERP", scopes: ["cost.read"], reason: "محاولة", idempotencyKey: `k_${randomToken(10)}` }, NOW))).fields).toMatchObject({ scopes: "scope_unknown" });
  });
});
