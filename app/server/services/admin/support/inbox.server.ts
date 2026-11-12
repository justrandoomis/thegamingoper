/**
 * The unified inbox (14.01): support tickets (SP-…: the storefront's requests, assistant hand-offs, tickets staff
 * opened for a call, a WhatsApp message, an e-mail or a visit) and repair requests (RP-…, whose workflow is module
 * 12's) in one list, with saved views, filters, sort and page in the URL.
 *
 *   const page = await listInbox(db, actor, parseInboxFilters(url.searchParams), now);
 *   const counts = await supportQueueCounts(db, actor, now);        // the shell's bell (escalated to me, unassigned, my late)
 *
 * BOUNDARY: no e-mail, chat or messaging provider is connected, so nothing arrives here on its own from those channels:
 * staff open a ticket for a call or a message they received, and record what the customer said; replies are held in
 * the outbox (tickets.server.ts). The inbox says so.
 * Due times: a ticket's next target — its first-response due time until someone answered, then its resolution due
 * time; a repair's SLA due time (module 12) until it is ready. "Late" = that time has passed.
 * Phones are masked without customer.phone.read_full (searching part of a number needs it too).
 *
 * Who: support.ticket.read.
 */
import { sql, type SQL } from "drizzle-orm";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { agentsOf, employeeNames, normalizeRepairRef, normalizeTicketRef, phoneView } from "./shared.server";
import {
  INBOX_PAGE_SIZE,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  type InboxCounts,
  type InboxFilters,
  type InboxPage,
  type InboxRow,
  type SupportQueueCounts,
  type TicketCategory,
  type TicketChannel,
  type TicketPriority,
} from "./types";

const T_OPEN = sql`t.status IN ('open', 'pending_customer', 'pending_staff', 'on_hold')`;
const T_DONE = sql`t.status IN ('resolved', 'closed')`;
const R_OPEN = sql`r.status IN ('submitted', 'received', 'diagnosing', 'awaiting_approval', 'awaiting_parts', 'repairing', 'ready')`;
const R_DONE = sql`r.status IN ('delivered', 'unrepairable', 'cancelled')`;
/** A ticket's next due time: first response until answered, then resolution; none once it is done. */
const T_DUE = sql`(CASE WHEN ${T_OPEN} THEN (CASE WHEN t.first_responded_at IS NULL THEN t.first_response_due_at ELSE t.resolution_due_at END) END)`;
/** A repair's SLA (module 12 counts "ready" as on time). */
const R_DUE = sql`(CASE WHEN r.status IN ('submitted', 'received', 'diagnosing', 'awaiting_approval', 'awaiting_parts', 'repairing') THEN r.sla_due_at END)`;
const R_CHANNEL = sql`(CASE r.source WHEN 'storefront' THEN 'web' WHEN 'assistant' THEN 'assistant' ELSE 'store' END)`;
const FALSE = sql`0`;
const TRUE = sql`1`;

type Parts = { t: SQL; r: SQL };

function viewParts(filters: InboxFilters, me: string, now: number): Parts {
  switch (filters.view) {
    case "open":
      return { t: T_OPEN, r: R_OPEN };
    case "needs_reply":
      return { t: sql`t.status IN ('open', 'pending_staff')`, r: sql`r.status = 'submitted'` };
    case "mine":
      return { t: sql`${T_OPEN} AND t.assigned_to = ${me}`, r: sql`${R_OPEN} AND r.assigned_to = ${me}` };
    case "unassigned":
      return { t: sql`${T_OPEN} AND t.assigned_to IS NULL`, r: sql`r.status = 'submitted' AND r.assigned_to IS NULL` };
    case "late":
      return { t: sql`${T_DUE} < ${now}`, r: sql`${R_DUE} < ${now}` };
    case "escalated":
      return { t: sql`${T_OPEN} AND t.escalated_to IS NOT NULL`, r: FALSE };
    case "escalated_me":
      return { t: sql`${T_OPEN} AND t.escalated_to = ${me}`, r: FALSE };
    case "handoffs":
      return { t: sql`${T_OPEN} AND t.channel = 'assistant'`, r: sql`${R_OPEN} AND r.source = 'assistant'` };
    case "repairs":
      return { t: FALSE, r: R_OPEN };
    case "waiting":
      return { t: sql`t.status IN ('pending_customer', 'on_hold')`, r: sql`r.status IN ('awaiting_approval', 'awaiting_parts')` };
    case "done":
      return { t: T_DONE, r: R_DONE };
    case "all":
      return { t: TRUE, r: TRUE };
  }
}

function filterParts(actor: Actor, filters: InboxFilters, me: string): Parts {
  const t: SQL[] = [];
  const r: SQL[] = [];
  if (filters.kind === "ticket") r.push(FALSE);
  if (filters.kind === "repair") t.push(FALSE);
  // ticket fields: a repair has no status of this list, no priority and no team
  if (filters.status) {
    t.push(sql`t.status = ${filters.status}`);
    r.push(FALSE);
  }
  if (filters.priority) {
    t.push(sql`t.priority = ${filters.priority}`);
    r.push(FALSE);
  }
  if (filters.team) {
    t.push(sql`t.team = ${filters.team}`);
    r.push(FALSE);
  }
  if (filters.category) {
    t.push(sql`t.category = ${filters.category}`);
    if (filters.category !== "repair") r.push(FALSE);
  }
  if (filters.channel) {
    t.push(sql`t.channel = ${filters.channel}`);
    r.push(sql`${R_CHANNEL} = ${filters.channel}`);
  }
  if (filters.assignee) {
    const who = filters.assignee === "me" ? me : filters.assignee;
    if (filters.assignee === "none") {
      t.push(sql`t.assigned_to IS NULL`);
      r.push(sql`r.assigned_to IS NULL`);
    } else {
      t.push(sql`t.assigned_to = ${who}`);
      r.push(sql`r.assigned_to = ${who}`);
    }
  }
  const text = filters.q.trim();
  if (text) {
    const ticketRef = normalizeTicketRef(text);
    const repairRef = normalizeRepairRef(text);
    const phone = normalizeIraqPhone(text);
    const digits = toLatinDigits(text).replace(/\D/g, "");
    // order and return references as people type them (Arabic-Indic or Persian digits, any case)
    const upper = toLatinDigits(text).toUpperCase();
    if (ticketRef) {
      t.push(sql`t.ref = ${ticketRef}`);
      r.push(FALSE);
    } else if (repairRef) {
      t.push(sql`t.repair_ticket_id = (SELECT id FROM repair_tickets WHERE ref = ${repairRef})`);
      r.push(sql`r.ref = ${repairRef}`);
    } else if (/^(TT|POS)-[A-Z0-9]{4,16}$/.test(upper)) {
      t.push(sql`t.order_id = (SELECT id FROM orders WHERE ref = ${upper})`);
      r.push(FALSE);
    } else if (/^RMA-[A-Z0-9]{4,16}$/.test(upper)) {
      t.push(sql`t.return_id = (SELECT id FROM returns WHERE rma = ${upper})`);
      r.push(sql`r.return_id = (SELECT id FROM returns WHERE rma = ${upper})`);
    } else if (phone) {
      t.push(sql`t.phone_e164 = ${phone}`);
      r.push(sql`r.phone_e164 = ${phone}`);
    } else if (digits.length >= 4 && digits.length === text.replace(/[\s-]/g, "").length) {
      // part of a number: only for those who may see whole numbers (otherwise the match itself would reveal digits)
      if (can(actor, "customer.phone.read_full")) {
        t.push(sql`t.phone_e164 LIKE ${`%${digits.slice(0, 15)}%`}`);
        r.push(sql`r.phone_e164 LIKE ${`%${digits.slice(0, 15)}%`}`);
      } else {
        t.push(FALSE);
        r.push(FALSE);
      }
    } else {
      const like = `%${text.slice(0, 60).replace(/[%_\\]/g, "")}%`;
      t.push(sql`(t.subject LIKE ${like} OR t.contact_name LIKE ${like} OR t.email LIKE ${like})`);
      r.push(sql`(r.issue LIKE ${like} OR r.contact_name LIKE ${like} OR r.device_text LIKE ${like})`);
    }
  }
  const join = (parts: SQL[]) => (parts.length ? sql.join(parts, sql` AND `) : TRUE);
  return { t: join(t), r: join(r) };
}

const ORDER: Record<InboxFilters["sort"], SQL> = {
  activity: sql`"activityAt" DESC, "createdAt" DESC`,
  due: sql`"dueAt" IS NULL, "dueAt" ASC, "createdAt" DESC`,
  created: sql`"createdAt" DESC`,
  priority: sql`"prank" ASC, "dueAt" IS NULL, "dueAt" ASC, "createdAt" DESC`,
};

type RawRow = {
  kind: "ticket" | "repair";
  id: string;
  ref: string;
  title: string;
  channel: string;
  category: string;
  priority: string;
  status: string;
  handoff: number;
  contact: string | null;
  phone: string | null;
  assignedTo: string | null;
  team: string | null;
  createdAt: number;
  activityAt: number;
  dueAt: number | null;
  dueTarget: string | null;
  escalatedTo: string | null;
  escalated: number;
  isDemo: number;
  prank: number;
};

function unionSql(t: SQL, r: SQL): SQL {
  return sql`
    SELECT 'ticket' AS "kind", t.id AS "id", t.ref AS "ref", t.subject AS "title", t.channel AS "channel", t.category AS "category", t.priority AS "priority",
      t.status AS "status", (t.channel = 'assistant' OR t.assistant_session_id IS NOT NULL) AS "handoff", t.contact_name AS "contact", t.phone_e164 AS "phone",
      t.assigned_to AS "assignedTo", t.team AS "team", t.created_at AS "createdAt", COALESCE(t.last_message_at, t.updated_at) AS "activityAt",
      ${T_DUE} AS "dueAt", (CASE WHEN t.first_responded_at IS NULL THEN 'first_response' ELSE 'resolution' END) AS "dueTarget",
      t.escalated_to AS "escalatedTo", (t.escalated_at IS NOT NULL) AS "escalated", t.is_demo AS "isDemo",
      (CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END) AS "prank"
    FROM support_tickets AS t WHERE ${t}
    UNION ALL
    SELECT 'repair', r.id, r.ref, substr(r.issue, 1, 160), ${R_CHANNEL}, 'repair', 'normal',
      r.status, (r.source = 'assistant'), r.contact_name, r.phone_e164,
      r.assigned_to, NULL, r.created_at, r.updated_at,
      ${R_DUE}, 'repair',
      NULL, 0, r.is_demo,
      2
    FROM repair_tickets AS r WHERE ${r}`;
}

const asChannel = (value: string): TicketChannel => ((TICKET_CHANNELS as readonly string[]).includes(value) ? (value as TicketChannel) : "web");
const asCategory = (value: string): TicketCategory => ((TICKET_CATEGORIES as readonly string[]).includes(value) ? (value as TicketCategory) : "other");
const asPriority = (value: string): TicketPriority => ((TICKET_PRIORITIES as readonly string[]).includes(value) ? (value as TicketPriority) : "normal");

export async function listInbox(db: Db, actor: Actor, filters: InboxFilters, now: number): Promise<InboxPage> {
  assertCan(actor, "support.ticket.read");
  const me = actor.kind === "employee" ? actor.id : "";
  const view = viewParts(filters, me, now);
  const extra = filterParts(actor, filters, me);
  const union = unionSql(sql`(${view.t}) AND (${extra.t})`, sql`(${view.r}) AND (${extra.r})`);
  const offset = (filters.page - 1) * INBOX_PAGE_SIZE;
  const [rows, total, counts, teams, agents] = await Promise.all([
    db.all<RawRow>(sql`SELECT * FROM (${union}) ORDER BY ${ORDER[filters.sort]} LIMIT ${INBOX_PAGE_SIZE} OFFSET ${offset}`),
    db.get<{ n: number }>(sql`SELECT count(*) AS n FROM (${union})`),
    inboxCounts(db, me, now),
    db.all<{ team: string }>(sql`SELECT DISTINCT team FROM support_tickets WHERE team IS NOT NULL ORDER BY team LIMIT 50`),
    agentsOf(db),
  ]);
  const names = await employeeNames(db, [...rows.map((row) => row.assignedTo), ...rows.map((row) => row.escalatedTo)]);
  const count = Number(total?.n ?? 0);
  return {
    rows: rows.map(
      (row): InboxRow => ({
        kind: row.kind,
        id: row.id,
        ref: row.ref,
        title: row.title,
        channel: asChannel(row.channel),
        category: asCategory(row.category),
        priority: asPriority(row.priority),
        status: row.status,
        handoff: Boolean(row.handoff),
        contact: row.contact,
        phone: phoneView(actor, row.phone),
        assigned: row.assignedTo ? { id: row.assignedTo, name: names.get(row.assignedTo) ?? row.assignedTo } : null,
        team: row.team,
        createdAt: Number(row.createdAt),
        activityAt: Number(row.activityAt),
        due: row.dueAt ? { at: Number(row.dueAt), target: row.dueTarget === "repair" ? "repair" : row.dueTarget === "resolution" ? "resolution" : "first_response", late: Number(row.dueAt) < now } : null,
        escalatedTo: row.escalatedTo ? { id: row.escalatedTo, name: names.get(row.escalatedTo) ?? row.escalatedTo } : null,
        escalated: Boolean(row.escalated),
        isDemo: Boolean(row.isDemo),
      }),
    ),
    total: count,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(count / INBOX_PAGE_SIZE)),
    filters,
    counts,
    teams: teams.map((row) => row.team),
    agents,
    can: { assign: can(actor, "support.ticket.assign"), reply: can(actor, "support.ticket.reply"), route: can(actor, "support.ticket.assign") },
  };
}

/** The counts behind the inbox's view chips (one query per table). */
export async function inboxCounts(db: Db, me: string, now: number): Promise<InboxCounts> {
  const [t, r] = await Promise.all([
    db.get<Record<string, number | null>>(sql`
      SELECT
        sum(CASE WHEN t.status IN ('open', 'pending_staff') THEN 1 ELSE 0 END) AS needs_reply,
        sum(CASE WHEN ${T_OPEN} AND t.assigned_to = ${me} THEN 1 ELSE 0 END) AS mine,
        sum(CASE WHEN ${T_OPEN} AND t.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
        sum(CASE WHEN ${T_DUE} < ${now} THEN 1 ELSE 0 END) AS late,
        sum(CASE WHEN ${T_OPEN} AND t.escalated_to = ${me} THEN 1 ELSE 0 END) AS escalated_me,
        sum(CASE WHEN ${T_OPEN} AND t.channel = 'assistant' THEN 1 ELSE 0 END) AS handoffs
      FROM support_tickets AS t`),
    db.get<Record<string, number | null>>(sql`
      SELECT
        sum(CASE WHEN r.status = 'submitted' THEN 1 ELSE 0 END) AS needs_reply,
        sum(CASE WHEN ${R_OPEN} AND r.assigned_to = ${me} THEN 1 ELSE 0 END) AS mine,
        sum(CASE WHEN r.status = 'submitted' AND r.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
        sum(CASE WHEN ${R_DUE} < ${now} THEN 1 ELSE 0 END) AS late,
        sum(CASE WHEN ${R_OPEN} AND r.source = 'assistant' THEN 1 ELSE 0 END) AS handoffs,
        sum(CASE WHEN ${R_OPEN} THEN 1 ELSE 0 END) AS repairs
      FROM repair_tickets AS r`),
  ]);
  const n = (value: number | null | undefined) => Number(value ?? 0);
  return {
    needs_reply: n(t?.needs_reply) + n(r?.needs_reply),
    mine: n(t?.mine) + n(r?.mine),
    unassigned: n(t?.unassigned) + n(r?.unassigned),
    late: n(t?.late) + n(r?.late),
    escalated_me: n(t?.escalated_me),
    handoffs: n(t?.handoffs) + n(r?.handoffs),
    repairs: n(r?.repairs),
  };
}

/**
 * What waits for this employee in the module — for the shell's bell and the inbox's cards. Each count only for
 * holders of the permission to act on it (null otherwise), and each equals the inbox view its link opens:
 *   escalatedToMe → /admin/support?view=escalated_me   (support.ticket.read: they decide it)
 *   unassigned    → /admin/support?view=unassigned&kind=ticket (support.ticket.assign)
 *   mineLate      → /admin/support?view=late&assignee=me&kind=ticket (support.ticket.reply)
 */
export async function supportQueueCounts(db: Db, actor: Actor, now: number): Promise<SupportQueueCounts> {
  if (!can(actor, "support.ticket.read")) return { escalatedToMe: null, unassigned: null, mineLate: null };
  const me = actor.kind === "employee" ? actor.id : "";
  const row = await db.get<Record<string, number | null>>(sql`
    SELECT
      sum(CASE WHEN ${T_OPEN} AND t.escalated_to = ${me} THEN 1 ELSE 0 END) AS escalated,
      sum(CASE WHEN ${T_OPEN} AND t.assigned_to IS NULL THEN 1 ELSE 0 END) AS unassigned,
      sum(CASE WHEN t.assigned_to = ${me} AND ${T_DUE} < ${now} THEN 1 ELSE 0 END) AS late
    FROM support_tickets AS t`);
  return {
    escalatedToMe: Number(row?.escalated ?? 0),
    unassigned: can(actor, "support.ticket.assign") ? Number(row?.unassigned ?? 0) : null,
    mineLate: can(actor, "support.ticket.reply") ? Number(row?.late ?? 0) : null,
  };
}

export { QUEUE_LINKS } from "./types";
