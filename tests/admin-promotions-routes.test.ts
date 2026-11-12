/**
 * Admin module 08 "promotions" — the route glue for every role (review 2026-11-12, a guard): every loader of the
 * module answers 200, 403 or 404 for six built-in roles (never a 500), and every intent of every action posted with an
 * empty form answers 400 (the fields say what is missing) to a role that may act and 403 to one that may not — the
 * finance role reads everything and writes nothing; support, cashier and content open nothing.
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import * as approvalsRoute from "~/routes/admin/promotions/approvals";
import * as couponRoute from "~/routes/admin/promotions/coupon";
import * as couponsRoute from "~/routes/admin/promotions/coupons";
import * as experimentRoute from "~/routes/admin/promotions/experiment";
import * as experimentsRoute from "~/routes/admin/promotions/experiments";
import * as flashSaleRoute from "~/routes/admin/promotions/flash-sale";
import * as flashRoute from "~/routes/admin/promotions/flash";
import * as giftCardRoute from "~/routes/admin/promotions/gift-card";
import * as giftCardsRoute from "~/routes/admin/promotions/gift-cards";
import * as indexRoute from "~/routes/admin/promotions/index";
import * as layoutRoute from "~/routes/admin/promotions/layout";
import * as pointsCustomerRoute from "~/routes/admin/promotions/points-customer";
import * as pointsRoute from "~/routes/admin/promotions/points";
import * as referralsRoute from "~/routes/admin/promotions/referrals";
import * as ruleRoute from "~/routes/admin/promotions/rule";
import * as rulesRoute from "~/routes/admin/promotions/rules";
import * as vipRoute from "~/routes/admin/promotions/vip";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { employeeRoles } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { saveCoupon } from "~/server/services/admin/promotions/coupons.server";
import { saveRule } from "~/server/services/admin/promotions/discounts.server";
import { saveExperiment } from "~/server/services/admin/promotions/experiments.server";
import { createFlashSale } from "~/server/services/admin/promotions/flash.server";
import { issueGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { toBaghdadInput } from "~/server/services/admin/promotions/types";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 86_400_000;
const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

function requestCtx(): RequestCtx {
  return { requestId: `probe-${randomToken(6)}`, nonce: "n", origin: ORIGIN, isHttps: false, isDev: true, now: Date.now(), ip: null, country: "IQ", userAgent: "vitest", locale: "ar", dir: "rtl", prefs: { theme: "system", currency: "IQD", numbering: "latn" }, storeMode: "demo", cookie: () => null, setCookie: () => {} };
}
async function signedIn(role: DefaultRoleKey): Promise<{ cookie: string; actor: EmployeeActor }> {
  const password = "promotions-probe-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("probe")}@promotions-probe.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const setCookies: string[] = [];
  const result = await signInEmployee({ ...requestCtx(), setCookie: (s: string) => void setCookies.push(s) } as RequestCtx, t.db, { email, password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "), actor: { kind: "employee", id, permissions: defaultRolePermissions(role) } };
}
async function call(cookie: string, path: string, params: Record<string, string>, fn: unknown, body?: Record<string, string>): Promise<{ status: number; value: unknown }> {
  const init: RequestInit = body ? { method: "POST", headers: { cookie, origin: ORIGIN }, body: Object.entries(body).reduce((form, [k, v]) => (form.append(k, v), form), new FormData()) } : { headers: { cookie } };
  const request = new Request(`${ORIGIN}${path}`, init);
  const context = new RouterContextProvider();
  let out: unknown;
  try {
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await (fn as (args: unknown) => unknown)({ request, context, params, url: new URL(request.url), pattern: path });
      return new Response(null);
    });
  } catch (error) {
    out = error;
  }
  const v = out as { type?: string; init?: { status?: number }; status?: number } | null;
  if (out instanceof Response) return { status: out.status, value: out };
  if (v && v.type === "DataWithResponseInit") return { status: v.init?.status ?? 200, value: v };
  if (out instanceof Error) return { status: 500, value: out };
  return { status: 200, value: out };
}

test("every loader and every intent, for six roles: 200 / 400 / 403 / 404, never 500", async () => {
  const sessions: Record<string, { cookie: string; actor: EmployeeActor }> = {};
  for (const role of ["owner", "manager", "finance", "support", "cashier", "content"] as const) sessions[role] = await signedIn(role);
  const m = sessions.manager.actor;
  const coupon = await saveCoupon(t.db, m, { code: "PROBE10", kind: "fixed", value: "1000", usageLimit: "5", activate: "on" }, NOW);
  const rule = await saveRule(t.db, m, { idempotencyKey: "probe-rule-0001", nameAr: "قاعدة", kind: "percent", value: "5", maxDiscountIqd: "1000" }, NOW);
  const sale = await createFlashSale(t.db, m, { nameAr: "عرض", startsAt: toBaghdadInput(Date.now() + DAY), endsAt: toBaghdadInput(Date.now() + 2 * DAY), idempotencyKey: "probe-flash-0001" }, Date.now());
  const card = await issueGiftCard(t.db, m, TEST_VARS.DATA_KEY, { amountIqd: "5000", note: "اختبار", idempotencyKey: "probe-gift-0001" }, Date.now());
  const exp = await saveExperiment(t.db, m, { idempotencyKey: "probe-exp-0001", key: "probe-test", name: "تجربة" }, NOW);
  const customerId = await make.customer();
  const pages: [string, Record<string, string>, unknown][] = [
    ["/admin/promotions", {}, layoutRoute.loader],
    ["/admin/promotions", {}, indexRoute.loader],
    ["/admin/promotions/approvals", {}, approvalsRoute.loader],
    ["/admin/promotions/coupons", {}, couponsRoute.loader],
    ["/admin/promotions/coupons?view=bogus&page=-3&sort=x", {}, couponsRoute.loader],
    ["/admin/promotions/coupons/new", { couponId: "new" }, couponRoute.loader],
    [`/admin/promotions/coupons/${coupon.couponId}`, { couponId: coupon.couponId }, couponRoute.loader],
    ["/admin/promotions/coupons/nope", { couponId: "nope" }, couponRoute.loader],
    ["/admin/promotions/coupons/%27%22", { couponId: "'\"" }, couponRoute.loader],
    ["/admin/promotions/rules", {}, rulesRoute.loader],
    ["/admin/promotions/rules/new", { ruleId: "new" }, ruleRoute.loader],
    [`/admin/promotions/rules/${rule.ruleId}?days=90&demo=1`, { ruleId: rule.ruleId }, ruleRoute.loader],
    ["/admin/promotions/rules/nope", { ruleId: "nope" }, ruleRoute.loader],
    ["/admin/promotions/flash", {}, flashRoute.loader],
    [`/admin/promotions/flash/${sale.saleId}`, { saleId: sale.saleId }, flashSaleRoute.loader],
    ["/admin/promotions/flash/nope", { saleId: "nope" }, flashSaleRoute.loader],
    ["/admin/promotions/points", {}, pointsRoute.loader],
    ["/admin/promotions/points?phone=0770", {}, pointsRoute.loader],
    [`/admin/promotions/points/${customerId}`, { customerId }, pointsCustomerRoute.loader],
    ["/admin/promotions/points/nope", { customerId: "nope" }, pointsCustomerRoute.loader],
    ["/admin/promotions/referrals", {}, referralsRoute.loader],
    ["/admin/promotions/vip", {}, vipRoute.loader],
    ["/admin/promotions/vip?members=ended&page=2", {}, vipRoute.loader],
    ["/admin/promotions/gift-cards", {}, giftCardsRoute.loader],
    [`/admin/promotions/gift-cards/${card.cardId}`, { cardId: card.cardId as string }, giftCardRoute.loader],
    ["/admin/promotions/gift-cards/nope", { cardId: "nope" }, giftCardRoute.loader],
    ["/admin/promotions/experiments", {}, experimentsRoute.loader],
    [`/admin/promotions/experiments/${exp.experimentId}`, { experimentId: exp.experimentId }, experimentRoute.loader],
    ["/admin/promotions/experiments/nope", { experimentId: "nope" }, experimentRoute.loader],
  ];
  const outside = ["support", "cashier", "content"] as const;
  for (const [path, params, loader] of pages) {
    const unknown = path.endsWith("/nope") || path.endsWith("%27%22");
    const writeOnly = path.endsWith("/new");
    for (const role of Object.keys(sessions)) {
      const result = await call(sessions[role].cookie, path, params, loader);
      const expected = (outside as readonly string[]).includes(role) ? 403 : unknown ? 404 : writeOnly && role === "finance" ? 403 : 200;
      expect(result.status, `${role} GET ${path}: ${result.status === 500 ? String((result.value as Error).message) : ""}`).toBe(expected);
    }
  }
  // actions: every intent of every page, posted by every role with an empty form
  const actions: [string, Record<string, string>, unknown, string[]][] = [
    ["/admin/promotions/coupons", {}, couponsRoute.action, ["bulk-off"]],
    [`/admin/promotions/coupons/${coupon.couponId}`, { couponId: coupon.couponId }, couponRoute.action, ["save", "active", "decide", "withdraw", "try", "nope"]],
    [`/admin/promotions/rules/${rule.ruleId}`, { ruleId: rule.ruleId }, ruleRoute.action, ["save", "active", "decide", "withdraw"]],
    ["/admin/promotions/flash", {}, flashRoute.action, ["create"]],
    [`/admin/promotions/flash/${sale.saleId}`, { saleId: sale.saleId }, flashSaleRoute.action, ["update", "item", "remove", "submit", "decide", "withdraw", "cancel"]],
    ["/admin/promotions/points", {}, pointsRoute.action, ["sync", "expire"]],
    [`/admin/promotions/points/${customerId}`, { customerId }, pointsCustomerRoute.action, ["adjust", "decide", "withdraw"]],
    ["/admin/promotions/referrals", {}, referralsRoute.action, ["issue", "code", "record", "reward", "reject"]],
    ["/admin/promotions/vip", {}, vipRoute.action, ["tier", "grant", "end"]],
    ["/admin/promotions/gift-cards", {}, giftCardsRoute.action, ["issue", "decide", "withdraw", "check", "redeem"]],
    [`/admin/promotions/gift-cards/${card.cardId}`, { cardId: card.cardId as string }, giftCardRoute.action, ["reveal", "void"]],
    ["/admin/promotions/experiments", {}, experimentsRoute.action, ["create"]],
    [`/admin/promotions/experiments/${exp.experimentId}`, { experimentId: exp.experimentId }, experimentRoute.action, ["save", "start", "pause", "resume", "complete"]],
  ];
  // reads that any reader may run: "try this coupon" (an empty cart is refused as input) and an unknown intent
  const readIntents = new Set(["try", "nope"]);
  // posting what is due needs nothing typed: the owner and the manager succeed
  const noInput = new Set(["sync", "expire"]);
  for (const [path, params, action, intents] of actions) {
    for (const intent of intents) {
      for (const role of Object.keys(sessions)) {
        const result = await call(sessions[role].cookie, path, params, action, { intent });
        const expected = (outside as readonly string[]).includes(role) ? 403 : role === "finance" ? (readIntents.has(intent) ? 400 : 403) : noInput.has(intent) ? 200 : 400;
        expect(result.status, `${role} POST ${path} ${intent}: ${result.status === 500 ? String((result.value as Error).message) : ""}`).toBe(expected);
      }
    }
  }
}, 120_000);
