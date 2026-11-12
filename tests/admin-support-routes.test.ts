/**
 * Admin module 14 "support" — the route intents (app/routes/admin/support/actions.server.ts) and the queue counts the
 * shell's bell reads, on a real local D1 with the built-in roles:
 *
 *   · every intent checks its own permission BEFORE anything of the form or the ticket is read (403, never a field
 *     error or a 404 that reveals what exists)
 *   · an unknown intent is a field error; the services still check again (a custom role without a permission is refused)
 *   · supportQueueCounts: each count only for holders of the permission to act, and each equals the number of rows the
 *     inbox view it links to shows that employee (the shell's "truth" rule)
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { inboxIntent, ticketIntent, TICKET_INTENT_PERMISSIONS } from "~/routes/admin/support/actions.server";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, supportTickets } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { escalateTicket } from "~/server/services/admin/support/escalation.server";
import { listInbox, supportQueueCounts } from "~/server/services/admin/support/inbox.server";
import { saveCannedReply } from "~/server/services/admin/support/replies.server";
import { QUEUE_LINKS, parseInboxFilters } from "~/server/services/admin/support/types";
import { createSupportTicket } from "~/server/services/support/tickets.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 3_600_000;
let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "support2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "support", "cashier", "content", "finance"] as const) staff[key] = await employee(key);
  staff.support2 = await employee("support");
});
afterAll(async () => {
  await t?.dispose();
});

async function employee(key: DefaultRoleKey): Promise<EmployeeActor> {
  const id = await make.employee({ name: `${key} ${make.next("emp")}` });
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(key) });
  return { kind: "employee", id, permissions: defaultRolePermissions(key), label: key };
}
const as = (key: DefaultRoleKey | "support2"): EmployeeActor => staff[key] as EmployeeActor;
const custom = (base: DefaultRoleKey | "support2", permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: as(base).id, permissions: new Set(permissions) });

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

let ip = 0;
async function ticket(category = "order") {
  return createSupportTicket(t.db, { customerId: null, ip: `192.0.2.${++ip}`, storeMode: "live" }, { idempotencyKey: randomToken(), phone: `0772${String(1_000_000 + ip).slice(-7)}`, subject: "سؤال عن الطلب", message: "أين طلبي؟", category, locale: "ar" }, NOW);
}

const form = (values: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  return data;
};

describe("ticket intents", () => {
  test("each intent refuses an employee without its permission before reading anything (also for an unknown ticket)", async () => {
    const reader = custom("support", ["support.ticket.read"]);
    for (const [intent, permissions] of Object.entries(TICKET_INTENT_PERMISSIONS)) {
      if (permissions.includes("support.ticket.read")) continue;
      // an unknown ticket reference: a 404 here would tell a reader-only employee that it does not exist
      const error = await failure(ticketIntent(t.db, reader, "SP-NOSUCH99", form({ intent, body: "x" }), NOW));
      expect(error.status, intent).toBe(403);
    }
    expect((await failure(ticketIntent(t.db, reader, "SP-NOSUCH99", form({ intent: "bogus" }), NOW))).fields).toMatchObject({ intent: "invalid" });
  });

  test("a reply, a status change and a canned preview go through the services, which check again", async () => {
    const created = await ticket();
    const reply = await ticketIntent(t.db, as("support"), created.ref, form({ intent: "reply", body: "طلبك في الطريق.", via: "whatsapp", then: "pending_customer", idempotencyKey: randomToken() }), NOW + HOUR);
    expect(reply).toMatchObject({ ok: true, intent: "reply", held: true, status: "pending_customer" });
    // closing needs support.ticket.close: the intent lets a replier in (status), the service refuses the close
    const replier = custom("support", ["support.ticket.read", "support.ticket.reply"]);
    expect((await failure(ticketIntent(t.db, replier, created.ref, form({ intent: "status", from: "pending_customer", to: "closed", reason: "مكرر" }), NOW))).status).toBe(403);
    const saved = await saveCannedReply(t.db, as("support"), { key: "hello", title: "ترحيب", bodyAr: "مرحباً {customer_name}، تذكرتك {ticket_ref}.", reason: "رد عام" }, NOW);
    const preview = await ticketIntent(t.db, as("support"), created.ref, form({ intent: "preview", replyId: saved.id }), NOW);
    expect((preview.preview as { text: string }).text).toContain(created.ref);
    expect((await failure(ticketIntent(t.db, custom("support", ["support.ticket.read"]), created.ref, form({ intent: "preview", replyId: saved.id }), NOW))).status).toBe(403);
  });

  test("linking looks a record up only for who may read that kind of record; unlinking needs no look-up", async () => {
    const created = await ticket();
    const replier = custom("support", ["support.ticket.read", "support.ticket.reply"]);
    // whether an order or an account exists is not revealed to someone who may not read orders or customers
    expect((await failure(ticketIntent(t.db, replier, created.ref, form({ intent: "link", field: "order", value: "TT-ANYTHING9" }), NOW))).status).toBe(403);
    expect((await failure(ticketIntent(t.db, replier, created.ref, form({ intent: "link", field: "customer", value: "07701234567" }), NOW))).status).toBe(403);
    expect(await ticketIntent(t.db, replier, created.ref, form({ intent: "link", field: "order", value: "" }), NOW)).toMatchObject({ ok: true, changed: false });
    expect((await failure(ticketIntent(t.db, as("support"), created.ref, form({ intent: "link", field: "order", value: "TT-ANYTHING9" }), NOW))).fields).toMatchObject({ value: "link_not_found" });
  });

  test("taking a ticket needs only the reply permission; assigning someone else needs the assign permission", async () => {
    const created = await ticket();
    const replier = custom("support2", ["support.ticket.read", "support.ticket.reply"]);
    expect((await failure(ticketIntent(t.db, replier, created.ref, form({ intent: "assign", employeeId: as("support2").id, expected: "" }), NOW))).status).toBe(403);
    expect(await ticketIntent(t.db, replier, created.ref, form({ intent: "take" }), NOW)).toMatchObject({ ok: true, intent: "take" });
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, created.ticketId)).get();
    expect(row?.assignedTo).toBe(as("support2").id);
  });
});

describe("inbox intents", () => {
  test("routing and bulk work need the assign permission; selected ids are required", async () => {
    expect((await failure(inboxIntent(t.db, as("content"), form({ intent: "route_waiting" }), NOW))).status).toBe(403);
    expect((await failure(inboxIntent(t.db, as("manager"), form({ intent: "bulk_assign" }), NOW))).fields).toMatchObject({ ticketId: "required" });
    const a = await ticket();
    const b = await ticket();
    const result = await inboxIntent(t.db, as("manager"), form({ intent: "bulk_assign", ticketId: [a.ticketId, b.ticketId], employeeId: as("support").id }), NOW);
    expect(result).toMatchObject({ ok: true, assigned: 2, skipped: 0 });
    expect(await inboxIntent(t.db, as("manager"), form({ intent: "route_waiting" }), NOW)).toMatchObject({ ok: true, intent: "route_waiting" });
  });
});

describe("the queue counts behind the shell's bell", () => {
  test("only for holders of the permission to act, and each equals the rows of the view it opens", async () => {
    expect(await supportQueueCounts(t.db, as("cashier"), NOW)).toEqual({ escalatedToMe: null, unassigned: null, mineLate: null });
    expect(await supportQueueCounts(t.db, as("content"), NOW)).toEqual({ escalatedToMe: null, unassigned: null, mineLate: null });
    const created = await ticket("payment");
    const row = await t.db.select().from(supportTickets).where(eq(supportTickets.id, created.ticketId)).get();
    await escalateTicket(t.db, as("support"), { ticketId: created.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason: "الزبون يطلب استرداد المبلغ", expected: row?.escalatedTo ?? "" }, NOW);
    // a ticket of support2's that is late
    const late = await ticket();
    await t.db.update(supportTickets).set({ assignedTo: as("support2").id, firstResponseDueAt: NOW - HOUR }).where(eq(supportTickets.id, late.ticketId));
    for (const key of ["manager", "support", "support2", "owner"] as const) {
      const counts = await supportQueueCounts(t.db, as(key), NOW);
      for (const [queue, link] of Object.entries(QUEUE_LINKS) as [keyof typeof QUEUE_LINKS, string][]) {
        const count = counts[queue];
        if (count === null) continue;
        const page = await listInbox(t.db, as(key), parseInboxFilters(new URL(link, "http://x").searchParams), NOW);
        expect(page.total, `${key} ${queue}`).toBe(count);
      }
    }
    expect((await supportQueueCounts(t.db, as("manager"), NOW)).escalatedToMe).toBe(1);
    expect((await supportQueueCounts(t.db, as("support2"), NOW)).mineLate).toBe(1);
    // the support role assigns, so it sees the unassigned queue; a reader-only employee does not
    expect((await supportQueueCounts(t.db, custom("support", ["support.ticket.read"]), NOW)).unassigned).toBeNull();
  });
});
