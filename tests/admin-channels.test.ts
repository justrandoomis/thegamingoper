/**
 * Admin module 21 "channels" (branches, sales channels and integrations) — services against a real local D1:
 *
 *   · authorization per role (owner, manager, finance, cashier, inventory, custom roles) on every service
 *   · 21.01 branches: create (idempotent, codes once, Arabic-Indic digits), stale forms refused, district rule, switching
 *     off refused while active records use it (re-checked in the write), branch limits; channels: the rules overview
 *     (POS price lists applied, the web's not), added channels only, the built-in ones never switched off
 *   · 21.02 orders by channel, demo left out unless asked
 *   · 21.06 profitability per channel from the journal: attribution, the POS by branch, what has no channel, commissions,
 *     the sum equal to the finance core's profit and loss, cost / profit keys ABSENT without cost.read / profit.read
 *   · 21.03 API keys (shown once, hash only, scopes only one holds, revoke, expiry) and the read API (401 / 400 / 403 / 405 /
 *     429, no cost, no customer data, audited per call, never the key)
 *   · 21.03 / 21.04 webhooks: the address rule (SSRF), isPublicAddress, the secret encrypted with DATA_KEY and shown once,
 *     order events queued once however often, no transport → nothing sent, signed requests, retries with backoff, given
 *     up after the last attempt, a retry repeats the same delivery, two runs never send the same attempt, pause
 *   · 21.04 inbound events: a repeat never acts twice, an unsigned event never acts
 *   · 21.05 providers: never connected, the secret encrypted and never returned or audited, stale forms refused
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { decryptSecret } from "~/server/crypto.server";
import { governorateId } from "~/server/db/seed/reference";
import { apiKeys, auditEvents, carriers, employeeRoles, employees, inboundEvents, integrations, inventoryLocations, orderEvents, posRegisters, priceLists, rolePermissions, roles, webhookDeliveries, webhooks } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { journalStatements, postCogs, postSale } from "~/server/services/accounting/post.server";
import { profitAndLoss } from "~/server/services/accounting/reports.server";
import { handleApiRequest } from "~/server/services/admin/channels/api.server";
import { apiKeyState, createApiKey, listApiKeys, revokeApiKey, verifyApiKey } from "~/server/services/admin/channels/apikeys.server";
import { createBranch, getBranch, listBranches, setBranchActive, updateBranch } from "~/server/services/admin/channels/branches.server";
import { createChannel, listChannels, renameChannel, setChannelActive } from "~/server/services/admin/channels/channels.server";
import { acceptInboundEvent } from "~/server/services/admin/channels/inbound.server";
import { channelsOverview, channelsQueueCounts, integrationMonitor } from "~/server/services/admin/channels/overview.server";
import { clearProviderCredentials, listProviders, saveProviderCredentials } from "~/server/services/admin/channels/providers.server";
import { channelProfitability, ordersByChannel } from "~/server/services/admin/channels/sales.server";
import { WEBHOOK_MAX_ATTEMPTS } from "~/server/services/admin/channels/types";
import {
  checkWebhookUrl,
  createWebhook,
  deliverWebhooks,
  getWebhook,
  isPublicAddress,
  queueOrderEvents,
  retryDelivery,
  rotateWebhookSecret,
  sendPing,
  setWebhookActive,
  updateWebhook,
  verifyWebhookSignature,
  type SignedWebhookRequest,
} from "~/server/services/admin/channels/webhooks.server";
import channelsMessages from "~/i18n/messages/admin-channels";
import { TEST_NOW, TEST_VARS, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DATA_KEY = TEST_VARS.DATA_KEY;
let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor };
const people: Record<string, Person> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "cashier", "inventory"] as const) people[role] = await person(role);
  // channel profitability without cost: the cost and profit keys must not reach this reader
  people.reportReader = await person(["channels.report.read"]);
  people.costReader = await person(["channels.report.read", "cost.read"]);
  // may manage keys but holds no API scope itself
  people.keyManager = await person(["channels.api_key.manage", "catalog.product.read"]);
  people.integrationReader = await person(["channels.integration.read"]);
}, 120_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[], branchId?: string): Promise<Person> {
  const id = await make.employee({ name: Array.isArray(role) ? `custom ${role.length}` : role, ...(branchId ? { branchId } : {}) });
  if (Array.isArray(role)) {
    const custom = `role_${make.next("ch").replace(/-/g, "_")}`;
    await t.db.insert(roles).values({ id: custom, key: custom.slice(5), name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom", branchId: branchId ?? null } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  const permissions = role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role);
  return { id, actor: { kind: "employee", id, permissions, label: role, branchId: branchId ?? null } };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const code = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.code ?? "unexpected";
const fieldsOf = async (run: () => Promise<unknown>) => toAppError(await thrown(run))?.fields ?? {};
const key = () => `${make.next("key")}-0123456789abcdef`;

// ───────────────────────────────────────────────────────────────── strings

describe("strings", () => {
  test("ar, en and ckb carry the same keys", () => {
    const keysOf = (tree: unknown, prefix = ""): string[] =>
      Object.entries(tree as Record<string, unknown>).flatMap(([name, value]) => {
        const full = prefix ? `${prefix}.${name}` : name;
        if (typeof value === "string") return [full];
        const plural = value && typeof value === "object" && "other" in (value as object) && Object.values(value as object).every((item) => typeof item === "string");
        return plural ? [full] : keysOf(value, full);
      });
    const ar = keysOf(channelsMessages.ar).sort();
    expect(keysOf(channelsMessages.en).sort()).toEqual(ar);
    expect(keysOf(channelsMessages.ckb).sort()).toEqual(ar);
  });
});

// ───────────────────────────────────────────────────────────────── 21.01 branches

describe("branches (21.01)", () => {
  test("a manager adds a branch once per form; the code is normalised, Arabic-Indic digits accepted, and used once", async () => {
    const formKey = key();
    const first = await createBranch(t.db, people.manager.actor, { code: "bgd-١", nameAr: "فرع بغداد", nameEn: "Baghdad", phone: "٠٧٧٠١٢٣٤٥٦٧", governorateId: governorateId("baghdad"), idempotencyKey: formKey }, NOW);
    expect(first.replayed).toBe(false);
    const again = await createBranch(t.db, people.manager.actor, { code: "BGD-1", nameAr: "فرع بغداد", idempotencyKey: formKey }, NOW);
    expect(again).toEqual({ branchId: first.branchId, replayed: true });
    const branch = await getBranch(t.db, people.manager.actor, first.branchId, "ar", NOW);
    expect(branch).toMatchObject({ code: "BGD-1", nameEn: "Baghdad", phone: "+9647701234567", isActive: true });
    expect(await fieldsOf(() => createBranch(t.db, people.manager.actor, { code: "BGD-1", nameAr: "آخر", idempotencyKey: key() }, NOW))).toEqual({ code: "code_taken" });
    expect(await fieldsOf(() => createBranch(t.db, people.manager.actor, { code: "?", nameAr: "", idempotencyKey: key() }, NOW))).toMatchObject({ code: "code_invalid", nameAr: "required" });
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "channels.branch.create"), eq(auditEvents.entityId, first.branchId)));
    expect(events).toHaveLength(1);
  });

  test("finance and cashiers cannot see or change branches", async () => {
    expect(await code(() => listBranches(t.db, people.finance.actor, "active", "ar"))).toBe("forbidden");
    expect(await code(() => createBranch(t.db, people.cashier.actor, { code: "X1", nameAr: "س", idempotencyKey: key() }, NOW))).toBe("forbidden");
  });

  test("a district of another governorate and a broken phone are refused", async () => {
    const district = await t.db.all<{ id: string }>(sql`SELECT id FROM districts WHERE governorate_id = ${governorateId("basra")} LIMIT 1`);
    const fields = await fieldsOf(() => createBranch(t.db, people.manager.actor, { code: "ERB-1", nameAr: "فرع", governorateId: governorateId("baghdad"), districtId: district[0].id, phone: "12", idempotencyKey: key() }, NOW));
    expect(fields).toEqual({ districtId: "district_mismatch", phone: "phone_invalid" });
  });

  test("a save is refused when the branch changed since the form was built", async () => {
    const { branchId } = await createBranch(t.db, people.owner.actor, { code: "NJF-1", nameAr: "فرع النجف", idempotencyKey: key() }, NOW);
    const seen = await getBranch(t.db, people.owner.actor, branchId, "ar", NOW);
    const saved = await updateBranch(t.db, people.manager.actor, { branchId, code: "NJF-1", nameAr: "فرع النجف الأشرف", fingerprint: seen.fingerprint, reason: "الاسم الكامل" }, NOW + 1);
    expect(saved.changed).toBe(true);
    // the same (now stale) form again
    expect(await code(() => updateBranch(t.db, people.owner.actor, { branchId, code: "NJF-1", nameAr: "اسم آخر", fingerprint: seen.fingerprint, reason: "تغيير" }, NOW + 2))).toBe("branch_changed");
    expect(await fieldsOf(() => updateBranch(t.db, people.owner.actor, { branchId, code: "NJF-1", nameAr: "اسم", fingerprint: seen.fingerprint, reason: "" }, NOW + 2))).toEqual({ reason: "reason_required" });
  });

  test("switching off is refused while an active register, location, employee or price list uses it — and works after", async () => {
    const { branchId } = await createBranch(t.db, people.owner.actor, { code: "KRB-1", nameAr: "فرع كربلاء", idempotencyKey: key() }, NOW);
    const locationId = newId("loc");
    await t.db.insert(inventoryLocations).values({ id: locationId, code: make.next("LOC"), name: "متجر كربلاء", kind: "store", branchId });
    const registerId = newId("reg");
    await t.db.insert(posRegisters).values({ id: registerId, code: make.next("REG"), name: "صندوق 1", branchId, locationId, createdAt: NOW });
    const limited = await make.employee({ branchId, status: "active" });
    const listId = newId("pl");
    await t.db.insert(priceLists).values({ id: listId, code: make.next("PL"), name: { ar: "قائمة كربلاء" }, branchId, isActive: true, createdAt: NOW, updatedAt: NOW });

    const usage = await getBranch(t.db, people.owner.actor, branchId, "ar", NOW);
    expect(usage.inUse).toEqual({ locations: 1, registers: 1, employees: 1, priceLists: 1 });
    expect(usage.usage.registers?.map((row) => row.id)).toEqual([registerId]);
    expect(await code(() => setBranchActive(t.db, people.owner.actor, { branchId, active: false, reason: "أغلق الفرع" }, NOW))).toBe("branch_in_use");

    await t.db.update(inventoryLocations).set({ isActive: false }).where(eq(inventoryLocations.id, locationId));
    await t.db.update(posRegisters).set({ isActive: false }).where(eq(posRegisters.id, registerId));
    await t.db.update(employees).set({ status: "disabled" }).where(eq(employees.id, limited));
    await t.db.update(priceLists).set({ isActive: false }).where(eq(priceLists.id, listId));
    expect(await setBranchActive(t.db, people.owner.actor, { branchId, active: false, reason: "أغلق الفرع" }, NOW)).toEqual({ changed: true });
    expect(await setBranchActive(t.db, people.owner.actor, { branchId, active: false, reason: "أغلق الفرع" }, NOW)).toEqual({ changed: false });
    const list = await listBranches(t.db, people.owner.actor, "inactive", "ar");
    expect(list.rows.some((row) => row.id === branchId)).toBe(true);
  });

  test("a branch-limited employee sees only their branch, never creates or switches one", async () => {
    const { branchId } = await createBranch(t.db, people.owner.actor, { code: "BSR-1", nameAr: "فرع البصرة", idempotencyKey: key() }, NOW);
    const other = await createBranch(t.db, people.owner.actor, { code: "MSL-1", nameAr: "فرع الموصل", idempotencyKey: key() }, NOW);
    const limited = await person("manager", branchId);
    const list = await listBranches(t.db, limited.actor, "all", "ar");
    expect(list.rows.map((row) => row.id)).toEqual([branchId]);
    expect(await code(() => getBranch(t.db, limited.actor, other.branchId, "ar", NOW))).toBe("not_found");
    expect(await code(() => createBranch(t.db, limited.actor, { code: "NEW-1", nameAr: "جديد", idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => setBranchActive(t.db, limited.actor, { branchId, active: false, reason: "إغلاق" }, NOW))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── 21.01 channels

describe("sales channels (21.01, 21.06)", () => {
  test("the overview says where each channel takes its stock, prices and delivery from", async () => {
    await t.db.insert(priceLists).values({ id: newId("pl"), code: make.next("PL"), name: { ar: "قائمة نقطة البيع" }, channel: "pos", isActive: true, createdAt: NOW, updatedAt: NOW });
    const rows = await listChannels(t.db, people.finance.actor, "ar");
    const web = rows.find((row) => row.key === "web");
    const pos = rows.find((row) => row.key === "pos");
    expect(web?.rules).toMatchObject({ stock: { kind: "sellable_locations" }, prices: { applied: false }, delivery: { kind: "governorate_fee", flatFeeIqd: 5000, overridesEnabled: false } });
    expect(pos?.rules).toMatchObject({ stock: { kind: "register_stores" }, prices: { applied: true }, delivery: { kind: "counter" } });
    expect(pos?.rules.prices.activeLists).toBeGreaterThanOrEqual(1);
    expect(web?.connected && pos?.connected).toBe(true);
    expect(await code(() => listChannels(t.db, people.cashier.actor, "ar"))).toBe("forbidden");
  });

  test("an added channel: keys checked, never web or pos, not connected; renamed with a fresh form only; switched off unless a price list uses it", async () => {
    expect(await fieldsOf(() => createChannel(t.db, people.manager.actor, { key: "web", nameAr: "ويب", kind: "marketplace", idempotencyKey: key() }, NOW))).toEqual({ key: "key_reserved" });
    expect(await fieldsOf(() => createChannel(t.db, people.manager.actor, { key: "1x", nameAr: "س", kind: "marketplace", idempotencyKey: key() }, NOW))).toEqual({ key: "key_invalid" });
    expect(await code(() => createChannel(t.db, people.finance.actor, { key: "noon", nameAr: "نون", kind: "marketplace", idempotencyKey: key() }, NOW))).toBe("forbidden");
    const formKey = key();
    const created = await createChannel(t.db, people.manager.actor, { key: "Noon", nameAr: "نون", kind: "marketplace", idempotencyKey: formKey }, NOW);
    expect((await createChannel(t.db, people.manager.actor, { key: "noon", nameAr: "نون", kind: "marketplace", idempotencyKey: formKey }, NOW)).replayed).toBe(true);
    expect(await fieldsOf(() => createChannel(t.db, people.manager.actor, { key: "noon", nameAr: "نون 2", kind: "social", idempotencyKey: key() }, NOW))).toEqual({ key: "code_taken" });
    const row = (await listChannels(t.db, people.manager.actor, "ar")).find((entry) => entry.id === created.channelId);
    expect(row).toMatchObject({ key: "noon", kind: "marketplace", isSystem: false, connected: false, rules: { stock: { kind: "none" }, delivery: { kind: "not_connected" } } });

    expect((await renameChannel(t.db, people.manager.actor, { channelId: created.channelId, nameAr: "نون العراق", fingerprint: row!.fingerprint, reason: "الاسم الرسمي" }, NOW)).changed).toBe(true);
    expect(await code(() => renameChannel(t.db, people.manager.actor, { channelId: created.channelId, nameAr: "اسم", fingerprint: row!.fingerprint, reason: "تغيير" }, NOW))).toBe("channel_changed");

    const web = (await listChannels(t.db, people.manager.actor, "ar")).find((entry) => entry.key === "web");
    expect(await code(() => setChannelActive(t.db, people.manager.actor, { channelId: web!.id, active: false, reason: "إيقاف" }, NOW))).toBe("channel_system");

    const listId = newId("pl");
    await t.db.insert(priceLists).values({ id: listId, code: make.next("PL"), name: { ar: "قائمة نون" }, channel: "noon", isActive: true, createdAt: NOW, updatedAt: NOW });
    expect(await code(() => setChannelActive(t.db, people.manager.actor, { channelId: created.channelId, active: false, reason: "إيقاف" }, NOW))).toBe("channel_in_use");
    await t.db.update(priceLists).set({ isActive: false }).where(eq(priceLists.id, listId));
    expect(await setChannelActive(t.db, people.manager.actor, { channelId: created.channelId, active: false, reason: "إيقاف" }, NOW)).toEqual({ changed: true });
  });
});

// ───────────────────────────────────────────────────────────────── 21.02 / 21.06

describe("orders by channel (21.02) and profitability (21.06)", () => {
  const range = { fromMs: NOW - 86_400_000, toMs: NOW + 86_400_000, demo: false, from: "2026-11-09", to: "2026-11-11" };
  let webOrder: { orderId: string; ref: string };
  let posOrder: { orderId: string; ref: string };
  let branchId: string;

  beforeAll(async () => {
    const product = await make.product({ priceIqd: 100_000 });
    ({ branchId } = await createBranch(t.db, people.owner.actor, { code: "PRF-1", nameAr: "فرع الأرباح", idempotencyKey: key() }, NOW));
    webOrder = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 2, unitPriceIqd: 100_000 }], { status: "delivered", discountIqd: 10_000 });
    posOrder = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1, unitPriceIqd: 100_000 }], { channel: "pos", status: "delivered", shippingIqd: 0, branchId, contactPhoneE164: null });
    const demo = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1, unitPriceIqd: 100_000 }], { status: "delivered", isDemo: true });
    const ctx = { at: NOW, createdBy: people.owner.id, isDemo: false };
    await runBatch(t.db, [
      ...postSale(t.db, { ...ctx, orderId: webOrder.orderId, ref: webOrder.ref, subtotalIqd: 200_000, discountIqd: 10_000, shippingIqd: 5000, totalIqd: 195_000 }),
      ...postCogs(t.db, { ...ctx, orderId: webOrder.orderId, ref: webOrder.ref, cogsIqd: 120_000 }),
      ...postSale(t.db, { ...ctx, orderId: posOrder.orderId, ref: posOrder.ref, subtotalIqd: 100_000, discountIqd: 0, shippingIqd: 0, totalIqd: 100_000 }),
      ...postCogs(t.db, { ...ctx, orderId: posOrder.orderId, ref: posOrder.ref, cogsIqd: 70_000 }),
      ...postSale(t.db, { ...ctx, isDemo: true, orderId: demo.orderId, ref: demo.ref, subtotalIqd: 100_000, discountIqd: 0, shippingIqd: 5000, totalIqd: 105_000 }),
      // a manual entry on the revenue account (no channel) and commissions paid with payroll (store-wide)
      ...journalStatements(t.db, { ...ctx, memo: "manual revenue", refType: "manual", refId: "m1", lines: [{ accountCode: "cash", debitIqd: 3000 }, { accountCode: "sales_revenue", creditIqd: 3000 }] }),
      ...journalStatements(t.db, { ...ctx, memo: "payroll", refType: "payroll_run", refId: "pr1", lines: [{ accountCode: "commissions", debitIqd: 8000 }, { accountCode: "cash", creditIqd: 8000 }] }),
    ]);
  });

  test("orders are summarised per channel, demo left out unless asked", async () => {
    const rows = await ordersByChannel(t.db, people.finance.actor, range, "ar");
    const web = rows.find((row) => row.key === "web");
    const pos = rows.find((row) => row.key === "pos");
    expect(pos).toMatchObject({ placed: 1, delivered: 1, gmvIqd: 100_000, averageBasketIqd: 100_000 });
    const withDemo = await ordersByChannel(t.db, people.finance.actor, { ...range, demo: true }, "ar");
    expect(withDemo.find((row) => row.key === "web")!.placed).toBe(web!.placed + 1);
    expect(await code(() => ordersByChannel(t.db, people.cashier.actor, range, "ar"))).toBe("forbidden");
  });

  test("each posting counts for its order's channel, the POS by branch; the channels add up to the finance core's profit and loss", async () => {
    const report = await channelProfitability(t.db, people.finance.actor, range, "ar");
    const web = report.rows.find((row) => row.key === "web")!;
    const pos = report.rows.find((row) => row.key === "pos")!;
    expect(web).toMatchObject({ ordersRecognised: 1, grossIqd: 200_000, discountsIqd: 10_000, netRevenueIqd: 190_000, shippingIncomeIqd: 5000, cogsIqd: 120_000, grossProfitIqd: 70_000, contributionIqd: 75_000 });
    expect(pos).toMatchObject({ ordersRecognised: 1, netRevenueIqd: 100_000, cogsIqd: 70_000, grossProfitIqd: 30_000 });
    expect(pos.branches).toEqual([expect.objectContaining({ branchId, name: "فرع الأرباح", ordersRecognised: 1, netRevenueIqd: 100_000, cogsIqd: 70_000, grossProfitIqd: 30_000 })]);
    expect(report.unattributed.grossIqd).toBe(3000);
    expect(report.commissionsIqd).toBe(8000);

    const pnl = await profitAndLoss(t.db, people.finance.actor, { from: range.fromMs, to: range.toMs, includeDemo: false });
    const channelNet = report.rows.reduce((sum, row) => sum + row.netRevenueIqd, 0);
    expect(channelNet + report.unattributed.grossIqd - report.unattributed.discountsIqd - report.unattributed.refundsIqd).toBe(pnl.revenue.netIqd);
    const contributions = report.rows.reduce((sum, row) => sum + (row.contributionIqd ?? 0), 0);
    const unattributed = report.unattributed.grossIqd - report.unattributed.discountsIqd - report.unattributed.refundsIqd - (report.unattributed.cogsIqd ?? 0) - ((report.unattributed.shippingCostsIqd ?? 0) - report.unattributed.shippingIncomeIqd);
    expect(contributions + unattributed - (report.commissionsIqd ?? 0)).toBe(pnl.profit!.netIqd);
    expect(report.store.netProfitIqd).toBe(pnl.profit!.netIqd);
  });

  test("cost and profit figures are ABSENT without cost.read / profit.read — not null, not 0", async () => {
    const plain = await channelProfitability(t.db, people.reportReader.actor, range, "ar");
    const web = plain.rows.find((row) => row.key === "web")!;
    expect(web.netRevenueIqd).toBe(190_000);
    for (const field of ["cogsIqd", "shippingCostsIqd", "uncostedUnits", "grossProfitIqd", "grossMarginBps", "contributionIqd", "contributionMarginBps"]) expect(field in web).toBe(false);
    expect("cogsIqd" in plain.unattributed || "commissionsIqd" in plain || "netProfitIqd" in plain.store || "cogsIqd" in plain.store).toBe(false);
    expect(JSON.stringify(plain)).not.toContain("120000");
    expect(plain.fields).toEqual({ cost: false, profit: false });

    const costOnly = await channelProfitability(t.db, people.costReader.actor, range, "ar");
    const costWeb = costOnly.rows.find((row) => row.key === "web")!;
    expect(costWeb.cogsIqd).toBe(120_000);
    expect("grossProfitIqd" in costWeb || "contributionIqd" in costWeb || "commissionsIqd" in costOnly).toBe(false);
    expect(await code(() => channelProfitability(t.db, people.cashier.actor, range, "ar"))).toBe("forbidden");
  });
});

// ───────────────────────────────────────────────────────────────── 21.03 API keys and the API

describe("API keys and the read API (21.03)", () => {
  const request = (path: string, init: { key?: string | null; method?: string } = {}) =>
    new Request(`http://localhost:5173${path}`, { method: init.method ?? "GET", headers: init.key ? { authorization: `Bearer ${init.key}` } : {} });
  const call = (path: string, resource: string, init: { key?: string | null; method?: string; now?: number } = {}) => handleApiRequest(t.db, request(path, init), { ip: null, requestId: "req-test", now: init.now ?? NOW }, resource);

  test("a key is shown once, only its hash is kept, scopes only one holds; managers without the permission are refused", async () => {
    expect(await code(() => createApiKey(t.db, people.manager.actor, { name: "ERP", scopes: ["orders.order.read"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await code(() => createApiKey(t.db, people.keyManager.actor, { name: "ERP", scopes: ["orders.order.read"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("scope_not_held");
    expect(await fieldsOf(() => createApiKey(t.db, people.owner.actor, { name: "ERP", scopes: [], reason: "ربط", idempotencyKey: key() }, NOW))).toEqual({ scopes: "scope_required" });
    expect(await fieldsOf(() => createApiKey(t.db, people.owner.actor, { name: "ERP", scopes: ["cost.read"], reason: "ربط", idempotencyKey: key() }, NOW))).toEqual({ scopes: "scope_unknown" });
    expect(await fieldsOf(() => createApiKey(t.db, people.owner.actor, { name: "ERP", scopes: ["orders.order.read"], expiresInDays: "٧", rateLimitPerMin: "abc", reason: "ربط", idempotencyKey: key() }, NOW))).toEqual({ expiresInDays: "expiry_invalid", rateLimitPerMin: "rate_invalid" });

    const formKey = key();
    const created = await createApiKey(t.db, people.owner.actor, { name: "ERP", scopes: ["orders.order.read", "catalog.product.read"], expiresInDays: "٩٠", rateLimitPerMin: "٦٠", reason: "ربط نظام المحاسبة", idempotencyKey: formKey }, NOW);
    expect(created.key).toMatch(/^ttk_[0-9A-Z]{8}_[A-Za-z0-9_-]{43}$/);
    const replay = await createApiKey(t.db, people.owner.actor, { name: "ERP", scopes: ["orders.order.read"], reason: "ربط نظام المحاسبة", idempotencyKey: formKey }, NOW);
    expect(replay).toMatchObject({ keyId: created.keyId, key: null, replayed: true });

    const stored = await t.db.select().from(apiKeys).where(eq(apiKeys.id, created.keyId)).get();
    expect(stored?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.key!.slice(13));
    expect(stored?.expiresAt).toBe(NOW + 90 * 86_400_000);
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, created.keyId));
    expect(JSON.stringify(audit)).not.toContain(created.key!.slice(13));
    const list = await listApiKeys(t.db, people.owner.actor, NOW);
    expect(JSON.stringify(list)).not.toContain(stored!.keyHash);
  });

  test("the API: 401 without or with a wrong key, 400 for a key in the address, 405 for a write, 403 without the scope, rows without cost or customer data, every answer audited", async () => {
    const product = await make.product({ priceIqd: 250_000, stock: 20 });
    const order = await make.order([{ variantId: product.variantId, sku: product.sku, qty: 1, unitPriceIqd: 250_000 }], { contactName: "زبون سري", status: "confirmed" });
    const { key: secret, keyId } = await createApiKey(t.db, people.owner.actor, { name: "Shop sync", scopes: ["catalog.product.read", "orders.order.read"], reason: "مزامنة", idempotencyKey: key() }, NOW);

    expect((await call("/api/v1/products", "products")).status).toBe(401);
    expect((await call("/api/v1/products", "products", { key: `${secret!.slice(0, -1)}A` })).status).toBe(401);
    expect((await call(`/api/v1/products?key=${secret}`, "products", { key: secret })).status).toBe(400);
    expect((await call("/api/v1/products", "products", { key: secret, method: "POST" })).status).toBe(405);
    const stock = await call("/api/v1/stock", "stock", { key: secret });
    expect(stock.status).toBe(403);
    expect(await stock.json()).toEqual({ error: "forbidden", scope: "inventory.stock.read" });

    const products = await call("/api/v1/products?limit=100", "products", { key: secret });
    expect(products.status).toBe(200);
    expect(products.headers.get("cache-control")).toBe("no-store");
    const body = (await products.json()) as { data: Record<string, unknown>[] };
    const row = body.data.find((entry) => entry.sku === product.sku);
    expect(row).toMatchObject({ priceIqd: 250_000, stockState: "in_stock", currency: "IQD", demo: false });
    expect(JSON.stringify(body)).not.toMatch(/cost|margin|landed/i);

    const orders = await call("/api/v1/orders?limit=100", "orders", { key: secret });
    const orderBody = (await orders.json()) as { data: Record<string, unknown>[] };
    const found = orderBody.data.find((entry) => entry.ref === order.ref);
    expect(found).toMatchObject({ status: "confirmed", totalIqd: order.totalIqd, lines: [expect.objectContaining({ sku: product.sku, qty: 1 })] });
    expect(JSON.stringify(orderBody)).not.toMatch(/زبون سري|\+9647|address|contact|cost/i);
    expect((await call("/api/v1/orders?limit=500", "orders", { key: secret })).status).toBe(400);

    const audited = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "channels.api.call"), eq(auditEvents.entityId, keyId)));
    expect(audited.map((event) => (event.after as { status: number }).status).sort()).toEqual([200, 200, 400, 403]);
    expect(audited.every((event) => event.actorKind === "system" && event.actorId === `api_key:${keyId}`)).toBe(true);
    expect(JSON.stringify(audited)).not.toContain(secret!.slice(13));
  });

  test("a key's own limit a minute is enforced (429 with Retry-After); revoked and expired keys stop at once", async () => {
    const { key: secret, keyId } = await createApiKey(t.db, people.owner.actor, { name: "Tight", scopes: ["catalog.product.read"], rateLimitPerMin: "2", expiresInDays: "30", reason: "حد صغير", idempotencyKey: key() }, NOW);
    const at = NOW + 5 * 60_000;
    expect((await call("/api/v1/products", "products", { key: secret, now: at })).status).toBe(200);
    expect((await call("/api/v1/products", "products", { key: secret, now: at })).status).toBe(200);
    const limited = await call("/api/v1/products", "products", { key: secret, now: at });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    expect(await verifyApiKey(t.db, secret!, NOW + 31 * 86_400_000)).toBeNull();
    expect(apiKeyState({ expiresAt: NOW + 30 * 86_400_000, revokedAt: null }, NOW + 31 * 86_400_000)).toBe("expired");
    expect(await revokeApiKey(t.db, people.owner.actor, { keyId, reason: "انتهى الربط" }, NOW)).toEqual({ changed: true });
    expect(await verifyApiKey(t.db, secret!, NOW)).toBeNull();
    expect((await call("/api/v1/products", "products", { key: secret, now: at + 120_000 })).status).toBe(401);
    expect(await verifyApiKey(t.db, "ttk_short", NOW)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── 21.03 / 21.04 webhooks

describe("webhooks (21.03, 21.04)", () => {
  test("only https on 443 with a public host name: every private, loopback, encoded or credentialed address is refused", () => {
    const refused: [string, string][] = [
      ["http://hooks.example.com/x", "url_https"],
      ["https://localhost/x", "url_host"],
      ["https://127.0.0.1/x", "url_host"],
      ["https://2130706433/x", "url_host"],
      ["https://0x7f.1/x", "url_host"],
      ["https://[::1]/x", "url_host"],
      ["https://10.0.0.8/x", "url_host"],
      ["https://169.254.169.254/latest/meta-data", "url_host"],
      ["https://metadata.google.internal/x", "url_host"],
      ["https://printer.local/x", "url_host"],
      ["https://intranet/x", "url_host"],
      ["https://user:pass@hooks.example.org/x", "url_credentials"],
      ["https://hooks.tamtam.iq:8443/x", "url_port"],
      ["ftp://hooks.tamtam.iq/x", "url_https"],
      ["not a url", "url_invalid"],
    ];
    for (const [url, error] of refused) expect(checkWebhookUrl(url), url).toEqual({ error });
    expect(checkWebhookUrl("https://Hooks.Partner.iq/tamtam?x=1#frag")).toEqual({ url: "https://hooks.partner.iq/tamtam?x=1" });
    expect(checkWebhookUrl("https://hooks.partner.iq:443/a")).toEqual({ url: "https://hooks.partner.iq/a" });
  });

  test("isPublicAddress (what a future transport must check after DNS) refuses every local and metadata range", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.100.200", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2001:db8::1", "ff02::1", "64:ff9b::7f00:1"]) expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["8.8.8.8", "185.199.108.153", "2606:4700:4700::1111", "2a00:1450:4001::200e"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  test("the signing secret is shown once and stored encrypted (DATA_KEY, bound to the webhook); without DATA_KEY nothing is created", async () => {
    expect(await code(() => createWebhook(t.db, people.owner.actor, undefined, { name: "ERP", url: "https://hooks.partner.iq/tt", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("data_key_missing");
    expect(await code(() => createWebhook(t.db, people.manager.actor, DATA_KEY, { name: "ERP", url: "https://hooks.partner.iq/tt", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW))).toBe("forbidden");
    expect(await fieldsOf(() => createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "ERP", url: "https://10.0.0.1/tt", events: [], reason: "ربط", idempotencyKey: key() }, NOW))).toEqual({ url: "url_host", events: "events_required" });
    const formKey = key();
    const created = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "ERP", url: "https://hooks.partner.iq/tt", events: ["order.placed"], reason: "ربط", idempotencyKey: formKey }, NOW);
    expect(created.secret).toMatch(/^whsec_/);
    expect((await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "ERP", url: "https://hooks.partner.iq/tt", events: ["order.placed"], reason: "ربط", idempotencyKey: formKey }, NOW)).secret).toBeNull();
    const row = await t.db.select().from(webhooks).where(eq(webhooks.id, created.webhookId)).get();
    expect(row?.secretEnc).not.toContain(created.secret!);
    expect(await decryptSecret(row!.secretEnc, DATA_KEY, `webhook:${created.webhookId}:secret`)).toBe(created.secret);
    await expect(decryptSecret(row!.secretEnc, DATA_KEY, "webhook:other:secret")).rejects.toThrow();
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, created.webhookId));
    expect(JSON.stringify(audit)).not.toContain(created.secret!);
    expect(JSON.stringify(audit)).not.toContain("/tt");
  });

  test("order events are queued once per webhook however often the queue runs; nothing from before the webhook existed", async () => {
    const product = await make.product();
    const before = await make.order([{ variantId: product.variantId, sku: product.sku }]);
    await t.db.insert(orderEvents).values({ id: newId("oev"), orderId: before.orderId, kind: "placed", actorKind: "system", at: NOW + 1000 });
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Queue", url: "https://hooks.partner.iq/q", events: ["order.placed", "order.shipped"], reason: "ربط", idempotencyKey: key() }, NOW + 2000);
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], { status: "shipped" });
    await t.db.insert(orderEvents).values([
      { id: newId("oev"), orderId: order.orderId, kind: "placed", actorKind: "customer", at: NOW + 3000 },
      { id: newId("oev"), orderId: order.orderId, kind: "status_changed", data: { from: "preparing", to: "shipped" }, actorKind: "employee", at: NOW + 4000 },
      { id: newId("oev"), orderId: order.orderId, kind: "status_changed", data: { from: "new", to: "confirmed" }, actorKind: "employee", at: NOW + 3500 },
    ]);
    const first = await queueOrderEvents(t.db, NOW + 5000);
    const second = await queueOrderEvents(t.db, NOW + 6000);
    const rows = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.webhookId));
    expect(rows.map((row) => row.event).sort()).toEqual(["order.placed", "order.shipped"]);
    expect(first.queued).toBeGreaterThanOrEqual(2);
    expect(second.queued).toBe(0);
    const shipped = rows.find((row) => row.event === "order.shipped")!;
    expect(shipped.payload).toMatchObject({ event: "order.shipped", data: { order: { ref: order.ref, status: "shipped", channel: "web" } } });
    expect(JSON.stringify(rows)).not.toMatch(/\+9647|address|cost/i);
  });

  test("the queue reads only the events a webhook hears, so many other events never stall it", async () => {
    const product = await make.product();
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Delivered only", url: "https://hooks.partner.iq/delivered", events: ["order.delivered"], reason: "ربط", idempotencyKey: key() }, NOW + 10_000);
    const order = await make.order([{ variantId: product.variantId, sku: product.sku }], { status: "delivered" });
    await t.db.insert(orderEvents).values([
      ...Array.from({ length: 5 }, (_, index) => ({ id: newId("oev"), orderId: order.orderId, kind: "placed", actorKind: "customer" as const, at: NOW + 11_000 + index })),
      { id: newId("oev"), orderId: order.orderId, kind: "status_changed", data: { from: "shipped", to: "delivered" }, actorKind: "employee" as const, at: NOW + 12_000 },
    ]);
    await queueOrderEvents(t.db, NOW + 13_000);
    const rows = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.webhookId));
    expect(rows.map((row) => row.event)).toEqual(["order.delivered"]);
  });

  test("no transport: nothing is sent and nothing changes; with one: signed, sent once, retried with backoff, given up, retried by a person as the same delivery", async () => {
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Deliver", url: "https://hooks.partner.iq/d", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW);
    const { deliveryId } = await sendPing(t.db, people.owner.actor, { webhookId: hook.webhookId }, NOW);
    const idle = await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: null }, NOW);
    expect(idle.reason).toBe("no_transport");
    expect((await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get())).toMatchObject({ status: "pending", attempts: 0 });

    // a receiver that fails every time: backoff, then given up after the last attempt
    const sent: SignedWebhookRequest[] = [];
    const failing = { send: async (request: SignedWebhookRequest) => (sent.push(request), { status: 500 }) };
    let at = NOW + 1000;
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: failing }, at);
      const row = await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get();
      expect(row?.attempts).toBe(attempt);
      expect(row?.status).toBe(attempt === WEBHOOK_MAX_ATTEMPTS ? "gave_up" : "failed");
      // not due again before its wait is over
      if (attempt < WEBHOOK_MAX_ATTEMPTS) {
        await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: failing }, at + 1);
        expect((await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get())?.attempts).toBe(attempt);
        at = (row?.nextAttemptAt ?? at) + 1;
      }
    }
    const mine = sent.filter((request) => request.headers["X-TamTam-Delivery"] === deliveryId);
    expect(mine).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    const secretRow = await t.db.select().from(webhooks).where(eq(webhooks.id, hook.webhookId)).get();
    const secret = await decryptSecret(secretRow!.secretEnc, DATA_KEY, `webhook:${hook.webhookId}:secret`);
    expect(await verifyWebhookSignature(secret, mine[0].headers["X-TamTam-Signature"], mine[0].body, NOW + 1000)).toBe(true);
    expect(await verifyWebhookSignature(secret, mine[0].headers["X-TamTam-Signature"], `${mine[0].body} `, NOW + 1000)).toBe(false);
    expect(secretRow?.failureCount).toBe(WEBHOOK_MAX_ATTEMPTS);

    // a person makes it due again: the SAME delivery is sent, once, and never again after success
    expect(await code(() => retryDelivery(t.db, people.manager.actor, { deliveryId, reason: "أُصلح المستقبل" }, at))).toBe("forbidden");
    expect(await retryDelivery(t.db, people.owner.actor, { deliveryId, reason: "أُصلح المستقبل" }, at)).toEqual({ changed: true });
    const ok: SignedWebhookRequest[] = [];
    const receiver = { send: async (request: SignedWebhookRequest) => (ok.push(request), { status: 204 }) };
    await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: receiver }, at + 1);
    await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: receiver }, at + 2);
    expect(ok.filter((request) => request.headers["X-TamTam-Delivery"] === deliveryId)).toHaveLength(1);
    expect((await t.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).get())?.status).toBe("succeeded");
    expect(await code(() => retryDelivery(t.db, people.owner.actor, { deliveryId, reason: "مرة أخرى" }, at + 3))).toBe("delivery_not_retryable");
    expect((await t.db.select().from(webhooks).where(eq(webhooks.id, hook.webhookId)).get())?.failureCount).toBe(0);
  });

  test("two delivery runs at once never send the same attempt twice; a paused webhook sends and queues nothing", async () => {
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Race", url: "https://hooks.partner.iq/r", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await sendPing(t.db, people.owner.actor, { webhookId: hook.webhookId }, NOW)).deliveryId);
    const seen: string[] = [];
    const slow = {
      send: async (request: SignedWebhookRequest) => {
        seen.push(request.headers["X-TamTam-Delivery"]);
        await new Promise((resolve) => setTimeout(resolve, 15));
        return { status: 200 };
      },
    };
    await Promise.all([deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: slow }, NOW + 10), deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: slow }, NOW + 10)]);
    for (const id of ids) expect(seen.filter((entry) => entry === id)).toHaveLength(1);

    const paused = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Paused", url: "https://hooks.partner.iq/p", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW);
    const pending = await sendPing(t.db, people.owner.actor, { webhookId: paused.webhookId }, NOW);
    expect(await setWebhookActive(t.db, people.owner.actor, { webhookId: paused.webhookId, active: false, reason: "صيانة المستقبل" }, NOW)).toEqual({ changed: true });
    expect(await code(() => sendPing(t.db, people.owner.actor, { webhookId: paused.webhookId }, NOW))).toBe("webhook_inactive");
    const sent: string[] = [];
    await deliverWebhooks(t.db, { dataKey: DATA_KEY, transport: { send: async (request) => (sent.push(request.headers["X-TamTam-Delivery"]), { status: 200 }) } }, NOW + 20);
    expect(sent).not.toContain(pending.deliveryId);
  });

  test("a new secret replaces the old one at once; a stale form is refused", async () => {
    const hook = await createWebhook(t.db, people.owner.actor, DATA_KEY, { name: "Rotate", url: "https://hooks.partner.iq/s", events: ["order.placed"], reason: "ربط", idempotencyKey: key() }, NOW);
    const { secret } = await rotateWebhookSecret(t.db, people.owner.actor, DATA_KEY, { webhookId: hook.webhookId, reason: "تسرب محتمل" }, NOW);
    const row = await t.db.select().from(webhooks).where(eq(webhooks.id, hook.webhookId)).get();
    expect(await decryptSecret(row!.secretEnc, DATA_KEY, `webhook:${hook.webhookId}:secret`)).toBe(secret);
    expect(secret).not.toBe(hook.secret);
    const view = await getWebhook(t.db, people.owner.actor, hook.webhookId);
    expect(await updateWebhook(t.db, people.owner.actor, { webhookId: hook.webhookId, name: "Rotate 2", url: view.url, events: ["order.placed"], fingerprint: view.fingerprint, reason: "اسم" }, NOW)).toEqual({ changed: true });
    expect(await code(() => updateWebhook(t.db, people.owner.actor, { webhookId: hook.webhookId, name: "Rotate 3", url: view.url, events: ["order.placed"], fingerprint: view.fingerprint, reason: "اسم" }, NOW))).toBe("webhook_changed");
  });
});

// ───────────────────────────────────────────────────────────────── 21.04 inbound events

describe("inbound provider events (21.04, acceptance: a webhook received again never duplicates)", () => {
  test("the event and its effect are one batch: a repeat changes nothing; an unsigned event never acts", async () => {
    const effect = () => [journalStatements(t.db, { at: NOW, memo: "provider settlement", refType: "manual", refId: "inbound-test", createdBy: null, isDemo: true, lines: [{ accountCode: "cash", debitIqd: 1000 }, { accountCode: "bank_clearing", creditIqd: 1000 }] })].flat();
    const count = async () => Number((await t.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM journal_entries WHERE ref_id = 'inbound-test'`))[0].n);
    const forged = await acceptInboundEvent(t.db, { provider: "zaincash", eventId: "evt-1", eventType: "payment.paid", payload: { amount: 1000 }, signatureOk: false }, effect(), NOW);
    expect(forged.status).toBe("refused");
    expect(await count()).toBe(0);
    const first = await acceptInboundEvent(t.db, { provider: "zaincash", eventId: "evt-1", eventType: "payment.paid", payload: { amount: 1000 }, signatureOk: true }, effect(), NOW);
    const again = await acceptInboundEvent(t.db, { provider: "zaincash", eventId: "evt-1", eventType: "payment.paid", payload: { amount: 1000 }, signatureOk: true }, [], NOW + 1);
    expect([first.status, again.status]).toEqual(["processed", "replayed"]);
    expect(await count()).toBe(1);
    const both = await Promise.all([1, 2].map(() => acceptInboundEvent(t.db, { provider: "zaincash", eventId: "evt-2", signatureOk: true }, [], NOW)));
    expect(both.map((entry) => entry.status).sort()).toEqual(["processed", "replayed"]);
    expect(await t.db.select().from(inboundEvents).where(eq(inboundEvents.id, "zaincash:evt-1")).get()).toMatchObject({ status: "processed", signatureOk: true });
  });
});

// ───────────────────────────────────────────────────────────────── 21.05 providers

describe("providers (21.05)", () => {
  test("never connected; the secret is encrypted, never returned, never audited; stale forms refused; managers read but do not save", async () => {
    await t.db.insert(carriers).values({ id: "car_ch_test", code: "CH-TEST", name: "Courier Test", kind: "third_party", createdAt: NOW, isDemo: true });
    const list = await listProviders(t.db, people.manager.actor, "ar");
    expect(list.every((provider) => provider.connected === false)).toBe(true);
    expect(list.map((provider) => provider.key)).toEqual(expect.arrayContaining(["zaincash", "whatsapp_cloud", "carrier:car_ch_test"]));
    expect(await code(() => listProviders(t.db, people.cashier.actor, "ar"))).toBe("forbidden");
    expect(await code(() => saveProviderCredentials(t.db, people.manager.actor, DATA_KEY, { provider: "zaincash", config: {}, secret: "s3cr3t-value-123", expected: "", reason: "تجهيز" }, NOW))).toBe("forbidden");
    expect(await code(() => saveProviderCredentials(t.db, people.owner.actor, undefined, { provider: "zaincash", config: {}, secret: "s3cr3t-value-123", expected: "", reason: "تجهيز" }, NOW))).toBe("data_key_missing");
    expect(await code(() => saveProviderCredentials(t.db, people.owner.actor, DATA_KEY, { provider: "unknown", config: {}, secret: "x", expected: "", reason: "تجهيز" }, NOW))).toBe("provider_unknown");
    expect(await fieldsOf(() => saveProviderCredentials(t.db, people.owner.actor, DATA_KEY, { provider: "zaincash", config: {}, expected: "", reason: "تجهيز" }, NOW))).toEqual({ secret: "secret_required" });

    const SECRET = "zc-merchant-secret-9f8e7d";
    expect(await saveProviderCredentials(t.db, people.owner.actor, DATA_KEY, { provider: "zaincash", config: { merchantId: "M-1001", msisdn: "9647800000000", injected: "x" }, secret: SECRET, expected: "", reason: "تجهيز الربط" }, NOW)).toEqual({ changed: true });
    const row = await t.db.select().from(integrations).where(and(eq(integrations.kind, "payment"), eq(integrations.provider, "zaincash"))).get();
    expect(row).toMatchObject({ status: "disabled", config: { merchantId: "M-1001", msisdn: "9647800000000" } });
    expect(row?.secretEnc).not.toContain(SECRET);
    expect(await decryptSecret(row!.secretEnc!, DATA_KEY, "integration:payment:zaincash:secret")).toBe(SECRET);
    const after = await listProviders(t.db, people.integrationReader.actor, "ar");
    const zain = after.find((provider) => provider.key === "zaincash")!;
    expect(zain).toMatchObject({ state: "credentials_saved", connected: false, hasSecret: true, config: { merchantId: "M-1001" } });
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, row!.id)))).not.toContain(SECRET);

    expect(await code(() => saveProviderCredentials(t.db, people.owner.actor, DATA_KEY, { provider: "zaincash", config: { merchantId: "M-2" }, expected: "", reason: "تغيير" }, NOW + 1))).toBe("integration_changed");
    expect(await saveProviderCredentials(t.db, people.owner.actor, DATA_KEY, { provider: "zaincash", config: { merchantId: "M-2" }, expected: String(zain.expected), reason: "تغيير المعرف" }, NOW + 1)).toEqual({ changed: true });
    expect(await decryptSecret((await t.db.select().from(integrations).where(eq(integrations.id, row!.id)).get())!.secretEnc!, DATA_KEY, "integration:payment:zaincash:secret")).toBe(SECRET);
    expect(await clearProviderCredentials(t.db, people.owner.actor, { provider: "zaincash", reason: "إلغاء الربط" }, NOW + 2)).toEqual({ changed: true });
    expect(await code(() => clearProviderCredentials(t.db, people.owner.actor, { provider: "zaincash", reason: "مرة ثانية" }, NOW + 3))).toBe("credentials_missing");
  });
});

// ───────────────────────────────────────────────────────────────── overview

describe("overview, monitor and the bell", () => {
  test("each figure only for who may open its page; the monitor says nothing is sent; the bell counts given-up deliveries for webhook managers only", async () => {
    const cashier = await code(() => channelsOverview(t.db, people.cashier.actor, NOW));
    expect(cashier).toBe("forbidden");
    const finance = await channelsOverview(t.db, people.finance.actor, NOW);
    expect(finance.branches).toBeNull();
    expect(finance.apiKeys).toBeNull();
    expect(finance.channels).not.toBeNull();
    const owner = await channelsOverview(t.db, people.owner.actor, NOW);
    expect(owner.branches?.active).toBeGreaterThan(0);
    const monitor = await integrationMonitor(t.db, people.integrationReader.actor, NOW);
    expect(monitor.transport).toBe(false);
    expect(monitor.providers.connected).toBe(0);
    expect(monitor.canRetry).toBe(false);
    expect((await channelsQueueCounts(t.db, people.manager.actor)).deliveriesGaveUp).toBeNull();
    expect((await channelsQueueCounts(t.db, people.owner.actor)).deliveriesGaveUp).toBeGreaterThanOrEqual(0);
  });
});
