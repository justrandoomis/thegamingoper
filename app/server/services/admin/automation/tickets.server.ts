/**
 * Admin 19.03 — ticket topics and reply suggestions by KEYWORD RULES (catalog.ts KEYWORD_RULES), labelled as rules,
 * never as AI: the subject and the customer's first message are normalised like the support module's routing rules
 * (`normalizeMatchText`), the first topic with a word in them is the suggestion (with the word that matched), and the
 * suggested replies are module 14's active canned replies of that topic. Nothing is written: staff change the topic
 * and reply on the ticket's own page (14.02). Summaries need a language model, which is not configured (boundary).
 *
 *   await ticketSuggestions(db, actor, parseTicketFilters(params), now);   // automation.workflow.read + support.ticket.read
 *
 * Counts are the truth: `open` is every open ticket; the keyword rules read the latest SCAN_LIMIT of them (`checked`,
 * said on the page when it is fewer than `open`); the chosen view comes in pages of PAGE_SIZE that add up to `total`.
 */
import { sql } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import { maskPhonesIn } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { normalizeMatchText } from "../support/types";
import { KEYWORD_RULES, type TicketCategory } from "./catalog";
import { recordHref } from "./shared.server";
import { PAGE_SIZE, type TicketView } from "./types";

// the URL state is client-safe (types.ts): the page builds its links from it
export { TICKET_VIEWS, parseTicketFilters, parseTicketView, ticketSearch, type TicketFilters, type TicketView } from "./types";

export type TicketSuggestion = {
  id: string;
  ref: string;
  subject: string;
  status: string;
  priority: string;
  category: string;
  lastMessageAt: number | null;
  suggested: { category: TicketCategory; keyword: string } | null;
  replies: { id: string; title: string }[];
  href: string | null;
  demo: boolean;
};

/** The topic the keyword rules suggest for a text, with the word that matched (null: no rule matched). */
export function suggestTopic(text: string): { category: TicketCategory; keyword: string } | null {
  const haystack = normalizeMatchText(text);
  for (const rule of KEYWORD_RULES) {
    const keyword = rule.words.find((word) => {
      const needle = normalizeMatchText(word);
      return needle !== "" && haystack.includes(needle);
    });
    if (keyword) return { category: rule.category, keyword };
  }
  return null;
}

/** Open tickets the keyword rules read at most per page view (the latest by their last message). */
export const SCAN_LIMIT = 1000;

export type TicketPage = {
  rows: TicketSuggestion[];
  /** Rows of the chosen view (differs: of the checked tickets, those the rules point elsewhere; all: the checked ones). */
  total: number;
  page: number;
  pageCount: number;
  /** Every open ticket; `checked` of them (the latest) were read by the keyword rules. */
  open: number;
  checked: number;
  differs: number;
  ranAt: number;
};

export async function ticketSuggestions(db: Db, actor: Actor, filters: { view: TicketView; page?: number }, now: number): Promise<TicketPage> {
  assertCan(actor, "automation.workflow.read");
  assertCan(actor, "support.ticket.read");
  const [tickets, openRows] = await Promise.all([
    db.all<{ id: string; ref: string; subject: string; status: string; priority: string; category: string; lastMessageAt: number | null; isDemo: number; firstMessage: string | null }>(sql`
      SELECT t.id AS id, t.ref AS ref, t.subject AS subject, t.status AS status, t.priority AS priority, t.category AS category, t.last_message_at AS lastMessageAt, t.is_demo AS isDemo,
             (SELECT substr(m.body, 1, 2000) FROM ticket_messages AS m WHERE m.ticket_id = t.id AND m.is_internal = 0 AND m.author_kind = 'customer' ORDER BY m.created_at ASC, m.id ASC LIMIT 1) AS firstMessage
      FROM support_tickets AS t WHERE t.status NOT IN ('resolved', 'closed')
      ORDER BY coalesce(t.last_message_at, t.created_at) DESC, t.id LIMIT ${SCAN_LIMIT}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM support_tickets WHERE status NOT IN ('resolved', 'closed')`),
  ]);
  const replies = await db.all<{ id: string; title: string; category: string | null }>(sql`SELECT id, title, category FROM canned_replies WHERE is_active = 1 ORDER BY title, id`);
  const byCategory = new Map<string, { id: string; title: string }[]>();
  for (const reply of replies) if (reply.category) byCategory.set(reply.category, [...(byCategory.get(reply.category) ?? []), { id: reply.id, title: reply.title }]);
  // a phone number a customer typed into a subject is masked for whoever may not read full numbers
  const fullPhones = can(actor, "customer.phone.read_full");
  const all = tickets.map((ticket): TicketSuggestion => {
    const suggested = suggestTopic(`${ticket.subject} ${(ticket.firstMessage ?? "").slice(0, 2000)}`);
    return {
      id: ticket.id,
      ref: ticket.ref,
      subject: fullPhones ? ticket.subject : maskPhonesIn(ticket.subject),
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      lastMessageAt: ticket.lastMessageAt === null ? null : Number(ticket.lastMessageAt),
      suggested,
      replies: (byCategory.get(suggested?.category ?? ticket.category) ?? []).slice(0, 3),
      href: recordHref(actor, "support_ticket", { ref: ticket.ref }),
      demo: ticket.isDemo === 1,
    };
  });
  const differing = all.filter((row) => row.suggested !== null && row.suggested.category !== row.category);
  const list = filters.view === "all" ? all : differing;
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, filters.page ?? 1), pageCount);
  return {
    rows: list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: list.length,
    page,
    pageCount,
    open: Number(openRows[0]?.n ?? 0),
    checked: all.length,
    differs: differing.length,
    ranAt: now,
  };
}
