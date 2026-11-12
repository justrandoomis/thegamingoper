/**
 * Review of admin module 01 "dashboard" — each test below failed on the builder's code:
 *
 *   · the global search answered a long Arabic sentence (with serial numbers in the store) or a pasted text with
 *     three-byte characters ("…", "’", Arabic presentation forms, emoji) with a 500: D1 refuses a LIKE pattern over
 *     50 bytes, and the serial prefix took 40 characters, every other needle 20 (an Arabic letter is two bytes)
 *   · one group's failure took the whole search page (and the coming Ctrl/⌘ K palette) down
 *   · "see all" links handed the module lists a text too long for their own LIKE
 *   · the tickets group was a second search, not the support inbox's: a ticket linked to an order, a return or an
 *     e-mail was missing, and its "see all" list showed other rows in another order
 *   · the stock card paired figures with lists that count something else (SKUs on hand with the "in stock" list,
 *     units with a list of SKUs, active SKUs with lists that count archived products too)
 *   · cash on delivery outstanding opened the settlements page without the demo choice the card was computed with
 *   · the activity feed listed a gift-card action that does not exist (the approval is the issue that carries an
 *     approval) and left out a return refund refused and a knowledge revision approved or refused
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { messagesFor } from "~/i18n/i18n.server";
import dashboardMessages from "~/i18n/messages/admin-dashboard";
import type { Locale } from "~/lib/locales";
import { StockFigures } from "~/routes/admin/dashboard/components/cards";
import SearchPage from "~/routes/admin/dashboard/search";
import type { EmployeeActor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import { seedRoles } from "~/server/auth/seed-roles";
import type { Db } from "~/server/db/drizzle.server";
import { products, serials, supportTickets } from "~/server/db/schema";
import { defaultRolePermissions, DEFAULT_ROLE_KEYS, type DefaultRoleKey } from "~/server/permissions";
import { activityFeed } from "~/server/services/admin/dashboard/activity.server";
import { FEED_ACTIONS } from "~/server/services/admin/dashboard/feed";
import { moneyCard, stockCard } from "~/server/services/admin/dashboard/roles.server";
import { globalSearch, searchAccess } from "~/server/services/admin/dashboard/search.server";
import { cleanQuery, SEARCH_GROUPS, type SearchResults } from "~/server/services/admin/dashboard/types";
import { settlementOverview } from "~/server/services/admin/finance/settlements.server";
import { parseRange } from "~/server/services/admin/finance/types";
import { listReorder, parseReorderFilters } from "~/server/services/admin/inventory/analytics.server";
import { listCounts, parseCountFilters } from "~/server/services/admin/inventory/counts.server";
import { listReservations, parseReservationFilters } from "~/server/services/admin/inventory/reservations.server";
import { listOversell, listStock, parseStockFilters } from "~/server/services/admin/inventory/stock.server";
import { listTransfers, parseTransferFilters } from "~/server/services/admin/inventory/transfers.server";
import { listOrders } from "~/server/services/admin/orders/list.server";
import { parseListFilters } from "~/server/services/admin/orders/types";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { parseInboxFilters } from "~/server/services/admin/support/types";
import { eq } from "drizzle-orm";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const ORIGIN = "http://localhost:5173";
const HOUR = 60 * 60 * 1000;
let t: TestDb;
let make: Fixtures;
const actorOf = (role: DefaultRoleKey, extra: Partial<EmployeeActor> = {}): EmployeeActor => ({ kind: "employee", id: `emp_rev_${role}`, permissions: defaultRolePermissions(role), label: role, ...extra });
const searchers = DEFAULT_ROLE_KEYS.filter((role) => role !== "owner").map((role) => actorOf(role));
const owner: EmployeeActor = { kind: "employee", id: "emp_rev_owner", permissions: ["*"], label: "owner" };
const utf8 = new TextEncoder();
const likeBytes = (text: string) => utf8.encode(`%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`).length;
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: String(((error as Error)?.cause as Error)?.message ?? (error as Error)?.message ?? error) }),
  );

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, TEST_NOW);
  await seedRoles(t.db, TEST_NOW);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── search and D1's LIKE limit

describe("the global search survives what staff type (D1 refuses a LIKE pattern over 50 bytes)", () => {
  const sentence = "سماعة رأس لاسلكية للبلايستيشن الخامس لا تعمل بعد التحديث الأخير";
  beforeAll(async () => {
    const product = await make.product({ priceIqd: 120_000, stock: 3, trackSerials: true });
    await t.db.update(products).set({ name: { ar: "سماعة رأس لاسلكية للبلايستيشن الخامس", en: "Wireless headset for PlayStation 5" } }).where(eq(products.id, product.productId));
    await t.db.insert(serials).values([
      { id: "ser_rev_1", serial: "SN-REV-0001", variantId: product.variantId, status: "in_stock", source: "purchase" },
      { id: "ser_rev_2", serial: "SN-REV-0002", variantId: product.variantId, status: "in_stock", source: "purchase" },
    ]);
    const customerId = await make.customer({ name: "سماعة رأس لاسلكية للبلايستيشن الخامس" });
    await make.order([{ ...product }], { customerId, contactName: "سماعة رأس لاسلكية للبلايستيشن الخامس", status: "confirmed", placedAt: TEST_NOW - HOUR });
    await t.db.insert(supportTickets).values({ id: "tkt_rev_long", ref: "SP-REVLONG1", subject: "سماعة رأس لاسلكية للبلايستيشن الخامس لا تعمل", priority: "normal", status: "open", createdAt: TEST_NOW - HOUR, updatedAt: TEST_NOW - HOUR });
  });

  test("a long Arabic sentence: every role's search answers (it was a 500 for everyone who searches serial numbers)", async () => {
    for (const actor of [...searchers, owner]) {
      const result = await outcome(globalSearch(t.db, actor, { q: sentence }, "ar", TEST_NOW));
      expect(result, actor.label ?? "").toMatchObject({ ok: true });
    }
    // and it still finds what the start of the sentence names
    const manager = await globalSearch(t.db, actorOf("manager"), { q: sentence }, "ar", TEST_NOW);
    expect(manager.groups.skus?.length).toBeGreaterThan(0);
    expect(manager.groups.customers?.length).toBeGreaterThan(0);
    expect(manager.groups.orders?.length).toBeGreaterThan(0);
    expect(manager.groups.tickets?.map((hit) => hit.ref)).toContain("SP-REVLONG1");
  });

  test("three- and four-byte characters (a pasted PDF's presentation forms, typographic quotes, emoji): every role's search answers", async () => {
    for (const q of ["ﻻ".repeat(25), "’".repeat(30), "Marvel’s Spider‑Man 2 — “Deluxe” …", "🎮".repeat(14), "ﺳﻤﺎﻋﺔ ﺭﺃﺱ ﻻﺳﻠﻜﻴﺔ ﻟﻠﺒﻼﻳﺴﺘﻴﺸﻦ"]) {
      for (const actor of [...searchers, owner]) {
        const result = await outcome(globalSearch(t.db, actor, { q }, "ar", TEST_NOW));
        expect(result, `${actor.label} ${q}`).toMatchObject({ ok: true });
      }
    }
  });

  test("text pasted from a PDF (Arabic presentation forms) finds what the catalogue writes with ordinary letters", async () => {
    expect(cleanQuery("ﺳﻤﺎﻋﺔ ﺭﺃﺱ")).toBe("سماعة رأس");
    expect(cleanQuery("ﻻﺳﻠﻜﻴﺔ")).toBe("لاسلكية");
    expect(cleanQuery("ＰＳ５")).toBe("PS5");
    const results = await globalSearch(t.db, actorOf("manager"), { q: "ﺳﻤﺎﻋﺔ ﺭﺃﺱ ﻻﺳﻠﻜﻴﺔ" }, "ar", TEST_NOW);
    expect(results.groups.skus?.length).toBeGreaterThan(0);
  });

  test("each \"see all\" link hands its list a text that list can search (≤ 50 bytes as a LIKE pattern)", async () => {
    for (const q of [sentence, "x_".repeat(30), "’".repeat(30)]) {
      const results = await globalSearch(t.db, owner, { q }, "ar", TEST_NOW);
      for (const group of SEARCH_GROUPS) {
        const link = results.links[group];
        if (!link) continue;
        const text = new URL(link, ORIGIN).searchParams.get("q") ?? "";
        expect(likeBytes(text), `${group} ${link}`).toBeLessThanOrEqual(50);
      }
    }
  });

  test("one group's failure does not take the page down: the other groups answer, the failed one says so", async () => {
    // a database that refuses every query on serial numbers (any module failure looks the same to the page)
    const failing = new Proxy(t.db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "all" || typeof value !== "function") return value;
        return (query: unknown) => {
          let text = "";
          try {
            text = JSON.stringify((query as { queryChunks?: unknown }).queryChunks ?? "");
          } catch {
            text = "";
          }
          if (text.includes("FROM serials AS s")) return Promise.reject(new Error("serials are unavailable"));
          return (value as (q: unknown) => unknown).call(target, query);
        };
      },
    }) as Db;
    const result = await outcome(globalSearch(failing, actorOf("manager"), { q: "SN-REV" }, "ar", TEST_NOW));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toEqual(["serials"]);
    expect(result.value.groups.serials).toEqual([]);
    expect(result.value.groups.skus).not.toBeNull();
  });
});

test("the search page says a group could not be searched — never \"nothing found\" in its place", () => {
  const results: SearchResults = {
    q: "SN-REV",
    limit: 6,
    tooShort: false,
    groups: { orders: [], customers: [], skus: [], serials: [], tickets: null },
    links: { orders: null, customers: null, skus: null, serials: null, tickets: null },
    failed: ["serials"],
  };
  const Page = SearchPage as unknown as (props: { loaderData: unknown }) => ReactNode;
  const html = render(() => createElement(Page, { loaderData: { results, title: "Global search" } }), "en", ["admin"]);
  const words = dashboardMessages.en.search;
  expect(html).toContain(words.groupFailed);
  expect(html).not.toContain("Nothing matches");
  // the groups that answered still say they found nothing
  expect(html).toContain(words.groupEmpty);
});

// ───────────────────────────────────────────────────────────────── tickets = the support inbox's own list

describe("the tickets group is the support inbox's own list for the same text", () => {
  let orderRef: string;
  beforeAll(async () => {
    const product = await make.product({ priceIqd: 90_000, stock: 5 });
    const order = await make.order([{ ...product }], { status: "shipped", placedAt: TEST_NOW - 2 * HOUR });
    orderRef = order.ref;
    await t.db.insert(supportTickets).values([
      // linked to the order, and its subject does not name it: the inbox finds it by the order's reference
      { id: "tkt_rev_order", ref: "SP-REVORD01", subject: "الطلب لم يصل بعد", orderId: order.orderId, priority: "high", status: "open", createdAt: TEST_NOW - HOUR, updatedAt: TEST_NOW - HOUR },
      // found by its e-mail address in the inbox
      { id: "tkt_rev_mail", ref: "SP-REVMAIL1", subject: "سؤال عن الضمان", email: "rana.review@example.test", priority: "normal", status: "open", createdAt: TEST_NOW - HOUR, updatedAt: TEST_NOW - HOUR },
    ]);
  });

  test("an order's reference and an e-mail address find the tickets the inbox finds, in the inbox's order", async () => {
    const support = actorOf("support");
    for (const q of [orderRef, "rana.review@example.test"]) {
      const results = await globalSearch(t.db, support, { q }, "ar", TEST_NOW);
      const link = results.links.tickets;
      expect(link, q).not.toBeNull();
      const list = await listInbox(t.db, support, parseInboxFilters(new URL(link ?? "/", ORIGIN).searchParams), TEST_NOW);
      expect(list.total, q).toBeGreaterThan(0);
      expect(results.groups.tickets?.map((hit) => hit.ref), q).toEqual(list.rows.slice(0, results.limit).map((row) => row.ref));
    }
  });
});

// ───────────────────────────────────────────────────────────────── the stock card's links

/** A component as the server renders it, with the admin-dashboard strings (English, Latin digits). */
function render(node: () => ReactNode, locale: Locale = "en", namespaces: string[] = []): string {
  const Stub = createRoutesStub([{ id: "root", path: "/", children: [{ id: "page", path: "admin", Component: () => node() }] }]);
  return renderToStaticMarkup(
    createElement(Stub, {
      initialEntries: ["/admin"],
      hydrationData: {
        loaderData: {
          root: { locale, dir: locale === "en" ? "ltr" : "rtl", fx: null, storeMode: "demo", i18n: messagesFor(locale, "common", "ui") },
          page: { i18n: messagesFor(locale, "admin-dashboard", ...namespaces) },
        },
      },
    }),
  );
}

/** Every figure of a rendered dl.dash-figures that opens a list: [href, the number shown]. */
function linkedFigures(html: string): [string, number][] {
  const out: [string, number][] = [];
  for (const chunk of html.split("<div><dt").slice(1)) {
    const href = /<a [^>]*href="([^"]+)"/.exec(chunk)?.[1];
    const figure = /<dd[^>]*>.*?<bdi[^>]*>([^<]+)<\/bdi>/.exec(chunk)?.[1];
    if (!href || figure === undefined) continue;
    out.push([href.replace(/&amp;/g, "&"), Number(figure.replace(/[^\d-]/g, ""))]);
  }
  return out;
}

/** What the list behind an inventory or orders link counts, through that module's own service. */
async function listTotal(actor: EmployeeActor, href: string): Promise<number> {
  const url = new URL(href, ORIGIN);
  const params = url.searchParams;
  switch (url.pathname) {
    case "/admin/inventory/stock":
      return (await listStock(t.db, actor, parseStockFilters(params), "en")).total;
    case "/admin/inventory/reorder":
      return (await listReorder(t.db, actor, parseReorderFilters(params), "en", TEST_NOW)).total;
    case "/admin/inventory/oversell":
      return (await listOversell(t.db, actor, "en")).levels.length;
    case "/admin/inventory/counts":
      return (await listCounts(t.db, actor, parseCountFilters(params))).total;
    case "/admin/inventory/transfers":
      return (await listTransfers(t.db, actor, parseTransferFilters(params))).total;
    case "/admin/inventory/reservations":
      return (await listReservations(t.db, actor, parseReservationFilters(params), "en", TEST_NOW)).total;
    case "/admin/orders":
      return (await listOrders(t.db, actor, parseListFilters(params), "en", TEST_NOW)).total;
    default:
      throw new Error(`no list known for ${href}`);
  }
}

describe("the stock card: a figure that opens a list is that list's number", () => {
  beforeAll(async () => {
    // a SKU with 2 left: on hand (counted by "SKUs with stock"), low, and NOT in the stock list's "in stock" (> 3)
    await make.product({ priceIqd: 50_000, stock: 2 });
    await make.product({ priceIqd: 50_000, stock: 0 });
    await make.product({ priceIqd: 50_000, stock: 40 });
    // archived products: the stock list counts them, inventory's overview (and the reorder list) does not
    for (const stock of [0, 1]) {
      const archived = await make.product({ priceIqd: 50_000, stock });
      await t.db.update(products).set({ status: "archived" }).where(eq(products.id, archived.productId));
    }
    const product = await make.product({ priceIqd: 70_000, stock: 9 });
    await make.order([{ ...product }], { status: "confirmed", placedAt: TEST_NOW - HOUR });
  });

  test("for the warehouse, the cashier and the manager: every linked figure equals its list's total", async () => {
    for (const actor of [actorOf("inventory"), actorOf("cashier"), actorOf("manager")]) {
      const card = await stockCard(t.db, actor, TEST_NOW);
      const pairs = linkedFigures(render(() => createElement(StockFigures, { data: card })));
      expect(pairs.length, actor.label ?? "").toBeGreaterThan(0);
      for (const [href, figure] of pairs) expect(figure, `${actor.label} ${href}`).toBe(await listTotal(actor, href));
    }
  });
});

// ───────────────────────────────────────────────────────────────── the money card's links

describe("the money card opens lists with the figures' own demo choice", () => {
  beforeAll(async () => {
    const product = await make.product({ priceIqd: 80_000, stock: 5 });
    const real = await make.order([{ ...product }], { status: "shipped", paymentMethod: "cod", paymentStatus: "cod_due", placedAt: TEST_NOW - HOUR });
    await make.payment(real.orderId, real.totalIqd, { method: "cod", status: "pending" });
    const demo = await make.order([{ ...product }], { status: "delivered", paymentMethod: "cod", paymentStatus: "cod_due", placedAt: TEST_NOW - HOUR, isDemo: true });
    await make.payment(demo.orderId, demo.totalIqd, { method: "cod", status: "pending" });
  });

  test("cash on delivery outstanding equals what the settlements page it opens shows — with and without demo rows", async () => {
    const finance = actorOf("finance");
    for (const demo of [false, true]) {
      const card = await moneyCard(t.db, finance, { demo });
      expect(card.links.cod).not.toBeNull();
      const range = parseRange(new URL(card.links.cod ?? "/", ORIGIN).searchParams, TEST_NOW);
      const overview = await settlementOverview(t.db, finance, range);
      expect(card.codOutstanding, `demo ${demo}`).toEqual(overview.cod.outstanding);
    }
  });
});

// ───────────────────────────────────────────────────────────────── the activity feed's approvals

describe("the activity feed lists the approvals the modules really record", () => {
  beforeAll(async () => {
    const event = (action: string, extra: Record<string, unknown>, at: number) => audit(t.db, { actor: owner, action, at, ...extra });
    // a second person's approval of a gift card is recorded as the card's issue carrying the approval
    await event("promotions.gift_card.issue", { entityType: "gift_card", entityId: "gcd_rev_approved", summary: "…AB12", after: { amountIqd: 50_000, solo: false, approvalId: "apr_rev_1" } }, TEST_NOW - 6_000);
    // a card issued alone (under the limit) is no approval
    await event("promotions.gift_card.issue", { entityType: "gift_card", entityId: "gcd_rev_solo", summary: "…CD34", after: { amountIqd: 10_000, solo: true, approvalId: null } }, TEST_NOW - 5_000);
    await event("returns.rma.refund_rejected", { entityType: "return", entityId: "ret_rev", summary: "RMA-REV00001", reason: "المبلغ لا يطابق الفاتورة" }, TEST_NOW - 4_000);
    await event("support.knowledge.revision_approve", { entityType: "knowledge_article", entityId: "kba_rev", summary: "ps5-controller-drift" }, TEST_NOW - 3_000);
    await event("support.knowledge.revision_reject", { entityType: "knowledge_article", entityId: "kba_rev", summary: "ps5-controller-drift", reason: "ينقصه مصدر" }, TEST_NOW - 2_000);
  });

  test("every listed action is one a module writes; the approval of a gift card shows, a card issued alone does not", async () => {
    expect(FEED_ACTIONS).not.toContain("promotions.gift_card.approve");
    const page = await activityFeed(t.db, owner, { kind: null, before: null }, 100);
    const lines = page.lines.map((line) => `${line.action} ${line.record.entity}`);
    expect(lines).toContain("promotions.gift_card.issue gift_card");
    expect(page.lines.filter((line) => line.action === "promotions.gift_card.issue")).toHaveLength(1);
    expect(page.lines.find((line) => line.action === "returns.rma.refund_rejected")?.record).toEqual({ entity: "return", label: "RMA-REV00001", href: "/admin/returns/RMA-REV00001" });
    expect(page.lines.filter((line) => line.action.startsWith("support.knowledge.revision_")).map((line) => line.record.label)).toEqual(["ps5-controller-drift", "ps5-controller-drift"]);
    // the approvals view has them too, for who may open their screens
    const approvals = await activityFeed(t.db, actorOf("manager"), { kind: "approval", before: null }, 100);
    expect(approvals.lines.map((line) => line.action)).toEqual(expect.arrayContaining(["promotions.gift_card.issue", "support.knowledge.revision_approve", "support.knowledge.revision_reject"]));
  });
});

describe("used-device price lines follow the pricing module's own rules for that page", () => {
  beforeAll(async () => {
    const event = (action: string, extra: Record<string, unknown>, at: number) => audit(t.db, { actor: owner, action, at, ...extra });
    await event("pricing.used.price", { entityType: "used_unit", entityId: "uu_rev_1", summary: "ps5-used-rev-1", before: { priceIqd: 400_000 }, after: { priceIqd: 380_000 }, reason: "خدش في الغطاء" }, TEST_NOW - 1_500);
    const product = await make.product({ priceIqd: 300_000 });
    await event("pricing.price.change", { entityType: "variant", entityId: product.variantId, summary: product.sku, before: { priceIqd: 300_000 }, after: { priceIqd: 290_000 } }, TEST_NOW - 1_400);
  });

  test("an employee limited to a branch does not see them (the used-device price page shows only their branch's devices)", async () => {
    const limited = actorOf("manager", { branchId: "br_rev_other" });
    const actions = (await activityFeed(t.db, limited, { kind: "price", before: null }, 100)).lines.map((line) => line.action);
    expect(actions).toContain("pricing.price.change");
    expect(actions.filter((action) => action.startsWith("pricing.used."))).toEqual([]);
  });

  test("a pricing permission that does not open the used-device page (exchange rates, price lists) does not see them", async () => {
    for (const permission of ["pricing.fx_rate.manage", "pricing.price_list.manage"] as const) {
      const reader: EmployeeActor = { kind: "employee", id: "emp_rev_fx", permissions: ["dashboard.overview.read", "dashboard.activity.read", permission], label: permission };
      const actions = (await activityFeed(t.db, reader, { kind: null, before: null }, 100)).lines.map((line) => line.action);
      expect(actions, permission).toContain("pricing.price.change");
      expect(actions.filter((action) => action.startsWith("pricing.used.")), permission).toEqual([]);
    }
    // who may open it still sees them
    const used: EmployeeActor = { kind: "employee", id: "emp_rev_used", permissions: ["dashboard.overview.read", "dashboard.activity.read", "pricing.used.update"], label: "used" };
    expect((await activityFeed(t.db, used, { kind: "price", before: null }, 100)).lines.map((line) => line.action)).toContain("pricing.used.price");
  });
});

// a guard: the groups the search runs are exactly the ones each role may open (unchanged by the review)
test("search access per role is unchanged", () => {
  expect(searchAccess(actorOf("cashier"))).toEqual({ orders: false, customers: true, skus: true, serials: true, tickets: false });
  expect(searchAccess(actorOf("content"))).toEqual({ orders: false, customers: false, skus: true, serials: false, tickets: false });
});
