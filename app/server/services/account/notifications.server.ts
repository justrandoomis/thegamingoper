/**
 * In-account notifications (brief §3.10): what the store wrote to the customer about their orders, payments and
 * account. They are the one channel that works today — no SMS, WhatsApp or e-mail provider is configured.
 *
 *   const page = await listNotifications(db, customerId, locale, { cursor });
 *   await markNotificationsRead(db, customerId, ctx.now, id?);                 // one, or all when id is omitted
 *   statements.push(notificationStatement(db, { customerId, kind: "proof_rejected", title, body, link: `/order/${ref}`, now }));
 *
 * PRODUCERS: nothing writes notifications yet. `notificationStatement` is the batch item for the services that will
 * (payment proof decisions, order status changes, trade-in offers) — put it in the same batch as the change it tells
 * about. Titles and bodies are L10n (`{ ar, en?, ckb? }`), links are locale-less paths inside the store.
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Paged } from "~/lib/dto";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { notifications } from "~/server/db/schema";
import type { NotificationView } from "./types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** A link must stay inside the store: a locale-less absolute path, never another site. */
const SAFE_LINK = /^\/(?!\/)[^\s\\]*$/;

export type NotificationInput = { customerId: string; kind: string; title: L10n; body?: L10n | null; link?: string | null; now: number; id?: string };

/** Batch item: one notification for a customer. */
export function notificationStatement(db: Db, input: NotificationInput): BatchStatement {
  const link = input.link && SAFE_LINK.test(input.link) ? input.link.slice(0, 300) : null;
  return db.insert(notifications).values({
    id: input.id ?? newId("ntf"),
    customerId: input.customerId,
    kind: input.kind.slice(0, 40),
    title: input.title,
    body: input.body ?? null,
    link,
    createdAt: input.now,
  });
}

function parseCursor(cursor: string | null | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const match = /^(\d{1,16}):([A-Za-z0-9_.:-]{1,128})$/.exec(cursor);
  return match ? { at: Number(match[1]), id: match[2] } : null;
}

/** The customer's notifications, newest first (keyset pages: pass `nextCursor` back as `cursor`). */
export async function listNotifications(db: Db, customerId: string, locale: Locale, page: { cursor?: string | null; limit?: number } = {}): Promise<Paged<NotificationView>> {
  const limit = Math.min(Math.max(Math.floor(page.limit ?? 20), 1), 50);
  const cursor = parseCursor(page.cursor);
  const mine = eq(notifications.customerId, customerId);
  const where = cursor ? and(mine, or(lt(notifications.createdAt, cursor.at), and(eq(notifications.createdAt, cursor.at), lt(notifications.id, cursor.id)))) : mine;
  const [rows, total] = await Promise.all([
    db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit + 1),
    db.select({ n: sql<number>`count(*)` }).from(notifications).where(mine).get(),
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items: items.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: pick(row.title, locale),
      body: row.body ? pick(row.body, locale) || null : null,
      link: row.link && SAFE_LINK.test(row.link) ? row.link : null,
      readAt: row.readAt,
      createdAt: row.createdAt,
    })),
    total: Number(total?.n ?? 0),
    nextCursor: rows.length > limit && last ? `${last.createdAt}:${last.id}` : null,
  };
}

/** Unread notifications of the customer. */
export async function countUnreadNotifications(db: Db, customerId: string): Promise<number> {
  const row = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.customerId, customerId), isNull(notifications.readAt)))
    .get();
  return Number(row?.n ?? 0);
}

/** Marks one notification (or, without `id`, all of them) as read. Another customer's id changes nothing. Returns how many changed. */
export async function markNotificationsRead(db: Db, customerId: string, now: number, id?: string | null): Promise<number> {
  const unread = and(eq(notifications.customerId, customerId), isNull(notifications.readAt));
  if (id !== undefined && id !== null && !ID.test(id)) return 0;
  const rows = await db
    .update(notifications)
    .set({ readAt: now })
    .where(id ? and(unread, eq(notifications.id, id)) : unread)
    .returning({ id: notifications.id });
  return rows.length;
}
