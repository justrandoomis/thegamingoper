/**
 * /admin/pos/api/:op — the till's JSON endpoints (no page). Every call is signed in and authorized like a page
 * (requireEmployee + the services' assertCan); answers are `private, no-store`.
 *
 *   GET  lookup?shift=&code=     a scanned or typed code → { kind: "item", item } | none | serial_unavailable | …
 *   GET  search?shift=&q=        items whose name or SKU contains q
 *   GET  catalog?shift=          the offline snapshot (prices, barcodes, the store's free units)
 *   GET  customer?phone=         the buyer's account (customers.customer.read)
 *   POST sale                    { …SaleRequest } → SaleOutcome (a repeat of its key returns the first sale)
 *   POST sync                    { sales: SaleRequest[] } → { results: { key, outcome }[] } (at most 20)
 *   POST print                   { ref } → { ok, copy, receipt }: the first print is the original (recorded once),
 *                                every later one a recorded copy (pos.receipt.reprint) — the till prints it in place
 *   POST discard                 { key, reason, sale } → a queued sale dropped for good (pos.shift.review; the trail
 *                                keeps what the device held)
 *
 * Failures the till can act on come back as `{ ok: false, code, message, fields, prices?, resolvable? }` with their
 * HTTP status (a body that is not a JSON object is a 400); anything unexpected is a 500 the till treats like a lost
 * connection for a sale (it stays queued).
 */
import { data } from "react-router";

import type { Route } from "./+types/till-api";
import { can } from "~/server/actor";
import { readBodyBytes } from "~/server/body.server";
import { forbidden, toAppError } from "~/server/errors";
import { catalogSnapshot, createSale, discardQueuedSale, findCustomer, lookupItem, printReceipt, saleFailure, searchItems, syncSales } from "~/server/services/admin/pos/sale.server";
import { openPos, posT } from "./pos.server";

const HEADERS = { "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPos(context, "pos.sale.create");
  const url = new URL(request.url);
  const shiftId = url.searchParams.get("shift") ?? "";
  try {
    switch (params.op) {
      case "lookup":
        return json(await lookupItem(db, actor, { shiftId, code: url.searchParams.get("code") ?? "" }, locale, now));
      case "search":
        return json({ items: await searchItems(db, actor, { shiftId, q: url.searchParams.get("q") ?? "" }, locale, now) });
      case "catalog":
        return json(await catalogSnapshot(db, actor, { shiftId }, locale, now));
      case "customer":
        return json({ customer: await findCustomer(db, actor, { phone: url.searchParams.get("phone") ?? "" }) });
      default:
        return json({ ok: false, code: "not_found" }, 404);
    }
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return json(saleFailure(appError, posT(locale)), appError.status);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now, ctx } = await openPos(context, "pos.sale.create");
  if (request.method !== "POST") return data({ ok: false, code: "method_not_allowed" }, { status: 405 });
  const t = posT(locale);
  // The permission before the input: dropping a queued sale is a supervisor's (the service checks it again).
  if (params.op === "discard" && !can(actor, "pos.shift.review")) return json(saleFailure(forbidden("pos.shift.review"), t), 403);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(await readBodyBytes(request, 512 * 1024)));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, code: "invalid", message: t("errors.invalid") }, 400);
  }
  const sale = { locale, storeMode: ctx.storeMode };
  try {
    switch (params.op) {
      case "sale":
        return json(await createSale(db, actor, body as never, sale, now));
      case "sync":
        return json({ results: await syncSales(db, actor, body as { sales: unknown[] }, sale, now, t) });
      case "print":
        return json({ ok: true, ...(await printReceipt(db, actor, typeof body.ref === "string" ? body.ref : "", now, locale)) });
      case "discard":
        return json({ ok: true, ...(await discardQueuedSale(db, actor, body as never, now)) });
      default:
        return json({ ok: false, code: "not_found" }, 404);
    }
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return json(saleFailure(error, t), appError.status);
  }
}
