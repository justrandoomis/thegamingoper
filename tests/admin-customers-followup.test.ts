/**
 * Admin module 07 "customers" — module follow-up (2026-11-12). Each test failed on the code before the follow-up:
 *
 *   · the profile listed the customer's tickets by reference with no way to them: each now links to its page in the
 *     support module (the section is sent only with support.ticket.read, which opens that page)
 *   · an erasure left the customer's stored maintenance-assistant conversations and their sign-in log (by account and
 *     by number) to their own retention — 30 and 90 days after the person asked to be forgotten. Both go with the
 *     erasure now; a ticket that held a conversation lets go of it and keeps its own summary
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { assistantMessages, assistantSessions, authEvents, customers, employeeRoles, supportTickets } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { createPrivacyRequest, executeErasure, planErasure, verifyPrivacyRequest } from "~/server/services/admin/customers/privacy.server";
import { getCustomerProfile } from "~/server/services/admin/customers/profile.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;
const people: Partial<Record<DefaultRoleKey, EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager"] as const) {
    const id = await make.employee({ name: role });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
    people[role] = { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role };
  }
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});
const as = (key: DefaultRoleKey): EmployeeActor => {
  const actor = people[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};

describe("admin 07 customers — follow-up", () => {
  test("each ticket on the profile links to its page in the support module", async () => {
    const customerId = await make.customer();
    const ref = `TK-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`;
    await t.db.insert(supportTickets).values({ id: newId("tkt"), ref, customerId, subject: "تأخر الطلب", category: "order", status: "open", createdAt: NOW, updatedAt: NOW });
    const profile = await getCustomerProfile(t.db, as("owner"), customerId, "ar", NOW);
    expect(profile.tickets?.find((ticket) => ticket.ref === ref)?.href).toBe(`/admin/support/tickets/${ref}`);
  });

  test("an erasure removes the stored assistant conversations and the sign-in log with the rest", async () => {
    const customerId = await make.customer();
    const phone = (await t.db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, customerId)).get())!.phone;
    const sessionId = newId("asst");
    await t.db.insert(assistantSessions).values({ id: sessionId, customerId, status: "escalated", logConsent: true, createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000, expiresAt: NOW + 30 * 86_400_000 } as typeof assistantSessions.$inferInsert);
    await t.db.insert(assistantMessages).values({ id: newId("amsg"), sessionId, role: "user", content: "جهازي لا يشتغل", createdAt: NOW - 3_600_000 } as typeof assistantMessages.$inferInsert);
    const ticketId = newId("tkt");
    await t.db.insert(supportTickets).values({ id: ticketId, ref: `TK-${randomToken(4).toUpperCase().replace(/[^A-Z0-9]/g, "Q")}`, customerId, assistantSessionId: sessionId, subject: "تحويل من المساعد", category: "repair", status: "resolved", createdAt: NOW, updatedAt: NOW });
    await t.db.insert(authEvents).values([
      { id: newId("aev"), subjectKind: "customer", subjectId: customerId, identifier: phone, kind: "otp", success: true, at: NOW - 60_000 },
      { id: newId("aev"), subjectKind: "customer", subjectId: null, identifier: phone, kind: "otp", success: false, at: NOW - 120_000 },
    ]);
    const request = await createPrivacyRequest(t.db, as("manager"), { customerId, kind: "delete", idempotencyKey: randomToken() }, NOW);
    await verifyPrivacyRequest(t.db, as("manager"), { ref: request.ref, method: "in_store_id", note: "هوية في المحل" }, NOW);
    const plan = await planErasure(t.db, as("manager"), request.ref);
    expect(plan.erased).toMatchObject({ assistant: 1, signIns: 2 });
    await executeErasure(t.db, as("manager"), { ref: request.ref, reason: "طلب حذف موثّق" }, NOW);
    expect(await t.db.select().from(assistantSessions).where(eq(assistantSessions.id, sessionId))).toHaveLength(0);
    expect(await t.db.select().from(assistantMessages).where(eq(assistantMessages.sessionId, sessionId))).toHaveLength(0);
    expect(await t.db.select().from(authEvents).where(eq(authEvents.identifier, phone))).toHaveLength(0);
    // the ticket stays (kept), without the conversation
    expect((await t.db.select({ session: supportTickets.assistantSessionId }).from(supportTickets).where(eq(supportTickets.id, ticketId)).get())?.session).toBeNull();
  });
});
