/**
 * Admin module 14 "support" — module follow-up (2026-11-12). The test failed on the code before the follow-up:
 *
 *   · the holder of an escalation could pass it on to another decider through the service (escalateTicket with the
 *     holder as `expected`), but the ticket page hid the escalate panel on every escalated ticket. The page now offers
 *     it to whoever may settle the escalation (`can.passOn`), never to the person who escalated it
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles } from "~/server/db/schema";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { escalateTicket } from "~/server/services/admin/support/escalation.server";
import { getTicket } from "~/server/services/admin/support/tickets.server";
import { createSupportTicket } from "~/server/services/support/tickets.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const urls = { file: (id: string) => `/admin/support/files/${id}` };
let t: TestDb;
let make: Fixtures;
type Key = DefaultRoleKey | "manager2";
const staff: Partial<Record<Key, EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager"] as const) staff[key] = await employee(key);
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

describe("admin 14 support — follow-up", () => {
  test("the holder of an escalation is offered passing it on; the person who escalated it is not", async () => {
    const ticket = await createSupportTicket(t.db, { customerId: null, ip: "198.51.100.77", storeMode: "live" }, { idempotencyKey: randomToken(), phone: "07723456789", contactName: "سارة", subject: "استرداد", message: "أريد استرداد المبلغ", category: "payment", locale: "ar" }, NOW);
    await escalateTicket(t.db, as("manager"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager2").id, reason: "الزبون يطلب استرداد المبلغ كاملاً" }, NOW);
    const forHolder = await getTicket(t.db, as("manager2"), ticket.ref, "ar", NOW + 1, urls);
    expect(forHolder.can.passOn).toBe(true);
    const forEscalator = await getTicket(t.db, as("manager"), ticket.ref, "ar", NOW + 1, urls);
    expect(forEscalator.can.passOn).toBe(false);
    // what the page now offers works: the holder passes it on
    await escalateTicket(t.db, as("manager2"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("owner").id, reason: "أحوّلها للمالك لأنه يقرر المبالغ الكبيرة", expected: as("manager2").id }, NOW + 2);
    expect((await getTicket(t.db, as("owner"), ticket.ref, "ar", NOW + 3, urls)).can.passOn).toBe(true);
    expect((await getTicket(t.db, as("manager2"), ticket.ref, "ar", NOW + 3, urls)).can.passOn).toBe(false);
  });
});
