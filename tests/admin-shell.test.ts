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
import { afterAll, beforeAll, describe, expect, test } from "vitest";
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
import { initialsOf, loadAdminShell } from "~/routes/admin/shell/shell.server";
import { summarizeUserAgent } from "~/routes/admin/shell/ua";
import type { EmployeeActor } from "~/server/actor";
import { getEmployee, signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword, toBase64Url, totpCode } from "~/server/crypto.server";
import { cycleCounts, employeeRoles, employees, employeeSessions, inventoryLocations, priceChanges, refunds, roles, stockTransfers, variants } from "~/server/db/schema";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { DEFAULT_ROLES, PERMISSION_DEFS, PERMISSIONS, roleId, type DefaultRoleKey } from "~/server/permissions";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

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

const OWNER = { name: "صاحب المتجر", email: "owner@shell.test", password: "a-long-owner-password-1" };

async function staff(role: DefaultRoleKey, password = "staff-password-1234") {
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(role)}@shell.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password };
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
    expect(ownerShell.waiting.queues.map((queue) => [queue.id, queue.count])).toEqual([["proofs", 1], ["refunds", 1]]);
    // each queue opens its module's own queue screen
    expect(ownerShell.waiting.queues.map((queue) => queue.href)).toEqual(["/admin/orders/proofs", "/admin/orders/refunds"]);
    expect(ownerShell.waiting.total).toBe(2);
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
    await t.db.insert(inventoryLocations).values({ id: "loc_shell_shop", code: "SHELL-SHOP", name: "متجر الاختبار", kind: "shop" });
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
