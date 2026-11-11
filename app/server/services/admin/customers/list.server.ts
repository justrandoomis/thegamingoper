/**
 * Admin 07.01 / 07.06 / 07.02 — the customer list: search, saved views (VIP, risk, complaints, blocked, new, no
 * purchase), status and RFM segment filters, sort and page, all from the URL; and its CSV export.
 *
 *   await listCustomers(db, actor, parseCustomerFilters(url.searchParams), now)   customers.customer.read
 *   await exportCustomersCsv(db, actor, filters, now)                            + customers.customer.export (audited)
 *
 * Phones: the full number only with customer.phone.read_full (others "0771 ••• ••52"). Searching by part of a number
 * needs that permission too — otherwise the digits would reveal a masked number one query at a time (the orders
 * module's review found that oracle); a whole number works for everyone. Merged and erased accounts are left out
 * unless the status filter asks for them. "Spent" is what the store kept (paid − refunded): revenue, never cost.
 */
import { sql, type SQL } from "drizzle-orm";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { runBatch } from "~/server/db/tx.server";
import { customerFlags, flagCondition } from "./flags.server";
import { segmentRowId, storedSegments } from "./rfm.server";
import { num, phoneView } from "./shared.server";
import { NEW_ACCOUNT_DAYS, PAGE_SIZE, type CustomerFilters, type CustomerListPage, type CustomerListRow, type CustomerSort, type CustomerStatusKey } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_EXPORT_ROWS = 5000;

const PURCHASE = sql`o.customer_id = c.id AND o.status <> 'cancelled' AND o.paid_iqd > o.refunded_iqd`;
const PURCHASES = sql`(SELECT count(*) FROM orders AS o WHERE ${PURCHASE})`;
const SPENT = sql`(SELECT coalesce(sum(o.paid_iqd - o.refunded_iqd), 0) FROM orders AS o WHERE ${PURCHASE})`;
const LAST_ORDER = sql`(SELECT max(o.placed_at) FROM orders AS o WHERE o.customer_id = c.id)`;
const ORDERS = sql`(SELECT count(*) FROM orders AS o WHERE o.customer_id = c.id)`;

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** The WHERE of the list (and its export) for these filters, as this employee may search. */
export function customerWhere(filters: CustomerFilters, actor: Actor, now: number): SQL {
  const parts: SQL[] = [];
  parts.push(filters.status ? sql`c.status = ${filters.status}` : sql`c.status IN ('active', 'blocked')`);

  const q = filters.q;
  if (q) {
    const or: SQL[] = [];
    const e164 = normalizeIraqPhone(q);
    if (e164) or.push(sql`c.phone_e164 = ${e164}`);
    const digits = q.replace(/[^\d]/g, "");
    if (!e164 && digits.length >= 4 && digits.length === q.replace(/[\s+-]/g, "").length && can(actor, "customer.phone.read_full")) {
      or.push(sql`c.phone_e164 LIKE ${`%${escapeLike(digits)}%`} ESCAPE '\\'`);
    }
    const ref = q.trim().toUpperCase();
    if (/^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(ref)) {
      or.push(sql`EXISTS (SELECT 1 FROM orders AS o WHERE o.customer_id = c.id AND o.ref = ${ref})`);
      or.push(sql`EXISTS (SELECT 1 FROM returns AS r WHERE r.customer_id = c.id AND r.rma = ${ref})`);
    }
    if (/^[A-Za-z0-9_]{6,64}$/.test(q)) or.push(sql`c.id = ${q}`);
    if (!/^[\d\s+-]+$/.test(q)) {
      const pattern = `%${escapeLike(q.toLowerCase())}%`;
      or.push(sql`lower(coalesce(c.name, '')) LIKE ${pattern} ESCAPE '\\'`);
      or.push(sql`lower(coalesce(c.email, '')) LIKE ${pattern} ESCAPE '\\'`);
    }
    parts.push(or.length ? sql`(${sql.join(or, sql` OR `)})` : sql`0`);
  }

  switch (filters.view) {
    case "vip":
    case "risk":
    case "complaints": {
      const condition = flagCondition(filters.view, now);
      if (condition) parts.push(condition);
      break;
    }
    case "blocked":
      parts.push(sql`c.status = 'blocked'`);
      break;
    case "new":
      parts.push(sql`c.created_at >= ${now - NEW_ACCOUNT_DAYS * DAY_MS}`);
      break;
    case "no_purchase":
      parts.push(sql`NOT EXISTS (SELECT 1 FROM orders AS o WHERE ${PURCHASE})`);
      break;
    default:
      break;
  }
  if (filters.segment) {
    parts.push(sql`EXISTS (SELECT 1 FROM customer_segment_members AS m WHERE m.customer_id = c.id AND m.segment_id = ${segmentRowId(filters.segment)})`);
  }
  return sql.join(parts, sql` AND `);
}

const ORDER_BY: Record<CustomerSort, SQL> = {
  joined: sql`c.created_at DESC, c.id DESC`,
  last_order: sql`last_order_at IS NULL, last_order_at DESC, c.id DESC`,
  spent: sql`spent DESC, c.id DESC`,
  purchases: sql`purchases DESC, c.id DESC`,
  name: sql`c.name IS NULL, c.name COLLATE NOCASE ASC, c.id ASC`,
};

type Row = { id: string; name: string | null; phone_e164: string; email: string | null; status: CustomerStatusKey; created_at: number; is_demo: number; purchases: number; orders: number; spent: number; last_order_at: number | null };

async function selectRows(db: Db, where: SQL, sort: CustomerSort, limit: number, offset: number): Promise<Row[]> {
  return db.all<Row>(sql`
    SELECT c.id, c.name, c.phone_e164, c.email, c.status, c.created_at, c.is_demo,
      ${PURCHASES} AS purchases, ${ORDERS} AS orders, ${SPENT} AS spent, ${LAST_ORDER} AS last_order_at
    FROM customers AS c
    WHERE ${where}
    ORDER BY ${ORDER_BY[sort]}
    LIMIT ${limit} OFFSET ${offset}`);
}

/** One page of the customer list (07.01) with each row's labels (07.06) and stored segment (07.02). */
export async function listCustomers(db: Db, actor: Actor, filters: CustomerFilters, now: number): Promise<CustomerListPage> {
  assertCan(actor, "customers.customer.read");
  const where = customerWhere(filters, actor, now);
  const [countRow] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM customers AS c WHERE ${where}`);
  const total = num(countRow?.n);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await selectRows(db, where, filters.sort, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const ids = rows.map((row) => row.id);
  const [flags, segments, computed] = await Promise.all([
    customerFlags(db, ids, now),
    storedSegments(db, ids),
    db.all<{ at: number | null }>(sql`SELECT max(computed_at) AS at FROM customer_segments WHERE key LIKE 'rfm.%'`),
  ]);
  const fullPhone = can(actor, "customer.phone.read_full");
  return {
    rows: rows.map((row): CustomerListRow => ({
      id: row.id,
      name: row.name,
      phone: phoneView(row.phone_e164, fullPhone),
      email: row.email,
      status: row.status,
      createdAt: num(row.created_at),
      purchases: num(row.purchases),
      orders: num(row.orders),
      spentIqd: num(row.spent),
      lastOrderAt: row.last_order_at === null ? null : num(row.last_order_at),
      segment: segments.get(row.id)?.segment ?? null,
      flags: flags.get(row.id) ?? [],
      isDemo: num(row.is_demo) === 1,
    })),
    total,
    page,
    pageCount,
    segmentsComputedAt: computed[0]?.at === null || computed[0]?.at === undefined ? null : num(computed[0].at),
  };
}

/** How many customers each label view holds right now (the module page's cards). */
export async function customerQueues(db: Db, actor: Actor, now: number): Promise<{ vip: number; risk: number; complaints: number; blocked: number }> {
  assertCan(actor, "customers.customer.read");
  const count = async (view: "vip" | "risk" | "complaints" | "blocked") => {
    const where = customerWhere({ q: "", view, status: null, segment: null, sort: "joined", page: 1 }, actor, now);
    const [row] = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM customers AS c WHERE ${where}`);
    return num(row?.n);
  };
  const [vip, risk, complaints, blocked] = await Promise.all([count("vip"), count("risk"), count("complaints"), count("blocked")]);
  return { vip, risk, complaints, blocked };
}

export type CustomerExport = { header: string[]; rows: (string | number | null)[][]; truncated: boolean };

/**
 * The list as rows for a CSV (same filters and order), at most MAX_EXPORT_ROWS. Needs customers.customer.read AND
 * customers.customer.export; phones as the employee may see them; audited with the filters and the row count.
 */
export async function exportCustomersCsv(db: Db, actor: Actor, filters: CustomerFilters, now: number, labels: { header: string[]; status: (status: CustomerStatusKey) => string; segment: (key: string | null) => string; flag: (id: string) => string }): Promise<CustomerExport> {
  assertCan(actor, "customers.customer.read");
  assertCan(actor, "customers.customer.export");
  const where = customerWhere(filters, actor, now);
  const rows = await selectRows(db, where, filters.sort, MAX_EXPORT_ROWS + 1, 0);
  const truncated = rows.length > MAX_EXPORT_ROWS;
  const kept = rows.slice(0, MAX_EXPORT_ROWS);
  const ids = kept.map((row) => row.id);
  const [flags, segments] = await Promise.all([customerFlags(db, ids, now), storedSegments(db, ids)]);
  const fullPhone = can(actor, "customer.phone.read_full");
  await runBatch(db, [
    auditStatement(db, {
      actor,
      action: "customers.customer.export",
      entityType: "customer",
      entityId: "list",
      after: { filters: { ...filters, page: undefined }, rows: kept.length, truncated, fullPhones: fullPhone },
      at: now,
    }),
  ]);
  return {
    header: labels.header,
    truncated,
    rows: kept.map((row) => [
      row.id,
      row.name,
      phoneView(row.phone_e164, fullPhone)?.display ?? null,
      row.email,
      labels.status(row.status),
      new Date(num(row.created_at) + 3 * 60 * 60 * 1000).toISOString().slice(0, 10),
      num(row.orders),
      num(row.purchases),
      num(row.spent),
      row.last_order_at === null ? null : new Date(num(row.last_order_at) + 3 * 60 * 60 * 1000).toISOString().slice(0, 10),
      labels.segment(segments.get(row.id)?.segment ?? null),
      (flags.get(row.id) ?? []).map((flag) => labels.flag(flag.id)).join(" · ") || null,
      num(row.is_demo),
    ]),
  };
}
