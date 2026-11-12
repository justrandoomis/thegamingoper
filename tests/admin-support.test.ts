/**
 * Admin module 14 "support" (owner: admin support) — the services under app/server/services/admin/support on a real
 * local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · authorization per role (support, manager, content, finance, cashier) and per field: phones masked without
 *     customer.phone.read_full, partial-number search refused, private photos only for ticket readers
 *   · the unified inbox (14.01): storefront tickets, assistant hand-offs and repair requests in one list; views, filters
 *   · replies held in the outbox (no provider), idempotent, never with an unfilled variable; the first-response clock;
 *     the shopper's ticket page shows the reply
 *   · status workflow, links kept by id with their consistency rules (14.02), assignment and "take"
 *   · routing by topic, priority and capacity with the reason recorded; capacity guarded; unmatched tickets not retried (14.03)
 *   · canned replies: safe variables only, no template code, preview in the ticket's language (14.04)
 *   · SLA policies and due times; metrics from the ticket events; satisfaction "not collected" (14.05)
 *   · the knowledge base through review: two people, revisions of approved articles, the storefront sees approved public only (14.06)
 *   · escalation to holders of the right permission, never oneself; only they resolve it (14.07)
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { systemActor, type EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { auditEvents, cannedReplies, customers, employeeRoles, files, knowledgeArticles, outbox, repairTickets, supportTickets, ticketMessages, warranties } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { customerFlags } from "~/server/services/admin/customers/flags.server";
import { articleBlocksToText, textToArticleBlocks } from "~/server/services/admin/support/article-text";
import { escalateTicket, escalationTargets, returnEscalation } from "~/server/services/admin/support/escalation.server";
import { listInbox, supportQueueCounts } from "~/server/services/admin/support/inbox.server";
import { archiveArticle, decideArticle, decideRevision, getArticleEditor, listArticles, saveArticle, submitArticle } from "~/server/services/admin/support/knowledge.server";
import { supportMetrics } from "~/server/services/admin/support/metrics.server";
import { listCannedReplies, previewCannedReply, saveCannedReply } from "~/server/services/admin/support/replies.server";
import { getRepairRequest } from "~/server/services/admin/support/repairs.server";
import { countWaitingToRoute, listRoutingRules, routeTicket, routeWaitingTickets, saveRoutingRule } from "~/server/services/admin/support/routing.server";
import { adoptSuggestedSla, applySlaToOpenTickets, listSlaPolicies, saveSlaPolicy } from "~/server/services/admin/support/sla.server";
import {
  addInternalNote,
  assignTicket,
  changeTicketStatus,
  getTicket,
  linkTicket,
  openStaffTicket,
  recordInboundMessage,
  replyToTicket,
  supportPhotoFile,
  triageTicket,
} from "~/server/services/admin/support/tickets.server";
import { checkTemplate, fillTemplate, inboxSearch, normalizeMatchText, parseInboxFilters, pickAgent, ruleMatches, slaClock, unfilledPlaceholders } from "~/server/services/admin/support/types";
import { getArticle } from "~/server/services/support/kb.server";
import { createRepairTicket } from "~/server/services/support/repairs.server";
import { createSupportTicket, getTicketByAccessToken } from "~/server/services/support/tickets.server";
import type { SupportWho } from "~/server/services/support/common.server";
import messages from "~/i18n/messages/admin-support";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const urls = { file: (id: string) => `/admin/support/files/${id}` };

let t: TestDb;
let make: Fixtures;
type Key = DefaultRoleKey | "support2" | "manager2";
const staff: Partial<Record<Key, EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "support", "cashier", "content", "inventory"] as const) staff[key] = await employee(key);
  staff.support2 = await employee("support");
  staff.manager2 = await employee("manager");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}
const as = (key: Key): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
/** The same person with other permissions (custom roles). */
const custom = (base: Key, permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: as(base).id, permissions: new Set(permissions) });

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (appError) return appError;
    throw error;
  }
  throw new Error("expected a failure");
}

let ipCounter = 0;
const who = (overrides: Partial<SupportWho> = {}): SupportWho => ({ customerId: null, ip: `203.0.113.${++ipCounter}`, storeMode: "live", ...overrides });
let phoneCounter = 0;
const freshPhone = () => `0771${String(1_000_000 + ++phoneCounter).slice(-7)}`;

/** A storefront ticket (the shopper's form), returned with its row. */
async function storefrontTicket(options: { category?: string; subject?: string; message?: string; phone?: string; customerId?: string | null; now?: number } = {}) {
  const created = await createSupportTicket(
    t.db,
    who({ customerId: options.customerId ?? null }),
    { idempotencyKey: randomToken(), phone: options.phone ?? freshPhone(), contactName: "سارة", subject: options.subject ?? "سؤال عن الطلب", message: options.message ?? "أين طلبي؟", category: options.category ?? "order", locale: "ar" },
    options.now ?? NOW,
  );
  const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, created.ticketId)).get();
  return { ...created, row: row! };
}

const reply = (ticketId: string, body = "شكراً، طلبك في الطريق.", extra: Partial<Parameters<typeof replyToTicket>[2]> = {}) =>
  replyToTicket(t.db, as("support"), { ticketId, body, via: "whatsapp", then: "pending_customer", idempotencyKey: randomToken(), ...extra }, NOW + HOUR);

// ───────────────────────────────────────────────────────────────── pure pieces

describe("pure helpers", () => {
  test("canned reply bodies: safe {variables} only, no template code; filling leaves the unknown as it is", () => {
    expect(checkTemplate("مرحباً {customer_name}، طلبك {order_ref}.")).toEqual({ variables: ["customer_name", "order_ref"], unknown: [], code: false });
    expect(checkTemplate("Hi {first_name}").unknown).toEqual(["first_name"]);
    for (const code of ["{{customer_name}}", "{customer_name.length}", "{#if order_ref}x{/if}", "${customer_name}", "a } b", "{ customer_name }"]) expect(checkTemplate(code).code, code).toBe(true);
    expect(fillTemplate("{customer_name} · {order_ref}", { customer_name: "سارة", order_ref: null })).toEqual({ text: "سارة · {order_ref}", missing: ["order_ref"] });
    expect(fillTemplate("{customer_name}", { customer_name: "<b>x</b>" }).text).toBe("<b>x</b>"); // text, never markup: rendered as a text node
    expect(unfilledPlaceholders("done {order_ref} and {x}")).toEqual(["order_ref", "x"]);
  });

  test("routing matcher: every list given must match; keywords ignore case, diacritics and letter variants", () => {
    expect(normalizeMatchText("إسترجاعُ المبلغ ٣")).toBe("استرجاع المبلغ 3");
    const facts = { category: "payment" as const, channel: "web" as const, priority: "normal" as const, text: "تحويل زين كاش لم يصل" };
    expect(ruleMatches({}, facts)).toEqual({});
    expect(ruleMatches({ categories: ["payment"], keywords: ["زين"] }, facts)).toEqual({ category: "payment", keyword: "زين" });
    expect(ruleMatches({ categories: ["payment"], channels: ["whatsapp"] }, facts)).toBeNull();
    expect(ruleMatches({ keywords: ["refund"] }, facts)).toBeNull();
    expect(pickAgent([], 5)).toEqual({ agent: null, why: "pool_empty" });
    expect(pickAgent([{ id: "a", name: "A", open: 5 }], 5)).toEqual({ agent: null, why: "capacity_full" });
    expect(pickAgent([{ id: "a", name: "A", open: 3 }, { id: "b", name: "B", open: 1 }, { id: "c", name: "C", open: 1 }], 5).agent?.id).toBe("b");
  });

  test("SLA clock and inbox URL state", () => {
    expect(slaClock(null, null, NOW)).toBe("none");
    expect(slaClock(NOW + 1, null, NOW)).toBe("running");
    expect(slaClock(NOW - 1, null, NOW)).toBe("late");
    expect(slaClock(NOW, NOW - 5, NOW)).toBe("met");
    expect(slaClock(NOW, NOW + 5, NOW)).toBe("breached");
    const filters = parseInboxFilters(new URLSearchParams("view=late&kind=ticket&priority=high&q=%20SP-ABC%20&page=2&sort=due&status=bogus"));
    expect(filters).toMatchObject({ view: "late", kind: "ticket", priority: "high", q: "SP-ABC", page: 2, sort: "due", status: null });
    expect(inboxSearch(filters)).toBe("?view=late&kind=ticket&priority=high&q=SP-ABC&sort=due&page=2");
    expect(inboxSearch(parseInboxFilters(new URLSearchParams("")))).toBe("");
  });

  test("article lines keep the catalogue photos", () => {
    const blocks = textToArticleBlocks("## خطوات\n- افصل الجهاز\n[photo] ps5-slim--1 | الجهاز من الأمام\n[warning] انتبه | لا تفتح الغطاء");
    expect(blocks.map((block) => block.type)).toEqual(["h2", "ul", "art", "callout"]);
    expect(textToArticleBlocks(articleBlocksToText(blocks))).toEqual(blocks);
  });

  test("the messages cover every variable word in three languages", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      expect(Object.keys(messages[locale].vars.repairStatus).sort()).toEqual(["awaiting_approval", "awaiting_parts", "cancelled", "delivered", "diagnosing", "ready", "received", "repairing", "submitted", "unrepairable"]);
    }
  });
});

// ───────────────────────────────────────────────────────────────── inbox (14.01)

describe("the unified inbox", () => {
  test("tickets, assistant hand-offs and repair requests in one list, by view, kind and search", async () => {
    const phone = freshPhone();
    const ticket = await storefrontTicket({ phone, subject: "طلبي متأخر" });
    const repair = await createRepairTicket(t.db, who(), { idempotencyKey: randomToken(), device: "other", deviceText: "PS4 Pro", issue: "الجهاز يطفئ بعد خمس دقائق من التشغيل", phone }, NOW);

    const open = await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams("")), NOW);
    expect(open.rows.map((row) => row.ref)).toEqual(expect.arrayContaining([ticket.ref, repair.ref]));
    expect(open.rows.find((row) => row.ref === repair.ref)).toMatchObject({ kind: "repair", status: "submitted", category: "repair" });

    const tickets = await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams("kind=ticket")), NOW);
    expect(tickets.rows.every((row) => row.kind === "ticket")).toBe(true);
    const repairs = await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams("view=repairs")), NOW);
    expect(repairs.rows.every((row) => row.kind === "repair")).toBe(true);

    const byPhone = await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams(`q=${phone}`)), NOW);
    expect(byPhone.rows.map((row) => row.ref).sort()).toEqual([ticket.ref, repair.ref].sort());
    const byRef = await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams(`q=${ticket.ref.toLowerCase()}`)), NOW);
    expect(byRef.rows.map((row) => row.ref)).toEqual([ticket.ref]);
    expect(open.counts.needs_reply).toBeGreaterThanOrEqual(2);
  });

  test("who may read it, and phones as each may see them", async () => {
    const phone = freshPhone();
    await storefrontTicket({ phone });
    for (const key of ["cashier", "content", "finance", "inventory"] as const) expect((await failure(listInbox(t.db, as(key), parseInboxFilters(new URLSearchParams("")), NOW))).status, key).toBe(403);
    const masked = custom("support", ["support.ticket.read"]);
    const page = await listInbox(t.db, masked, parseInboxFilters(new URLSearchParams(`q=${phone}`)), NOW);
    expect(page.rows[0].phone).toMatchObject({ full: false });
    expect(page.rows[0].phone?.display).toContain("•");
    // a part of a number finds nothing for whoever may not see whole numbers (the match would reveal the digits)
    const part = phone.slice(-6);
    expect((await listInbox(t.db, masked, parseInboxFilters(new URLSearchParams(`q=${part}`)), NOW)).total).toBe(0);
    expect((await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams(`q=${part}`)), NOW)).total).toBeGreaterThanOrEqual(1);
  });
});

// ───────────────────────────────────────────────────────────────── replies, status, links (14.01, 14.02)

describe("working a ticket", () => {
  test("a reply is held in the outbox (no provider), stops the first-response clock, is idempotent and reaches the shopper's page", async () => {
    const ticket = await storefrontTicket();
    const key = randomToken();
    const first = await reply(ticket.ticketId, "تم شحن طلبك اليوم.", { idempotencyKey: key });
    expect(first).toMatchObject({ held: true, replayed: false, status: "pending_customer" });
    const again = await reply(ticket.ticketId, "تم شحن طلبك اليوم.", { idempotencyKey: key });
    expect(again.replayed).toBe(true);
    const rows = await t.db.select().from(ticketMessages).where(and(eq(ticketMessages.ticketId, ticket.ticketId), eq(ticketMessages.authorKind, "employee")));
    expect(rows).toHaveLength(1);
    const held = await t.db.select().from(outbox).where(eq(outbox.refId, ticket.ticketId));
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ status: "held", channel: "whatsapp", template: "support_reply" });
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get();
    expect(row?.firstRespondedAt).toBe(NOW + HOUR);
    // the shopper's ticket page (the storefront's service) shows the reply, never internal notes
    await addInternalNote(t.db, as("support"), { ticketId: ticket.ticketId, body: "ملاحظة داخلية لا يراها الزبون", idempotencyKey: randomToken() }, NOW + HOUR);
    const receipt = await getTicketByAccessToken(t.db, ticket.ref, ticket.accessToken);
    expect(receipt?.replies.map((r) => r.body)).toEqual(["تم شحن طلبك اليوم."]);
    const detail = await getTicket(t.db, as("support"), ticket.ref, "ar", NOW + 2 * HOUR, urls);
    expect(detail.sla.firstResponse.doneAt).toBe(NOW + HOUR);
    const message = detail.timeline.find((item) => item.kind === "message" && item.author === "employee" && !item.internal);
    expect(message).toMatchObject({ via: "whatsapp", outbox: { status: "held" } });
  });

  test("a reply is refused while a {variable} is unfilled, on a channel the ticket has no address for, and on a closed ticket", async () => {
    const ticket = await storefrontTicket();
    expect((await failure(reply(ticket.ticketId, "طلبك {order_ref} في الطريق"))).fields).toMatchObject({ body: "unfilled_variable" });
    expect((await failure(reply(ticket.ticketId, "أهلاً", { via: "email" }))).fields).toMatchObject({ via: "no_email" });
    await changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "open", to: "closed", reason: "مكرر" }, NOW);
    expect((await failure(reply(ticket.ticketId))).code).toBe("ticket_closed");
    // a call is recorded as a call: nothing goes to the outbox
    const other = await storefrontTicket();
    await reply(other.ticketId, "اتصلت بالزبون وشرحت له.", { via: "call" });
    expect(await t.db.select().from(outbox).where(eq(outbox.refId, other.ticketId))).toHaveLength(0);
  });

  test("status workflow: reasons, the close permission, stale pages, reopening clears the resolution", async () => {
    const ticket = await storefrontTicket();
    expect((await failure(changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "open", to: "on_hold" }, NOW))).fields).toMatchObject({ reason: "reason_required" });
    const noClose = custom("support", ["support.ticket.read", "support.ticket.reply"]);
    expect((await failure(changeTicketStatus(t.db, noClose, { ticketId: ticket.ticketId, from: "open", to: "closed", reason: "مكرر" }, NOW))).status).toBe(403);
    await changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "open", to: "resolved", reason: "شرحنا الخطوات" }, NOW + HOUR);
    expect((await failure(changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "open", to: "pending_staff" }, NOW))).code).toBe("ticket_changed");
    expect((await failure(changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "resolved", to: "pending_staff" }, NOW))).code).toBe("transition_not_allowed");
    await changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "resolved", to: "open", reason: "عاد الزبون بنفس المشكلة" }, NOW + 2 * HOUR);
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get();
    expect(row).toMatchObject({ status: "open", resolvedAt: null });
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, ticket.ticketId), eq(auditEvents.action, "support.ticket.status")));
    expect(events.map((event) => event.reason)).toEqual(["شرحنا الخطوات", "عاد الزبون بنفس المشكلة"]);
  });

  test("a customer message staff record makes the ticket wait for staff again", async () => {
    const ticket = await storefrontTicket();
    await reply(ticket.ticketId);
    const result = await recordInboundMessage(t.db, as("support"), { ticketId: ticket.ticketId, body: "وصلني الطلب ناقص قطعة", via: "whatsapp", idempotencyKey: randomToken() }, NOW + 2 * HOUR);
    expect(result.status).toBe("pending_staff");
    const detail = await getTicket(t.db, as("support"), ticket.ref, "ar", NOW + 3 * HOUR, urls);
    const recorded = detail.timeline.find((item) => item.kind === "message" && item.author === "customer" && item.via === "whatsapp");
    expect(recorded && recorded.kind === "message" ? recorded.recordedBy : null).toBeTruthy();
  });

  test("links are kept by id and must agree with the ticket's customer and order", async () => {
    const product = await make.product();
    const customerA = await make.customer();
    const customerB = await make.customer();
    const orderA = await make.order([{ variantId: product.variantId, sku: product.sku }], { customerId: customerA });
    const orderB = await make.order([{ variantId: product.variantId, sku: product.sku }], { customerId: customerB });
    const warrantyB = newId("wty");
    await t.db.insert(warranties).values({ id: warrantyB, orderItemId: orderB.itemIds[0], customerId: customerB, startsAt: NOW, endsAt: NOW + 365 * 24 * HOUR, createdAt: NOW });
    const ticket = await storefrontTicket({ customerId: customerA });
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "order", value: orderA.ref }, NOW);
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "order", value: orderB.ref }, NOW))).code).toBe("order_other_customer");
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "warranty", value: warrantyB }, NOW))).code).toMatch(/order_other_customer|warranty_other_order/);
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "order", value: "TT-NOPE9999" }, NOW))).fields).toMatchObject({ value: "link_not_found" });
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "product", value: product.sku }, NOW);
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get();
    expect(row).toMatchObject({ orderId: orderA.orderId, productId: product.productId });
    const detail = await getTicket(t.db, as("support"), ticket.ref, "ar", NOW, urls);
    expect(detail.order).toMatchObject({ ref: orderA.ref, href: `/admin/orders/${orderA.ref}` });
    expect(detail.customer?.href).toBe(`/admin/customers/${customerA}`);
    // without the orders permission the order shows by its reference only
    const reader = custom("support", ["support.ticket.read"]);
    expect((await getTicket(t.db, reader, ticket.ref, "ar", NOW, urls)).order).toMatchObject({ ref: orderA.ref, href: null, status: null });
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "product", value: "" }, NOW);
    expect((await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get())?.productId).toBeNull();
  });

  test("assignment: assign, take an unassigned ticket, never to someone who cannot answer, never over a stale page", async () => {
    const ticket = await storefrontTicket();
    const replyOnly = custom("support2", ["support.ticket.read", "support.ticket.reply"]);
    await assignTicket(t.db, replyOnly, { ticketId: ticket.ticketId, employeeId: as("support2").id, expected: "" }, NOW);
    expect((await failure(assignTicket(t.db, custom("support", ["support.ticket.read", "support.ticket.reply"]), { ticketId: ticket.ticketId, employeeId: as("support").id, expected: as("support2").id }, NOW))).code).toBe("take_only_unassigned");
    expect((await failure(assignTicket(t.db, as("manager"), { ticketId: ticket.ticketId, employeeId: as("cashier").id, expected: as("support2").id }, NOW))).code).toBe("assignee_not_agent");
    expect((await failure(assignTicket(t.db, as("manager"), { ticketId: ticket.ticketId, employeeId: as("support").id, expected: "" }, NOW))).code).toBe("ticket_changed");
    await assignTicket(t.db, as("manager"), { ticketId: ticket.ticketId, employeeId: as("support").id, expected: as("support2").id }, NOW);
    expect((await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get())?.assignedTo).toBe(as("support").id);
  });

  test("a ticket staff open for a call: contact required, the account linked by phone, idempotent", async () => {
    const customerId = await make.customer();
    const account = await t.db.select().from(customers).where(eq(customers.id, customerId)).get();
    expect((await failure(openStaffTicket(t.db, as("support"), { channel: "phone", subject: "سؤال", idempotencyKey: randomToken() }, NOW))).fields).toMatchObject({ phone: "contact_required" });
    const key = randomToken();
    const input = { channel: "phone" as const, phone: account!.phoneE164, subject: "يسأل عن الضمان", category: "warranty" as const, message: "اشتريت الجهاز قبل شهر", idempotencyKey: key };
    const first = await openStaffTicket(t.db, as("support"), input, NOW);
    const second = await openStaffTicket(t.db, as("support"), input, NOW);
    expect(second).toMatchObject({ ref: first.ref, replayed: true });
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, first.ticketId)).get();
    expect(row).toMatchObject({ customerId, channel: "phone", assignedTo: as("support").id, status: "open" });
    expect((await failure(openStaffTicket(t.db, as("cashier"), { ...input, idempotencyKey: randomToken() }, NOW))).status).toBe(403);
  });

  test("private photos: ticket and repair photos for ticket readers only, nothing else", async () => {
    const ticket = await storefrontTicket();
    const photo = newId("fil");
    const proof = newId("fil");
    await t.db.insert(files).values([
      { id: photo, storageKey: `prv_${photo}`, visibility: "private", kind: "support_photo", mime: "image/png", bytes: 10, sha256: "x", ownerType: "support_ticket", ownerId: ticket.ticketId, createdAt: NOW },
      { id: proof, storageKey: `prv_${proof}`, visibility: "private", kind: "payment_proof", mime: "image/png", bytes: 10, sha256: "y", ownerType: "payment", ownerId: "pay_x", createdAt: NOW },
    ]);
    expect(await supportPhotoFile(t.db, as("support"), photo)).toEqual({ id: photo });
    expect(await supportPhotoFile(t.db, as("support"), proof)).toBeNull();
    expect((await failure(supportPhotoFile(t.db, as("cashier"), photo))).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────── routing (14.03)

describe("routing", () => {
  test("rules by topic and capacity assign the least-loaded agent, queue the rest, and record why", async () => {
    const reason = "قاعدة تجريبية للاختبار";
    expect((await failure(saveRoutingRule(t.db, as("support"), { name: "قاعدة", categories: ["payment"], team: "payments", reason }, NOW))).status).toBe(403);
    expect((await failure(saveRoutingRule(t.db, as("manager"), { name: "قاعدة", categories: ["payment"], agents: [as("cashier").id], reason }, NOW))).fields).toMatchObject({ agents: "assignee_not_agent" });
    expect((await failure(saveRoutingRule(t.db, as("manager"), { name: "قاعدة", categories: ["payment"], reason }, NOW))).fields).toMatchObject({ team: "rule_does_nothing" });
    await saveRoutingRule(t.db, as("manager"), { name: "المدفوعات", categories: ["payment"], keywords: "تحويل، زين كاش", agents: [as("support").id, as("support2").id], capacity: 1, team: "payments", reason }, NOW);

    // whatever the two agents already hold counts against the capacity: free them first
    await t.db.update(supportTickets).set({ assignedTo: null }).where(sql`${supportTickets.assignedTo} IN (${as("support").id}, ${as("support2").id})`);
    const tickets = [];
    for (let i = 0; i < 3; i++) tickets.push(await storefrontTicket({ category: "payment", subject: `تحويل زين كاش رقم ${i}`, message: "حولت المبلغ ولم يتأكد الطلب" }));
    const unmatched = await storefrontTicket({ category: "other", subject: "سؤال عام", message: "متى تفتحون؟" });
    expect(await countWaitingToRoute(t.db)).toBeGreaterThanOrEqual(4);
    const run = await routeWaitingTickets(t.db, systemActor("support.route"), NOW);
    expect(run.assigned).toBeGreaterThanOrEqual(2);
    const rows = await Promise.all(tickets.map((ticket) => t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get()));
    const holders = rows.map((row) => row?.assignedTo);
    expect(holders.filter((id) => id === as("support").id)).toHaveLength(1);
    expect(holders.filter((id) => id === as("support2").id)).toHaveLength(1);
    expect(holders.filter((id) => id === null)).toHaveLength(1);
    expect(rows.every((row) => row?.team === "payments")).toBe(true);
    // the reason is on record, in words the ticket page renders
    const queued = tickets[holders.indexOf(null)];
    const detail = await getTicket(t.db, as("support"), queued.ref, "ar", NOW, urls);
    expect(detail.routing?.decision).toMatchObject({ ruleName: "المدفوعات", matched: { category: "payment", keyword: "تحويل" }, agent: null, fallback: "capacity_full", team: "payments" });
    const assigned = await getTicket(t.db, as("support"), tickets[holders.findIndex((id) => id !== null)].ref, "ar", NOW, urls);
    expect(assigned.routing?.decision.agent).toMatchObject({ open: 0, capacity: 1 });
    // a ticket no rule matched is recorded once and not tried again
    expect((await getTicket(t.db, as("support"), unmatched.ref, "ar", NOW, urls)).routing?.decision.fallback).toBe("no_rule");
    const second = await routeWaitingTickets(t.db, systemActor("support.route"), NOW);
    expect(second.routed).toBe(0);
    // routing again by hand (an assigner) records a new decision
    const forced = await routeTicket(t.db, as("manager"), { ticketId: unmatched.ticketId }, NOW + HOUR);
    expect(forced.fallback).toBe("no_rule");
    expect((await listRoutingRules(t.db, as("support"))).agents.find((agent) => agent.id === as("support").id)?.open).toBeGreaterThanOrEqual(1);
    expect((await failure(routeTicket(t.db, as("cashier"), { ticketId: unmatched.ticketId }, NOW))).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────────── SLA (14.05)

describe("SLA policies and due times", () => {
  test("tickets get due times from the policies (the storefront's rule), open tickets without them can be filled, priority moves them", async () => {
    const before = await storefrontTicket({ category: "shipping" });
    expect(before.row.firstResponseDueAt).toBeNull();
    expect((await failure(adoptSuggestedSla(t.db, as("support"), { reason: "اعتماد الأهداف" }, NOW))).status).toBe(403);
    expect((await adoptSuggestedSla(t.db, as("manager"), { reason: "اعتماد الأهداف المقترحة" }, NOW)).added).toBe(4);
    expect((await failure(adoptSuggestedSla(t.db, as("manager"), { reason: "مرة ثانية" }, NOW))).code).toBe("nothing_to_apply");
    const policies = await listSlaPolicies(t.db, as("support"));
    expect(policies.policies).toHaveLength(4);
    expect((await failure(saveSlaPolicy(t.db, as("manager"), { name: "مكرر", priority: "normal", category: null, firstResponseMinutes: 60, resolutionMinutes: 600, reason: "تجربة" }, NOW))).code).toBe("policy_duplicate");
    await saveSlaPolicy(t.db, as("manager"), { name: "شكاوى الدفع", priority: "normal", category: "payment", firstResponseMinutes: 30, resolutionMinutes: 600, reason: "الدفع أسرع" }, NOW);
    expect((await failure(saveSlaPolicy(t.db, as("manager"), { name: "عكس", priority: "low", category: "other", firstResponseMinutes: 600, resolutionMinutes: 60, reason: "خطأ" }, NOW))).fields).toMatchObject({ resolutionMinutes: "resolution_before_response" });

    const created = await storefrontTicket({ category: "payment" });
    expect(created.row.firstResponseDueAt).toBe(NOW + 30 * 60_000);
    const applied = await applySlaToOpenTickets(t.db, as("manager"), { reason: "تذاكر قديمة بلا أهداف" }, NOW);
    expect(applied.updated).toBeGreaterThanOrEqual(1);
    const filled = await t.db.select().from(supportTickets).where(eq(supportTickets.id, before.ticketId)).get();
    expect(filled?.firstResponseDueAt).toBe(before.row.createdAt + 8 * 60 * 60_000);
    await triageTicket(t.db, as("manager"), { ticketId: before.ticketId, priority: "urgent", category: "shipping", expectedUpdatedAt: filled!.updatedAt }, NOW + 5);
    expect((await t.db.select().from(supportTickets).where(eq(supportTickets.id, before.ticketId)).get())?.firstResponseDueAt).toBe(before.row.createdAt + 60 * 60_000);
    expect((await failure(triageTicket(t.db, as("manager"), { ticketId: before.ticketId, priority: "low", category: "shipping", expectedUpdatedAt: filled!.updatedAt }, NOW))).code).toBe("ticket_changed");
  });
});

// ───────────────────────────────────────────────────────────────── canned replies (14.04)

describe("canned replies", () => {
  test("only safe variables, filled from the ticket in its language, reviewed before recording", async () => {
    const reason = "رد شائع";
    expect((await failure(saveCannedReply(t.db, as("support"), { key: "bad-var", title: "رد", bodyAr: "مرحباً {first_name}", reason }, NOW))).fields).toMatchObject({ bodyAr: "unknown_variable" });
    expect((await failure(saveCannedReply(t.db, as("support"), { key: "bad-code", title: "رد", bodyAr: "مرحباً {{customer_name}}", reason }, NOW))).fields).toMatchObject({ bodyAr: "template_code" });
    expect((await failure(saveCannedReply(t.db, as("content"), { key: "content", title: "رد", bodyAr: "مرحباً", reason }, NOW))).status).toBe(403);
    const saved = await saveCannedReply(t.db, as("support"), { key: "order-shipped", title: "تم الشحن", bodyAr: "مرحباً {customer_name}، طلبك {order_ref} حالته الآن: {order_status}. — {agent_name}", bodyEn: "Hello {customer_name}, order {order_ref} is now {order_status}. — {agent_name}", reason }, NOW);
    expect((await failure(saveCannedReply(t.db, as("support"), { key: "order-shipped", title: "مكرر", bodyAr: "نص", reason }, NOW))).fields).toMatchObject({ key: "key_taken" });
    const stored = await t.db.select().from(cannedReplies).where(eq(cannedReplies.id, saved.id)).get();
    expect(stored?.variables).toEqual(["customer_name", "order_ref", "order_status", "agent_name"]);

    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], { status: "shipped" });
    const ticket = await storefrontTicket();
    const missing = await previewCannedReply(t.db, as("support"), { ticketId: ticket.ticketId, replyId: saved.id });
    expect(missing.missing).toEqual(["order_ref", "order_status"]);
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "order", value: order.ref }, NOW);
    const preview = await previewCannedReply(t.db, as("support"), { ticketId: ticket.ticketId, replyId: saved.id });
    expect(preview.missing).toEqual([]);
    expect(preview.text).toContain(order.ref);
    expect(preview.text).toContain("تم الشحن");
    expect(preview.text).toContain("سارة");
    // an English-speaking shopper gets the English body; a Sorani one falls back to Arabic, said so
    await t.db.update(supportTickets).set({ locale: "ckb" }).where(eq(supportTickets.id, ticket.ticketId));
    expect((await previewCannedReply(t.db, as("support"), { ticketId: ticket.ticketId, replyId: saved.id })).fallback).toBe(true);
    // the reviewed text is recorded with where it came from
    await reply(ticket.ticketId, preview.text, { cannedReplyId: saved.id, edited: false });
    const detail = await getTicket(t.db, as("support"), ticket.ref, "ar", NOW + HOUR, urls);
    expect(detail.timeline.some((item) => item.kind === "message" && item.fromCanned?.edited === false)).toBe(true);
    expect((await listCannedReplies(t.db, as("support"))).rows.map((row) => row.key)).toContain("order-shipped");
  });
});

// ───────────────────────────────────────────────────────────────── escalation (14.07)

describe("escalation", () => {
  test("to a holder of the right permission who can open the ticket, never oneself; only they close it; nothing is paid here", async () => {
    const customerId = await make.customer();
    const ticket = await storefrontTicket({ category: "payment", customerId });
    const targets = await escalationTargets(t.db, as("support"));
    // finance holds refunds but cannot open tickets (no support.ticket.read): not offered
    expect(targets.financial.map((person) => person.id)).toContain(as("manager").id);
    expect(targets.financial.map((person) => person.id)).not.toContain(as("finance").id);
    expect(targets.financial.map((person) => person.id)).not.toContain(as("support").id);
    expect((await failure(escalateTicket(t.db, as("cashier"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason: "الزبون يطلب استرداد المبلغ" }, NOW))).status).toBe(403);
    expect((await failure(escalateTicket(t.db, as("manager"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason: "الزبون يطلب استرداد المبلغ" }, NOW))).code).toBe("escalation_self");
    expect((await failure(escalateTicket(t.db, as("support"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("finance").id, reason: "الزبون يطلب استرداد المبلغ" }, NOW))).code).toBe("escalation_target");
    const result = await escalateTicket(t.db, as("support"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason: "الزبون يطلب استرداد المبلغ كاملاً" }, NOW);
    expect(result.priority).toBe("high");
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.ticketId)).get();
    expect(row).toMatchObject({ escalatedTo: as("manager").id, status: "pending_staff", priority: "high" });
    // the customer's profile counts it as an open complaint (module 07's rule)
    expect((await customerFlags(t.db, [customerId], NOW)).get(customerId)?.map((flag) => flag.id)).toContain("complaint_open");
    expect((await supportQueueCounts(t.db, as("manager"), NOW)).escalatedToMe).toBeGreaterThanOrEqual(1);
    expect((await listInbox(t.db, as("manager"), parseInboxFilters(new URLSearchParams("view=escalated_me")), NOW)).rows.map((r) => r.ref)).toContain(ticket.ref);
    // the agent cannot resolve it while it is escalated
    expect((await failure(changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "pending_staff", to: "resolved", reason: "تم الحل" }, NOW))).code).toBe("escalation_open");
    expect((await failure(returnEscalation(t.db, as("support2"), { ticketId: ticket.ticketId, outcome: "لا شيء بعد هنا" }, NOW))).status).toBe(403);
    await returnEscalation(t.db, as("manager"), { ticketId: ticket.ticketId, outcome: "اعتمدنا الاسترداد في قسم الطلبات" }, NOW + HOUR);
    await changeTicketStatus(t.db, as("support"), { ticketId: ticket.ticketId, from: "pending_staff", to: "resolved", reason: "أبلغنا الزبون بالاسترداد" }, NOW + 2 * HOUR);
    const detail = await getTicket(t.db, as("support"), ticket.ref, "ar", NOW + 3 * HOUR, urls);
    expect(detail.escalation).toMatchObject({ kind: "financial", handedBack: true });
    expect(detail.timeline.map((item) => (item.kind === "event" ? item.action : null)).filter(Boolean)).toEqual(expect.arrayContaining(["escalate", "escalation_return", "status"]));
  });
});

// ───────────────────────────────────────────────────────────────── knowledge (14.06)

describe("the knowledge base through review", () => {
  const form = (slug: string, overrides: Record<string, unknown> = {}) => ({ slug, kind: "guide" as const, audience: "public" as const, titleAr: "تنظيف مراوح الجهاز", bodyAr: "## قبل أن تبدأ\nافصل الجهاز عن الكهرباء.\n- استعمل فرشاة ناعمة", reason: "مقال جديد", ...overrides });

  test("two people: the writer submits, someone who did not edit approves; only then the help centre shows it", async () => {
    const draft = await saveArticle(t.db, as("content"), form("clean-the-fans"), NOW);
    expect(await getArticle(t.db, "ar", "clean-the-fans")).toBeNull();
    let editor = await getArticleEditor(t.db, as("content"), draft.articleId);
    expect(editor.status).toBe("draft");
    await submitArticle(t.db, as("content"), { articleId: draft.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 1);
    editor = await getArticleEditor(t.db, as("manager"), draft.articleId);
    expect((await failure(decideArticle(t.db, as("content"), { articleId: draft.articleId, decision: "approve", expectedUpdatedAt: editor.updatedAt }, NOW + 2))).status).toBe(403);
    // the manager fixes a word during review — now the manager cannot approve this version either
    await saveArticle(t.db, as("manager"), { ...form("clean-the-fans", { titleAr: "تنظيف مراوح الجهاز بأمان" }), articleId: draft.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 3);
    editor = await getArticleEditor(t.db, as("manager"), draft.articleId);
    expect(editor.approveBlocked).toBe("editor");
    expect((await failure(decideArticle(t.db, as("manager"), { articleId: draft.articleId, decision: "approve", expectedUpdatedAt: editor.updatedAt }, NOW + 4))).code).toBe("approver_is_editor");
    await decideArticle(t.db, as("manager2"), { articleId: draft.articleId, decision: "approve", expectedUpdatedAt: editor.updatedAt }, NOW + 5);
    expect((await getArticle(t.db, "ar", "clean-the-fans"))?.title).toBe("تنظيف مراوح الجهاز بأمان");
  });

  test("an approved article is changed only through an approved revision; slug locked; internal articles never public", async () => {
    const created = await saveArticle(t.db, as("content"), form("reset-controller"), NOW);
    let editor = await getArticleEditor(t.db, as("content"), created.articleId);
    await submitArticle(t.db, as("content"), { articleId: created.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 1);
    editor = await getArticleEditor(t.db, as("manager"), created.articleId);
    await decideArticle(t.db, as("manager"), { articleId: created.articleId, decision: "approve", expectedUpdatedAt: editor.updatedAt }, NOW + 2);
    editor = await getArticleEditor(t.db, as("content"), created.articleId);
    expect(editor.slugLocked).toBe(true);
    expect((await failure(saveArticle(t.db, as("content"), { ...form("reset-controller-2"), articleId: created.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 3))).fields).toMatchObject({ slug: "slug_locked" });
    const revision = await saveArticle(t.db, as("content"), { ...form("reset-controller", { titleAr: "إعادة ضبط يد التحكم" }), articleId: created.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 3);
    expect(revision.revision).toBe(true);
    // the help centre still shows the approved text
    expect((await getArticle(t.db, "ar", "reset-controller"))?.title).toBe("تنظيف مراوح الجهاز");
    editor = await getArticleEditor(t.db, as("manager"), created.articleId);
    expect(editor.revision).not.toBeNull();
    expect((await failure(decideRevision(t.db, as("content"), { articleId: created.articleId, revisionId: editor.revision!.id, decision: "approve" }, NOW + 4))).status).toBe(403);
    await decideRevision(t.db, as("manager"), { articleId: created.articleId, revisionId: editor.revision!.id, savedAt: editor.revision!.savedAt, decision: "approve" }, NOW + 4);
    expect((await getArticle(t.db, "ar", "reset-controller"))?.title).toBe("إعادة ضبط يد التحكم");
    // a stale form is refused
    expect((await failure(saveArticle(t.db, as("content"), { ...form("reset-controller"), articleId: created.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 5))).code).toBe("article_changed");
    // archived: gone from the help centre
    editor = await getArticleEditor(t.db, as("content"), created.articleId);
    await archiveArticle(t.db, as("content"), { articleId: created.articleId, expectedUpdatedAt: editor.updatedAt, reason: "لم يعد صحيحاً" }, NOW + 6);
    expect(await getArticle(t.db, "ar", "reset-controller")).toBeNull();

    const internal = await saveArticle(t.db, as("content"), form("internal-refund-script", { audience: "internal", titleAr: "نص داخلي لطلبات الاسترداد" }), NOW);
    editor = await getArticleEditor(t.db, as("content"), internal.articleId);
    await submitArticle(t.db, as("content"), { articleId: internal.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 1);
    editor = await getArticleEditor(t.db, as("manager"), internal.articleId);
    await decideArticle(t.db, as("manager"), { articleId: internal.articleId, decision: "approve", expectedUpdatedAt: editor.updatedAt }, NOW + 2);
    expect(await getArticle(t.db, "ar", "internal-refund-script")).toBeNull();
    // agents read approved articles (internal ones are their knowledge base), never drafts
    const agentList = await listArticles(t.db, custom("support", ["support.ticket.read"]), { view: "all", q: "" }, "ar");
    expect(agentList.rows.map((row) => row.slug)).toContain("internal-refund-script");
    expect(agentList.rows.every((row) => row.status === "approved")).toBe(true);
    expect((await failure(listArticles(t.db, as("cashier"), { view: "all", q: "" }, "ar"))).status).toBe(403);
    expect((await failure(saveArticle(t.db, as("content"), form("bad-photo", { bodyAr: "[photo] no-such-photo--9 | x" }), NOW))).fields).toMatchObject({ bodyAr: "photo_unknown" });
    expect((await failure(saveArticle(t.db, as("content"), form("clean-the-fans"), NOW))).fields).toMatchObject({ slug: "slug_taken" });
  });
});

// ───────────────────────────────────────────────────────────────── metrics (14.05) and repairs

describe("metrics and repair requests", () => {
  test("first response and resolution from the ticket events; satisfaction only when collected; demo left out unless asked", async () => {
    const at = NOW + 10 * 24 * HOUR;
    const a = await storefrontTicket({ now: at });
    const b = await storefrontTicket({ now: at });
    await replyToTicket(t.db, as("support"), { ticketId: a.ticketId, body: "رد أول", via: "call", idempotencyKey: randomToken() }, at + 30 * 60_000);
    await replyToTicket(t.db, as("support"), { ticketId: b.ticketId, body: "رد أول", via: "call", idempotencyKey: randomToken() }, at + 90 * 60_000);
    await changeTicketStatus(t.db, as("support"), { ticketId: a.ticketId, from: "pending_customer", to: "resolved", reason: "تم الحل" }, at + 3 * HOUR);
    const metrics = await supportMetrics(t.db, as("support"), { days: 7, demo: false }, at + 4 * HOUR);
    expect(metrics.tickets.created).toBe(2);
    expect(metrics.tickets.firstResponse).toMatchObject({ count: 2, median: 60 });
    expect(metrics.tickets.resolution).toMatchObject({ count: 1, median: 180 });
    expect(metrics.satisfaction).toEqual({ collected: false, resolved: 1 });
    expect(metrics.byAgent.find((agent) => agent.id === as("support").id)?.answered).toBe(2);
    await t.db.update(supportTickets).set({ csatRating: 4 }).where(eq(supportTickets.id, a.ticketId));
    expect((await supportMetrics(t.db, as("support"), { days: 7, demo: false }, at + 4 * HOUR)).satisfaction).toMatchObject({ collected: true, answered: 1, average: 4 });
    await t.db.update(supportTickets).set({ isDemo: true }).where(eq(supportTickets.id, b.ticketId));
    expect((await supportMetrics(t.db, as("support"), { days: 7, demo: false }, at + 4 * HOUR)).tickets.created).toBe(1);
    expect((await supportMetrics(t.db, as("support"), { days: 7, demo: true }, at + 4 * HOUR)).tickets.created).toBe(2);
    expect((await failure(supportMetrics(t.db, as("cashier"), { days: 7, demo: false }, at))).status).toBe(403);
  });

  test("a repair request as support sees it: status from module 12's events, the serial kept private", async () => {
    const created = await createRepairTicket(t.db, who(), { idempotencyKey: randomToken(), device: "other", deviceText: "Switch OLED", serial: "XAW1000123456", issue: "الشاشة لا تعمل بعد السقوط", phone: freshPhone(), handover: "drop_off", preferredWindow: "morning" }, NOW);
    const view = await getRepairRequest(t.db, as("support"), created.ref, "ar", NOW, urls);
    expect(view).toMatchObject({ status: "submitted", handover: "drop_off", preferredWindow: "morning", serial: { given: true, ours: false }, workHref: `/admin/returns/repairs/${created.ref}` });
    expect(JSON.stringify(view)).not.toContain("XAW1000123456");
    const row = await t.db.select().from(repairTickets).where(eq(repairTickets.id, created.ticketId)).get();
    expect(row?.status).toBe("submitted");
    expect((await failure(getRepairRequest(t.db, as("cashier"), created.ref, "ar", NOW, urls))).status).toBe(403);
    expect((await getRepairRequest(t.db, custom("support", ["support.ticket.read"]), created.ref, "ar", NOW, urls)).workHref).toBeNull();
  });

  test("knowledge rows written by the demo seed stay untouched by reading", async () => {
    const before = await t.db.select({ n: sql<number>`count(*)` }).from(knowledgeArticles).get();
    await listArticles(t.db, as("manager"), { view: "all", q: "" }, "ar");
    expect((await t.db.select({ n: sql<number>`count(*)` }).from(knowledgeArticles).get())?.n).toBe(before?.n);
  });
});
