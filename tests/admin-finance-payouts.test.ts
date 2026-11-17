/**
 * Wallet payouts (2026-11-13): money OUT of a customer's wallet — asked in module 07 (services/admin/customers/
 * wallet.server.ts requestPayout, the profile's "payout" intent), decided in module 10 by a SECOND person
 * (services/admin/finance/wallets.server.ts decidePayout) through the commerce core's requestWalletPayout /
 * decideWalletPayout. What these tests hold the screens to:
 *
 *   · two people: whoever asked never decides (payout_self_approval) — not even to withdraw it; another employee with
 *     customers.wallet.adjust does; a cashier or support employee can neither ask nor decide
 *   · amounts: whole dinars typed in any digits; the debit is exactly the request's amount (ledger −amount, Dr wallet
 *     liability / Cr cash or bank clearing, audited); never more than the wallet holds when asked
 *   · a wrong amount: a decision bound to another figure than the request's is refused and moves nothing
 *   · a stale request: decided by someone else meanwhile (payout_not_pending), or the wallet spent since the request
 *     (payout_exceeds_balance — the overdraft trigger, nothing moves, the request still waits), one waiting per customer
 *   · the queue: countDecidablePayouts / walletQueue().payouts count the others' requests only (the bell's number)
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import type { EmployeeActor } from "~/server/actor";
import { seedRoles } from "~/server/auth/seed-roles";
import { approvals, auditEvents, employeeRoles, journalEntries, journalLines, walletLedger } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { profileAction } from "~/routes/admin/customers/customer.server";
import { payoutState, requestPayout } from "~/server/services/admin/customers/wallet.server";
import { getCustomerProfile } from "~/server/services/admin/customers/profile.server";
import { countDecidablePayouts, customerWallet, decidePayout, listPayouts, walletOverview, walletQueue } from "~/server/services/admin/finance/wallets.server";
import { parseRange } from "~/server/services/admin/finance/types";
import { creditWallet, getWalletBalance, walletDebitStatement } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<"manager" | "finance" | "finance2" | "cashier" | "support", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  staff.manager = await employee("manager");
  staff.finance = await employee("finance");
  staff.finance2 = await employee("finance");
  staff.cashier = await employee("cashier");
  staff.support = await employee("support");
}, 90_000);
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
async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return (toAppError(error) ?? error) as AppError;
  }
  throw new Error("expected a failure");
}

/** A customer whose wallet holds `amount` (a checked top-up). */
async function customerWith(amount: number): Promise<string> {
  const customerId = await make.customer();
  await creditWallet(t.db, as("finance"), { customerId, amountIqd: amount, kind: "topup", reason: "شحن مؤكد للاختبار", idempotencyKey: `topup-${randomToken(10)}`, fundedBy: "cash" }, NOW - 60_000);
  return customerId;
}
const ask = (who: EmployeeActor, customerId: string, amountIqd: number, extra: { method?: "cash" | "bank_transfer"; reference?: string } = {}) =>
  requestPayout(t.db, who, { customerId, amountIqd, method: extra.method ?? "cash", reference: extra.reference, reason: "العميل يغلق حسابه ويريد رصيده نقداً", idempotencyKey: randomToken(12) }, NOW);

describe("payouts: two people", () => {
  test("whoever asked never decides — not even to withdraw; another employee pays it out, exactly the amount, posted and audited", async () => {
    const customerId = await customerWith(50_000);
    const { approvalId } = await ask(as("manager"), customerId, 30_000);

    // the requester: neither approve nor reject
    for (const decision of ["approve", "reject"] as const) {
      const refused = await failureOf(decidePayout(t.db, as("manager"), { approvalId, decision, expectedAmountIqd: 30_000, note: "أنا طلبته" }, NOW));
      expect(refused).toMatchObject({ code: "payout_self_approval", status: 403 });
    }
    expect(await getWalletBalance(t.db, customerId)).toBe(50_000);

    const paid = await decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 30_000 }, NOW);
    expect(paid).toMatchObject({ status: "paid", replayed: false });
    expect(await getWalletBalance(t.db, customerId)).toBe(20_000);

    const entry = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `wallet_payout:${approvalId}`)).get();
    expect(entry).toMatchObject({ customerId, amountIqd: -30_000, refType: "wallet_payout", refId: approvalId });
    // Dr wallet liability / Cr cash, the payout's own amount
    const journal = await t.db.select().from(journalEntries).where(and(eq(journalEntries.refType, "wallet_ledger"), eq(journalEntries.refId, entry!.id))).get();
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, journal!.id));
    expect(lines.find((line) => line.accountId === accountId("wallet_liability"))?.debitIqd).toBe(30_000);
    expect(lines.find((line) => line.accountId === accountId("cash"))?.creditIqd).toBe(30_000);
    // asked and paid, each by its own person, in the trail
    const trail = await t.db.select().from(auditEvents).where(eq(auditEvents.entityId, customerId));
    expect(trail.find((event) => event.action === "customers.wallet.payout_request")?.actorId).toBe(as("manager").id);
    expect(trail.find((event) => event.action === "customers.wallet.payout")?.actorId).toBe(as("finance").id);

    // the same decision again is the same answer, nothing twice
    expect(await decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 30_000 }, NOW)).toMatchObject({ status: "paid", replayed: true });
    expect(await getWalletBalance(t.db, customerId)).toBe(20_000);
    const [row] = (await listPayouts(t.db, as("finance2"))).filter((payout) => payout.id === approvalId);
    expect(row).toMatchObject({ status: "approved", amountIqd: 30_000, method: "cash", entryId: entry!.id, mine: false });
  });

  test("a cashier or a support employee can neither ask nor decide; a finance employee without the request cannot decide their own", async () => {
    const customerId = await customerWith(10_000);
    expect((await failureOf(ask(as("cashier"), customerId, 5_000))).status).toBe(403);
    expect((await failureOf(ask(as("support"), customerId, 5_000))).status).toBe(403);
    const { approvalId } = await ask(as("finance"), customerId, 5_000);
    expect((await failureOf(decidePayout(t.db, as("cashier"), { approvalId, decision: "approve", expectedAmountIqd: 5_000 }, NOW))).status).toBe(403);
    expect((await failureOf(decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 5_000 }, NOW))).code).toBe("payout_self_approval");
    expect(await decidePayout(t.db, as("finance2"), { approvalId, decision: "reject", expectedAmountIqd: 5_000, note: "العميل تراجع عن الطلب" }, NOW)).toMatchObject({ status: "rejected" });
    expect(await getWalletBalance(t.db, customerId)).toBe(10_000);
  });

  test("rejecting needs a reason; a rejected request moves nothing and frees the customer for a new one", async () => {
    const customerId = await customerWith(8_000);
    const { approvalId } = await ask(as("manager"), customerId, 8_000);
    expect((await failureOf(decidePayout(t.db, as("finance"), { approvalId, decision: "reject", expectedAmountIqd: 8_000 }, NOW))).fields).toEqual({ note: "required" });
    await decidePayout(t.db, as("finance"), { approvalId, decision: "reject", expectedAmountIqd: 8_000, note: "لم يحضر العميل" }, NOW);
    expect(await getWalletBalance(t.db, customerId)).toBe(8_000);
    expect((await ask(as("manager"), customerId, 8_000)).replayed).toBe(false);
  });
});

describe("payouts: amounts", () => {
  test("whole dinars only, at least 1, never more than the wallet holds when asked", async () => {
    const customerId = await customerWith(12_000);
    expect((await failureOf(ask(as("manager"), customerId, 2_500.5))).fields).toMatchObject({ amountIqd: "invalid" });
    expect((await failureOf(ask(as("manager"), customerId, 0))).fields).toMatchObject({ amountIqd: "too_small" });
    expect((await failureOf(ask(as("manager"), customerId, -1_000))).fields).toMatchObject({ amountIqd: "too_small" });
    const over = await failureOf(ask(as("manager"), customerId, 12_001));
    expect(over).toMatchObject({ code: "payout_exceeds_balance", fields: { amountIqd: "payout_exceeds_balance" } });
    expect(await t.db.select().from(approvals).where(and(eq(approvals.kind, "wallet_payout"), eq(approvals.entityId, customerId)))).toHaveLength(0);
  });

  test("the profile's form reads the amount as typed (Arabic-Indic digits and separators) and refuses a fraction", async () => {
    const customerId = await customerWith(40_000);
    const session = { actor: as("manager") } as Parameters<typeof profileAction>[2];
    const form = (amount: string) => {
      const data = new FormData();
      data.set("intent", "payout");
      data.set("amountIqd", amount);
      data.set("method", "cash");
      data.set("reason", "إغلاق الحساب بطلب العميل");
      data.set("key", randomToken(12));
      return data;
    };
    const fraction = await profileAction({ locale: "ar", now: NOW }, t.db, session, customerId, form("١٢٫٥"));
    expect(fraction).toMatchObject({ ok: false, intent: "payout", status: 400 });
    const done = await profileAction({ locale: "ar", now: NOW }, t.db, session, customerId, form("٢٥٬٠٠٠"));
    expect(done).toMatchObject({ ok: true, intent: "payout" });
    const [request] = (await listPayouts(t.db, as("finance"))).filter((payout) => payout.customerId === customerId);
    expect(request).toMatchObject({ customerId, amountIqd: 25_000, status: "pending" });
    // a support employee (no wallet rights) is refused before anything is read
    const refused = await profileAction({ locale: "ar", now: NOW }, t.db, { actor: as("support") } as Parameters<typeof profileAction>[2], customerId, form("1000"));
    expect(refused).toMatchObject({ ok: false, status: 403 });
  });

  test("a bank transfer is paid only with its outgoing reference, posted to bank clearing; the reference reads back", async () => {
    const customerId = await customerWith(30_000);
    const { approvalId } = await ask(as("manager"), customerId, 30_000, { method: "bank_transfer" });
    const missing = await failureOf(decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 30_000 }, NOW));
    expect(missing.fields).toEqual({ reference: "reference_required" });
    expect(await getWalletBalance(t.db, customerId)).toBe(30_000);
    await decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 30_000, reference: "TRX-77821" }, NOW);
    const entry = await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `wallet_payout:${approvalId}`)).get();
    const journal = await t.db.select().from(journalEntries).where(eq(journalEntries.refId, entry!.id)).get();
    const lines = await t.db.select().from(journalLines).where(eq(journalLines.entryId, journal!.id));
    expect(lines.find((line) => line.accountId === accountId("bank_clearing"))?.creditIqd).toBe(30_000);
    const wallet = await customerWallet(t.db, as("finance"), customerId, 1);
    expect(wallet.payouts[0]).toMatchObject({ id: approvalId, status: "approved", method: "bank_transfer", reference: "TRX-77821" });
    // the ledger row reads as a payout, linked to the customer's payouts
    expect(wallet.entries.find((row) => row.id === entry!.id)).toMatchObject({ refType: "wallet_payout", refHref: `/admin/finance/wallets/${customerId}#wallet-payouts` });
  });
});

describe("payouts: a wrong amount, a stale request", () => {
  test("a decision bound to another figure than the request's is refused and nothing moves", async () => {
    const customerId = await customerWith(20_000);
    const { approvalId } = await ask(as("manager"), customerId, 15_000);
    for (const seen of [16_000, 1_500, 150_000]) {
      const refused = await failureOf(decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: seen }, NOW));
      expect(refused).toMatchObject({ code: "payout_amount_changed", status: 409 });
    }
    expect((await failureOf(decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: Number.NaN }, NOW))).status).toBe(400);
    expect(await getWalletBalance(t.db, customerId)).toBe(20_000);
    expect((await t.db.select().from(approvals).where(eq(approvals.id, approvalId)).get())?.status).toBe("pending");
  });

  test("decided by someone else meanwhile: the second decision is payout_not_pending", async () => {
    const customerId = await customerWith(9_000);
    const { approvalId } = await ask(as("manager"), customerId, 9_000);
    await decidePayout(t.db, as("finance"), { approvalId, decision: "reject", expectedAmountIqd: 9_000, note: "طلب مكرر" }, NOW);
    const stale = await failureOf(decidePayout(t.db, as("finance2"), { approvalId, decision: "approve", expectedAmountIqd: 9_000 }, NOW + 1_000));
    expect(stale).toMatchObject({ code: "payout_not_pending", status: 409 });
    expect(await getWalletBalance(t.db, customerId)).toBe(9_000);
  });

  test("the wallet spent since the request: approving is refused inside its batch, nothing moves, the request still waits", async () => {
    const customerId = await customerWith(25_000);
    const { approvalId } = await ask(as("manager"), customerId, 20_000);
    // the customer pays an order from the wallet after the request was made
    await runBatch(t.db, [walletDebitStatement(t.db, { customerId, amountIqd: 10_000, refType: "order", refId: newId("ord"), idempotencyKey: `order:${randomToken(8)}:wallet`, actor: { kind: "customer", id: customerId }, now: NOW })]);
    const stale = await failureOf(decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 20_000 }, NOW + 1_000));
    expect(stale).toMatchObject({ code: "payout_exceeds_balance", status: 409 });
    expect(await getWalletBalance(t.db, customerId)).toBe(15_000);
    expect((await t.db.select().from(approvals).where(eq(approvals.id, approvalId)).get())?.status).toBe("pending");
    expect(await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `wallet_payout:${approvalId}`))).toHaveLength(0);
    // the card says the wallet no longer covers it
    const [row] = (await listPayouts(t.db, as("finance"))).filter((payout) => payout.id === approvalId);
    expect(row).toMatchObject({ status: "pending", amountIqd: 20_000, balanceIqd: 15_000 });
  });

  test("one waiting request per customer; the profile says why it cannot ask again", async () => {
    const customerId = await customerWith(6_000);
    await ask(as("manager"), customerId, 3_000);
    expect((await failureOf(ask(as("finance"), customerId, 1_000))).code).toBe("wallet_payout_pending");
    const state = await payoutState(t.db, as("finance"), customerId);
    expect(state).toMatchObject({ canRequest: false, blockedBy: "pending", pending: { amountIqd: 3_000, method: "cash", mine: false } });
    const empty = await make.customer();
    expect(await payoutState(t.db, as("finance"), empty)).toMatchObject({ canRequest: false, blockedBy: "empty", pending: null });
    // the profile carries it only for those who read wallets
    const profile = await getCustomerProfile(t.db, as("manager"), customerId, "ar", NOW);
    expect(profile.wallet?.payout).toMatchObject({ pending: { amountIqd: 3_000, mine: true }, canRequest: false });
    expect((await getCustomerProfile(t.db, as("support"), customerId, "ar", NOW)).wallet).toBeNull();
  });
});

describe("payouts: the queue", () => {
  test("countDecidablePayouts and walletQueue().payouts count the others' waiting requests; null without the right", async () => {
    const before = { finance: await countDecidablePayouts(t.db, as("finance")), finance2: await countDecidablePayouts(t.db, as("finance2")) };
    const customerId = await customerWith(4_000);
    await ask(as("finance"), customerId, 4_000);
    expect(await countDecidablePayouts(t.db, as("finance"))).toBe(before.finance);
    expect(await countDecidablePayouts(t.db, as("finance2"))).toBe((before.finance2 ?? 0) + 1);
    expect((await walletQueue(t.db, as("finance2")))?.payouts).toBe((before.finance2 ?? 0) + 1);
    expect(await countDecidablePayouts(t.db, as("cashier"))).toBeNull();
    expect(await countDecidablePayouts(t.db, as("support"))).toBeNull();
    const overview = await walletOverview(t.db, as("finance"), parseRange(new URLSearchParams(), NOW));
    expect(overview.pendingPayouts.count).toBeGreaterThanOrEqual(1);
  });
});

describe("payouts: adversarial (review 2026-11-17)", () => {
  test("two deciders at once (double submit, two tabs): one debit, the other answers replayed or payout_not_pending", async () => {
    const customerId = await customerWith(40_000);
    const { approvalId } = await ask(as("manager"), customerId, 25_000);
    const results = await Promise.allSettled([
      decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 25_000 }, NOW),
      decidePayout(t.db, as("finance2"), { approvalId, decision: "approve", expectedAmountIqd: 25_000 }, NOW),
      decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 25_000 }, NOW),
    ]);
    expect(results.filter((result) => result.status === "fulfilled" && !result.value.replayed)).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(toAppError(result.reason)?.code).toBe("payout_not_pending");
    expect(await t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, `wallet_payout:${approvalId}`))).toHaveLength(1);
    expect(await getWalletBalance(t.db, customerId)).toBe(15_000);
  });

  test("an approve and a reject racing: exactly one wins, and money moves only if the approve did", async () => {
    const customerId = await customerWith(10_000);
    const { approvalId } = await ask(as("manager"), customerId, 10_000);
    await Promise.allSettled([
      decidePayout(t.db, as("finance"), { approvalId, decision: "approve", expectedAmountIqd: 10_000 }, NOW),
      decidePayout(t.db, as("finance2"), { approvalId, decision: "reject", expectedAmountIqd: 10_000, note: "لا يوجد ما يثبت" }, NOW),
    ]);
    const status = (await t.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)).get())?.status;
    expect(status === "approved" || status === "rejected").toBe(true);
    expect(await getWalletBalance(t.db, customerId)).toBe(status === "approved" ? 0 : 10_000);
  });

  test("junk input: a forged decision, a fraction, a negative or string figure, an unknown request: nothing moves", async () => {
    const customerId = await customerWith(9_000);
    const { approvalId } = await ask(as("manager"), customerId, 9_000);
    const junk: unknown[] = [
      { approvalId, decision: "pay", expectedAmountIqd: 9_000 },
      { approvalId, decision: "approve", expectedAmountIqd: 9_000.5 },
      { approvalId, decision: "approve", expectedAmountIqd: -9_000 },
      { approvalId, decision: "approve", expectedAmountIqd: "9000" },
      { approvalId, decision: "approve", expectedAmountIqd: Number.NaN },
      { approvalId: "apr_' OR 1=1 --", decision: "approve", expectedAmountIqd: 9_000 },
    ];
    for (const input of junk) expect((await failureOf(decidePayout(t.db, as("finance"), input as never, NOW))).status).toBeGreaterThanOrEqual(400);
    expect((await failureOf(decidePayout(t.db, as("finance"), { approvalId: "apr_doesnotexist000000000000", decision: "approve", expectedAmountIqd: 9_000 }, NOW))).status).toBe(404);
    expect(await getWalletBalance(t.db, customerId)).toBe(9_000);
    expect((await t.db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)).get())?.status).toBe("pending");
  });

  test("the request: a forged amount (fraction, negative, string, above the cap), a short reason, an unknown method are refused", async () => {
    const customerId = await customerWith(5_000);
    for (const amountIqd of [0.5, -1, "5000", 100_000_001, Number.POSITIVE_INFINITY] as unknown[])
      expect((await failureOf(requestPayout(t.db, as("manager"), { customerId, amountIqd: amountIqd as number, method: "cash", reason: "العميل يغلق حسابه", idempotencyKey: randomToken(12) }, NOW))).status).toBe(400);
    expect((await failureOf(requestPayout(t.db, as("manager"), { customerId, amountIqd: 1_000, method: "cash", reason: "قصير", idempotencyKey: randomToken(12) }, NOW))).status).toBe(400);
    expect((await failureOf(requestPayout(t.db, as("manager"), { customerId, amountIqd: 1_000, method: "crypto" as "cash", reason: "العميل يغلق حسابه", idempotencyKey: randomToken(12) }, NOW))).status).toBe(400);
    expect(await payoutState(t.db, as("finance"), customerId)).toMatchObject({ pending: null });
  });
});
