/**
 * Storefront security review — SECOND PASS (2026-11, owner: security; docs/SECURITY.md §17 "Second pass 2026-11").
 *
 * An independent review of the first pass (tests/storefront-adversarial.test.ts and -input.test.ts, SECURITY §16): each
 * fix it claims was attacked again, then the surface was read a different way — every user-controlled input traced to
 * the place it is stored or shown, and every write a shopper (or any web page, through a shopper's browser) can cause
 * asked "what bounds it?". Every `describe` below says what was wrong; its tests failed on the code before the repair.
 * The last block holds attacks that found nothing.
 *
 * Runs against a throw-away local D1 + KV; rate-limit attacks run only here, never against the shared dev server.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { action as uploadTradeInAction } from "~/routes/api/upload-tradein";
import { loader as loginLoader } from "~/routes/storefront/account/login";
import { loader as signupLoader } from "~/routes/storefront/account/signup";
import { action as walletProofAction } from "~/routes/storefront/account/wallet-proof";
import type { CustomerActor } from "~/server/actor";
import { signUpCustomer } from "~/server/auth/customer.server";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { assistantMessages, auditEvents, files, searchQueryStats, supportTickets, ticketMessages } from "~/server/db/schema";
import { toAppError } from "~/server/errors";
import { runJob } from "~/server/jobs.server";
import { limitKey, rateLimit, RATE_LIMITS } from "~/server/ratelimit.server";
import { kvBlobStore } from "~/server/storage.server";
import { isCleanText } from "~/server/text.server";
import { CONSENT_CHANGES_PER_CUSTOMER } from "~/server/services/account/preferences.server";
import { updateProfile } from "~/server/services/account/profile.server";
import { requestWalletTopup, saveTopupProof } from "~/server/services/account/topups.server";
import { lookupGuestOrder } from "~/server/services/orders/manage.server";
import { baghdadDay, recordSearchQuery } from "~/server/services/search.server";
import { handOffToStaff } from "~/server/services/support/assistant.server";
import { parseAssistantState } from "~/server/services/support/state";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const SITE = "http://localhost:5173";
const NOW = TEST_NOW;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── characters (built from code points)

const ch = (code: number) => String.fromCharCode(code);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const PDI = ch(0x2069);
const ZWSP = ch(0x200b);
const CSI = ch(0x9b); // a C1 control: "ESC [" in one character

// ───────────────────────────────────────────────────────────────── harness (as in tests/storefront-adversarial*.test.ts)

let counter = 0;
/** A fresh private IPv4 address per call, so per-IP limits never leak between tests. */
const freshIp = () => {
  counter++;
  return `10.77.${Math.floor(counter / 250)}.${(counter % 250) + 1}`;
};

function context(options: { cookies?: Record<string, string>; ip?: string | null } = {}): { ctx: RequestCtx; setCookies: string[] } {
  const jar = new Map(Object.entries(options.cookies ?? {}));
  const setCookies: string[] = [];
  const ctx: RequestCtx = {
    requestId: `verify-${++counter}`,
    nonce: "n",
    origin: SITE,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: options.ip === undefined ? freshIp() : options.ip,
    country: "IQ",
    userAgent: "Mozilla/5.0 (security review, second pass)",
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

type Handler = (args: never) => unknown;
type HitInit = { form?: Record<string, string> | FormData; cookies?: Record<string, string>; ip?: string | null };
type Hit = { status: number; location: string | null; body: unknown; error?: unknown };
type DataWithInit = { data: unknown; init?: { status?: number; headers?: HeadersInit } | null };
const isDataWithInit = (value: unknown): value is DataWithInit => typeof value === "object" && value !== null && "data" in value && "init" in value;

/** One request through the real root middleware into a loader or an action. */
async function hit(path: string, handler: Handler, init: HitInit = {}): Promise<Hit> {
  const method = init.form ? "POST" : "GET";
  const headers = new Headers();
  const ip = init.ip === undefined ? freshIp() : init.ip;
  if (ip) headers.set("CF-Connecting-IP", ip);
  if (init.cookies) headers.set("Cookie", Object.entries(init.cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; "));
  if (method !== "GET") headers.set("Origin", SITE);
  const body = init.form ? (init.form instanceof FormData ? init.form : new URLSearchParams(init.form)) : undefined;
  const request = new Request(`${SITE}${path}`, { method, headers, body });
  const routerContext = new RouterContextProvider();
  const url = new URL(request.url);
  let inner: unknown;
  let innerError: unknown;
  const response = (await requestContextMiddleware({ request, context: routerContext, url, pattern: path, params: {} } as never, async () => {
    try {
      inner = await (handler as (args: unknown) => unknown)({ request, context: routerContext, params: {}, url, pattern: path });
    } catch (thrown) {
      if (thrown instanceof Response || isDataWithInit(thrown)) inner = thrown;
      else {
        innerError = thrown;
        return new Response("unexpected", { status: 500 });
      }
    }
    if (inner instanceof Response) return inner;
    if (isDataWithInit(inner)) return new Response(JSON.stringify(inner.data), { status: inner.init?.status ?? 200, headers: inner.init?.headers });
    return new Response(JSON.stringify(inner ?? null), { status: 200 });
  })) as Response;
  const parsed: unknown = isDataWithInit(inner) ? inner.data : inner instanceof Response ? null : inner;
  return { status: response.status, location: response.headers.get("Location"), body: parsed, error: innerError };
}

function jarAfter(setCookies: string[]): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const serialized of setCookies) {
    const [pair, ...rest] = serialized.split(/;\s*/);
    const at = pair.indexOf("=");
    const name = pair.slice(0, at);
    if (rest.some((part) => part.toLowerCase() === "max-age=0")) delete jar[name];
    else jar[name] = decodeURIComponent(pair.slice(at + 1));
  }
  return jar;
}

/** A signed-up customer: id, actor (no IP, as services see it in tests) and the cookie jar of the browser that signed up. */
async function customer(): Promise<{ id: string; actor: CustomerActor; jar: Record<string, string> }> {
  const req = context();
  const session = await signUpCustomer(req.ctx, t.db, { phone: make.phone(), password: `pw-${randomToken(9)}` });
  return { id: session.customer.id, actor: { kind: "customer", id: session.customer.id }, jar: jarAfter(req.setCookies) };
}

async function thrownCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return toAppError(error)?.code ?? "unexpected";
  }
  return "none";
}

/** A local path for a Location header: one leading "/", nothing a browser reads as another host, ASCII only. */
function isLocalLocation(location: string | null): boolean {
  if (location === null) return false;
  if (!/^\/(?![/\\])/.test(location)) return false;
  if (/[^\x21-\x7e]/.test(location)) return false;
  return new URL(location, "https://tamtamgames.example").host === "tamtamgames.example";
}

/** A real 1×1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
const png = (name = "proof.png") => new File([PNG], name, { type: "image/png" });

/** A well-formed order reference nobody placed. */
const strayRef = () => `TT-${randomToken(12).toUpperCase().replace(/[^A-Z0-9]/g, "Q").slice(0, 8)}`;

// ───────────────────────────────────────────────────────────────── 1. per-IP limits: a subscriber's whole IPv6 prefix

describe("fix 4 attacked again — an IPv6 subscriber holds more than a /64", () => {
  // Was: per-IP limits counted an IPv6 caller by its /64 only. A home or business line commonly gets a /56 or a /48,
  // and a tunnel broker hands out a /48 for free: 65,536 /64s, each a fresh budget for every per-IP limit (sign-in,
  // sign-up, checkout — COD orders hold stock —, lookups, uploads).

  test("rotating /64s inside one /48 buys at most WIDE_NETWORK_FACTOR (16) budgets, not 65,536", async () => {
    const rule = { limit: 3, windowSec: 600 };
    const now = Math.floor(Date.now() / 600_000) * 600_000 + 1000; // one fixed instant: the loop never crosses a window
    let allowed = 0;
    for (let net = 0; net < 120; net++) {
      const verdict = await rateLimit(t.db, await limitKey("verify48", "ip", `2001:db8:4b1d:${net.toString(16)}::1`), rule, now);
      if (verdict.ok) allowed++;
    }
    expect(allowed).toBe(3 * 16);
    // A /64 still has its own budget first; another /48 and IPv4 callers are untouched.
    expect((await rateLimit(t.db, await limitKey("verify48", "ip", "2001:db8:4b1e::1"), rule, now)).ok).toBe(true);
    expect((await rateLimit(t.db, await limitKey("verify48", "ip", "198.51.100.77"), rule, now)).ok).toBe(true);
  });

  test("guest order lookups (10 / 15 min per IP): one /48 is refused at the 161st, whatever /64 it uses", async () => {
    const now = Math.floor(Date.now() / (15 * MINUTE)) * 15 * MINUTE + 1000; // one window for the whole loop
    let refusedAt = 0;
    for (let i = 1; i <= 200 && refusedAt === 0; i++) {
      const ip = `2001:db8:77aa:${i.toString(16)}::${(i * 7).toString(16)}`;
      const code = await thrownCode(() => lookupGuestOrder(t.db, { ref: strayRef(), phone: make.phone() }, { ip }, now));
      if (code === "rate_limited") refusedAt = i;
      else expect(code).toBe("none");
    }
    expect(refusedAt).toBe(RATE_LIMITS.orderLookup.limit * 16 + 1);
  });

  test("the key of one address is stable; IPv4 and IPv4-mapped callers keep their single key", async () => {
    expect(await limitKey("x", "ip", "2001:db8:1:2::1")).toBe(await limitKey("x", "ip", "2001:0db8:0001:0002:ffff::9"));
    expect(await limitKey("x", "ip", "::ffff:203.0.113.9")).toBe(await limitKey("x", "ip", "203.0.113.9"));
    expect(await limitKey("x", "ip", "203.0.113.9")).toMatch(/^x:ip:[0-9a-f]{32}$/);
    expect(await limitKey("x", "phone", "+9647701234567")).toMatch(/^x:phone:[0-9a-f]{32}$/);
  });
});

// ───────────────────────────────────────────────────────────────── 2. next=: the claimed "one more decoding"

describe("fix 1 attacked again — next= with a language prefix in front of encoded slashes", () => {
  // Was: nextFrom checked one more decoding of the value it was GIVEN, then dropped the language prefix, so
  // "/en/%2F%2Fevil.example" came out as "/%2F%2Fevil.example" — which one more decoding turns into "///evil.example",
  // exactly what the check was there to prevent. No sink decodes it today (the browser keeps %2F in a path); the
  // promised invariant is restored anyway: the value that leaves, decoded once more, is still one local path.
  const VECTORS = ["/en/%2F%2Fevil.example", "/ckb/%2F%2Fevil.example", "/en/%2F%5Cevil.example", "/en/%2f/evil.example", "/en/%252F%252Fevil.example", "/en/.%2e/%2F%2Fevil.example"];

  test("the redirect, decoded once more, never names another host (sign-in and sign-up pages, signed-in visitor)", async () => {
    const person = await customer();
    for (const next of VECTORS) {
      for (const [path, handler] of [
        ["/account/login", loginLoader],
        ["/account/signup", signupLoader],
      ] as const) {
        const answer = await hit(`${path}?next=${encodeURIComponent(next)}`, handler as Handler, { cookies: person.jar });
        expect(answer.status, next).toBe(302);
        expect(isLocalLocation(answer.location), `${next} → ${answer.location}`).toBe(true);
        expect(isLocalLocation(decodeURIComponent(answer.location ?? "")), `${next} → ${answer.location} (decoded)`).toBe(true);
      }
    }
  });
});

// ───────────────────────────────────────────────────────────────── 3. hidden characters: two doors the first pass missed

describe("fix 9 attacked again — shopper text that still reached storage with hidden characters", () => {
  test("the assistant: the question a shopper typed reaches the stored transcript and the staff note cleaned", async () => {
    // Was: the typed question (`q`, the URL state) only lost C0 controls; bidi overrides and isolates, C1 controls and
    // zero-width spaces went into assistant_messages and into the ticket's internal note that staff read.
    const typed = `Xbox ${RLO}enil-ffo${LRI}x${PDI}${ZWSP} ${CSI}31m لا يعمل`;
    const state = parseAssistantState(new URLSearchParams([["device", "other"], ["q", typed]]));
    expect(state.q).toContain(RLO); // the URL state itself keeps it (client-safe parser) — storage is what must not
    const ticket = await handOffToStaff(t.db, { customerId: null, ip: freshIp(), storeMode: "demo" }, "ar", state, { idempotencyKey: randomToken(), phone: make.phone(), consent: "on" }, NOW);

    const row = await t.db.select({ id: supportTickets.id, sessionId: supportTickets.assistantSessionId }).from(supportTickets).where(eq(supportTickets.ref, ticket.ref)).get();
    const transcript = await t.db.select({ content: assistantMessages.content }).from(assistantMessages).where(eq(assistantMessages.sessionId, row?.sessionId ?? ""));
    const notes = await t.db.select({ body: ticketMessages.body }).from(ticketMessages).where(and(eq(ticketMessages.ticketId, row?.id ?? ""), eq(ticketMessages.isInternal, true)));
    expect(transcript.some((message) => message.content.includes("Xbox"))).toBe(true);
    expect(notes.some((note) => note.body.includes("Xbox"))).toBe(true);
    for (const message of transcript) expect(isCleanText(message.content, { multiline: true }), JSON.stringify(message.content)).toBe(true);
    for (const note of notes) expect(isCleanText(note.body, { multiline: true }), JSON.stringify(note.body)).toBe(true);
  });

  test("an uploaded photo's file name: stored and shown back without bidi overrides (the classic 'gnp.exe' trick)", async () => {
    // Was: sanitizeFileName removed C0 controls and path characters only; "IMG<RLO>gnp.exe" was kept as typed and shown
    // back to the shopper (trade-in photo list) and to staff (admin file lists) as "IMGexe.png".
    const form = new FormData();
    form.set("intent", "add");
    form.set("file", png(`IMG${RLO}gnp.exe${ZWSP}`));
    const answer = await hit("/api/upload/tradein", uploadTradeInAction as Handler, { form });
    expect(answer.status).toBe(200);
    const photo = (answer.body as { photo: { id: string; name: string | null } }).photo;
    expect(photo.name).toBe("IMGgnp.exe");
    const stored = await t.db.select({ originalName: files.originalName }).from(files).where(eq(files.id, photo.id)).get();
    expect(stored?.originalName).toBe("IMGgnp.exe");
  });
});

// ───────────────────────────────────────────────────────────────── 4. append-only history: every door bounded

describe("append-only history — every shopper door that writes it is bounded (fix 8 reached further)", () => {
  test("profile changes — each one an audit event in the append-only trail — are limited per customer", async () => {
    // Was: no limit. A signed-in script alternating two names wrote audit_events rows without end (UPDATE and DELETE
    // are refused on that table: nothing could clean it up).
    const person = await customer();
    const codes: string[] = [];
    for (let i = 0; i < 12; i++) codes.push(await thrownCode(() => updateProfile(t.db, person.actor, { name: `نور ${i}` }, NOW + i)));
    expect(codes.slice(0, 10).every((code) => code === "none")).toBe(true);
    expect(codes.slice(10)).toEqual(["rate_limited", "rate_limited"]);
    const rows = await t.db.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.action, "customers.profile.update"), eq(auditEvents.entityId, person.id)));
    expect(rows).toHaveLength(10);
    // Saving what is already there is no change, writes nothing and is never refused.
    expect(await thrownCode(() => updateProfile(t.db, person.actor, { name: "نور 9" }, NOW + 20))).toBe("none");
  });

  test("consent answers: the per-customer budget is per hour — a script can no longer spend it again every minute", async () => {
    // Was: 12 per MINUTE (the first pass) — 17,280 rows a day per account (34,560 from the settings form, which writes two
    // answers per request) in a table that refuses DELETE.
    const person = await customer();
    const key = await limitKey("consent", "customer", person.id);
    const hourStart = Math.floor(Date.now() / HOUR) * HOUR + HOUR; // a whole hour ahead, so the loop stays in one window
    const verdicts: boolean[] = [];
    for (let i = 0; i < 13; i++) verdicts.push((await rateLimit(t.db, key, CONSENT_CHANGES_PER_CUSTOMER, hourStart + i * (MINUTE + 1000))).ok);
    expect(verdicts.filter(Boolean)).toHaveLength(12);
    expect(verdicts[12]).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── 5. uploads nobody uses

describe("wallet top-up proofs — uploads that no request ever uses", () => {
  test("one IP shares one upload budget across accounts (accounts cost nothing)", async () => {
    // Was: the top-up proof route counted per ACCOUNT only. Sign-ups are free (10 an hour per IP), so every new account
    // brought 20 more 8 MB uploads per 10 minutes from the same address.
    const ip = freshIp();
    const a = await customer();
    const b = await customer();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) {
      const form = new FormData();
      form.set("file", png(`t${i}.png`));
      statuses.push((await hit("/account/wallet/proof", walletProofAction as Handler, { form, cookies: (i % 2 === 0 ? a : b).jar, ip })).status);
    }
    expect(statuses.slice(0, RATE_LIMITS.upload.limit).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(RATE_LIMITS.upload.limit)).toEqual([429, 429]);
  });

  test("a proof no request uses is deleted by the daily retention after a day; one a request uses stays", async () => {
    // Was: nothing ever deleted an unused top-up proof (private, up to 8 MB in the file store).
    const store = kvBlobStore(t.kv);
    const person = await customer();
    const unused = await saveTopupProof(t.db, store, person.actor, png("old.png"), NOW - 2 * DAY);
    const used = await saveTopupProof(t.db, store, person.actor, png("used.png"), NOW - 2 * DAY);
    await requestWalletTopup(t.db, person.actor, { method: "zaincash", declaredAmountIqd: "25000", fileId: used.fileId, idempotencyKey: randomToken() }, NOW - 2 * DAY);
    const fresh = await saveTopupProof(t.db, store, person.actor, png("fresh.png"), NOW - HOUR);
    const keyOf = async (id: string) => (await t.db.select({ storageKey: files.storageKey }).from(files).where(eq(files.id, id)).get())?.storageKey ?? "";
    const unusedKey = await keyOf(unused.fileId);

    const run = await runJob(t.db, "retention", NOW, { env: { KV: t.kv } });
    expect(run.status).toBe("succeeded");
    expect(Number(run.stats.topupProofs)).toBeGreaterThanOrEqual(1);
    const rows = await t.db.select({ id: files.id, deletedAt: files.deletedAt }).from(files).where(inArray(files.id, [unused.fileId, used.fileId, fresh.fileId]));
    const deleted = new Map(rows.map((row) => [row.id, row.deletedAt !== null]));
    expect(deleted.get(unused.fileId)).toBe(true);
    expect(deleted.get(used.fileId)).toBe(false);
    expect(deleted.get(fresh.fileId)).toBe(false);
    expect(await store.get(unusedKey)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── 6. anonymous writes from a GET

describe("search statistics — rows written by anonymous GETs, from any web page", () => {
  test("a flood of distinct queries cannot grow search_query_stats past its daily cap; known queries still count", async () => {
    // Was: every GET /search?q=<anything new> inserted a row (no limit, no retention). Any page on the web can make its
    // visitors' browsers request such URLs (an <img src>), so per-IP limits would not even help: the cap is per day.
    const day = baghdadDay(NOW);
    await t.d1
      .prepare(
        "INSERT INTO search_query_stats (day, locale, query, searches, zero_results, last_at) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) SELECT ?1, 'ckb', 'flood ' || i, 1, 1, ?2 FROM n",
      )
      .bind(day, NOW)
      .run();
    expect(await recordSearchQuery(t.db, { locale: "ckb", q: "brand new query", total: 0, now: NOW + 1 })).toBe(false);
    expect(await t.db.select().from(searchQueryStats).where(and(eq(searchQueryStats.locale, "ckb"), eq(searchQueryStats.query, "brand new query")))).toEqual([]);
    // A query already counted today keeps counting; another language has its own room.
    expect(await recordSearchQuery(t.db, { locale: "ckb", q: "Flood 7", total: 0, now: NOW + 2 })).toBe(true);
    expect((await t.db.select({ searches: searchQueryStats.searches }).from(searchQueryStats).where(and(eq(searchQueryStats.locale, "ckb"), eq(searchQueryStats.query, "flood 7"))).get())?.searches).toBe(2);
    expect(await recordSearchQuery(t.db, { locale: "en", q: "brand new query", total: 3, now: NOW + 3 })).toBe(true);
    const total = await t.db.select({ n: sql<number>`count(*)` }).from(searchQueryStats).where(and(eq(searchQueryStats.day, day), eq(searchQueryStats.locale, "ckb"))).get();
    expect(Number(total?.n)).toBe(2000);
  });
});
