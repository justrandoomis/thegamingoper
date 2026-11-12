/**
 * Admin module 02 "catalog" — the route modules themselves (loaders, actions and the CSV resource route) behind the
 * real root middleware, with real staff sessions (sign-in through the auth service), against a local D1 with the demo
 * catalogue. Complements tests/admin-catalog.test.ts (the services):
 *
 *   · every loader asks for its own permission: a cashier reads the list but gets 403 on a save or an import page
 *   · actions validate the raw form (field errors as a 400 answer, never a crash) and answer translated failures
 *   · the CSV export of a role without cost.read has no cost columns at all; a manager's has them
 *   · loader data never carries cost for a role without cost.read
 *   · the form helpers: nested names, repeated keys, Baghdad time
 *   · adversarial review 2026-11-11: uploads carry the upload rate limit per employee; the permission is checked before
 *     the input or the version; switching off a category with products in the store needs a reason; every editor tab
 *     answers 404 for a product that does not exist; field errors read as staff should read them
 */
import { crc32 } from "node:zlib";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub, RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import catalogMessages from "~/i18n/messages/admin-catalog";
import { makeT } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { SpecsEditor } from "~/routes/admin/catalog/components/SpecsEditor";
import { action as categoriesAction, loader as categoriesLoader } from "~/routes/admin/catalog/category-tree";
import { action as importAction } from "~/routes/admin/catalog/csv-import";
import { action as detailsAction, loader as detailsLoader } from "~/routes/admin/catalog/editor-details";
import { loader as bundleLoader } from "~/routes/admin/catalog/editor-bundle";
import { loader as compatibilityLoader } from "~/routes/admin/catalog/editor-compatibility";
import { loader as historyLoader } from "~/routes/admin/catalog/editor-history";
import { action as mediaAction, loader as mediaLoader } from "~/routes/admin/catalog/editor-media";
import { loader as relatedLoader } from "~/routes/admin/catalog/editor-related";
import { action as variantsAction, loader as variantsLoader } from "~/routes/admin/catalog/editor-variants";
import { action as newProductAction } from "~/routes/admin/catalog/new-product";
import { action as frameAction } from "~/routes/admin/catalog/product-editor";
import { fieldErrorText, inputDir, L10nFields } from "~/routes/admin/catalog/components/ui";
import { loader as exportLoader } from "~/routes/admin/catalog/csv-export";
import { loader as importLoader } from "~/routes/admin/catalog/csv-import";
import { action as listAction, loader as listLoader } from "~/routes/admin/catalog/product-list";
import { baghdadInputToEpoch, formObject } from "~/routes/admin/catalog/catalog.server";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { employeeRoles } from "~/server/db/schema";
import { seedDemo } from "~/server/db/seed/demo";
import { parseCsv } from "~/server/services/admin/catalog/csv";
import { roleId, type DefaultRoleKey } from "~/server/permissions";
import { RATE_LIMITS } from "~/server/ratelimit.server";
import { createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

let t: TestDb;
let make: Fixtures;
const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  t = await createTestDb();
  await seedDemo(t.db, t.now);
  await seedRoles(t.db, t.now);
  make = fixtures(t.db, t.now);
});
afterAll(async () => {
  await t?.dispose();
});

/** A request context for the sign-in service (what the root middleware would build). */
function signInCtx(cookies: string[]): RequestCtx {
  return {
    requestId: "catalog-routes",
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
    setCookie: (serialized) => {
      cookies.push(serialized);
    },
  };
}

/** A signed-in employee of a role, as a Cookie header. */
async function staffCookie(role: DefaultRoleKey): Promise<string> {
  const password = "catalog-routes-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next(role)}@catalog.test`;
  const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const set: string[] = [];
  const result = await signInEmployee(signInCtx(set), t.db, { email, password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const token = set.map((cookie) => cookie.split(";")[0]).find((pair) => pair.startsWith("tt_adm=") && pair.length > "tt_adm=".length);
  if (!token) throw new Error("no session cookie");
  return token;
}

type Args = { request: Request; context: RouterContextProvider; url: URL; pattern: string; params: Record<string, string> };
/** The generated route types are narrower than a test request; every handler is called with the same shape. */
const handler = (fn: unknown) => fn as (args: Args) => Promise<unknown>;

/** Runs a loader or action behind the root middleware (CSRF check, request context, headers). */
async function run(handler: (args: Args) => Promise<unknown>, path: string, cookie: string, init: RequestInit & { params?: Record<string, string>; pattern?: string } = {}) {
  const headers: Record<string, string> = { Cookie: cookie, ...(init.method && init.method !== "GET" ? { Origin: ORIGIN } : {}) };
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", body: init.body, headers });
  const context = new RouterContextProvider();
  const url = new URL(request.url);
  let result: unknown;
  try {
    await requestContextMiddleware({ request, context, url, pattern: init.pattern ?? "admin/catalog", params: init.params ?? {} }, async () => {
      result = await handler({ request, context, url, pattern: init.pattern ?? "admin/catalog", params: init.params ?? {} });
      return new Response(null);
    });
  } catch (error) {
    return { thrown: error };
  }
  return { result };
}

/** Status and body of a data() result, a Response or a thrown one. */
async function described(outcome: { result?: unknown; thrown?: unknown }): Promise<{ status: number; body: unknown }> {
  const value = outcome.thrown ?? outcome.result;
  if (value instanceof Response) {
    const text = await value.text();
    return { status: value.status, body: text };
  }
  const init = value as { type?: string; init?: { status?: number }; data?: unknown };
  if (init?.type === "DataWithResponseInit") return { status: init.init?.status ?? 200, body: init.data };
  return { status: 200, body: value };
}

const form = (entries: Record<string, string | string[]>) => {
  const body = new FormData();
  for (const [key, value] of Object.entries(entries)) for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  return body;
};

describe("form helpers", () => {
  test("nested names, repeated keys and arrays become the objects the services read", () => {
    const parsed = formObject(form({ "name.ar": "اسم", "name.en": "Name", "specs.0.key": "storage", "specs.0.value.ar": "1TB", "specs.2.key": "gpu", ids: ["a", "b"], "__proto__.x": "no" }));
    expect(parsed).toEqual({ name: { ar: "اسم", en: "Name" }, specs: [{ key: "storage", value: { ar: "1TB" } }, { key: "gpu" }], ids: ["a", "b"] });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("Baghdad wall-clock time is UTC+3 all year", () => {
    expect(baghdadInputToEpoch("2026-11-12T10:30")).toBe(Date.UTC(2026, 10, 12, 7, 30));
    expect(baghdadInputToEpoch("2026-07-01T00:00")).toBe(Date.UTC(2026, 5, 30, 21, 0));
    expect(baghdadInputToEpoch("12/11/2026")).toBeUndefined();
  });
});

/** A component as the server renders it inside the admin, with the catalogue's strings, in the admin's language. */
function render(node: () => ReactNode, locale: Locale): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "admin", Component: () => node() }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/admin"],
      hydrationData: { loaderData: { root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui") }, page: { i18n: messagesFor(locale, "admin-catalog") } } },
    }),
  );
}
/** The opening tag of the input named `name`. */
const inputTag = (html: string, name: string) => new RegExp(`<input[^>]*name="${name.replace(/\./g, "\\.")}"[^>]*>`).exec(html)?.[0] ?? "";

describe("per-language fields keep their own direction (QA 2026-11-12)", () => {
  // the kit's TextField dropped the `dir` it was given: «007 First Light» read «First Light 007» in the Arabic admin
  test("a one-line field: English left to right from the server; Arabic and Sorani right to left from the first paint", () => {
    for (const locale of ["ar", "en"] as const) {
      const html = render(() => createElement(L10nFields, { name: "name", label: "name", value: { ar: "007 فيرست لايت", en: "007 First Light", ckb: "" } }), locale);
      expect(inputTag(html, "name.en"), locale).toMatch(/dir="ltr"/);
      for (const code of ["ar", "ckb"]) {
        expect(inputTag(html, `name.${code}`), `${locale} ${code}`).toContain("[direction:rtl]");
        expect(inputTag(html, `name.${code}`), `${locale} ${code}`).not.toMatch(/dir="ltr"/);
      }
      // the spec sheet on the same page
      const specs = render(() => createElement(SpecsEditor, { rows: [{ key: "storage", label: { ar: "السعة", en: "Storage" }, value: { ar: "1 تيرابايت", en: "1 TB" } }], error: () => undefined }), locale);
      expect(inputTag(specs, "specs.0.label.en"), locale).toMatch(/dir="ltr"/);
      expect(inputTag(specs, "specs.0.value.ar"), locale).toContain("[direction:rtl]");
      expect(inputTag(specs, "specs.0.value.ckb"), locale).toContain("[direction:rtl]");
    }
  });

  test("inputDir: the attribute too, once the input exists in the browser", () => {
    expect(inputDir("ltr")).toMatchObject({ dir: "ltr", ltr: true });
    const attributes = new Map<string, string>();
    (inputDir("rtl").ref as (node: unknown) => void)({ setAttribute: (name: string, value: string) => attributes.set(name, value) });
    expect(attributes.get("dir")).toBe("rtl");
  });
});

describe("route permissions and answers", () => {
  test("a cashier reads the list but may not save details, open the import page or bulk-edit", async () => {
    const cashier = await staffCookie("cashier");
    const list = await described(await run(handler(listLoader), "/admin/catalog?kind=game", cashier));
    expect(list.status).toBe(200);
    expect((list.body as { result: { total: number } }).result.total).toBeGreaterThan(0);
    expect((list.body as { can: Record<string, boolean> }).can).toMatchObject({ create: false, bulkEdit: false, export: false });

    const product = (list.body as { result: { rows: { id: string }[] } }).result.rows[0].id;
    const save = await described(await run(handler(detailsAction), `/admin/catalog/products/${product}`, cashier, { method: "POST", body: form({ intent: "save", version: "1" }), params: { id: product } }));
    expect(save.status).toBe(403);
    // The import page asks for catalog.product.read and shows nothing to import without the permission.
    const page = await described(await run(handler(importLoader), "/admin/catalog/import", cashier));
    expect(page.body).toMatchObject({ jobs: [], can: { import: false, export: false } });
    const bulk = await described(await run(handler(listAction), "/admin/catalog", cashier, { method: "POST", body: form({ intent: "bulk_update", ids: [product], "set.brand": "X", reason: "test" }) }));
    expect(bulk.status).toBe(403);
    expect(bulk.body).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("a content editor's invalid save comes back as field errors (400), translated", async () => {
    const content = await staffCookie("content");
    const list = await described(await run(handler(listLoader), "/admin/catalog?kind=game&status=published", content));
    const product = (list.body as { result: { rows: { id: string }[] } }).result.rows[0].id;
    const details = await described(await run(handler(detailsLoader), `/admin/catalog/products/${product}`, content, { params: { id: product } }));
    const version = (details.body as { editor: { product: { version: number } } }).editor.product.version;
    const answer = await described(await run(handler(detailsAction), `/admin/catalog/products/${product}`, content, { method: "POST", body: form({ intent: "save", version: String(version), kind: "game", "name.ar": "", slug: "Not A Slug" }), params: { id: product } }));
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ ok: false, code: "invalid", intent: "save" });
    const fields = (answer.body as { fields: Record<string, string> }).fields;
    expect(fields["name.ar"]).toBe("هذا الحقل مطلوب.");
    expect(fields.slug).toBe("استخدم كلمات إنجليزية صغيرة وأرقاماً بينها شرطات.");
    // An unknown intent is a 400, not a crash.
    const unknown = await described(await run(handler(detailsAction), `/admin/catalog/products/${product}`, content, { method: "POST", body: form({ intent: "drop_table" }), params: { id: product } }));
    expect(unknown.status).toBe(400);
  });

  test("cost reaches neither the loader data nor the export of a role without cost.read", async () => {
    const content = await staffCookie("content");
    const manager = await staffCookie("manager");
    const list = await described(await run(handler(listLoader), "/admin/catalog?kind=console", content));
    const product = (list.body as { result: { rows: { id: string }[] } }).result.rows[0].id;
    const forContent = await described(await run(handler(variantsLoader), `/admin/catalog/products/${product}/variants`, content, { params: { id: product } }));
    expect(JSON.stringify(forContent.body)).not.toMatch(/landedCost|marginBps/);
    const forManager = await described(await run(handler(variantsLoader), `/admin/catalog/products/${product}/variants`, manager, { params: { id: product } }));
    expect(JSON.stringify(forManager.body)).toMatch(/landedCostIqd/);

    // Content may not export at all; the manager's variant sheet has the cost columns.
    expect((await described(await run(handler(exportLoader), "/admin/catalog/export?level=variants", content))).status).toBe(403);
    const sheet = await described(await run(handler(exportLoader), "/admin/catalog/export?level=variants&kind=console", manager));
    expect(sheet.status).toBe(200);
    expect(parseCsv(sheet.body as string).header).toEqual(expect.arrayContaining(["landed_cost_iqd", "margin_percent"]));
  });
});

describe("uploads (adversarial review 2026-11-11)", () => {
  /** A real 2×2 PNG (the upload service parses the whole file). */
  const chunk = (type: string, data: number[]) => {
    const body = Uint8Array.from([...new TextEncoder().encode(type), ...data]);
    const be = (value: number) => [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    return [...be(data.length), ...body, ...be(crc32(body) >>> 0)];
  };
  const png = () =>
    new File(
      [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [0, 0, 0, 2, 0, 0, 0, 2, 8, 2, 0, 0, 0]), ...chunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]), ...chunk("IEND", [])])],
      "photo.png",
      { type: "image/png" },
    );

  test("picture and CSV uploads carry the upload rate limit per employee (SECURITY §9)", async () => {
    const content = await staffCookie("content");
    const manager = await staffCookie("manager");
    const list = await described(await run(handler(listLoader), "/admin/catalog?kind=accessory", content));
    const product = (list.body as { result: { rows: { id: string }[] } }).result.rows[0].id;
    // The limiter's windows are aligned to the clock: freeze the date just inside a fresh window.
    const window = RATE_LIMITS.upload.windowSec * 1000;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Math.ceil(Date.now() / window) * window + 1000);
    try {
      const upload = async (cookie: string) => {
        const body = new FormData();
        body.append("intent", "upload");
        body.append("file", png());
        return described(await run(handler(mediaAction), `/admin/catalog/products/${product}/media`, cookie, { method: "POST", body, params: { id: product } }));
      };
      for (let i = 0; i < RATE_LIMITS.upload.limit; i++) expect((await upload(content)).status, `upload ${i + 1}`).toBe(200);
      const refused = await upload(content);
      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ ok: false, code: "rate_limited" });
      // The limit is per employee: a colleague still uploads.
      expect((await upload(manager)).status).toBe(200);
      // A CSV file is an upload too (stored privately): the same budget.
      for (let i = 0; i < RATE_LIMITS.upload.limit - 1; i++) {
        const body = new FormData();
        body.append("file", new File(["slug,brand\r\nno-such-product,X\r\n"], "products.csv", { type: "text/csv" }));
        await run(handler(importAction), "/admin/catalog/import", manager, { method: "POST", body });
      }
      const body = new FormData();
      body.append("file", new File(["slug,brand\r\nno-such-product,X\r\n"], "products.csv", { type: "text/csv" }));
      const csv = await described(await run(handler(importAction), "/admin/catalog/import", manager, { method: "POST", body }));
      expect(csv.status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("adversarial review 2026-11-11 (2): permission first, a reason from the category page", () => {
  type Rows = { result: { rows: { id: string; complete: boolean }[] } };

  test("a role without the permission is refused (403) before its input is read or its version compared", async () => {
    const cashier = await staffCookie("cashier");
    const list = await described(await run(handler(listLoader), "/admin/catalog?status=published", cashier));
    const product = (list.body as Rows).result.rows[0].id;
    // A variant save with nothing in it: "forbidden", not a list of field errors about a form it may not send.
    const variant = await described(await run(handler(variantsAction), `/admin/catalog/products/${product}/variants`, cashier, { method: "POST", body: form({ intent: "save", version: "1", sku: "" }), params: { id: product } }));
    expect(variant.status).toBe(403);
    expect(variant.body).toMatchObject({ ok: false, code: "forbidden" });
    // A publishing move with a stale version: "forbidden", not "the product changed".
    const move = await described(await run(handler(frameAction), `/admin/catalog/products/${product}`, cashier, { method: "POST", body: form({ intent: "status", action: "hide", version: "999", reason: "اختبار الصلاحية" }), params: { id: product } }));
    expect(move.status).toBe(403);
    expect(move.body).toMatchObject({ ok: false, code: "forbidden" });
    // …nor field errors about a schedule it may not set.
    const schedule = await described(await run(handler(frameAction), `/admin/catalog/products/${product}`, cashier, { method: "POST", body: form({ intent: "status", action: "schedule", version: "x", publishAt: "soon" }), params: { id: product } }));
    expect(schedule.status).toBe(403);
    // A bulk move with nothing chosen: forbidden too.
    const bulk = await described(await run(handler(listAction), "/admin/catalog", cashier, { method: "POST", body: form({ intent: "bulk_status", action: "archive" }) }));
    expect(bulk.status).toBe(403);
  });

  test("switching off a category with products in the store asks the page for a reason, and the tree shows how many", async () => {
    const manager = await staffCookie("manager");
    const slug = "route-review-live-category";
    const name = "تصنيف لمراجعة الإيقاف";
    const created = await described(await run(handler(categoriesAction), "/admin/catalog/categories", manager, { method: "POST", body: form({ intent: "save", slug, "name.ar": name, isActive: "on" }) }));
    expect(created.body).toMatchObject({ ok: true });
    const categoryId = (created.body as { id: string }).id;
    const list = await described(await run(handler(listLoader), "/admin/catalog?status=published", manager));
    const published = (list.body as Rows).result.rows.find((row) => row.complete);
    if (!published) throw new Error("no complete published product in the demo catalogue");
    const moved = await described(await run(handler(listAction), "/admin/catalog", manager, { method: "POST", body: form({ intent: "bulk_update", ids: [published.id], "set.categoryId": categoryId, reason: "نقل للمراجعة" }) }));
    expect(moved.body).toMatchObject({ ok: true, updated: 1 });

    const off = { intent: "save", id: categoryId, slug, "name.ar": name, isActive: "" };
    const refused = await described(await run(handler(categoriesAction), "/admin/catalog/categories", manager, { method: "POST", body: form(off) }));
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, code: "invalid", fields: { reason: "اكتب السبب (3 أحرف على الأقل)." } });
    const tree = await described(await run(handler(categoriesLoader), "/admin/catalog/categories", manager));
    expect((tree.body as { tree: { flat: { id: string; isActive: boolean; subtreeLive: number }[] } }).tree.flat.find((node) => node.id === categoryId)).toMatchObject({ isActive: true, subtreeLive: 1 });

    const done = await described(await run(handler(categoriesAction), "/admin/catalog/categories", manager, { method: "POST", body: form({ ...off, reason: "تصنيف للمراجعة فقط" }) }));
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ ok: true, id: categoryId });
  });
});

describe("adversarial review 2026-11-11 (3): a product that does not exist", () => {
  test("every tab of the editor answers 404 (the tabs load beside the frame: none of them may end as a server error)", async () => {
    const content = await staffCookie("content");
    const id = "prd_no-such-product-anywhere";
    for (const [name, loader, path] of [
      ["details", detailsLoader, ""],
      ["variants", variantsLoader, "/variants"],
      ["media", mediaLoader, "/media"],
      ["bundle", bundleLoader, "/bundle"],
      ["related", relatedLoader, "/related"],
      ["compatibility", compatibilityLoader, "/compatibility"],
      ["history", historyLoader, "/history"],
    ] as const) {
      const answer = await described(await run(handler(loader), `/admin/catalog/products/${id}${path}`, content, { params: { id } }));
      expect(answer.status, name).toBe(404);
      expect(answer.body, name).toEqual({ error: "not_found" });
    }
  });
});

describe("adversarial review 2026-11-11 (4): field errors as staff read them", () => {
  test("an empty category on a new product is 'required', and a sentence the server translated is shown as it is", async () => {
    const content = await staffCookie("content");
    const answer = await described(await run(handler(newProductAction), "/admin/catalog/new", content, { method: "POST", body: form({ kind: "accessory", "name.ar": "حامل", slug: "route-review-stand", categoryId: "" }) }));
    expect(answer.status).toBe(400);
    const fields = (answer.body as { fields: Record<string, string> }).fields;
    expect(fields.categoryId).toBe("هذا الحقل مطلوب.");
    // The screen shows that sentence without looking it up again as a key (which only logs "missing key").
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t = makeT(catalogMessages.ar, "ar", "admin-catalog");
      // (The spy does see a lookup of a key that does not exist.)
      t("errors.no_such_key_for_the_spy");
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockClear();
      expect(fieldErrorText(t, answer.body, "categoryId")).toBe("هذا الحقل مطلوب.");
      // A key the server could not translate is still translated on the screen.
      expect(fieldErrorText(t, { ok: false, code: "invalid", fields: { sku: "sku_taken" } }, "sku")).toBe("هذا الـ SKU مستخدم لمتغير آخر.");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
