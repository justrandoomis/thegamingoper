/**
 * Admin module 21 "channels" — its routes against a real local D1, with real signed-in sessions:
 *
 *   · the frame and every page answer 403 to a role without the page's permission, and serve the roles that have it
 *   · loader data never carries a key, a hash or a secret; a created API key and a webhook secret reach only the action's
 *     answer, once; cost / profit keys are absent from the profitability loader without the permissions
 *   · actions check the change's own permission in the service (a manager cannot create a key, save provider secrets)
 *   · every route is registered under /admin/channels (the shell's gate attributes it to the module), and the read API's
 *     resource route answers with a key and refuses without one
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loader as apiLoader, action as apiAction } from "~/routes/admin/channels/api-v1";
import { action as keysAction, loader as keysLoader } from "~/routes/admin/channels/api-keys";
import { loader as docsLoader } from "~/routes/admin/channels/api-docs";
import { action as branchAction, loader as branchLoader } from "~/routes/admin/channels/branch";
import { action as branchNewAction } from "~/routes/admin/channels/branch-new";
import { loader as branchesLoader } from "~/routes/admin/channels/branches";
import { loader as homeLoader } from "~/routes/admin/channels/home";
import { loader as layoutLoader } from "~/routes/admin/channels/layout";
import { loader as monitorLoader } from "~/routes/admin/channels/monitor";
import { loader as ordersLoader } from "~/routes/admin/channels/orders";
import { loader as profitLoader } from "~/routes/admin/channels/profit";
import { action as providersAction, loader as providersLoader } from "~/routes/admin/channels/providers";
import { channelsAdminRoutes } from "~/routes/admin/channels/routes";
import { loader as salesLoader } from "~/routes/admin/channels/sales";
import { action as webhooksAction, loader as webhooksLoader } from "~/routes/admin/channels/webhooks";
import { gateRuleOf } from "~/routes/admin/shell/gate.server";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { apiKeys, employeeRoles, rolePermissions, roles, webhooks } from "~/server/db/schema";
import { createBranch } from "~/server/services/admin/channels/branches.server";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; email: string; password: string; cookie: string };
const people: Record<string, Person> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, TEST_NOW);
  await seedRoles(t.db, TEST_NOW);
  for (const role of ["owner", "manager", "finance", "cashier"] as const) people[role] = await person(role);
  people.reader = await person(["channels.report.read"]);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], branchId?: string): Promise<Person> {
  const password = "channels-routes-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("ch")}@channels.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? "custom" : role, passwordHash: hashed.hash, passwordIters: hashed.iterations, ...(branchId ? { branchId } : {}) });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("chr").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: TEST_NOW });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
  } else {
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  }
  const permissions = Array.isArray(role) ? new Set<string>(role) : role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  const who: Person = { id, email, password, actor: { kind: "employee", id, permissions, label: "x" }, cookie: "" };
  who.cookie = await signedIn(who);
  return who;
}

function requestCtx(): RequestCtx {
  return {
    requestId: "test",
    nonce: "n",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: null,
    userAgent: "Mozilla/5.0 (Windows NT 10.0) Edg/130",
    locale: "ar",
    dir: "rtl",
    prefs: {} as RequestCtx["prefs"],
    storeMode: "demo",
    cookie: () => null,
    setCookie: () => {},
  };
}

async function signedIn(who: Pick<Person, "email" | "password">): Promise<string> {
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email: who.email, password: who.password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  return setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "";
}

type Fn = (args: never) => unknown;
async function run(cookie: string, path: string, fn: Fn, init: { params?: Record<string, string>; method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130", ...(init.headers ?? {}) } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params: init.params ?? {}, url: new URL(request.url), pattern: path } as never);
      return out instanceof Response ? out : new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);
const dataOf = <T>(value: unknown): T => ((value as { data?: unknown })?.data ?? value) as T;
const form = (entries: Record<string, string | string[]>) => {
  const body = new FormData();
  for (const [name, value] of Object.entries(entries)) for (const item of Array.isArray(value) ? value : [value]) body.append(name, item);
  return body;
};

describe("pages and permissions", () => {
  test("the frame refuses a role without any permission of the module; each page refuses who lacks its own", async () => {
    expect(statusOf(await run(people.cashier.cookie, "/admin/channels", layoutLoader as never))).toBe(403);
    expect(statusOf(await run(people.cashier.cookie, "/admin/channels", homeLoader as never))).toBe(403);
    const finance = (await run(people.finance.cookie, "/admin/channels", layoutLoader as never)) as { access?: { profit: boolean; branches: boolean; apiKeys: boolean } };
    expect(finance.access).toMatchObject({ profit: true, branches: false, apiKeys: false });
    expect(statusOf(await run(people.finance.cookie, "/admin/channels/branches", branchesLoader as never))).toBe(403);
    expect(statusOf(await run(people.manager.cookie, "/admin/channels/branches", branchesLoader as never))).toBe(200);
    expect(statusOf(await run(people.manager.cookie, "/admin/channels/api", keysLoader as never))).toBe(403);
    expect(statusOf(await run(people.manager.cookie, "/admin/channels/webhooks", webhooksLoader as never))).toBe(403);
    expect(statusOf(await run(people.reader.cookie, "/admin/channels/orders", ordersLoader as never))).toBe(403);
    expect(statusOf(await run(people.finance.cookie, "/admin/channels/orders", ordersLoader as never))).toBe(200);
    expect(statusOf(await run(people.finance.cookie, "/admin/channels/sales", salesLoader as never))).toBe(200);
    expect(statusOf(await run(people.reader.cookie, "/admin/channels/api/docs", docsLoader as never))).toBe(200);
    expect(statusOf(await run(people.manager.cookie, "/admin/channels/monitor", monitorLoader as never))).toBe(200);
    expect(statusOf(await run(people.finance.cookie, "/admin/channels/monitor", monitorLoader as never))).toBe(403);
    expect(statusOf(await run(people.manager.cookie, "/admin/channels/providers", providersLoader as never))).toBe(200);
  });

  test("profitability: the cost and profit keys are absent from the loader's data without the permissions", async () => {
    const plain = dataOf<{ report: { rows: Record<string, unknown>[]; fields: { cost: boolean } } }>(await run(people.reader.cookie, "/admin/channels/profit", profitLoader as never));
    expect(plain.report.fields.cost).toBe(false);
    expect(plain.report.rows.length).toBeGreaterThan(0);
    for (const row of plain.report.rows) expect(Object.keys(row).some((name) => /cogs|profit|contribution|margin|shippingCosts|uncosted/i.test(name))).toBe(false);
    const finance = dataOf<{ report: { rows: Record<string, unknown>[] } }>(await run(people.finance.cookie, "/admin/channels/profit", profitLoader as never));
    expect(finance.report.rows.every((row) => "cogsIqd" in row && "grossProfitIqd" in row)).toBe(true);
  });
});

describe("actions", () => {
  test("a branch is added through its form and saved with a reason; a stale form is refused", async () => {
    const created = await run(people.manager.cookie, "/admin/channels/branches/new", branchNewAction as never, { method: "POST", body: form({ code: "rte-1", nameAr: "فرع الاختبار", key: "route-branch-key-0001" }) });
    expect(created).toBeInstanceOf(Response);
    const location = (created as Response).headers.get("location") ?? "";
    expect(location).toMatch(/^\/admin\/channels\/branches\/brn_[0-9a-f]{26}\?saved=created$/);
    const branchId = location.split("/").pop()!.split("?")[0];
    const page = dataOf<{ branch: { fingerprint: string; code: string } }>(await run(people.manager.cookie, `/admin/channels/branches/${branchId}`, branchLoader as never, { params: { branchId } }));
    expect(page.branch.code).toBe("RTE-1");
    const saved = dataOf<{ ok: boolean; changed?: boolean }>(
      await run(people.manager.cookie, `/admin/channels/branches/${branchId}`, branchAction as never, { method: "POST", params: { branchId }, body: form({ intent: "save", code: "RTE-1", nameAr: "فرع الاختبار الجديد", fingerprint: page.branch.fingerprint, reason: "اسم أوضح" }) }),
    );
    expect(saved).toMatchObject({ ok: true, changed: true });
    const stale = await run(people.manager.cookie, `/admin/channels/branches/${branchId}`, branchAction as never, { method: "POST", params: { branchId }, body: form({ intent: "save", code: "RTE-1", nameAr: "آخر", fingerprint: page.branch.fingerprint, reason: "تغيير" }) });
    expect(statusOf(stale)).toBe(409);
    expect(dataOf<{ code: string; message: string }>(stale)).toMatchObject({ code: "branch_changed", message: expect.stringContaining("تغيّر الفرع") });
    const invalid = await run(people.manager.cookie, `/admin/channels/branches/${branchId}`, branchAction as never, { method: "POST", params: { branchId }, body: form({ intent: "save", code: "RTE-1", nameAr: "", fingerprint: page.branch.fingerprint, reason: "" }) });
    expect(statusOf(invalid)).toBe(400);
    expect(dataOf<{ fields: Record<string, string> }>(invalid).fields).toMatchObject({ nameAr: "هذا الحقل مطلوب.", reason: expect.stringContaining("السبب") });
  });

  test("an API key reaches only the action's answer, once; no loader carries a key or a hash; a manager cannot create one", async () => {
    const refused = await run(people.manager.cookie, "/admin/channels/api", keysAction as never, { method: "POST", body: form({ intent: "create", name: "ERP", scope: "orders.order.read", reason: "ربط", formKey: "route-key-form-00001" }) });
    expect(statusOf(refused)).toBe(403);
    const created = dataOf<{ ok: boolean; secret: string | null; prefix: string }>(
      await run(people.owner.cookie, "/admin/channels/api", keysAction as never, { method: "POST", body: form({ intent: "create", name: "ERP", scope: ["orders.order.read", "catalog.product.read"], expiresInDays: "30", rateLimitPerMin: "60", reason: "ربط", formKey: "route-key-form-00002" }) }),
    );
    expect(created.secret).toMatch(/^ttk_/);
    const replay = dataOf<{ ok: boolean; secret: string | null }>(
      await run(people.owner.cookie, "/admin/channels/api", keysAction as never, { method: "POST", body: form({ intent: "create", name: "ERP", scope: "orders.order.read", reason: "ربط", formKey: "route-key-form-00002" }) }),
    );
    expect(replay.secret).toBeNull();
    const page = await run(people.owner.cookie, "/admin/channels/api", keysLoader as never);
    const stored = await t.db.select({ hash: apiKeys.keyHash }).from(apiKeys);
    const text = JSON.stringify(page);
    expect(text).not.toContain(created.secret!.slice(13));
    for (const row of stored) expect(text).not.toContain(row.hash);

    // the read API's resource route: with the key, and without
    const ok = (await run("", "/api/v1/orders", apiLoader as never, { params: { resource: "orders" }, headers: { authorization: `Bearer ${created.secret}` } })) as Response;
    expect(ok.status).toBe(200);
    const denied = (await run("", "/api/v1/orders", apiLoader as never, { params: { resource: "orders" } })) as Response;
    expect(denied.status).toBe(401);
    const write = (await run("", "/api/v1/orders", apiAction as never, { method: "POST", params: { resource: "orders" }, headers: { authorization: `Bearer ${created.secret}` }, body: form({}) })) as Response;
    expect(write.status).toBe(405);
  });

  test("a webhook's secret is in the creating answer only; the list never carries it", async () => {
    const created = dataOf<{ ok: boolean; secret: string | null; webhookId: string }>(
      await run(people.owner.cookie, "/admin/channels/webhooks", webhooksAction as never, { method: "POST", body: form({ intent: "create", name: "Partner", url: "https://hooks.partner.iq/tt", event: ["order.placed"], reason: "ربط", formKey: "route-webhook-form-01" }) }),
    );
    expect(created.secret).toMatch(/^whsec_/);
    const list = await run(people.owner.cookie, "/admin/channels/webhooks", webhooksLoader as never);
    const row = await t.db.select().from(webhooks).where(eq(webhooks.id, created.webhookId)).get();
    expect(JSON.stringify(list)).not.toContain(created.secret!);
    expect(JSON.stringify(list)).not.toContain(row!.secretEnc);
    const blocked = await run(people.owner.cookie, "/admin/channels/webhooks", webhooksAction as never, { method: "POST", body: form({ intent: "create", name: "Local", url: "https://127.0.0.1/x", event: ["order.placed"], reason: "ربط", formKey: "route-webhook-form-02" }) });
    expect(statusOf(blocked)).toBe(400);
    expect(dataOf<{ fields: Record<string, string> }>(blocked).fields.url).toContain("localhost");
  });

  test("provider secrets: a manager may read the registry but not save; the owner's save never comes back", async () => {
    const refused = await run(people.manager.cookie, "/admin/channels/providers", providersAction as never, { method: "POST", body: form({ intent: "save", provider: "zaincash", "config.merchantId": "M1", secret: "route-secret-value-1", expected: "", reason: "تجهيز" }) });
    expect(statusOf(refused)).toBe(403);
    const saved = await run(people.owner.cookie, "/admin/channels/providers", providersAction as never, { method: "POST", body: form({ intent: "save", provider: "zaincash", "config.merchantId": "M1", secret: "route-secret-value-1", expected: "", reason: "تجهيز" }) });
    // DATA_KEY is read from the Worker's env (tests/helpers/cloudflare-workers.ts) — either it is saved, or refused plainly
    expect([200, 503]).toContain(statusOf(saved));
    const page = await run(people.manager.cookie, "/admin/channels/providers", providersLoader as never);
    expect(JSON.stringify(page)).not.toContain("route-secret-value-1");
  });
});

describe("branch limits (review)", () => {
  test("a branch-limited employee: the store-wide pages answer 403 (never a 500), the frame does not offer them, a key or a webhook is refused", async () => {
    const { branchId } = await createBranch(t.db, people.owner.actor, { code: "RTL-1", nameAr: "فرع مقيّد", idempotencyKey: "route-limited-branch-0001" }, TEST_NOW);
    const limited = await person("manager", branchId);
    expect(statusOf(await run(limited.cookie, "/admin/channels/profit", profitLoader as never))).toBe(403);
    expect(statusOf(await run(limited.cookie, "/admin/channels/orders", ordersLoader as never))).toBe(403);
    const frame = (await run(limited.cookie, "/admin/channels", layoutLoader as never)) as { access?: { profit: boolean; orders: boolean; branches: boolean } };
    expect(frame.access).toMatchObject({ profit: false, orders: false, branches: true });

    const maker = await person(["channels.api_key.manage", "channels.webhook.manage", "orders.order.read", "catalog.product.read"], branchId);
    const key = await run(maker.cookie, "/admin/channels/api", keysAction as never, { method: "POST", body: form({ intent: "create", name: "Branch ERP", scope: "orders.order.read", reason: "ربط", formKey: "route-limited-key-00001" }) });
    expect(statusOf(key)).toBe(403);
    const hook = await run(maker.cookie, "/admin/channels/webhooks", webhooksAction as never, { method: "POST", body: form({ intent: "create", name: "Branch hook", url: "https://hooks.partner.iq/branch", event: ["order.placed"], reason: "ربط", formKey: "route-limited-hook-0001" }) });
    expect(statusOf(hook)).toBe(403);
    expect(await t.db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.name, "Branch ERP"))).toHaveLength(0);
  });
});

describe("registration", () => {
  test("every page is under /admin/channels and belongs to the module for the shell's gate", () => {
    const patterns: string[] = [];
    const walk = (entries: typeof channelsAdminRoutes, base: string) => {
      for (const entry of entries) {
        const path = entry.index ? base : [base, entry.path].filter(Boolean).join("/");
        patterns.push(`admin/${path}`);
        if (entry.children) walk(entry.children, path);
      }
    };
    walk(channelsAdminRoutes, "");
    expect(patterns.length).toBeGreaterThanOrEqual(13);
    for (const pattern of patterns) expect(gateRuleOf(pattern), pattern).toEqual({ kind: "module", module: "channels" });
  });
});
