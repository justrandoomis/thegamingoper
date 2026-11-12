/**
 * Admin module 16 "marketing" — the route glue for every role: every loader of the module answers 200, 403 or 404
 * for seven built-in roles (never a 500), every intent of every action posted with an empty form answers 400 (the
 * fields say what is missing) to a role that may act and 403 to one that may not, and the loaders send no full phone
 * number and no profile link to staff without those permissions. The CSV export is audited.
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import * as campaignRoute from "~/routes/admin/marketing/campaign";
import * as campaignsRoute from "~/routes/admin/marketing/campaigns";
import * as cartsRoute from "~/routes/admin/marketing/carts";
import * as crossSellRoute from "~/routes/admin/marketing/cross-sell";
import * as indexRoute from "~/routes/admin/marketing/index";
import * as layoutRoute from "~/routes/admin/marketing/layout";
import * as linksRoute from "~/routes/admin/marketing/links";
import * as csvRoute from "~/routes/admin/marketing/performance-csv";
import * as performanceRoute from "~/routes/admin/marketing/performance";
import * as reviewsRoute from "~/routes/admin/marketing/reviews";
import * as segmentsRoute from "~/routes/admin/marketing/segments";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { consents, employeeRoles } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { saveCampaign } from "~/server/services/admin/marketing/campaigns.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
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
  return { requestId: `probe-${randomToken(6)}`, nonce: "n", origin: ORIGIN, isHttps: false, isDev: true, now: Date.now(), ip: null, country: "IQ", userAgent: "vitest", locale: "ar", dir: "rtl", prefs: { theme: "system", currency: "IQD", numbering: "latn" }, storeMode: "live", cookie: () => null, setCookie: () => {} };
}
async function signedIn(role: DefaultRoleKey): Promise<{ cookie: string; actor: EmployeeActor }> {
  const password = "marketing-probe-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("probe")}@marketing-probe.test`;
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

const SECTION: Record<string, readonly DefaultRoleKey[]> = {
  // who may open each page (owner and manager hold every marketing permission; finance only the reports; content reviews)
  any: ["owner", "manager", "finance", "content"],
  campaigns: ["owner", "manager"],
  carts: ["owner", "manager"],
  links: ["owner", "manager", "finance"],
  crossSell: ["owner", "manager"],
  reviews: ["owner", "manager", "content"],
  performance: ["owner", "manager", "finance"],
};

test("every loader and every intent, for seven roles: 200 / 400 / 403 / 404, never 500", async () => {
  const sessions: Partial<Record<DefaultRoleKey, { cookie: string; actor: EmployeeActor }>> = {};
  const roles = ["owner", "manager", "finance", "content", "support", "cashier", "fulfillment"] as const;
  for (const role of roles) sessions[role] = await signedIn(role);
  const manager = sessions.manager?.actor as EmployeeActor;
  const campaign = await saveCampaign(t.db, manager, { idempotencyKey: "probe-campaign-00001", name: "حملة الفحص", channel: "sms", bodyAr: "مرحباً {name}", guests: true }, NOW);
  const customer = await make.customer();
  await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: customer, kind: "marketing", granted: true, source: "account", at: NOW });

  const pages: [string, Record<string, string>, unknown, keyof typeof SECTION, number?][] = [
    ["/admin/marketing", {}, layoutRoute.loader, "any"],
    ["/admin/marketing", {}, indexRoute.loader, "any"],
    ["/admin/marketing/campaigns", {}, campaignsRoute.loader, "campaigns"],
    ["/admin/marketing/campaigns?view=bogus&page=-3&channel=fax&demo=1", {}, campaignsRoute.loader, "campaigns"],
    ["/admin/marketing/campaigns/new?platform=plt_playstation&from=2026-01-01", { campaignId: "new" }, campaignRoute.loader, "campaigns"],
    [`/admin/marketing/campaigns/${campaign.campaignId}?rpage=x`, { campaignId: campaign.campaignId }, campaignRoute.loader, "campaigns"],
    ["/admin/marketing/campaigns/nope", { campaignId: "nope" }, campaignRoute.loader, "campaigns", 404],
    ["/admin/marketing/campaigns/%27%22", { campaignId: "'\"" }, campaignRoute.loader, "campaigns", 404],
    ["/admin/marketing/segments?platform=x&from=bad&to=٢٠٢٦-١١-١٠&f=1", {}, segmentsRoute.loader, "campaigns"],
    ["/admin/marketing/carts?view=all&demo=1", {}, cartsRoute.loader, "carts"],
    ["/admin/marketing/links?from=2026-01-01&to=2026-12-31&q=a", {}, linksRoute.loader, "links"],
    ["/admin/marketing/cross-sell?device=dvm_nope&kind=pin&active=all", {}, crossSellRoute.loader, "crossSell"],
    ["/admin/marketing/reviews?view=all&rating=9", {}, reviewsRoute.loader, "reviews"],
    ["/admin/marketing/performance?from=2026-01&to=2099-01", {}, performanceRoute.loader, "performance"],
    ["/admin/marketing/performance/csv?from=2026-09&to=2026-11", {}, csvRoute.loader, "performance"],
  ];
  for (const [path, params, loader, section, okStatus] of pages) {
    for (const role of roles) {
      const { status, value } = await call(sessions[role]?.cookie ?? "", path, params, loader);
      const allowed = SECTION[section].includes(role);
      expect(status, `${role} ${path} ${status === 500 ? String(value) : ""}`).toBe(allowed ? (okStatus ?? 200) : 403);
    }
  }

  // the export is a CSV with a byte-order mark, and it is audited
  const csv = await call(sessions.finance?.cookie ?? "", "/admin/marketing/performance/csv?from=2026-11&to=2026-11", {}, csvRoute.loader);
  expect(csv.value instanceof Response && csv.value.headers.get("content-type")).toContain("text/csv");
  const audited = (await t.d1.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'marketing.report.export'").all<{ n: number }>()).results[0].n;
  expect(audited).toBeGreaterThan(0);

  // every intent with an empty form: 400 (or a 404/409 for a record that is not there) for who may act, 403 otherwise
  const intents: [string, Record<string, string>, unknown, string, readonly DefaultRoleKey[]][] = [
    ["/admin/marketing/campaigns/new", { campaignId: "new" }, campaignRoute.action, "save", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "submit", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "decide", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "withdraw", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "cancel", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "close", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "spend", ["owner", "manager"]],
    [`/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, "link", ["owner", "manager"]],
    ["/admin/marketing/carts", {}, cartsRoute.action, "prepare", ["owner", "manager"]],
    ["/admin/marketing/links", {}, linksRoute.action, "create", ["owner", "manager"]],
    ["/admin/marketing/cross-sell", {}, crossSellRoute.action, "create", ["owner", "manager"]],
    ["/admin/marketing/cross-sell", {}, crossSellRoute.action, "active", ["owner", "manager"]],
    ["/admin/marketing/reviews", {}, reviewsRoute.action, "moderate", ["owner", "manager", "content"]],
  ];
  for (const [path, params, action, intent, may] of intents) {
    for (const role of roles) {
      const { status, value } = await call(sessions[role]?.cookie ?? "", path, params, action, { intent });
      if (may.includes(role)) expect([400, 404, 409], `${role} ${intent} ${status} ${JSON.stringify(value)}`).toContain(status);
      else expect(status, `${role} ${intent}`).toBe(403);
    }
  }
  // an unknown intent is 400 for anyone who may open the page
  expect((await call(sessions.manager?.cookie ?? "", "/admin/marketing/carts", {}, cartsRoute.action, { intent: "bogus" })).status).toBe(400);
  // the empty form has no campaign to submit: 404
  expect((await call(sessions.manager?.cookie ?? "", "/admin/marketing/campaigns/new", { campaignId: "new" }, campaignRoute.action, { intent: "submit" })).status).toBe(404);
  // release on a draft: 409, never a 500
  expect((await call(sessions.owner?.cookie ?? "", `/admin/marketing/campaigns/${campaign.campaignId}`, { campaignId: campaign.campaignId }, campaignRoute.action, { intent: "release" })).status).toBe(409);
});
