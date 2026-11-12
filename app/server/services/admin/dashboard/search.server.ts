/**
 * Admin 01.06 — global search: orders, customers, SKUs, serial numbers and tickets in one query box, with quick
 * actions (links to the screen where the action happens). The search page (/admin/dashboard/search?q=) and — once the
 * shell wires it — the Ctrl/⌘ K palette both call `globalSearch`.
 *
 * Every group answers only for holders of the permission its module's own list needs, and with that module's field
 * rules; a group the employee may not search is null (not an empty list):
 *
 *   orders     orders.order.read              the orders list's own WHERE (listWhere: reference, whole phone number,
 *                                             name; part of a number only with customer.phone.read_full); phones
 *                                             masked without customer.phone.read_full
 *   customers  customers.customer.read        the customers list's own WHERE (customerWhere: name, e-mail, whole number,
 *                                             an order or RMA reference; digits only with customer.phone.read_full;
 *                                             merged and erased accounts left out); phones masked the same way
 *   skus       catalog.product.read, inventory.stock.read or a pricing permission: SKU (exact, then its start),
 *                                             barcode, product name; the selling price (public); what is available only
 *                                             with inventory.stock.read; never a cost
 *   serials    inventory.serial.read + inventory.stock.read (the inventory serial pages) or devices.registry.read (the
 *                                             device registry): the serial (exact, or its start from 4 characters),
 *                                             status, SKU; never a unit's cost
 *   tickets    support.ticket.read            the support inbox's own list (listInbox, view "all", newest first): a ticket
 *                                             or repair reference, an order or return reference, a whole phone number
 *                                             (digits only with read_full), subject / issue, contact name, e-mail
 *
 * No file, proof, cost, margin or full phone number is ever selected for a role that may not see it. Every group runs
 * side by side, and a group that fails is reported as failed (`failed`, logged) while the others answer — never a 500,
 * never "nothing found" in its place.
 *
 * D1 refuses a LIKE pattern over 50 BYTES ("LIKE or GLOB pattern too complex"): an Arabic letter is two bytes, "…", "’"
 * or an Arabic presentation form (text pasted from a PDF) three, an emoji four. Every text that ends up in a LIKE —
 * here, in a module's WHERE this search calls, and in a "see all" link's list — is `likeNeedle(q)`: the longest start
 * of what was typed that fits once escaped. Exact matches (a reference, a whole phone number, a SKU, a barcode, a
 * serial) use the whole text.
 */
import { desc, sql, type SQL } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { orders } from "~/server/db/schema";
import type { Permission } from "~/server/permissions";
import { customerWhere } from "~/server/services/admin/customers/list.server";
import { phoneView } from "~/server/services/admin/customers/shared.server";
import { parseCustomerFilters } from "~/server/services/admin/customers/types";
import { listWhere as orderListWhere } from "~/server/services/admin/orders/list.server";
import { phoneFor } from "~/server/services/admin/orders/shared.server";
import { PACKABLE_STATUSES, parseListFilters } from "~/server/services/admin/orders/types";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { inboxSearch, parseInboxFilters, type InboxFilters } from "~/server/services/admin/support/types";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { cleanQuery, SEARCH_GROUPS, SEARCH_LIMIT, SEARCH_MIN_LENGTH, type CustomerHit, type OrderHit, type QuickAction, type SearchGroup, type SearchResults, type SerialHit, type SkuHit, type TicketHit } from "./types";

/** Every pricing permission opens the SKU price pages (pricing's SKU_READERS). */
const PRICING_READERS: readonly Permission[] = [
  "pricing.price.update",
  "pricing.price.approve",
  "pricing.cost.update",
  "pricing.margin.manage",
  "pricing.simulation.run",
  "pricing.suggestion.read",
  "pricing.price_list.manage",
  "pricing.discount.override",
  "pricing.used.update",
  "pricing.fx_rate.manage",
];

export type SearchAccess = { orders: boolean; customers: boolean; skus: boolean; serials: boolean; tickets: boolean };

export function searchAccess(actor: Actor): SearchAccess {
  return {
    orders: can(actor, "orders.order.read"),
    customers: can(actor, "customers.customer.read"),
    skus: can(actor, "catalog.product.read") || can(actor, "inventory.stock.read") || canAny(actor, PRICING_READERS),
    serials: (can(actor, "inventory.serial.read") && can(actor, "inventory.stock.read")) || can(actor, "devices.registry.read"),
    tickets: can(actor, "support.ticket.read"),
  };
}

/** Characters of a free-text needle (the orders list cuts its own at 20 too). */
const NEEDLE = 20;
/** D1's limit on a LIKE pattern (SQLITE_LIMIT_LIKE_PATTERN_LENGTH), in UTF-8 bytes. */
export const LIKE_MAX_BYTES = 50;
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);
const num = (value: unknown) => Number(value ?? 0);
const enc = encodeURIComponent;
const utf8 = new TextEncoder();
const bytesOf = (text: string) => utf8.encode(text).length;

/**
 * The longest start of `text` — at most `maxUnits` UTF-16 units — whose LIKE pattern fits D1's limit once escaped and
 * given `wildcards` "%". A character counts at its widest as typed, upper- or lower-cased (the modules' WHEREs compare
 * either), so neither this search nor a module's WHERE or list it is handed to can be refused.
 *
 *   likeNeedle("ﻻ".repeat(25))         // 16 characters: 16 × 3 bytes + "%…%" = 50
 *   likeNeedle("TT-7Q2M9K", 20, 2)     // "TT-7Q2M9K" (short text is kept whole)
 */
export function likeNeedle(text: string, maxUnits: number = NEEDLE, wildcards = 2): string {
  let out = "";
  let used = wildcards;
  for (const ch of text) {
    const size = Math.max(bytesOf(escapeLike(ch)), bytesOf(escapeLike(ch.toUpperCase())), bytesOf(escapeLike(ch.toLowerCase())));
    if (out.length + ch.length > maxUnits || used + size > LIKE_MAX_BYTES) break;
    out += ch;
    used += size;
  }
  return out.trimEnd();
}

async function searchOrders(db: Db, actor: Actor, q: string, needle: string, limit: number, now: number): Promise<OrderHit[]> {
  // the orders list's own WHERE, handed a text its LIKE can run (a reference or a whole number is short: kept whole)
  const where = orderListWhere({ ...parseListFilters(new URLSearchParams()), q: needle }, actor, now);
  const exact = q.toUpperCase();
  const rows = await db
    .select({
      ref: orders.ref,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      totalIqd: orders.totalIqd,
      placedAt: orders.placedAt,
      contactName: orders.contactName,
      phone: orders.contactPhoneE164,
      customerId: orders.customerId,
      channel: orders.channel,
      isDemo: orders.isDemo,
    })
    .from(orders)
    .where(where)
    .orderBy(sql`CASE WHEN ${orders.ref} = ${exact} THEN 0 ELSE 1 END`, desc(orders.placedAt))
    .limit(limit);
  const packs = can(actor, "orders.fulfillment.pack");
  return rows.map((row) => {
    const actions: QuickAction[] = [{ key: "open", href: `/admin/orders/${enc(row.ref)}` }];
    if (packs && (PACKABLE_STATUSES as readonly string[]).includes(row.status)) actions.push({ key: "pack", href: `/admin/orders/${enc(row.ref)}/pack` });
    const profile = customerProfileId(actor, row.customerId);
    if (profile) actions.push({ key: "customer", href: `/admin/customers/${enc(profile)}` });
    const phone = phoneFor(actor, row.phone);
    return {
      ref: row.ref,
      status: row.status,
      paymentStatus: row.paymentStatus,
      totalIqd: row.totalIqd,
      placedAt: row.placedAt,
      contactName: row.contactName,
      phone: phone ? { display: phone.display, full: phone.full } : null,
      channel: row.channel,
      isDemo: row.isDemo,
      actions,
    };
  });
}

async function searchCustomers(db: Db, actor: Actor, needle: string, limit: number, now: number): Promise<CustomerHit[]> {
  const where = customerWhere(parseCustomerFilters(new URLSearchParams({ q: needle })), actor, now);
  const rows = await db.all<{ id: string; name: string | null; phone: string | null; status: string; isDemo: number }>(sql`
    SELECT c.id AS id, c.name AS name, c.phone_e164 AS phone, c.status AS status, c.is_demo AS isDemo
    FROM customers AS c WHERE ${where}
    ORDER BY c.created_at DESC, c.id LIMIT ${limit}`);
  const full = can(actor, "customer.phone.read_full");
  const wallets = can(actor, "finance.wallet.read");
  return rows.map((row) => {
    const actions: QuickAction[] = [{ key: "profile", href: `/admin/customers/${enc(row.id)}` }];
    if (wallets) actions.push({ key: "wallet", href: `/admin/finance/wallets/${enc(row.id)}` });
    const phone = phoneView(row.phone, full);
    return { id: row.id, name: row.name, phone: phone ? { display: phone.display, full: phone.full } : null, status: row.status, isDemo: Boolean(row.isDemo), actions };
  });
}

async function searchSkus(db: Db, actor: Actor, q: string, needle: string, limit: number, locale: Locale): Promise<SkuHit[]> {
  const upper = q.toUpperCase();
  const like = escapeLike(needle);
  const start = `${escapeLike(needle.toUpperCase())}%`;
  const named = needle.length >= 3 && /\p{L}/u.test(needle);
  const conditions: SQL[] = [sql`upper(v.sku) = ${upper}`, sql`v.barcode = ${q}`, sql`upper(v.sku) LIKE ${start} ESCAPE '\\'`];
  if (named) {
    conditions.push(sql`json_extract(p.name, '$.ar') LIKE ${`%${like}%`} ESCAPE '\\'`);
    conditions.push(sql`lower(json_extract(p.name, '$.en')) LIKE ${`%${like.toLowerCase()}%`} ESCAPE '\\'`);
  }
  const rows = await db.all<{ id: string; sku: string; title: string | null; priceIqd: number; isActive: number; productId: string; name: string; productStatus: string }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.title AS title, v.price_iqd AS priceIqd, v.is_active AS isActive, p.id AS productId, p.name AS name, p.status AS productStatus
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    WHERE ${sql.join(conditions, sql` OR `)}
    ORDER BY CASE WHEN upper(v.sku) = ${upper} OR v.barcode = ${q} THEN 0 WHEN upper(v.sku) LIKE ${start} ESCAPE '\\' THEN 1 ELSE 2 END,
             CASE WHEN p.status = 'archived' THEN 1 ELSE 0 END, v.sku
    LIMIT ${limit}`);
  const stock = can(actor, "inventory.stock.read");
  const availability = stock ? await getAvailability(db, rows.map((row) => row.id)) : null;
  const catalog = can(actor, "catalog.product.read");
  const pricing = canAny(actor, PRICING_READERS);
  return rows.map((row) => {
    const actions: QuickAction[] = [];
    if (catalog) actions.push({ key: "product", href: `/admin/catalog/products/${enc(row.productId)}` });
    if (stock) actions.push({ key: "stock", href: `/admin/inventory/stock/${enc(row.id)}` });
    if (pricing) actions.push({ key: "pricing", href: `/admin/pricing/skus/${enc(row.id)}` });
    const name = parseName(row.name, locale);
    const title = parseName(row.title, locale);
    return {
      variantId: row.id,
      sku: row.sku,
      name,
      title: title || null,
      productStatus: row.productStatus,
      isActive: Boolean(row.isActive),
      priceIqd: num(row.priceIqd),
      available: availability ? (availability.get(row.id)?.available ?? 0) : null,
      actions,
    };
  });
}

function parseName(value: unknown, locale: Locale): string {
  if (!value) return "";
  if (typeof value === "object") return pick(value as Parameters<typeof pick>[0], locale);
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return parsed && typeof parsed === "object" ? pick(parsed as Parameters<typeof pick>[0], locale) : String(value);
  } catch {
    return String(value);
  }
}

async function searchSerials(db: Db, actor: Actor, q: string, limit: number, locale: Locale): Promise<SerialHit[]> {
  const upper = q.toUpperCase();
  // the start of a serial: up to 40 characters, one "%" — 40 Arabic letters would be 81 bytes, so the needle is cut
  const start = likeNeedle(q, 40, 1);
  const prefix = start.length >= 4 ? sql` OR upper(s.serial) LIKE ${`${escapeLike(start.toUpperCase())}%`} ESCAPE '\\'` : sql``;
  const rows = await db.all<{ id: string; serial: string; status: string; sku: string; name: string }>(sql`
    SELECT s.id AS id, s.serial AS serial, s.status AS status, v.sku AS sku, p.name AS name
    FROM serials AS s JOIN variants AS v ON v.id = s.variant_id JOIN products AS p ON p.id = v.product_id
    WHERE upper(s.serial) = ${upper}${prefix}
    ORDER BY CASE WHEN upper(s.serial) = ${upper} THEN 0 ELSE 1 END, s.serial
    LIMIT ${limit}`);
  const inventory = can(actor, "inventory.serial.read") && can(actor, "inventory.stock.read");
  const registry = can(actor, "devices.registry.read");
  return rows.map((row) => {
    const actions: QuickAction[] = [];
    if (inventory) actions.push({ key: "serial", href: `/admin/inventory/serials/${enc(row.id)}` });
    if (registry) actions.push({ key: "registry", href: `/admin/devices/registry/${enc(row.id)}` });
    return { id: row.id, serial: row.serial, status: row.status, sku: row.sku, name: parseName(row.name, locale), actions };
  });
}

/** Why a group failed, without a query's bound values (Drizzle writes them after "params:"). */
function reasonOf(error: unknown): string {
  const failure = error as { cause?: { message?: unknown }; message?: unknown } | null;
  const text = String(failure?.cause?.message ?? failure?.message ?? error);
  return text.replace(/\bparams:[\s\S]*$/, "params: [withheld]").slice(0, 300);
}

/** The support inbox's own filters for a search: every ticket and repair, newest first — what "see all" opens. */
function ticketFilters(needle: string): InboxFilters {
  return parseInboxFilters(new URLSearchParams({ view: "all", q: needle, sort: "created" }));
}

/**
 * Tickets and repairs through the support inbox's own list (listInbox): its matching (references of tickets, repairs,
 * orders and returns, whole numbers, digits only with customer.phone.read_full, subject, contact, e-mail) and its
 * order, so the group shows the first rows of the list its "see all" opens.
 */
async function searchTickets(db: Db, actor: Actor, filters: InboxFilters, limit: number, now: number): Promise<TicketHit[]> {
  const page = await listInbox(db, actor, filters, now);
  return page.rows.slice(0, limit).map((row) => ({
    kind: row.kind,
    ref: row.ref,
    title: row.title,
    status: row.status,
    priority: row.kind === "ticket" ? row.priority : null,
    isDemo: row.isDemo,
    actions: [{ key: row.kind === "repair" ? "repair" : "open", href: row.kind === "repair" ? `/admin/support/repairs/${enc(row.ref)}` : `/admin/support/tickets/${enc(row.ref)}` }],
  }));
}

/**
 * The search (dashboard.search.use). `limit` rows per group (1–10). Nothing typed: every group the employee has is
 * an empty list; too short to search (under SEARCH_MIN_LENGTH): the same, with `tooShort`. A group whose module
 * failed is an empty list named in `failed` (the page says it could not be searched), the others stand.
 */
export async function globalSearch(db: Db, actor: Actor, raw: { q: unknown; limit?: number }, locale: Locale, now: number): Promise<SearchResults> {
  assertCan(actor, "dashboard.search.use");
  const q = cleanQuery(raw.q);
  const limit = Math.min(Math.max(Math.trunc(raw.limit ?? SEARCH_LIMIT), 1), 10);
  const access = searchAccess(actor);
  const none = <T>(allowed: boolean): T[] | null => (allowed ? [] : null);
  if (q.length < SEARCH_MIN_LENGTH) {
    return {
      q,
      limit,
      tooShort: q.length > 0,
      groups: { orders: none(access.orders), customers: none(access.customers), skus: none(access.skus), serials: none(access.serials), tickets: none(access.tickets) },
      links: { orders: null, customers: null, skus: null, serials: null, tickets: null },
      failed: [],
    };
  }
  const needle = likeNeedle(q);
  const tickets = ticketFilters(needle);
  const failed: SearchGroup[] = [];
  const run = <T>(group: SearchGroup, allowed: boolean, search: () => Promise<T[]>): Promise<T[] | null> =>
    allowed
      ? search().catch((error: unknown) => {
          // the reason only: a failed query's bound values are what was typed (a phone number, a name)
          console.error(`[dashboard] the ${group} search failed: ${reasonOf(error)}`);
          failed.push(group);
          return [] as T[];
        })
      : Promise.resolve(null);
  const [orderHits, customerHits, skuHits, serialHits, ticketHits] = await Promise.all([
    run("orders", access.orders, () => searchOrders(db, actor, q, needle, limit, now)),
    run("customers", access.customers, () => searchCustomers(db, actor, needle, limit, now)),
    run("skus", access.skus, () => searchSkus(db, actor, q, needle, limit, locale)),
    run("serials", access.serials, () => searchSerials(db, actor, q, limit, locale)),
    run("tickets", access.tickets, () => searchTickets(db, actor, tickets, limit, now)),
  ]);
  return {
    q,
    limit,
    tooShort: false,
    groups: { orders: orderHits, customers: customerHits, skus: skuHits, serials: serialHits, tickets: ticketHits },
    links: listLinks(actor, access, needle, tickets),
    failed: SEARCH_GROUPS.filter((group) => failed.includes(group)),
  };
}

/**
 * Each group's own list, searched with the text this search used (the needle: a list's own LIKE can run it) — the
 * one this employee may open. Tickets open the inbox with the very filters the group was read with.
 */
function listLinks(actor: Actor, access: SearchAccess, needle: string, tickets: InboxFilters): SearchResults["links"] {
  const query = `q=${enc(needle)}`;
  let skus: string | null = null;
  if (can(actor, "inventory.stock.read")) skus = `/admin/inventory/stock?${query}`;
  else if (can(actor, "catalog.product.read")) skus = `/admin/catalog?${query}`;
  else if (canAny(actor, PRICING_READERS)) skus = `/admin/pricing/skus?${query}`;
  let serials: string | null = null;
  if (can(actor, "inventory.serial.read") && can(actor, "inventory.stock.read")) serials = `/admin/inventory/serials?${query}`;
  else if (can(actor, "devices.registry.read")) serials = `/admin/devices/registry?${query}`;
  return {
    orders: access.orders ? `/admin/orders?${query}` : null,
    customers: access.customers ? `/admin/customers?${query}` : null,
    skus: access.skus ? skus : null,
    serials: access.serials ? serials : null,
    tickets: access.tickets ? `/admin/support${inboxSearch(tickets)}` : null,
  };
}

/** How many groups this employee searches (the page says which ones it looked in). */
export const searchedGroups = (results: SearchResults): number => Object.values(results.groups).filter((group) => group !== null).length;
