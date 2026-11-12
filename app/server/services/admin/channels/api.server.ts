/**
 * 21.03 The read-only API — `GET /api/v1/{products|stock|orders}` with a scoped key (apikeys.server.ts). Documented
 * for staff on /admin/channels/api/docs (types.ts API_ENDPOINTS is the one list both use).
 *
 *   handleApiRequest(db, request, { ip, requestId, now }, resource): Response
 *
 * Rules, in order:
 *   1. GET or HEAD only (405 otherwise) — the API never changes anything.
 *   2. A key in the address (?key=, ?api_key=, ?access_token=) is refused (400): addresses end up in logs.
 *   3. Per network (API_IP_RATE a minute) before any key is looked at (429 with Retry-After).
 *   4. "Authorization: Bearer ttk_…" — malformed, unknown, revoked or expired all get the same 401.
 *   5. The endpoint's scope must be one of the key's scopes (403 names the scope).
 *   6. The key's own limit a minute (429).
 *   7. The answer: JSON, `no-store`, never cost or profit, never a customer's name, phone or address; demo rows say so.
 *   8. Every answered call (200, 400, 403, 404) is an audit event `channels.api.call` by the key (actor "api_key:<id>"),
 *      with the endpoint, the status and the number of rows — never the key.
 *
 * Stock is a number here (inventory.stock.read is a staff permission); on the storefront it never is.
 * Must not import "cloudflare:workers".
 */
import { and, asc, eq, gt, gte, inArray, or, sql } from "drizzle-orm";
import { systemActor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { orderItems, orders, products, variants } from "~/server/db/schema";
import { limitKey, rateLimit } from "~/server/ratelimit.server";
import { getAvailability, stockStateOf } from "~/server/services/inventory/stock.server";
import { verifyApiKey, type VerifiedKey } from "./apikeys.server";
import { API_ENDPOINTS, API_IP_RATE, API_PAGE_DEFAULT, API_PAGE_MAX, type ApiEndpoint } from "./types";

export type ApiRequestContext = { ip: string | null; requestId: string | null; now: number };

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}, head = false): Response {
  return new Response(head ? null : JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

type Page<T> = { data: T[]; next: string | null };
class BadRequest extends Error {
  constructor(readonly fields: Record<string, string>) {
    super("invalid");
  }
}

function limitOf(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null || raw === "") return API_PAGE_DEFAULT;
  if (!/^\d{1,3}$/.test(raw)) throw new BadRequest({ limit: "invalid" });
  const value = Number(raw);
  if (value < 1 || value > API_PAGE_MAX) throw new BadRequest({ limit: "invalid" });
  return value;
}

function cursorOf(params: URLSearchParams): string | null {
  const raw = params.get("cursor");
  if (raw === null || raw === "") return null;
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(raw)) throw new BadRequest({ cursor: "invalid" });
  return raw;
}

// ───────────────────────────────────────────────────────────────── endpoints

async function productsPage(db: Db, params: URLSearchParams): Promise<Page<Record<string, unknown>>> {
  const limit = limitOf(params);
  const cursor = cursorOf(params);
  const rows = await db
    .select({
      variantId: variants.id,
      sku: variants.sku,
      title: variants.title,
      priceIqd: variants.priceIqd,
      productId: products.id,
      slug: products.slug,
      name: products.name,
      kind: products.kind,
      isDemo: products.isDemo,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(products.status, "published"), eq(variants.isActive, true), cursor ? gt(variants.id, cursor) : undefined))
    .orderBy(asc(variants.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const availability = await getAvailability(
    db,
    page.map((row) => row.variantId),
  );
  return {
    data: page.map((row) => ({
      sku: row.sku,
      variantId: row.variantId,
      productId: row.productId,
      slug: row.slug,
      kind: row.kind,
      name: row.name,
      variantTitle: row.title ?? null,
      priceIqd: row.priceIqd,
      currency: "IQD",
      stockState: availability.get(row.variantId)?.state ?? stockStateOf(0),
      demo: Boolean(row.isDemo),
    })),
    next: rows.length > limit ? (page[page.length - 1]?.variantId ?? null) : null,
  };
}

async function stockPage(db: Db, params: URLSearchParams): Promise<Page<Record<string, unknown>>> {
  const limit = limitOf(params);
  const cursor = cursorOf(params);
  const skuParam = params.get("sku");
  const skus = skuParam
    ? [
        ...new Set(
          skuParam
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  if (skus.length > API_PAGE_MAX || skus.some((sku) => sku.length > 64)) throw new BadRequest({ sku: "invalid" });
  const rows = await db
    .select({ variantId: variants.id, sku: variants.sku, isDemo: products.isDemo })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(variants.isActive, true), skus.length ? inArray(variants.sku, skus) : undefined, cursor ? gt(variants.id, cursor) : undefined))
    .orderBy(asc(variants.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const availability = await getAvailability(
    db,
    page.map((row) => row.variantId),
  );
  return {
    data: page.map((row) => {
      const found = availability.get(row.variantId);
      return { sku: row.sku, variantId: row.variantId, available: found?.available ?? 0, stockState: found?.state ?? stockStateOf(0), demo: Boolean(row.isDemo) };
    }),
    next: rows.length > limit ? (page[page.length - 1]?.variantId ?? null) : null,
  };
}

async function ordersPage(db: Db, params: URLSearchParams): Promise<Page<Record<string, unknown>>> {
  const limit = limitOf(params);
  const cursor = cursorOf(params);
  const sinceRaw = params.get("since");
  let since = 0;
  if (sinceRaw !== null && sinceRaw !== "") {
    if (!/^\d{1,15}$/.test(sinceRaw)) throw new BadRequest({ since: "invalid" });
    since = Number(sinceRaw);
  }
  // keyset: updated_at, then id — "<updatedAt>.<id>"
  let after: { at: number; id: string } | null = null;
  if (cursor) {
    const dot = cursor.indexOf(".");
    const at = Number(cursor.slice(0, dot));
    const id = cursor.slice(dot + 1);
    if (dot < 1 || !Number.isSafeInteger(at) || !id) throw new BadRequest({ cursor: "invalid" });
    after = { at, id };
  }
  const rows = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      channel: orders.channel,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      subtotalIqd: orders.subtotalIqd,
      discountIqd: orders.discountIqd,
      shippingIqd: orders.shippingIqd,
      taxIqd: orders.taxIqd,
      totalIqd: orders.totalIqd,
      paidIqd: orders.paidIqd,
      refundedIqd: orders.refundedIqd,
      placedAt: orders.placedAt,
      updatedAt: orders.updatedAt,
      isDemo: orders.isDemo,
    })
    .from(orders)
    .where(and(gte(orders.updatedAt, since), after ? or(gt(orders.updatedAt, after.at), and(eq(orders.updatedAt, after.at), gt(orders.id, after.id))) : undefined))
    .orderBy(asc(orders.updatedAt), asc(orders.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const lines = page.length
    ? await db
        .select({ orderId: orderItems.orderId, sku: orderItems.sku, qty: orderItems.qty, unitPriceIqd: orderItems.unitPriceIqd, discountIqd: orderItems.discountIqd, totalIqd: orderItems.totalIqd })
        .from(orderItems)
        .where(
          inArray(
            orderItems.orderId,
            page.map((row) => row.id),
          ),
        )
    : [];
  const linesBy = new Map<string, Record<string, unknown>[]>();
  for (const line of lines) {
    const list = linesBy.get(line.orderId) ?? [];
    list.push({ sku: line.sku, qty: line.qty, unitPriceIqd: line.unitPriceIqd, discountIqd: line.discountIqd, totalIqd: line.totalIqd });
    linesBy.set(line.orderId, list);
  }
  const last = page[page.length - 1];
  return {
    data: page.map((row) => ({
      ref: row.ref,
      channel: row.channel,
      status: row.status,
      paymentStatus: row.paymentStatus,
      currency: "IQD",
      subtotalIqd: row.subtotalIqd,
      discountIqd: row.discountIqd,
      shippingIqd: row.shippingIqd,
      taxIqd: row.taxIqd,
      totalIqd: row.totalIqd,
      paidIqd: row.paidIqd,
      refundedIqd: row.refundedIqd,
      placedAt: row.placedAt,
      updatedAt: row.updatedAt,
      demo: Boolean(row.isDemo),
      lines: linesBy.get(row.id) ?? [],
    })),
    next: rows.length > limit && last ? `${last.updatedAt}.${last.id}` : null,
  };
}

const HANDLERS: Record<ApiEndpoint["resource"], (db: Db, params: URLSearchParams) => Promise<Page<Record<string, unknown>>>> = {
  products: productsPage,
  stock: stockPage,
  orders: ordersPage,
};

// ───────────────────────────────────────────────────────────────── the request

const KEY_PARAMS = ["key", "api_key", "apikey", "access_token", "token"];

async function record(db: Db, key: VerifiedKey, ctx: ApiRequestContext, endpoint: string, status: number, rows: number | null): Promise<void> {
  await audit(db, {
    actor: systemActor(`api_key:${key.id}`),
    actorLabel: `${key.name} (${key.prefix})`,
    action: "channels.api.call",
    entityType: "api_key",
    entityId: key.id,
    after: { endpoint, status, rows },
    at: ctx.now,
    ip: ctx.ip,
    requestId: ctx.requestId,
  });
}

export async function handleApiRequest(db: Db, request: Request, ctx: ApiRequestContext, resource: string): Promise<Response> {
  const method = request.method.toUpperCase();
  const head = method === "HEAD";
  if (method !== "GET" && !head) return json(405, { error: "method_not_allowed" }, { Allow: "GET, HEAD" });
  const url = new URL(request.url);
  if (KEY_PARAMS.some((name) => url.searchParams.has(name))) return json(400, { error: "key_in_url" }, {}, head);

  const network = await rateLimit(db, await limitKey("api", "ip", ctx.ip), { limit: API_IP_RATE, windowSec: 60 }, ctx.now);
  if (!network.ok) return json(429, { error: "rate_limited" }, { "Retry-After": String(network.retryAfterSec) }, head);

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const key = match ? await verifyApiKey(db, match[1], ctx.now) : null;
  if (!key) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="tamtam"' }, head);

  const endpoint = API_ENDPOINTS.find((entry) => entry.resource === resource);
  if (!endpoint) {
    await record(db, key, ctx, `/api/v1/${resource.slice(0, 40)}`, 404, null);
    return json(404, { error: "not_found" }, {}, head);
  }
  if (!key.scopes.has(endpoint.scope)) {
    await record(db, key, ctx, endpoint.path, 403, null);
    return json(403, { error: "forbidden", scope: endpoint.scope }, {}, head);
  }
  const own = await rateLimit(db, await limitKey("api", "key", key.id), { limit: key.rateLimitPerMin, windowSec: 60 }, ctx.now);
  if (!own.ok) return json(429, { error: "rate_limited" }, { "Retry-After": String(own.retryAfterSec) }, head);

  try {
    const page = await HANDLERS[endpoint.resource](db, url.searchParams);
    await record(db, key, ctx, endpoint.path, 200, page.data.length);
    return json(200, page, { "X-RateLimit-Limit": String(key.rateLimitPerMin), "X-RateLimit-Remaining": String(own.remaining) }, head);
  } catch (error) {
    if (error instanceof BadRequest) {
      await record(db, key, ctx, endpoint.path, 400, null);
      return json(400, { error: "invalid", fields: error.fields }, {}, head);
    }
    throw error;
  }
}
