/**
 * Canned replies (14.04): saved answers with a fixed list of SAFE variables (types.ts CANNED_VARIABLES, written
 * `{customer_name}`), filled from the ticket on the server and reviewed by the agent before anything is recorded.
 *
 *   const list = await listCannedReplies(db, actor, locale);
 *   await saveCannedReply(db, actor, { key, title, bodyAr, bodyEn, category, isActive, reason }, now);
 *   const preview = await previewCannedReply(db, actor, { ticketId, replyId }, now);   // { text, missing, locale }
 *
 * No template code: a body may only hold text and `{name}` placeholders from the list — `{{x}}`, `{x.y}`, `{#if}`,
 * `${x}`, a lone brace or an unknown name is refused at save time. Values are plain strings put in place of their
 * placeholder (the reply is text, never markup); a variable without a value stays as `{name}` and the agent must fill
 * it in — the reply service refuses a text that still holds one. The preview is in the ticket's language (the
 * shopper's), from the reply's body in that language or the Arabic one (said so).
 *
 * Who: listing and previewing — support.ticket.reply (or the manager of the list); changing — support.canned_reply.manage.
 * Errors: forbidden (403), not_found (404), invalid (400: unknown_variable, template_code, key_taken), reply_changed (409).
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { formatDate } from "~/lib/dates";
import { newId } from "~/lib/ids";
import { isLocale, pick, type L10n, type Locale } from "~/lib/locales";
import { formatIraqPhone, normalizeIraqPhone } from "~/lib/phone";
import messages from "~/i18n/messages/admin-support";
import { makeT } from "~/i18n/translate";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { cannedReplies, customers, employees, orders, products, repairTickets, TICKET_CATEGORIES, warranties, type SupportTicket } from "~/server/db/schema";
import { expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { employeeNames, isId, ticketById } from "./shared.server";
import { CANNED_KEY, CANNED_VARIABLES, checkTemplate, fillTemplate, type CannedVariable, type TicketCategory } from "./types";

export type CannedReplyRow = {
  id: string;
  key: string;
  title: string;
  body: L10n;
  category: TicketCategory | null;
  variables: CannedVariable[];
  isActive: boolean;
  updatedAt: number;
  createdBy: string | null;
};

function readable(actor: Actor): void {
  if (!canAny(actor, ["support.ticket.reply", "support.canned_reply.manage"])) throw forbidden("support.ticket.reply");
}

export async function listCannedReplies(db: Db, actor: Actor): Promise<{ rows: CannedReplyRow[]; canManage: boolean }> {
  readable(actor);
  const rows = await db.select().from(cannedReplies).orderBy(asc(cannedReplies.isActive), asc(cannedReplies.title));
  const names = await employeeNames(
    db,
    rows.map((row) => row.createdBy),
  );
  const canManage = canAny(actor, ["support.canned_reply.manage"]);
  return {
    rows: rows
      .filter((row) => canManage || row.isActive)
      .sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.title.localeCompare(b.title))
      .map((row) => ({
        id: row.id,
        key: row.key,
        title: row.title,
        body: row.body,
        category: row.category ?? null,
        variables: (Array.isArray(row.variables) ? row.variables : []).filter((name): name is CannedVariable => (CANNED_VARIABLES as readonly string[]).includes(name)),
        isActive: row.isActive,
        updatedAt: row.updatedAt,
        createdBy: row.createdBy ? (names.get(row.createdBy) ?? null) : null,
      })),
    canManage,
  };
}

const bodyText = () => z.string().overwrite(cleanBlock).trim().max(4000, "too_long");

export const CannedReplyInput = z.object({
  id: z.string().trim().max(128).optional(),
  key: z.string().trim().toLowerCase().min(2, "required").max(60, "too_long").regex(CANNED_KEY, "invalid"),
  title: z.string().overwrite(cleanLine).trim().min(2, "required").max(120, "too_long"),
  bodyAr: bodyText().min(2, "required"),
  bodyEn: bodyText().default(""),
  bodyCkb: bodyText().default(""),
  category: z.preprocess((value) => (value === "" ? null : value), z.enum(TICKET_CATEGORIES, "invalid").nullable().default(null)),
  isActive: z.boolean().default(true),
  /** updated_at of the reply the form was built from (a stale form is refused). */
  expectedUpdatedAt: z.number().int().optional(),
  reason: z.string().overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long"),
});

/** Creates or changes a canned reply; every body is checked for unknown variables and template code. */
export async function saveCannedReply(db: Db, actor: Actor, raw: z.input<typeof CannedReplyInput>, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "support.canned_reply.manage");
  const input = CannedReplyInput.parse(raw);
  const fields: Record<string, string> = {};
  const variables: CannedVariable[] = [];
  for (const [field, text] of [
    ["bodyAr", input.bodyAr],
    ["bodyEn", input.bodyEn],
    ["bodyCkb", input.bodyCkb],
  ] as const) {
    if (!text) continue;
    const check = checkTemplate(text);
    if (check.code) fields[field] = "template_code";
    else if (check.unknown.length > 0) fields[field] = "unknown_variable";
    for (const name of check.variables) if (!variables.includes(name)) variables.push(name);
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  const value: L10n = { ar: input.bodyAr, ...(input.bodyEn ? { en: input.bodyEn } : {}), ...(input.bodyCkb ? { ckb: input.bodyCkb } : {}) };
  const existing = input.id ? await db.select().from(cannedReplies).where(eq(cannedReplies.id, isId(input.id) ? input.id : "")).get() : undefined;
  if (input.id && !existing) throw notFound("canned_reply");
  if (existing && input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt) throw new AppError("reply_changed", 409, { detail: existing.id });
  const id = existing?.id ?? newId("cnr");
  const row = { key: input.key, title: input.title, body: value, category: input.category, variables, isActive: input.isActive, updatedAt: now };
  try {
    await runBatch(db, [
      existing
        ? db
            .update(cannedReplies)
            .set(row)
            .where(and(eq(cannedReplies.id, id), eq(cannedReplies.updatedAt, existing.updatedAt)))
        : db.insert(cannedReplies).values({ id, ...row, createdBy: actor.kind === "employee" ? actor.id : null }),
      ...(existing ? [expectChanged(db, 1, "REPLY_CHANGED")] : []),
      auditStatement(db, {
        actor,
        action: existing ? "support.canned.update" : "support.canned.create",
        entityType: "canned_reply",
        entityId: id,
        summary: input.key,
        before: existing ? { key: existing.key, title: existing.title, body: existing.body, category: existing.category, isActive: existing.isActive } : null,
        after: { key: input.key, title: input.title, body: value, category: input.category, variables, isActive: input.isActive },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error)) throw invalid({ key: "key_taken" });
    if (isDbError(error, "REPLY_CHANGED")) throw new AppError("reply_changed", 409, { detail: id });
    throw error;
  }
  return { id, created: !existing };
}

// ───────────────────────────────────────────────────────────────── values and preview

/**
 * The values of the safe variables for this ticket, in its language (null = no value: the agent fills it in). They
 * follow the ticket page's field rules: the account's name only with customers.customer.read, the order's status only
 * with orders.order.read — a canned reply never tells an agent what the page hides from them.
 */
export async function ticketVariables(db: Db, actor: Actor, ticket: SupportTicket, locale: Locale): Promise<Record<CannedVariable, string | null>> {
  const t = makeT(messages[locale], locale, "admin-support");
  const readCustomers = can(actor, "customers.customer.read");
  const readOrders = can(actor, "orders.order.read");
  const [customer, order, repair, product, warranty, me, contact] = await Promise.all([
    ticket.customerId && readCustomers ? db.select({ name: customers.name }).from(customers).where(eq(customers.id, ticket.customerId)).get() : Promise.resolve(undefined),
    ticket.orderId ? db.select({ ref: orders.ref, status: orders.status }).from(orders).where(eq(orders.id, ticket.orderId)).get() : Promise.resolve(undefined),
    ticket.repairTicketId ? db.select({ ref: repairTickets.ref, status: repairTickets.status }).from(repairTickets).where(eq(repairTickets.id, ticket.repairTicketId)).get() : Promise.resolve(undefined),
    ticket.productId ? db.select({ name: products.name }).from(products).where(eq(products.id, ticket.productId)).get() : Promise.resolve(undefined),
    ticket.warrantyId ? db.select({ endsAt: warranties.endsAt, status: warranties.status }).from(warranties).where(eq(warranties.id, ticket.warrantyId)).get() : Promise.resolve(undefined),
    actor.kind === "employee" ? db.select({ name: employees.name }).from(employees).where(eq(employees.id, actor.id)).get() : Promise.resolve(undefined),
    getSetting(db, "store.contact").catch(() => null),
  ]);
  const phone = contact?.phone ? normalizeIraqPhone(contact.phone) : null;
  const word = (key: string) => {
    const text = t(key);
    return text === key ? null : text;
  };
  return {
    customer_name: ticket.contactName?.trim() || customer?.name?.trim() || null,
    ticket_ref: ticket.ref,
    agent_name: me?.name ?? null,
    order_ref: order?.ref ?? null,
    order_status: order && readOrders ? word(`vars.orderStatus.${order.status}`) : null,
    repair_ref: repair?.ref ?? null,
    repair_status: repair ? word(`vars.repairStatus.${repair.status}`) : null,
    product_name: product ? pick(product.name, locale) || null : null,
    warranty_end: warranty && warranty.status !== "void" ? formatDate(warranty.endsAt, "long", locale, "latn") : null,
    store_phone: phone ? formatIraqPhone(phone) : null,
  };
}

export type CannedPreview = { text: string; missing: CannedVariable[]; locale: Locale; fallback: boolean; replyId: string; title: string };

/** A canned reply filled in for this ticket — what goes into the composer for the agent to review and edit. */
export async function previewCannedReply(db: Db, actor: Actor, raw: { ticketId?: string; replyId?: string }): Promise<CannedPreview> {
  assertCan(actor, "support.ticket.reply");
  const ticket = await ticketById(db, raw.ticketId);
  const reply = isId(raw.replyId) ? await db.select().from(cannedReplies).where(and(eq(cannedReplies.id, raw.replyId), eq(cannedReplies.isActive, true))).get() : undefined;
  if (!reply) throw notFound("canned_reply");
  const locale: Locale = isLocale(ticket.locale) ? ticket.locale : "ar";
  const own = reply.body[locale];
  const text = typeof own === "string" && own.trim() ? own : reply.body.ar;
  const values = await ticketVariables(db, actor, ticket, locale);
  const filled = fillTemplate(text, values);
  return { text: filled.text, missing: filled.missing, locale, fallback: !(typeof own === "string" && own.trim()), replyId: reply.id, title: reply.title };
}
