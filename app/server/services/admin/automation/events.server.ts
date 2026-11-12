/**
 * Admin module 19 — where the events of the catalogue come from. Nothing in the commerce core calls automation: the
 * scheduled run READS the records the other modules wrote, so an event is a fact already in the database.
 *
 *   order.placed         orders.placed_at (web and counter sales), one event per order
 *   price.changed        price_changes rows with status "applied" (the price history), one event per change
 *   stock.below_reorder  a stock level at a sellable, active location whose available units (on hand − reserved) are at
 *                        or below its reorder point — one event per level and stock episode (the latest arrival of
 *                        stock there: after new units arrive, falling again is a new event)
 *   ticket.waiting       a support ticket waiting for a staff reply (the customer wrote, or the ticket was opened, and no
 *                        public staff reply followed): one event per waiting episode, dated when it crossed the rule's
 *                        hours. History is rebuilt from the ticket's messages, so a dry run sees past episodes too
 *
 * Time-based events (orders, prices) are read after a cursor (`after`), oldest first; state-based ones (stock,
 * tickets) are read as they are now. A stock level's past is not rebuilt: a stock rule's dry run says it read today's
 * stock. Every query is bounded (`limit`).
 */
import { sql } from "drizzle-orm";
import type { Db } from "~/server/db/drizzle.server";
import { HOUR_MS, type AutomationEvent, type EventType, type OrderFacts, type PriceFacts, type RuleMatch, type StockFacts, type TicketFacts, type TicketMatch } from "./catalog";

export type Cursor = { at: number; id: string };
export type EventWindow = { from: number; to: number; limit: number; after?: Cursor | null };

const num = (value: unknown) => Number(value ?? 0);
const flag = (value: unknown) => value === 1 || value === true || value === "1";

export async function orderEvents(db: Db, window: EventWindow): Promise<AutomationEvent<"order.placed">[]> {
  const after = window.after ?? { at: window.from, id: "" };
  const rows = await db.all<{ id: string; ref: string; channel: string; paymentMethod: string | null; totalIqd: number; governorateId: string | null; status: string; reviewStatus: string; isDemo: number; placedAt: number }>(sql`
    SELECT o.id AS id, o.ref AS ref, o.channel AS channel, o.payment_method AS paymentMethod, o.total_iqd AS totalIqd, o.governorate_id AS governorateId,
           o.status AS status, o.review_status AS reviewStatus, o.is_demo AS isDemo, o.placed_at AS placedAt
    FROM orders AS o
    WHERE (o.placed_at > ${after.at} OR (o.placed_at = ${after.at} AND o.id > ${after.id})) AND o.placed_at >= ${window.from} AND o.placed_at <= ${window.to}
    ORDER BY o.placed_at ASC, o.id ASC LIMIT ${window.limit}`);
  return rows.map((row) => ({
    type: "order.placed",
    key: `order:${row.id}`,
    at: num(row.placedAt),
    refType: "order",
    refId: row.id,
    label: row.ref,
    facts: { ref: row.ref, channel: row.channel, paymentMethod: row.paymentMethod, totalIqd: num(row.totalIqd), governorateId: row.governorateId, status: row.status, reviewStatus: row.reviewStatus, isDemo: flag(row.isDemo) } satisfies OrderFacts,
  }));
}

export async function priceEvents(db: Db, window: EventWindow): Promise<AutomationEvent<"price.changed">[]> {
  const after = window.after ?? { at: window.from, id: "" };
  const rows = await db.all<{ id: string; variantId: string; sku: string; oldPriceIqd: number | null; newPriceIqd: number; source: string; createdAt: number; isDemo: number }>(sql`
    SELECT pc.id AS id, pc.variant_id AS variantId, v.sku AS sku, pc.old_price_iqd AS oldPriceIqd, pc.new_price_iqd AS newPriceIqd, pc.source AS source,
           pc.created_at AS createdAt, p.is_demo AS isDemo
    FROM price_changes AS pc JOIN variants AS v ON v.id = pc.variant_id JOIN products AS p ON p.id = v.product_id
    WHERE pc.status = 'applied' AND (pc.created_at > ${after.at} OR (pc.created_at = ${after.at} AND pc.id > ${after.id})) AND pc.created_at >= ${window.from} AND pc.created_at <= ${window.to}
    ORDER BY pc.created_at ASC, pc.id ASC LIMIT ${window.limit}`);
  return rows.map((row) => ({
    type: "price.changed",
    key: `price_change:${row.id}`,
    at: num(row.createdAt),
    refType: "price_change",
    refId: row.id,
    label: row.sku,
    facts: { variantId: row.variantId, sku: row.sku, oldPriceIqd: row.oldPriceIqd === null ? null : num(row.oldPriceIqd), newPriceIqd: num(row.newPriceIqd), source: row.source, isDemo: flag(row.isDemo) } satisfies PriceFacts,
  }));
}

/** Units on the way per SKU: transfers in transit + what open purchase orders still owe (04's "incoming"). */
const INCOMING = sql`
  tr AS (SELECT i.variant_id, SUM(i.qty - i.qty_received) AS qty FROM stock_transfer_items AS i JOIN stock_transfers AS t ON t.id = i.transfer_id WHERE t.status = 'in_transit' GROUP BY i.variant_id),
  po AS (SELECT pi.variant_id, SUM(max(pi.qty_ordered - pi.qty_received, 0)) AS qty FROM po_items AS pi JOIN purchase_orders AS o ON o.id = pi.po_id WHERE o.status IN ('approved', 'sent', 'partially_received') GROUP BY pi.variant_id)`;

export async function stockEvents(db: Db, now: number, limit: number): Promise<AutomationEvent<"stock.below_reorder">[]> {
  const rows = await db.all<{ variantId: string; locationId: string; locationCode: string; sku: string; kind: string; isDemo: number; available: number; reorderPoint: number; incoming: number; lastInboundId: string | null }>(sql`
    WITH ${INCOMING}
    SELECT s.variant_id AS variantId, s.location_id AS locationId, l.code AS locationCode, v.sku AS sku, p.kind AS kind, p.is_demo AS isDemo,
           max(s.on_hand - s.reserved, 0) AS available, s.reorder_point AS reorderPoint, coalesce(tr.qty, 0) + coalesce(po.qty, 0) AS incoming,
           (SELECT m.id FROM stock_movements AS m WHERE m.variant_id = s.variant_id AND m.location_id = s.location_id AND m.qty_delta > 0 ORDER BY m.at DESC, m.id DESC LIMIT 1) AS lastInboundId
    FROM stock_levels AS s
    JOIN inventory_locations AS l ON l.id = s.location_id AND l.is_sellable = 1 AND l.is_active = 1
    JOIN variants AS v ON v.id = s.variant_id AND v.is_active = 1
    JOIN products AS p ON p.id = v.product_id AND p.status <> 'archived' AND p.kind <> 'bundle'
    LEFT JOIN tr ON tr.variant_id = s.variant_id LEFT JOIN po ON po.variant_id = s.variant_id
    WHERE s.reorder_point IS NOT NULL AND max(s.on_hand - s.reserved, 0) <= s.reorder_point
    ORDER BY max(s.on_hand - s.reserved, 0) - s.reorder_point ASC, v.sku ASC LIMIT ${limit}`);
  return rows.map((row) => ({
    type: "stock.below_reorder",
    key: `stock:${row.variantId}:${row.locationId}:${row.lastInboundId ?? "none"}`,
    at: now,
    refType: "stock_level",
    refId: `${row.variantId}:${row.locationId}`,
    label: `${row.sku} · ${row.locationCode}`,
    facts: { variantId: row.variantId, sku: row.sku, locationId: row.locationId, locationCode: row.locationCode, available: num(row.available), reorderPoint: num(row.reorderPoint), incoming: num(row.incoming), productKind: row.kind, isDemo: flag(row.isDemo) } satisfies StockFacts,
  }));
}

type TicketRow = { id: string; ref: string; status: string; priority: string; category: string; assignedTo: string | null; isDemo: number; createdAt: number; endedAt: number | null };
type MessageRow = { ticketId: string; authorKind: string; createdAt: number };

/**
 * Waiting episodes of one ticket: from its opening or a customer's message, until the next public staff reply (or the
 * ticket being resolved or closed). `open` = still waiting now.
 */
export function waitingEpisodes(ticket: { createdAt: number; endedAt: number | null }, messages: readonly { authorKind: string; createdAt: number }[], now: number): { start: number; end: number | null }[] {
  const sorted = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  const out: { start: number; end: number | null }[] = [];
  let start: number | null = ticket.createdAt;
  for (const message of sorted) {
    if (ticket.endedAt !== null && message.createdAt > ticket.endedAt) break;
    if (message.authorKind === "employee") {
      if (start !== null) out.push({ start, end: message.createdAt });
      start = null;
    } else if (message.authorKind === "customer" && start === null) {
      start = message.createdAt;
    }
  }
  if (start !== null) out.push({ start, end: ticket.endedAt !== null && ticket.endedAt <= now ? ticket.endedAt : null });
  return out;
}

/**
 * Tickets that waited at least the rule's hours in [from, to] — or, with `current`, that are waiting now and crossed
 * the hours by `to`. The event is dated when the wait crossed the hours.
 */
export async function ticketEvents(db: Db, match: TicketMatch, window: EventWindow & { current: boolean }): Promise<AutomationEvent<"ticket.waiting">[]> {
  const hours = match.hours * HOUR_MS;
  const tickets = await db.all<TicketRow>(
    window.current
      ? sql`
        SELECT t.id AS id, t.ref AS ref, t.status AS status, t.priority AS priority, t.category AS category, t.assigned_to AS assignedTo, t.is_demo AS isDemo,
               t.created_at AS createdAt, NULL AS endedAt
        FROM support_tickets AS t WHERE t.status IN ('open', 'pending_staff') AND t.created_at <= ${window.to - hours}
        ORDER BY t.created_at ASC LIMIT ${window.limit}`
      : sql`
        SELECT t.id AS id, t.ref AS ref, t.status AS status, t.priority AS priority, t.category AS category, t.assigned_to AS assignedTo, t.is_demo AS isDemo,
               t.created_at AS createdAt, coalesce(t.resolved_at, t.closed_at) AS endedAt
        FROM support_tickets AS t
        WHERE t.created_at <= ${window.to - hours} AND (t.status IN ('open', 'pending_staff', 'on_hold') OR coalesce(t.last_message_at, t.updated_at) >= ${window.from} OR coalesce(t.resolved_at, t.closed_at, ${window.to}) >= ${window.from})
        ORDER BY t.created_at ASC LIMIT ${window.limit}`,
  );
  if (!tickets.length) return [];
  const messages: MessageRow[] = [];
  for (let at = 0; at < tickets.length; at += 90) {
    const ids = tickets.slice(at, at + 90).map((ticket) => ticket.id);
    messages.push(
      ...(await db.all<MessageRow>(sql`
        SELECT m.ticket_id AS ticketId, m.author_kind AS authorKind, m.created_at AS createdAt FROM ticket_messages AS m
        WHERE m.is_internal = 0 AND m.author_kind IN ('customer', 'employee') AND m.ticket_id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`)),
    );
  }
  const byTicket = new Map<string, MessageRow[]>();
  for (const message of messages) byTicket.set(message.ticketId, [...(byTicket.get(message.ticketId) ?? []), message]);
  const out: AutomationEvent<"ticket.waiting">[] = [];
  for (const ticket of tickets) {
    const episodes = waitingEpisodes({ createdAt: num(ticket.createdAt), endedAt: ticket.endedAt === null ? null : num(ticket.endedAt) }, (byTicket.get(ticket.id) ?? []).map((m) => ({ authorKind: m.authorKind, createdAt: num(m.createdAt) })), window.to);
    for (const episode of episodes) {
      const crossed = episode.start + hours;
      const waitedLongEnough = (episode.end ?? window.to) - episode.start >= hours;
      if (!waitedLongEnough || crossed > window.to) continue;
      if (window.current ? episode.end !== null : crossed < window.from) continue;
      out.push({
        type: "ticket.waiting",
        key: `ticket:${ticket.id}:${episode.start}:${match.hours}`,
        at: crossed,
        refType: "support_ticket",
        refId: ticket.id,
        label: ticket.ref,
        facts: { ref: ticket.ref, status: ticket.status, priority: ticket.priority, category: ticket.category, assignedTo: ticket.assignedTo, waitingSince: episode.start, isDemo: flag(ticket.isDemo) } satisfies TicketFacts,
      });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.refId.localeCompare(b.refId));
}

/** The events of one type for a rule's conditions in a window: what the dry run and the scheduled run read. */
export async function collectEvents(db: Db, type: EventType, match: RuleMatch, window: EventWindow & { current?: boolean }, now: number): Promise<AutomationEvent[]> {
  switch (type) {
    case "order.placed":
      return orderEvents(db, window);
    case "price.changed":
      return priceEvents(db, window);
    case "stock.below_reorder":
      return stockEvents(db, now, window.limit);
    case "ticket.waiting":
      return ticketEvents(db, match as TicketMatch, { ...window, current: window.current ?? false });
  }
}

/** Events read after a cursor (orders, prices), and so need one; the others are read as they are now. */
export const usesCursor = (type: EventType) => type === "order.placed" || type === "price.changed";
