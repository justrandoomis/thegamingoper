/**
 * Session rotation after a credential change (owner: server core; docs/SECURITY.md §5–6).
 *
 * The device that changes its password (staff and customers), turns two-step verification on or off (staff) or confirms
 * its phone number with a code (customers) continues on a NEW session token. The token it had before — and any copy of
 * that cookie — stops working at once. Checked through the real root middleware and the real route actions
 * (/admin/me, /account/settings): the answer that confirms the change is the one that carries the new cookie, and
 * nothing that runs later in the same request (a document POST renders its loaders after the action) clears it again.
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken, sha256Hex } from "~/lib/ids";
import { action as meAction } from "~/routes/admin/shell/me";
import { action as settingsAction } from "~/routes/storefront/account/settings";
import { ADMIN_COOKIE, confirmTotpEnrollment, disableOwnTotp, getEmployee, signInEmployee } from "~/server/auth/admin.server";
import { CUSTOMER_COOKIE, getCustomer, listCustomerSessions, signInCustomer, signUpCustomer } from "~/server/auth/customer.server";
import { getCtx, requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword, totpCode } from "~/server/crypto.server";
import { authEvents, customerSessions, employeeSessions } from "~/server/db/schema";
import { loadShellData } from "~/server/shell.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const SITE = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── helpers

let requests = 0;

/** A request context as the root middleware builds it (for calling services directly). */
function context(options: { cookies?: Record<string, string>; now?: number } = {}): { ctx: RequestCtx; setCookies: string[] } {
  const n = ++requests;
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `rotation-${n}`,
    nonce: "test-nonce",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: options.now ?? Date.now(),
    ip: `198.18.40.${n % 250}`,
    country: "IQ",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: (name) => jar.get(name) ?? null,
    setCookie: (serialized) => {
      setCookies.push(serialized);
    },
  };
  return { ctx, setCookies };
}

type ParsedCookie = { name: string; value: string; attributes: Record<string, string | true> };

function parseSetCookie(serialized: string): ParsedCookie {
  const [pair, ...attributes] = serialized.split(/;\s*/);
  const at = pair.indexOf("=");
  const parsed: ParsedCookie = { name: pair.slice(0, at), value: decodeURIComponent(pair.slice(at + 1)), attributes: {} };
  for (const attribute of attributes) {
    const eqAt = attribute.indexOf("=");
    if (eqAt === -1) parsed.attributes[attribute.toLowerCase()] = true;
    else parsed.attributes[attribute.slice(0, eqAt).toLowerCase()] = attribute.slice(eqAt + 1);
  }
  return parsed;
}

/** The cookies a browser keeps after a response (later Set-Cookie wins, Max-Age=0 deletes). */
function jarAfter(setCookies: string[], base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const serialized of setCookies) {
    const cookie = parseSetCookie(serialized);
    if (cookie.attributes["max-age"] === "0") delete jar[cookie.name];
    else jar[cookie.name] = cookie.value;
  }
  return jar;
}

const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

type Outcome = { status: number; data: unknown; setCookies: string[] };

/**
 * A same-site form POST the way React Router runs it: root middleware (request context, CSRF check, queued cookies) →
 * the route's action → `after` (what a document request runs next: the loaders, which ask for the session again).
 */
async function post(path: string, action: (args: never) => Promise<unknown>, form: Record<string, string>, cookies: Record<string, string>, after?: (ctx: RequestCtx) => Promise<void>): Promise<Outcome> {
  const request = new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { Origin: SITE, "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(cookies), "CF-Connecting-IP": `198.18.41.${++requests % 250}` },
    body: new URLSearchParams(form),
  });
  const routerContext = new RouterContextProvider();
  const url = new URL(request.url);
  let value: unknown;
  const response = (await requestContextMiddleware({ request, context: routerContext, url, pattern: path, params: {} } as never, async () => {
    try {
      value = await action({ request, context: routerContext, params: {}, url, pattern: path } as never);
    } catch (thrown) {
      value = thrown;
    }
    if (after) await after(getCtx(routerContext));
    if (value instanceof Response) return value;
    const init = (value as { init?: { status?: number; headers?: HeadersInit } } | null)?.init;
    return new Response(null, { status: init?.status ?? 200, headers: init?.headers });
  })) as Response;
  const data = value instanceof Response ? null : ((value as { data?: unknown } | null)?.data ?? value);
  return { status: response.status, data, setCookies: response.headers.getSetCookie() };
}

const only = (setCookies: string[], name: string) => setCookies.map(parseSetCookie).filter((cookie) => cookie.name === name);

// ───────────────────────────────────────────────────────────────── staff

async function staffMember(password = `staff-pw-${randomToken(9)}`) {
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("rotation")}@rotation.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  return { id, email, password };
}

async function staffSignIn(email: string, password: string, now = Date.now()) {
  const req = context({ now });
  const result = await signInEmployee(req.ctx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error(`expected a full sign-in, got ${result.status}`);
  return jarAfter(req.setCookies);
}

describe("staff: /admin/me", () => {
  test("a password change answers with the new cookie on both paths; the old cookie and every copy of it are dead", async () => {
    const person = await staffMember();
    const before = await staffSignIn(person.email, person.password);
    const laptop = await staffSignIn(person.email, person.password);
    const copy = { ...before };
    const oldRow = (await t.db.select().from(employeeSessions).where(eq(employeeSessions.idHash, await sha256Hex(before[ADMIN_COOKIE]))).get())!;
    expect(oldRow).toBeTruthy();
    let afterSession: Awaited<ReturnType<typeof getEmployee>> = null;

    const answer = await post("/admin/me", meAction, { intent: "password", currentPassword: person.password, newPassword: "a-new-staff-password-1", confirmPassword: "a-new-staff-password-1" }, before, async (ctx) => {
      // What every loader of a document POST does after the action: ask for the session again.
      afterSession = await getEmployee(ctx, t.db);
    });
    expect(answer.data).toEqual({ ok: true, intent: "password" });
    const admin = only(answer.setCookies, ADMIN_COOKIE);
    expect(admin.map((cookie) => cookie.attributes.path)).toEqual(["/admin", "/admin.data"]);
    // One value on both paths, a real token, never a deletion — nothing later in the request cleared it.
    expect(new Set(admin.map((cookie) => cookie.value)).size).toBe(1);
    expect(admin.every((cookie) => cookie.attributes["max-age"] !== "0" && cookie.attributes.httponly === true && cookie.attributes.samesite === "Strict")).toBe(true);
    const rotated = jarAfter(answer.setCookies, before);
    expect(rotated[ADMIN_COOKIE]).not.toBe(before[ADMIN_COOKIE]);
    expect(afterSession).not.toBeNull();

    const now = Date.now();
    expect(await getEmployee(context({ cookies: copy, now }).ctx, t.db)).toBeNull();
    expect(await getEmployee(context({ cookies: laptop, now }).ctx, t.db)).toBeNull();
    const current = await getEmployee(context({ cookies: rotated, now }).ctx, t.db);
    expect(current?.employee.id).toBe(person.id);
    expect(current?.session.id).toBe((afterSession as unknown as { session: { id: string } }).session.id);
    // The successor keeps the session's start and absolute end: a change never lengthens a session.
    const newRow = (await t.db.select().from(employeeSessions).where(eq(employeeSessions.idHash, current!.session.id)).get())!;
    expect(newRow).toMatchObject({ createdAt: oldRow.createdAt, expiresAt: oldRow.expiresAt, revokedAt: null });
    const live = (await t.db.select().from(employeeSessions).where(eq(employeeSessions.employeeId, person.id))).filter((row) => row.revokedAt === null);
    expect(live.map((row) => row.idHash)).toEqual([current!.session.id]);
  });

  test("a refused change (wrong current password, mismatch) keeps the cookie and sets none", async () => {
    const person = await staffMember();
    const jar = await staffSignIn(person.email, person.password);
    for (const form of [
      { intent: "password", currentPassword: "not-the-password", newPassword: "a-new-staff-password-2", confirmPassword: "a-new-staff-password-2" },
      { intent: "password", currentPassword: person.password, newPassword: "a-new-staff-password-2", confirmPassword: "something-else-entirely" },
    ]) {
      const answer = await post("/admin/me", meAction, form, jar);
      expect(answer.status).toBe(400);
      expect(only(answer.setCookies, ADMIN_COOKIE)).toEqual([]);
    }
    expect(await getEmployee(context({ cookies: jar }).ctx, t.db)).not.toBeNull();
  });

  test("turning two-step verification on and off moves the device to a new token each time", async () => {
    const person = await staffMember();
    // Thirty-second aligned, ahead of the wall clock, so each authenticator code below belongs to its own step.
    const base = Math.ceil(Date.now() / 30_000) * 30_000 + 60_000;
    let jar = await staffSignIn(person.email, person.password, base);

    const begin = await post("/admin/me", meAction, { intent: "totp-begin", password: person.password }, jar);
    const begun = begin.data as { ok: boolean; secret?: string };
    expect(begun.ok).toBe(true);
    const secret = String(begun.secret).replace(/ /g, "");
    expect(only(begin.setCookies, ADMIN_COOKIE)).toEqual([]);

    // The services are called directly here: the route stamps requests with the wall clock, the codes need a step.
    const on = context({ cookies: jar, now: base + MINUTE });
    await confirmTotpEnrollment(on.ctx, t.db, { code: await totpCode(secret, base + MINUTE) }, { DATA_KEY: t.env.DATA_KEY });
    const afterOn = jarAfter(on.setCookies, jar);
    expect(afterOn[ADMIN_COOKIE]).not.toBe(jar[ADMIN_COOKIE]);
    expect(await getEmployee(context({ cookies: jar, now: base + 2 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(context({ cookies: afterOn, now: base + 2 * MINUTE }).ctx, t.db)).toMatchObject({ employee: { totpEnabled: true }, session: { mfaOk: true } });
    // Later calls in the same request see the new session.
    expect((await getEmployee(on.ctx, t.db))?.session.mfaOk).toBe(true);
    jar = afterOn;

    const off = context({ cookies: jar, now: base + 3 * MINUTE });
    await disableOwnTotp(off.ctx, t.db, { password: person.password, code: await totpCode(secret, base + 3 * MINUTE) }, { DATA_KEY: t.env.DATA_KEY });
    const afterOff = jarAfter(off.setCookies, jar);
    expect(afterOff[ADMIN_COOKIE]).not.toBe(jar[ADMIN_COOKIE]);
    expect(await getEmployee(context({ cookies: jar, now: base + 4 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(context({ cookies: afterOff, now: base + 4 * MINUTE }).ctx, t.db)).toMatchObject({ employee: { totpEnabled: false } });
    // The changes are on record; no token is.
    const events = await t.db.select().from(authEvents).where(and(eq(authEvents.subjectId, person.id), eq(authEvents.kind, "mfa_enroll")));
    expect(events.filter((row) => row.success)).toHaveLength(2);
    for (const token of [jar[ADMIN_COOKIE], afterOff[ADMIN_COOKIE]]) expect(JSON.stringify(await t.db.select().from(employeeSessions))).not.toContain(token);
  });
});

// ───────────────────────────────────────────────────────────────── customers

const PASSWORD = "customer-password-1";

async function customerSignUp() {
  const phone = make.phone();
  const req = context();
  const session = await signUpCustomer(req.ctx, t.db, { phone, password: PASSWORD });
  return { phone, session, jar: jarAfter(req.setCookies) };
}

async function customerSignIn(phone: string, password = PASSWORD) {
  const req = context();
  await signInCustomer(req.ctx, t.db, { phone, password });
  return jarAfter(req.setCookies);
}

describe("customers: /account/settings", () => {
  test("a password change answers with a new tt_sid; the old cookie, its copies and the other devices are signed out", async () => {
    const { phone, session, jar } = await customerSignUp();
    const phoneDevice = await customerSignIn(phone);
    const copy = { ...jar };
    let shellCustomer: unknown = undefined;

    const answer = await post("/account/settings", settingsAction, { intent: "password", currentPassword: PASSWORD, newPassword: "customer-password-2" }, jar, async (ctx) => {
      // A document POST renders after the action: the shell reads the customer again in the same request.
      shellCustomer = (await loadShellData(ctx, t.db)).customer;
    });
    expect(answer.data).toMatchObject({ ok: true, intent: "password" });
    const sid = only(answer.setCookies, CUSTOMER_COOKIE);
    expect(sid).toHaveLength(1);
    expect(sid[0].attributes).toMatchObject({ httponly: true, samesite: "Lax", path: "/", "max-age": String(30 * 24 * 60 * 60) });
    expect(sid[0].value).not.toBe(jar[CUSTOMER_COOKIE]);
    expect(shellCustomer).toMatchObject({ id: session.customer.id });

    const rotated = jarAfter(answer.setCookies, jar);
    expect(await getCustomer(context({ cookies: copy }).ctx, t.db)).toBeNull();
    expect(await getCustomer(context({ cookies: phoneDevice }).ctx, t.db)).toBeNull();
    const current = await getCustomer(context({ cookies: rotated }).ctx, t.db);
    expect(current?.customer.id).toBe(session.customer.id);
    // "Signed in since …" stays true: the successor keeps the session's start.
    expect(current?.session.createdAt).toBe(session.session.createdAt);
    const listed = await listCustomerSessions(t.db, session.customer.id, Date.now(), current!.session.id);
    expect(listed.map((row) => [row.id, row.current])).toEqual([[current!.session.id, true]]);
    // The new password works, the old one does not.
    await expect(signInCustomer(context().ctx, t.db, { phone, password: PASSWORD })).rejects.toMatchObject({ code: "invalid_credentials" });
    expect(await customerSignIn(phone, "customer-password-2")).toHaveProperty(CUSTOMER_COOKIE);
  });

  test("a wrong current password changes nothing and sets no cookie", async () => {
    const { jar } = await customerSignUp();
    const answer = await post("/account/settings", settingsAction, { intent: "password", currentPassword: "not-it-at-all", newPassword: "customer-password-3" }, jar);
    expect(answer.status).toBe(400);
    expect(only(answer.setCookies, CUSTOMER_COOKIE)).toEqual([]);
    expect(await getCustomer(context({ cookies: jar }).ctx, t.db)).not.toBeNull();
  });

  test("confirming the phone with a code moves this device to a new tt_sid; other devices stay signed in; a wrong code rotates nothing", async () => {
    const { phone, session, jar } = await customerSignUp();
    const tablet = await customerSignIn(phone);

    const asked = await post("/account/settings", settingsAction, { intent: "phoneRequest" }, jar);
    const sent = asked.data as { ok: boolean; codeId: string; devCode: string };
    expect(sent).toMatchObject({ ok: true, codeId: expect.any(String), devCode: expect.stringMatching(/^\d{6}$/) });
    expect(only(asked.setCookies, CUSTOMER_COOKIE)).toEqual([]);

    const wrongCode = String((Number(sent.devCode) + 1) % 1_000_000).padStart(6, "0");
    const wrong = await post("/account/settings", settingsAction, { intent: "phoneConfirm", code: wrongCode, codeId: sent.codeId }, jar);
    expect(wrong.status).toBe(400);
    expect(only(wrong.setCookies, CUSTOMER_COOKIE)).toEqual([]);
    expect((await getCustomer(context({ cookies: jar }).ctx, t.db))?.customer.phoneVerified).toBe(false);

    const answer = await post("/account/settings", settingsAction, { intent: "phoneConfirm", code: sent.devCode, codeId: sent.codeId }, jar);
    expect(answer.data).toMatchObject({ ok: true, intent: "phoneConfirm" });
    const sid = only(answer.setCookies, CUSTOMER_COOKIE);
    expect(sid).toHaveLength(1);
    expect(sid[0].value).not.toBe(jar[CUSTOMER_COOKIE]);
    const rotated = jarAfter(answer.setCookies, jar);

    expect(await getCustomer(context({ cookies: jar }).ctx, t.db)).toBeNull();
    expect(await getCustomer(context({ cookies: rotated }).ctx, t.db)).toMatchObject({ customer: { id: session.customer.id, phoneVerified: true } });
    // Only this device's token changed: the tablet stays signed in and sees the confirmed number too.
    expect((await getCustomer(context({ cookies: tablet }).ctx, t.db))?.customer.phoneVerified).toBe(true);
    const rows = await t.db.select().from(customerSessions).where(eq(customerSessions.customerId, session.customer.id));
    expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(2);
  });
});

describe("staff sessions never last longer because of a change", () => {
  test("a rotation close to the 12-hour end keeps that end", async () => {
    const person = await staffMember();
    const start = Date.now() - 11 * HOUR - 30 * MINUTE;
    const jar = await staffSignIn(person.email, person.password, start);
    // Keep the session in use (it ends after 2 idle hours).
    for (let at = start + HOUR; at < Date.now(); at += HOUR) await getEmployee(context({ cookies: jar, now: at }).ctx, t.db);
    const answer = await post("/admin/me", meAction, { intent: "password", currentPassword: person.password, newPassword: "a-new-staff-password-3", confirmPassword: "a-new-staff-password-3" }, jar);
    expect(answer.data).toEqual({ ok: true, intent: "password" });
    const [cookie] = only(answer.setCookies, ADMIN_COOKIE);
    // About 30 minutes left, not a fresh 12 hours.
    expect(Number(cookie.attributes["max-age"])).toBeLessThanOrEqual(30 * 60);
    expect(Number(cookie.attributes["max-age"])).toBeGreaterThan(25 * 60);
    const rotated = jarAfter(answer.setCookies, jar);
    expect(await getEmployee(context({ cookies: rotated, now: start + 12 * HOUR + SECOND }).ctx, t.db)).toBeNull();
  });
});
