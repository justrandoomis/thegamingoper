/**
 * Admin module 22 "settings" — services and routes against a real local D1:
 *
 *   · setSetting `{ expected }`: refused when the value in force differs — before the batch and inside it (a change
 *     landing in between is never overwritten silently)
 *   · money-control limits: changed directly only by who holds settings.change.approve; anyone else requests, another
 *     person approves (never the requester), approval and value in ONE batch guarded on the value asked against; one
 *     open request per key; expiry; withdraw; idempotent requests
 *   · the modules read their limits from settings with the same defaults as their old constants, and a changed
 *     setting changes their behaviour (price cuts, purchase orders, expenses, return service targets)
 *   · custom fields: one key across kinds, key/type locks, options in use, a stale form refused, all audited
 *   · templates: only the message's variables, the required ones present, a stale form refused
 *   · policies: draft from the code's text, edit as lines (round trip of the real drafts), approve, withdraw
 *   · routes: 403 for a role without settings.read; the key page's change/decide actions
 */
import { and, eq } from "drizzle-orm";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { randomToken } from "~/lib/ids";
import { action as keyAction } from "~/routes/admin/settings/key";
import { loader as settingsLoader } from "~/routes/admin/settings/home";
import type { EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { PRODUCT_KIND_SCOPES } from "~/server/db/columns";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { CUSTOM_FIELD_TYPES, approvals, auditEvents, customFields, employeeRoles, products, purchaseOrders, rolePermissions, roles, settings } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { EXPENSE_SECOND_APPROVAL_ABOVE_IQD, expenseApprovalLimit, needsOtherApprover } from "~/server/services/accounting/expenses.server";
import { TOPUP_SECOND_APPROVAL_ABOVE_IQD } from "~/server/services/admin/finance/wallets.server";
import { previewPriceChange } from "~/server/services/admin/pricing/prices.server";
import { DROP_APPROVAL_BPS } from "~/server/services/admin/pricing/rules";
import { savePurchaseOrder, submitPurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { PO_SPENDING_LIMIT_IQD } from "~/server/services/admin/purchasing/rules";
import { createSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { slaTargets } from "~/server/services/admin/returns/shared.server";
import { SLA } from "~/server/services/admin/returns/types";
import { EDITABLE_POLICIES, FIELD_KINDS, FIELD_TYPES, SETTING_EDITORS, TEMPLATE_CATALOG, parsePercentBps, parseWhole } from "~/server/services/admin/settings/catalog";
import { REQUEST_TTL_MS, countDecidableSettingChanges, decideSettingChange, getSettingItem, listChanges, proposeSettingChange } from "~/server/services/admin/settings/changes.server";
import { getCustomField, saveCustomField, setCustomFieldActive } from "~/server/services/admin/settings/custom-fields.server";
import { archivePolicy, getPolicyEditor, publishPolicy, savePolicyDraft, startPolicyDraft } from "~/server/services/admin/settings/policies.server";
import { blocksToText, textToBlocks } from "~/server/services/admin/settings/policy-text";
import { getTemplate, saveTemplate } from "~/server/services/admin/settings/templates.server";
import { getPolicy, getPolicyDraftL10n, listPolicies } from "~/server/services/content.server";
import { SETTING_KEYS, getSetting, isSettingChangedError, setSetting, settingChangeStatements, settingDefault } from "~/server/settings.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const ORIGIN = "http://localhost:5173";

let t: TestDb;
let make: Fixtures;
type Person = { id: string; actor: EmployeeActor; email: string; password: string };
const people: Record<string, Person> = {};
let roleSeq = 0;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const role of ["owner", "manager", "finance", "cashier"] as const) people[role] = await person(role);
  people.owner2 = await person("owner");
  people.manager2 = await person("manager");
}, 90_000);
afterAll(async () => {
  await t?.dispose();
});

async function person(role: DefaultRoleKey | Permission[]): Promise<Person> {
  const password = "settings-test-password-1";
  const hashed = await hashPassword(password, 1000);
  const email = `${make.next("set")}@settings.test`;
  const id = await make.employee({ email, name: Array.isArray(role) ? "custom" : role, passwordHash: hashed.hash, passwordIters: hashed.iterations });
  if (Array.isArray(role)) {
    const custom = `role_settings_${++roleSeq}`;
    await t.db.insert(roles).values({ id: custom, key: `settings_${roleSeq}`, name: { ar: "دور اختبار", en: "Test role" }, isSystem: false, createdAt: NOW });
    if (role.length) await t.db.insert(rolePermissions).values(role.map((permission) => ({ roleId: custom, permission })));
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: custom });
    return { id, email, password, actor: { kind: "employee", id, permissions: new Set<string>(role), label: "custom" } };
  }
  await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(role) });
  return { id, email, password, actor: { kind: "employee", id, permissions: role === "owner" ? new Set<string>(["*"]) : defaultRolePermissions(role), label: role } };
}

async function thrown(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}
const failure = async (run: () => Promise<unknown>) => toAppError(await thrown(run));
const code = async (run: () => Promise<unknown>) => (await failure(run))?.code ?? "unexpected";
const key = () => `k_${randomToken(10)}`;

describe("setSetting with the value the person saw", () => {
  test("refused when the value in force differs; the default counts while nothing is stored", async () => {
    const owner = people.owner.actor;
    expect(await getSetting(t.db, "returns.window_days")).toBe(settingDefault("returns.window_days"));
    const start = settingDefault("returns.window_days");
    expect(await code(() => setSetting(t.db, owner, "returns.window_days", 10, "سياسة جديدة", NOW, { expected: start + 1 }))).toBe("setting_changed");
    expect(await setSetting(t.db, owner, "returns.window_days", 10, "سياسة جديدة", NOW, { expected: start })).toBe(10);
    expect(await code(() => setSetting(t.db, people.manager.actor, "returns.window_days", 12, "قديم", NOW, { expected: start }))).toBe("setting_changed");
    expect(await getSetting(t.db, "returns.window_days")).toBe(10);
    // without `expected` the old behaviour is unchanged
    expect(await setSetting(t.db, owner, "returns.window_days", 11, "بلا توقع", NOW)).toBe(11);
  });

  test("a change landing between the read and the batch is caught inside the batch", async () => {
    const owner = people.owner.actor;
    const seen = await getSetting(t.db, "tradein.estimate_valid_days");
    const mine = await settingChangeStatements(t.db, owner, "tradein.estimate_valid_days", seen + 2, "تغييري", NOW, { expected: seen });
    await setSetting(t.db, people.owner2.actor, "tradein.estimate_valid_days", seen + 5, "تغيير شخص آخر", NOW, { expected: seen });
    const error = await thrown(() => runBatch(t.db, mine.statements));
    expect(isSettingChangedError(error)).toBe(true);
    expect(await getSetting(t.db, "tradein.estimate_valid_days")).toBe(seen + 5);
    const events = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "settings.setting.update"), eq(auditEvents.entityId, "tradein.estimate_valid_days")));
    expect(events).toHaveLength(1);
  });

  test("a money-control limit is never written directly by someone who may only request it", async () => {
    expect(await code(() => setSetting(t.db, people.manager.actor, "purchasing.po_approval_limit_iqd", 5_000_000, "أعلى", NOW))).toBe("setting_needs_approval");
    expect(await code(() => setSetting(t.db, people.finance.actor, "returns.window_days", 3, "test", NOW))).toBe("forbidden");
  });

  test("every key has an editor here; the client-safe lists equal the schema's", () => {
    for (const settingKey of SETTING_KEYS) expect(SETTING_EDITORS[settingKey], settingKey).toBeDefined();
    expect([...FIELD_KINDS]).toEqual([...PRODUCT_KIND_SCOPES]);
    expect([...FIELD_TYPES]).toEqual([...CUSTOM_FIELD_TYPES]);
    expect(parseWhole("١٬٠٠٠٬٠٠٠")).toBe(1_000_000);
    expect(parseWhole("1,000,000")).toBe(1_000_000);
    expect(parseWhole("12.5")).toBeNaN();
    expect(parseWhole("")).toBeUndefined();
    expect(parsePercentBps("١٢٫٥")).toBe(1250);
    expect(parsePercentBps("10%")).toBe(1000);
    expect(parsePercentBps("1.234")).toBeNaN();
  });
});

describe("two-person changes of the money-control limits", () => {
  test("a manager requests, the owner approves: the value and the approval land together", async () => {
    const before = await getSetting(t.db, "purchasing.po_approval_limit_iqd");
    expect(before).toBe(PO_SPENDING_LIMIT_IQD);
    const raw = { key: "purchasing.po_approval_limit_iqd", value: 2_000_000, expected: before, reason: "طلبات الموسم أكبر", idempotencyKey: "po-limit-request-1" };
    const asked = await proposeSettingChange(t.db, people.manager.actor, raw, NOW);
    expect(asked).toMatchObject({ status: "requested", replayed: false });
    expect(await proposeSettingChange(t.db, people.manager.actor, raw, NOW)).toEqual({ status: "requested", requestId: asked.requestId, replayed: true });
    expect(await code(() => proposeSettingChange(t.db, people.manager.actor, { ...raw, value: 2_500_000 }, NOW))).toBe("idempotency_mismatch");
    expect(await getSetting(t.db, "purchasing.po_approval_limit_iqd")).toBe(before);
    // one open request per key
    expect(await code(() => proposeSettingChange(t.db, people.manager2.actor, { ...raw, value: 3_000_000, idempotencyKey: "po-limit-request-2" }, NOW))).toBe("change_pending");
    // the manager cannot approve; the owner sees it in the bell count
    expect(await code(() => decideSettingChange(t.db, people.manager2.actor, { approvalId: asked.requestId, decision: "approve" }, NOW))).toBe("forbidden");
    expect(await countDecidableSettingChanges(t.db, people.manager.actor, NOW)).toBeNull();
    expect(await countDecidableSettingChanges(t.db, people.owner.actor, NOW)).toBe(1);
    const item = await getSettingItem(t.db, people.manager.actor, "purchasing.po_approval_limit_iqd", "ar", NOW);
    expect(item.needsApproval).toBe(true);
    expect(item.pending).toMatchObject({ mine: true, canDecide: false, value: 2_000_000, before });

    expect(await decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "approve", note: "موافق" }, NOW)).toEqual({ status: "approved", replayed: false });
    expect(await decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "approve", note: "موافق" }, NOW)).toEqual({ status: "approved", replayed: true });
    expect(await getSetting(t.db, "purchasing.po_approval_limit_iqd")).toBe(2_000_000);
    const row = await t.db.select().from(approvals).where(eq(approvals.id, asked.requestId!)).get();
    expect(row).toMatchObject({ status: "approved", decidedBy: people.owner.id, requestedBy: people.manager.id });
    const stored = await t.db.select().from(settings).where(eq(settings.key, "purchasing.po_approval_limit_iqd")).get();
    expect(stored?.updatedBy).toBe(people.owner.id);
    const log = await listChanges(t.db, people.manager.actor, { key: "purchasing.po_approval_limit_iqd", page: 1 });
    expect(log.rows.map((entry) => entry.action)).toEqual(["settings.change.approve", "settings.setting.update", "settings.change.request"]);
  });

  test("the requester never decides their own request — even after gaining the permission", async () => {
    const requester = await person(["settings.read", "settings.manage"]);
    const asked = await proposeSettingChange(t.db, requester.actor, { key: "finance.expense_second_approval_iqd", value: 750_000, expected: EXPENSE_SECOND_APPROVAL_ABOVE_IQD, reason: "مصروفات التشغيل أكبر", idempotencyKey: key() }, NOW);
    const promoted: EmployeeActor = { ...requester.actor, permissions: new Set(["settings.read", "settings.manage", "settings.change.approve"]) };
    expect(await code(() => decideSettingChange(t.db, promoted, { approvalId: asked.requestId, decision: "approve" }, NOW))).toBe("approver_is_requester");
    // someone else may not withdraw it; a rejection needs a reason; the requester withdraws
    expect(await code(() => decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "withdraw" }, NOW))).toBe("forbidden");
    expect(await code(() => decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "reject" }, NOW))).toBe("invalid");
    expect(await decideSettingChange(t.db, requester.actor, { approvalId: asked.requestId, decision: "withdraw" }, NOW)).toEqual({ status: "withdrawn", replayed: false });
    expect(await code(() => decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "approve" }, NOW))).toBe("change_not_pending");
    expect(await getSetting(t.db, "finance.expense_second_approval_iqd")).toBe(EXPENSE_SECOND_APPROVAL_ABOVE_IQD);
  });

  test("a request made against a value changed since is stale: approval refused, nothing written", async () => {
    const seen = await getSetting(t.db, "finance.topup_second_approval_iqd");
    const asked = await proposeSettingChange(t.db, people.manager.actor, { key: "finance.topup_second_approval_iqd", value: 400_000, expected: seen, reason: "حد أقل", idempotencyKey: key() }, NOW);
    await setSetting(t.db, people.owner.actor, "finance.topup_second_approval_iqd", 600_000, "قرار المالك", NOW, { expected: seen });
    expect(await code(() => decideSettingChange(t.db, people.owner2.actor, { approvalId: asked.requestId, decision: "approve" }, NOW))).toBe("setting_changed");
    expect(await getSetting(t.db, "finance.topup_second_approval_iqd")).toBe(600_000);
    expect((await t.db.select().from(approvals).where(eq(approvals.id, asked.requestId!)).get())?.status).toBe("pending");
    expect(await decideSettingChange(t.db, people.owner2.actor, { approvalId: asked.requestId, decision: "reject", note: "تغير الحد منذ الطلب" }, NOW)).toEqual({ status: "rejected", replayed: false });
  });

  test("a request against a value the form did not show, an unchanged value, a key edited elsewhere, an expired request", async () => {
    const seen = await getSetting(t.db, "pricing.drop_approval_bps");
    expect(await code(() => proposeSettingChange(t.db, people.manager.actor, { key: "pricing.drop_approval_bps", value: 1500, expected: seen + 1, reason: "test", idempotencyKey: key() }, NOW))).toBe("setting_changed");
    expect(await code(() => proposeSettingChange(t.db, people.owner.actor, { key: "pricing.drop_approval_bps", value: seen, expected: seen, reason: "test", idempotencyKey: key() }, NOW))).toBe("invalid");
    // the form showed another value and asks for the one already in force (sent twice, or someone was faster): nothing to do
    expect(await proposeSettingChange(t.db, people.owner.actor, { key: "pricing.drop_approval_bps", value: seen, expected: seen + 500, reason: "test", idempotencyKey: key() }, NOW)).toEqual({ status: "unchanged" });
    expect(await code(() => proposeSettingChange(t.db, people.owner.actor, { key: "shipping.flat_fee_iqd", value: 6000, expected: 5000, reason: "test", idempotencyKey: key() }, NOW))).toBe("not_editable");
    expect(await code(() => proposeSettingChange(t.db, people.cashier.actor, { key: "returns.window_days", value: 3, expected: 11, reason: "test", idempotencyKey: key() }, NOW))).toBe("forbidden");
    const asked = await proposeSettingChange(t.db, people.manager.actor, { key: "pricing.drop_approval_bps", value: 1500, expected: seen, reason: "تخفيضات الموسم", idempotencyKey: key() }, NOW);
    const later = NOW + REQUEST_TTL_MS + 1;
    expect(await countDecidableSettingChanges(t.db, people.owner.actor, later)).toBe(0);
    expect(await code(() => decideSettingChange(t.db, people.owner.actor, { approvalId: asked.requestId, decision: "approve" }, later))).toBe("change_not_pending");
    // an expired request no longer blocks a new one
    expect((await proposeSettingChange(t.db, people.manager2.actor, { key: "pricing.drop_approval_bps", value: 1500, expected: seen, reason: "مرة أخرى", idempotencyKey: key() }, later)).status).toBe("requested");
  });
});

describe("the modules read their limits from settings", () => {
  test("defaults equal the constants they replace", () => {
    expect(settingDefault("pricing.drop_approval_bps")).toBe(DROP_APPROVAL_BPS);
    expect(settingDefault("purchasing.po_approval_limit_iqd")).toBe(PO_SPENDING_LIMIT_IQD);
    expect(settingDefault("finance.topup_second_approval_iqd")).toBe(TOPUP_SECOND_APPROVAL_ABOVE_IQD);
    expect(settingDefault("finance.expense_second_approval_iqd")).toBe(EXPENSE_SECOND_APPROVAL_ABOVE_IQD);
    expect(settingDefault("returns.sla")).toEqual({ decision_hours: SLA.decisionHours, inspection_hours: SLA.inspectionHours, repair_days: SLA.repairDays, quarantine_days: SLA.quarantineDays, warranty_ending_days: SLA.warrantyEndingDays });
  });

  test("a price cut over the limit needs a second person until the limit is raised", async () => {
    const product = await make.product({ priceIqd: 1_000_000 });
    const raw = { variantId: product.variantId, newPriceIqd: 850_000, reason: "تخفيض", idempotencyKey: key() };
    const owner = people.owner.actor;
    expect((await previewPriceChange(t.db, owner, raw, "ar", NOW)).reasons).toContain("drop_over_limit");
    const current = await getSetting(t.db, "pricing.drop_approval_bps");
    await setSetting(t.db, owner, "pricing.drop_approval_bps", 2000, "حد التخفيض 20٪", NOW, { expected: current });
    expect((await previewPriceChange(t.db, owner, raw, "ar", NOW)).reasons).not.toContain("drop_over_limit");
    await setSetting(t.db, owner, "pricing.drop_approval_bps", DROP_APPROVAL_BPS, "إعادة", NOW, { expected: 2000 });
  });

  test("a purchase order over the limit waits for approval; under the raised limit it does not", async () => {
    const product = await make.product({ priceIqd: 900_000 });
    const { supplierId } = await createSupplier(t.db, people.manager.actor, { code: "SUP-SET", name: "Settings supplier", currency: "IQD", leadTimeDays: "5", paymentTerms: "cash" }, NOW);
    const order = async () => {
      const { poId } = await savePurchaseOrder(t.db, people.manager.actor, { supplierId, locationId: DEFAULT_LOCATION_ID, currency: "IQD", lines: [{ code: product.sku, qty: "3", unitCost: "600000" }], idempotencyKey: key() }, NOW);
      const version = (await t.db.select({ updatedAt: purchaseOrders.updatedAt }).from(purchaseOrders).where(eq(purchaseOrders.id, poId)).get())!.updatedAt;
      return submitPurchaseOrder(t.db, people.manager.actor, { poId, version }, NOW);
    };
    // 3 × 600,000 = 1,800,000 IQD: within the 2,000,000 limit approved in the two-person test above, over 1,000,000
    expect(await getSetting(t.db, "purchasing.po_approval_limit_iqd")).toBe(2_000_000);
    expect((await order()).status).toBe("approved");
    await setSetting(t.db, people.owner.actor, "purchasing.po_approval_limit_iqd", 1_000_000, "العودة إلى مليون", NOW, { expected: 2_000_000 });
    expect((await order()).status).toBe("pending_approval");
  });

  test("expenses: one person alone above the limit needs another approver; the limit is the setting", async () => {
    expect(await expenseApprovalLimit(t.db)).toBe(EXPENSE_SECOND_APPROVAL_ABOVE_IQD);
    const expense = { amountIqd: 600_000, createdBy: "emp_a" };
    expect(needsOtherApprover(expense, "emp_a", 0)).toBe(true);
    expect(needsOtherApprover(expense, "emp_a", 0, 1_000_000)).toBe(false);
    expect(needsOtherApprover(expense, "emp_b", 0)).toBe(false);
  });

  test("return service targets follow the setting", async () => {
    expect(await slaTargets(t.db)).toEqual({ ...SLA });
    const seen = await getSetting(t.db, "returns.sla");
    await setSetting(t.db, people.manager.actor, "returns.sla", { ...seen, repair_days: 10 }, "قطع الغيار تتأخر", NOW, { expected: seen });
    expect((await slaTargets(t.db)).repairDays).toBe(10);
    expect(await code(() => setSetting(t.db, people.manager.actor, "returns.sla", { ...seen, repair_days: 0 }, "صفر", NOW))).toBe("invalid");
  });
});

describe("custom fields", () => {
  const base = { productKind: "console", labelAr: "منطقة الجهاز", labelEn: "Region", type: "select", options: [{ value: "eu", labelAr: "أوروبا" }, { value: "us", labelAr: "أمريكا" }], required: false, filterable: true, sort: 0, reason: "حقل جديد للأجهزة" };

  test("one key across kinds; key and type locked once used; an option in use stays; a stale form refused", async () => {
    expect(await code(() => saveCustomField(t.db, people.cashier.actor, { ...base, key: "region_code" }, NOW))).toBe("forbidden");
    expect(await code(() => saveCustomField(t.db, people.owner.actor, { ...base, key: "region_code", options: [] }, NOW))).toBe("invalid");
    const created = await saveCustomField(t.db, people.manager.actor, { ...base, key: "region_code" }, NOW);
    expect(created.created).toBe(true);
    expect(await code(() => saveCustomField(t.db, people.manager.actor, { ...base, key: "region_code", productKind: "controller" }, NOW))).toBe("key_taken");

    const product = await make.product({ kind: "console" });
    await t.db.update(products).set({ attributes: { region_code: "eu" } }).where(eq(products.id, product.productId));
    const field = await getCustomField(t.db, people.manager.actor, created.fieldId, "ar");
    expect(field.usage.withValue).toBe(1);
    const edit = { ...base, key: "region_code", fieldId: created.fieldId, version: field.version };
    expect(await code(() => saveCustomField(t.db, people.manager.actor, { ...edit, key: "region" }, NOW))).toBe("key_locked");
    expect(await code(() => saveCustomField(t.db, people.manager.actor, { ...edit, type: "text", options: [] }, NOW))).toBe("type_locked");
    expect(await code(() => saveCustomField(t.db, people.manager.actor, { ...edit, options: [{ value: "us", labelAr: "أمريكا" }] }, NOW))).toBe("option_in_use");
    expect(await code(() => saveCustomField(t.db, people.manager.actor, { ...edit, version: "stale" }, NOW))).toBe("field_changed");
    const saved = await saveCustomField(t.db, people.manager.actor, { ...edit, options: [...base.options, { value: "jp", labelAr: "اليابان" }], required: true }, NOW);
    expect(saved).toMatchObject({ created: false, usage: { withValue: 1 } });
    expect(await setCustomFieldActive(t.db, people.manager.actor, { fieldId: created.fieldId, active: false, reason: "لم يعد مستخدماً" }, NOW)).toEqual({ changed: true });
    expect(await setCustomFieldActive(t.db, people.manager.actor, { fieldId: created.fieldId, active: false, reason: "لم يعد مستخدماً" }, NOW)).toEqual({ changed: false });
    const row = await t.db.select().from(customFields).where(eq(customFields.id, created.fieldId)).get();
    expect(row).toMatchObject({ isActive: false, required: true });
    const actions = (await t.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, created.fieldId))).map((entry) => entry.action).sort();
    expect(actions).toEqual(["settings.custom_field.create", "settings.custom_field.deactivate", "settings.custom_field.update"]);
  });
});

describe("message templates", () => {
  test("only the message's variables, the required ones present, a stale form refused", async () => {
    expect(await code(() => saveTemplate(t.db, people.cashier.actor, { key: "order_confirmed", locale: "ar", body: "طلبك {ref}", isActive: true, version: null }, NOW))).toBe("forbidden");
    expect(await code(() => saveTemplate(t.db, people.manager.actor, { key: "order_confirmed", locale: "ar", body: "طلبك {ref} بسعر {total}", isActive: true, version: null }, NOW))).toBe("template_variable_unknown");
    expect(await code(() => saveTemplate(t.db, people.manager.actor, { key: "order_confirmed", locale: "ar", body: "تم تأكيد طلبك", isActive: true, version: null }, NOW))).toBe("template_variable_missing");
    expect(await code(() => saveTemplate(t.db, people.manager.actor, { key: "no_such", locale: "ar", body: "x {ref}", isActive: true, version: null }, NOW))).toBe("not_found");
    expect(await saveTemplate(t.db, people.manager.actor, { key: "order_confirmed", locale: "ar", body: "طمطم: تم تأكيد طلبك {ref}", isActive: true, version: null, reason: "نص أوضح" }, NOW)).toEqual({ created: true });
    expect(await code(() => saveTemplate(t.db, people.manager.actor, { key: "order_confirmed", locale: "ar", body: "طمطم: طلبك {ref}", isActive: true, version: null }, NOW))).toBe("template_changed");
    const current = await getTemplate(t.db, people.manager.actor, "order_confirmed", NOW);
    expect(await code(() => saveTemplate(t.db, people.manager.actor, { key: "order_confirmed", locale: "ar", body: "طمطم: تم تأكيد طلبك {ref}", isActive: true, version: current.versions.ar }, NOW))).toBe("invalid");
    expect(await saveTemplate(t.db, people.manager.actor, { key: "order_confirmed", locale: "ar", body: "طمطم: طلبك {ref} مؤكد", isActive: false, version: current.versions.ar }, NOW + 1)).toEqual({ created: false });
    for (const entry of TEMPLATE_CATALOG) for (const name of entry.required) expect(entry.variables as readonly string[], entry.key).toContain(name);
  });
});

describe("policies", () => {
  test("the real drafts survive the line editor (every language); only invisible direction isolates are dropped", async () => {
    // SECURITY §5: staff free text loses bidi overrides and isolates (U+202A–E, U+2066–9); LRM/RLM stay
    const withoutIsolates = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/[\u2066-\u2069]/g, ""));
    for (const slug of EDITABLE_POLICIES) {
      const draft = await getPolicyDraftL10n(t.db, slug, { storeMode: "demo" });
      for (const locale of ["ar", "en", "ckb"] as const) {
        const blocks = (draft.body[locale] as { type: string }[]).filter((block) => block.type !== "art");
        expect(blocks.length, `${slug}/${locale}`).toBeGreaterThan(3);
        expect(textToBlocks(blocksToText(blocks)), `${slug}/${locale}`).toEqual(withoutIsolates(blocks));
      }
    }
    expect(textToBlocks("## عنوان\u202e\n- أ\n- ب\n[warning] انتبه | نص\n| أ | ب |\n| 1 | 2 |")).toEqual([
      { type: "h2", text: "عنوان" },
      { type: "ul", items: ["أ", "ب"] },
      { type: "callout", tone: "warning", title: "انتبه", text: "نص" },
      { type: "table", head: ["أ", "ب"], rows: [["1", "2"]] },
    ]);
  });

  test("draft from the code's text, edit, approve (the storefront serves it), withdraw (the draft comes back)", async () => {
    expect(await code(() => startPolicyDraft(t.db, people.finance.actor, { slug: "returns", reason: "test", version: null }, NOW, "demo"))).toBe("forbidden");
    expect(await code(() => startPolicyDraft(t.db, people.owner.actor, { slug: "privacy", reason: "test", version: null }, NOW, "demo"))).toBe("policy_not_editable");
    expect(await startPolicyDraft(t.db, people.manager.actor, { slug: "returns", reason: "بداية المراجعة", version: null }, NOW, "demo")).toEqual({ created: true });
    expect(await code(() => startPolicyDraft(t.db, people.manager.actor, { slug: "returns", reason: "مرة ثانية", version: null }, NOW, "demo"))).toBe("policy_changed");
    const editor = await getPolicyEditor(t.db, people.manager.actor, "returns", "ar", NOW, "demo");
    expect(editor.source).toBe("draft");
    expect(editor.text.ar.length).toBeGreaterThan(20);
    expect(editor.live.approved).toBe(false);
    expect(await code(() => savePolicyDraft(t.db, people.manager.actor, { slug: "returns", version: editor.version, textAr: "  " }, NOW + 1))).toBe("invalid");
    expect(await savePolicyDraft(t.db, people.manager.actor, { slug: "returns", version: editor.version, textAr: "## الإرجاع\nيمكن إرجاع المنتج خلال 7 أيام.", textEn: "## Returns\nWithin 7 days." }, NOW + 1)).toEqual({ blocks: 2 });
    expect(await code(() => publishPolicy(t.db, people.manager.actor, { slug: "returns", version: editor.version, reason: "معتمد" }, NOW + 2))).toBe("policy_changed");
    expect(await publishPolicy(t.db, people.owner.actor, { slug: "returns", version: NOW + 1, reason: "اعتمدها المالك" }, NOW + 2)).toEqual({ published: true });
    const live = await getPolicy(t.db, "ar", "returns", { now: NOW + 3 });
    expect(live).toMatchObject({ source: "cms", approved: true, blocks: [{ type: "h2", text: "الإرجاع" }, { type: "p", text: "يمكن إرجاع المنتج خلال 7 أيام." }] });
    expect((await listPolicies(t.db, "ar", { now: NOW + 3 })).find((entry) => entry.slug === "returns")?.approved).toBe(true);
    expect(await archivePolicy(t.db, people.owner.actor, { slug: "returns", version: NOW + 2, reason: "نعود إلى المسودة" }, NOW + 3)).toEqual({ archived: true });
    expect((await getPolicy(t.db, "ar", "returns", { now: NOW + 4 }))?.source).toBe("draft");
    const steps = (await t.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.entityId, "returns"))).map((entry) => entry.action);
    expect(steps).toEqual(expect.arrayContaining(["settings.policy.start", "settings.policy.save", "settings.policy.publish", "settings.policy.archive"]));
  });
});

// ───────────────────────────────────────────────────────────────── routes

function requestCtx(): RequestCtx {
  return {
    requestId: `set-${randomToken(6)}`,
    nonce: "n",
    origin: ORIGIN,
    isHttps: false,
    isDev: true,
    now: Date.now(),
    ip: null,
    country: "IQ",
    userAgent: "vitest",
    locale: "ar",
    dir: "rtl",
    prefs: { theme: "system", currency: "IQD", numbering: "latn" },
    storeMode: "demo",
    cookie: () => null,
    setCookie: () => {},
  };
}

async function signedIn(who: Person): Promise<string> {
  const setCookies: string[] = [];
  const ctx = { ...requestCtx(), setCookie: (serialized: string) => void setCookies.push(serialized) } as RequestCtx;
  const result = await signInEmployee(ctx, t.db, { email: who.email, password: who.password });
  if (result.status !== "signed_in") throw new Error("sign-in failed");
  const jar = new Map<string, string>();
  for (const serialized of setCookies) {
    const [pair] = serialized.split("; ");
    const at = pair.indexOf("=");
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function run(cookie: string, path: string, params: Record<string, string>, fn: (args: never) => unknown, body?: FormData): Promise<unknown> {
  const request = new Request(`${ORIGIN}${path}`, body ? { method: "POST", headers: { cookie, origin: ORIGIN }, body } : { headers: { cookie } });
  const context = new RouterContextProvider();
  try {
    let out: unknown;
    await requestContextMiddleware({ request, context, url: new URL(request.url), pattern: "/", params: {} }, async () => {
      out = await fn({ request, context, params, url: new URL(request.url), pattern: path } as never);
      return new Response(null);
    });
    return out;
  } catch (error) {
    return error;
  }
}
const statusOf = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);
const dataOf = (value: unknown) => ((value as { data?: unknown } | null)?.data ?? value) as Record<string, unknown>;
const formOf = (entries: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(entries)) form.append(name, value);
  return form;
};

describe("routes", () => {
  test("the settings pages answer 403 to a role without settings.read", async () => {
    const outsider = await person(["dashboard.overview.read", "orders.order.read"]);
    expect(statusOf(await run(await signedIn(outsider), "/admin/settings", {}, settingsLoader as never))).toBe(403);
    const finance = await run(await signedIn(people.finance), "/admin/settings", {}, settingsLoader as never);
    expect(statusOf(finance)).toBe(200);
  });

  test("the key page: a manager's change becomes a request, another person approves it", async () => {
    const path = "/admin/settings/keys/finance.topup_second_approval_iqd";
    const params = { key: "finance.topup_second_approval_iqd" };
    const seen = await getSetting(t.db, "finance.topup_second_approval_iqd");
    const managerCookie = await signedIn(people.manager2);
    const bad = await run(managerCookie, path, params, keyAction as never, formOf({ intent: "change", value: "450000", expected: String(seen), reason: "", formKey: key() }));
    expect(statusOf(bad)).toBe(400);
    expect(dataOf(bad)).toMatchObject({ ok: false, fields: { reason: expect.any(String) } });
    const asked = dataOf(await run(managerCookie, path, params, keyAction as never, formOf({ intent: "change", value: "450000", expected: String(seen), reason: "حد مناسب", formKey: key() })));
    expect(asked).toMatchObject({ ok: true, intent: "change", status: "requested" });
    const ownerCookie = await signedIn(people.owner2);
    const decided = dataOf(await run(ownerCookie, path, params, keyAction as never, formOf({ intent: "decide", approvalId: String(asked.requestId), decision: "approve", reason: "" })));
    expect(decided).toMatchObject({ ok: true, status: "approved" });
    expect(await getSetting(t.db, "finance.topup_second_approval_iqd")).toBe(450_000);
  });
});
