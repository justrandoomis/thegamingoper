/**
 * Admin module 14 "support" — adversarial review (2026-11-12). Each test is an attack on the builder's code that
 * succeeded before the fix, on a real local D1 with the built-in roles:
 *
 *   · two-person escalation: the escalator never hands back their own escalation, nobody takes it from its holder by
 *     escalating it again, and the target's authority is checked inside the write
 *   · races just before the write batch: an escalation landing under a resolution, a priority raised under an
 *     escalation, two links that each passed their own check
 *   · one customer and one order per ticket across every link (customer, order, warranty, return, repair), also when a
 *     staff ticket is opened
 *   · look-ups and fills only for who may read them: the order a staff ticket names, the routing dry run's tickets, the
 *     canned reply's account name and order status
 *   · stale forms of routing rules and SLA policies are refused instead of overwriting a newer change
 *   · the SLA "give them due times" count equals what the action does
 *   · references typed with Arabic-Indic digits
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import type { Db } from "~/server/db/drizzle.server";
import { customers, employeeRoles, employees, returns, supportTickets, warranties } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { inboxIntent } from "~/routes/admin/support/actions.server";
import { escalateTicket, returnEscalation } from "~/server/services/admin/support/escalation.server";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { decideArticle, decideRevision, getArticleEditor, saveArticle, submitArticle } from "~/server/services/admin/support/knowledge.server";
import { previewCannedReply, saveCannedReply } from "~/server/services/admin/support/replies.server";
import { listRoutingRules, previewRule, saveRoutingRule } from "~/server/services/admin/support/routing.server";
import { applySlaToOpenTickets, listSlaPolicies, saveSlaPolicy } from "~/server/services/admin/support/sla.server";
import { assignTicket, changeTicketStatus, getTicket, linkTicket, openStaffTicket, replyToTicket, triageTicket } from "~/server/services/admin/support/tickets.server";
import { parseInboxFilters } from "~/server/services/admin/support/types";
import { getArticle } from "~/server/services/support/kb.server";
import type { SupportWho } from "~/server/services/support/common.server";
import { createRepairTicket } from "~/server/services/support/repairs.server";
import { createSupportTicket } from "~/server/services/support/tickets.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 3_600_000;
const urls = { file: (id: string) => `/admin/support/files/${id}` };

let t: TestDb;
let make: Fixtures;
type Key = DefaultRoleKey | "support2" | "manager2";
const staff: Partial<Record<Key, EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "support"] as const) staff[key] = await employee(key);
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
/** The same person with other permissions (a custom role). */
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

type Batch = (statements: unknown) => Promise<unknown>;

/** The same database, except that `hook` runs once just before the `nth` db.batch call: a competing request. */
function beforeBatch(db: Db, nth: number, hook: () => PromiseLike<unknown>): Db {
  let calls = 0;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "batch") {
        return async (statements: unknown) => {
          calls += 1;
          if (calls === nth) await hook();
          return (target.batch as unknown as Batch).call(target, statements);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

let ipCounter = 0;
const who = (overrides: Partial<SupportWho> = {}): SupportWho => ({ customerId: null, ip: `198.51.100.${++ipCounter}`, storeMode: "live", ...overrides });
let phoneCounter = 0;
const freshPhone = () => `0772${String(2_000_000 + ++phoneCounter).slice(-7)}`;

async function storefrontTicket(options: { category?: string; customerId?: string | null } = {}) {
  return createSupportTicket(
    t.db,
    who({ customerId: options.customerId ?? null }),
    { idempotencyKey: randomToken(), phone: freshPhone(), contactName: "سارة", subject: "سؤال عن الطلب", message: "أين طلبي؟", category: options.category ?? "order", locale: "ar" },
    NOW,
  );
}
const ticketRow = async (id: string) => (await t.db.select().from(supportTickets).where(eq(supportTickets.id, id)).get())!;
const formData = (values: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  return data;
};
const reason = "الزبون يطلب استرداد المبلغ كاملاً";
const toArabicDigits = (text: string) => text.replace(/\d/g, (digit) => "٠١٢٣٤٥٦٧٨٩"[Number(digit)]);

// ───────────────────────────────────────────────────────────────── escalation (14.07): two people

describe("escalation stays with the person it was given to", () => {
  test("the escalator cannot hand back their own escalation for the person it went to (a colleague may cover)", async () => {
    const ticket = await storefrontTicket({ category: "payment" });
    // a manager holds refunds AND may escalate: the "cover" rule let them settle the complaint they had sent to the owner
    await escalateTicket(t.db, as("manager"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("owner").id, reason }, NOW);
    expect((await failure(returnEscalation(t.db, as("manager"), { ticketId: ticket.ticketId, outcome: "اعتمدت الاسترداد بنفسي" }, NOW + 1))).status).toBe(403);
    expect((await ticketRow(ticket.ticketId)).escalatedTo).toBe(as("owner").id);
    // the ticket page offers the hand-back key to exactly those the service lets do it
    const handBack = async (key: Key) => (await getTicket(t.db, as(key), ticket.ref, "ar", NOW + 1, urls)).can.handBack;
    expect({ owner: await handBack("owner"), manager2: await handBack("manager2"), manager: await handBack("manager"), support: await handBack("support") }).toEqual({ owner: true, manager2: true, manager: false, support: false });
    // another holder of the decision may still cover while the owner is away
    await returnEscalation(t.db, as("manager2"), { ticketId: ticket.ticketId, outcome: "اعتمدنا الاسترداد في قسم الطلبات" }, NOW + 2);
    expect((await ticketRow(ticket.ticketId)).escalatedTo).toBeNull();

    // escalated again by the manager, passed on by its holder: the original escalator still cannot settle it
    await escalateTicket(t.db, as("manager"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager2").id, reason }, NOW + 3);
    await escalateTicket(t.db, as("manager2"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("owner").id, reason: "أحوّلها للمالك لأنه يقرر المبالغ الكبيرة", expected: as("manager2").id }, NOW + 4);
    expect((await failure(returnEscalation(t.db, as("manager"), { ticketId: ticket.ticketId, outcome: "اعتمدت الاسترداد بنفسي" }, NOW + 5))).status).toBe(403);
    expect((await ticketRow(ticket.ticketId)).escalatedTo).toBe(as("owner").id);
  });

  test("nobody takes an escalation away from its holder by escalating it again; the holder may pass it on", async () => {
    const ticket = await storefrontTicket({ category: "payment" });
    await escalateTicket(t.db, as("support"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason }, NOW);
    // another agent (and the escalator) cannot move it to someone else — the page hides the panel, the service did not refuse
    for (const key of ["support2", "support"] as const) {
      expect((await failure(escalateTicket(t.db, as(key), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("owner").id, reason, expected: as("manager").id }, NOW + 1))).code, key).toBe("escalation_open");
    }
    expect((await ticketRow(ticket.ticketId)).escalatedTo).toBe(as("manager").id);
    await escalateTicket(t.db, as("manager"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("owner").id, reason: "أحوّلها للمالك لأنه يقرر المبالغ الكبيرة", expected: as("manager").id }, NOW + 2);
    expect((await ticketRow(ticket.ticketId)).escalatedTo).toBe(as("owner").id);
  });

  test("a target who loses the authority just before the write is refused (no ticket stuck with them)", async () => {
    const ticket = await storefrontTicket({ category: "payment" });
    const target = as("manager2").id;
    const racing = beforeBatch(t.db, 1, () => t.db.update(employees).set({ status: "disabled", disabledAt: NOW }).where(eq(employees.id, target)));
    try {
      expect((await failure(escalateTicket(racing, as("support"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: target, reason }, NOW))).code).toBe("escalation_target");
      expect((await ticketRow(ticket.ticketId)).escalatedTo).toBeNull();
    } finally {
      await t.db.update(employees).set({ status: "active", disabledAt: null }).where(eq(employees.id, target));
    }
  });

  test("an escalation that lands just before a resolution keeps the ticket open (status change and reply)", async () => {
    for (const how of ["status", "reply"] as const) {
      const ticket = await storefrontTicket({ category: "payment" });
      await t.db.update(supportTickets).set({ status: "pending_staff" }).where(eq(supportTickets.id, ticket.ticketId));
      const racing = beforeBatch(t.db, 1, () => escalateTicket(t.db, as("support2"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason }, NOW));
      const attempt =
        how === "status"
          ? changeTicketStatus(racing, as("support"), { ticketId: ticket.ticketId, from: "pending_staff", to: "resolved", reason: "تم الحل" }, NOW + 1)
          : replyToTicket(racing, as("support"), { ticketId: ticket.ticketId, body: "تم حل مشكلتك.", via: "call", then: "resolved", idempotencyKey: randomToken() }, NOW + 1);
      expect(["ticket_changed", "escalation_open"], how).toContain((await failure(attempt)).code);
      const row = await ticketRow(ticket.ticketId);
      expect(row, how).toMatchObject({ status: "pending_staff", escalatedTo: as("manager").id, resolvedAt: null });
    }
  });

  test("a priority raised just before an escalation is not lowered by it", async () => {
    const ticket = await storefrontTicket({ category: "payment" });
    const row = await ticketRow(ticket.ticketId);
    const racing = beforeBatch(t.db, 1, () => triageTicket(t.db, as("manager"), { ticketId: ticket.ticketId, priority: "urgent", category: row.category, expectedUpdatedAt: row.updatedAt }, NOW));
    expect((await failure(escalateTicket(racing, as("support"), { ticketId: ticket.ticketId, kind: "financial", toEmployeeId: as("manager").id, reason }, NOW + 1))).code).toBe("ticket_changed");
    expect((await ticketRow(ticket.ticketId)).priority).toBe("urgent");
  });
});

// ───────────────────────────────────────────────────────────────── links (14.02): one customer, one order

describe("a ticket's links agree with each other", () => {
  test("every link is checked against every other one, whichever comes first", async () => {
    const product = await make.product();
    const customerA = await make.customer();
    const customerB = await make.customer();
    const orderA = await make.order([{ variantId: product.variantId, sku: product.sku }], { customerId: customerA });
    const orderA2 = await make.order([{ variantId: product.variantId, sku: product.sku }], { customerId: customerA });
    const warrantyA2 = newId("wty");
    await t.db.insert(warranties).values({ id: warrantyA2, orderItemId: orderA2.itemIds[0], customerId: customerA, startsAt: NOW, endsAt: NOW + 365 * 24 * HOUR, createdAt: NOW });
    const repairB = await createRepairTicket(t.db, who({ customerId: customerB }), { idempotencyKey: randomToken(), device: "other", deviceText: "PS5", issue: "الجهاز لا يقرأ الأقراص أبداً", phone: freshPhone() }, NOW);
    const rmaA2 = `RMA-${make.next("R").replace(/\D/g, "")}9`;
    await t.db.insert(returns).values({ id: newId("ret"), rma: rmaA2, orderId: orderA2.orderId, customerId: customerA, createdAt: NOW });

    // no customer on the ticket: an order of A, then a repair of B
    const first = await storefrontTicket();
    await linkTicket(t.db, as("support"), { ticketId: first.ticketId, field: "order", value: orderA.ref }, NOW);
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: first.ticketId, field: "repair", value: repairB.ref }, NOW))).code).toBe("order_other_customer");
    // the RMA of A's other order
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: first.ticketId, field: "return", value: rmaA2 }, NOW))).code).toBe("warranty_other_order");

    // a warranty first, then another order of the same customer
    const second = await storefrontTicket();
    await linkTicket(t.db, as("support"), { ticketId: second.ticketId, field: "warranty", value: warrantyA2 }, NOW);
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: second.ticketId, field: "order", value: orderA.ref }, NOW))).code).toBe("warranty_other_order");
    await linkTicket(t.db, as("support"), { ticketId: second.ticketId, field: "order", value: orderA2.ref }, NOW);

    // a repair of B first, then the account of A
    const third = await storefrontTicket();
    await linkTicket(t.db, as("support"), { ticketId: third.ticketId, field: "repair", value: repairB.ref }, NOW);
    expect((await failure(linkTicket(t.db, as("support"), { ticketId: third.ticketId, field: "customer", value: customerA }, NOW))).code).toBe("order_other_customer");
    await linkTicket(t.db, as("support"), { ticketId: third.ticketId, field: "customer", value: customerB }, NOW);

    const rows = await t.db.select().from(supportTickets).where(inArray(supportTickets.id, [first.ticketId, second.ticketId, third.ticketId]));
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.ticketId)).toMatchObject({ orderId: orderA.orderId, repairTicketId: null, returnId: null });
    expect(byId.get(second.ticketId)).toMatchObject({ warrantyId: warrantyA2, orderId: orderA2.orderId });
    expect(byId.get(third.ticketId)).toMatchObject({ repairTicketId: repairB.ticketId, customerId: customerB });
  });

  test("two links that each passed their own check cannot both land (race just before the write)", async () => {
    const product = await make.product();
    const customerA = await make.customer();
    const customerB = await make.customer();
    const orderA = await make.order([{ variantId: product.variantId, sku: product.sku }], { customerId: customerA });
    const ticket = await storefrontTicket();
    const racing = beforeBatch(t.db, 1, () => linkTicket(t.db, as("support2"), { ticketId: ticket.ticketId, field: "customer", value: customerB }, NOW));
    expect(["ticket_changed", "order_other_customer"]).toContain((await failure(linkTicket(racing, as("support"), { ticketId: ticket.ticketId, field: "order", value: orderA.ref }, NOW + 1))).code);
    expect(await ticketRow(ticket.ticketId)).toMatchObject({ customerId: customerB, orderId: null });
  });

  test("a staff ticket is not opened with the account of one customer and the repair of another", async () => {
    const customerA = await make.customer();
    const customerB = await make.customer();
    const account = await t.db.select().from(customers).where(eq(customers.id, customerA)).get();
    const repairB = await createRepairTicket(t.db, who({ customerId: customerB }), { idempotencyKey: randomToken(), device: "other", deviceText: "Xbox Series S", issue: "الجهاز يسخن ثم ينطفئ فجأة", phone: freshPhone() }, NOW);
    const key = randomToken();
    expect((await failure(openStaffTicket(t.db, as("support"), { channel: "phone", phone: account!.phoneE164, subject: "يسأل عن جهازه", repairRef: repairB.ref, idempotencyKey: key }, NOW))).code).toBe("order_other_customer");
    expect(await t.db.select().from(supportTickets).where(eq(supportTickets.repairTicketId, repairB.ticketId))).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────── field rules: look-ups and fills

describe("what a role may look up or see", () => {
  test("a staff ticket names an order only for someone who may read orders (no existence oracle)", async () => {
    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], {});
    const noOrders = custom("support", ["support.ticket.read", "support.ticket.reply"]);
    for (const orderRef of [order.ref, "TT-NOSUCH99"]) {
      const error = await failure(openStaffTicket(t.db, noOrders, { channel: "phone", phone: freshPhone(), subject: "سؤال عن طلب", orderRef, idempotencyKey: randomToken() }, NOW));
      expect(error.status, orderRef).toBe(403);
    }
    expect(await t.db.select().from(supportTickets).where(eq(supportTickets.orderId, order.orderId))).toHaveLength(0);
  });

  test("the routing dry run shows the tickets it would take only to someone who may read tickets", async () => {
    await storefrontTicket({ category: "shipping" });
    const rulesOnly = custom("manager", ["support.routing.manage"]);
    const preview = await previewRule(t.db, rulesOnly, { name: "تجربة", categories: ["shipping"] });
    expect(preview.matches).toEqual([]);
    expect(JSON.stringify(preview)).not.toContain("سؤال عن الطلب");
    const reader = await previewRule(t.db, as("manager"), { name: "تجربة", categories: ["shipping"] });
    expect(reader.matches.length).toBeGreaterThanOrEqual(1);
  });

  test("a canned reply fills only what the ticket page shows this agent (the account's name, the order's status)", async () => {
    const customerId = await make.customer({ name: "اسم الحساب السري" });
    const account = await t.db.select().from(customers).where(eq(customers.id, customerId)).get();
    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], { customerId, status: "shipped" });
    const opened = await openStaffTicket(t.db, as("support"), { channel: "phone", phone: account!.phoneE164, subject: "سؤال عن الطلب", orderRef: order.ref, idempotencyKey: randomToken() }, NOW);
    const saved = await saveCannedReply(t.db, as("support"), { key: "review-fields", title: "حالة الطلب", bodyAr: "مرحباً {customer_name}، طلبك {order_ref} حالته: {order_status}.", reason: "رد للمراجعة" }, NOW);
    const agent = custom("support", ["support.ticket.read", "support.ticket.reply"]);
    const page = await getTicket(t.db, agent, opened.ref, "ar", NOW, urls);
    expect(page.customer?.name).toBeNull();
    expect(page.order?.status).toBeNull();
    const preview = await previewCannedReply(t.db, agent, { ticketId: opened.ticketId, replyId: saved.id });
    expect(preview.text).not.toContain("اسم الحساب السري");
    expect(preview.missing).toEqual(expect.arrayContaining(["customer_name", "order_status"]));
    // whoever may read customers and orders gets them filled
    const full = await previewCannedReply(t.db, as("support"), { ticketId: opened.ticketId, replyId: saved.id });
    expect(full.text).toContain("اسم الحساب السري");
    expect(full.missing).toEqual([]);
  });

  test("the return a ticket links shows its status only to someone who may read returns (not in the page's data either)", async () => {
    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], {});
    const rma = `RMA-${make.next("S").replace(/\D/g, "")}5`;
    await t.db.insert(returns).values({ id: newId("ret"), rma, orderId: order.orderId, status: "approved", createdAt: NOW });
    const ticket = await storefrontTicket();
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "return", value: rma }, NOW);
    const reader = custom("support", ["support.ticket.read"]);
    expect((await getTicket(t.db, reader, ticket.ref, "ar", NOW, urls)).rma).toMatchObject({ rma, status: null, href: null });
    expect((await getTicket(t.db, as("support"), ticket.ref, "ar", NOW, urls)).rma).toMatchObject({ rma, status: "approved" });
  });

  test("the ticket offers a return request only to someone who may create one", async () => {
    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], {});
    const ticket = await storefrontTicket();
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "order", value: order.ref }, NOW);
    const readsRmas = custom("support", ["support.ticket.read", "support.ticket.reply", "orders.order.read", "returns.rma.read"]);
    expect((await getTicket(t.db, readsRmas, ticket.ref, "ar", NOW, urls)).can.rmaCreate).toBe(false);
    expect((await getTicket(t.db, as("support"), ticket.ref, "ar", NOW, urls)).can.rmaCreate).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────── stale forms (14.03, 14.05)

describe("a form built from an older version is refused, not saved over a newer change", () => {
  test("routing rules", async () => {
    const created = await saveRoutingRule(t.db, as("manager"), { name: "قاعدة المراجعة", categories: ["shipping"], team: "review-team", reason: "قاعدة جديدة" }, NOW);
    const rule = (await listRoutingRules(t.db, as("manager"))).rules.find((row) => row.id === created.id)!;
    expect(rule.version).toBeTruthy();
    await saveRoutingRule(t.db, as("manager"), { id: created.id, version: rule.version, name: "قاعدة المراجعة", categories: ["shipping"], team: "review-team", agents: [as("support").id], reason: "إضافة موظف" }, NOW + 1);
    // the second manager's page still shows the rule without its pool
    expect((await failure(saveRoutingRule(t.db, as("manager2"), { id: created.id, version: rule.version, name: "قاعدة المراجعة", categories: ["shipping", "order"], team: "review-team", reason: "إضافة الطلبات" }, NOW + 2))).code).toBe("rule_changed");
    const after = (await listRoutingRules(t.db, as("manager"))).rules.find((row) => row.id === created.id)!;
    expect(after.pool.map((person) => person.id)).toEqual([as("support").id]);
  });

  test("SLA policies", async () => {
    const created = await saveSlaPolicy(t.db, as("manager"), { name: "شحن عاجل", priority: "urgent", category: "shipping", firstResponseMinutes: 30, resolutionMinutes: 300, reason: "هدف جديد" }, NOW);
    const policy = (await listSlaPolicies(t.db, as("manager"))).policies.find((row) => row.id === created.id)!;
    expect(policy.version).toBeTruthy();
    await saveSlaPolicy(t.db, as("manager"), { id: created.id, version: policy.version, name: "شحن عاجل", priority: "urgent", category: "shipping", firstResponseMinutes: 20, resolutionMinutes: 300, reason: "أسرع" }, NOW + 1);
    expect((await failure(saveSlaPolicy(t.db, as("manager2"), { id: created.id, version: policy.version, name: "شحن عاجل جداً", priority: "urgent", category: "shipping", firstResponseMinutes: 30, resolutionMinutes: 240, reason: "تعديل" }, NOW + 2))).code).toBe("rule_changed");
    expect((await listSlaPolicies(t.db, as("manager"))).policies.find((row) => row.id === created.id)?.firstResponseMinutes).toBe(20);
  });
});

// ───────────────────────────────────────────────────────────────── knowledge (14.06): what the reviewer saw

describe("a revision is approved as the reviewer saw it", () => {
  const article = (slug: string, titleAr: string) => ({ slug, kind: "guide" as const, audience: "public" as const, titleAr, bodyAr: "## قبل أن تبدأ\nافصل الجهاز عن الكهرباء.", reason: "مقال" });

  test("an edit saved after the reviewer opened the revision is refused, not approved unseen; a stale revision form too", async () => {
    const slug = "review-revision-race";
    const created = await saveArticle(t.db, as("support"), article(slug, "النسخة المعتمدة"), NOW);
    let editor = await getArticleEditor(t.db, as("support"), created.articleId);
    await submitArticle(t.db, as("support"), { articleId: created.articleId, expectedUpdatedAt: editor.updatedAt }, NOW + 1);
    editor = await getArticleEditor(t.db, as("manager"), created.articleId);
    await decideArticle(t.db, as("manager"), { articleId: created.articleId, decision: "approve", expectedUpdatedAt: editor.updatedAt }, NOW + 2);

    // the writer proposes a revision; a second writer's page was built before it
    const writerPage = await getArticleEditor(t.db, as("support"), created.articleId);
    const otherPage = await getArticleEditor(t.db, as("support2"), created.articleId);
    await saveArticle(t.db, as("support"), { ...article(slug, "نسخة راجعها المدير"), articleId: created.articleId, expectedUpdatedAt: writerPage.updatedAt }, NOW + 3);
    // the second writer saves from the page without that revision: refused instead of replacing it unseen
    expect((await failure(saveArticle(t.db, as("support2"), { ...article(slug, "نسخة من صفحة قديمة"), articleId: created.articleId, expectedUpdatedAt: otherPage.updatedAt }, NOW + 4))).code).toBe("article_changed");

    // the reviewer opens the revision, then the writer changes it again before the reviewer decides
    const reviewed = await getArticleEditor(t.db, as("manager2"), created.articleId);
    expect(reviewed.revision?.title.ar).toBe("نسخة راجعها المدير");
    const writerAgain = await getArticleEditor(t.db, as("support"), created.articleId);
    await saveArticle(t.db, as("support"), { ...article(slug, "نسخة لم يرها أحد"), articleId: created.articleId, expectedUpdatedAt: writerAgain.updatedAt, revisionSavedAt: writerAgain.revision?.savedAt }, NOW + 5);
    expect((await failure(decideRevision(t.db, as("manager2"), { articleId: created.articleId, revisionId: reviewed.revision!.id, savedAt: reviewed.revision?.savedAt, decision: "approve" }, NOW + 6))).code).toBe("article_changed");
    expect((await getArticle(t.db, "ar", slug))?.title).toBe("النسخة المعتمدة");
    // from a fresh page the reviewer approves what they now see
    const fresh = await getArticleEditor(t.db, as("manager2"), created.articleId);
    await decideRevision(t.db, as("manager2"), { articleId: created.articleId, revisionId: fresh.revision!.id, savedAt: fresh.revision?.savedAt, decision: "approve" }, NOW + 7);
    expect((await getArticle(t.db, "ar", slug))?.title).toBe("نسخة لم يرها أحد");
  });
});

// ───────────────────────────────────────────────────────────────── the inbox's bulk work

describe("bulk work on the inbox", () => {
  test("bulk assign skips a ticket someone took after the list was shown (and says how many it skipped)", async () => {
    const a = await storefrontTicket();
    const b = await storefrontTicket();
    // the list showed both without a holder; then an agent takes b
    await assignTicket(t.db, as("support2"), { ticketId: b.ticketId, employeeId: as("support2").id, expected: "" }, NOW);
    const result = await inboxIntent(t.db, as("manager"), formData({ intent: "bulk_assign", ticketId: [a.ticketId, b.ticketId], expected: [`${a.ticketId}:`, `${b.ticketId}:`], employeeId: as("support").id }), NOW + 1);
    expect(result).toMatchObject({ ok: true, assigned: 1, skipped: 1 });
    expect((await ticketRow(a.ticketId)).assignedTo).toBe(as("support").id);
    expect((await ticketRow(b.ticketId)).assignedTo).toBe(as("support2").id);
  });
});

// ───────────────────────────────────────────────────────────────── counts and digits

describe("counts say what the action does; digits as people type them", () => {
  test("the SLA page offers due times for as many tickets as the action fills", async () => {
    // only urgent shipping tickets have a policy here (the previous test); give one open ticket that kind
    const ticket = await storefrontTicket({ category: "shipping" });
    await t.db.update(supportTickets).set({ priority: "urgent", firstResponseDueAt: null, resolutionDueAt: null }).where(eq(supportTickets.id, ticket.ticketId));
    const before = await listSlaPolicies(t.db, as("manager"));
    expect(before.missing.withoutDue).toBeGreaterThan(1);
    expect(before.missing.fillable).toBeGreaterThanOrEqual(1);
    expect(before.missing.fillable).toBeLessThan(before.missing.withoutDue);
    const applied = await applySlaToOpenTickets(t.db, as("manager"), { reason: "تذاكر بلا مواعيد" }, NOW + HOUR);
    expect(applied.updated).toBe(before.missing.fillable);
    expect((await listSlaPolicies(t.db, as("manager"))).missing.fillable).toBe(0);
  });

  test("order and return references typed with Arabic-Indic digits are found (link, new ticket, inbox search)", async () => {
    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], {});
    const typed = toArabicDigits(order.ref);
    expect(typed).not.toBe(order.ref);
    const ticket = await storefrontTicket();
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "order", value: typed }, NOW);
    expect((await ticketRow(ticket.ticketId)).orderId).toBe(order.orderId);
    const found = await listInbox(t.db, as("support"), parseInboxFilters(new URLSearchParams({ q: typed })), NOW);
    expect(found.rows.map((row) => row.ref)).toContain(ticket.ref);
    const opened = await openStaffTicket(t.db, as("support"), { channel: "phone", phone: freshPhone(), subject: "سؤال عن طلب", orderRef: toArabicDigits(order.ref.toLowerCase()), idempotencyKey: randomToken() }, NOW);
    expect((await ticketRow(opened.ticketId)).orderId).toBe(order.orderId);
    const rma = `RMA-${make.next("Q").replace(/\D/g, "")}7`;
    await t.db.insert(returns).values({ id: newId("ret"), rma, orderId: order.orderId, createdAt: NOW });
    await linkTicket(t.db, as("support"), { ticketId: ticket.ticketId, field: "return", value: toArabicDigits(rma) }, NOW);
    expect((await t.db.select({ returnId: supportTickets.returnId }).from(supportTickets).where(and(eq(supportTickets.id, ticket.ticketId), isNull(supportTickets.customerId))).get())?.returnId).toBeTruthy();
  });
});
