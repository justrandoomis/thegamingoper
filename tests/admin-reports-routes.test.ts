/**
 * Admin module 18 "reports" — its routes against a real local D1, with real signed-in sessions:
 *
 *   · page loaders answer 403 to a role without the page's permission and serve the roles that have it
 *   · the margin page sends no cost or profit field to a reader without cost.read (the loader's data itself)
 *   · the export route: a file with the page's figures, audited, 404 for an unknown report or format, 403 without
 *     reports.export.create
 *   · the saved-reports action: create, rename (Arabic-Indic digits in the version field), delete with a reason;
 *     field errors as 400; 403 without reports.saved.manage
 *   · the module's routes are registered under /admin/reports (the shell's gate attributes them to the module)
 */
import { eq, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loader as dictionaryLoader } from "~/routes/admin/reports/dictionary";
import { loader as exportLoader } from "~/routes/admin/reports/export";
import { loader as indexLoader } from "~/routes/admin/reports/index";
import { loader as inventoryLoader } from "~/routes/admin/reports/inventory";
import { loader as layoutLoader } from "~/routes/admin/reports/layout";
import { loader as marginLoader } from "~/routes/admin/reports/margin";
import { loader as performanceLoader } from "~/routes/admin/reports/performance";
import { reportsAdminRoutes } from "~/routes/admin/reports/routes";
import { action as savedAction, loader as savedLoader } from "~/routes/admin/reports/saved";
import { loader as salesLoader } from "~/routes/admin/reports/sales";
import { loader as customersLoader } from "~/routes/admin/reports/customers";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { auditEvents, employeeRoles, rolePermissions, roles, savedReports } from "~/server/db/schema";
import { roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;
type Person = { id: string; email: string; password: string; cookie: string };
const people: Record<string, Person> = {};
const READER_ROLE = "role_test_reports_reader";

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, TEST_NOW);
  await seedRoles(t.db, TEST_NOW);
  const reader: Permission[] = ["dashboard.overview.read", "reports.sales.read", "reports.margin.read", "reports.inventory.read", "reports.export.create"];
  await t.db.insert(roles).values({ id: READER_ROLE, key: "test_reports_reader", name: { ar: "قارئ", en: "Reader" }, isSystem: false, createdAt: TEST_NOW });
  await t.db.insert(rolePermissions).values(reader.map((permission) => ({ roleId: READER_ROLE, permission })));
  for (const key of ["owner", "finance", "support", "inventory"] as const) people[key] = await person(roleId(key as DefaultRoleKey));
  people.reader = await person(READER_ROLE);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: string): Promise<Person> {
  const password = "reports-routes-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("reports")}@reports.test`;
  const id = await make.employee({ email, name: role, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
  const who: Person = { id, email, password, cookie: "" };
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
async function run(cookie: string, path: string, fn: Fn, init: { method?: string; body?: BodyInit } = {}): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130" } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params: {}, url: new URL(request.url), pattern: path } as never);
      return out instanceof Response ? out : new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);
const dataOf = <T>(value: unknown) => ((value as { data?: T } | null)?.data ?? value) as T;

describe("page loaders", () => {
  test("the module's frame and front page refuse a role without any reports permission, and serve finance", async () => {
    expect(statusOf(await run(people.support.cookie, "/admin/reports", layoutLoader as never))).toBe(403);
    expect(statusOf(await run(people.inventory.cookie, "/admin/reports", indexLoader as never))).toBe(403);
    const frame = (await run(people.finance.cookie, "/admin/reports", layoutLoader as never)) as { access?: { reports: Record<string, boolean>; saved: boolean; cost: boolean } };
    expect(frame.access).toMatchObject({ reports: { sales: true, margin: true, inventory: true, customers: true, performance: true }, saved: true, cost: true });
    const home = (await run(people.finance.cookie, "/admin/reports", indexLoader as never)) as { saved?: unknown[] };
    expect(home.saved).toEqual([]);
  });

  test("each report's page needs its own permission", async () => {
    expect(statusOf(await run(people.reader.cookie, "/admin/reports/customers", customersLoader as never))).toBe(403);
    expect(statusOf(await run(people.reader.cookie, "/admin/reports/performance", performanceLoader as never))).toBe(403);
    expect(statusOf(await run(people.support.cookie, "/admin/reports/sales", salesLoader as never))).toBe(403);
    const sales = (await run(people.reader.cookie, "/admin/reports/sales?period=2026-06&by=platform", salesLoader as never)) as { report?: { by: string; consistent: boolean } };
    expect(sales.report).toMatchObject({ by: "platform", consistent: true });
    const customers = (await run(people.finance.cookie, "/admin/reports/customers?view=value", customersLoader as never)) as { report?: { view: string }; canOpenSegments?: boolean };
    expect(customers.report?.view).toBe("value");
    expect(customers.canOpenSegments).toBe(true);
  });

  test("margin: a reader without cost.read receives no cost or profit field at all", async () => {
    const data = await run(people.reader.cookie, "/admin/reports/margin?period=2026-06", marginLoader as never);
    const json = JSON.stringify(data);
    expect(json).toContain('"access":{"cost":false,"profit":false}');
    for (const key of ["cogsIqd", "netProfitIqd", "commissionsIqd", "shippingSubsidyIqd", "landedCostIqd", "netMarginBps"]) expect(json).not.toContain(`"${key}"`);
    const finance = JSON.stringify(await run(people.finance.cookie, "/admin/reports/margin?period=2026-06", marginLoader as never));
    expect(finance).toContain('"access":{"cost":true,"profit":true}');
  });

  test("inventory: module 04's turnover needs inventory.report.read — said, not hidden", async () => {
    const reader = (await run(people.reader.cookie, "/admin/reports/inventory?view=turnover", inventoryLoader as never)) as { stock?: { needs: string | null } };
    expect(reader.stock).toEqual({ needs: "inventory.report.read" });
    const finance = (await run(people.finance.cookie, "/admin/reports/inventory?view=dead&days=30", inventoryLoader as never)) as { stock?: { needs: string | null; report?: { report: string; days: number } } };
    expect(finance.stock?.needs).toBeNull();
    expect(finance.stock?.report).toMatchObject({ report: "dead", days: 30 });
  });

  test("the dictionary opens for any reports permission and searches in the URL", async () => {
    const all = (await run(people.reader.cookie, "/admin/reports/dictionary", dictionaryLoader as never)) as { ids?: string[] };
    expect(all.ids?.length).toBeGreaterThan(40);
    const found = (await run(people.reader.cookie, `/admin/reports/dictionary?q=${encodeURIComponent("صافي الربح")}`, dictionaryLoader as never)) as { ids?: string[] };
    expect(found.ids).toContain("net_profit");
    expect(found.ids?.length).toBeLessThan(all.ids?.length ?? 0);
  });
});

describe("export route", () => {
  test("a CSV or XLSX of the page, audited; 404 for an unknown report or format; 403 without the export permission", async () => {
    const csv = await run(people.reader.cookie, "/admin/reports/export?report=sales&format=csv&period=2026-06&by=channel", exportLoader as never);
    expect(csv).toBeInstanceOf(Response);
    const response = csv as Response;
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toContain("tamtam-sales-channel-2026-06.csv");
    expect(await response.text()).toContain("القناة");
    const xlsx = (await run(people.reader.cookie, "/admin/reports/export?report=margin&format=xlsx&period=2026-06", exportLoader as never)) as Response;
    expect(xlsx.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const bytes = new Uint8Array(await xlsx.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
    expect(statusOf(await run(people.reader.cookie, "/admin/reports/export?report=nothing&format=csv", exportLoader as never))).toBe(404);
    expect(statusOf(await run(people.reader.cookie, "/admin/reports/export?report=sales&format=pdf", exportLoader as never))).toBe(404);
    expect(statusOf(await run(people.reader.cookie, "/admin/reports/export?report=customers&format=csv", exportLoader as never))).toBe(403);
    expect(statusOf(await run(people.support.cookie, "/admin/reports/export?report=sales&format=csv", exportLoader as never))).toBe(403);
    const events = await t.db.select().from(auditEvents).where(sql`${auditEvents.action} = 'reports.export.create' AND ${auditEvents.actorId} = ${people.reader.id}`);
    expect(events.map((event) => event.entityId).sort()).toEqual(["margin", "sales"]);
  });
});

describe("saved reports action", () => {
  test("create → rename (the version typed with Arabic-Indic digits) → delete with a reason; field errors are 400", async () => {
    const form = (entries: Record<string, string>) => {
      const body = new FormData();
      for (const [key, value] of Object.entries(entries)) body.set(key, value);
      return body;
    };
    const created = dataOf<{ ok: boolean; id: string }>(await run(people.finance.cookie, "/admin/reports/saved", savedAction as never, { method: "POST", body: form({ intent: "create", reportKey: "sales", name: "مبيعات حزيران", search: "?period=2026-06&by=channel", shared: "on", idempotencyKey: "route-key-000000000001" }) }));
    expect(created.ok).toBe(true);
    const row = await t.db.select().from(savedReports).where(eq(savedReports.id, created.id)).get();
    expect(row).toMatchObject({ reportKey: "sales", isShared: true, ownerId: people.finance.id, params: { period: "2026-06", by: "channel" } });
    const tooShort = await run(people.finance.cookie, "/admin/reports/saved", savedAction as never, { method: "POST", body: form({ intent: "create", reportKey: "sales", name: "x", search: "", idempotencyKey: "route-key-000000000002" }) });
    expect(statusOf(tooShort)).toBe(400);
    expect(dataOf<{ fields?: Record<string, string> }>(tooShort).fields?.name).toBeTruthy();
    const arabicDigits = String(row?.updatedAt).replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);
    const renamed = dataOf<{ ok: boolean; changed: boolean }>(await run(people.finance.cookie, "/admin/reports/saved", savedAction as never, { method: "POST", body: form({ intent: "update", id: created.id, name: "مبيعات حزيران حسب القناة", expectedUpdatedAt: arabicDigits }) }));
    expect(renamed).toMatchObject({ ok: true, changed: true });
    const fresh = await t.db.select().from(savedReports).where(eq(savedReports.id, created.id)).get();
    expect(fresh?.isShared).toBe(false);
    const noReason = await run(people.finance.cookie, "/admin/reports/saved", savedAction as never, { method: "POST", body: form({ intent: "delete", id: created.id, reason: "", expectedUpdatedAt: String(fresh?.updatedAt) }) });
    expect(statusOf(noReason)).toBe(400);
    const deleted = dataOf<{ ok: boolean }>(await run(people.finance.cookie, "/admin/reports/saved", savedAction as never, { method: "POST", body: form({ intent: "delete", id: created.id, reason: "لم يعد مطلوباً", expectedUpdatedAt: String(fresh?.updatedAt) }) }));
    expect(deleted.ok).toBe(true);
    expect(await t.db.select().from(savedReports).where(eq(savedReports.id, created.id)).get()).toBeUndefined();
    // the reader may not save (no reports.saved.manage): refused before anything is read
    expect(statusOf(await run(people.reader.cookie, "/admin/reports/saved", savedAction as never, { method: "POST", body: form({ intent: "create", reportKey: "sales", name: "قراءة", search: "", idempotencyKey: "route-key-000000000003" }) }))).toBe(403);
    // the list page is open to any reports permission
    const list = (await run(people.reader.cookie, "/admin/reports/saved", savedLoader as never)) as { saved?: unknown[]; access?: { saved: boolean } };
    expect(list.access?.saved).toBe(false);
  });
});

describe("registration", () => {
  test("every page of the module sits under /admin/reports", () => {
    const [frame] = reportsAdminRoutes;
    expect(frame.path).toBe("reports");
    const children = (frame.children ?? []).map((child) => (child.index ? "(index)" : child.path));
    expect(children).toEqual(["(index)", "sales", "margin", "inventory", "customers", "performance", "saved", "export", "dictionary"]);
  });
});
