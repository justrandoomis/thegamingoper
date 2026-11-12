/**
 * Admin module 17 "cms" — its routes against a real local D1 (demo catalogue): every page's loader answers 403 to a
 * signed-in employee without the section's permission and 200 to the content role; actions read the forms as the
 * pages send them (ar/en/ckb fields, JSON lists, Arabic-Indic digits), refuse a role without the permission before
 * any field error, and translate failures; every error code the services throw has its sentence in ar/en/ckb.
 */
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { getNamespace } from "~/i18n/i18n.server";
import { translate, type MessageTree } from "~/i18n/translate";
import { randomToken } from "~/lib/ids";
import { action as bannerAction, loader as bannerLoader } from "~/routes/admin/cms/banner";
import { loader as bannersLoader } from "~/routes/admin/cms/banners";
import { action as homeAction, loader as homeLoader } from "~/routes/admin/cms/home";
import { loader as indexLoader } from "~/routes/admin/cms/index";
import { loader as navigationLoader } from "~/routes/admin/cms/navigation";
import { action as pageAction, loader as pageLoader } from "~/routes/admin/cms/page";
import { loader as pagesLoader } from "~/routes/admin/cms/pages";
import { loader as pinLoader } from "~/routes/admin/cms/pin";
import { action as redirectsAction, loader as redirectsLoader } from "~/routes/admin/cms/redirects";
import { loader as scheduleLoader } from "~/routes/admin/cms/schedule";
import { loader as searchLoader } from "~/routes/admin/cms/search";
import { loader as seoLoader } from "~/routes/admin/cms/seo";
import { loader as zeroLoader } from "~/routes/admin/cms/zero";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { seedDemo } from "~/server/db/seed/demo";
import { employeeRoles, rolePermissions, roles } from "~/server/db/schema";
import { CMS_ERROR_KEYS } from "~/server/services/admin/cms/shared.server";
import { roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
let t: TestDb;
let make: Fixtures;
type Person = { id: string; email: string; password: string };
const people: Record<string, Person> = {};
let cookies: Record<string, string> = {};
let roleSeq = 0;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, t.now);
  await seedDemo(t.db, t.now);
  await seedRoles(t.db, t.now);
  people.content = await person("content");
  people.cashier = await person("cashier");
  people.editor = await person(["cms.page.manage"]);
  cookies = Object.fromEntries(await Promise.all(Object.entries(people).map(async ([key, who]) => [key, await signedIn(who)] as const)));
}, 180_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[]): Promise<Person> {
  const password = "cms-routes-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("cms")}@cms.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? "custom" : role, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (Array.isArray(role)) {
    const custom = `role_cms_${++roleSeq}`;
    await t.db.insert(roles).values({ id: custom, key: `cms_${roleSeq}`, name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: t.now });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
  } else {
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  }
  return { id, email, password };
}

function requestCtx(): RequestCtx {
  return {
    requestId: `cms-${randomToken(6)}`,
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
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function run(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown, body?: FormData): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, body ? { method: "POST", headers: { cookie, origin: ORIGIN }, body } : { headers: { cookie } });
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
const dataOf = (value: unknown) => ((value as { data?: unknown } | null)?.data ?? value) as Record<string, unknown>;
const formOf = (entries: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(entries)) form.append(name, value);
  return form;
};

const PAGES: [string, string, Record<string, string>, (args: never) => unknown][] = [
  ["index", "/admin/cms", {}, indexLoader as never],
  ["home", "/admin/cms/home", {}, homeLoader as never],
  ["pin", "/admin/cms/home/pins/new", { pinId: "new" }, pinLoader as never],
  ["banners", "/admin/cms/banners", {}, bannersLoader as never],
  ["banner", "/admin/cms/banners/new", { bannerId: "new" }, bannerLoader as never],
  ["pages", "/admin/cms/pages", {}, pagesLoader as never],
  ["page", "/admin/cms/pages/terms", { slug: "terms" }, pageLoader as never],
  ["schedule", "/admin/cms/schedule", {}, scheduleLoader as never],
  ["navigation", "/admin/cms/navigation", {}, navigationLoader as never],
  ["search", "/admin/cms/search", {}, searchLoader as never],
  ["zero", "/admin/cms/search/zero", {}, zeroLoader as never],
  ["seo", "/admin/cms/seo", {}, seoLoader as never],
  ["redirects", "/admin/cms/redirects", {}, redirectsLoader as never],
];

describe("loaders", () => {
  test.each(PAGES)("%s: 403 without a content permission, 200 for the content role", async (_name, path, params, loader) => {
    expect(statusOf(await run(cookies.cashier, path, params, loader))).toBe(403);
    expect(statusOf(await run(cookies.content, path, params, loader))).toBe(200);
  });

  test("a page editor without other content permissions opens pages, not banners", async () => {
    expect(statusOf(await run(cookies.editor, "/admin/cms/pages", {}, pagesLoader as never))).toBe(200);
    expect(statusOf(await run(cookies.editor, "/admin/cms/banners", {}, bannersLoader as never))).toBe(403);
    // an unknown page slug is a 404, not a crash
    expect(statusOf(await run(cookies.content, "/admin/cms/pages/no-such-page", { slug: "no-such-page" }, pageLoader as never))).toBe(404);
  });

  test("a stale link opens the page, not a 404 of it: an unknown filter scope, an unknown synonym set (review 2026-11-12)", async () => {
    const navigation = await run(cookies.content, "/admin/cms/navigation?filters=no-such-category", {}, navigationLoader as never);
    expect(statusOf(navigation)).toBe(200);
    expect((dataOf(navigation).filters as { categoryId: string | null }).categoryId).toBeNull();
    const search = await run(cookies.content, "/admin/cms/search?edit=no-such-set", {}, searchLoader as never);
    expect(statusOf(search)).toBe(200);
    expect(dataOf(search).editing).toBeNull();
  });

  test("no cost or margin field travels in the module's loader data", async () => {
    const data = JSON.stringify(dataOf(await run(cookies.content, "/admin/cms/home/pins/new?platform=playstation", { pinId: "new" }, pinLoader as never)));
    for (const word of ["unitCost", "unit_cost", "landed", "margin", "costIqd"]) expect(data).not.toContain(word);
  });
});

describe("actions", () => {
  test("a banner from the form: ar/en/ckb fields, Arabic-Indic order digits; errors translated; 403 before fields", async () => {
    const base = { intent: "save", placement: "home_strip", "title.ar": "عرض الشتاء", "title.en": "Winter offer", "title.ckb": "", accent: "brand", sort: "٢", link: "/used" };
    const created = dataOf(await run(cookies.content, "/admin/cms/banners/new", { bannerId: "new" }, bannerAction as never, formOf(base)));
    expect(created).toMatchObject({ ok: true, intent: "save", created: true });
    const bad = await run(cookies.content, "/admin/cms/banners/new", { bannerId: "new" }, bannerAction as never, formOf({ ...base, link: "/admin" }));
    expect(statusOf(bad)).toBe(400);
    expect(dataOf(bad)).toMatchObject({ ok: false, fields: { link: "لا يمكن الربط بلوحة الإدارة أو الواجهة البرمجية." } });
    const forbidden = await run(cookies.cashier, "/admin/cms/banners/new", { bannerId: "new" }, bannerAction as never, formOf({ ...base, "title.ar": "" }));
    expect(statusOf(forbidden)).toBe(403);
  });

  test("the home layout from the form's JSON lists; a page editor cannot approve a policy", async () => {
    const saved = dataOf(await run(cookies.content, "/admin/cms/home", {}, homeAction as never, formOf({ intent: "layout", order: JSON.stringify(["deals", "games"]), hidden: JSON.stringify(["used"]), version: "0", reason: "تخفيضات أولاً" })));
    expect(saved).toMatchObject({ ok: true, intent: "layout" });
    const refused = await run(cookies.editor, "/admin/cms/pages/terms", { slug: "terms" }, pageAction as never, formOf({ intent: "publish", version: "1", reason: "اعتماد" }));
    expect(statusOf(refused)).toBe(403);
  });

  test("redirects: create, then switch many off at once from the bulk dialog's JSON ids", async () => {
    const one = dataOf(await run(cookies.content, "/admin/cms/redirects", {}, redirectsAction as never, formOf({ intent: "save", fromPath: "/old-one", toPath: "/used", code: "301" })));
    const two = dataOf(await run(cookies.content, "/admin/cms/redirects", {}, redirectsAction as never, formOf({ intent: "save", fromPath: "/old-two", toPath: "/support", code: "302" })));
    const bulk = dataOf(await run(cookies.content, "/admin/cms/redirects", {}, redirectsAction as never, formOf({ intent: "active", ids: JSON.stringify([one.id, two.id]), active: "false", reason: "انتهت الحملة" })));
    expect(bulk).toMatchObject({ ok: true, changed: [one.id, two.id], skipped: [] });
    const loop = await run(cookies.content, "/admin/cms/redirects", {}, redirectsAction as never, formOf({ intent: "save", fromPath: "/old-one", toPath: "/old-one" }));
    expect(dataOf(loop)).toMatchObject({ ok: false });
  });

  test("a full address of the host the request came to is a store path: the admin is refused (review 2026-11-12)", async () => {
    const redirect = await run(cookies.content, "/admin/cms/redirects", {}, redirectsAction as never, formOf({ intent: "save", fromPath: "/old-three", toPath: `${ORIGIN}/admin/orders`, code: "301" }));
    expect(statusOf(redirect)).toBe(400);
    expect(dataOf(redirect)).toMatchObject({ ok: false, fields: { toPath: expect.any(String) } });
    expect((dataOf(redirect).fields as Record<string, string>).toPath).toBe(translate(getNamespace("admin-cms")!.ar as MessageTree, "ar", "errors.path_reserved"));
    const banner = await run(cookies.content, "/admin/cms/banners/new", { bannerId: "new" }, bannerAction as never, formOf({ intent: "save", placement: "cart", "title.ar": "رابط", link: `${ORIGIN}/api/cart` }));
    expect((dataOf(banner).fields as Record<string, string>).link).toBe(translate(getNamespace("admin-cms")!.ar as MessageTree, "ar", "errors.link_reserved"));
  });
});

describe("words", () => {
  test("every error code of the module has its sentence in Arabic, English and Sorani", () => {
    const ns = getNamespace("admin-cms")!;
    const fieldCodes = ["product_not_published", "product_scheduled_later", "product_incomplete", "section_locked", "reason_required"];
    for (const locale of ["ar", "en", "ckb"] as const) {
      for (const key of [...CMS_ERROR_KEYS, ...fieldCodes]) expect(translate(ns[locale] as MessageTree, locale, `errors.${key}`), `${locale}: errors.${key}`).toBeTruthy();
    }
  });
});
