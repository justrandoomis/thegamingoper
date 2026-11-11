/**
 * Admin module 22 "settings" — the adversarial review (2026-11-11). Each test is an attack that the first build let
 * through:
 *
 *   · setSetting `{ expected }` read the value twice — once to compare, once to build the in-batch guard — so a change
 *     landing between the two reads was compared against the OLD value and guarded on the NEW one: the stale form won
 *     and silently overwrote the other person's change
 *   · a role that may read settings but not change a key got a field error ("write the reason") instead of 403
 *   · an expired request kept the key's editor locked for everyone (only the requester could withdraw it) and nobody
 *     else could close it
 *   · one stored value that no longer fits its schema crashed the whole settings module — the one place to fix it —
 *     and could never be replaced (any `expected` was refused)
 */
import { eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { action as keyAction } from "~/routes/admin/settings/key";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, auditEvents, employeeRoles, rolePermissions, roles, settings } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { REQUEST_TTL_MS, decideSettingChange, getSettingItem, listSettingItems, pendingChanges, proposeSettingChange } from "~/server/services/admin/settings/changes.server";
import { getSetting, setSetting } from "~/server/settings.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; email: string; password: string };
const people: Record<string, Person> = {};
let roleSeq = 0;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance"] as const) people[role] = await person(role);
  people.owner2 = await person("owner");
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[]): Promise<Person> {
  const password = "settings-review-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("setrev")}@settings.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? "custom" : role, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (Array.isArray(role)) {
    const custom = `role_setrev_${++roleSeq}`;
    await t.db.insert(roles).values({ id: custom, key: `setrev_${roleSeq}`, name: { ar: "دور مراجعة", en: "Review role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, password, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password, actor: { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role } };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const failure = async (run: () => Promise<unknown>) => toAppError(await thrown(run));
const code = async (run: () => Promise<unknown>) => (await failure(run))?.code ?? "unexpected";
const key = () => `k_${randomToken(10)}`;

/**
 * The database as the service sees it, with another person's change landing right before the service's raw read
 * (`db.all`) — the moment between reading the value in force and sending the batch.
 */
function withChangeBeforeRawRead(db: Db, competing: () => Promise<unknown>): Db {
  let fired = false;
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "all") {
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await competing();
          }
          return (target.all as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("setSetting { expected } — one read, compared and guarded", () => {
  test("a change landing between the service's read and its batch is refused, never overwritten", async () => {
    const owner = people.owner.actor;
    const seen = await getSetting(t.db, "checkout.transfer_proof_hours");
    const raced = withChangeBeforeRawRead(t.db, () => setSetting(t.db, people.owner2.actor, "checkout.transfer_proof_hours", seen + 7, "تغيير شخص آخر", NOW, { expected: seen }));
    expect(await code(() => setSetting(raced, owner, "checkout.transfer_proof_hours", seen + 1, "تغييري", NOW, { expected: seen }))).toBe("setting_changed");
    expect(await getSetting(t.db, "checkout.transfer_proof_hours")).toBe(seen + 7);
    const events = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, "checkout.transfer_proof_hours"));
    expect(events.map((event) => (event.after as { value: number }).value)).toEqual([seen + 7]);
  });
});

describe("proposeSettingChange", () => {
  test("a role that may not change the key gets 403 before anything it typed is read", async () => {
    const finance = people.finance.actor;
    expect(await code(() => proposeSettingChange(t.db, finance, { key: "returns.window_days", value: 3, expected: 7, reason: "", idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => proposeSettingChange(t.db, finance, { key: "returns.window_days", value: "not a number", reason: "x", idempotencyKey: "short" }, NOW))).toBe("forbidden");
  });

  test("an expired request no longer locks the key, and another approver may close it", async () => {
    const seen = await getSetting(t.db, "finance.expense_second_approval_iqd");
    const asked = await proposeSettingChange(t.db, people.manager.actor, { key: "finance.expense_second_approval_iqd", value: seen + 100_000, expected: seen, reason: "حد أعلى", idempotencyKey: key() }, NOW);
    const live = await getSettingItem(t.db, people.owner.actor, "finance.expense_second_approval_iqd", "ar", NOW);
    expect(live.blocked).toBe(true);
    const later = NOW + REQUEST_TTL_MS + 60_000;
    const item = await getSettingItem(t.db, people.owner.actor, "finance.expense_second_approval_iqd", "ar", later);
    expect(item.pending).toMatchObject({ id: asked.requestId, expired: true, canDecide: false, canReject: true });
    expect(item.blocked).toBe(false);
    // the requester sees it expired too, but never closes it as a decision of their own
    expect((await pendingChanges(t.db, people.manager.actor, "ar", later)).find((change) => change.id === asked.requestId)).toMatchObject({ mine: true, canReject: false });
    expect(await decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "reject", note: "انتهت مهلة الطلب" }, later)).toEqual({ status: "rejected", replayed: false });
    expect((await t.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, asked.requestId!)).get())?.status).toBe("rejected");
  });
});

describe("a stored value that no longer fits its schema", () => {
  test("is shown as broken (never crashes the module) and can be replaced by who may change it", async () => {
    await t.db.insert(settings).values({ key: "tradein.estimate_valid_days", value: 500, updatedAt: NOW }).onConflictDoUpdate({ target: settings.key, set: { value: 500, updatedAt: NOW } });
    const items = await listSettingItems(t.db, people.manager.actor, "ar", NOW);
    const broken = items.find((item) => item.key === "tradein.estimate_valid_days");
    expect(broken).toMatchObject({ value: null, isDefault: false });
    expect(broken?.broken).toEqual(expect.any(String));
    expect(items.find((item) => item.key === "returns.window_days")?.broken).toBeNull();
    const item = await getSettingItem(t.db, people.manager.actor, "tradein.estimate_valid_days", "ar", NOW);
    expect(item.broken).toEqual(expect.any(String));
    // what the form showed was "broken" (null): the replacement is guarded on the stored text
    expect(await code(() => proposeSettingChange(t.db, people.manager.actor, { key: "tradein.estimate_valid_days", value: 14, expected: 7, reason: "إصلاح القيمة", idempotencyKey: key() }, NOW))).toBe("setting_changed");
    expect(await proposeSettingChange(t.db, people.manager.actor, { key: "tradein.estimate_valid_days", value: 14, expected: null, reason: "إصلاح القيمة", idempotencyKey: key() }, NOW)).toEqual({ status: "applied" });
    expect(await getSetting(t.db, "tradein.estimate_valid_days")).toBe(14);
    // a value that fits is never matched by "broken"
    expect(await code(() => proposeSettingChange(t.db, people.manager.actor, { key: "tradein.estimate_valid_days", value: 20, expected: null, reason: "مرة أخرى", idempotencyKey: key() }, NOW))).toBe("setting_changed");
  });
});

// ───────────────────────────────────────────────────────────────── routes

function requestCtx(): RequestCtx {
  return {
    requestId: `setrev-${randomToken(6)}`,
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

async function signedIn(who: Person): Promise<string> {
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email: who.email, password: who.password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  return setCookies.map((line) => line.split("; ")[0]).find((value) => value.startsWith("tt_adm=") && value.length > 10) ?? "";
}

async function post(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown, entries: Record<string, string>): Promise<unknown> {
  const body = new FormData();
  for (const [name, value] of Object.entries(entries)) body.append(name, value);
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
const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

describe("routes", () => {
  test("the key page answers 403 (not a field error) to a role that may only read the key", async () => {
    const cookie = await signedIn(people.finance);
    const answer = await post(cookie, "/admin/settings/keys/returns.window_days", { key: "returns.window_days" }, keyAction as never, { intent: "change", value: "3", expected: "7", reason: "", formKey: key() });
    expect(statusOf(answer)).toBe(403);
    expect((answer as { data?: { code?: string } }).data?.code).toBe("forbidden");
  });
});
