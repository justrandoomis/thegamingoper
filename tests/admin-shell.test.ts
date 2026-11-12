/**
 * Admin shell (owner: admin shell) — the blueprint registry, `next` validation, module visibility from the permission
 * catalogue, the admin gate (sign-in redirect with next, 403 for modules a role cannot see, no-store/noindex), the
 * first-owner setup page, the sign-in page (lockout wording, TOTP, recovery codes, the same-site hop), My security,
 * the shell's data (navigation and queues) and the sign-out and language endpoints.
 *
 * Everything that touches the database runs against a real local D1 (tests/helpers/db.ts), in the order a store goes
 * through it: setup creates the owner, then staff sign in.
 */
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { matchPath, RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { randomToken } from "~/lib/ids";
import { BLUEPRINT_STATUS, BLUEPRINT_STATUSES, blueprintStatusMarkdown, statusCounts, statusOf, type BlueprintEntry } from "~/routes/admin/blueprint-status";
import { adminModuleRoutes } from "~/routes/admin/_routes";
import { action as languageAction } from "~/routes/admin/auth/language";
import { action as signOutAction } from "~/routes/admin/auth/sign-out";
import { loginAction, loginLoader, type LoginFailure } from "~/routes/admin/auth/sign-in.server";
import { setupAction, setupLoader, type SetupFailure } from "~/routes/admin/auth/first-owner.server";
import { canSeeModule, visibleModules } from "~/routes/admin/shell/access.server";
import { BLUEPRINT_FUNCTION_IDS, BLUEPRINT_MODULES } from "~/routes/admin/shell/blueprint-catalog";
import { parseBlueprintFilters } from "~/routes/admin/shell/blueprint-filters";
import { adminGate, moduleOfPattern } from "~/routes/admin/shell/gate.server";
import { groupSecret, loadMySecurity, mySecurityAction } from "~/routes/admin/shell/me.server";
import { loader as moduleLandingLoader } from "~/routes/admin/shell/module";
import { ADMIN_MODULE_SLUGS, ADMIN_MODULES, moduleOfPath, navGroupsFor, NAV_GROUPS } from "~/routes/admin/shell/modules";
import { adminNextPath, loginPathFor } from "~/routes/admin/shell/next.server";
import { qrPath } from "~/routes/admin/shell/qr.server";
import { filterGrouped, normalizeSearch } from "~/routes/admin/shell/search";
import adminMessages from "~/i18n/messages/admin";
import { loadWaiting, QUEUE_HREF, type ShellQueue, type ShellWaiting } from "~/routes/admin/shell/queues.server";
import { initialsOf, loadAdminShell } from "~/routes/admin/shell/shell.server";
import { summarizeUserAgent } from "~/routes/admin/shell/ua";
import { loader as expensesPageLoader } from "~/routes/admin/finance/expenses";
import { loader as walletsPageLoader } from "~/routes/admin/finance/wallets";
import { loader as invoicesPageLoader } from "~/routes/admin/purchasing/invoices";
import { loader as purchaseOrderPageLoader } from "~/routes/admin/purchasing/order";
import { loader as purchaseOrdersPageLoader } from "~/routes/admin/purchasing/orders";
import { loader as receiptPageLoader } from "~/routes/admin/purchasing/receipt";
import { loader as receiptsPageLoader } from "~/routes/admin/purchasing/receipts";
import { loader as returnsPageLoader } from "~/routes/admin/returns/index";
import { loader as rmaPageLoader } from "~/routes/admin/returns/rma";
import { loader as attemptsPageLoader } from "~/routes/admin/shipping/attempts";
import { loader as codPageLoader } from "~/routes/admin/shipping/cod";
import { loader as settlementPageLoader } from "~/routes/admin/shipping/settlement";
import { loader as privacyPageLoader } from "~/routes/admin/customers/privacy";
import { loader as tradeInPageLoader } from "~/routes/admin/devices/trade-in";
import { loader as tradeInsPageLoader } from "~/routes/admin/devices/trade-ins";
import { loader as usedPageLoader } from "~/routes/admin/devices/used";
import { loader as shiftReportPageLoader } from "~/routes/admin/pos/shift-report";
import { loader as shiftsPageLoader } from "~/routes/admin/pos/shifts";
import { loader as retentionPageLoader } from "~/routes/admin/security/retention";
import { loader as securityRolesPageLoader } from "~/routes/admin/security/roles";
import { loader as signInsPageLoader } from "~/routes/admin/security/sign-ins";
import { loader as settingChangesPageLoader } from "~/routes/admin/settings/changes";
import type { EmployeeActor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import { getEmployee, signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword, toBase64Url, totpCode } from "~/server/crypto.server";
import { createDb } from "~/server/db/drizzle.server";
import {
  accounts,
  approvals,
  auditEvents,
  authEvents,
  carriers,
  codSettlementItems,
  codSettlements,
  cycleCounts,
  employeeRoles,
  employees,
  employeeSessions,
  expenses,
  inventoryLocations,
  posRegisters,
  posShifts,
  priceChanges,
  privacyRequests,
  purchaseOrders,
  receipts,
  refunds,
  returns,
  rolePermissions,
  roles,
  shipments,
  stockTransfers,
  supplierInvoices,
  suppliers,
  tradeInEvents,
  tradeIns,
  usedUnits,
  variants,
  walletTopups,
} from "~/server/db/schema";
import { accountId, DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { DEFAULT_ROLES, PERMISSION_DEFS, PERMISSIONS, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { createExpense } from "~/server/services/accounting/expenses.server";
import { decideTopup, requestWalletAdjustment } from "~/server/services/admin/finance/wallets.server";
import { baghdadDay, dayStart, DAY_MS } from "~/server/services/admin/finance/types";
import { purchasingOverview } from "~/server/services/admin/purchasing/alerts.server";
import { shippingOverview } from "~/server/services/admin/shipping/shipments.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

/** While on, a module's own queue count throws (the shell must then show none of that module's queues, and nothing else breaks). */
const failing = vi.hoisted(() => ({ returns: false, devices: false }));
vi.mock("~/server/services/admin/returns/rma.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/returns/rma.server")>();
  return {
    ...real,
    queueCounts: async (...args: Parameters<typeof real.queueCounts>) => {
      if (failing.returns) throw new Error("the returns counts are down (test)");
      return real.queueCounts(...args);
    },
  };
});
vi.mock("~/server/services/admin/devices/tradeins.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/server/services/admin/devices/tradeins.server")>();
  return {
    ...real,
    deviceQueueCounts: async (...args: Parameters<typeof real.deviceQueueCounts>) => {
      if (failing.devices) throw new Error("the devices counts are down (test)");
      return real.deviceQueueCounts(...args);
    },
  };
});

const NOW = TEST_NOW;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

const DATA_KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const SETUP_TOKEN = randomToken(24);
const secrets = { DATA_KEY, SETUP_TOKEN, SESSION_SECRET: randomToken(48) };

// ───────────────────────────────────────────────────────────────── request helpers

type TestRequest = { ctx: RequestCtx; setCookies: string[] };
let requestCount = 0;

function request(options: { now?: number; ip?: string | null; cookies?: Record<string, string>; locale?: "ar" | "en" } = {}): TestRequest {
  const n = ++requestCount;
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const locale = options.locale ?? "ar";
  const ctx: RequestCtx = {
    requestId: `admin-shell-${n}`,
    nonce: "test-nonce",
    origin: "http://localhost:5173",
    isHttps: false,
    isDev: true,
    now: options.now ?? NOW,
    ip: options.ip === undefined ? `203.0.${Math.floor(n / 250)}.${n % 250}` : options.ip,
    country: "IQ",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    locale,
    dir: locale === "en" ? "ltr" : "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

/** The cookies a browser keeps after a response (later Set-Cookie wins, Max-Age=0 deletes). */
function cookiesAfter(previous: TestRequest, base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const serialized of previous.setCookies) {
    const [pair, ...attributes] = serialized.split("; ");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (attributes.some((attribute) => attribute.toLowerCase() === "max-age=0")) delete jar[name];
    else jar[name] = decodeURIComponent(pair.slice(at + 1));
  }
  return jar;
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
}

async function thrown(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the call to throw, but it returned");
}

/** Status and data of a thrown/returned Response or `data()` value. */
function described(value: unknown): { status: number; data?: unknown; location?: string | null; reload?: string | null } {
  if (value instanceof Response) return { status: value.status, location: value.headers.get("Location"), reload: value.headers.get("X-Remix-Reload-Document") };
  const init = (value as { type?: string; init?: { status?: number }; data?: unknown }) ?? {};
  if (init.type === "DataWithResponseInit") return { status: init.init?.status ?? 200, data: init.data };
  throw new Error(`Not a response: ${String(value)}`);
}

/** Runs `inner` behind the real root middleware (CSRF check, request context from the Request, security headers). */
async function throughRoot(req: Request, inner: (context: RouterContextProvider, url: URL) => Promise<Response>): Promise<Response | unknown> {
  const context = new RouterContextProvider();
  const url = new URL(req.url);
  try {
    return await requestContextMiddleware({ request: req, context, url, pattern: "/", params: {} }, () => inner(context, url));
  } catch (error) {
    return error;
  }
}

const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

/** One statement sent through recordingD1: its SQL and values, the rows it brought back, when it started and finished. */
type Recorded = { sql: string; params: unknown[]; rows: number; startedAt: number; finishedAt: number | null };

/**
 * A D1 binding that writes down every statement sent through it (a batch counts as one, its rows summed), on one
 * counter for starts and finishes. Each statement waits for the next macrotask before it runs, so everything sent at
 * the same time shows as started before anything finished.
 */
function recordingD1(real: D1Database): { d1: D1Database; log: Recorded[] } {
  const log: Recorded[] = [];
  let tick = 0;
  const REAL = Symbol("the real statement");
  const timed = async <T>(sql: string, params: unknown[], call: () => Promise<T>, rows: (value: T) => number): Promise<T> => {
    const entry: Recorded = { sql, params, rows: 0, startedAt: ++tick, finishedAt: null };
    log.push(entry);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const value = await call();
    entry.rows = rows(value);
    entry.finishedAt = ++tick;
    return value;
  };
  const wrap = (statement: D1PreparedStatement, sql: string, params: unknown[]): D1PreparedStatement =>
    ({
      [REAL]: statement,
      bind: (...values: unknown[]) => wrap(statement.bind(...values), sql, values),
      all: () => timed(sql, params, () => statement.all(), (result) => result.results.length),
      raw: () => timed(sql, params, () => statement.raw(), (result) => result.length),
      first: (column?: string) => timed(sql, params, () => (column === undefined ? statement.first() : statement.first(column)), (row) => (row === null ? 0 : 1)),
      run: () => timed(sql, params, () => statement.run(), () => 0),
    }) as unknown as D1PreparedStatement;
  const unwrap = (statement: D1PreparedStatement) => (statement as unknown as Record<symbol, D1PreparedStatement>)[REAL] ?? statement;
  const d1 = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
    batch: (statements: D1PreparedStatement[]) => timed("batch", [], () => real.batch(statements.map(unwrap)), (results) => results.reduce((sum, result) => sum + (result.results?.length ?? 0), 0)),
    exec: (sql: string) => real.exec(sql),
  };
  return { d1: d1 as unknown as D1Database, log };
}

const OWNER = { name: "صاحب المتجر", email: "owner@shell.test", password: "a-long-owner-password-1" };

async function staff(role: DefaultRoleKey, password = "staff-password-1234") {
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(role)}@shell.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password };
}

/** An employee holding exactly these permissions, through a role of their own (what the role editor makes). */
async function employeeWith(permissions: readonly Permission[], password = "role-password-12345") {
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("with")}@shell.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  const role = `rol_${make.next("with").replace(/-/g, "_")}`;
  await t.db.insert(roles).values({ id: role, key: role, name: { ar: "دور للاختبار", en: "Test role" }, createdAt: NOW });
  await t.db.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: role, permission })));
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
  return { id, email, password, role };
}

/** A fresh trade-in reference the trade-in's page opens (normalizeTradeInRef: "TI-" + 8 of 2–9 / A–Z without I, O). */
function tradeInRef(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return `TI-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

async function signedIn(email: string, password: string, now = NOW): Promise<{ session: EmployeeSession; cookies: Record<string, string> }> {
  const req = request({ now });
  const result = await signInEmployee(req.ctx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error(`expected a full sign-in, got ${result.status}`);
  return { session: result.session, cookies: cookiesAfter(req) };
}

const roleActor = (key: DefaultRoleKey): EmployeeActor => ({ kind: "employee", id: `emp_${key}`, permissions: [...(DEFAULT_ROLES.find((role) => role.key === key)?.permissions ?? [])] });

// ───────────────────────────────────────────────────────────────── blueprint

describe("blueprint registry", () => {
  test("the catalogue is docs/admin-blueprint.json: 23 modules, 176 functions, same ids, priorities and titles", () => {
    const json = JSON.parse(readFileSync(new URL("../docs/admin-blueprint.json", import.meta.url), "utf8")) as {
      modules: { id: string; priority: string; ar: string; en: string; functions: { id: string; ar: string; en: string }[] }[];
    };
    const shape = (modules: typeof json.modules) => modules.map((m) => ({ id: m.id, priority: m.priority, ar: m.ar, en: m.en, functions: m.functions.map((f) => ({ id: f.id, ar: f.ar, en: f.en })) }));
    expect(shape(BLUEPRINT_MODULES as unknown as typeof json.modules)).toEqual(shape(json.modules));
    expect(BLUEPRINT_MODULES).toHaveLength(23);
    expect(BLUEPRINT_FUNCTION_IDS).toHaveLength(176);
    expect(new Set(BLUEPRINT_FUNCTION_IDS).size).toBe(176);
    // The shell's module list follows the blueprint and the permission groups (folder = slug = permission group).
    expect(ADMIN_MODULES.map((module) => module.id)).toEqual(BLUEPRINT_MODULES.map((module) => module.id));
    for (const slug of ADMIN_MODULE_SLUGS) expect(PERMISSIONS.some((permission) => PERMISSION_DEFS[permission].group === slug), slug).toBe(true);
  });

  test("every function has a truthful entry: routes are real admin pages, anything not planned says why", () => {
    expect(Object.keys(BLUEPRINT_STATUS).sort()).toEqual([...BLUEPRINT_FUNCTION_IDS].sort());
    // The admin's static pages, from the route config (the shell's /:module and * fallbacks are not destinations).
    const patterns: string[] = [];
    const walk = (entries: typeof adminModuleRoutes, base: string) => {
      for (const entry of entries) {
        const path = entry.index ? base : entry.path ? `${base}/${entry.path}` : base;
        if (entry.path !== ":module" && entry.path !== "*") patterns.push(path);
        if (entry.children) walk(entry.children, path);
      }
    };
    walk(adminModuleRoutes, "/admin");
    expect(patterns).toEqual(expect.arrayContaining(["/admin", "/admin/me", "/admin/blueprint"]));

    for (const [id, entry] of Object.entries(BLUEPRINT_STATUS) as [string, BlueprintEntry][]) {
      expect(BLUEPRINT_STATUSES, id).toContain(entry.status);
      if (entry.status !== "planned") expect(entry.note ?? entry.route, `${id} is ${entry.status} but says neither where nor what is missing`).toBeTruthy();
      if (entry.status === "implemented") expect(entry.route, `${id} is implemented but has no route`).toBeTruthy();
      if (entry.status === "partial" || entry.status === "boundary") expect(entry.note, `${id} must say what is missing`).toBeTruthy();
      if (entry.note) {
        expect(entry.note.ar.trim(), id).not.toBe("");
        expect(entry.note.en.trim(), id).not.toBe("");
      }
      if (entry.route) {
        expect(adminNextPath(entry.route, ""), `${id}: ${entry.route} is not an admin path`).toBe(entry.route);
        const pathname = entry.route.split(/[?#]/)[0];
        expect(
          patterns.some((pattern) => matchPath({ path: pattern, end: true }, pathname)),
          `${id}: no admin route serves ${pathname}`,
        ).toBe(true);
      }
    }
    expect(statusOf("99.99")).toEqual({ status: "planned" });
  });

  test("counts add up and the STATUS.md table lists every module", () => {
    const all = statusCounts();
    expect(all.total).toBe(176);
    expect(all.implemented + all.partial + all.boundary + all.planned).toBe(176);
    expect(BLUEPRINT_MODULES.reduce((sum, module) => sum + statusCounts(module.id).total, 0)).toBe(176);
    const markdown = blueprintStatusMarkdown();
    for (const module of BLUEPRINT_MODULES) expect(markdown).toContain(`| ${module.id} ${module.en} |`);
    expect(markdown).toContain(`**${all.planned}**`);
  });

  test("blueprint filters come from the URL and unknown values are dropped", () => {
    expect(parseBlueprintFilters(new URLSearchParams("status=partial&priority=P0&module=05&q=refund"))).toEqual({ status: "partial", priority: "P0", module: "05", q: "refund" });
    expect(parseBlueprintFilters(new URLSearchParams("status=done&priority=P9&module=99"))).toEqual({ status: null, priority: null, module: null, q: "" });
  });
});

// ───────────────────────────────────────────────────────────────── next

describe("next validation", () => {
  test("only same-origin paths under /admin are accepted; everything else becomes /admin", () => {
    const accepted = ["/admin", "/admin/orders", "/admin/orders?status=new&page=2", "/admin/orders/TT-7K4M2Q9X#items", "/admin/blueprint?q=%D8%A7%D8%B3%D8%AA%D8%B1%D8%AF%D8%A7%D8%AF"];
    for (const path of accepted) expect(adminNextPath(path), path).toBe(path);
    const refused = [
      "",
      "admin",
      "//evil.example",
      "//evil.example/admin",
      "/\\evil.example",
      "/\\/evil.example/admin",
      "\\\\evil.example",
      "https://evil.example/admin",
      "http:/admin",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/admin/../..//evil.example",
      "/admin/%2e%2e/%2e%2e//evil.example",
      "/admin%2F..%2F..%2Fevil",
      "/admin/%5C%5Cevil.example",
      "/admin/x%0d%0aSet-Cookie:x=1",
      "/administrator",
      "/admin.data",
      "/account",
      "/",
      " /admin",
      "/admin\u0000",
      `/admin/${"x".repeat(600)}`,
      "/admin/login",
      "/admin/login?next=/admin",
      "/admin/setup",
      "/admin/%6Cogin",
      "/admin/logout",
    ];
    for (const path of refused) expect(adminNextPath(path), JSON.stringify(path)).toBe("/admin");
    expect(adminNextPath(null)).toBe("/admin");
    expect(adminNextPath(["/admin/orders"])).toBe("/admin");
    expect(adminNextPath("//evil.example", "")).toBe("");
  });

  test("the sign-in link carries next only when there is somewhere to return to", () => {
    expect(loginPathFor("/admin/orders?status=new")).toBe("/admin/login?next=%2Fadmin%2Forders%3Fstatus%3Dnew");
    expect(loginPathFor("/admin")).toBe("/admin/login");
    expect(loginPathFor("//evil.example")).toBe("/admin/login");
    expect(loginPathFor(null)).toBe("/admin/login");
  });
});

// ───────────────────────────────────────────────────────────────── access and navigation

describe("modules come from the permission catalogue", () => {
  test("the owner sees all 23; field-level permissions alone open nothing; unknown names never", () => {
    expect(visibleModules(roleActor("owner"))).toEqual([...ADMIN_MODULE_SLUGS]);
    const fieldsOnly: EmployeeActor = { kind: "employee", id: "emp_fields", permissions: ["cost.read", "profit.read", "customer.phone.read_full"] };
    expect(visibleModules(fieldsOnly)).toEqual([]);
    expect(canSeeModule(roleActor("owner"), "nope")).toBe(false);
    expect(visibleModules({ kind: "customer", id: "cus_1" })).toEqual([]);
    expect(visibleModules({ kind: "guest" })).toEqual([]);
  });

  test("each built-in role sees exactly the modules of the permission groups it holds", () => {
    for (const role of DEFAULT_ROLES) {
      const actor = roleActor(role.key);
      const held = role.key === "owner" ? new Set<string>(PERMISSIONS) : new Set<string>(role.permissions);
      const expected = ADMIN_MODULE_SLUGS.filter((slug) => PERMISSIONS.some((permission) => PERMISSION_DEFS[permission].group === slug && held.has(permission)));
      expect(visibleModules(actor), role.key).toEqual(expected);
    }
    expect(visibleModules(roleActor("cashier"))).toEqual(["dashboard", "catalog", "inventory", "pos", "customers", "returns"]);
    expect(canSeeModule(roleActor("cashier"), "finance")).toBe(false);
    expect(canSeeModule(roleActor("finance"), "finance")).toBe(true);
    expect(canSeeModule(roleActor("content"), "cms")).toBe(true);
    expect(canSeeModule(roleActor("content"), "orders")).toBe(false);
  });

  test("navigation: at most 8 caption groups, P0 before P1 inside a group, every visible module exactly once", () => {
    const groups = navGroupsFor(ADMIN_MODULE_SLUGS);
    expect(groups.length).toBeLessThanOrEqual(8);
    expect(groups.map((group) => group.key)).toEqual([...NAV_GROUPS]);
    const listed = groups.flatMap((group) => group.modules.map((module) => module.slug));
    expect([...listed].sort()).toEqual(ADMIN_MODULE_SLUGS.filter((slug) => slug !== "dashboard").sort());
    for (const group of groups) {
      const ranks = group.modules.map((module) => Number(module.priority.slice(1)));
      expect([...ranks].sort((a, b) => a - b), group.key).toEqual(ranks);
    }
    // A cashier's navigation holds only the cashier's modules, and empty groups disappear.
    const cashier = navGroupsFor(visibleModules(roleActor("cashier")));
    expect(cashier.flatMap((group) => group.modules.map((module) => module.slug)).sort()).toEqual(["catalog", "customers", "inventory", "pos", "returns"]);
    expect(cashier.map((group) => group.key)).toEqual(["sales", "stock"]);
  });

  test("the gate reads the matched route pattern, never the raw URL", () => {
    expect(moduleOfPattern("admin/orders/:ref")).toBe("orders");
    expect(moduleOfPattern("/admin/finance")).toBe("finance");
    expect(moduleOfPattern("admin")).toBeNull();
    expect(moduleOfPattern("admin/:module")).toBeNull();
    expect(moduleOfPattern("admin/*")).toBeNull();
    expect(moduleOfPattern("admin/me")).toBeNull();
    expect(moduleOfPattern("admin/%6Frders")).toBeNull();
    expect(moduleOfPattern(":locale?/orders")).toBeNull();
    expect(moduleOfPath("/admin")?.slug).toBe("dashboard");
    expect(moduleOfPath("/admin/orders/TT-1")?.slug).toBe("orders");
    expect(moduleOfPath("/admin/me")).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── small pure parts

describe("palette search, devices, initials, QR", () => {
  test("Arabic and English queries match loosely: diacritics, alef forms, taa marbuta, case", () => {
    expect(normalizeSearch("إستِرداد")).toBe("استرداد");
    expect(normalizeSearch("الطلبيّة")).toBe(normalizeSearch("الطلبيه"));
    expect(normalizeSearch("Refunds")).toBe("refunds");
    expect(normalizeSearch("٠٥.٠٣")).toBe("05.03");
    type Item = { group: "modules" | "functions"; label: string; haystack: string };
    const items: Item[] = [
      { group: "modules", label: "المرتجعات والضمان", haystack: normalizeSearch("المرتجعات والضمان Returns and warranty") },
      { group: "functions", label: "منع استرداد العنصر نفسه مرتين", haystack: normalizeSearch("منع استرداد العنصر نفسه مرتين Prevent refunding the same item twice 12.05") },
      { group: "functions", label: "استرداد إلى وسيلة دفع", haystack: normalizeSearch("استرداد إلى وسيلة دفع Refund to an allowed payment method 12.04") },
    ];
    const limits = { modules: 10, functions: 10 };
    expect(filterGrouped(items, "", ["modules", "functions"], limits, ["functions"]).map((item) => item.label)).toEqual(["المرتجعات والضمان"]);
    expect(filterGrouped(items, "إسترداد", ["modules", "functions"], limits, ["functions"]).map((item) => item.label)).toEqual(["استرداد إلى وسيلة دفع", "منع استرداد العنصر نفسه مرتين"]);
    expect(filterGrouped(items, "refund twice", ["modules", "functions"], limits).map((item) => item.label)).toEqual(["منع استرداد العنصر نفسه مرتين"]);
  });

  test("device names, initials, grouped secrets and the QR path", () => {
    expect(summarizeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0")).toEqual({ browser: "Edge", system: "Windows" });
    expect(summarizeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toEqual({ browser: "Safari", system: "iPhone" });
    expect(summarizeUserAgent(null)).toEqual({ browser: null, system: null });
    expect(initialsOf("صاحب المتجر")).toBe("صم");
    expect(initialsOf("noor ali")).toBe("NA");
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
    const qr = qrPath("otpauth://totp/TamTam%20Games:owner%40tamtam.test?secret=JBSWY3DPEHPK3PXP&issuer=TamTam%20Games");
    expect(qr.size).toBeGreaterThanOrEqual(21);
    expect(qr.path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });
});

// ───────────────────────────────────────────────────────────────── setup

describe("first-owner setup page", () => {
  test("switched off without a long SETUP_TOKEN; ready while no employee exists", async () => {
    expect(await setupLoader(t.db, {})).toEqual({ state: "disabled" });
    expect(await setupLoader(t.db, { SETUP_TOKEN: "short" })).toEqual({ state: "disabled" });
    expect(await setupLoader(t.db, { SETUP_TOKEN })).toEqual({ state: "ready" });
  });

  test("works exactly once: typos and a wrong token write nothing, success sends the owner to sign in, then 404", async () => {
    const count = async () => (await t.db.select().from(employees)).length;
    const mismatch = (await setupAction(request().ctx, t.db, { SETUP_TOKEN }, form({ setupToken: SETUP_TOKEN, ...OWNER, confirm: `${OWNER.password}x` }))) as SetupFailure;
    expect(mismatch).toMatchObject({ ok: false, status: 400, fields: { confirm: expect.any(String) }, values: { name: OWNER.name, email: OWNER.email } });
    expect(JSON.stringify(mismatch)).not.toContain(OWNER.password);

    const wrong = (await setupAction(request().ctx, t.db, { SETUP_TOKEN }, form({ setupToken: "not-the-token-at-all", ...OWNER, confirm: OWNER.password }))) as SetupFailure;
    expect(wrong).toMatchObject({ ok: false, code: "setup_token_invalid", status: 403, fields: { setupToken: expect.any(String) } });
    const short = (await setupAction(request().ctx, t.db, { SETUP_TOKEN }, form({ setupToken: SETUP_TOKEN, ...OWNER, password: "short", confirm: "short" }))) as SetupFailure;
    expect(short).toMatchObject({ ok: false, status: 400, fields: { password: expect.any(String) } });
    expect(await count()).toBe(0);
    expect((await t.db.select().from(roles)).length).toBe(0);

    const done = await setupAction(request().ctx, t.db, { SETUP_TOKEN }, form({ setupToken: SETUP_TOKEN, ...OWNER, confirm: OWNER.password }));
    expect(described(done)).toEqual({ status: 302, location: "/admin/login?setup=done", reload: "true" });
    expect(await count()).toBe(1);
    const owner = await t.db.select().from(employees).where(eq(employees.email, OWNER.email)).get();
    expect(owner).toMatchObject({ name: OWNER.name, status: "active", totpEnabled: false });
    expect((await t.db.select().from(roles)).map((role) => role.key).sort()).toEqual(DEFAULT_ROLES.map((role) => role.key).sort());

    // Afterwards the page does not exist, for GET and POST alike — even with the right token.
    expect(described(await thrown(() => setupLoader(t.db, { SETUP_TOKEN })))).toMatchObject({ status: 404 });
    expect(described(await thrown(() => setupAction(request().ctx, t.db, { SETUP_TOKEN }, form({ setupToken: SETUP_TOKEN, name: "Second", email: "second@shell.test", password: "another-long-password", confirm: "another-long-password" }))))).toMatchObject({ status: 404 });
    expect(await count()).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── sign-in

const loginUrl = (query = "") => new URL(`http://localhost:5173/admin/login${query}`);
const docRequest = (url: URL, headers: Record<string, string> = {}) => new Request(url, { headers });

describe("sign-in page", () => {
  test("a wrong password and an unknown email read the same; success goes to a validated next", async () => {
    const unknown = (await loginAction(request().ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: "nobody@shell.test", password: "whatever-password" }))) as LoginFailure;
    const wrong = (await loginAction(request().ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: OWNER.email, password: "wrong-password-123" }))) as LoginFailure;
    expect(unknown).toMatchObject({ ok: false, step: "password", code: "invalid_credentials", status: 401 });
    expect(wrong).toMatchObject({ ok: false, step: "password", code: "invalid_credentials", status: 401 });
    expect(wrong.message).toBe(unknown.message);
    expect(wrong.email).toBe(OWNER.email);

    const ok = await loginAction(request().ctx, t.db, secrets, loginUrl("?next=%2Fadmin%2Forders%3Fx%3D1"), form({ intent: "password", email: OWNER.email, password: OWNER.password }));
    expect(described(ok)).toMatchObject({ status: 302, location: "/admin/orders?x=1" });
    for (const evil of ["//evil.example", "https://evil.example/admin", "/\\evil.example", "/admin/login"]) {
      const result = await loginAction(request().ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: OWNER.email, password: OWNER.password, next: evil }));
      expect(described(result).location, evil).toBe("/admin");
    }
  });

  test("lockout after five failures: the same words and status whether or not the email exists", async () => {
    const victim = await staff("inventory");
    const start = NOW + 2 * HOUR;
    const attempt = (email: string, offset: number, password = "guess-password-1") =>
      loginAction(request({ now: start + offset }).ctx, t.db, secrets, loginUrl(), form({ intent: "password", email, password }));
    for (const email of [victim.email, "ghost@shell.test"]) {
      for (let i = 0; i < 5; i++) expect(await attempt(email, i * 1000)).toMatchObject({ code: "invalid_credentials" });
    }
    const lockedReal = (await attempt(victim.email, 10_000, victim.password)) as LoginFailure;
    const lockedGhost = (await attempt("ghost@shell.test", 10_000)) as LoginFailure;
    expect(lockedReal).toMatchObject({ ok: false, code: "locked_out", status: 429 });
    expect(lockedGhost).toMatchObject({ ok: false, code: "locked_out", status: 429 });
    expect(lockedReal.message).toBe(lockedGhost.message);
    expect(lockedReal.message).toMatch(/15/);
    expect(lockedReal.message).not.toContain(victim.email);
    // English reads the same way for both.
    const en = (await loginAction(request({ now: start + 11_000, locale: "en" }).ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: "ghost@shell.test", password: "x-password-123" }))) as LoginFailure;
    expect(en.message).toMatch(/^Sign-in for this email is paused after too many failed attempts\. Try again in \d+ minutes?\.$/);
  });

  test("two-step: the code step, a wrong code, the right code, no replay, a recovery code once", async () => {
    const person = await staff("support");
    const start = NOW + 5 * HOUR;
    // enrol through My security
    const login = await signedIn(person.email, person.password, start);
    const enrolReq = request({ cookies: login.cookies, now: start + MINUTE });
    const enrolSession = (await getEmployee(enrolReq.ctx, t.db))!;
    const begun = await mySecurityAction(enrolReq.ctx, t.db, enrolSession, secrets, form({ intent: "totp-begin" }));
    if (!begun.ok || begun.intent !== "totp-begin") throw new Error("enrolment did not start");
    expect(begun.qr.path.length).toBeGreaterThan(100);
    const secret = begun.secret.replace(/ /g, "");
    const confirmReq = request({ cookies: login.cookies, now: start + 2 * MINUTE });
    const confirmSession = (await getEmployee(confirmReq.ctx, t.db))!;
    const wrongConfirm = await mySecurityAction(confirmReq.ctx, t.db, confirmSession, secrets, form({ intent: "totp-confirm", code: "000000" }));
    expect(wrongConfirm).toMatchObject({ ok: false, intent: "totp-confirm", code: "mfa_invalid" });
    const confirmed = await mySecurityAction(request({ cookies: login.cookies, now: start + 3 * MINUTE }).ctx, t.db, confirmSession, secrets, form({ intent: "totp-confirm", code: await totpCode(secret, start + 3 * MINUTE) }));
    if (!confirmed.ok || confirmed.intent !== "totp-confirm") throw new Error("enrolment was not confirmed");
    expect(confirmed.recoveryCodes).toHaveLength(10);

    // password → the code step (a half-open session), shown by the loader
    const at = start + 10 * MINUTE;
    const step1 = request({ now: at });
    expect(await loginAction(step1.ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: person.email, password: person.password }))).toEqual({ ok: true, step: "code" });
    const halfOpen = cookiesAfter(step1);
    expect(await loginLoader(request({ cookies: halfOpen, now: at }).ctx, t.db, docRequest(loginUrl()), loginUrl())).toMatchObject({ step: "code", email: person.email });

    const wrong = (await loginAction(request({ cookies: halfOpen, now: at }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code: "123456" }))) as LoginFailure;
    expect(wrong).toMatchObject({ ok: false, step: "code", code: "mfa_invalid", status: 401 });
    expect(wrong.message.length).toBeGreaterThan(5);

    const code = await totpCode(secret, at);
    const ok = await loginAction(request({ cookies: halfOpen, now: at }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code, next: "/admin/support" }));
    expect(described(ok)).toMatchObject({ status: 302, location: "/admin/support" });

    // the same code cannot open a second session
    const again = request({ now: at + 1000 });
    await loginAction(again.ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: person.email, password: person.password }));
    const replay = await loginAction(request({ cookies: cookiesAfter(again), now: at + 1000 }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code }));
    expect(replay).toMatchObject({ ok: false, code: "mfa_invalid" });

    // a recovery code works once ("use a recovery code instead" only changes the field)
    const recovery = confirmed.recoveryCodes[0];
    const viaRecovery = await loginAction(request({ cookies: cookiesAfter(again), now: at + 2000 }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code: recovery.toLowerCase() }));
    expect(described(viaRecovery)).toMatchObject({ status: 302, location: "/admin" });
    const third = request({ now: at + 3000 });
    await loginAction(third.ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: person.email, password: person.password }));
    expect(await loginAction(request({ cookies: cookiesAfter(third), now: at + 3000 }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code: recovery }))).toMatchObject({ ok: false, code: "mfa_invalid" });

    // "sign in with another account" ends the half-open session
    const restart = request({ cookies: cookiesAfter(third), now: at + 4000 });
    expect(await loginAction(restart.ctx, t.db, secrets, loginUrl(), form({ intent: "restart" }))).toEqual({ ok: true, step: "password" });
    expect(await loginLoader(request({ cookies: cookiesAfter(restart, cookiesAfter(third)), now: at + 4000 }).ctx, t.db, docRequest(loginUrl()), loginUrl())).toMatchObject({ step: "password" });

    // too many wrong codes end the attempt: back to the password
    const fourth = request({ now: at + HOUR });
    await loginAction(fourth.ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: person.email, password: person.password }));
    let last: unknown;
    for (let i = 0; i < 7; i++) last = await loginAction(request({ cookies: cookiesAfter(fourth), now: at + HOUR + i }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code: "999999" }));
    expect(last).toMatchObject({ ok: false, step: "password" });
    expect((last as LoginFailure).code).toMatch(/^mfa_(locked|expired)$/);
  });

  test("a signed-in employee goes straight to next; a cross-site arrival gets one same-site hop", async () => {
    const owner = await signedIn(OWNER.email, OWNER.password, NOW + 8 * HOUR);
    const url = loginUrl("?next=%2Fadmin%2Fblueprint");
    const redirected = await thrown(() => loginLoader(request({ cookies: owner.cookies, now: NOW + 8 * HOUR }).ctx, t.db, docRequest(url), url));
    expect(described(redirected)).toMatchObject({ status: 302, location: "/admin/blueprint" });

    // From an email or a chat the Strict cookie is not sent: the page asks the browser to come back from its own origin.
    const cross = await loginLoader(request({ now: NOW + 8 * HOUR }).ctx, t.db, docRequest(url, { "Sec-Fetch-Site": "cross-site" }), url);
    expect(cross.hop).toBe("/admin/login?next=%2Fadmin%2Fblueprint&hop=1");
    const hopUrl = new URL(`http://localhost:5173${cross.hop}`);
    const afterHop = await loginLoader(request({ now: NOW + 8 * HOUR }).ctx, t.db, docRequest(hopUrl, { "Sec-Fetch-Site": "same-origin" }), hopUrl);
    expect(afterHop).toMatchObject({ hop: null, step: "password", next: "/admin/blueprint" });
    const sameSite = await loginLoader(request({ now: NOW + 8 * HOUR }).ctx, t.db, docRequest(url, { "Sec-Fetch-Site": "same-origin" }), url);
    expect(sameSite.hop).toBeNull();
    // Even after the hop, a hostile next stays out.
    const evilUrl = loginUrl("?next=%2F%2Fevil.example");
    expect((await loginLoader(request().ctx, t.db, docRequest(evilUrl, { "Sec-Fetch-Site": "cross-site" }), evilUrl)).hop).toBe("/admin/login?hop=1");
    // Notices
    expect((await loginLoader(request().ctx, t.db, docRequest(loginUrl("?signed_out=all")), loginUrl("?signed_out=all"))).notice).toBe("signed_out_all");
    expect((await loginLoader(request().ctx, t.db, docRequest(loginUrl("?setup=done")), loginUrl("?setup=done"))).notice).toBe("setup_done");
  });
});

// ───────────────────────────────────────────────────────────────── the gate

describe("admin gate", () => {
  const admin = (path: string, cookies: Record<string, string> = {}, init: RequestInit = {}) =>
    new Request(`http://localhost:5173${path}`, { ...init, headers: { ...(cookies ? { Cookie: cookieHeader(cookies) } : {}), ...(init.headers as Record<string, string> | undefined) } });

  /** Runs the gate for a matched route pattern; `ran` says whether anything below it was called. */
  async function gate(req: Request, pattern: string, url = new URL(req.url)) {
    let ran = false;
    const outcome = await throughRoot(req, async (context) =>
      (await adminGate({ request: req, context, url, pattern, params: {} }, async () => {
        ran = true;
        return new Response("<p>module page</p>", { headers: { "Content-Type": "text/html" } });
      })) as Response,
    );
    return { outcome, ran };
  }

  test("nobody signed in → a document redirect to sign-in with the page to come back to; nothing below runs", async () => {
    const { outcome, ran } = await gate(admin("/admin/orders?status=new"), "admin/orders");
    expect(ran).toBe(false);
    expect(described(outcome)).toEqual({ status: 302, location: "/admin/login?next=%2Fadmin%2Forders%3Fstatus%3Dnew", reload: "true" });
    // A client navigation asks for /admin/orders.data?_routes=…; React Router hands the gate the page's own URL.
    const data = await gate(admin("/admin/orders.data?_routes=routes%2Fadmin%2F_layout"), "admin/orders", new URL("http://localhost:5173/admin/orders"));
    expect(described(data.outcome).location).toBe("/admin/login?next=%2Fadmin%2Forders");
    // The home needs no next; a stale cookie changes nothing.
    expect(described((await gate(admin("/admin", { tt_adm: randomToken() }), "admin")).outcome).location).toBe("/admin/login");
  });

  test("a module the role cannot see answers 403 before any of its loaders or actions run — even a POST", async () => {
    const cashier = await staff("cashier");
    // The root middleware stamps requests with the real clock, so these sessions start now.
    const { cookies } = await signedIn(cashier.email, cashier.password, Date.now());
    for (const [path, pattern] of [
      ["/admin/finance", "admin/finance"],
      ["/admin/finance/journal?period=2026-11", "admin/finance/journal"],
      ["/admin/security/audit", "admin/security/audit"],
    ] as const) {
      const { outcome, ran } = await gate(admin(path, cookies), pattern);
      expect(ran, path).toBe(false);
      expect(described(outcome), path).toMatchObject({ status: 403, data: { error: "forbidden", module: pattern.split("/")[1] } });
    }
    const post = await gate(admin("/admin/finance/journal", cookies, { method: "POST", headers: { Origin: "http://localhost:5173" }, body: new URLSearchParams({ amount: "1" }) }), "admin/finance/journal");
    expect(post.ran).toBe(false);
    expect(described(post.outcome)).toMatchObject({ status: 403 });

    // Its own modules pass, with no-store and noindex on the way out.
    const allowed = await gate(admin("/admin/pos/sale", cookies), "admin/pos/sale");
    expect(allowed.ran).toBe(true);
    const response = allowed.outcome as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    // The shell's own pages are for every signed-in employee.
    for (const pattern of ["admin", "admin/me", "admin/blueprint"]) expect((await gate(admin(`/${pattern}`, cookies), pattern)).ran, pattern).toBe(true);
    // The owner opens everything.
    const owner = await signedIn(OWNER.email, OWNER.password, Date.now());
    expect((await gate(admin("/admin/finance/journal", owner.cookies), "admin/finance/journal")).ran).toBe(true);
  });

  test("the landing page of a module: 403 inside the shell when the role cannot see it, 404 for an unknown name", async () => {
    const cashier = await staff("cashier");
    const { cookies } = await signedIn(cashier.email, cashier.password, Date.now());
    const land = async (module: string) => {
      const req = admin(`/admin/${module}`, cookies);
      return throughRoot(req, async (context, url) => Response.json(await moduleLandingLoader({ request: req, context, url, pattern: "admin/:module", params: { module } } as Parameters<typeof moduleLandingLoader>[0])));
    };
    expect(described(await land("finance"))).toMatchObject({ status: 403, data: { error: "forbidden", module: "finance" } });
    expect(described(await land("nope"))).toMatchObject({ status: 404 });
    expect(described(await land("dashboard"))).toMatchObject({ status: 302, location: "/admin" });
    const pos = (await land("pos")) as Response;
    expect(await pos.json()).toEqual({ slug: "pos", moduleId: "06" });
  });

  test("staff.manage alone opens module 20's role editor (and the frame's front page) through the gate — nothing else of the module", async () => {
    // A role an owner made: it manages staff and roles, and holds no security.* permission.
    const hr = await employeeWith(["staff.manage"]);
    const { cookies } = await signedIn(hr.email, hr.password, Date.now());
    for (const [path, pattern] of [
      ["/admin/security/roles", "admin/security/roles"],
      [`/admin/security/roles/${hr.role}`, "admin/security/roles/:roleId"],
      ["/admin/security", "/admin/security/"],
    ] as const) {
      const { outcome, ran } = await gate(admin(path, cookies), pattern);
      expect(ran, path).toBe(true);
      expect((outcome as Response).headers.get("Cache-Control"), path).toBe("no-store");
    }
    // The page itself, behind the gate: the roles with "new role" (staff.manage creates roles).
    const req = admin("/admin/security/roles", cookies);
    let page: unknown = null;
    await throughRoot(req, async (context, url) =>
      (await adminGate({ request: req, context, url, pattern: "admin/security/roles", params: {} }, async () => {
        page = await securityRolesPageLoader({ request: req, context, url, pattern: "admin/security/roles", params: {} } as never);
        return new Response(null);
      })) as Response,
    );
    expect(page).toMatchObject({ canCreate: true, roles: expect.arrayContaining([expect.objectContaining({ key: hr.role })]) });
    // Every other page of the module still needs a security permission — the staff pages, the trail, a deeper path.
    for (const [path, pattern] of [
      ["/admin/security/staff", "admin/security/staff"],
      ["/admin/security/staff/emp_x", "admin/security/staff/:employeeId"],
      ["/admin/security/audit", "admin/security/audit"],
      ["/admin/security/roles/x/members", "admin/security/roles/:roleId/members"],
    ] as const) {
      const { outcome, ran } = await gate(admin(path, cookies), pattern);
      expect(ran, path).toBe(false);
      expect(described(outcome), path).toMatchObject({ status: 403, data: { error: "forbidden", module: "security" } });
    }
    // Without staff.manage (and without security.*) the role editor stays closed.
    const cashier = await staff("cashier");
    const cashierCookies = (await signedIn(cashier.email, cashier.password, Date.now())).cookies;
    for (const pattern of ["admin/security/roles", "admin/security/roles/:roleId", "admin/security"]) {
      const { outcome, ran } = await gate(admin("/admin/security/roles", cashierCookies), pattern);
      expect(ran, pattern).toBe(false);
      expect(described(outcome), pattern).toMatchObject({ status: 403 });
    }
  });
});

// ───────────────────────────────────────────────────────────────── shell data

describe("shell data", () => {
  test("navigation and queues follow permissions; nobody is asked to approve their own refund", async () => {
    const finance = await staff("finance");
    const cashier = await staff("cashier");
    const product = await make.product({ priceIqd: 100_000, stock: 5 });
    const order = await make.order([{ ...product, qty: 1 }]);
    const paymentId = await make.payment(order.orderId, order.totalIqd, { method: "cod", status: "paid" });
    await make.payment(order.orderId, 1000, { method: "bank_transfer", status: "pending_verification" });
    await t.db.insert(refunds).values({ id: "ref_shell_1", orderId: order.orderId, paymentId, amountIqd: 5000, method: "cash", reason: "test", status: "pending", createdBy: finance.id, createdAt: NOW });

    const at = NOW + 11 * HOUR;
    const financeSession = (await signedIn(finance.email, finance.password, at)).session;
    const financeShell = await loadAdminShell(request({ now: at }).ctx, t.db, financeSession);
    expect(financeShell.modules).toEqual(visibleModules(financeSession.actor));
    expect(financeShell.waiting.queues.map((queue) => [queue.id, queue.count])).toEqual([["proofs", 1]]);
    expect(financeShell.waiting.notices.map((notice) => notice.id)).toEqual(["mfa_off"]);

    const ownerSession = (await signedIn(OWNER.email, OWNER.password, at)).session;
    const ownerShell = await loadAdminShell(request({ now: at, locale: "en" }).ctx, t.db, ownerSession);
    // (the owner is also asked for the access reviews every role is due for, and the sign-in alerts of the tests above)
    const ordersQueues = ownerShell.waiting.queues.filter((queue) => queue.module === "orders");
    expect(ordersQueues.map((queue) => [queue.id, queue.count])).toEqual([["proofs", 1], ["refunds", 1]]);
    // each queue opens its module's own queue screen
    expect(ordersQueues.map((queue) => queue.href)).toEqual(["/admin/orders/proofs", "/admin/orders/refunds"]);
    expect(ownerShell.waiting.queues.filter((queue) => queue.module !== "orders").map((queue) => queue.id)).toEqual(expect.arrayContaining(["access_reviews"]));
    expect(ownerShell.waiting.total).toBe(ownerShell.waiting.queues.reduce((sum, queue) => sum + queue.count, 0));
    expect(ownerShell.modules).toHaveLength(23);
    expect(ownerShell.employee).toMatchObject({ name: OWNER.name, email: OWNER.email, roles: ["Owner"], totpEnabled: false });
    expect(ownerShell.locale).toBe("en");

    const cashierSession = (await signedIn(cashier.email, cashier.password, at)).session;
    const cashierShell = await loadAdminShell(request({ now: at, cookies: { tt_admin_rail: "collapsed" } }).ctx, t.db, cashierSession);
    expect(cashierShell.waiting.queues).toEqual([]);
    expect(cashierShell.modules).toEqual(["dashboard", "catalog", "inventory", "pos", "customers", "returns"]);
    expect(cashierShell.rail).toBe("collapsed");
    expect(cashierShell.employee.roles).toEqual(["الكاشير"]);
  });

  test("inventory and pricing queues: counts to approve (never one the employee started or counted), transfers on their way, price changes to decide (never their own request)", async () => {
    const manager = await staff("manager");
    const clerk = await staff("inventory");
    const cashier = await staff("cashier");
    await t.db.insert(inventoryLocations).values({ id: "loc_shell_shop", code: "SHELL-SHOP", name: "متجر الاختبار", kind: "store" });
    await t.db.insert(cycleCounts).values([
      { id: "cc_shell_clerk", ref: "CC-SHELL-1", locationId: DEFAULT_LOCATION_ID, status: "review", startedBy: clerk.id, createdAt: NOW },
      { id: "cc_shell_manager", ref: "CC-SHELL-2", locationId: DEFAULT_LOCATION_ID, status: "review", startedBy: manager.id, createdAt: NOW },
      { id: "cc_shell_open", ref: "CC-SHELL-3", locationId: DEFAULT_LOCATION_ID, status: "counting", startedBy: clerk.id, createdAt: NOW },
    ]);
    await t.db.insert(stockTransfers).values([
      { id: "tr_shell_1", ref: "TR-SHELL-1", fromLocationId: DEFAULT_LOCATION_ID, toLocationId: "loc_shell_shop", status: "in_transit", createdAt: NOW, shippedAt: NOW },
      { id: "tr_shell_2", ref: "TR-SHELL-2", fromLocationId: DEFAULT_LOCATION_ID, toLocationId: "loc_shell_shop", status: "draft", createdAt: NOW },
    ]);
    const [variant] = await t.db.select({ id: variants.id, price: variants.priceIqd }).from(variants).limit(1);
    await t.db.insert(priceChanges).values([
      { id: "pc_shell_clerk", variantId: variant.id, oldPriceIqd: variant.price, newPriceIqd: variant.price + 1000, status: "pending", requestedBy: clerk.id, createdAt: NOW },
      { id: "pc_shell_manager", variantId: variant.id, oldPriceIqd: variant.price, newPriceIqd: variant.price + 2000, status: "pending", requestedBy: manager.id, createdAt: NOW },
    ]);

    const at = NOW + 13 * HOUR;
    const managerShell = await loadAdminShell(request({ now: at }).ctx, t.db, (await signedIn(manager.email, manager.password, at)).session);
    const queues = Object.fromEntries(managerShell.waiting.queues.map((queue) => [queue.id, queue]));
    expect(queues.counts).toEqual({ id: "counts", module: "inventory", count: 1, href: "/admin/inventory/counts?status=review" });
    expect(queues.transfers).toEqual({ id: "transfers", module: "inventory", count: 1, href: "/admin/inventory/transfers?status=in_transit" });
    expect(queues.prices).toEqual({ id: "prices", module: "pricing", count: 1, href: "/admin/pricing/changes" });
    expect(managerShell.waiting.total).toBe(managerShell.waiting.queues.reduce((sum, queue) => sum + queue.count, 0));

    // the clerk who started the count is never asked to approve it (and holds no approve permission anyway)
    const clerkShell = await loadAdminShell(request({ now: at }).ctx, t.db, (await signedIn(clerk.email, clerk.password, at)).session);
    expect(clerkShell.waiting.queues.find((queue) => queue.id === "counts")).toBeUndefined();
    expect(clerkShell.waiting.queues.find((queue) => queue.id === "prices")).toBeUndefined();

    const cashierShell = await loadAdminShell(request({ now: at }).ctx, t.db, (await signedIn(cashier.email, cashier.password, at)).session);
    expect(cashierShell.waiting.queues).toEqual([]);
  });

  test("shipping, returns, purchasing and finance queues: each module's own rule and screen, never the employee's own request, only for those who act", async () => {
    const at = NOW + 14 * HOUR;
    const signIn = async (person: { email: string; password: string }) => (await signedIn(person.email, person.password, at)).session;
    const managerA = await staff("manager");
    const managerB = await staff("manager");
    const financeA = await staff("finance");
    const financeB = await staff("finance");
    const clerk = await staff("inventory");
    const packer = await staff("fulfillment");
    const helper = await staff("support");
    const cashier = await staff("cashier");
    const buyer = await make.employee();
    const [mA, mB, fA, fB, clerkSession, packerSession, helperSession, cashierSession] = [
      await signIn(managerA),
      await signIn(managerB),
      await signIn(financeA),
      await signIn(financeB),
      await signIn(clerk),
      await signIn(packer),
      await signIn(helper),
      await signIn(cashier),
    ];
    const product = await make.product({ priceIqd: 90_000, stock: 4 });
    const order = await make.order([{ ...product, qty: 1 }]);

    // shipping — a failed delivery (and one already on its way back, which waits for the goods, not a decision); three
    // submitted settlements: no difference (its preparer may reconcile it alone), a variance (never its creator and
    // submitter), a hand correction (never its corrector, creator or submitter); and a draft
    await t.db.insert(carriers).values({ id: "car_shell", code: "SHELL-CAR", name: "شركة شحن للاختبار", createdAt: NOW });
    await t.db.insert(shipments).values([
      { id: "shp_shell_failed", orderId: order.orderId, carrierId: "car_shell", status: "failed", failureReason: "لم يرد على الهاتف", createdAt: NOW, updatedAt: NOW },
      { id: "shp_shell_back", orderId: order.orderId, carrierId: "car_shell", status: "returning", createdAt: NOW, updatedAt: NOW },
    ]);
    await t.db.insert(codSettlements).values([
      { id: "cod_shell_clean", ref: "COD-SHELL-1", carrierId: "car_shell", status: "submitted", createdBy: financeA.id, createdAt: NOW },
      { id: "cod_shell_short", ref: "COD-SHELL-2", carrierId: "car_shell", status: "submitted", expectedIqd: 100_000, receivedIqd: 95_000, varianceIqd: -5000, createdBy: financeA.id, createdAt: NOW },
      { id: "cod_shell_fixed", ref: "COD-SHELL-3", carrierId: "car_shell", status: "submitted", createdBy: financeB.id, createdAt: NOW },
      { id: "cod_shell_draft", ref: "COD-SHELL-4", carrierId: "car_shell", status: "draft", createdBy: financeB.id, createdAt: NOW },
    ]);
    await audit(t.db, { actor: fA.actor, action: "shipping.cod.submit", entityType: "cod_settlement", entityId: "cod_shell_clean", at: NOW });
    await audit(t.db, { actor: fA.actor, action: "shipping.cod.submit", entityType: "cod_settlement", entityId: "cod_shell_short", at: NOW });
    await audit(t.db, { actor: fA.actor, action: "shipping.cod.item", entityType: "cod_settlement", entityId: "cod_shell_fixed", at: NOW });
    await audit(t.db, { actor: fB.actor, action: "shipping.cod.submit", entityType: "cod_settlement", entityId: "cod_shell_fixed", at: NOW + MINUTE });

    // returns — two to decide (managerA opened one), one received for inspection, one already inspected (references
    // in the real RMA-XXXXXXXX form, so each one's page opens)
    await t.db.insert(returns).values([
      { id: "ret_shell_mine", rma: "RMA-SHELL001", orderId: order.orderId, status: "requested", createdAt: NOW },
      { id: "ret_shell_other", rma: "RMA-SHELL002", orderId: order.orderId, status: "requested", createdAt: NOW },
      { id: "ret_shell_back", rma: "RMA-SHELL003", orderId: order.orderId, status: "received", receivedAt: NOW, createdAt: NOW },
      { id: "ret_shell_done", rma: "RMA-SHELL004", orderId: order.orderId, status: "inspected", inspectedAt: NOW, createdAt: NOW },
    ]);
    await audit(t.db, { actor: mA.actor, action: "returns.rma.create", entityType: "return", entityId: "ret_shell_mine", at: NOW });
    await audit(t.db, { actor: helperSession.actor, action: "returns.rma.create", entityType: "return", entityId: "ret_shell_other", at: NOW });

    // purchasing — four orders above the limit: managerA's own, managerB's own, a buyer's, a buyer's that managerB edited;
    // a posting that stopped an hour ago next to a finished one; an invoice with variances next to a matched one
    await t.db.insert(suppliers).values({ id: "sup_shell", code: "SUP-SHELL", name: "مورد للاختبار", createdAt: NOW, updatedAt: NOW });
    const pendingOrders = [
      ["po_shell_a", managerA.id],
      ["po_shell_b", managerB.id],
      ["po_shell_buyer", buyer],
      ["po_shell_edited", buyer],
    ] as const;
    await t.db.insert(approvals).values(pendingOrders.map(([id, by]) => ({ id: `apv_${id}`, kind: "purchase_order", entityType: "purchase_order", entityId: id, requestedBy: by, status: "pending" as const, createdAt: NOW })));
    await t.db.insert(purchaseOrders).values(
      pendingOrders.map(([id, by], index) => ({ id, ref: `PO-SHELL-${index + 1}`, supplierId: "sup_shell", status: "pending_approval" as const, locationId: DEFAULT_LOCATION_ID, approvalId: `apv_${id}`, createdBy: by, createdAt: NOW, updatedAt: NOW })),
    );
    await audit(t.db, { actor: mB.actor, action: "purchasing.po.update", entityType: "purchase_order", entityId: "po_shell_edited", at: NOW });
    await t.db.insert(receipts).values([
      { id: "rc_shell_stuck", ref: "RC-SHELL-1", supplierId: "sup_shell", locationId: DEFAULT_LOCATION_ID, status: "posted", receivedBy: "posting:shell-test", postedAt: NOW - HOUR, createdAt: NOW - HOUR },
      { id: "rc_shell_posted", ref: "RC-SHELL-2", supplierId: "sup_shell", locationId: DEFAULT_LOCATION_ID, status: "posted", receivedBy: clerk.id, postedAt: NOW - HOUR, createdAt: NOW - HOUR },
    ]);
    await t.db.insert(supplierInvoices).values([
      { id: "inv_shell_off", supplierId: "sup_shell", invoiceNo: "INV-SHELL-1", totalMinor: 10_000, status: "mismatch", createdAt: NOW },
      { id: "inv_shell_ok", supplierId: "sup_shell", invoiceNo: "INV-SHELL-2", totalMinor: 10_000, status: "matched", createdAt: NOW },
    ]);

    // finance — three top-up requests (financeA gave the large one its first approval; one is rejected), financeA's own
    // adjustment request, financeA's expense above any one-person limit and financeB's small one
    const customerId = await make.customer();
    await t.db.insert(walletTopups).values([
      { id: "wtu_shell_new", ref: "TU-SHELL-1", customerId, method: "bank_transfer", amountIqd: 50_000, idempotencyKey: "shell-topup-1", createdAt: NOW },
      { id: "wtu_shell_half", ref: "TU-SHELL-2", customerId, method: "zaincash", amountIqd: 900_000, idempotencyKey: "shell-topup-2", createdAt: NOW },
      { id: "wtu_shell_no", ref: "TU-SHELL-3", customerId, method: "cash", amountIqd: 20_000, status: "rejected", rejectReason: "لا حوالة", idempotencyKey: "shell-topup-3", createdAt: NOW },
    ]);
    await t.db.insert(approvals).values([
      { id: "apv_shell_topup", kind: "wallet_topup", entityType: "wallet_topup", entityId: "wtu_shell_half", requestedBy: financeA.id, status: "pending", createdAt: NOW },
      { id: "apv_shell_adjust", kind: "wallet_adjustment", entityType: "customer", entityId: customerId, requestedBy: financeA.id, payload: { amountIqd: 10_000 }, reason: "تعويض عن تأخير التوصيل", status: "pending", createdAt: NOW },
    ]);
    const [expenseAccount] = await t.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "expense")).limit(1);
    await t.db.insert(expenses).values([
      { id: "exp_shell_rent", accountId: expenseAccount.id, amountIqd: 50_000_000, description: "إيجار المستودع", incurredOn: "2026-11-09", period: "2026-11", createdBy: financeA.id, createdAt: NOW },
      { id: "exp_shell_pens", accountId: expenseAccount.id, amountIqd: 15_000, description: "قرطاسية", incurredOn: "2026-11-09", period: "2026-11", createdBy: financeB.id, createdAt: NOW },
    ]);

    const waitingOf = async (session: EmployeeSession) => (await loadAdminShell(request({ now: at }).ctx, t.db, session)).waiting;
    const NEW = ["failed_deliveries", "cod_settlements", "rmas", "inspections", "po_approvals", "stuck_receipts", "invoice_mismatches", "topups", "adjustments", "expenses"];
    const countsOf = (waiting: ShellWaiting) => Object.fromEntries(waiting.queues.filter((queue) => NEW.includes(queue.id)).map((queue) => [queue.id, queue.count]));

    // A manager acts on all of them — each opens its module's own queue screen and carries its module's bead.
    const managerAWaiting = await waitingOf(mA);
    expect(managerAWaiting.queues.filter((queue) => NEW.includes(queue.id))).toEqual([
      { id: "failed_deliveries", module: "shipping", count: 1, href: "/admin/shipping/attempts" },
      { id: "cod_settlements", module: "shipping", count: 3, href: "/admin/shipping/cod?status=submitted" },
      // not the RMA managerA opened
      { id: "rmas", module: "returns", count: 1, href: "/admin/returns?view=decide" },
      { id: "inspections", module: "returns", count: 1, href: "/admin/returns?view=inspect" },
      // not managerA's own order
      { id: "po_approvals", module: "purchasing", count: 3, href: "/admin/purchasing/orders?view=pending_approval" },
      { id: "stuck_receipts", module: "purchasing", count: 1, href: "/admin/purchasing/receipts?state=posting" },
      { id: "invoice_mismatches", module: "purchasing", count: 1, href: "/admin/purchasing/invoices?status=mismatch" },
      { id: "topups", module: "finance", count: 2, href: "/admin/finance/wallets?status=pending_verification" },
      { id: "adjustments", module: "finance", count: 1, href: "/admin/finance/wallets?tab=adjustments" },
      // every draft the list can show (its longest range up to today, demo rows too) — see the "truth" test below
      { id: "expenses", module: "finance", count: 2, href: expect.stringMatching(/^\/admin\/finance\/expenses\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&demo=1&status=draft$/) },
    ]);
    expect(managerAWaiting.total).toBe(managerAWaiting.queues.reduce((sum, queue) => sum + queue.count, 0));
    // managerB decides the RMA managerA opened, but neither their own order nor the one they edited
    expect(countsOf(await waitingOf(mB))).toMatchObject({ rmas: 2, po_approvals: 2 });

    // Finance: not the top-up it approved first, not its own adjustment request (no queue at 0), not its own large
    // expense, not the settlements it prepared that carry a difference; nothing of purchasing's approvals, receiving,
    // returns or deliveries.
    expect(countsOf(await waitingOf(fA))).toEqual({ cod_settlements: 1, invoice_mismatches: 1, topups: 1, expenses: 1 });
    expect(countsOf(await waitingOf(fB))).toEqual({ cod_settlements: 2, invoice_mismatches: 1, topups: 2, adjustments: 1, expenses: 2 });
    // The stock clerk inspects returns and resumes postings (no cost.read: no invoices); the packer decides failed
    // deliveries; support and the cashier act on none of these.
    expect(countsOf(await waitingOf(clerkSession))).toEqual({ inspections: 1, stuck_receipts: 1 });
    expect(countsOf(await waitingOf(packerSession))).toEqual({ failed_deliveries: 1 });
    expect(countsOf(await waitingOf(helperSession))).toEqual({});
    expect((await waitingOf(cashierSession)).queues).toEqual([]);

    // The same numbers as the modules' own home pages show.
    expect((await shippingOverview(t.db, fA.actor, at)).toReconcile).toBe(1);
    expect((await shippingOverview(t.db, fB.actor, at)).toReconcile).toBe(2);
    expect((await shippingOverview(t.db, mA.actor, at)).failed).toBe(1);
    expect((await purchasingOverview(t.db, mA.actor, at)).waiting).toMatchObject({ approvals: 3, receiptsStuck: 1, invoicesMismatch: 1 });
    expect((await purchasingOverview(t.db, mB.actor, at)).waiting.approvals).toBe(2);
  });

  test("a module whose count fails shows none of its queues: logged, and the other queues and the page still load", async () => {
    const at = NOW + 15 * HOUR;
    const manager = await staff("manager");
    const session = (await signedIn(manager.email, manager.password, at)).session;
    const product = await make.product({ priceIqd: 40_000, stock: 1 });
    const order = await make.order([{ ...product, qty: 1 }]);
    await t.db.insert(returns).values({ id: "ret_shell_failing", rma: "RMA-SHELL009", orderId: order.orderId, status: "received", receivedAt: NOW, createdAt: NOW });
    await t.db.insert(shipments).values({ id: "shp_shell_failing", orderId: order.orderId, status: "failed", createdAt: NOW, updatedAt: NOW });
    const healthy = (await loadAdminShell(request({ now: at }).ctx, t.db, session)).waiting;
    expect(healthy.queues.some((queue) => queue.module === "returns")).toBe(true);

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failing.returns = true;
    try {
      const waiting = (await loadAdminShell(request({ now: at }).ctx, t.db, session)).waiting;
      const others = healthy.queues.filter((queue) => queue.module !== "returns");
      expect(waiting.queues).toEqual(others);
      expect(others.map((queue) => queue.id)).toContain("failed_deliveries");
      expect(waiting.total).toBe(others.reduce((sum, queue) => sum + queue.count, 0));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("returns"), expect.any(Error));
    } finally {
      failing.returns = false;
      logged.mockRestore();
    }
  });

  // ── the new queues against the pages they open (review 2026-11-11). Page requests run behind the real root
  // middleware, which stamps them with the real clock, so these employees sign in on it and the records are dated by it.

  /** An employee holding exactly these permissions: a role the owner made in the role editor. */
  async function custom(permissions: readonly Permission[], password = "custom-password-1234") {
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("custom")}@shell.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    const role = `rol_${make.next("custom").replace("-", "_")}`;
    await t.db.insert(roles).values({ id: role, key: role, name: { ar: "دور مخصص", en: "Custom role" }, createdAt: NOW });
    await t.db.insert(rolePermissions).values(permissions.map((permission) => ({ roleId: role, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
    return { id, email, password };
  }

  type PageLoader = (args: never) => Promise<unknown>;
  /** The list each queue's link opens, by path. */
  const QUEUE_PAGES: Record<string, PageLoader> = {
    "/admin/shipping/attempts": attemptsPageLoader,
    "/admin/shipping/cod": codPageLoader,
    "/admin/returns": returnsPageLoader,
    "/admin/purchasing/orders": purchaseOrdersPageLoader,
    "/admin/purchasing/receipts": receiptsPageLoader,
    "/admin/purchasing/invoices": invoicesPageLoader,
    "/admin/finance/wallets": walletsPageLoader,
    "/admin/finance/expenses": expensesPageLoader,
  };

  /** A page's loader for a signed-in employee, behind the real root middleware: its data, or the status it refused with. */
  async function openPage(href: string, cookies: Record<string, string>, loader?: PageLoader, params: Record<string, string> = {}): Promise<{ status: number; data: unknown }> {
    const req = new Request(`http://localhost:5173${href}`, { headers: { Cookie: cookieHeader(cookies) } });
    const run = loader ?? QUEUE_PAGES[new URL(req.url).pathname];
    if (!run) throw new Error(`no page loader for ${href}`);
    let data: unknown = null;
    const outcome = await throughRoot(req, async (context, url) => {
      data = await run({ request: req, context, params, url, pattern: url.pathname } as never);
      return new Response(null);
    });
    return outcome instanceof Response && outcome.status === 200 ? { status: 200, data } : { status: described(outcome).status, data: null };
  }

  type Row = Record<string, unknown>;
  const dig = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => (node !== null && typeof node === "object" ? (node as Row)[key] : undefined), value);
  const rowsAt = (value: unknown, ...path: string[]): Row[] => {
    const found = dig(value, ...path);
    return Array.isArray(found) ? (found as Row[]) : [];
  };

  /**
   * How many of the rows a queue's link lists this employee may act on — as the module's own pages say (a settlement's
   * "reconcile", an RMA's or an order's "decide", a posting's "resumable", the lists' own flags). The link must open
   * (200) for them. This is the number the shell must show.
   */
  async function actionableOnPage(queue: ShellQueue, cookies: Record<string, string>): Promise<number> {
    const list = await openPage(queue.href, cookies);
    expect.soft(list.status, `${queue.id}: ${queue.href} opens`).toBe(200);
    const data = list.data;
    const ids = (key: string, ...path: string[]) => rowsAt(data, ...path).map((row) => String(row[key]));
    const howMany = async (keys: string[], may: (key: string) => Promise<boolean>) => {
      let n = 0;
      for (const key of keys) if (await may(key)) n++;
      return n;
    };
    switch (queue.id) {
      case "failed_deliveries":
        return rowsAt(data, "rows").filter((row) => row.status === "failed").length;
      case "cod_settlements":
        return howMany(ids("id", "settlements"), async (settlementId) => dig((await openPage(`/admin/shipping/cod/${settlementId}`, cookies, settlementPageLoader, { settlementId })).data, "settlement", "can", "reconcile") === true);
      case "rmas":
        return howMany(ids("rma", "page", "rows"), async (rma) => dig((await openPage(`/admin/returns/${rma}`, cookies, rmaPageLoader, { rma })).data, "rma", "can", "decide") === true);
      case "inspections":
      case "invoice_mismatches":
        return Number(dig(data, "page", "total") ?? 0);
      case "po_approvals":
        return howMany(ids("id", "page", "rows"), async (poId) => dig((await openPage(`/admin/purchasing/orders/${poId}`, cookies, purchaseOrderPageLoader, { poId })).data, "detail", "can", "decide") === true);
      case "stuck_receipts":
        return howMany(ids("id", "page", "rows"), async (receiptId) => dig((await openPage(`/admin/purchasing/receipts/${receiptId}`, cookies, receiptPageLoader, { receiptId })).data, "detail", "receipt", "posting", "resumable") === true);
      case "topups":
        return rowsAt(data, "topups", "rows").filter((row) => row.status === "pending_verification" && dig(row, "firstApproval", "byMe") !== true).length;
      case "adjustments":
        return rowsAt(data, "adjustments").filter((row) => row.status === "pending" && row.mine !== true).length;
      case "expenses":
        return rowsAt(data, "page", "rows").filter((row) => row.status === "draft" && row.needsOther !== true).length;
      default:
        throw new Error(`no page check for ${queue.id}`);
    }
  }

  const NEW_QUEUES = ["failed_deliveries", "cod_settlements", "rmas", "inspections", "po_approvals", "stuck_receipts", "invoice_mismatches", "topups", "adjustments", "expenses"] as const;

  test("truth: each new queue counts exactly what its link lists that the employee may act on — last month's and demo drafts, custom roles and all", async () => {
    const now = Date.now();
    const manager = await staff("manager");
    const bookkeeper = await staff("finance");
    const clerk = await staff("inventory");
    const packer = await staff("fulfillment");
    // Roles an owner could make: settles carriers' cash without recording payments (orders.payment.record); decides and
    // inspects returns without reading the list; approves purchase orders without reading them.
    const codClerk = await custom(["shipping.cod.settle", "shipping.shipment.read"]);
    const returnsDecider = await custom(["returns.rma.approve", "returns.rma.inspect"]);
    const poApprover = await custom(["purchasing.po.approve", "cost.read"]);
    // and one who approves orders and matches invoices but may not see cost: never a cost-gated count
    const costBlind = await custom(["purchasing.po.approve", "purchasing.po.read", "purchasing.invoice.manage", "purchasing.receipt.create"]);
    const people = { manager, bookkeeper, clerk, packer, codClerk, returnsDecider, poApprover, costBlind };
    const signed: Record<string, { session: EmployeeSession; cookies: Record<string, string> }> = {};
    for (const [who, person] of Object.entries(people)) signed[who] = await signedIn(person.email, person.password, now);

    const product = await make.product({ priceIqd: 60_000, stock: 6 });
    const order = await make.order([{ ...product, qty: 1 }]);
    const cashOrder = await make.order([{ ...product, qty: 1 }], { paymentMethod: "cod" });
    await make.payment(cashOrder.orderId, cashOrder.totalIqd, { method: "cod", status: "pending" });
    const backOrder = await make.order([{ ...product, qty: 1 }]);

    // shipping — two failed deliveries and one parcel on its way back; a settlement holding a parcel whose cash the
    // courier brought (its cash-on-delivery payment still to be recorded), a settlement of the carrier's charges only,
    // and one with a difference the bookkeeper made and submitted
    await t.db.insert(carriers).values({ id: "car_truth", code: "TRUTH-CAR", name: "شركة شحن للتحقق", createdAt: now });
    await t.db.insert(shipments).values([
      { id: "shp_truth_failed1", orderId: order.orderId, carrierId: "car_truth", status: "failed", failureReason: "الهاتف مغلق", createdAt: now, updatedAt: now },
      { id: "shp_truth_failed2", orderId: order.orderId, carrierId: "car_truth", status: "failed", createdAt: now, updatedAt: now },
      { id: "shp_truth_back", orderId: order.orderId, carrierId: "car_truth", status: "returning", createdAt: now, updatedAt: now },
      { id: "shp_truth_cash", orderId: cashOrder.orderId, carrierId: "car_truth", status: "delivered", deliveredAt: now, createdAt: now, updatedAt: now },
      { id: "shp_truth_returned", orderId: backOrder.orderId, carrierId: "car_truth", status: "returned", returnedAt: now, createdAt: now, updatedAt: now },
    ]);
    await t.db.insert(codSettlements).values([
      { id: "cod_truth_cash", ref: "COD-TRUTH-1", carrierId: "car_truth", status: "submitted", expectedIqd: cashOrder.totalIqd, receivedIqd: cashOrder.totalIqd, createdBy: bookkeeper.id, createdAt: now },
      { id: "cod_truth_fees", ref: "COD-TRUTH-2", carrierId: "car_truth", status: "submitted", feesIqd: 3000, receivedIqd: -3000, createdBy: bookkeeper.id, createdAt: now },
      { id: "cod_truth_diff", ref: "COD-TRUTH-3", carrierId: "car_truth", status: "submitted", receivedIqd: 5000, varianceIqd: 5000, createdBy: bookkeeper.id, createdAt: now },
    ]);
    await t.db.insert(codSettlementItems).values([
      { settlementId: "cod_truth_cash", shipmentId: "shp_truth_cash", amountIqd: cashOrder.totalIqd, feeIqd: 0 },
      { settlementId: "cod_truth_fees", shipmentId: "shp_truth_returned", amountIqd: 0, feeIqd: 3000 },
    ]);
    for (const id of ["cod_truth_cash", "cod_truth_fees", "cod_truth_diff"]) await audit(t.db, { actor: signed.bookkeeper.session.actor, action: "shipping.cod.submit", entityType: "cod_settlement", entityId: id, at: now });

    // returns — two to decide (the manager opened one), one received and waiting for inspection
    await t.db.insert(returns).values([
      { id: "ret_truth_mine", rma: "RMA-TRUTH001", orderId: order.orderId, status: "requested", createdAt: now },
      { id: "ret_truth_web", rma: "RMA-TRUTH002", orderId: order.orderId, status: "requested", createdAt: now },
      { id: "ret_truth_back", rma: "RMA-TRUTH003", orderId: order.orderId, status: "received", receivedAt: now, createdAt: now },
    ]);
    await audit(t.db, { actor: signed.manager.session.actor, action: "returns.rma.create", entityType: "return", entityId: "ret_truth_mine", at: now });

    // purchasing — a buyer's order above the limit and the manager's own; a posting that stopped an hour ago next to one
    // still running (its lease not over); an invoice with variances
    const buyer = await make.employee();
    await t.db.insert(suppliers).values({ id: "sup_truth", code: "SUP-TRUTH", name: "مورد للتحقق", createdAt: now, updatedAt: now });
    await t.db.insert(approvals).values([
      { id: "apv_po_truth_buyer", kind: "purchase_order", entityType: "purchase_order", entityId: "po_truth_buyer", requestedBy: buyer, status: "pending", createdAt: now },
      { id: "apv_po_truth_mine", kind: "purchase_order", entityType: "purchase_order", entityId: "po_truth_mine", requestedBy: manager.id, status: "pending", createdAt: now },
    ]);
    await t.db.insert(purchaseOrders).values([
      { id: "po_truth_buyer", ref: "PO-TRUTH-1", supplierId: "sup_truth", status: "pending_approval", locationId: DEFAULT_LOCATION_ID, approvalId: "apv_po_truth_buyer", createdBy: buyer, createdAt: now, updatedAt: now },
      { id: "po_truth_mine", ref: "PO-TRUTH-2", supplierId: "sup_truth", status: "pending_approval", locationId: DEFAULT_LOCATION_ID, approvalId: "apv_po_truth_mine", createdBy: manager.id, createdAt: now, updatedAt: now },
    ]);
    await t.db.insert(receipts).values([
      { id: "rc_truth_stopped", ref: "RC-TRUTH-1", supplierId: "sup_truth", locationId: DEFAULT_LOCATION_ID, status: "posted", receivedBy: "posting:truth-a", postedAt: now - HOUR, createdAt: now - HOUR },
      { id: "rc_truth_running", ref: "RC-TRUTH-2", supplierId: "sup_truth", locationId: DEFAULT_LOCATION_ID, status: "posted", receivedBy: "posting:truth-b", postedAt: now - MINUTE, createdAt: now - MINUTE },
    ]);
    await t.db.insert(supplierInvoices).values({ id: "inv_truth_off", supplierId: "sup_truth", invoiceNo: "INV-TRUTH-1", totalMinor: 25_000, status: "mismatch", createdAt: now });

    // finance, through the services — two top-up requests (the bookkeeper approves the large one first: it then waits for
    // a second person), the bookkeeper's adjustment request, and three drafts the bookkeeper recorded: one dated last
    // month, a demo one, and one above the limit they may not approve alone
    const customerId = await make.customer();
    await t.db.insert(walletTopups).values([
      { id: "wtu_truth_small", ref: "TU-TRUTH-1", customerId, method: "bank_transfer", amountIqd: 40_000, idempotencyKey: "truth-topup-1", createdAt: now },
      { id: "wtu_truth_big", ref: "TU-TRUTH-2", customerId, method: "zaincash", amountIqd: 900_000, idempotencyKey: "truth-topup-2", createdAt: now },
    ]);
    expect((await decideTopup(t.db, signed.bookkeeper.session.actor, { topupId: "wtu_truth_big", decision: "approve" }, now)).status).toBe("awaiting_second");
    await requestWalletAdjustment(t.db, signed.bookkeeper.session.actor, { customerId, amountIqd: 15_000, reason: "تعويض عن تأخير الشحنة", idempotencyKey: "truth-adjustment-1" }, now);
    const today = baghdadDay(now);
    const lastMonth = baghdadDay(dayStart(`${today.slice(0, 7)}-01`) - DAY_MS);
    const paid = { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash") };
    await createExpense(t.db, signed.bookkeeper.session.actor, { ...paid, amountIqd: 20_000, description: "صيانة المكيف", incurredOn: lastMonth, idempotencyKey: "truth-expense-last-month" }, now);
    await createExpense(t.db, signed.bookkeeper.session.actor, { ...paid, amountIqd: 30_000, description: "قرطاسية للعرض", incurredOn: today, idempotencyKey: "truth-expense-demo" }, now, { demo: true });
    await createExpense(t.db, signed.bookkeeper.session.actor, { ...paid, amountIqd: 900_000, description: "إيجار المخزن", incurredOn: today, idempotencyKey: "truth-expense-big" }, now);

    const shown: Record<string, Record<string, number>> = {};
    for (const [who, { session, cookies }] of Object.entries(signed)) {
      const shell = await loadAdminShell(request({ now: Date.now() }).ctx, t.db, session);
      const queues = shell.waiting.queues.filter((queue) => (NEW_QUEUES as readonly string[]).includes(queue.id));
      for (const queue of queues) expect.soft(await actionableOnPage(queue, cookies), `${who} · ${queue.id} · ${queue.href}`).toBe(queue.count);
      // every queue's module is in the employee's navigation, so the rail's beads add up to the bell
      expect(shell.waiting.queues.every((queue) => shell.modules.includes(queue.module)), who).toBe(true);
      shown[who] = Object.fromEntries(queues.map((queue) => [queue.id, queue.count]));
    }

    // The manager acts on all ten; the bookkeeper sees their two cheap drafts (last month's and the demo one) but not the
    // large one, nor their own adjustment or first approval, nor the settlement with a difference they submitted.
    expect(Object.keys(shown.manager).sort()).toEqual([...NEW_QUEUES].sort());
    expect(shown.manager.expenses - shown.bookkeeper.expenses).toBe(1);
    expect(shown.clerk).toEqual({ inspections: shown.manager.inspections, stuck_receipts: shown.manager.stuck_receipts });
    expect(shown.packer).toEqual({ failed_deliveries: shown.manager.failed_deliveries });
    // Who may not record the courier's cash is not asked to reconcile the settlement that carries it.
    expect(shown.codClerk).toEqual({ cod_settlements: shown.manager.cod_settlements - 1 });
    // Without the list to open, no queue: returns need returns.rma.read, purchase orders purchasing.po.read.
    expect(shown.returnsDecider).toEqual({});
    expect(shown.poApprover).toEqual({});
    expect(shown.costBlind).toEqual({ stuck_receipts: shown.manager.stuck_receipts });
  });

  // ── the queues of modules 06 pos, 07 customers, 13 devices, 20 security and 22 settings (integration 2026-11-11)

  const LATER_QUEUES = ["pos_shifts", "privacy_requests", "tradein_inspections", "tradein_offers", "tradein_payouts", "used_inspections", "used_listings", "signin_alerts", "access_reviews", "settings_changes"] as const;
  const LATER_PAGES: Record<string, PageLoader> = {
    "/admin/pos/shifts": shiftsPageLoader,
    "/admin/customers/privacy": privacyPageLoader,
    "/admin/devices/trade-ins": tradeInsPageLoader,
    "/admin/devices/used": usedPageLoader,
    "/admin/security/sign-ins": signInsPageLoader,
    "/admin/security/retention": retentionPageLoader,
    "/admin/settings/changes": settingChangesPageLoader,
  };

  /** How many of the rows one of these queues' links lists this employee may act on, as the module's own pages say. */
  async function actionableOnLaterPage(queue: ShellQueue, cookies: Record<string, string>): Promise<number> {
    const href = queue.href.split("#")[0];
    const list = await openPage(href, cookies, LATER_PAGES[href.split("?")[0]]);
    expect.soft(list.status, `${queue.id}: ${queue.href} opens`).toBe(200);
    const data = list.data;
    switch (queue.id) {
      case "pos_shifts": {
        // a shift is the employee's to review when its report says so (never one they opened or closed)
        let n = 0;
        for (const row of rowsAt(data, "page", "rows")) if (dig((await openPage(`/admin/pos/shifts/${String(row.id)}`, cookies, shiftReportPageLoader, { shiftId: String(row.id) })).data, "report", "canReview") === true) n++;
        return n;
      }
      case "tradein_payouts": {
        // an accepted trade-in is the employee's when its own page lets them act on it: the data wipe, or the payout with
        // nothing in its way but where the unit goes — never "the wipe comes first", never their own offer that only a
        // second person may pay (the page's payoutBlockers)
        let n = 0;
        for (const row of rowsAt(data, "page", "rows")) {
          const page = await openPage(`/admin/devices/trade-ins/${String(row.ref)}`, cookies, tradeInPageLoader, { ref: String(row.ref) });
          expect.soft(page.status, `${queue.id}: the page of ${String(row.ref)} opens`).toBe(200);
          const can = (dig(page.data, "ti", "can") ?? {}) as Row;
          const blockers = (dig(page.data, "ti", "payoutBlockers") ?? []) as string[];
          if (can.wipe === true || (can.payout === true && !blockers.some((blocker) => blocker === "payout_wipe_required" || blocker === "payout_second_person"))) n++;
        }
        return n;
      }
      case "privacy_requests":
      case "tradein_inspections":
      case "tradein_offers":
      case "used_inspections":
      case "used_listings":
        return Number(dig(data, "page", "total") ?? 0);
      case "signin_alerts":
        return rowsAt(data, "overview", "alerts").length;
      case "access_reviews":
        return rowsAt(data, "roles").filter((row) => row.reviewDue === true).length;
      case "settings_changes":
        return rowsAt(data, "pending").filter((row) => row.canDecide === true).length;
      default:
        throw new Error(`no page check for ${queue.id}`);
    }
  }

  test("pos, customers, devices, security and settings queues: the module's own count, only for whoever acts and may open the list, never their own — exactly what the link lists", async () => {
    const now = Date.now();
    const manager = await staff("manager");
    const bookkeeper = await staff("finance");
    const clerk = await staff("inventory");
    const cashier = await staff("cashier");
    // Roles an owner could make: a till supervisor who also works a till; who confirms ownership but cannot open the
    // trade-ins (and one who can); settings approvers with and without settings.read; an access reviewer; a log reader.
    const supervisor = await employeeWith(["pos.shift.review", "pos.shift.open", "pos.shift.close"]);
    const verifier = await employeeWith(["devices.ownership.verify"]);
    const payer = await employeeWith(["devices.ownership.verify", "devices.tradein.read"]);
    const approver = await employeeWith(["settings.change.approve", "settings.read", "settings.manage"]);
    const blindApprover = await employeeWith(["settings.change.approve", "settings.manage"]);
    const reviewer = await employeeWith(["security.access_review.perform"]);
    const watcher = await employeeWith(["security.auth_event.read"]);
    const people = { manager, bookkeeper, clerk, cashier, supervisor, verifier, payer, approver, blindApprover, reviewer, watcher };
    const signed: Record<string, { session: EmployeeSession; cookies: Record<string, string> }> = { owner: await signedIn(OWNER.email, OWNER.password, now) };
    for (const [who, person] of Object.entries(people)) signed[who] = await signedIn(person.email, person.password, now);
    const tag = make.next("later").replace(/[^a-z0-9]/gi, "_");
    const TAG = tag.replace(/_/g, "").toUpperCase();

    // pos — counted drawers: short (a cashier's), the supervisor's own, one the supervisor closed, one with no difference,
    // one already approved; and an open drawer
    const till = await make.employee();
    const register = `reg_${tag}`;
    await t.db.insert(posRegisters).values({ id: register, code: `R-${TAG}`, name: "صندوق للاختبار", createdAt: now });
    const counted = (suffix: string, openedBy: string, closedBy: string, varianceIqd: number, approvedBy: string | null = null) => ({
      id: `sh_${tag}_${suffix}`,
      registerId: register,
      openedBy,
      openedAt: now - 9 * HOUR,
      openingFloatIqd: 50_000,
      closedBy,
      closedAt: now - HOUR,
      countedCashIqd: 150_000 + varianceIqd,
      expectedCashIqd: 150_000,
      varianceIqd,
      status: "closed" as const,
      varianceReason: varianceIqd ? "فرق في العد" : null,
      approvedBy,
    });
    await t.db.insert(posShifts).values([
      counted("short", till, till, -5000),
      counted("mine", supervisor.id, supervisor.id, 2000),
      counted("closed", till, supervisor.id, 1000),
      counted("even", till, till, 0),
      counted("done", till, till, 3000, manager.id),
      { id: `sh_${tag}_open`, registerId: register, openedBy: till, openedAt: now - HOUR, openingFloatIqd: 50_000, status: "open" },
    ]);

    // customers — two open privacy requests (one past its due date) and a finished one
    const phone = "+9647701234567";
    await t.db.insert(privacyRequests).values([
      { id: `pr_${tag}_a`, ref: `PR-${TAG}A`, phoneE164: phone, kind: "export", status: "open", dueAt: now + 10 * DAY_MS, createdAt: now },
      { id: `pr_${tag}_b`, ref: `PR-${TAG}B`, phoneE164: phone, kind: "delete", status: "verifying", dueAt: now - DAY_MS, createdAt: now - 31 * DAY_MS },
      { id: `pr_${tag}_c`, ref: `PR-${TAG}C`, phoneE164: phone, kind: "unsubscribe", status: "completed", completedAt: now, createdAt: now - DAY_MS },
    ]);

    // devices — two trade-ins to inspect (one booked), one inspected, an open offer (the customer decides), one accepted,
    // one paid; used units: two to inspect, one ready
    // (a reference the trade-in's page accepts: TI- and 8 of 2–9 / A–Z without I and O)
    const tradeIn = (suffix: string, status: (typeof tradeIns.$inferInsert)["status"], extra: Partial<typeof tradeIns.$inferInsert> = {}) => ({ id: `ti_${tag}_${suffix}`, ref: tradeInRef(), phoneE164: phone, status, createdAt: now, updatedAt: now, ...extra });
    // an offer exists only after an inspection, made by a person (the database's offer guard)
    const inspected = { checklist: { templateId: null, completedAt: now - DAY_MS, completedBy: manager.id, items: [{ key: "power", result: "pass" as const }] }, grade: "B" as const, inspectedBy: manager.id, inspectedAt: now - DAY_MS };
    const offered = (amountIqd: number, offeredAt: number, offerExpiresAt: number) => ({ finalOfferIqd: amountIqd, offeredBy: manager.id, offeredAt, offerExpiresAt, inspection: inspected });
    await t.db.insert(tradeIns).values([
      tradeIn("new", "submitted"),
      tradeIn("booked", "inspection_scheduled", { inspectionScheduledAt: now + DAY_MS }),
      tradeIn("insp", "inspected", { inspection: inspected }),
      tradeIn("offer", "offered", offered(200_000, now, now + 3 * DAY_MS)),
      tradeIn("acc", "accepted", { ...offered(180_000, now - DAY_MS, now + DAY_MS), acceptedAt: now, payoutMethod: "cash" }),
      tradeIn("paid", "paid", { ...offered(150_000, now - 2 * DAY_MS, now + DAY_MS), paidAt: now }),
    ]);
    const product = await make.product({ priceIqd: 300_000, stock: 0 });
    const unit = (suffix: string, status: "intake" | "testing" | "ready") => ({ id: `uu_${tag}_${suffix}`, slug: `used-${tag}-${suffix}`.replace(/_/g, "-"), variantId: product.variantId, grade: "B" as const, priceIqd: 250_000, status, createdAt: now, updatedAt: now });
    await t.db.insert(usedUnits).values([unit("in", "intake"), unit("test", "testing"), unit("ready", "ready")]);

    // security — a lockout an hour ago (and one from two days ago, outside the alerts' 24 hours)
    await t.db.insert(authEvents).values([
      { id: `aev_${tag}_now`, subjectKind: "employee", kind: "lockout", success: false, identifier: `locked-${tag}@shell.test`, ip: "198.51.100.7", at: now - HOUR },
      { id: `aev_${tag}_old`, subjectKind: "employee", kind: "lockout", success: false, identifier: `old-${tag}@shell.test`, ip: "198.51.100.8", at: now - 2 * DAY_MS },
    ]);

    // settings — a request by the manager, one by the approver, one that expired
    const settingRequest = (suffix: string, key: string, requestedBy: string, expiresAt: number) => ({ id: `apv_${tag}_${suffix}`, kind: "settings", entityType: "setting", entityId: key, requestedBy, payload: { value: 1500, before: 1000 }, reason: "تجربة", status: "pending" as const, createdAt: now - HOUR, expiresAt });
    await t.db.insert(approvals).values([
      settingRequest("theirs", "pricing.drop_approval_bps", manager.id, now + 13 * DAY_MS),
      settingRequest("mine", "purchasing.po_approval_limit_iqd", approver.id, now + 13 * DAY_MS),
      settingRequest("late", "finance.topup_second_approval_iqd", manager.id, now - MINUTE),
    ]);

    const shown: Record<string, Record<string, number>> = {};
    let ownerQueues: ShellQueue[] = [];
    for (const [who, { session, cookies }] of Object.entries(signed)) {
      const shell = await loadAdminShell(request({ now: Date.now() }).ctx, t.db, session);
      const queues = shell.waiting.queues.filter((queue) => (LATER_QUEUES as readonly string[]).includes(queue.id));
      for (const queue of queues) expect.soft(await actionableOnLaterPage(queue, cookies), `${who} · ${queue.id} · ${queue.href}`).toBe(queue.count);
      // every queue's module is in the employee's navigation, so the rail's beads add up to the bell
      expect(shell.waiting.queues.every((queue) => shell.modules.includes(queue.module)), who).toBe(true);
      expect(shell.waiting.total, who).toBe(shell.waiting.queues.reduce((sum, queue) => sum + queue.count, 0));
      shown[who] = Object.fromEntries(queues.map((queue) => [queue.id, queue.count]));
      if (who === "owner") ownerQueues = queues;
    }

    // The owner acts on all ten, each opening its module's own queue screen and carrying its module's bead.
    expect(ownerQueues.map((queue) => [queue.id, queue.module, queue.href])).toEqual([
      ["pos_shifts", "pos", "/admin/pos/shifts?state=review"],
      ["privacy_requests", "customers", "/admin/customers/privacy"],
      ["tradein_inspections", "devices", "/admin/devices/trade-ins?view=new"],
      ["tradein_offers", "devices", "/admin/devices/trade-ins?view=inspected"],
      ["tradein_payouts", "devices", "/admin/devices/trade-ins?view=accepted"],
      ["used_inspections", "devices", "/admin/devices/used?view=todo"],
      ["used_listings", "devices", "/admin/devices/used?view=ready"],
      ["signin_alerts", "security", "/admin/security/sign-ins?window=24h"],
      ["access_reviews", "security", "/admin/security/retention#reviews"],
      ["settings_changes", "settings", "/admin/settings/changes"],
    ]);
    expect(shown.owner).toMatchObject({ pos_shifts: 3, privacy_requests: 2, tradein_inspections: 2, tradein_offers: 1, tradein_payouts: 1, used_inspections: 2, used_listings: 1, settings_changes: 2 });
    expect(shown.owner.signin_alerts).toBeGreaterThanOrEqual(1);
    expect(shown.owner.access_reviews).toBeGreaterThanOrEqual(DEFAULT_ROLES.length);
    // The manager runs the shop floor (no access reviews, no settings approvals: the owner's); finance reviews drawers;
    // the stock clerk inspects used units; a cashier none of these.
    expect(shown.manager).toEqual({ pos_shifts: 3, privacy_requests: 2, tradein_inspections: 2, tradein_offers: 1, tradein_payouts: 1, used_inspections: 2, used_listings: 1, signin_alerts: shown.owner.signin_alerts });
    expect(shown.bookkeeper).toEqual({ pos_shifts: 3 });
    expect(shown.clerk).toEqual({ used_inspections: 2 });
    expect(shown.cashier).toEqual({});
    // Never their own: the supervisor neither reviews the drawer they opened nor the one they closed.
    expect(shown.supervisor).toEqual({ pos_shifts: 1 });
    // The wipe and payout are listed on the trade-ins, which ownership.verify alone cannot open.
    expect(shown.verifier).toEqual({});
    expect(shown.payer).toEqual({ tradein_payouts: 1 });
    // Not their own request, not an expired one; without settings.read no queue (the list is behind it).
    expect(shown.approver).toEqual({ settings_changes: 1 });
    expect(shown.blindApprover).toEqual({});
    expect(shown.reviewer).toEqual({ access_reviews: shown.owner.access_reviews });
    expect(shown.watcher).toEqual({ signin_alerts: shown.owner.signin_alerts });
  });

  test("a new module whose count fails hides only its own queues: the devices queues go, the others stay, it is logged", async () => {
    const owner = (await signedIn(OWNER.email, OWNER.password, Date.now())).session;
    const healthy = (await loadAdminShell(request({ now: Date.now() }).ctx, t.db, owner)).waiting;
    expect(healthy.queues.filter((queue) => queue.module === "devices").length).toBeGreaterThan(0);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    failing.devices = true;
    try {
      const waiting = (await loadAdminShell(request({ now: Date.now() }).ctx, t.db, owner)).waiting;
      const others = healthy.queues.filter((queue) => queue.module !== "devices");
      expect(waiting.queues).toEqual(others);
      expect(others.map((queue) => queue.id)).toEqual(expect.arrayContaining(["pos_shifts", "privacy_requests", "settings_changes"]));
      expect(waiting.total).toBe(others.reduce((sum, queue) => sum + queue.count, 0));
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("devices"), expect.any(Error));
    } finally {
      failing.devices = false;
      logged.mockRestore();
    }
  });

  test("the layout counts on the request's clock (ctx.now): the link's days and what has expired are the request's, not the server's", async () => {
    const owner = (await signedIn(OWNER.email, OWNER.password, Date.now())).session;
    // A request whose clock is far from the server's: a draft expense of that day, and a settings request that expires
    // an hour before it.
    const later = Date.UTC(2027, 5, 15, 9, 0, 0);
    const [expenseAccount] = await t.db.select({ id: accounts.id }).from(accounts).where(eq(accounts.type, "expense")).limit(1);
    await t.db.insert(expenses).values({ id: "exp_shell_clock", accountId: expenseAccount.id, amountIqd: 12_000, description: "مصروف بتاريخ الطلب", incurredOn: baghdadDay(later), period: baghdadDay(later).slice(0, 7), createdBy: null, createdAt: later });
    await t.db.insert(approvals).values({ id: "apv_shell_clock", kind: "settings", entityType: "setting", entityId: "returns.window_days", requestedBy: await make.employee(), payload: { value: 10, before: 14 }, reason: "تجربة الساعة", status: "pending", createdAt: later - DAY_MS, expiresAt: later - HOUR });
    const waitingAt = async (now: number) => Object.fromEntries((await loadAdminShell(request({ now }).ctx, t.db, owner)).waiting.queues.map((queue) => [queue.id, queue]));
    const at = await waitingAt(later);
    expect(at.expenses?.href).toContain(`&to=${baghdadDay(later)}&`);
    const before = await waitingAt(later - 2 * HOUR);
    // two hours earlier the request was still open: the owner was asked to decide it then, not any more
    expect((before.settings_changes?.count ?? 0) - (at.settings_changes?.count ?? 0)).toBe(1);
  });

  test("trade-in payouts: only what the employee can do there — the wipe for whoever confirms it, the payout once wiped, never their own offer that needs a second payer", async () => {
    const now = Date.now();
    // the manager who made the offers below (every devices permission), another manager, a payer who cannot confirm a
    // wipe, a checker who cannot pay
    const offerer = await staff("manager");
    const colleague = await staff("manager");
    const payer = await employeeWith(["devices.tradein.payout", "devices.tradein.read"]);
    const checker = await employeeWith(["devices.ownership.verify", "devices.tradein.read"]);
    const signed: Record<string, { session: EmployeeSession; cookies: Record<string, string> }> = { owner: await signedIn(OWNER.email, OWNER.password, now) };
    for (const [who, person] of Object.entries({ offerer, colleague, payer, checker })) signed[who] = await signedIn(person.email, person.password, now);
    const payouts = async (who: string) => (await loadAdminShell(request({ now: Date.now() }).ctx, t.db, signed[who].session)).waiting.queues.find((queue) => queue.id === "tradein_payouts");
    const before: Record<string, number> = {};
    for (const who of Object.keys(signed)) before[who] = (await payouts(who))?.count ?? 0;

    // Four accepted trade-ins, each offered on the guide's suggestion of 200,000 (the latest `offered` event, as payOut
    // reads it): A within the guide, not wiped yet; B above the guide, wiped (only a second person may pay it); C within
    // the guide, wiped (its offerer may pay it); D above the guide but the colleague's offer, wiped.
    const tag = make.next("payout").replace(/[^a-z0-9]/gi, "_");
    const inspection = { checklist: { templateId: null, completedAt: now - DAY_MS, completedBy: offerer.id, items: [{ key: "power", result: "pass" as const }] }, grade: "B" as const, inspectedBy: offerer.id, inspectedAt: now - DAY_MS };
    const accepted = (suffix: string, by: string, amountIqd: number, wiped: boolean) => ({
      id: `ti_${tag}_${suffix}`,
      ref: tradeInRef(),
      phoneE164: "+9647701239876",
      status: "accepted" as const,
      inspection,
      ownershipOk: true,
      accountLockOk: true,
      dataWiped: wiped,
      finalOfferIqd: amountIqd,
      offeredBy: by,
      offeredAt: now - DAY_MS,
      offerExpiresAt: now + 2 * DAY_MS,
      acceptedAt: now - HOUR,
      payoutMethod: "cash" as const,
      createdAt: now - 2 * DAY_MS,
      updatedAt: now - HOUR,
    });
    const rows = [accepted("a", offerer.id, 180_000, false), accepted("b", offerer.id, 250_000, true), accepted("c", offerer.id, 190_000, true), accepted("d", colleague.id, 260_000, true)];
    await t.db.insert(tradeIns).values(rows);
    await t.db.insert(tradeInEvents).values(rows.map((row) => ({ id: `tie_${row.id}`, tradeInId: row.id, kind: "offered", data: { amountIqd: row.finalOfferIqd, suggestedIqd: 200_000, grade: "B" }, actorKind: "employee" as const, actorId: row.offeredBy, at: row.offeredAt })));

    const added: Record<string, number> = {};
    for (const who of Object.keys(signed)) {
      const queue = await payouts(who);
      added[who] = (queue?.count ?? 0) - before[who];
      // exactly what the trade-ins' own pages let this employee do
      if (queue) expect(await actionableOnLaterPage(queue, signed[who].cookies), who).toBe(queue.count);
    }
    expect(added).toEqual({
      // the owner holds every permission and made none of these offers
      owner: 4,
      // A (wipe), C (their own offer, within the guide), D (the colleague's) — never B, their own above the guide
      offerer: 3,
      // the colleague may wipe A and pay B and C; D is their own offer above the guide
      colleague: 3,
      // wiped ones only: B, C, D
      payer: 3,
      // the wipe only: A
      checker: 1,
    });
  });

  test("speed: every module is asked at once, and the shell reads the same however much waits (no list to count, no query per row)", async () => {
    const owner = (await signedIn(OWNER.email, OWNER.password, Date.now())).session;
    const recording = recordingD1(t.d1);
    const db = createDb(recording.d1);
    const read = async () => {
      recording.log.length = 0;
      const waiting = await loadWaiting(db, owner);
      return { waiting, statements: recording.log.map((entry) => ({ ...entry })) };
    };
    const countOf = (waiting: ShellWaiting, id: string) => waiting.queues.find((queue) => queue.id === id)?.count ?? 0;
    const rowsRead = (statements: Recorded[]) => statements.reduce((sum, entry) => sum + entry.rows, 0);

    const now = Date.now();
    const product = await make.product({ priceIqd: 10_000, stock: 1 });
    const order = await make.order([{ ...product, qty: 1 }]);
    const customerId = await make.customer();
    await t.db.insert(carriers).values({ id: "car_rows", code: "ROWS-CAR", name: "شركة شحن للقراءة", createdAt: now });
    await t.db.insert(codSettlements).values({ id: "cod_rows", ref: "COD-ROWS-1", carrierId: "car_rows", status: "submitted", createdBy: null, createdAt: now });

    const before = await read();
    // All at once: before any statement came back, the shell's batch and the first query of every module's count had been
    // sent (pricing, shipping both, purchasing all three, the wallet's two, the settings returns and expenses read first).
    const firstBack = Math.min(...before.statements.map((entry) => entry.finishedAt ?? Infinity));
    const firstWave = before.statements.filter((entry) => entry.startedAt < firstBack);
    const sent = (pattern: RegExp, param?: string) => firstWave.some((entry) => pattern.test(entry.sql) && (param === undefined || entry.params.includes(param)));
    expect(sent(/^batch$/)).toBe(true);
    for (const pattern of [/"price_changes"/, /"shipments"/, /cod_settlements/, /purchase_orders/, /FROM receipts/, /supplier_invoices/, /wallet_topups/, /wallet_adjustment/]) expect(sent(pattern), String(pattern)).toBe(true);
    expect(sent(/"settings"/, "returns.sla")).toBe(true);
    expect(sent(/"settings"/, "finance.expense_second_approval_iqd")).toBe(true);
    // …and the later modules' (pos, customers, devices — trade-ins and used units —, security's alerts and reviews,
    // settings' requests), never one after the other
    for (const pattern of [/"pos_shifts"/, /"privacy_requests"/, /"trade_ins"/, /"used_units"/, /FROM auth_events/, /security\.access_review\.complete/]) expect(sent(pattern), String(pattern)).toBe(true);
    expect(sent(/"approvals"/, "settings")).toBe(true);
    // …and wave D's (2026-11-12): promotions' requests, support's tickets, staff's leave and advances (counted with the
    // staff module's other queues — review 2026-11-12: one module, one failure), the operations counts, the content
    // module's policies
    expect(sent(/"approvals"/, "coupon")).toBe(true);
    expect(sent(/"approvals"/, "staff_advance")).toBe(true);
    for (const pattern of [/FROM support_tickets/, /"leave_requests"/, /consistency_findings|job_runs|FROM incidents/, /FROM pages/]) expect(sent(pattern), String(pattern)).toBe(true);

    // Much more waits: 60 hand corrections on a settlement, 30 failed deliveries, 30 top-up requests.
    for (let i = 0; i < 60; i++) await audit(t.db, { actor: { kind: "employee", id: `emp_rows_${i % 3}`, permissions: [] }, action: "shipping.cod.item", entityType: "cod_settlement", entityId: "cod_rows", at: now });
    // (ten rows per insert: D1 binds at most 100 values to one statement)
    for (let from = 0; from < 30; from += 10) {
      await t.db.insert(shipments).values(Array.from({ length: 10 }, (_, i) => ({ id: `shp_rows_${from + i}`, orderId: order.orderId, status: "failed" as const, createdAt: now, updatedAt: now })));
      await t.db.insert(walletTopups).values(Array.from({ length: 10 }, (_, i) => ({ id: `wtu_rows_${from + i}`, ref: `TU-ROWS-${from + i}`, customerId, method: "cash" as const, amountIqd: 10_000, idempotencyKey: `rows-topup-${from + i}`, createdAt: now })));
    }

    const after = await read();
    expect(countOf(after.waiting, "failed_deliveries")).toBe(countOf(before.waiting, "failed_deliveries") + 30);
    expect(countOf(after.waiting, "topups")).toBe(countOf(before.waiting, "topups") + 30);
    expect(countOf(after.waiting, "cod_settlements")).toBe(countOf(before.waiting, "cod_settlements"));
    expect(after.statements.length).toBe(before.statements.length);
    expect(rowsRead(after.statements)).toBe(rowsRead(before.statements));
  });

  test("words: every queue's notice is in Arabic with all six plural forms and in English and Sorani with one and other", () => {
    const formsOf = (locale: "ar" | "en" | "ckb", id: string) => Object.keys(((adminMessages[locale].notices as Record<string, unknown>)[id] ?? {}) as object).sort();
    for (const id of Object.keys(QUEUE_HREF)) {
      expect(formsOf("ar", id), `ar ${id}`).toEqual(["few", "many", "one", "other", "two", "zero"]);
      for (const locale of ["en", "ckb"] as const) expect(formsOf(locale, id), `${locale} ${id}`).toEqual(["one", "other"]);
    }
  });
});

// ───────────────────────────────────────────────────────────────── My security, sign-out, language

describe("My security", () => {
  test("sessions: list with devices, end another one, not this one through that form, sign the others out", async () => {
    const person = await staff("content");
    const at = NOW + 12 * HOUR;
    const laptop = await signedIn(person.email, person.password, at);
    const phone = await signedIn(person.email, person.password, at + 1000);
    const tablet = await signedIn(person.email, person.password, at + 2000);
    const req = request({ cookies: laptop.cookies, now: at + MINUTE });
    const session = (await getEmployee(req.ctx, t.db))!;
    const page = await loadMySecurity(req.ctx, t.db, session);
    expect(page.sessions).toHaveLength(3);
    expect(page.sessions.filter((entry) => entry.current).map((entry) => entry.id)).toEqual([session.session.id]);
    expect(page.sessions[0].device).toEqual({ browser: "Chrome", system: "Windows" });
    expect(JSON.stringify(page)).not.toContain(laptop.cookies.tt_adm);

    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "revoke", sessionId: session.session.id }))).toMatchObject({ ok: false, code: "invalid" });
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "revoke", sessionId: phone.session.session.id }))).toEqual({ ok: true, intent: "revoke", ended: true });
    expect(await getEmployee(request({ cookies: phone.cookies, now: at + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "revoke-others" }))).toEqual({ ok: true, intent: "revoke-others" });
    expect(await getEmployee(request({ cookies: tablet.cookies, now: at + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: laptop.cookies, now: at + 2 * MINUTE }).ctx, t.db)).not.toBeNull();
    // Someone else's session id is not "another one of mine".
    const other = await signedIn(OWNER.email, OWNER.password, at);
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "revoke", sessionId: other.session.session.id }))).toEqual({ ok: true, intent: "revoke", ended: false });
    expect(await getEmployee(request({ cookies: other.cookies, now: at + 2 * MINUTE }).ctx, t.db)).not.toBeNull();
  });

  test("password: the confirmation must match, the current password is checked, success signs the others out", async () => {
    const person = await staff("fulfillment");
    const at = NOW + 13 * HOUR;
    const here = await signedIn(person.email, person.password, at);
    const elsewhere = await signedIn(person.email, person.password, at);
    const req = request({ cookies: here.cookies, now: at + MINUTE });
    const session = (await getEmployee(req.ctx, t.db))!;
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "password", currentPassword: person.password, newPassword: "a-brand-new-password", confirmPassword: "a-brand-new-passwordx" }))).toMatchObject({ ok: false, fields: { confirmPassword: expect.any(String) } });
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "password", currentPassword: "not-my-password", newPassword: "a-brand-new-password", confirmPassword: "a-brand-new-password" }))).toMatchObject({ ok: false, fields: { currentPassword: expect.any(String) } });
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "password", currentPassword: person.password, newPassword: "a-brand-new-password", confirmPassword: "a-brand-new-password" }))).toEqual({ ok: true, intent: "password" });
    expect(await getEmployee(request({ cookies: elsewhere.cookies, now: at + 2 * MINUTE }).ctx, t.db)).toBeNull();
    // This device stays signed in on the new token the change set; its old cookie (and any copy of it) no longer works.
    expect(await getEmployee(request({ cookies: cookiesAfter(req, here.cookies), now: at + 2 * MINUTE }).ctx, t.db)).not.toBeNull();
    expect(await getEmployee(request({ cookies: here.cookies, now: at + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await mySecurityAction(req.ctx, t.db, session, secrets, form({ intent: "nonsense" }))).toMatchObject({ ok: false, intent: null });
  });

  test("sign-out: this device, or every device; the language switch keeps the page and stays inside the admin", async () => {
    const person = await staff("support");
    const at = Date.now();
    const a = await signedIn(person.email, person.password, at);
    const b = await signedIn(person.email, person.password, at);
    const post = (path: string, cookies: Record<string, string>, body: Record<string, string>) =>
      new Request(`http://localhost:5173${path}`, { method: "POST", headers: { Origin: "http://localhost:5173", Cookie: cookieHeader(cookies), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

    const out = post("/admin/logout", a.cookies, { scope: "all" });
    const signedOut = (await throughRoot(out, async (context, url) => signOutAction({ request: out, context, url, pattern: "admin/logout", params: {} } as Parameters<typeof signOutAction>[0]))) as Response;
    expect(described(signedOut)).toMatchObject({ status: 302, location: "/admin/login?signed_out=all", reload: "true" });
    expect(signedOut.headers.getSetCookie().filter((cookie) => cookie.startsWith("tt_adm=")).every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    const live = await t.db.select().from(employeeSessions).where(eq(employeeSessions.employeeId, person.id));
    expect(live.every((row) => row.revokedAt !== null)).toBe(true);
    expect(b.session.session.id).toBeTruthy();

    // A cross-site POST never reaches the action.
    const forged = new Request("http://localhost:5173/admin/logout", { method: "POST", headers: { Origin: "https://evil.example" }, body: new URLSearchParams({ scope: "all" }) });
    expect(described(await throughRoot(forged, async () => new Response("reached")))).toMatchObject({ status: 403 });

    const switchTo = async (back: string) => {
      const req = post("/admin/locale", {}, { locale: "en", back });
      return (await throughRoot(req, async (context, url) => languageAction({ request: req, context, url, pattern: "admin/locale", params: {} } as Parameters<typeof languageAction>[0]))) as Response;
    };
    const english = await switchTo("/admin/orders?status=new");
    expect(described(english)).toMatchObject({ status: 302, location: "/admin/orders?status=new", reload: "true" });
    expect(english.headers.getSetCookie().find((cookie) => cookie.startsWith("tt_admin_locale="))).toMatch(/^tt_admin_locale=en; Path=\/; Max-Age=31536000; HttpOnly; SameSite=Lax$/);
    expect(described(await switchTo("/admin/login?next=%2Fadmin%2Fme")).location).toBe("/admin/login?next=%2Fadmin%2Fme");
    expect(described(await switchTo("//evil.example")).location).toBe("/admin");
    expect(described(await switchTo("https://evil.example/admin")).location).toBe("/admin");
  });
});
