/**
 * Admin module 23 "ops" — its routes against a real local D1, with real signed-in sessions:
 *
 *   · page loaders answer 403 to a role without the page's permission (and serve the roles that have it)
 *   · an action checks the change's own permission in its service (a finance reader cannot close a finding)
 *   · the browser's report endpoint: any signed-in employee, scrubbed and grouped, malformed → 400, too large → 413,
 *     over the per-employee limit → 429 and nothing stored
 *   · the timing middleware writes nothing for a fast request, one row for a slow or failed one, once per request
 *   · the module's routes are registered under /admin/ops (the shell's gate attributes them to the module)
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { action as findingAction, loader as findingLoader } from "~/routes/admin/ops/finding";
import { loader as incidentNewLoader } from "~/routes/admin/ops/incident-new";
import { loader as jobsLoader } from "~/routes/admin/ops/jobs";
import { loader as layoutLoader } from "~/routes/admin/ops/layout";
import { opsTimingMiddleware } from "~/routes/admin/ops/observe.server";
import { action as reportAction } from "~/routes/admin/ops/report";
import { opsAdminRoutes } from "~/routes/admin/ops/routes";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { consistencyFindings, employeeRoles, errorReports, perfRollups } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { resetTelemetryBudget } from "~/server/services/admin/ops/telemetry.server";
import { TELEMETRY_RATE } from "~/server/services/admin/ops/types";
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
  for (const role of ["manager", "finance", "support"] as const) people[role] = await person(role);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});
beforeEach(() => resetTelemetryBudget());

async function person(role: DefaultRoleKey): Promise<Person> {
  const password = "ops-routes-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("ops")}@ops.test`;
  const id = await make.employee({ email, name: role, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const who: Person = { id, email, password, actor: { kind: "employee", id, permissions: defaultRolePermissions(role), label: role }, cookie: "" };
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
async function run(cookie: string, path: string, fn: Fn, init: { params?: Record<string, string>; method?: string; body?: BodyInit; headers?: Record<string, string>; pattern?: string } = {}): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130", ...(init.headers ?? {}) } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params: init.params ?? {}, url: new URL(request.url), pattern: init.pattern ?? path } as never);
      return out instanceof Response ? out : new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}

const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

describe("page loaders", () => {
  test("the module's frame refuses a role without any ops permission, and serves finance its one section", async () => {
    expect(statusOf(await run(people.support.cookie, "/admin/ops", layoutLoader as never))).toBe(403);
    const finance = (await run(people.finance.cookie, "/admin/ops", layoutLoader as never)) as { access?: { consistency: boolean; jobs: boolean } };
    expect(finance.access).toMatchObject({ consistency: true, jobs: false });
  });

  test("the jobs page answers 403 to finance and serves the manager every job", async () => {
    expect(statusOf(await run(people.finance.cookie, "/admin/ops/jobs", jobsLoader as never))).toBe(403);
    const data = (await run(people.manager.cookie, "/admin/ops/jobs", jobsLoader as never)) as { overview?: { jobs: unknown[] } };
    expect(data.overview?.jobs.length).toBeGreaterThan(0);
  });

  test("opening an incident needs ops.incident.manage", async () => {
    expect(statusOf(await run(people.finance.cookie, "/admin/ops/incidents/new", incidentNewLoader as never))).toBe(403);
    const data = (await run(people.manager.cookie, "/admin/ops/incidents/new", incidentNewLoader as never)) as { options?: { owners: { id: string }[] } };
    expect(data.options?.owners.some((owner) => owner.id === people.manager.id)).toBe(true);
  });

  test("a finding page serves finance (read), but its close action is refused by the service (403)", async () => {
    const id = "cfd_route_test";
    await t.db.insert(consistencyFindings).values({ id, fingerprint: `orders.totals_vs_items|order|${id}`, checkKey: "orders.totals_vs_items", severity: "warning", entityType: "order", entityId: id, message: "test", details: {}, status: "open", detectedAt: TEST_NOW, lastSeenAt: TEST_NOW });
    const page = (await run(people.finance.cookie, `/admin/ops/consistency/${id}`, findingLoader as never, { params: { findingId: id } })) as { finding?: { id: string } };
    expect(page.finding?.id).toBe(id);
    const form = new FormData();
    form.set("intent", "close");
    form.set("outcome", "resolved");
    form.set("reason", "fixed in the orders module");
    const refused = await run(people.finance.cookie, `/admin/ops/consistency/${id}`, findingAction as never, { method: "POST", body: form, params: { findingId: id } });
    expect(statusOf(refused)).toBe(403);
    const again = new FormData();
    for (const [key, value] of form) again.set(key, value);
    const closed = (await run(people.manager.cookie, `/admin/ops/consistency/${id}`, findingAction as never, { method: "POST", body: again, params: { findingId: id } })) as { ok?: boolean };
    expect(closed.ok).toBe(true);
    expect((await t.db.select().from(consistencyFindings).where(eq(consistencyFindings.id, id)).get())?.status).toBe("resolved");
  });
});

describe("the browser's report endpoint", () => {
  const post = (who: Person, body: unknown, headers: Record<string, string> = {}) =>
    run(who.cookie, "/admin/ops/report", reportAction as never, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

  test("any signed-in employee may report; the text is scrubbed and grouped; bad bodies are refused", async () => {
    const response = (await post(people.support, { kind: "error", phase: "error", message: "TypeError: x of 07701234567 at row 12", route: "/admin/orders/:ref", url: "/admin/orders/TT-1?t=secret" })) as Response;
    expect(response.status).toBe(204);
    const [row] = await t.db.select().from(errorReports).where(eq(errorReports.source, "client"));
    expect(row.message).not.toContain("7701234567");
    expect(row.url).toBe("/admin/orders/TT-1");
    expect(((await post(people.support, "{not json")) as Response).status).toBe(400);
    expect(((await post(people.support, { kind: "nonsense" })) as Response).status).toBe(400);
    expect(((await post(people.support, { kind: "error", message: "x".repeat(20_000), route: "/a", url: "/a" })) as Response).status).toBe(413);
    // a fast load is accepted and not written
    expect(((await post(people.support, { kind: "timing", phase: "load", ms: 400, route: "/admin" })) as Response).status).toBe(204);
    expect(await t.db.select().from(perfRollups).where(eq(perfRollups.route, "/admin"))).toHaveLength(0);
    expect(((await post(people.support, { kind: "timing", phase: "load", ms: 6400, route: "/admin" })) as Response).status).toBe(204);
    expect((await t.db.select().from(perfRollups).where(eq(perfRollups.route, "/admin")))[0]).toMatchObject({ metric: "load_slow", samples: 1, poor: 1 });
  });

  test("over the per-employee limit: 429 and nothing stored", async () => {
    const who = people.manager;
    let last: Response | null = null;
    for (let i = 0; i <= TELEMETRY_RATE.limit; i++) last = (await post(who, { kind: "error", message: `Limit test ${i}`, route: "/admin/limit", url: "/admin/limit" })) as Response;
    expect(last?.status).toBe(429);
    const rows = await t.db.select().from(errorReports).where(eq(errorReports.route, "/admin/limit"));
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(TELEMETRY_RATE.limit);
  });
});

describe("the timing middleware", () => {
  const call = async (pattern: string, response: Response, wait = 0) => {
    const context = new RouterContextProvider();
    const request = new Request(`${ORIGIN}${pattern}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" } });
    let result: Response | undefined;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      result = (await opsTimingMiddleware({ request, context, pattern, params: {}, url: new URL(request.url) } as never, async () => {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        return response;
      })) as Response;
      return result;
    });
    return result;
  };

  test("nothing for a fast request, one row for a failed one, the report endpoint never timed", async () => {
    await call("/admin/ops/fast", new Response("ok"));
    expect(await t.db.select().from(perfRollups).where(eq(perfRollups.route, "/admin/ops/fast"))).toHaveLength(0);
    const out = await call("/admin/ops/broken", new Response("x", { status: 503 }));
    expect(out?.status).toBe(503);
    const [row] = await t.db.select().from(perfRollups).where(eq(perfRollups.route, "/admin/ops/broken"));
    expect(row).toMatchObject({ metric: "server_failed", device: "mobile", samples: 1 });
    await call("/admin/ops/report", new Response("x", { status: 500 }));
    expect(await t.db.select().from(perfRollups).where(eq(perfRollups.route, "/admin/ops/report"))).toHaveLength(0);
  });
});

test("every route of the module is registered under /admin/ops", () => {
  const paths: string[] = [];
  const walk = (entries: readonly { path?: string; children?: unknown[] }[], prefix: string) => {
    for (const entry of entries) {
      const path = entry.path ? `${prefix}/${entry.path}` : prefix;
      paths.push(path);
      if (entry.children) walk(entry.children as never, path);
    }
  };
  walk(opsAdminRoutes as never, "/admin");
  expect(paths.every((path) => path === "/admin/ops" || path.startsWith("/admin/ops/"))).toBe(true);
  expect(paths).toEqual(expect.arrayContaining(["/admin/ops/jobs", "/admin/ops/consistency", "/admin/ops/incidents", "/admin/ops/errors", "/admin/ops/performance", "/admin/ops/backups", "/admin/ops/report"]));
});
