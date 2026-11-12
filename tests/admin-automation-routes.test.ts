/**
 * Admin module 19 "automation" — its routes against a real local D1, with real signed-in sessions:
 *
 *   · page loaders answer 403 to a role without the page's permission, and serve the roles that have it
 *   · actions check the change's own permission (an inventory clerk reads suggestions but cannot dismiss one or run
 *     the rules; finance reads unusual transactions only)
 *   · the builder's action: a saved draft redirects to the rule's page; a refused form answers 400 with every field
 *     error and the values as typed (shown again without JavaScript)
 *   · the module's routes are registered under /admin/automation (the shell's gate attributes them to the module)
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loader as anomaliesLoader } from "~/routes/admin/automation/anomalies";
import { loader as assistantLoader } from "~/routes/admin/automation/assistant";
import { action as homeAction, loader as homeLoader } from "~/routes/admin/automation/home";
import { loader as layoutLoader } from "~/routes/admin/automation/layout";
import { loader as ruleLoader } from "~/routes/admin/automation/rule";
import { action as ruleNewAction, loader as ruleNewLoader } from "~/routes/admin/automation/rule-new";
import { action as rulesAction, loader as rulesLoader } from "~/routes/admin/automation/rules";
import { automationAdminRoutes } from "~/routes/admin/automation/routes";
import { action as suggestionsAction, loader as suggestionsLoader } from "~/routes/admin/automation/suggestions";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { employeeRoles } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
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
  for (const role of ["manager", "finance", "support", "inventory", "cashier", "fulfillment"] as const) people[role] = await person(role);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey): Promise<Person> {
  const password = "automation-routes-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("auto")}@automation.test`;
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
async function run(cookie: string, path: string, fn: Fn, init: { params?: Record<string, string>; method?: string; body?: BodyInit } = {}): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers: { cookie, origin: ORIGIN, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Edg/130" } });
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
const form = (entries: [string, string][]) => {
  const body = new FormData();
  for (const [name, value] of entries) body.append(name, value);
  return body;
};

describe("page loaders", () => {
  test("the frame refuses a role without any automation permission and lists only the sections a role may open", async () => {
    expect(statusOf(await run(people.support.cookie, "/admin/automation", layoutLoader as never))).toBe(403);
    expect(statusOf(await run(people.cashier.cookie, "/admin/automation", layoutLoader as never))).toBe(403);
    const clerk = (await run(people.inventory.cookie, "/admin/automation", layoutLoader as never)) as { access?: { rules: boolean; suggestions: boolean; anomalies: boolean } };
    expect(clerk.access).toMatchObject({ rules: false, suggestions: true, anomalies: false });
    const finance = (await run(people.finance.cookie, "/admin/automation", layoutLoader as never)) as { access?: { rules: boolean; anomalies: boolean } };
    expect(finance.access).toMatchObject({ rules: false, anomalies: true });
    const home = (await run(people.inventory.cookie, "/admin/automation", homeLoader as never)) as { overview?: { figures: { rules: unknown } } };
    expect(home.overview?.figures.rules).toBeNull();
  });
  test("each page checks its own permission", async () => {
    expect(statusOf(await run(people.inventory.cookie, "/admin/automation/rules", rulesLoader as never))).toBe(403);
    expect(statusOf(await run(people.manager.cookie, "/admin/automation/rules", rulesLoader as never))).toBe(200);
    expect(statusOf(await run(people.finance.cookie, "/admin/automation/rules/new", ruleNewLoader as never))).toBe(403);
    expect(statusOf(await run(people.inventory.cookie, "/admin/automation/suggestions", suggestionsLoader as never))).toBe(200);
    expect(statusOf(await run(people.inventory.cookie, "/admin/automation/anomalies", anomaliesLoader as never))).toBe(403);
    expect(statusOf(await run(people.finance.cookie, "/admin/automation/anomalies", anomaliesLoader as never))).toBe(200);
    expect(statusOf(await run(people.inventory.cookie, "/admin/automation/assistant", assistantLoader as never))).toBe(403);
    expect(statusOf(await run(people.manager.cookie, "/admin/automation/assistant", assistantLoader as never))).toBe(200);
    expect(statusOf(await run(people.manager.cookie, "/admin/automation/rules/wfl_doesnotexist0000", ruleLoader as never, { params: { ruleId: "wfl_doesnotexist0000" } }))).toBe(404);
  });
});

describe("actions", () => {
  test("a clerk reads suggestions but cannot dismiss one or run the rules; a form that is not one is a 400", async () => {
    expect(statusOf(await run(people.inventory.cookie, "/admin/automation/suggestions", suggestionsAction as never, { method: "POST", body: form([["intent", "scan"]]) }))).toBe(403);
    expect(statusOf(await run(people.inventory.cookie, "/admin/automation/rules", rulesAction as never, { method: "POST", body: form([["intent", "run_now"], ["reason", "اختبار"]]) }))).toBe(403);
    const noReason = await run(people.manager.cookie, "/admin/automation/rules", rulesAction as never, { method: "POST", body: form([["intent", "run_now"]]) });
    expect(statusOf(noReason)).toBe(400);
    const ran = (await run(people.manager.cookie, "/admin/automation/rules", rulesAction as never, { method: "POST", body: form([["intent", "run_now"], ["reason", "المجدول متوقف محلياً"]]) })) as { ok?: boolean; runs?: number };
    expect(ran.ok).toBe(true);
    const notForm = await run(people.manager.cookie, "/admin/automation", homeAction as never, { method: "POST", body: "{}" });
    expect(statusOf(notForm)).toBe(400);
  });
  test("the builder: a draft redirects to its page; a refused form answers 400 with its field errors and the typed values", async () => {
    const refused = (await run(people.manager.cookie, "/admin/automation/rules/new", ruleNewAction as never, {
      method: "POST",
      body: form([
        ["event", "ticket.waiting"],
        ["name", "x"],
        ["hours", "٠"],
      ]),
    })) as { data?: { fields?: Record<string, string>; values?: { name: string; event: string } }; init?: { status?: number } };
    expect(refused.init?.status).toBe(400);
    expect(Object.keys(refused.data?.fields ?? {}).sort()).toEqual(["actions", "hours", "name"]);
    expect(refused.data?.values).toMatchObject({ name: "x", event: "ticket.waiting" });
    const saved = await run(people.manager.cookie, "/admin/automation/rules/new", ruleNewAction as never, {
      method: "POST",
      body: form([
        ["event", "order.placed"],
        ["name", "طلبات الدفع عند الاستلام"],
        ["paymentMethods", "cod"],
        ["act_notify", "on"],
        ["notifyAudience", "automation.workflow.read"],
        ["idempotencyKey", "routes-test-key-0123456789"],
      ]),
    });
    expect(saved).toBeInstanceOf(Response);
    expect((saved as Response).status).toBe(302);
    expect((saved as Response).headers.get("Location")).toMatch(/^\/admin\/automation\/rules\/wfl_[a-z0-9]+$/);
    expect(statusOf(await run(people.finance.cookie, "/admin/automation/rules/new", ruleNewAction as never, { method: "POST", body: form([["event", "order.placed"]]) }))).toBe(403);
  });
});

describe("registration", () => {
  test("every route of the module sits under /admin/automation", () => {
    const [frame] = automationAdminRoutes;
    expect(frame.path).toBe("automation");
    const paths = (frame.children ?? []).map((child) => (child.index ? "(index)" : child.path));
    expect(paths).toEqual(["(index)", "rules", "rules/new", "rules/:ruleId", "rules/:ruleId/edit", "runs", "runs/:runId", "suggestions", "suggestions/order", "forecast", "anomalies", "tickets", "assistant"]);
  });
});
