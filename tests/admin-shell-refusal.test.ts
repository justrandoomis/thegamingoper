/**
 * The admin gate's refusal, inside the admin frame (polish round, 2026-11-13).
 *
 * A refusal thrown by the gate (middleware, before any loader) renders in the ROOT error boundary — React Router's
 * rule for errors thrown before next() — which has no admin frame: staff got a bare page. Now the refusal is RETURNED
 * by how the request came, while WHO is refused does not change:
 *
 *   · a page the browser opened itself (GET/HEAD, Sec-Fetch-Dest: document) → 302 to /admin/denied?module=…&from=…,
 *     the shell's page that answers 403 inside the frame (shell/denied.tsx)
 *   · a client navigation's data request (Sec-Fetch-Dest: empty) → the 403 with the frame's data and words, which the
 *     layout's error boundary needs (it gets none of the layout's own loader data then)
 *   · everything else (a form, a script without fetch metadata) → the plain 403, as before
 *
 * Proved here: across a matrix of roles × route patterns (every module's routes, the cross-group pages, the shell's
 * pages, an unmapped route), the four ways of asking are refused for exactly the same (role, pattern) pairs, nothing
 * below the gate runs for any of them, and the refusal page itself only says what the gate decided.
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { adminModuleRoutes } from "~/routes/admin/_routes";
import { loader as deniedLoader } from "~/routes/admin/shell/denied";
import { adminGate, deniedPath, DENIED_PATH, gateAllows, gateRuleOf, isDataFetch, isDocumentNavigation } from "~/routes/admin/shell/gate.server";
import { canSeeModule } from "~/routes/admin/shell/access.server";
import { ADMIN_MODULE_SLUGS } from "~/routes/admin/shell/modules";
import { adminNextPath } from "~/routes/admin/shell/next.server";
import { getEmployee, signInEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { employeeRoles, rolePermissions, roles } from "~/server/db/schema";
import { roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;
beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, TEST_NOW);
  await seedRoles(t.db, TEST_NOW);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── helpers

let requestCount = 0;
function requestCtx(cookies: Record<string, string> = {}, now = Date.now()): { ctx: RequestCtx; setCookies: string[] } {
  const n = ++requestCount;
  const jar = new Map(Object.entries(cookies));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `refusal-${n}`,
    nonce: "test-nonce",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now,
    ip: `198.18.${Math.floor(n / 250)}.${n % 250}`,
    country: "IQ",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => void setCookies.push(serialized),
  };
  return { ctx, setCookies };
}

function adminCookie(setCookies: string[]): string {
  let value = "";
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    if (pair.startsWith("tt_adm=")) value = decodeURIComponent(pair.slice("tt_adm=".length));
  }
  return value;
}

type Person = { label: string; cookies: Record<string, string> };

/** An employee holding a built-in role, or exactly these permissions through a role of their own; signed in now. */
async function person(label: string, grant: { role: DefaultRoleKey } | { permissions: readonly Permission[] }): Promise<Person> {
  const password = "refusal-password-1234";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("refusal")}@refusal.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations, name: "موظف الرفض" });
  if ("role" in grant) await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(grant.role) });
  else {
    const role = `rol_${make.next("refusal").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: role, key: role, name: { ar: "دور للاختبار", en: "Test role" }, createdAt: TEST_NOW });
    if (grant.permissions.length) await t.db.insert(rolePermissions).values(grant.permissions.map((permission) => ({ roleId: role, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: role });
  }
  // the root middleware stamps requests with the real clock: a session signed in now
  const signed = requestCtx();
  await signInEmployee(signed.ctx, t.db, { email, password });
  return { label, cookies: { tt_adm: adminCookie(signed.setCookies) } };
}

type Way = "plain" | "document" | "data" | "post";
const WAYS: readonly Way[] = ["plain", "document", "data", "post"];

function adminRequest(path: string, cookies: Record<string, string>, way: Way): Request {
  const headers: Record<string, string> = { cookie: Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ") };
  if (way === "document") Object.assign(headers, { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" });
  if (way === "data") Object.assign(headers, { "sec-fetch-dest": "empty", "sec-fetch-mode": "cors", "sec-fetch-site": "same-origin" });
  if (way === "post") Object.assign(headers, { origin: ORIGIN, "sec-fetch-site": "same-origin" });
  return new Request(`${ORIGIN}${path}`, way === "post" ? { method: "POST", headers, body: new URLSearchParams({ intent: "anything" }) } : { headers });
}

/** Runs the gate behind the real root middleware; `ran` says whether anything below it was called. */
async function viaGate(req: Request, pattern: string): Promise<{ outcome: unknown; ran: boolean }> {
  let ran = false;
  const context = new RouterContextProvider();
  const url = new URL(req.url);
  let outcome: unknown;
  try {
    outcome = await requestContextMiddleware({ request: req, context, url, pattern: "/", params: {} }, async () =>
      (await adminGate({ request: req, context, url, pattern, params: {} }, async () => {
        ran = true;
        return new Response("<p>module page</p>", { headers: { "Content-Type": "text/html" } });
      })) as Response,
    );
  } catch (error) {
    outcome = error;
  }
  return { outcome, ran };
}

/** Status, data and Location of a thrown/returned Response or `data()` value. */
function described(value: unknown): { status: number; data?: Record<string, unknown>; location?: string | null; headers?: Headers } {
  if (value instanceof Response) return { status: value.status, location: value.headers.get("Location"), headers: value.headers };
  const init = (value as { type?: string; init?: { status?: number; headers?: HeadersInit }; data?: Record<string, unknown> }) ?? {};
  if (init.type === "DataWithResponseInit") return { status: init.init?.status ?? 200, data: init.data, headers: new Headers(init.init?.headers) };
  throw new Error(`Not a response: ${String(value)}`);
}

/** Every route pattern of the authenticated admin layout, from the route config (as React Router matches them). */
function layoutPatterns(): string[] {
  const out: string[] = [];
  const walk = (entries: typeof adminModuleRoutes, base: string) => {
    for (const entry of entries) {
      const path = entry.index ? base : entry.path ? `${base}/${entry.path}` : base;
      out.push(path);
      if (entry.children) walk(entry.children, path);
    }
  };
  walk(adminModuleRoutes, "admin");
  return [...new Set(out)];
}

/** A concrete URL path for a pattern (":ref" → "x", "*" → "x"). */
const pathOf = (pattern: string) => `/${pattern.replace(/:[A-Za-z]+\??/g, "x").replace(/\*/g, "x")}`;

// ───────────────────────────────────────────────────────────────── the matrix

describe("the gate refuses exactly the same requests, whichever way the refusal is returned", () => {
  let people: Person[];
  beforeAll(async () => {
    people = [
      await person("cashier", { role: "cashier" }),
      await person("support", { role: "support" }),
      await person("inventory", { role: "inventory" }),
      await person("content", { role: "content" }),
      // a role an owner made: staff and roles only (module 20's role editor opens for it — ALSO_OPENED_BY)
      await person("staff.manage", { permissions: ["staff.manage", "dashboard.overview.read"] }),
      // an account without any role
      await person("no role", { permissions: [] }),
    ];
  }, 120_000);

  test("every module's routes, the cross-group pages, the shell's pages and an unmapped route × six people × four ways", async () => {
    const all = layoutPatterns();
    // every module once by its own first routes, every cross-group page, the shell's pages, a route outside any module
    const byModule = ADMIN_MODULE_SLUGS.flatMap((slug) => all.filter((pattern) => pattern === `admin/${slug}` || pattern.startsWith(`admin/${slug}/`)).slice(0, 3));
    const patterns = [...new Set([...byModule, "admin/security", "admin/security/roles", "admin/security/roles/:roleId", "admin/staff/me", "admin", "admin/me", "admin/blueprint", "admin/denied", "admin/:module", "admin/*", "admin/payments/:id"])];
    expect(byModule.length).toBeGreaterThan(ADMIN_MODULE_SLUGS.length);
    let refused = 0;
    let allowed = 0;
    for (const someone of people) {
      const session = (await getEmployee(requestCtx(someone.cookies).ctx, t.db)) as EmployeeSession;
      for (const pattern of patterns) {
        const rule = gateRuleOf(pattern);
        // the decision the gate made before this change: a module's group (or the page's other group), any employee
        // for the shell's own pages, nobody for a route outside every module
        const expected = rule.kind === "shell" || rule.kind === "employee" || rule.kind === "public" ? true : rule.kind === "module" ? gateAllows(session.actor, rule) : false;
        // a module of the employee's own group always opens (the cross-group pages add to that, never take away)
        if (rule.kind === "module" && canSeeModule(session.actor, rule.module)) expect(expected, `${someone.label} ${pattern}`).toBe(true);
        for (const way of WAYS) {
          const { outcome, ran } = await viaGate(adminRequest(pathOf(pattern), someone.cookies, way), pattern);
          const label = `${someone.label} · ${way} · ${pattern}`;
          expect(ran, label).toBe(expected);
          if (expected) continue;
          const answer = described(outcome);
          const module = rule.kind === "module" ? rule.module : null;
          if (way === "document") {
            // the shell's refusal page, with the page asked for; never cached, never indexed
            expect(answer.status, label).toBe(302);
            expect(answer.location, label).toBe(deniedPath(module, pathOf(pattern)));
            expect(answer.headers?.get("Cache-Control"), label).toBe("no-store");
            expect(answer.headers?.get("X-Robots-Tag"), label).toBe("noindex, nofollow");
          } else {
            expect(answer, label).toMatchObject({ status: 403, data: { error: "forbidden", ...(module ? { module } : {}) } });
            expect(answer.headers?.get("Cache-Control"), label).toBe("no-store");
            // only a client navigation's data request carries the frame (the layout's boundary needs it)
            if (way === "data") expect(answer.data, label).toMatchObject({ shell: { modules: expect.any(Array), waiting: expect.any(Object) }, i18n: { admin: expect.any(Object) } });
            else expect(answer.data?.shell, label).toBeUndefined();
          }
        }
        if (expected) allowed++;
        else refused++;
      }
    }
    // the matrix really refuses and really lets through
    expect(refused).toBeGreaterThan(100);
    expect(allowed).toBeGreaterThan(30);
  }, 180_000);

  test("the frame carried by a data request is the employee's own: their modules, their queues, their language", async () => {
    const cashier = people[0]!;
    const { outcome } = await viaGate(adminRequest("/admin/finance/journal", cashier.cookies, "data"), "admin/finance/journal");
    const data = described(outcome).data as { shell: { modules: string[]; locale: string; employee: { name: string } }; i18n: { admin: { errors: { forbiddenTitle: string } } } };
    expect(data.shell.modules).not.toContain("finance");
    expect(data.shell.modules).toContain("pos");
    expect(data.shell.locale).toBe("ar");
    expect(data.shell.employee.name).toBe("موظف الرفض");
    expect(data.i18n.admin.errors.forbiddenTitle).toBe("ليست لديك صلاحية لهذه الصفحة");
  });

  test("which requests are the browser's own pages and which are a script's data requests (fetch metadata)", () => {
    const at = (method: string, dest: string | null) => new Request(`${ORIGIN}/admin/x`, { method, headers: dest ? { "sec-fetch-dest": dest } : {} });
    expect(isDocumentNavigation(at("GET", "document"))).toBe(true);
    expect(isDocumentNavigation(at("HEAD", "Document"))).toBe(true);
    expect(isDocumentNavigation(at("POST", "document"))).toBe(false);
    expect(isDocumentNavigation(at("GET", "empty"))).toBe(false);
    expect(isDocumentNavigation(at("GET", null))).toBe(false);
    expect(isDataFetch(at("GET", "empty"))).toBe(true);
    expect(isDataFetch(at("POST", "empty"))).toBe(false);
    expect(isDataFetch(at("GET", "document"))).toBe(false);
    expect(deniedPath("finance", "/admin/finance/journal?period=2026-11")).toBe("/admin/denied?module=finance&from=%2Fadmin%2Ffinance%2Fjournal%3Fperiod%3D2026-11");
    expect(deniedPath(null, null)).toBe(DENIED_PATH);
    // what the refusal page reads back is an admin path the sign-in's own check accepts
    expect(adminNextPath(new URL(`${ORIGIN}${deniedPath("finance", "/admin/finance/journal?period=2026-11")}`).searchParams.get("from"), "")).toBe("/admin/finance/journal?period=2026-11");
  });
});

// ───────────────────────────────────────────────────────────────── the refusal page

describe("/admin/denied says the gate's refusal inside the frame — and decides nothing", () => {
  let cashier: Person;
  beforeAll(async () => {
    cashier = await person("cashier (page)", { role: "cashier" });
  }, 60_000);

  async function page(query: string, cookies: Record<string, string> = cashier.cookies): Promise<ReturnType<typeof described>> {
    const req = adminRequest(`${DENIED_PATH}${query}`, cookies, "document");
    const context = new RouterContextProvider();
    const url = new URL(req.url);
    let outcome: unknown;
    try {
      outcome = await requestContextMiddleware({ request: req, context, url, pattern: "/", params: {} }, async () =>
        (await adminGate({ request: req, context, url, pattern: "admin/denied", params: {} }, async () =>
          Response.json(await deniedLoader({ request: req, context, url, pattern: "admin/denied", params: {} } as Parameters<typeof deniedLoader>[0])),
        )) as Response,
    );
    } catch (error) {
      outcome = error;
    }
    return described(outcome);
  }

  test("a module the role cannot open: 403 with the module and the page asked for", async () => {
    expect(await page("?module=finance&from=%2Fadmin%2Ffinance%2Fjournal")).toMatchObject({ status: 403, data: { error: "forbidden", module: "finance", from: "/admin/finance/journal" } });
    // a route outside every module: no module, the page asked for
    expect(await page("?from=%2Fadmin%2Fpayments%2F1")).toMatchObject({ status: 403, data: { error: "forbidden", from: "/admin/payments/1" } });
  });

  test("what it reads is checked: an unknown module is none, a page outside the admin or the sign-in or itself is dropped", async () => {
    const unknown = await page("?module=nope&from=%2Fadmin%2Forders");
    expect(unknown.status).toBe(403);
    expect(unknown.data?.module).toBeUndefined();
    for (const from of ["//evil.example/admin", "https://evil.example/admin", "/admin/login", "/admin/denied?module=finance", "/store", "/admin/%2e%2e/%2e%2e/x"]) {
      const answer = await page(`?module=finance&from=${encodeURIComponent(from)}`);
      expect(answer.status, from).toBe(403);
      expect(answer.data?.from, from).toBeUndefined();
    }
  });

  test("a module the employee may open after all goes on to the page asked for (or the module's home) — the gate decides there again", async () => {
    expect(await page("?module=pos&from=%2Fadmin%2Fpos%2Fsell")).toMatchObject({ status: 302, location: "/admin/pos/sell" });
    // a page of another module is not where this one sends them
    expect(await page("?module=pos&from=%2Fadmin%2Ffinance")).toMatchObject({ status: 302, location: "/admin/pos" });
    expect(await page("?module=dashboard")).toMatchObject({ status: 302, location: "/admin" });
  });

  test("nobody signed in: the sign-in page, as for every admin page", async () => {
    const answer = await page("?module=finance", {});
    expect(answer.status).toBe(302);
    expect(answer.location).toMatch(/^\/admin\/login\?next=%2Fadmin%2Fdenied/);
  });
});
