/**
 * Admin module 21 "channels" — the adversarial review's attacks, each written as a test before its fix:
 *
 *   · an API key outlived its creator: a disabled or branch-limited account, or a scope taken away, kept the key working
 *   · a branch-limited employee could make a key or a webhook that reads every branch, and saw the whole store's
 *     profitability (with its net profit) and every branch's orders
 *   · a webhook carries order references and totals: anyone managing webhooks could point one without orders.order.read,
 *     and the monitor showed order references to readers who may not read orders
 *   · the event queue stalled for good once more events than one scan fell inside its overlap window
 *   · a retry pressed while an attempt was being sent made the same delivery due again: sent twice at once
 *   · a provider's endpoint setting took any address (metadata, private, plain http) for the adapter to come
 *   · figures that disagreed with their lists: the home's branch count for a branch-limited employee, deliveries
 *     "waiting" (pending only on the home, pending + failed on the list), the orders summary's link (all time, not the
 *     period it counts)
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { employeeRoles, employees, orderEvents, rolePermissions, roles, webhookDeliveries } from "~/server/db/schema";
import { chunkRows, runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { handleApiRequest } from "~/server/services/admin/channels/api.server";
import { createApiKey, listApiKeys } from "~/server/services/admin/channels/apikeys.server";
import { createBranch, listBranches } from "~/server/services/admin/channels/branches.server";
import { createChannel, listChannels } from "~/server/services/admin/channels/channels.server";
import { channelsOverview } from "~/server/services/admin/channels/overview.server";
import { saveProviderCredentials } from "~/server/services/admin/channels/providers.server";
import { channelProfitability, ordersByChannel } from "~/server/services/admin/channels/sales.server";
import { channelsAccess } from "~/server/services/admin/channels/shared.server";
import { createWebhook, deliverWebhooks, getWebhook, listDeliveries, listWebhooks, queueOrderEvents, retryDelivery, sendPing, setWebhookActive, updateWebhook, type SignedWebhookRequest } from "~/server/services/admin/channels/webhooks.server";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const MINUTE = 60_000;
const DATA_KEY = TEST_VARS.DATA_KEY;
let t: TestDb;
let make: Fixtures;
type Person = { id: string; roleId: string; actor: EmployeeActor };
const people: Record<string, Person> = {};
let branchId: string;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  people.owner = await person("owner");
  people.finance = await person("finance");
  ({ branchId } = await createBranch(t.db, people.owner.actor, { code: "REV-1", nameAr: "فرع المراجعة", idempotencyKey: "review-branch-form-0001" }, NOW));
  await createBranch(t.db, people.owner.actor, { code: "REV-2", nameAr: "فرع آخر", idempotencyKey: "review-branch-form-0002" }, NOW);
  people.limitedManager = await person("manager", branchId);
  people.keyHolder = await person(["channels.api_key.manage", "orders.order.read", "catalog.product.read"]);
  people.limitedKeyMaker = await person(["channels.api_key.manage", "orders.order.read", "catalog.product.read"], branchId);
  people.hookOnly = await person(["channels.webhook.manage"]);
  people.limitedHookMaker = await person(["channels.webhook.manage", "orders.order.read"], branchId);
  people.integrationReader = await person(["channels.integration.read"]);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], branch?: string): Promise<Person> {
  const id = await make.employee({ name: Array.isArray(role) ? "custom" : role, ...(branch ? { branchId: branch } : {}) });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("rv").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, roleId: custom, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom", branchId: branch ?? null } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, roleId: roleId(role), actor: { kind: "employee", id, permissions, label: role, branchId: branch ?? null } };
}

/** "ok" when the call went through, else the AppError code it was refused with. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ok";
  } catch (error) {
    return toAppError(error)?.code ?? `unexpected: ${String(error)}`;
  }
}
const fieldsOf = async (run: () => Promise<unknown>): Promise<Record<string, string>> => {
  try {
    await run();
    return {};
  } catch (error) {
    return toAppError(error)?.fields ?? {};
  }
};
const key = () => `${make.next("rvkey")}-0123456789abcdef`;
const call = (resource: string, secret: string | null, now: number) =>
  handleApiRequest(t.db, new Request(`http://localhost:5173/api/v1/${resource}`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }), { ip: null, requestId: "req-review", now }, resource);
const deliveryOf = (id: string) => t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get();

// ───────────────────────────────────────────────────────────────── API keys and the hierarchy rule

describe("an API key works only while its creator could still make it", () => {
  test("a scope taken away answers 403; a branch limit or a disabled account stops the key (401) — and the list says so", async () => {
    const holder = people.keyHolder;
    const created = await createApiKey(t.db, holder.actor, { name: "ERP", scopes: ["orders.order.read", "catalog.product.read"], reason: "ربط نظام المحاسبة", idempotencyKey: key() }, NOW);
    const secret = created.key!;
    let at = NOW + 10 * MINUTE;
    expect((await call("orders", secret, at)).status).toBe(200);
    expect((await call("products", secret, at)).status).toBe(200);

    // the role no longer grants orders.order.read: the key cannot read orders either
    await t.db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, holder.roleId), eq(rolePermissions.permission, "orders.order.read")));
    at += 2 * MINUTE;
    expect((await call("orders", secret, at)).status).toBe(403);
    expect((await call("products", secret, at)).status).toBe(200);

    // limited to one branch: the key read every branch, so it stops
    await t.db.update(employees).set({ branchId }).where(eq(employees.id, holder.id));
    at += 2 * MINUTE;
    expect((await call("products", secret, at)).status).toBe(401);
    const listed = await listApiKeys(t.db, people.owner.actor, at);
    expect(listed.rows.find((row) => row.id === created.keyId)?.state).toBe("suspended");

    // the account disabled (the employee left): the key stops
    await t.db.update(employees).set({ branchId: null, status: "disabled" }).where(eq(employees.id, holder.id));
    at += 2 * MINUTE;
    expect((await call("products", secret, at)).status).toBe(401);
    const overview = await channelsOverview(t.db, people.owner.actor, at);
    const after = await listApiKeys(t.db, people.owner.actor, at);
    expect(after.rows.find((row) => row.id === created.keyId)?.state).toBe("suspended");
    expect(overview.apiKeys?.active).toBe(after.counts.active);
  });

  test("an employee limited to a branch cannot make a key or a webhook: both read every branch", async () => {
    expect(await outcome(() => createApiKey(t.db, people.limitedKeyMaker.actor, { name: "Branch ERP", scopes: ["orders.order.read"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await outcome(() => createWebhook(t.db, people.limitedHookMaker.actor, DATA_KEY, { name: "Branch hook", url: "https://hooks.partner.iq/branch", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── webhooks carry order data

describe("a webhook carries order references and totals", () => {
  test("making or re-pointing one needs orders.order.read; the deliveries show order references only to who may read orders", async () => {
    expect(await outcome(() => createWebhook(t.db, people.hookOnly.actor, DATA_KEY, { name: "Mine", url: "https://collector.example-partner.iq/x", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("orders_read_required");

    const at = NOW + 60 * MINUTE;
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Partner", url: "https://hooks.partner.iq/orders", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, at);
    const view = await getWebhook(t.db, people.owner.actor, hook.webhookId);
    expect(await outcome(() => updateWebhook(t.db, people.hookOnly.actor, { webhookId: hook.webhookId, name: view.name, url: "https://collector.example-partner.iq/x", events: view.events, fingerprint: view.fingerprint, reason: "تغيير" }, at))).toBe("orders_read_required");

    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }]);
    await t.db.insert(orderEvents).values({ id: newId("oev"), orderId: order.orderId, kind: "placed", actorKind: "customer", at: at + 1000 });
    await queueOrderEvents(t.db, at + 2000);
    const forOwner = await listDeliveries(t.db, people.owner.actor, { status: null, webhook: hook.webhookId, page: 1 });
    expect(forOwner.rows.map((row) => row.ref)).toContain(order.ref);
    const forReader = await listDeliveries(t.db, people.integrationReader.actor, { status: null, webhook: hook.webhookId, page: 1 });
    expect(forReader.rows.length).toBe(forOwner.rows.length);
    expect(forReader.rows.every((row) => row.ref === null)).toBe(true);
    expect(JSON.stringify(forReader)).not.toContain(order.ref);
  });
});

describe("resuming a paused webhook opens the flow again", () => {
  test("it needs what pointing one does (orders.order.read, no branch limit); pausing never does", async () => {
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Paused partner", url: "https://hooks.partner.iq/paused", events: ["order.shipped"], reason: "ربط", idempotencyKey: key() }, NOW);
    expect(await outcome(() => setWebhookActive(t.db, people.hookOnly.actor, { webhookId: hook.webhookId, active: false, reason: "إيقاف احتياطي" }, NOW))).toBe("ok");
    expect(await outcome(() => setWebhookActive(t.db, people.hookOnly.actor, { webhookId: hook.webhookId, active: true, reason: "استئناف" }, NOW))).toBe("orders_read_required");
    expect(await outcome(() => setWebhookActive(t.db, people.limitedHookMaker.actor, { webhookId: hook.webhookId, active: true, reason: "استئناف" }, NOW))).toBe("forbidden");
    expect(await outcome(() => setWebhookActive(t.db, people.owner.actor, { webhookId: hook.webhookId, active: true, reason: "استئناف" }, NOW))).toBe("ok");
    expect(await outcome(() => setWebhookActive(t.db, people.limitedHookMaker.actor, { webhookId: hook.webhookId, active: false, reason: "إيقاف" }, NOW))).toBe("ok");
  });
});

// ───────────────────────────────────────────────────────────────── store-wide figures and branch limits

describe("the store-wide figures are not a branch-limited employee's", () => {
  const range = { fromMs: NOW - 86_400_000, toMs: NOW + 86_400_000, demo: false, from: "2026-11-09", to: "2026-11-11" };

  test("profitability per channel (with the store's net profit) and the orders of every branch are refused, and their sections are not offered", async () => {
    const limited = people.limitedManager.actor;
    expect(await outcome(() => channelProfitability(t.db, limited, range, "ar"))).toBe("forbidden");
    expect(await outcome(() => ordersByChannel(t.db, limited, range, "ar"))).toBe("forbidden");
    expect(channelsAccess(limited)).toMatchObject({ profit: false, orders: false, branches: true });
    expect(channelsAccess(people.finance.actor)).toMatchObject({ profit: true, orders: true });
  });

  test("the home counts the branches the branch list shows", async () => {
    const limited = people.limitedManager.actor;
    const overview = await channelsOverview(t.db, limited, NOW);
    const list = await listBranches(t.db, limited, "all", "ar");
    expect(overview.branches).toEqual({ active: list.counts.active, inactive: list.counts.inactive });
    expect(list.counts.all).toBe(1);
  });

  test("the orders summary links module 05's list for the same period it counts", async () => {
    const rows = await ordersByChannel(t.db, people.finance.actor, range, "ar");
    expect(rows.find((row) => row.key === "web")?.list).toBe("/admin/orders?from=2026-11-09&to=2026-11-11");
  });
});

// ───────────────────────────────────────────────────────────────── the queue and the delivery engine

describe("the delivery engine never stalls and never sends a delivery twice at once", () => {
  test("more events than one scan inside the overlap window are all queued, each once", async () => {
    const at = NOW + 2 * 86_400_000;
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Flash sale", url: "https://hooks.partner.iq/flash", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, at);
    const product = await make.product();
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }]);
    const events = Array.from({ length: 620 }, (_, index) => ({ id: newId("oev"), orderId: order.orderId, kind: "placed", actorKind: "customer" as const, at: at + 1000 + index * 50 }));
    await runBatch(
      t.db,
      chunkRows(orderEvents, events).map((chunk) => t.db.insert(orderEvents).values(chunk)),
    );
    for (let run = 0; run < 3; run++) await queueOrderEvents(t.db, at + 2 * MINUTE + run);
    const queued = await t.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM webhook_deliveries WHERE webhook_id = ${hook.webhookId}`);
    expect(Number(queued[0].n)).toBe(620);
  });

  test("a retry pressed while an attempt is out is refused, and no second run sends the same delivery meanwhile", async () => {
    const at0 = NOW + 3 * 86_400_000;
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "In flight", url: "https://hooks.partner.iq/inflight", events: ["order.cancelled"], reason: "ربط", idempotencyKey: key() }, at0);
    // only this webhook's deliveries are due in this test (the other tests leave hundreds waiting)
    await t.db.run(sql`UPDATE webhooks SET is_active = 0 WHERE id <> ${hook.webhookId}`);
    const { deliveryId } = await sendPing(t.db, people.owner.actor, { webhookId: hook.webhookId }, at0);
    await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: { send: async () => ({ status: 503 }) } }, at0 + 1000);
    const failed = await deliveryOf(deliveryId);
    expect(failed).toMatchObject({ status: "failed", attempts: 1 });
    const at = (failed?.nextAttemptAt ?? at0) + 1;

    const sent: string[] = [];
    let retried = "not tried";
    let nestedDone = false;
    const nested = { send: async (request: SignedWebhookRequest) => (sent.push(request.headers["X-TamTam-Delivery"]), { status: 200 }) };
    const slow = {
      send: async (request: SignedWebhookRequest) => {
        sent.push(request.headers["X-TamTam-Delivery"]);
        if (request.headers["X-TamTam-Delivery"] === deliveryId && !nestedDone) {
          nestedDone = true;
          // while this attempt is out: a person presses "retry", and the next scheduled run starts
          retried = await outcome(() => retryDelivery(t.db, people.owner.actor, { deliveryId, reason: "أعد الإرسال" }, at));
          await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: nested }, at);
        }
        return { status: 200 };
      },
    };
    await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: slow }, at);
    expect(retried).toBe("delivery_not_retryable");
    expect(sent.filter((id) => id === deliveryId)).toHaveLength(1);
    expect(await deliveryOf(deliveryId)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  test("the home's deliveries waiting are the ones the webhook list counts as waiting (pending and failed)", async () => {
    const at = NOW + 4 * 86_400_000;
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Waiting", url: "https://hooks.partner.iq/waiting", events: ["order.returned"], reason: "ربط", idempotencyKey: key() }, at);
    await sendPing(t.db, people.owner.actor, { webhookId: hook.webhookId }, at);
    await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: { send: async () => ({ status: 500 }) } }, at + 1000);
    const overview = await channelsOverview(t.db, people.owner.actor, at + 2000);
    const rows = await listWebhooks(t.db, people.owner.actor);
    const waiting = rows.reduce((sum, row) => sum + row.counts.pending + row.counts.failed, 0);
    expect(rows.some((row) => row.counts.failed > 0)).toBe(true);
    expect(overview.webhooks?.pending).toBe(waiting);
  });
});

// ───────────────────────────────────────────────────────────────── typed digits

describe("digits typed in Arabic-Indic or Persian", () => {
  test("a channel key accepts them as a branch code does", async () => {
    const created = await createChannel(t.db, people.owner.actor, { key: "souq٢", nameAr: "سوق ٢", kind: "marketplace", idempotencyKey: key() }, NOW);
    const persian = await createChannel(t.db, people.owner.actor, { key: "shop۳", nameAr: "متجر ۳", kind: "social", idempotencyKey: key() }, NOW);
    const rows = await listChannels(t.db, people.owner.actor, "ar");
    expect(rows.find((row) => row.id === created.channelId)?.key).toBe("souq2");
    expect(rows.find((row) => row.id === persian.channelId)?.key).toBe("shop3");
  });
});

// ───────────────────────────────────────────────────────────────── providers

describe("a provider's endpoint is an outbound address", () => {
  test("only https on a public host name is kept — never metadata, a private address or plain http", async () => {
    const save = (endpoint: string, expected = "") =>
      saveProviderCredentials(t.db, people.owner.actor, DATA_KEY, { provider: "sms_gateway", config: { senderId: "TAMTAM", endpoint }, secret: "sms-gateway-secret-123", expected, reason: "تجهيز" }, NOW);
    expect(await fieldsOf(() => save("http://169.254.169.254/latest/meta-data"))).toEqual({ "config.endpoint": "url_https" });
    expect(await fieldsOf(() => save("https://10.0.0.5/send"))).toEqual({ "config.endpoint": "url_host" });
    expect(await fieldsOf(() => save("https://metadata.google.internal/computeMetadata"))).toEqual({ "config.endpoint": "url_host" });
    expect(await outcome(() => save("https://SMS.Gateway-Partner.iq/send"))).toBe("ok");
  });
});
