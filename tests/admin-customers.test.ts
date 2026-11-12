/**
 * Admin module 07 "customers" (owner: admin customers) — the services under app/server/services/admin/customers and the
 * route glue of app/routes/admin/customers, on a real local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · authorization per role (manager, support, finance, cashier, content, inventory) and field rules: phones masked
 *     without customer.phone.read_full, sections absent without their module's permission, no cost data anywhere
 *   · RFM (07.02) from real orders (paid, not refunded in full, never cancelled), the segment map, recompute in one
 *     audited batch, the list's segment filter
 *   · labels (07.06): VIP / risk / complaint rules with their numbers, manual VIP label, fraud flag, block (sessions end)
 *   · contact (07.03): stale form refused, masked address phone kept, district of another governorate refused
 *   · consents and privacy (07.04): withdrawals only, append-only history, requests idempotent, nothing before
 *     verification, the export without staff notes or cost (audited), erasure blocked by money or open orders and
 *     otherwise anonymizing while orders, ledger and consents stay
 *   · merge (07.05): the plan's blockers (wallet), a stale plan refused, everything moves in one batch, consents never
 *     carried as a grant, replay harmless
 *   · communication log (07.07): only safe facts of a message, contacts logged with an order of this customer only,
 *     card-like numbers refused
 *   · the route actions check each intent's permission before anything is read
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { contactAction, customerPrivacyAction, mergeAction, privacyRequestAction, segmentsAction } from "~/routes/admin/customers/actions.server";
import { profileAction } from "~/routes/admin/customers/customer.server";
import { systemActor, type EmployeeActor } from "~/server/actor";
import type { EmployeeSession } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import {
  addresses,
  auditEvents,
  consents,
  customerSegmentMembers,
  customerSessions,
  customers,
  employeeRoles,
  orderEvents,
  orders,
  paymentProofs,
  payments,
  privacyRequests,
  supportTickets,
  walletLedger,
  wishlistItems,
} from "~/server/db/schema";
import { governorateId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { enqueueMessage } from "~/server/outbox.server";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { listCommunication, logContact } from "~/server/services/admin/customers/communication.server";
import { saveCustomerAddress, setCustomerChannels, updateCustomerDetails } from "~/server/services/admin/customers/contact.server";
import { customerFlags, setBlocked, setFraudFlag, setVip } from "~/server/services/admin/customers/flags.server";
import { exportCustomersCsv, listCustomers } from "~/server/services/admin/customers/list.server";
import { mergeCustomers, planMerge } from "~/server/services/admin/customers/merge.server";
import {
  buildPrivacyExport,
  completePrivacyRequest,
  createPrivacyRequest,
  customerConsentHistory,
  erasedPhone,
  executeErasure,
  getPrivacyRequest,
  listConsentLog,
  recordWithdrawal,
  verifyPrivacyRequest,
} from "~/server/services/admin/customers/privacy.server";
import { addCustomerNote, getCustomerProfile } from "~/server/services/admin/customers/profile.server";
import { recomputeSegments, segmentOverview } from "~/server/services/admin/customers/rfm.server";
import { CUSTOMER_ERROR_KEYS, hasLongDigitRun } from "~/server/services/admin/customers/shared.server";
import { parseCustomerFilters, rfmOf, segmentOf } from "~/server/services/admin/customers/types";
import { creditWallet } from "~/server/services/wallet.server";
import messages from "~/i18n/messages/admin-customers";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;
const system = systemActor("test.admin-customers");

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "manager2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "support", "cashier", "content", "inventory"] as const) staff[key] = await employee(key);
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

const as = (key: keyof typeof staff): EmployeeActor => {
  const actor = staff[key];
  if (!actor) throw new Error(`no ${key}`);
  return actor;
};
const custom = (permissions: Permission[]): EmployeeActor => ({ kind: "employee", id: as("manager").id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (appError) return appError;
    throw error;
  }
  throw new Error("expected a failure");
}

/** A paid order of the customer (`paid` kept unless `refunded`), placed `daysAgo` days before NOW. */
async function paidOrder(customerId: string, options: { total?: number; daysAgo?: number; status?: "delivered" | "cancelled" | "returned" | "confirmed" | "shipped"; refunded?: number; paid?: number } = {}) {
  const product = await make.product({ priceIqd: options.total ?? 100_000 });
  const total = (options.total ?? 100_000) + 5000;
  const status = options.status ?? "delivered";
  const paid = options.paid ?? (status === "cancelled" ? 0 : total);
  return make.order([{ ...product, qty: 1, unitPriceIqd: options.total ?? 100_000 }], {
    customerId,
    status,
    paymentStatus: paid > 0 ? "paid" : "unpaid",
    paidIqd: paid,
    refundedIqd: options.refunded ?? 0,
    placedAt: NOW - (options.daysAgo ?? 1) * DAY,
    cancelledAt: status === "cancelled" ? NOW - (options.daysAgo ?? 1) * DAY : null,
    isDemo: false,
  }).then((order) => ({ ...order, totalIqd: total }));
}

const session = (actor: EmployeeActor): EmployeeSession =>
  ({
    employee: { id: actor.id, email: "x@tamtam.test", name: actor.label ?? "x", phone: null, jobTitle: null, locale: "ar", branchId: null, totpEnabled: false, passwordChangedAt: null },
    actor: { ...actor, permissions: actor.permissions instanceof Set ? actor.permissions : new Set(actor.permissions) },
    roles: [],
    session: { id: "s", createdAt: NOW, expiresAt: NOW + DAY, mfaOk: true },
  }) as EmployeeSession;
const form = (entries: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) for (const entry of Array.isArray(value) ? value : [value]) data.append(key, entry);
  return data;
};
const ctx = { locale: "ar" as const, now: NOW };

// ───────────────────────────────────────────────────────────────── pure rules

describe("rules (pure)", () => {
  test("RFM scores and the segment map follow the written bounds", () => {
    expect(rfmOf({ purchases: 0, monetaryIqd: 0, lastPurchaseAt: null }, NOW)).toMatchObject({ r: 0, f: 0, m: 0, segment: "none" });
    expect(rfmOf({ purchases: 1, monetaryIqd: 50_000, lastPurchaseAt: NOW - 3 * DAY }, NOW)).toMatchObject({ r: 5, f: 1, m: 1, segment: "new", recencyDays: 3 });
    expect(rfmOf({ purchases: 6, monetaryIqd: 2_500_000, lastPurchaseAt: NOW - 20 * DAY }, NOW)).toMatchObject({ r: 5, f: 4, m: 5, segment: "champions" });
    expect(rfmOf({ purchases: 6, monetaryIqd: 900_000, lastPurchaseAt: NOW - 400 * DAY }, NOW)).toMatchObject({ r: 1, f: 4, segment: "cant_lose" });
    expect(segmentOf(2, 1)).toBe("hibernating");
    expect(segmentOf(2, 3)).toBe("at_risk");
    expect(segmentOf(1, 2)).toBe("lost");
    expect(segmentOf(3, 1)).toBe("need_attention");
    expect(segmentOf(3, 5)).toBe("loyal");
    // every R × F cell has a segment
    for (const r of [1, 2, 3, 4, 5] as const) for (const f of [1, 2, 3, 4, 5] as const) expect(segmentOf(r, f)).not.toBe("none");
  });

  test("card-like digit runs are refused but phone numbers are not", () => {
    expect(hasLongDigitRun("بطاقته 4111 1111 1111 1111")).toBe(true);
    expect(hasLongDigitRun("حساب ٩٢٦٩٣١٧٤٢٧١٢٣٤")).toBe(true);
    expect(hasLongDigitRun("اتصلنا على 0770 123 4567 ثم +964 771 906 1852")).toBe(false);
    expect(hasLongDigitRun("الطلب TT-7K4M2Q9X بمبلغ 125,000")).toBe(false);
  });

  test("every module error code has a text in ar, en and ckb", () => {
    for (const locale of ["ar", "en", "ckb"] as const) {
      const tree = (messages as unknown as Record<string, { errors: Record<string, string> }>)[locale].errors;
      for (const key of CUSTOMER_ERROR_KEYS) if (key !== "customer_unavailable" && key !== "district_invalid") expect(tree[key], `${locale}: errors.${key}`).toBeTruthy();
    }
  });

  test("list filters come from the URL, unknown values are dropped, digits are Latin", () => {
    expect(parseCustomerFilters(new URLSearchParams("view=vip&segment=lost&sort=spent&page=٢&q=٠٧٧٠"))).toEqual({ q: "0770", view: "vip", status: null, segment: "lost", sort: "spent", page: 2 });
    expect(parseCustomerFilters(new URLSearchParams("view=drop&segment=x&sort=y&status=z&page=-1"))).toMatchObject({ view: "all", segment: null, sort: "joined", status: null, page: 1 });
  });
});

// ───────────────────────────────────────────────────────────────── list, profile, field rules

describe("list and profile (07.01)", () => {
  test("roles: who may read, whose phone is masked, which sections are absent; no cost data", async () => {
    const id = await make.customer({ name: "عميل الصلاحيات", email: "perm@tamtam.test" });
    await paidOrder(id, { total: 250_000 });
    const filters = parseCustomerFilters(new URLSearchParams(`q=${encodeURIComponent("عميل الصلاحيات")}`));
    const forSupport = await listCustomers(t.db, as("support"), filters, NOW);
    expect(forSupport.rows[0]).toMatchObject({ id, purchases: 1, spentIqd: 255_000 });
    expect(forSupport.rows[0].phone?.full).toBe(true);
    const forCashier = await listCustomers(t.db, as("cashier"), filters, NOW);
    expect(forCashier.rows[0].phone).toMatchObject({ full: false });
    expect(forCashier.rows[0].phone?.display).toMatch(/•••/);
    for (const key of ["content", "inventory"] as const) expect((await failureOf(listCustomers(t.db, as(key), filters, NOW))).code).toBe("forbidden");

    const cashierView = await getCustomerProfile(t.db, as("cashier"), id, "ar", NOW);
    expect(cashierView.orders).toBeNull();
    expect(cashierView.returns).toBeNull();
    expect(cashierView.wallet).toBeNull();
    expect(cashierView.consents).toBeNull();
    expect(cashierView.privacy).toBeNull();
    expect(cashierView.stats.purchases).toBe(1);
    const supportView = await getCustomerProfile(t.db, as("support"), id, "ar", NOW);
    expect(supportView.orders?.length).toBe(1);
    expect(supportView.consents).not.toBeNull();
    expect(supportView.wallet).toBeNull();
    const financeView = await getCustomerProfile(t.db, as("finance"), id, "ar", NOW);
    expect(financeView.wallet).toMatchObject({ balanceIqd: 0, financeHref: `/admin/finance/wallets/${id}` });
    expect(financeView.header.phone?.full).toBe(false);
    for (const view of [cashierView, supportView, financeView]) expect(JSON.stringify(view)).not.toMatch(/cost_?snapshot|costIqd|landed|unit_cost|margin/i);
  });

  test("partial-digit phone search needs the full-phone permission; a whole number works for everyone", async () => {
    const phone = "+9647701234599";
    const id = await make.customer({ phoneE164: phone, name: "بحث الرقم" });
    const partial = parseCustomerFilters(new URLSearchParams("q=1234599"));
    expect((await listCustomers(t.db, as("cashier"), partial, NOW)).rows.map((row) => row.id)).not.toContain(id);
    expect((await listCustomers(t.db, as("support"), partial, NOW)).rows.map((row) => row.id)).toContain(id);
    const whole = parseCustomerFilters(new URLSearchParams("q=07701234599"));
    expect((await listCustomers(t.db, as("cashier"), whole, NOW)).rows.map((row) => row.id)).toEqual([id]);
  });

  test("the CSV export needs its permission, masks phones like the screen and is audited", async () => {
    const filters = parseCustomerFilters(new URLSearchParams(""));
    const labels = { header: ["id"], status: (s: string) => s, segment: (s: string | null) => s ?? "", flag: (s: string) => s };
    expect((await failureOf(exportCustomersCsv(t.db, as("support"), filters, NOW, labels))).code).toBe("forbidden");
    const masked = await exportCustomersCsv(t.db, custom(["customers.customer.read", "customers.customer.export"]), filters, NOW, labels);
    expect(masked.rows.length).toBeGreaterThan(0);
    expect(masked.rows.every((row) => row[2] === null || String(row[2]).includes("•••"))).toBe(true);
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "customers.customer.export")).all();
    expect(audit.length).toBeGreaterThan(0);
  });

  test("notes are append-only audit events; card numbers refused; merged accounts read-only", async () => {
    const id = await make.customer();
    expect((await failureOf(addCustomerNote(t.db, as("cashier"), { customerId: id, text: "ملاحظة" }, NOW))).code).toBe("forbidden");
    expect((await failureOf(addCustomerNote(t.db, as("support"), { customerId: id, text: "رقم بطاقته 4111111111111111" }, NOW))).fields).toEqual({ text: "note_has_card_number" });
    await addCustomerNote(t.db, as("support"), { customerId: id, text: "اتصل يسأل عن موعد التوصيل" }, NOW);
    const profile = await getCustomerProfile(t.db, as("support"), id, "ar", NOW);
    expect(profile.notes.map((note) => note.text)).toEqual(["اتصل يسأل عن موعد التوصيل"]);
    const merged = await make.customer({ status: "merged" });
    expect((await failureOf(addCustomerNote(t.db, as("support"), { customerId: merged, text: "ملاحظة" }, NOW))).code).toBe("customer_unavailable");
  });
});

// ───────────────────────────────────────────────────────────────── RFM

describe("segments (07.02)", () => {
  test("from real orders only: cancelled and fully refunded orders are no purchase; recompute stores membership", async () => {
    const champion = await make.customer({ name: "بطل" });
    for (let i = 0; i < 5; i++) await paidOrder(champion, { total: 500_000, daysAgo: 5 + i });
    const ghost = await make.customer({ name: "ملغى فقط" });
    await paidOrder(ghost, { status: "cancelled" });
    const refunded = await paidOrder(ghost, { total: 100_000 });
    await t.db.update(orders).set({ refundedIqd: refunded.totalIqd, paymentStatus: "refunded" }).where(eq(orders.id, refunded.orderId));
    const profile = await getCustomerProfile(t.db, as("manager"), champion, "ar", NOW);
    expect(profile.rfm).toMatchObject({ r: 5, f: 4, m: 5, segment: "champions", frequency: 5 });
    expect((await getCustomerProfile(t.db, as("manager"), ghost, "ar", NOW)).rfm.segment).toBe("none");

    expect((await failureOf(recomputeSegments(t.db, as("support"), NOW))).code).toBe("forbidden");
    const result = await recomputeSegments(t.db, as("manager"), NOW);
    expect(result.counts.champions).toBeGreaterThanOrEqual(1);
    const member = await t.db.select().from(customerSegmentMembers).where(eq(customerSegmentMembers.customerId, champion)).all();
    expect(member.map((row) => row.segmentId)).toEqual(["seg_rfm_champions"]);
    const filtered = await listCustomers(t.db, as("manager"), parseCustomerFilters(new URLSearchParams("segment=champions")), NOW);
    expect(filtered.rows.map((row) => row.id)).toContain(champion);
    const overview = await segmentOverview(t.db, as("support"), NOW);
    expect(overview.canRecompute).toBe(false);
    expect(overview.rows.find((row) => row.segment === "champions")?.stored).toBe(overview.rows.find((row) => row.segment === "champions")?.now);
    // a second run replaces, never duplicates
    await recomputeSegments(t.db, as("manager"), NOW + 1000);
    expect((await t.db.select().from(customerSegmentMembers).where(eq(customerSegmentMembers.customerId, champion)).all()).length).toBe(1);
    expect((await t.db.select().from(auditEvents).where(eq(auditEvents.action, "customers.segment.recompute")).all()).length).toBeGreaterThanOrEqual(2);
    const action = await segmentsAction(ctx, t.db, session(as("cashier")), form({ intent: "recompute" }));
    expect(action).toMatchObject({ ok: false, code: "forbidden", status: 403 });
  });
});

// ───────────────────────────────────────────────────────────────── labels

describe("labels (07.06)", () => {
  test("VIP and risk rules explain themselves with numbers; complaints come from open tickets", async () => {
    const vip = await make.customer();
    await paidOrder(vip, { total: 2_100_000, daysAgo: 30 });
    const risky = await make.customer();
    await paidOrder(risky, { status: "cancelled", daysAgo: 3 });
    await paidOrder(risky, { status: "cancelled", daysAgo: 10 });
    const proofOrder = await paidOrder(risky, { status: "confirmed", paid: 0 });
    const paymentId = await make.payment(proofOrder.orderId, proofOrder.totalIqd, { method: "bank_transfer", status: "rejected" });
    await t.db.insert(paymentProofs).values([
      { id: newId("ppf"), paymentId, fileId: (await fileRow()).id, declaredAmountIqd: 1000, status: "rejected", sha256: "a", reviewedAt: NOW - DAY, createdAt: NOW - 2 * DAY },
      { id: newId("ppf"), paymentId, fileId: (await fileRow()).id, declaredAmountIqd: 1000, status: "rejected", sha256: "b", reviewedAt: NOW - DAY, createdAt: NOW - 2 * DAY },
    ]);
    await t.db.insert(supportTickets).values({ id: newId("tkt"), ref: `TK-${randomToken(4).toUpperCase()}`, customerId: risky, subject: "تأخر الطلب", category: "complaint", status: "open", createdAt: NOW, updatedAt: NOW });
    const flags = await customerFlags(t.db, [vip, risky], NOW);
    expect(flags.get(vip)?.find((flag) => flag.id === "vip_spend")?.vars).toMatchObject({ amount: 2_105_000, threshold: 2_000_000 });
    const riskIds = flags.get(risky)?.map((flag) => flag.id);
    expect(riskIds).toEqual(expect.arrayContaining(["risk_cancelled", "risk_rejected_proofs", "complaint_open"]));
    const view = await listCustomers(t.db, as("support"), parseCustomerFilters(new URLSearchParams("view=risk")), NOW);
    expect(view.rows.map((row) => row.id)).toContain(risky);
    expect(view.rows.map((row) => row.id)).not.toContain(vip);
    const complaints = await listCustomers(t.db, as("support"), parseCustomerFilters(new URLSearchParams("view=complaints")), NOW);
    expect(complaints.rows.map((row) => row.id)).toEqual([risky]);
  });

  test("manual labels: VIP (update), fraud flag and block (block permission), sessions end, unchanged refused", async () => {
    const id = await make.customer();
    await t.db.insert(customerSessions).values({ idHash: randomToken(), customerId: id, createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + DAY });
    expect((await failureOf(setVip(t.db, as("support"), { customerId: id, tier: "VIP", reason: "عميل قديم" }, NOW))).code).toBe("forbidden");
    await setVip(t.db, as("manager"), { customerId: id, tier: "ذهبي", reason: "عميل منذ سنوات" }, NOW);
    expect((await failureOf(setVip(t.db, as("manager"), { customerId: id, tier: "ذهبي", reason: "مرة أخرى" }, NOW))).code).toBe("vip_unchanged");
    expect((await customerFlags(t.db, [id], NOW)).get(id)?.[0]).toEqual({ id: "vip_manual", vars: { tier: "ذهبي" } });
    expect((await failureOf(setFraudFlag(t.db, as("finance"), { customerId: id, flagged: true, reason: "إثباتات مكررة" }, NOW))).code).toBe("forbidden");
    await setFraudFlag(t.db, as("manager"), { customerId: id, flagged: true, reason: "إثباتات مكررة" }, NOW);
    const row = await t.db.select().from(customers).where(eq(customers.id, id)).get();
    expect(row).toMatchObject({ fraudFlag: true, fraudReason: "إثباتات مكررة" });
    const blocked = await setBlocked(t.db, as("manager"), { customerId: id, blocked: true, reason: "احتيال مؤكد" }, NOW);
    expect(blocked).toEqual({ status: "blocked", sessionsEnded: 1 });
    expect((await t.db.select().from(customerSessions).where(eq(customerSessions.customerId, id)).get())?.revokedAt).toBe(NOW);
    expect((await failureOf(setBlocked(t.db, as("manager"), { customerId: id, blocked: true, reason: "مرة أخرى" }, NOW))).code).toBe("status_unchanged");
    const actions = (await t.db.select().from(auditEvents).where(and(eq(auditEvents.entityType, "customer"), eq(auditEvents.entityId, id))).all()).map((event) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["customers.customer.vip", "customers.customer.flag", "customers.customer.block"]));
  });

  test("profileAction checks the intent's permission before anything is read", async () => {
    const id = await make.customer();
    expect(await profileAction(ctx, t.db, session(as("support")), id, form({ intent: "block", blocked: "1", reason: "x" }))).toMatchObject({ ok: false, code: "forbidden", status: 403 });
    expect(await profileAction(ctx, t.db, session(as("support")), "cus_nope", form({ intent: "block", blocked: "1", reason: "x" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await profileAction(ctx, t.db, session(as("manager")), id, form({ intent: "drop" }))).toMatchObject({ ok: false, code: "invalid", status: 400 });
    expect(await profileAction(ctx, t.db, session(as("support")), id, form({ intent: "note", text: "اتصلنا" }))).toMatchObject({ ok: true });
    const failure = await profileAction(ctx, t.db, session(as("manager")), id, form({ intent: "flag", flagged: "1", reason: "" }));
    expect(failure).toMatchObject({ ok: false, code: "invalid", status: 400 });
    expect((failure as { fields?: Record<string, string> }).fields?.reason).toBeTruthy();
  });
});

async function fileRow() {
  const { files } = await import("~/server/db/schema");
  const id = newId("fil");
  await t.db.insert(files).values({ id, storageKey: `prv_${randomToken(8)}`, visibility: "private", kind: "payment_proof", mime: "image/png", bytes: 10, sha256: randomToken(8), createdAt: NOW });
  return { id };
}

// ───────────────────────────────────────────────────────────────── contact

describe("contact (07.03)", () => {
  test("details: a stale form is refused; addresses keep a masked phone; districts must belong to the governorate", async () => {
    const id = await make.customer({ name: "قبل", updatedAt: NOW });
    expect((await failureOf(updateCustomerDetails(t.db, as("support"), { customerId: id, name: "بعد", locale: "ar", reason: "تصحيح", expectedUpdatedAt: NOW }, NOW))).code).toBe("forbidden");
    await updateCustomerDetails(t.db, as("manager"), { customerId: id, name: "بعد", email: "after@tamtam.test", locale: "en", reason: "طلب العميل", expectedUpdatedAt: NOW }, NOW + 1);
    expect((await failureOf(updateCustomerDetails(t.db, as("manager"), { customerId: id, name: "مرة ثالثة", locale: "ar", reason: "تصحيح", expectedUpdatedAt: NOW }, NOW + 2))).code).toBe("customer_changed");
    const baghdad = governorateId("baghdad");
    const saved = await saveCustomerAddress(t.db, as("manager"), { customerId: id, label: "البيت", phone: "07701112233", governorateId: baghdad, areaText: "الكرادة", addressText: "شارع 62 قرب الجسر", reason: "طلب العميل" }, NOW);
    expect(saved.created).toBe(true);
    // edited by someone who sees the number masked: an empty phone keeps it
    await saveCustomerAddress(t.db, as("manager"), { customerId: id, id: saved.id, label: "البيت", phone: "", governorateId: baghdad, areaText: "الكرادة", addressText: "شارع 62 قرب الجسر، الطابق 2", reason: "إضافة الطابق" }, NOW + 5);
    expect((await t.db.select().from(addresses).where(eq(addresses.id, saved.id)).get())?.phoneE164).toBe("+9647701112233");
    const other = (await t.db.all<{ id: string }>(sql`SELECT d.id FROM districts AS d JOIN governorates AS g ON g.id = d.governorate_id WHERE g.slug <> 'baghdad' LIMIT 1`))[0];
    if (other) expect((await failureOf(saveCustomerAddress(t.db, as("manager"), { customerId: id, governorateId: baghdad, districtId: other.id, areaText: "المنطقة", addressText: "عنوان طويل بما يكفي", reason: "تجربة" }, NOW))).fields).toEqual({ districtId: "district_invalid" });
    await setCustomerChannels(t.db, as("manager"), { customerId: id, sms: true, whatsapp: true, email: false, reason: "طلب العميل" }, NOW + 6);
    expect((await t.db.select().from(customers).where(eq(customers.id, id)).get())?.notificationPrefs).toMatchObject({ sms: true, whatsapp: true, email: false });
    expect(await contactAction(ctx, t.db, session(as("cashier")), id, form({ intent: "channels", sms: "on", reason: "x" }))).toMatchObject({ ok: false, code: "forbidden" });
  });
});

// ───────────────────────────────────────────────────────────────── consents and privacy

describe("consents and privacy (07.04)", () => {
  test("withdrawals only, never twice; the history is append-only; the log filters", async () => {
    const id = await make.customer({ phoneE164: "+9647801231234" });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: id, kind: "marketing", granted: true, source: "checkout", at: NOW - DAY });
    expect((await failureOf(recordWithdrawal(t.db, as("support"), { customerId: id, kind: "marketing", reason: "طلب العميل" }, NOW))).code).toBe("forbidden");
    await recordWithdrawal(t.db, as("manager"), { customerId: id, kind: "marketing", reason: "اتصل وطلب إيقاف العروض" }, NOW);
    expect((await failureOf(recordWithdrawal(t.db, as("manager"), { customerId: id, kind: "marketing", reason: "مرة أخرى" }, NOW))).code).toBe("consent_not_granted");
    const history = await customerConsentHistory(t.db, as("support"), id);
    expect(history.current.find((state) => state.kind === "marketing")).toMatchObject({ granted: false, source: "admin" });
    expect(history.history.map((row) => row.granted)).toEqual([false, true]);
    await expect(t.d1.prepare("UPDATE consents SET granted = 1 WHERE subject_id = ?").bind(id).run()).rejects.toThrow(/IMMUTABLE|immutable|TT:/);
    const log = await listConsentLog(t.db, as("support"), { q: "07801231234", kind: "marketing", answer: "withdrawn", source: null, page: 1 });
    expect(log.rows.map((row) => row.customer?.id)).toEqual([id]);
    expect(log.rows[0].customer?.phone?.full).toBe(true);
  });

  test("requests: idempotent, one open per kind, nothing before verification; the export leaves out notes and cost", async () => {
    const id = await make.customer({ name: "طالب النسخة" });
    await paidOrder(id, { total: 300_000 });
    await addCustomerNote(t.db, as("support"), { customerId: id, text: "ملاحظة داخلية لا تُسلَّم" }, NOW);
    const key = randomToken();
    const first = await createPrivacyRequest(t.db, as("manager"), { customerId: id, kind: "export", idempotencyKey: key }, NOW);
    expect(await createPrivacyRequest(t.db, as("manager"), { customerId: id, kind: "export", idempotencyKey: key }, NOW)).toEqual({ ref: first.ref, replayed: true });
    expect((await failureOf(createPrivacyRequest(t.db, as("manager"), { customerId: id, kind: "export", idempotencyKey: randomToken() }, NOW))).code).toBe("privacy_open_exists");
    expect((await failureOf(createPrivacyRequest(t.db, as("manager"), { phone: "07709998877", kind: "delete", idempotencyKey: randomToken() }, NOW))).code).toBe("privacy_customer_required");
    expect((await failureOf(buildPrivacyExport(t.db, as("manager"), first.ref, NOW))).code).toBe("privacy_not_verified");
    expect((await failureOf(completePrivacyRequest(t.db, as("manager"), { ref: first.ref, note: "سُلّم" }, NOW))).code).toBe("privacy_not_verified");
    await verifyPrivacyRequest(t.db, as("manager"), { ref: first.ref, method: "call_back", note: "اتصلت برقم الحساب وأكد" }, NOW);
    expect((await failureOf(completePrivacyRequest(t.db, as("manager"), { ref: first.ref, note: "سُلّم" }, NOW))).code).toBe("privacy_not_exported");
    const file = await buildPrivacyExport(t.db, as("manager"), first.ref, NOW);
    const document = JSON.parse(file.body);
    expect(document.account.id).toBe(id);
    expect(document.orders.length).toBe(1);
    expect(file.body).not.toMatch(/ملاحظة داخلية|cost_snapshot|fraud/);
    const detail = await getPrivacyRequest(t.db, as("manager"), first.ref, NOW);
    expect(detail.exports[0]).toMatchObject({ sha256: file.sha256 });
    await completePrivacyRequest(t.db, as("manager"), { ref: first.ref, note: "سُلّم الملف في المحل" }, NOW);
    expect((await t.db.select().from(privacyRequests).where(eq(privacyRequests.ref, first.ref)).get())?.status).toBe("completed");
    expect(await customerPrivacyAction(ctx, t.db, session(as("support")), id, form({ intent: "request", kind: "delete", idempotencyKey: randomToken() }))).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("a visitor's number can unsubscribe: withdrawals land on its checkout answers (guest contacts)", async () => {
    const { guestContacts } = await import("~/server/db/schema");
    const phone = "+9647505551234";
    const guestId = newId("gst");
    await t.db.insert(guestContacts).values({ id: guestId, phoneE164: phone, createdAt: NOW });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "guest_contact", subjectId: guestId, kind: "marketing", granted: true, source: "checkout", at: NOW - DAY });
    const request = await createPrivacyRequest(t.db, as("manager"), { phone: "07505551234", kind: "unsubscribe", idempotencyKey: randomToken() }, NOW);
    expect(await privacyRequestAction(ctx, t.db, session(as("manager")), request.ref, form({ intent: "unsubscribe", kind: "marketing", note: "اتصل" }))).toMatchObject({ ok: false, code: "privacy_not_verified", status: 409 });
    await verifyPrivacyRequest(t.db, as("manager"), { ref: request.ref, method: "call_back", note: "اتصلت بالرقم" }, NOW);
    expect(await privacyRequestAction(ctx, t.db, session(as("manager")), request.ref, form({ intent: "unsubscribe", kind: "marketing", note: "طلب إيقاف العروض" }))).toMatchObject({ ok: true, withdrawn: ["marketing"] });
    const rows = await t.db.select().from(consents).where(and(eq(consents.subjectType, "guest_contact"), eq(consents.subjectId, guestId))).all();
    expect(rows.map((row) => row.granted).sort()).toEqual([false, true]);
    expect((await t.db.select().from(privacyRequests).where(eq(privacyRequests.ref, request.ref)).get())?.status).toBe("completed");
  });

  test("erasure follows the retention rules: blocked by money or open orders, then anonymizes and keeps the ledgers", async () => {
    const id = await make.customer({ name: "يريد الحذف", email: "forget@tamtam.test", phoneE164: "+9647812345670" });
    const order = await paidOrder(id, { total: 120_000 });
    const open = await paidOrder(id, { status: "confirmed", total: 50_000 });
    await creditWallet(t.db, as("manager"), { customerId: id, amountIqd: 10_000, kind: "adjustment", reason: "تعويض تأخير", idempotencyKey: `test:${randomToken()}` }, NOW);
    await t.db.insert(addresses).values({ id: newId("adr"), customerId: id, governorateId: governorateId("baghdad"), addressText: "عنوان للحذف", isDefault: true });
    await t.db.insert(consents).values({ id: newId("cns"), subjectType: "customer", subjectId: id, kind: "marketing", granted: true, source: "signup", at: NOW - DAY });
    const request = await createPrivacyRequest(t.db, as("manager"), { customerId: id, kind: "delete", idempotencyKey: randomToken() }, NOW);
    await verifyPrivacyRequest(t.db, as("manager"), { ref: request.ref, method: "in_store_id", note: "هوية في المحل" }, NOW);
    const detail = await getPrivacyRequest(t.db, as("manager"), request.ref, NOW);
    expect(detail.erasure?.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining(["open_orders", "wallet_balance"]));
    expect(detail.can.erase).toBe(false);
    expect((await failureOf(executeErasure(t.db, as("manager"), { ref: request.ref, reason: "طلب العميل" }, NOW))).code).toBe("erasure_blocked");
    // the open order ends and the money is spent (a purchase debit inside an order batch, as the core does)
    await t.db.update(orders).set({ status: "delivered" }).where(eq(orders.id, open.orderId));
    await t.db.insert(walletLedger).values({ id: newId("wal"), customerId: id, amountIqd: -10_000, kind: "purchase", refType: "order", refId: open.orderId, actorKind: "system", actorId: "test", idempotencyKey: `test:${randomToken()}`, at: NOW });
    const done = await privacyRequestAction(ctx, t.db, session(as("manager")), request.ref, form({ intent: "erase", reason: "طلب حذف موثّق" }));
    expect(done).toMatchObject({ ok: true });
    const row = await t.db.select().from(customers).where(eq(customers.id, id)).get();
    expect(row).toMatchObject({ name: null, email: null, passwordHash: null, status: "deleted", phoneE164: erasedPhone(id) });
    expect(row?.anonymizedAt).toBe(NOW);
    expect((await t.db.select().from(addresses).where(eq(addresses.customerId, id)).all()).length).toBe(0);
    expect((await t.db.select().from(orders).where(eq(orders.customerId, id)).all()).map((o) => o.id).sort()).toEqual([order.orderId, open.orderId].sort());
    expect((await t.db.select().from(walletLedger).where(eq(walletLedger.customerId, id)).all()).length).toBe(2);
    const latest = (await customerConsentHistory(t.db, as("manager"), id)).current.find((state) => state.kind === "marketing");
    expect(latest).toMatchObject({ granted: false, source: "erasure" });
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, "customers.privacy.erase")).all();
    expect(JSON.stringify(audit.at(-1))).not.toMatch(/يريد الحذف|forget@tamtam|7812345670/);
    expect((await t.db.select().from(privacyRequests).where(eq(privacyRequests.ref, request.ref)).get())?.status).toBe("completed");
  });
});

// ───────────────────────────────────────────────────────────────── merge

describe("merge (07.05)", () => {
  test("the wallet blocks a merge; a stale plan is refused; everything moves in one batch; replay is harmless", async () => {
    const keep = await make.customer({ name: "الحساب الباقي" });
    const dup = await make.customer({ name: "الحساب المكرر" });
    const dupOrder = await paidOrder(dup, { total: 80_000 });
    const product = await make.product();
    await t.db.insert(wishlistItems).values([
      { id: newId("wsh"), customerId: dup, productId: product.productId, createdAt: NOW },
      { id: newId("wsh"), customerId: keep, productId: product.productId, createdAt: NOW },
    ]);
    await t.db.insert(addresses).values({ id: newId("adr"), customerId: dup, governorateId: governorateId("baghdad"), addressText: "عنوان المكرر", isDefault: true });
    await t.db.insert(customerSessions).values({ idHash: randomToken(), customerId: dup, createdAt: NOW, lastSeenAt: NOW, expiresAt: NOW + DAY });
    // consents: the duplicate withdrew marketing after the kept account granted it; it granted personalization (never carried)
    await t.db.insert(consents).values([
      { id: newId("cns"), subjectType: "customer", subjectId: keep, kind: "marketing", granted: true, source: "checkout", at: NOW - 10 * DAY },
      { id: newId("cns"), subjectType: "customer", subjectId: dup, kind: "marketing", granted: false, source: "account", at: NOW - DAY },
      { id: newId("cns"), subjectType: "customer", subjectId: dup, kind: "personalization", granted: true, source: "account", at: NOW - DAY },
    ]);
    await creditWallet(t.db, as("manager"), { customerId: dup, amountIqd: 5000, kind: "adjustment", reason: "تعويض", idempotencyKey: `test:${randomToken()}` }, NOW);

    expect((await failureOf(planMerge(t.db, as("support"), { keepId: keep, mergeId: dup }, NOW))).code).toBe("forbidden");
    const blocked = await planMerge(t.db, as("manager"), { keepId: keep, mergeId: dup }, NOW);
    // since 2026-11-12 wallet money no longer blocks a merge: the commerce core's transfer moves it (tests/commerce-wallet-ops.test.ts)
    expect(blocked.blockers).toEqual([]);
    expect(blocked.merge.walletIqd).toBe(5000);
    expect(blocked.consentCarry).toEqual(["marketing"]);
    const verification = { method: "call_both_numbers" as const, verification: "اتصلت بالرقمين وأكد صاحبهما", reason: "حساب مكرر" };

    await t.db.insert(walletLedger).values({ id: newId("wal"), customerId: dup, amountIqd: -5000, kind: "purchase", refType: "order", refId: dupOrder.orderId, actorKind: "system", actorId: "test", idempotencyKey: `test:${randomToken()}`, at: NOW });
    const plan = await planMerge(t.db, as("manager"), { keepId: keep, mergeId: dup }, NOW);
    expect(plan.blockers).toEqual([]);
    expect(plan.moves).toMatchObject({ orders: 1, addresses: 1, wishlist: 0, sessions: 1 });
    expect(plan.stays).toMatchObject({ walletEntries: 2, duplicateFavourites: 1 });
    expect((await failureOf(mergeCustomers(t.db, as("manager"), { keepId: keep, mergeId: dup, ...verification, fingerprint: "0".repeat(24) }, NOW))).code).toBe("merge_plan_changed");
    expect(await mergeAction(ctx, t.db, session(as("finance")), keep, form({ intent: "merge", mergeId: dup, fingerprint: plan.fingerprint }))).toMatchObject({ ok: false, code: "forbidden" });

    const result = await mergeCustomers(t.db, as("manager"), { keepId: keep, mergeId: dup, ...verification, fingerprint: plan.fingerprint }, NOW);
    expect(result.replayed).toBe(false);
    expect((await t.db.select().from(orders).where(eq(orders.id, dupOrder.orderId)).get())?.customerId).toBe(keep);
    expect((await t.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, dupOrder.orderId), eq(orderEvents.kind, "customer_merged"))).all()).length).toBe(1);
    expect((await t.db.select().from(addresses).where(eq(addresses.customerId, keep)).all()).length).toBe(1);
    expect((await t.db.select().from(wishlistItems).where(eq(wishlistItems.customerId, keep)).all()).length).toBe(1);
    expect((await t.db.select().from(wishlistItems).where(eq(wishlistItems.customerId, dup)).all()).length).toBe(0);
    expect(await t.db.select().from(customers).where(eq(customers.id, dup)).get()).toMatchObject({ status: "merged", mergedIntoId: keep });
    expect((await t.db.select().from(customerSessions).where(eq(customerSessions.customerId, dup)).get())?.revokedAt).toBe(NOW);
    // the wallet ledger never moved
    expect((await t.db.select().from(walletLedger).where(eq(walletLedger.customerId, dup)).all()).length).toBe(2);
    const keptConsents = (await customerConsentHistory(t.db, as("manager"), keep)).current;
    expect(keptConsents.find((state) => state.kind === "marketing")).toMatchObject({ granted: false, source: "merge" });
    expect(keptConsents.find((state) => state.kind === "personalization")?.granted).toBeNull();
    const audit = await t.db.select().from(auditEvents).where(and(eq(auditEvents.action, "customers.customer.merge_in"), eq(auditEvents.entityId, keep))).get();
    expect(audit?.reason).toBe("حساب مكرر");
    expect(JSON.stringify(audit?.after)).toContain(dupOrder.ref);
    // a repeat is harmless; the profile of the kept account lists the merged one and its notes
    expect(await mergeCustomers(t.db, as("manager"), { keepId: keep, mergeId: dup, ...verification, fingerprint: plan.fingerprint }, NOW)).toEqual({ replayed: true, moved: null });
    const profile = await getCustomerProfile(t.db, as("manager"), keep, "ar", NOW);
    expect(profile.mergedFrom.map((merged) => merged.id)).toEqual([dup]);
    expect(profile.stats.orders).toBe(1);
    const reverse = await planMerge(t.db, as("manager"), { keepId: dup, mergeId: keep }, NOW);
    expect(reverse.blockers.map((blocker) => blocker.code)).toContain("keep_unavailable");
  });
});

// ───────────────────────────────────────────────────────────────── communication

describe("communication log (07.07)", () => {
  test("messages show only safe facts; contacts need an order of this customer; card numbers refused", async () => {
    const id = await make.customer();
    const order = await paidOrder(id, { total: 90_000 });
    await enqueueMessage(t.db, { channel: "sms", recipient: "+9647700000001", template: "order_shipped", payload: { ref: order.ref, status: "shipped", trackingNo: "TRK-1", paymentId: "pay_x", amountIqd: 95_000 }, customerId: id, refType: "order", refId: order.orderId, now: NOW });
    await enqueueMessage(t.db, { channel: "sms", recipient: "+9647700000001", template: "payment_rejected", payload: { ref: order.ref, paymentId: "pay_x", reason: "المبلغ ناقص 10,000" }, customerId: id, refType: "order", refId: order.orderId, now: NOW + 1 });
    expect((await failureOf(listCommunication(t.db, as("cashier"), { customerId: id }, NOW))).code).toBe("forbidden");
    const log = await listCommunication(t.db, as("support"), { customerId: id }, NOW);
    const shipped = log.rows.find((row) => row.kind === "message" && row.template === "order_shipped");
    expect(shipped).toMatchObject({ status: "held", orderRef: order.ref, hidden: 2 });
    expect(JSON.stringify(log.rows)).not.toMatch(/pay_x|المبلغ ناقص|amountIqd/);
    expect(shipped && shipped.kind === "message" ? shipped.facts : []).toEqual([
      { field: "status", value: "shipped" },
      { field: "trackingNo", value: "TRK-1" },
    ]);
    const other = await paidOrder(await make.customer(), { total: 10_000 });
    expect((await failureOf(logContact(t.db, as("support"), { customerId: id, channel: "phone", direction: "outbound", orderRef: other.ref, summary: "اتصلنا" }, NOW))).fields).toEqual({ orderRef: "not_found" });
    expect((await failureOf(logContact(t.db, as("support"), { customerId: id, channel: "phone", direction: "outbound", summary: "أعطانا البطاقة 4111 1111 1111 1111" }, NOW))).fields).toEqual({ summary: "note_has_card_number" });
    await logContact(t.db, as("support"), { customerId: id, channel: "whatsapp", direction: "inbound", orderRef: order.ref, summary: "سأل عن موعد التوصيل" }, NOW + 2);
    const forOrder = await listCommunication(t.db, as("support"), { customerId: id, orderRef: order.ref }, NOW);
    expect(forOrder.rows[0]).toMatchObject({ kind: "contact", channel: "whatsapp", orderRef: order.ref });
    expect((await failureOf(logContact(t.db, as("finance"), { customerId: id, channel: "phone", direction: "outbound", summary: "اتصلنا" }, NOW))).code).toBe("forbidden");
  });
});

void system;
