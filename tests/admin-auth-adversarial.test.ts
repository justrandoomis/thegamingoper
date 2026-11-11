/**
 * Admin authentication and shell — ADVERSARIAL review (owner: admin-auth-review).
 *
 * Every test names the correct behaviour and then attacks it through the real route modules, the real root middleware
 * (CSRF, headers) and the real services, against a real local D1 (tests/helpers/db.ts). Holes this review found and
 * closed are marked "was broken"; the one it left open (the session token surviving a credential change) was closed
 * by the server pass on 2026-11-11 and is marked "was open".
 *
 *   1 setup              once, only with SETUP_TOKEN (constant time, rate-limited), races, replay → 404
 *   2 sign-in            enumeration (words, status, timing), lockout and its reset, the lockout RACE (was broken),
 *                        per-IP and per-account limits
 *   3 two-step           replay, the ±1 step window, parallel use of one code, recovery codes once, the code
 *                        brute-force cap, enrolment needs the password on an older session (was broken)
 *   4 sessions           fixation at sign-in and at the second step, rotation after credential changes (was open),
 *                        password change and "sign out everywhere" end every other session, half-open ones too
 *   5 cookies            HttpOnly, Secure on https only, SameSite=Strict, Path=/admin(.data), no token in URLs,
 *                        loader data or logs
 *   6 redirects          next= and back= never leave the admin and are always plain ASCII (was: raw Unicode)
 *   7 CSRF               cross-site, null, missing and malformed Origin on login, logout, enrolment, revoke
 *   8 authorization      every module × every role through the gate and the landing page, unmapped admin routes
 *                        (was: allowed), the blueprint (was: open to accounts without any permission), customers,
 *                        nobody, and no cost/profit/proof/credential field in any shell loader's data
 *   9 headers            no-store + noindex, the security headers, CSP in production
 *  10 audit and logs     every security event leaves a row (failed "turn two-step off" did not), no secret anywhere
 *  11 dev-accounts       refuses production and remote flags, prints no credentials
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env as workerEnv } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { randomToken } from "~/lib/ids";
import { loader as layoutLoader } from "~/routes/admin/_layout";
import { action as languageAction } from "~/routes/admin/auth/language";
import { action as signOutAction, loader as signOutLoader } from "~/routes/admin/auth/sign-out";
import { headers as setupHeaders } from "~/routes/admin/auth/first-owner";
import { setupAction, setupLoader, type SetupFailure } from "~/routes/admin/auth/first-owner.server";
import { headers as signInHeaders, loader as signInRouteLoader } from "~/routes/admin/auth/sign-in";
import { loginAction, loginLoader, type LoginFailure } from "~/routes/admin/auth/sign-in.server";
import { loader as homeLoader } from "~/routes/admin/dashboard/admin-home";
import { canSeeModule } from "~/routes/admin/shell/access.server";
import { loader as blueprintLoader } from "~/routes/admin/shell/blueprint";
import { adminGate, gateRuleOf } from "~/routes/admin/shell/gate.server";
import { loader as meLoader } from "~/routes/admin/shell/me";
import { mySecurityAction } from "~/routes/admin/shell/me.server";
import { loader as moduleLandingLoader } from "~/routes/admin/shell/module";
import { ADMIN_MODULE_SLUGS } from "~/routes/admin/shell/modules";
import { adminBackPath, adminNextPath } from "~/routes/admin/shell/next.server";
import { ADMIN_COOKIE, RECENT_SIGN_IN_MS, beginTotpEnrollment, confirmTotpEnrollment, createFirstOwner, getEmployee, getPendingMfa, signInEmployee, verifyEmployeeMfa } from "~/server/auth/admin.server";
import { CUSTOMER_COOKIE, signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword, toBase64Url, totpCode } from "~/server/crypto.server";
import { auditEvents, authEvents, employeeRoles, employees, employeeSessions, rateLimits, roles } from "~/server/db/schema";
import { DEFAULT_ROLES, roleId, type DefaultRoleKey } from "~/server/permissions";
import { RATE_LIMITS } from "~/server/ratelimit.server";
import { isProductionEnv, redactSecrets } from "../scripts/dev-accounts";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";
import { PROJECT_ROOT } from "./helpers/migrations";

const NOW = TEST_NOW; // 30-second aligned: TOTP steps start exactly here
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

let t: TestDb;
let make: Fixtures;

// Every secret this file creates — scanned for in audit rows, security-log rows, loader data and console output.
const SECRETS = new Set<string>();
const remember = <T extends string>(secret: T): T => {
  SECRETS.add(secret);
  return secret;
};

const DATA_KEY = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
const SETUP_TOKEN = remember(randomToken(24));
const secrets = { DATA_KEY, SETUP_TOKEN, SESSION_SECRET: randomToken(48) };

// Everything printed while this file runs, to prove no credential reaches a log line.
const printed: string[] = [];
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
});
afterAll(async () => {
  vi.restoreAllMocks();
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── request helpers

type TestRequest = { ctx: RequestCtx; setCookies: string[] };
let requestCount = 0;
let ipCount = 0;
/** A client address no other test uses (per-IP limits must not leak between tests). */
const uniqueIp = () => `198.18.${Math.floor(++ipCount / 250)}.${ipCount % 250}`;

function request(options: { now?: number; ip?: string | null; cookies?: Record<string, string>; locale?: "ar" | "en"; https?: boolean } = {}): TestRequest {
  const n = ++requestCount;
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const locale = options.locale ?? "ar";
  const ctx: RequestCtx = {
    requestId: `adversarial-${n}`,
    nonce: "test-nonce",
    origin: options.https ? "https://tamtamgames.com" : "http://localhost:5173",
    isHttps: options.https ?? false,
    isDev: true,
    now: options.now ?? NOW,
    ip: options.ip === undefined ? uniqueIp() : options.ip,
    country: "IQ",
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
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

type ParsedCookie = { name: string; value: string; attributes: Record<string, string | true> };
function parseSetCookie(serialized: string): ParsedCookie {
  const [pair, ...attributes] = serialized.split(/;\s*/);
  const at = pair.indexOf("=");
  const parsed: ParsedCookie = { name: pair.slice(0, at), value: decodeURIComponent(pair.slice(at + 1)), attributes: {} };
  for (const attribute of attributes) {
    const eq = attribute.indexOf("=");
    if (eq === -1) parsed.attributes[attribute.toLowerCase()] = true;
    else parsed.attributes[attribute.slice(0, eq).toLowerCase()] = attribute.slice(eq + 1);
  }
  return parsed;
}

/** The cookies a browser keeps after a response (later Set-Cookie wins, Max-Age=0 deletes). */
function cookiesAfter(previous: TestRequest, base: Record<string, string> = {}): Record<string, string> {
  const jar = { ...base };
  for (const serialized of previous.setCookies) {
    const cookie = parseSetCookie(serialized);
    if (cookie.attributes["max-age"] === "0") delete jar[cookie.name];
    else jar[cookie.name] = cookie.value;
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
function described(value: unknown): { status: number; data?: unknown; location?: string | null; headers?: Record<string, string> } {
  if (value instanceof Response) return { status: value.status, location: value.headers.get("Location"), headers: Object.fromEntries(value.headers) };
  const init = (value as { type?: string; init?: { status?: number; headers?: HeadersInit }; data?: unknown }) ?? {};
  if (init.type === "DataWithResponseInit") return { status: init.init?.status ?? 200, data: init.data, headers: Object.fromEntries(new Headers(init.init?.headers)) };
  throw new Error(`Not a response: ${String(value)}`);
}

const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");

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

const SITE = "http://localhost:5173";
const admin = (pathname: string, cookies: Record<string, string> = {}, init: RequestInit = {}) =>
  new Request(`${SITE}${pathname}`, { ...init, headers: { ...(Object.keys(cookies).length ? { Cookie: cookieHeader(cookies) } : {}), ...(init.headers as Record<string, string> | undefined) } });
const samePost = (body: Record<string, string>): RequestInit => ({ method: "POST", headers: { Origin: SITE, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

type HandlerArgs = { request: Request; context: RouterContextProvider; url: URL; pattern: string; params: Record<string, string> };

/**
 * The admin layout's real gate for a matched route pattern, then `handler` (a route's loader or action) — the way React
 * Router runs them: root middleware → gate → handler. `ran` says whether anything below the gate was called.
 */
async function viaGate(req: Request, pattern: string, handler?: (args: HandlerArgs) => Promise<unknown>, params: Record<string, string> = {}) {
  let ran = false;
  const outcome = await throughRoot(req, async (context, url) =>
    (await adminGate({ request: req, context, url, pattern, params }, async () => {
      ran = true;
      const value = handler ? await handler({ request: req, context, url, pattern, params }) : null;
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value ?? null), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    })) as Response,
  );
  return { outcome, ran };
}

const loginUrl = (query = "") => new URL(`${SITE}/admin/login${query}`);
const docRequest = (url: URL, headers: Record<string, string> = {}) => new Request(url, { headers });

const OWNER = { name: "مالك الاختبار", email: "owner@adversary.test", password: remember("an-owner-password-that-is-long") };

/** An employee holding `role` (or no role at all), with a password hashed at `iterations`. */
async function staff(role: DefaultRoleKey | null, password: string = remember(`pw-${randomToken(9)}`), iterations = 1000) {
  const hashed = await hashPassword(password, iterations);
  const email = `${make.next(role ?? "norole")}@adversary.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (role) await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password };
}

async function signedIn(email: string, password: string, now = NOW, options: { https?: boolean; cookies?: Record<string, string> } = {}) {
  const req = request({ now, https: options.https, cookies: options.cookies });
  const result = await signInEmployee(req.ctx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error(`expected a full sign-in, got ${result.status}`);
  const cookies = cookiesAfter(req, options.cookies);
  remember(cookies[ADMIN_COOKIE]);
  return { session: result.session, cookies, setCookies: req.setCookies };
}

/**
 * Turns two-step verification on for an employee (fresh session, so no password needed) and returns the secret and the
 * device's cookies — the ones the confirmation set: turning two-step on moves the device to a new session token.
 */
async function enrolled(person: { email: string; password: string }, at: number) {
  const login = await signedIn(person.email, person.password, at);
  const begin = request({ cookies: login.cookies, now: at + SECOND });
  const { secret } = await beginTotpEnrollment(begin.ctx, t.db, secrets);
  remember(secret);
  const confirm = request({ cookies: login.cookies, now: at + 2 * SECOND });
  const { recoveryCodes } = await confirmTotpEnrollment(confirm.ctx, t.db, { code: await totpCode(secret, at + 2 * SECOND) }, secrets);
  for (const code of recoveryCodes) remember(code);
  const cookies = cookiesAfter(confirm, login.cookies);
  remember(cookies[ADMIN_COOKIE]);
  return { secret, recoveryCodes, cookies };
}

/** Password step of a two-step sign-in: the half-open session's cookies. */
async function halfOpen(email: string, password: string, now: number) {
  const req = request({ now });
  const result = await signInEmployee(req.ctx, t.db, { email, password });
  expect(result.status).toBe("mfa_required");
  const cookies = cookiesAfter(req);
  remember(cookies[ADMIN_COOKIE]);
  return cookies;
}

const passwordStep = (email: string, password: string, options: Parameters<typeof request>[0] = {}, url = loginUrl()) =>
  loginAction(request(options).ctx, t.db, secrets, url, form({ intent: "password", email, password }));

const codeStep = (cookies: Record<string, string>, code: string, now: number) => loginAction(request({ cookies, now }).ctx, t.db, secrets, loginUrl(), form({ intent: "code", code }));

/** Six-digit codes that are NOT valid around `at` (so a "wrong code" can never be right by accident). */
async function wrongCodes(secret: string, at: number, n: number): Promise<string[]> {
  const valid = new Set(await Promise.all([-1, 0, 1].map((step) => totpCode(secret, at + step * 30 * SECOND))));
  const out: string[] = [];
  for (let candidate = 100000; out.length < n; candidate += 7919) if (!valid.has(String(candidate))) out.push(String(candidate));
  return out;
}

/** A Location header is a same-origin admin path a browser cannot read as another site, in plain ASCII. */
function expectSafeAdminLocation(location: string | null | undefined, label: string) {
  expect(location, label).toBeTruthy();
  const value = String(location);
  expect(value, `${label}: printable ASCII only`).toMatch(/^[\x21-\x7e]+$/);
  expect(value, `${label}: a local path`).toMatch(/^\/(?![/\\])/);
  const resolved = new URL(value, "https://tamtamgames.com/admin/login");
  expect(resolved.origin, label).toBe("https://tamtamgames.com");
  expect(resolved.pathname === "/admin" || resolved.pathname.startsWith("/admin/"), `${label}: under /admin (${resolved.pathname})`).toBe(true);
  return resolved;
}

const count = async (table: typeof employees | typeof roles | typeof auditEvents) => (await t.db.select().from(table)).length;

// ───────────────────────────────────────────────────────────────── 1 setup

describe("1 setup: once, only with the token", () => {
  test("refused without a usable SETUP_TOKEN and with a wrong, partial, missing or differently-cased token — nothing is written", async () => {
    expect(await setupLoader(t.db, {})).toEqual({ state: "disabled" });
    expect(await setupLoader(t.db, { SETUP_TOKEN: "x".repeat(15) })).toEqual({ state: "disabled" });
    expect(await setupLoader(t.db, { SETUP_TOKEN: " ".repeat(40) })).toEqual({ state: "disabled" });
    expect(await setupLoader(t.db, { SETUP_TOKEN })).toEqual({ state: "ready" });

    const before = await count(auditEvents);
    const owner = { name: OWNER.name, email: OWNER.email, password: OWNER.password, confirm: OWNER.password };
    // A configured-but-short secret is "switched off", whatever is typed — even the short secret itself.
    const off = (await setupAction(request().ctx, t.db, { SETUP_TOKEN: "short-secret" }, form({ setupToken: "short-secret", ...owner }))) as SetupFailure;
    expect(off).toMatchObject({ ok: false, code: "setup_disabled", status: 403 });

    const attempts: [string, Record<string, string>][] = [
      ["wrong", { setupToken: "not-the-setup-token-at-all", ...owner }],
      ["all but the last character", { setupToken: SETUP_TOKEN.slice(0, -1), ...owner }],
      ["one character more", { setupToken: `${SETUP_TOKEN}x`, ...owner }],
      ["upper-cased", { setupToken: SETUP_TOKEN.toUpperCase() === SETUP_TOKEN ? SETUP_TOKEN.toLowerCase() : SETUP_TOKEN.toUpperCase(), ...owner }],
      ["missing", { ...owner }],
      ["empty", { setupToken: "", ...owner }],
    ];
    for (const [label, fields] of attempts) {
      const failure = (await setupAction(request().ctx, t.db, { SETUP_TOKEN }, form(fields))) as SetupFailure;
      expect(failure, label).toMatchObject({ ok: false, code: "setup_token_invalid", status: 403, fields: { setupToken: expect.any(String) } });
      expect(JSON.stringify(failure), label).not.toContain(SETUP_TOKEN);
    }
    expect(await count(employees)).toBe(0);
    expect(await count(roles)).toBe(0);
    expect(await count(auditEvents)).toBe(before);
  });

  test("the token comparison takes the same time whatever was typed (no early exit to time)", async () => {
    // With no client address there is no rate-limit row to write, so a refused attempt is pure CPU: the measurement
    // sees only the comparison. Both sides are hashed before a constant-time compare, so a near miss is no slower.
    const candidates = {
      far: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      near: `${SETUP_TOKEN.slice(0, -1)}${SETUP_TOKEN.endsWith("A") ? "B" : "A"}`,
      tiny: "a",
      huge: "q".repeat(4000),
    };
    const samples: Record<keyof typeof candidates, number[]> = { far: [], near: [], tiny: [], huge: [] };
    const raw = (token: string) => ({ setupToken: token, email: "x@adversary.test", name: "Nobody", password: "irrelevant-password" });
    for (let round = 0; round < 120; round++) {
      for (const key of Object.keys(candidates) as (keyof typeof candidates)[]) {
        const started = performance.now();
        await thrown(() => createFirstOwner(t.db, raw(candidates[key]), NOW, { SETUP_TOKEN }, { ip: null }));
        samples[key].push(performance.now() - started);
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const medians = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, median(values)]));
    // Hashing a 4,000-character string costs microseconds; a byte-by-byte early exit is what this would catch
    // only if it were large, so the bound is loose on purpose: no candidate stands out by more than half a millisecond.
    expect(Math.max(...Object.values(medians)) - Math.min(...Object.values(medians)), JSON.stringify(medians)).toBeLessThan(0.5);
    expect(await count(employees)).toBe(0);
  });

  test("five attempts per address per hour: the sixth is refused even with the right token", async () => {
    const ip = uniqueIp();
    const owner = { name: OWNER.name, email: OWNER.email, password: OWNER.password, confirm: OWNER.password };
    for (let i = 0; i < RATE_LIMITS.setup.limit; i++) {
      expect(await setupAction(request({ ip }).ctx, t.db, { SETUP_TOKEN }, form({ setupToken: `wrong-token-${i}-xxxxxxxx`, ...owner }))).toMatchObject({ code: "setup_token_invalid" });
    }
    const blocked = (await setupAction(request({ ip }).ctx, t.db, { SETUP_TOKEN }, form({ setupToken: SETUP_TOKEN, ...owner }))) as SetupFailure;
    expect(blocked).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
    expect(await count(employees)).toBe(0);
  });

  test("simultaneous setups create exactly ONE owner; the losers get the 404 of a page that no longer exists", async () => {
    const contenders = Array.from({ length: 5 }, (_, i) => ({ name: `Contender ${i}`, email: i === 0 ? OWNER.email : `contender-${i}@adversary.test`, password: i === 0 ? OWNER.password : remember(`contender-password-${i}-xyz`) }));
    const outcomes = await Promise.all(
      contenders.map(async (who) => {
        try {
          return { value: await setupAction(request({ ip: null }).ctx, t.db, { SETUP_TOKEN }, form({ setupToken: SETUP_TOKEN, ...who, confirm: who.password })) };
        } catch (error) {
          return { error };
        }
      }),
    );
    const won = outcomes.filter((outcome) => "value" in outcome && outcome.value instanceof Response);
    const lost = outcomes.filter((outcome) => "error" in outcome);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(4);
    for (const outcome of lost) expect(described((outcome as { error: unknown }).error)).toMatchObject({ status: 404 });
    expect(described((won[0] as { value: Response }).value)).toMatchObject({ status: 302, location: "/admin/login?setup=done" });

    const owners = await t.db.select().from(employees);
    expect(owners).toHaveLength(1);
    expect((await t.db.select().from(roles)).map((role) => role.key).sort()).toEqual(DEFAULT_ROLES.map((role) => role.key).sort());
    expect(await t.db.select().from(employeeRoles).where(eq(employeeRoles.employeeId, owners[0].id))).toHaveLength(1);
    // The winner may be any contender: from here on, the file signs in as whoever won.
    const winner = contenders.find((who) => who.email === owners[0].email)!;
    Object.assign(OWNER, winner);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "staff.employee.bootstrap"))).toHaveLength(1);
  });

  test("after success the page is a 404 for GET and POST, with or without the right token, and writes nothing", async () => {
    expect(described(await thrown(() => setupLoader(t.db, { SETUP_TOKEN })))).toMatchObject({ status: 404 });
    for (const token of [SETUP_TOKEN, "wrong-token-entirely-wrong"]) {
      const replay = await thrown(() => setupAction(request().ctx, t.db, { SETUP_TOKEN }, form({ setupToken: token, name: "Second Owner", email: "second@adversary.test", password: "second-owner-password", confirm: "second-owner-password" })));
      expect(described(replay)).toMatchObject({ status: 404 });
    }
    // Even the service itself, called directly, refuses before writing anything.
    expect(await thrown(() => createFirstOwner(t.db, { setupToken: SETUP_TOKEN, email: "third@adversary.test", name: "Third", password: "third-owner-password" }, NOW, { SETUP_TOKEN }, { ip: uniqueIp() }))).toMatchObject({ code: "setup_done" });
    expect(await count(employees)).toBe(1);
    // Another employee (not an owner) changes nothing: only "no employee at all" opens the page.
    await staff("cashier");
    expect(await setupLoader(t.db, { SETUP_TOKEN }).catch((error: unknown) => described(error).status)).toBe(404);
  });

  test("setup leaves one audit event that holds no password, hash or token", async () => {
    const event = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "staff.employee.bootstrap")).get();
    expect(event).toMatchObject({ actorKind: "system", entityType: "employee", after: { email: OWNER.email, roles: ["owner"] } });
    const text = JSON.stringify(event);
    for (const secret of [OWNER.password, SETUP_TOKEN, "pbkdf2-sha256$"]) expect(text).not.toContain(secret);
  });
});

// ───────────────────────────────────────────────────────────────── 2 sign-in

describe("2 sign-in: no enumeration, lockout, limits", () => {
  test("unknown email, wrong password, a disabled account and an account without a password read exactly the same", async () => {
    const disabled = await staff("support");
    await t.db.update(employees).set({ status: "disabled" }).where(eq(employees.id, disabled.id));
    const noPassword = await make.employee({ email: "no-password@adversary.test" });
    expect(noPassword).toBeTruthy();
    const cases = [
      ["unknown email", "ghost-1@adversary.test", "some-password-123"],
      ["wrong password", OWNER.email, "not-the-owner-password"],
      ["disabled, right password", disabled.email, disabled.password],
      ["no password set", "no-password@adversary.test", "any-password-at-all"],
    ] as const;
    const answers: Record<string, unknown>[] = [];
    for (const [label, email, password] of cases) {
      const failure = (await passwordStep(email, password, { now: NOW + 2 * HOUR })) as LoginFailure;
      expect(failure, label).toMatchObject({ ok: false, step: "password", code: "invalid_credentials", status: 401 });
      const { email: echoed, ...rest } = failure;
      expect(echoed, label).toBe(email);
      answers.push(rest);
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    // A failed attempt opens nothing: no session row for any of them.
    expect(await t.db.select().from(employeeSessions).where(eq(employeeSessions.employeeId, disabled.id))).toHaveLength(0);
  });

  test("…and take the same time: an unknown email costs one full password hash like a real one", async () => {
    const real = await staff("support", remember("timing-password-123"), 100_000);
    const durations: Record<"unknown" | "wrong", number[]> = { unknown: [], wrong: [] };
    for (let round = 0; round < 6; round++) {
      // 16 minutes apart: every attempt falls in a fresh lockout window, so the real account is never locked here.
      const now = NOW + 3 * HOUR + round * 16 * MINUTE;
      for (const kind of round % 2 ? (["unknown", "wrong"] as const) : (["wrong", "unknown"] as const)) {
        const email = kind === "unknown" ? `timing-ghost-${round}@adversary.test` : real.email;
        const started = performance.now();
        const failure = await passwordStep(email, `wrong-${round}-password`, { now });
        durations[kind].push(performance.now() - started);
        expect(failure).toMatchObject({ code: "invalid_credentials" });
      }
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    const ratio = median(durations.unknown) / median(durations.wrong);
    expect(ratio, JSON.stringify(durations)).toBeGreaterThan(0.5);
    expect(ratio, JSON.stringify(durations)).toBeLessThan(2);
  });

  test("five failures lock the email — real or not — with the same words; the window's end and a success reset it", async () => {
    const victim = await staff("inventory");
    const start = NOW + 6 * HOUR + 30 * SECOND;
    for (const email of [victim.email, "ghost-lock@adversary.test"]) {
      for (let i = 0; i < RATE_LIMITS.adminSignInFailures.limit; i++) expect(await passwordStep(email, `guess-${i}-password`, { now: start + i * SECOND })).toMatchObject({ code: "invalid_credentials" });
    }
    const lockedReal = (await passwordStep(victim.email, victim.password, { now: start + 10 * SECOND })) as LoginFailure;
    const lockedGhost = (await passwordStep("ghost-lock@adversary.test", "anything-goes-here", { now: start + 10 * SECOND })) as LoginFailure;
    expect(lockedReal).toMatchObject({ ok: false, code: "locked_out", status: 429 });
    expect({ ...lockedReal, email: null }).toEqual({ ...lockedGhost, email: null });
    // The lock ends with its window …
    expect(described(await passwordStep(victim.email, victim.password, { now: start + 16 * MINUTE }))).toMatchObject({ status: 302 });
    // … and a success clears the failures before it: four more failures do not lock.
    for (let i = 0; i < 4; i++) await passwordStep(victim.email, `typo-${i}-password`, { now: start + 17 * MINUTE });
    expect(described(await passwordStep(victim.email, victim.password, { now: start + 17 * MINUTE }))).toMatchObject({ status: 302 });
    for (let i = 0; i < 4; i++) await passwordStep(victim.email, `typo-${i}-again`, { now: start + 17 * MINUTE });
    expect(described(await passwordStep(victim.email, victim.password, { now: start + 17 * MINUTE }))).toMatchObject({ status: 302 });
  });

  test("was broken — parallel guesses cannot slip past the lock: at most five passwords are tried per window", async () => {
    // Before the fix the lock was READ before the password check and counted after it, so 12 guesses sent at once all
    // read "not locked" and all 12 were tried (the dev server let 15 of 40 through). Now each attempt is counted first.
    const victim = await staff("finance");
    const at = NOW + 7 * HOUR + 5 * SECOND;
    const outcomes = (await Promise.all(Array.from({ length: 12 }, (_, i) => passwordStep(victim.email, `parallel-guess-${i}`, { now: at, ip: uniqueIp() })))) as LoginFailure[];
    const tried = outcomes.filter((outcome) => outcome.code === "invalid_credentials").length;
    expect(tried).toBeLessThanOrEqual(RATE_LIMITS.adminSignInFailures.limit);
    expect(outcomes.filter((outcome) => outcome.code === "locked_out")).toHaveLength(12 - tried);
    expect(await passwordStep(victim.email, victim.password, { now: at + SECOND })).toMatchObject({ code: "locked_out" });
    expect(await t.db.select().from(authEvents).where(and(eq(authEvents.kind, "lockout"), eq(authEvents.identifier, victim.email)))).toHaveLength(1);
  });

  test("twenty attempts per address across all accounts; then even the right password for another account waits", async () => {
    const ip = uniqueIp();
    for (let i = 0; i < RATE_LIMITS.adminSignInIp.limit; i++) await passwordStep(`spray-${i}@adversary.test`, "Summer2026!x", { ip, now: NOW + 8 * HOUR });
    const blocked = (await passwordStep(OWNER.email, OWNER.password, { ip, now: NOW + 8 * HOUR })) as LoginFailure;
    expect(blocked).toMatchObject({ ok: false, code: "rate_limited", status: 429 });
    expect(described(await passwordStep(OWNER.email, OWNER.password, { ip: uniqueIp(), now: NOW + 8 * HOUR }))).toMatchObject({ status: 302 });
  });
});

// ───────────────────────────────────────────────────────────────── 3 two-step

describe("3 two-step verification", () => {
  test("a used code is refused; codes two steps away are refused; one step of drift is accepted", async () => {
    const person = await staff("support");
    const base = NOW + 10 * HOUR + 15 * SECOND; // the middle of a 30-second step
    const { secret } = await enrolled(person, base);
    const at = base + 12 * MINUTE; // a fresh 10-minute window for code attempts

    for (const [label, offset] of [["two steps ago", -60 * SECOND], ["two steps ahead", 60 * SECOND], ["an hour ago", -HOUR]] as const) {
      const cookies = await halfOpen(person.email, person.password, at);
      expect(await codeStep(cookies, await totpCode(secret, at + offset), at), label).toMatchObject({ ok: false, code: "mfa_invalid" });
    }
    // One step of clock drift either way is accepted (RFC 6238 ±1) …
    const late = await halfOpen(person.email, person.password, at + 30 * SECOND);
    const lastStepsCode = await totpCode(secret, at);
    expect(described(await codeStep(late, lastStepsCode, at + 30 * SECOND))).toMatchObject({ status: 302 });
    // … once: the same code again, still inside its window, from a fresh password step.
    const replay = await halfOpen(person.email, person.password, at + 31 * SECOND);
    expect(await codeStep(replay, lastStepsCode, at + 31 * SECOND)).toMatchObject({ ok: false, code: "mfa_invalid" });
  });

  test("one code sent from two half-open sessions at the same moment opens exactly one session", async () => {
    const person = await staff("support");
    const base = NOW + 11 * HOUR + 15 * SECOND;
    const { secret } = await enrolled(person, base);
    const at = base + 12 * MINUTE;
    const code = await totpCode(secret, at);
    const sessions = await Promise.all([halfOpen(person.email, person.password, at), halfOpen(person.email, person.password, at)]);
    const outcomes = await Promise.all(sessions.map((cookies) => codeStep(cookies, code, at)));
    expect(outcomes.filter((outcome) => outcome instanceof Response)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !(outcome instanceof Response) && (outcome as LoginFailure).code === "mfa_invalid")).toHaveLength(1);
  });

  test("a recovery code works once — also when the same code is sent twice at the same moment", async () => {
    const person = await staff("support");
    const base = NOW + 12 * HOUR + 15 * SECOND;
    const { recoveryCodes } = await enrolled(person, base);
    const at = base + 5 * MINUTE;
    const code = recoveryCodes[3];
    const sessions = await Promise.all([halfOpen(person.email, person.password, at), halfOpen(person.email, person.password, at)]);
    const outcomes = await Promise.all(sessions.map((cookies) => codeStep(cookies, code, at)));
    expect(outcomes.filter((outcome) => outcome instanceof Response)).toHaveLength(1);
    // Spelled differently (lower case, no dash) it is the same, already used code.
    const again = await halfOpen(person.email, person.password, at + SECOND);
    expect(await codeStep(again, code.replace("-", "").toLowerCase(), at + SECOND)).toMatchObject({ ok: false, code: "mfa_invalid" });
    expect((await t.db.select().from(employees).where(eq(employees.id, person.id)).get())?.recoveryCodes).toHaveLength(9);
  });

  test("guessing codes is capped at six per ten minutes per employee — a new password step does not buy more", async () => {
    const person = await staff("support");
    const base = NOW + 13 * HOUR + 15 * SECOND;
    const { secret } = await enrolled(person, base);
    const at = base + 20 * MINUTE; // a fresh 10-minute window (enrolment used one attempt in its own)
    let cookies = await halfOpen(person.email, person.password, at);
    const wrong = await wrongCodes(secret, at, RATE_LIMITS.mfaVerify.limit + 1);
    for (let i = 0; i < RATE_LIMITS.mfaVerify.limit; i++) expect(await codeStep(cookies, wrong[i], at)).toMatchObject({ code: "mfa_invalid" });
    // The seventh ends the half-open session …
    expect(await codeStep(cookies, wrong[RATE_LIMITS.mfaVerify.limit], at)).toMatchObject({ ok: false, step: "password", code: "mfa_locked" });
    expect(await getPendingMfa(request({ cookies, now: at }).ctx, t.db)).toBeNull();
    // … and the password again opens a half-open session that still cannot try a code — not even the right one.
    cookies = await halfOpen(person.email, person.password, at + SECOND);
    expect(await codeStep(cookies, await totpCode(secret, at + SECOND), at + SECOND)).toMatchObject({ ok: false, code: "mfa_locked" });
    // The next window allows the right code.
    const later = at + 10 * MINUTE;
    cookies = await halfOpen(person.email, person.password, later);
    expect(described(await codeStep(cookies, await totpCode(secret, later), later))).toMatchObject({ status: 302 });
  });

  test("was broken — a copy of an older session cannot tie the account to another phone without the password", async () => {
    // Enrolment signs every other device out, so before the fix anyone holding a copy of the cookie could enrol THEIR
    // authenticator and lock the real employee out of their own account. Now the password is needed again unless the
    // session was opened with it in the last 15 minutes.
    const victim = await staff("finance");
    const at = NOW + 14 * HOUR;
    const victimLaptop = await signedIn(victim.email, victim.password, at);
    const victimPhone = await signedIn(victim.email, victim.password, at + MINUTE);
    const later = at + RECENT_SIGN_IN_MS + MINUTE;
    const stolen = request({ cookies: victimLaptop.cookies, now: later });
    const stolenSession = (await getEmployee(stolen.ctx, t.db))!;
    const withoutPassword = await mySecurityAction(stolen.ctx, t.db, stolenSession, secrets, form({ intent: "totp-begin" }));
    expect(withoutPassword).toMatchObject({ ok: false, intent: "totp-begin", code: "invalid", fields: { password: expect.any(String) } });
    const wrongPassword = await mySecurityAction(stolen.ctx, t.db, stolenSession, secrets, form({ intent: "totp-begin", password: "a-guessed-password" }));
    expect(wrongPassword).toMatchObject({ ok: false, code: "invalid", fields: { password: expect.any(String) } });
    expect(JSON.stringify([withoutPassword, wrongPassword])).not.toMatch(/otpauth|secret/i);
    const row = await t.db.select().from(employees).where(eq(employees.id, victim.id)).get();
    expect(row).toMatchObject({ totpEnabled: false, totpSecretEnc: null });
    expect(await getEmployee(request({ cookies: victimPhone.cookies, now: later }).ctx, t.db)).not.toBeNull();
    expect(await t.db.select().from(authEvents).where(and(eq(authEvents.subjectId, victim.id), eq(authEvents.kind, "mfa_enroll"), eq(authEvents.success, false)))).toHaveLength(1);

    // The employee, typing the password, can.
    const own = await mySecurityAction(stolen.ctx, t.db, stolenSession, secrets, form({ intent: "totp-begin", password: victim.password }));
    expect(own).toMatchObject({ ok: true, intent: "totp-begin" });
    // A session opened with the password a moment ago needs no second typing (the 15-minute grace).
    const fresh = await signedIn(victim.email, victim.password, later);
    const freshReq = request({ cookies: fresh.cookies, now: later + MINUTE });
    expect(await mySecurityAction(freshReq.ctx, t.db, (await getEmployee(freshReq.ctx, t.db))!, secrets, form({ intent: "totp-begin" }))).toMatchObject({ ok: true });
  });
});

// ───────────────────────────────────────────────────────────────── 4 sessions

describe("4 sessions: fixation, rotation, revocation", () => {
  test("a cookie planted before sign-in is replaced and its session ended; the second step issues another token", async () => {
    const attacker = await staff("cashier");
    const victim = await staff("support");
    const at = NOW + 20 * HOUR;
    const attackers = await signedIn(attacker.email, attacker.password, at);
    // The attacker's own valid token (or a made-up one) sits in the victim's browser when the victim signs in.
    for (const planted of [attackers.cookies[ADMIN_COOKIE], randomToken()]) {
      const login = await signedIn(victim.email, victim.password, at + MINUTE, { cookies: { [ADMIN_COOKIE]: planted } });
      expect(login.cookies[ADMIN_COOKIE]).not.toBe(planted);
      expect(login.session.employee.id).toBe(victim.id);
      expect(await getEmployee(request({ cookies: { [ADMIN_COOKIE]: planted }, now: at + 2 * MINUTE }).ctx, t.db)).toBeNull();
    }
    // Password step → code step: the half-open token never becomes the full one.
    const person = await staff("support");
    const { secret } = await enrolled(person, at + 15 * SECOND);
    const half = await halfOpen(person.email, person.password, at + 5 * MINUTE);
    const verify = request({ cookies: half, now: at + 5 * MINUTE });
    await verifyEmployeeMfa(verify.ctx, t.db, { code: await totpCode(secret, at + 5 * MINUTE) }, secrets);
    const full = cookiesAfter(verify, half);
    expect(full[ADMIN_COOKIE]).not.toBe(half[ADMIN_COOKIE]);
    expect(await getEmployee(request({ cookies: half, now: at + 6 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: full, now: at + 6 * MINUTE }).ctx, t.db)).not.toBeNull();
  });

  // Was open (OWASP: renew the session id after a credential change): the device that changed its password or its
  // two-step setting kept its token, so a COPY of that cookie stayed signed in. Closed 2026-11-11 (server pass): the
  // changing device continues on a new token; the old one is dead. More cases: tests/auth-rotation.test.ts.
  test("was open — after a password change or a two-step change, a copy of the cookie that made it no longer works", async () => {
    const person = await staff("content");
    const at = NOW + 21 * HOUR + 15 * SECOND;
    const here = await signedIn(person.email, person.password, at);
    const copy = { ...here.cookies };
    const change = request({ cookies: here.cookies, now: at + MINUTE });
    const changed = await mySecurityAction(change.ctx, t.db, (await getEmployee(change.ctx, t.db))!, secrets, form({ intent: "password", currentPassword: person.password, newPassword: remember("a-fresh-password-456"), confirmPassword: "a-fresh-password-456" }));
    expect(changed).toEqual({ ok: true, intent: "password" });
    expect(await getEmployee(request({ cookies: copy, now: at + 2 * MINUTE }).ctx, t.db)).toBeNull();
    // The device that made the change carries on with the cookie its answer set — on both cookie paths.
    const rotated = cookiesAfter(change, here.cookies);
    remember(rotated[ADMIN_COOKIE]);
    expect(rotated[ADMIN_COOKIE]).not.toBe(copy[ADMIN_COOKIE]);
    expect(change.setCookies.map(parseSetCookie).map((cookie) => [cookie.name, cookie.attributes.path])).toEqual([
      [ADMIN_COOKIE, "/admin"],
      [ADMIN_COOKIE, "/admin.data"],
    ]);
    expect((await getEmployee(request({ cookies: rotated, now: at + 2 * MINUTE }).ctx, t.db))?.employee.id).toBe(person.id);

    // Two-step on, then off: each change moves the device to a new token again and kills the one before.
    const begin = request({ cookies: rotated, now: at + 3 * MINUTE });
    const begun = await mySecurityAction(begin.ctx, t.db, (await getEmployee(begin.ctx, t.db))!, secrets, form({ intent: "totp-begin", password: "a-fresh-password-456" }));
    if (!begun.ok || begun.intent !== "totp-begin") throw new Error("enrolment did not start");
    const secret = remember(begun.secret.replace(/ /g, ""));
    const confirm = request({ cookies: rotated, now: at + 4 * MINUTE });
    const confirmed = await mySecurityAction(confirm.ctx, t.db, (await getEmployee(confirm.ctx, t.db))!, secrets, form({ intent: "totp-confirm", code: await totpCode(secret, at + 4 * MINUTE) }));
    expect(confirmed).toMatchObject({ ok: true, intent: "totp-confirm" });
    if (confirmed.ok && confirmed.intent === "totp-confirm") for (const code of confirmed.recoveryCodes) remember(code);
    const enrolledJar = cookiesAfter(confirm, rotated);
    remember(enrolledJar[ADMIN_COOKIE]);
    expect(await getEmployee(request({ cookies: rotated, now: at + 5 * MINUTE }).ctx, t.db)).toBeNull();
    expect(await getEmployee(request({ cookies: enrolledJar, now: at + 5 * MINUTE }).ctx, t.db)).toMatchObject({ session: { mfaOk: true } });

    const off = request({ cookies: enrolledJar, now: at + 6 * MINUTE });
    const turnedOff = await mySecurityAction(off.ctx, t.db, (await getEmployee(off.ctx, t.db))!, secrets, form({ intent: "totp-disable", password: "a-fresh-password-456", code: await totpCode(secret, at + 6 * MINUTE) }));
    expect(turnedOff).toEqual({ ok: true, intent: "totp-disable" });
    const offJar = cookiesAfter(off, enrolledJar);
    remember(offJar[ADMIN_COOKIE]);
    expect(await getEmployee(request({ cookies: enrolledJar, now: at + 7 * MINUTE }).ctx, t.db)).toBeNull();
    expect((await getEmployee(request({ cookies: offJar, now: at + 7 * MINUTE }).ctx, t.db))?.employee.totpEnabled).toBe(false);
    // One live session is left: this device's newest.
    const live = (await t.db.select().from(employeeSessions).where(eq(employeeSessions.employeeId, person.id))).filter((row) => row.revokedAt === null);
    expect(live).toHaveLength(1);
  });

  test("a password change ends every other session — other devices and half-open sign-ins alike", async () => {
    const person = await staff("support");
    const at = NOW + 22 * HOUR + 15 * SECOND;
    const { secret } = await enrolled(person, at);
    const enrolledDevice = (await t.db.select().from(employeeSessions).where(and(eq(employeeSessions.employeeId, person.id), eq(employeeSessions.mfaOk, true))).get())!;
    expect(enrolledDevice).toBeTruthy();
    // A second full device (password + code) and a half-open sign-in that has not given its code yet.
    const other = await halfOpen(person.email, person.password, at + MINUTE);
    const otherReq = request({ cookies: other, now: at + MINUTE });
    await verifyEmployeeMfa(otherReq.ctx, t.db, { code: await totpCode(secret, at + MINUTE) }, secrets);
    const otherFull = cookiesAfter(otherReq, other);
    const pending = await halfOpen(person.email, person.password, at + 2 * MINUTE);

    const changer = await halfOpen(person.email, person.password, at + 3 * MINUTE);
    const changerReq = request({ cookies: changer, now: at + 3 * MINUTE + 30 * SECOND });
    await verifyEmployeeMfa(changerReq.ctx, t.db, { code: await totpCode(secret, at + 3 * MINUTE + 30 * SECOND) }, secrets);
    const changerFull = cookiesAfter(changerReq, changer);
    const change = request({ cookies: changerFull, now: at + 4 * MINUTE });
    const result = await mySecurityAction(change.ctx, t.db, (await getEmployee(change.ctx, t.db))!, secrets, form({ intent: "password", currentPassword: person.password, newPassword: remember("changed-password-789"), confirmPassword: "changed-password-789" }));
    expect(result).toEqual({ ok: true, intent: "password" });

    const later = at + 5 * MINUTE;
    expect(await getEmployee(request({ cookies: otherFull, now: later }).ctx, t.db)).toBeNull();
    expect(await getPendingMfa(request({ cookies: pending, now: later }).ctx, t.db)).toBeNull();
    expect(await codeStep(pending, await totpCode(secret, later), later)).toMatchObject({ ok: false, code: "mfa_expired" });
    const live = await t.db.select().from(employeeSessions).where(and(eq(employeeSessions.employeeId, person.id)));
    expect(live.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  test("“sign out on every device” ends every session — full, half-open and in other browsers — through the real endpoint", async () => {
    const person = await staff("support");
    const at = Date.now(); // the root middleware stamps requests with the real clock
    const { secret } = await enrolled(person, at - 2 * MINUTE); // its code's step lies well before the ones used below
    const devices: Record<string, string>[] = [];
    for (let i = 0; i < 2; i++) {
      const half = await halfOpen(person.email, person.password, at);
      const step = request({ cookies: half, now: at });
      // Each full sign-in needs an unused code: one from the step before and one from the current step.
      await verifyEmployeeMfa(step.ctx, t.db, { code: await totpCode(secret, at - i * 30 * SECOND) }, secrets);
      devices.push(cookiesAfter(step, half));
    }
    const pending = await halfOpen(person.email, person.password, at);
    const out = admin("/admin/logout", devices[0], samePost({ scope: "all" }));
    const response = (await throughRoot(out, async (context, url) => signOutAction({ request: out, context, url, pattern: "admin/logout", params: {} } as Parameters<typeof signOutAction>[0]))) as Response;
    expect(described(response)).toMatchObject({ status: 302, location: "/admin/login?signed_out=all" });
    expect(response.headers.getSetCookie().map(parseSetCookie).filter((cookie) => cookie.name === ADMIN_COOKIE).map((cookie) => cookie.attributes["max-age"])).toEqual(["0", "0"]);

    for (const jar of devices) expect(await getEmployee(request({ cookies: jar, now: at + SECOND }).ctx, t.db)).toBeNull();
    expect(await getPendingMfa(request({ cookies: pending, now: at + SECOND }).ctx, t.db)).toBeNull();
    const rows = await t.db.select().from(employeeSessions).where(eq(employeeSessions.employeeId, person.id));
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    expect(await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "security.session.revoke"), eq(auditEvents.entityId, person.id)))).toHaveLength(1);
    // A GET cannot sign anyone out (a link or an <img> pointing at it does nothing).
    const half = await halfOpen(person.email, person.password, Date.now());
    const step = request({ cookies: half, now: Date.now() });
    await verifyEmployeeMfa(step.ctx, t.db, { code: await totpCode(secret, Date.now() + 30 * SECOND) }, secrets);
    const fresh = cookiesAfter(step, half);
    expect(described(signOutLoader())).toMatchObject({ status: 302, location: "/admin" });
    expect(await getEmployee(request({ cookies: fresh, now: Date.now() }).ctx, t.db)).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── 5 cookies

describe("5 cookies", () => {
  test("tt_adm is HttpOnly, SameSite=Strict, scoped to /admin and /admin.data, Secure exactly on https, never for a Domain", async () => {
    for (const https of [true, false]) {
      const { setCookies, cookies } = await signedIn(OWNER.email, OWNER.password, NOW + 30 * HOUR, { https });
      const parsed = setCookies.map(parseSetCookie);
      expect(parsed.map((cookie) => [cookie.name, cookie.attributes.path])).toEqual([
        [ADMIN_COOKIE, "/admin"],
        [ADMIN_COOKIE, "/admin.data"],
      ]);
      for (const cookie of parsed) {
        expect(cookie.attributes).toMatchObject({ httponly: true, samesite: "Strict", "max-age": String(12 * 3600) });
        expect(cookie.attributes.secure ?? false).toBe(https);
        expect(cookie.attributes.domain).toBeUndefined();
        expect(cookie.value).toBe(cookies[ADMIN_COOKIE]);
      }
      // What the database keeps is not the token.
      expect(JSON.stringify(await t.db.select().from(employeeSessions))).not.toContain(cookies[ADMIN_COOKIE]);
    }
  });

  test("the session token appears in no redirect, no loader data and no page of the shell", async () => {
    const owner = await signedIn(OWNER.email, OWNER.password, Date.now());
    const token = owner.cookies[ADMIN_COOKIE];
    const signIn = await passwordStep(OWNER.email, OWNER.password, { now: NOW + 31 * HOUR }, loginUrl("?next=%2Fadmin%2Fme"));
    expect(described(signIn).location).toBe("/admin/me");
    const pages: [string, string, (args: HandlerArgs) => Promise<unknown>][] = [
      ["/admin", "admin", (args) => layoutLoader(args as Parameters<typeof layoutLoader>[0])],
      ["/admin/me", "admin/me", (args) => meLoader(args as Parameters<typeof meLoader>[0])],
      ["/admin/blueprint", "admin/blueprint", (args) => blueprintLoader(args as Parameters<typeof blueprintLoader>[0])],
    ];
    for (const [pathname, pattern, handler] of pages) {
      const { outcome, ran } = await viaGate(admin(pathname, owner.cookies), pattern, handler);
      expect(ran, pathname).toBe(true);
      const body = await (outcome as Response).text();
      expect(body, pathname).not.toContain(token);
      expect(body, pathname).not.toContain("pbkdf2");
    }
    // Leaving the admin's pages for the sign-in page carries no token either.
    const { outcome } = await viaGate(admin("/admin/orders?status=new"), "admin/orders");
    expect(described(outcome).location).toBe("/admin/login?next=%2Fadmin%2Forders%3Fstatus%3Dnew");
  });
});

// ───────────────────────────────────────────────────────────────── 6 redirects

const HOSTILE_NEXT: string[] = [
  "//evil.example",
  "///evil.example",
  "/\\evil.example",
  "\\\\evil.example",
  "https://evil.example",
  "https:evil.example",
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "%2F%2Fevil.example",
  "%5C%5Cevil.example",
  "/%2F%2Fevil.example",
  "/%5Cevil.example",
  "%252F%252Fevil.example",
  "/admin/%2F%2Fevil.example",
  "/admin/%5C%5Cevil.example",
  "/admin/%252F%252Fevil.example",
  "/admin\r\nSet-Cookie: tt_adm=x",
  "/admin/%0d%0aSet-Cookie:%20tt_adm=x",
  "/admin/%250d%250aSet-Cookie:%20tt_adm=x",
  "/admin/../",
  "/admin/..",
  "/admin/../..//evil.example",
  "/admin/%2e%2e/%2e%2e//evil.example",
  "/admin/..%2F..%2F%2Fevil.example",
  "/admin@evil.example",
  "/admin.evil.example",
  "/admin\t/x",
  "/admin/login",
  "/admin/LOGIN",
  "/admin/Setup",
  "/admin/%6Cogin",
  "/admin/طلبات",
  "/admin/x\u2028y",
  "/admin/orders?q=أحمد&x=\"<>",
  `/admin/${"a".repeat(600)}`,
];

describe("6 redirects never leave the admin", () => {
  test("next= after the password step: always a same-origin /admin path in plain ASCII (was: raw Unicode reached Location)", async () => {
    // A Location with a raw "أ" or U+2028 throws in Node and other non-workerd runtimes ("not a ByteString") — after the
    // session was already created. adminNextPath now hands back the URL parser's canonical, percent-encoded form.
    const person = await staff("support");
    for (const next of HOSTILE_NEXT) {
      const result = await loginAction(request({ ip: null, now: NOW + 32 * HOUR }).ctx, t.db, secrets, loginUrl(), form({ intent: "password", email: person.email, password: person.password, next }));
      const resolved = expectSafeAdminLocation(described(result).location, JSON.stringify(next));
      expect(/^\/admin\/(login|setup|logout|locale)(\/|$)/i.test(resolved.pathname), JSON.stringify(next)).toBe(false);
    }
    expect(adminNextPath("/admin/طلبات")).toBe("/admin/%D8%B7%D9%84%D8%A8%D8%A7%D8%AA");
    expect(adminNextPath("/admin/x/../orders")).toBe("/admin/orders");
  });

  test("next= in the query string, decoded the way a browser request is (single, double and triple encoding)", async () => {
    const owner = await signedIn(OWNER.email, OWNER.password, NOW + 33 * HOUR);
    const queries = [
      "?next=%2F%2Fevil.example",
      "?next=%252F%252Fevil.example",
      "?next=%25252F%25252Fevil.example",
      "?next=https%3A%2F%2Fevil.example",
      "?next=%2Fadmin%2F%2E%2E%2F%2E%2E%2F%2Fevil.example",
      "?next=%2Fadmin%0D%0ALocation%3A%20https%3A%2F%2Fevil.example",
      "?next=%2Fadmin%2F%D8%A3",
      "?next=%2Fadmin&next=%2F%2Fevil.example",
      "?next=%2F%2Fevil.example&next=%2Fadmin",
    ];
    for (const query of queries) {
      const url = loginUrl(query);
      // Signed in: the loader forwards at once.
      const forwarded = await thrown(() => loginLoader(request({ cookies: owner.cookies, now: NOW + 33 * HOUR }).ctx, t.db, docRequest(url), url));
      expectSafeAdminLocation(described(forwarded).location, `loader ${query}`);
      // Not signed in: the next kept in the form is already the safe one, and so is the cross-site hop.
      const page = await loginLoader(request({ now: NOW + 33 * HOUR }).ctx, t.db, docRequest(url, { "Sec-Fetch-Site": "cross-site" }), url);
      expectSafeAdminLocation(page.next, `form ${query}`);
      expect(page.hop, query).toMatch(/^\/admin\/login\?/);
      const hopNext = new URL(page.hop!, SITE).searchParams.get("next");
      if (hopNext) expectSafeAdminLocation(hopNext, `hop ${query}`);
    }
  });

  test("the language switch's back= follows the same rules (the sign-in page itself is allowed)", async () => {
    for (const back of [...HOSTILE_NEXT, "/admin/login?next=%2Fadmin%2Fme"]) {
      const req = admin("/admin/locale", {}, samePost({ locale: "en", back }));
      const response = (await throughRoot(req, async (context, url) => languageAction({ request: req, context, url, pattern: "admin/locale", params: {} } as Parameters<typeof languageAction>[0]))) as Response;
      expectSafeAdminLocation(described(response).location, JSON.stringify(back));
    }
    expect(adminBackPath("/admin/login?next=%2Fadmin%2Fme")).toBe("/admin/login?next=%2Fadmin%2Fme");
  });

  test("the gate's way to sign-in keeps an encoded, admin-only next, whatever the requested URL looked like", async () => {
    for (const pathname of ["/admin/orders?x=%0d%0a", "/admin/%2F%2Fevil.example", "/admin/..%2F..%2Fevil", "/admin/%D8%B7?q=\"x\"", "/admin//evil.example"]) {
      const { outcome, ran } = await viaGate(admin(pathname), "admin/:module", undefined, { module: "orders" });
      expect(ran, pathname).toBe(false);
      const location = described(outcome).location!;
      expect(location, pathname).toMatch(/^\/admin\/login(\?next=[A-Za-z0-9%._~-]+)?$/);
      const next = new URL(location, SITE).searchParams.get("next");
      if (next) expectSafeAdminLocation(next, pathname);
    }
  });
});

// ───────────────────────────────────────────────────────────────── 7 CSRF

describe("7 CSRF: no state change from another site", () => {
  test("cross-site, null, missing and malformed Origins never reach sign-in, sign-out, enrolment or session revoke", async () => {
    const owner = await signedIn(OWNER.email, OWNER.password, Date.now());
    const targets: [string, Record<string, string>][] = [
      ["/admin/login", { intent: "password", email: OWNER.email, password: OWNER.password }],
      ["/admin/logout", { scope: "all" }],
      ["/admin/me", { intent: "totp-begin" }],
      ["/admin/me", { intent: "revoke", sessionId: owner.session.session.id }],
      ["/admin/me", { intent: "revoke-others" }],
      ["/admin/locale", { locale: "en", back: "/admin" }],
      ["/admin/setup", { setupToken: SETUP_TOKEN, name: "Evil", email: "evil@evil.example", password: "evil-password-1234", confirm: "evil-password-1234" }],
    ];
    const forged: [string, Record<string, string>, string?][] = [
      ["another site", { Origin: "https://evil.example" }],
      ["a sibling subdomain", { Origin: "https://admin.localhost:5173" }],
      ["another port", { Origin: "http://localhost:5174" }],
      ["another scheme", { Origin: "https://localhost:5173" }],
      ["a trailing slash", { Origin: "http://localhost:5173/" }],
      ["the null origin (sandboxed iframe, data: URL)", { Origin: "null" }],
      ["no Origin and no fetch metadata", {}],
      ["no Origin, cross-site metadata", { "Sec-Fetch-Site": "cross-site" }],
      ["no Origin, same-site metadata (a sibling subdomain)", { "Sec-Fetch-Site": "same-site" }],
      ["no Origin, metadata 'none'", { "Sec-Fetch-Site": "none" }],
      ["the right Origin twice", { Origin: `${SITE}, ${SITE}` }],
      ["PUT from another site", { Origin: "https://evil.example" }, "PUT"],
      ["DELETE without Origin", {}, "DELETE"],
      ["PATCH with the null origin", { Origin: "null" }, "PATCH"],
    ];
    for (const [pathname, body] of targets) {
      for (const [label, headers, method] of forged) {
        let reached = false;
        const req = admin(pathname, owner.cookies, { method: method ?? "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
        const outcome = await throughRoot(req, async () => {
          reached = true;
          return new Response("reached");
        });
        expect(reached, `${label} → ${pathname}`).toBe(false);
        expect(described(outcome), `${label} → ${pathname}`).toMatchObject({ status: 403, data: { error: "cross_site_request_blocked" } });
      }
      // The page's own form passes (same Origin), and so does a same-origin fetch that sends only fetch metadata.
      const sameOrigin: Record<string, string>[] = [{ Origin: SITE }, { "Sec-Fetch-Site": "same-origin" }];
      for (const headers of sameOrigin) {
        let reached = false;
        const req = admin(pathname, owner.cookies, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
        await throughRoot(req, async () => {
          reached = true;
          return new Response("reached");
        });
        expect(reached, `same origin → ${pathname}`).toBe(true);
      }
    }
    expect(await getEmployee(request({ cookies: owner.cookies, now: Date.now() }).ctx, t.db)).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── 8 authorization

const ROLE_KEYS = DEFAULT_ROLES.map((role) => role.key);

describe("8 authorization is enforced on the server, not by hiding links", () => {
  const sessions = new Map<DefaultRoleKey | "none", Record<string, string>>();
  beforeAll(async () => {
    for (const key of ROLE_KEYS) {
      if (key === "owner") sessions.set(key, (await signedIn(OWNER.email, OWNER.password, Date.now())).cookies);
      else {
        const person = await staff(key);
        sessions.set(key, (await signedIn(person.email, person.password, Date.now())).cookies);
      }
    }
    const nobody = await staff(null);
    sessions.set("none", (await signedIn(nobody.email, nobody.password, Date.now())).cookies);
  });

  test("every module × every role: 403 from the gate before any loader or action, and from the landing page", async () => {
    let refusals = 0;
    for (const [role, cookies] of sessions) {
      const session = (await getEmployee(request({ cookies, now: Date.now() }).ctx, t.db))!;
      for (const slug of ADMIN_MODULE_SLUGS) {
        const allowed = canSeeModule(session.actor, slug);
        const label = `${role} → ${slug}`;
        const read = await viaGate(admin(`/admin/${slug}/x/42`, cookies), `admin/${slug}/x/:id`);
        const write = await viaGate(admin(`/admin/${slug}/x/42`, cookies, samePost({ intent: "delete" })), `admin/${slug}/x/:id`);
        const landing = await viaGate(admin(`/admin/${slug}`, cookies), "admin/:module", (args) => moduleLandingLoader(args as unknown as Parameters<typeof moduleLandingLoader>[0]), { module: slug });
        if (allowed) {
          expect(read.ran && write.ran, label).toBe(true);
          if (slug === "dashboard") expect(described(landing.outcome), label).toMatchObject({ status: 302, location: "/admin" });
          else expect(landing.outcome instanceof Response && landing.outcome.status === 200, label).toBe(true);
        } else {
          refusals++;
          expect(read.ran || write.ran, label).toBe(false);
          expect(described(read.outcome), label).toMatchObject({ status: 403, data: { error: "forbidden", module: slug } });
          expect(described(write.outcome), label).toMatchObject({ status: 403 });
          // /admin/dashboard is only an alias of the admin home (which shows nothing the employee may not open).
          if (slug === "dashboard") expect(described(landing.outcome), label).toMatchObject({ status: 302, location: "/admin" });
          else expect(described(landing.outcome), label).toMatchObject({ status: 403, data: { error: "forbidden", module: slug } });
        }
      }
    }
    // Sanity: the default roles really are narrower than the owner, and an account without a role opens nothing.
    expect(refusals).toBeGreaterThan(ADMIN_MODULE_SLUGS.length);
    const none = (await getEmployee(request({ cookies: sessions.get("none")!, now: Date.now() }).ctx, t.db))!;
    expect(ADMIN_MODULE_SLUGS.filter((slug) => canSeeModule(none.actor, slug))).toEqual([]);
  });

  test("was broken — an admin route outside /admin/<module>/ is refused for everyone, the owner included (fail closed)", async () => {
    expect(gateRuleOf("admin/payments/:id")).toEqual({ kind: "unmapped" });
    expect(gateRuleOf("/admin/me/")).toEqual({ kind: "shell" });
    expect(gateRuleOf("admin/orders/:ref")).toEqual({ kind: "module", module: "orders" });
    for (const role of ["owner", "cashier"] as const) {
      for (const pattern of ["admin/payments/:id", "admin/:anything/x", "admin/me/extra", "admin/blueprint/raw"]) {
        const { outcome, ran } = await viaGate(admin("/admin/payments/1", sessions.get(role)!), pattern);
        expect(ran, `${role} ${pattern}`).toBe(false);
        expect(described(outcome), `${role} ${pattern}`).toMatchObject({ status: 403 });
      }
    }
    expect(printed.some((line) => line.includes('route pattern "admin/payments/:id"'))).toBe(true);
  });

  test("was broken — the blueprint page needs at least one admin permission; home and My security stay open", async () => {
    const none = sessions.get("none")!;
    const blueprint = await viaGate(admin("/admin/blueprint", none), "admin/blueprint", (args) => blueprintLoader(args as Parameters<typeof blueprintLoader>[0]));
    expect(described(blueprint.outcome)).toMatchObject({ status: 403, data: { error: "forbidden" } });
    for (const [pathname, pattern, handler] of [
      ["/admin", "admin", (args: HandlerArgs) => homeLoader(args as Parameters<typeof homeLoader>[0])],
      ["/admin/me", "admin/me", (args: HandlerArgs) => meLoader(args as Parameters<typeof meLoader>[0])],
    ] as const) {
      const { outcome } = await viaGate(admin(pathname, none), pattern, handler);
      expect((outcome as Response).status, pathname).toBe(200);
    }
    const cashier = await viaGate(admin("/admin/blueprint", sessions.get("cashier")!), "admin/blueprint", (args) => blueprintLoader(args as Parameters<typeof blueprintLoader>[0]));
    expect((cashier.outcome as Response).status).toBe(200);
  });

  test("nobody signed in: every admin page and data request is a document redirect to sign-in, nothing below runs", async () => {
    const patterns = ["admin", "admin/me", "admin/blueprint", "admin/:module", "admin/*", ...ADMIN_MODULE_SLUGS.map((slug) => `admin/${slug}/x/:id`), "admin/payments"];
    for (const pattern of patterns) {
      for (const req of [admin("/admin/x"), admin("/admin/x.data?_routes=routes%2Fadmin%2F_layout"), admin("/admin/x", {}, samePost({ intent: "anything" })), admin("/admin/x", { [ADMIN_COOKIE]: randomToken() })]) {
        const { outcome, ran } = await viaGate(req, pattern);
        expect(ran, `${req.method} ${req.url} as ${pattern}`).toBe(false);
        expect(described(outcome), pattern).toMatchObject({ status: 302 });
        expect(described(outcome).location, pattern).toMatch(/^\/admin\/login(\?|$)/);
        expect((outcome as Response).headers.get("X-Remix-Reload-Document")).toBe("true");
      }
    }
  });

  test("a customer's session opens nothing in the admin — not as tt_sid, not copied into tt_adm", async () => {
    const signup = request({ now: Date.now() });
    const customer = await signUpCustomer(signup.ctx, t.db, { phone: make.phone(), password: remember("customer-password-1"), name: "زبون" });
    const token = cookiesAfter(signup)[CUSTOMER_COOKIE];
    remember(token);
    expect(customer.customer.id).toBeTruthy();
    const jars: Record<string, string>[] = [{ [CUSTOMER_COOKIE]: token }, { [ADMIN_COOKIE]: token }, { [CUSTOMER_COOKIE]: token, [ADMIN_COOKIE]: token }];
    for (const jar of jars) {
      expect(await getEmployee(request({ cookies: jar, now: Date.now() }).ctx, t.db)).toBeNull();
      for (const pattern of ["admin", "admin/me", "admin/orders/x/:id"]) {
        const { outcome, ran } = await viaGate(admin("/admin/x", jar), pattern);
        expect(ran, `${JSON.stringify(Object.keys(jar))} ${pattern}`).toBe(false);
        expect(described(outcome).location).toMatch(/^\/admin\/login/);
      }
    }
    expect(ADMIN_MODULE_SLUGS.filter((slug) => canSeeModule({ kind: "customer", id: customer.customer.id }, slug))).toEqual([]);
  });

  test("no shell loader sends cost, profit, proof or credential fields — to any role", async () => {
    // Real data for the queues: an order with a pending transfer proof and a pending refund.
    const product = await make.product({ priceIqd: 250_000, stock: 3 });
    const order = await make.order([{ ...product, qty: 1 }]);
    await make.payment(order.orderId, 1000, { method: "bank_transfer", status: "pending_verification" });
    const FORBIDDEN_KEY = /cost|margin|profit|proof|sha256|hash|secret|token|^recoveryCodes$|^password$|landed|acquisition/i;
    const keysOf = (value: unknown, found: string[] = []): string[] => {
      if (Array.isArray(value)) for (const item of value) keysOf(item, found);
      else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) {
        found.push(key);
        keysOf(inner, found);
      }
      return found;
    };
    for (const [role, cookies] of sessions) {
      const session = (await getEmployee(request({ cookies, now: Date.now() }).ctx, t.db))!;
      const handlers: [string, string, (args: HandlerArgs) => Promise<unknown>, Record<string, string>?][] = [
        ["/admin", "admin", async (args) => ({ ...((await layoutLoader(args as Parameters<typeof layoutLoader>[0])) as { shell: unknown }).shell as object })],
        ["/admin", "admin", (args) => homeLoader(args as Parameters<typeof homeLoader>[0])],
        ["/admin/me", "admin/me", (args) => meLoader(args as Parameters<typeof meLoader>[0])],
        ["/admin/blueprint", "admin/blueprint", (args) => blueprintLoader(args as Parameters<typeof blueprintLoader>[0])],
        ...ADMIN_MODULE_SLUGS.filter((slug) => slug !== "dashboard" && canSeeModule(session.actor, slug)).map(
          (slug) => [`/admin/${slug}`, "admin/:module", (args: HandlerArgs) => moduleLandingLoader(args as unknown as Parameters<typeof moduleLandingLoader>[0]), { module: slug }] as [string, string, (args: HandlerArgs) => Promise<unknown>, Record<string, string>],
        ),
      ];
      for (const [pathname, pattern, handler, params] of handlers) {
        const { outcome } = await viaGate(admin(pathname, cookies), pattern, handler, params ?? {});
        if (!(outcome instanceof Response)) continue; // a refusal (the blueprint for "none") sends no data at all
        const text = await outcome.text();
        const keys = keysOf(JSON.parse(text));
        expect(keys.filter((key) => FORBIDDEN_KEY.test(key)), `${role} ${pathname}`).toEqual([]);
        expect(text, `${role} ${pathname}`).not.toMatch(/pbkdf2-sha256|"v1\.[A-Za-z0-9_-]+\./);
      }
      // The proof queue is a COUNT, and only for those who may verify payments.
      const shell = (await viaGate(admin("/admin", cookies), "admin", (args) => layoutLoader(args as Parameters<typeof layoutLoader>[0]))).outcome as Response;
      const waiting = ((await shell.json()) as { shell: { waiting: { queues: { id: string; count: number }[] } } }).shell.waiting;
      const sees = waiting.queues.some((queue) => queue.id === "proofs");
      expect(sees, role).toBe(session.actor.permissions.has("orders.payment.verify") || role === "owner");
    }
  });
});

// ───────────────────────────────────────────────────────────────── 9 headers

describe("9 headers", () => {
  test("admin pages: no-store and noindex from the gate, the security headers from the root middleware", async () => {
    const owner = await signedIn(OWNER.email, OWNER.password, Date.now());
    for (const [pathname, pattern] of [["/admin", "admin"], ["/admin/me", "admin/me"], ["/admin/orders.data?_routes=x", "admin/:module"]] as const) {
      const { outcome } = await viaGate(admin(pathname, owner.cookies), pattern, async () => ({ ok: true }), { module: "orders" });
      const headers = (outcome as Response).headers;
      expect(headers.get("Cache-Control"), pathname).toBe("no-store");
      expect(headers.get("X-Robots-Tag"), pathname).toBe("noindex, nofollow");
      expect(headers.get("X-Frame-Options"), pathname).toBe("DENY");
      expect(headers.get("X-Content-Type-Options"), pathname).toBe("nosniff");
      expect(headers.get("Referrer-Policy"), pathname).toBe("strict-origin-when-cross-origin");
      expect(headers.get("Cross-Origin-Opener-Policy"), pathname).toBe("same-origin");
      expect(headers.get("Permissions-Policy"), pathname).toContain("microphone=()");
    }
    // The gate's own refusal asks for no-store too.
    const cashier = await staff("cashier");
    const cashierCookies = (await signedIn(cashier.email, cashier.password, Date.now())).cookies;
    const refused = await viaGate(admin("/admin/finance/journal", cashierCookies), "admin/finance/journal");
    expect(described(refused.outcome).headers).toMatchObject({ "cache-control": "no-store" });
    // Sign-in and setup pages say the same in their own headers and data responses.
    for (const headers of [signInHeaders(), setupHeaders()]) expect(headers).toEqual({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
    const page = admin("/admin/login");
    const loaded = await throughRoot(page, async (context, url) => {
      const value = await signInRouteLoader({ request: page, context, url, pattern: "admin/login", params: {} } as Parameters<typeof signInRouteLoader>[0]);
      expect(described(value).headers).toMatchObject({ "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" });
      return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
    });
    expect((loaded as Response).headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  test("in production every admin HTML response carries the nonce-based Content-Security-Policy SECURITY.md describes", async () => {
    const saved = (workerEnv as unknown as Record<string, unknown>).APP_ENV;
    (workerEnv as unknown as Record<string, unknown>).APP_ENV = "production";
    try {
      for (const origin of ["https://tamtamgames.com", "http://localhost:5173"]) {
        const req = new Request(`${origin}/admin/login`);
        const response = (await throughRoot(req, async () => new Response("<html></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }))) as Response;
        const csp = response.headers.get("Content-Security-Policy") ?? "";
        for (const directive of ["default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "connect-src 'self'", "frame-src 'none'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
          expect(csp, `${origin}: ${directive}`).toContain(directive);
        }
        expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{16,}'/);
        expect(csp.includes("upgrade-insecure-requests"), origin).toBe(origin.startsWith("https:"));
        expect(csp).not.toContain("unsafe-eval");
        expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
      }
    } finally {
      (workerEnv as unknown as Record<string, unknown>).APP_ENV = saved;
    }
  });
});

// ───────────────────────────────────────────────────────────────── 10 audit and logs

describe("10 audit trail and security log", () => {
  test("sign-in, failures, lockout, two-step on and off (and refused attempts), revocations and setup all leave a row", async () => {
    const person = await staff("support");
    const at = NOW + 40 * HOUR + 15 * SECOND;
    await passwordStep(person.email, "wrong-password-xyz", { now: at });
    const { secret, cookies } = await enrolled(person, at + SECOND);
    // A refused "turn it off" (wrong password, then wrong code) — was broken: nothing was written for either.
    const off = request({ cookies, now: at + MINUTE });
    const session = (await getEmployee(off.ctx, t.db))!;
    expect(await mySecurityAction(off.ctx, t.db, session, secrets, form({ intent: "totp-disable", password: "not-my-password", code: "123456" }))).toMatchObject({ ok: false, fields: { password: expect.any(String) } });
    expect(await mySecurityAction(off.ctx, t.db, session, secrets, form({ intent: "totp-disable", password: person.password, code: "123456" }))).toMatchObject({ ok: false, code: "mfa_invalid" });
    const disable = request({ cookies, now: at + 2 * MINUTE });
    expect(await mySecurityAction(disable.ctx, t.db, session, secrets, form({ intent: "totp-disable", password: person.password, code: await totpCode(secret, at + 2 * MINUTE) }))).toEqual({ ok: true, intent: "totp-disable" });
    // Turning it off moved this device to a new session token: carry on with the cookie that answer set.
    const afterOff = cookiesAfter(disable, cookies);
    remember(afterOff[ADMIN_COOKIE]);
    const other = await signedIn(person.email, person.password, at + 3 * MINUTE);
    const revoke = request({ cookies: afterOff, now: at + 4 * MINUTE });
    expect(await mySecurityAction(revoke.ctx, t.db, (await getEmployee(revoke.ctx, t.db))!, secrets, form({ intent: "revoke", sessionId: other.session.session.id }))).toMatchObject({ ok: true, ended: true });

    const log = await t.db.select().from(authEvents).where(eq(authEvents.subjectId, person.id));
    const kinds = log.map((row) => `${row.kind}:${row.success ? "ok" : "fail"}:${(row.details as { reason?: string; change?: string } | null)?.reason ?? (row.details as { change?: string } | null)?.change ?? ""}`);
    expect(kinds).toEqual(expect.arrayContaining(["login:fail:bad_password", "login:ok:", "mfa_enroll:ok:", "mfa_enroll:fail:bad_password", "mfa_enroll:fail:bad_code", "mfa_enroll:ok:disabled"]));
    const audit = (await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, person.id))).map((row) => row.action);
    expect(audit).toEqual(expect.arrayContaining(["security.mfa.enable", "security.mfa.disable", "security.session.revoke"]));
    expect(await t.db.select().from(authEvents).where(eq(authEvents.kind, "lockout"))).not.toHaveLength(0);
    expect(await t.db.select().from(auditEvents).where(eq(auditEvents.action, "staff.employee.bootstrap"))).toHaveLength(1);
  });

  test("no password, hash, TOTP secret, recovery code, setup token or session token in any audit row, security-log row, rate-limit key or log line", async () => {
    const dumps = {
      audit_events: JSON.stringify(await t.db.select().from(auditEvents)),
      auth_events: JSON.stringify(await t.db.select().from(authEvents)),
      rate_limits: JSON.stringify(await t.db.select().from(rateLimits)),
      employee_sessions: JSON.stringify(await t.db.select().from(employeeSessions)),
      console: printed.join("\n"),
    };
    expect(SECRETS.size).toBeGreaterThan(20);
    for (const [where, text] of Object.entries(dumps)) {
      for (const secret of SECRETS) if (secret) expect(text.includes(secret), `${where} contains a secret`).toBe(false);
      expect(text, where).not.toContain("pbkdf2-sha256$");
      expect(text, where).not.toMatch(/"v1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"/);
    }
  });
});

// ───────────────────────────────────────────────────────────────── 11 dev-accounts

describe("11 scripts/dev-accounts.ts", () => {
  const tsxCli = path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const run = (args: string[], appEnv?: string) =>
    spawnSync(process.execPath, [tsxCli, "--tsconfig", "tsconfig.cloudflare.json", "scripts/dev-accounts.ts", ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, APP_ENV: appEnv ?? "" },
      encoding: "utf8",
      timeout: 90_000,
    });
  const credentialValues = () => {
    const file = path.join(PROJECT_ROOT, ".dev.seed-credentials");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => /^[A-Z_]+=(.+)$/.exec(line.trim())?.[1])
      .filter((value): value is string => Boolean(value && value.length >= 4));
  };

  test("refuses remote and unknown flags and APP_ENV=production (however padded) before opening any database; prints no credential", { timeout: 120_000 }, () => {
    const cases: [string[], string | undefined][] = [
      [["--remote"], undefined],
      [["--env=production"], undefined],
      [["--local=false"], undefined],
      [["--", "--remote"], undefined],
      [["--persist-to", "C:/elsewhere"], undefined],
      [[], "production"],
      [[], " Production "],
      [["--credentials-only"], "PRODUCTION"],
    ];
    const known = credentialValues();
    for (const [args, appEnv] of cases) {
      const result = run(args, appEnv);
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, `${args.join(" ")} APP_ENV=${JSON.stringify(appEnv)}: ${output}`).toBe(2);
      expect(output).toMatch(/Refusing to run/);
      for (const value of known) expect(output.includes(value), "a credential was printed").toBe(false);
    }
  });

  test("error messages are printed without query parameters, credentials or hashes", () => {
    expect(isProductionEnv(" production\n")).toBe(true);
    expect(isProductionEnv("development")).toBe(false);
    expect(isProductionEnv(undefined)).toBe(false);
    const message = 'DrizzleQueryError: Failed query: insert into "employees" ("id", "email", "password_hash") values (?, ?, ?)\nparams: emp_1,demo.owner@tamtam.local,pbkdf2-sha256$100000$abc$def';
    const safe = redactSecrets(message, ["demo.owner@tamtam.local", "the-demo-password"]);
    expect(safe).toContain("Failed query");
    expect(safe).not.toContain("demo.owner@tamtam.local");
    expect(safe).not.toContain("pbkdf2");
    expect(redactSecrets("could not log in demo.owner@tamtam.local with the-demo-password", ["demo.owner@tamtam.local", "the-demo-password"])).toBe("could not log in [redacted] with [redacted]");
  });
});
