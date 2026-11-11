/**
 * Admin module 10 "finance" (owner: admin finance) — the services under app/server/services/admin/finance and the
 * route glue of app/routes/admin/finance, on a real local D1 (tests/helpers/db.ts) with the built-in roles:
 *
 *   · authorization per role (owner, manager, finance, cashier, support, custom roles) and the field permissions:
 *     the books need cost.read; profit needs cost.read + profit.read; exports follow the same rules
 *   · the ledger: manual entries (balanced, never on the wallet account, never in a closed month, idempotent),
 *     reversals (manual entries only, once), the chart of accounts (codes, parents, system accounts, balances)
 *   · statements: CSV import (Arabic headers and digits, day-first dates, dedupe on re-import), matching to PAID
 *     payments only, one line per payment, notes for differences, undo / set aside / restore, the exact bulk match
 *   · wallet top-ups (creditWallet "topup:<id>"): one credit ever, two people above the limit, send back, reject with
 *     a reason, the customer's cancel racing an approval, finishing an interrupted credit, the private proof
 *   · wallet adjustments: two people always, idempotent request and credit
 *   · tax configuration and report (inclusive only), the monthly close (checklist, order, final), anomaly checks
 *   · route loaders behind a real session: 403 for roles without the page's permission, no cost in their data
 */
import { and, eq, sql } from "drizzle-orm";
import { deflateSync } from "node:zlib";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { loader as accountsLoader } from "~/routes/admin/finance/accounts";
import { loader as financeIndexLoader } from "~/routes/admin/finance/index";
import { loader as journalLoader } from "~/routes/admin/finance/journal";
import { loader as journalExportLoader } from "~/routes/admin/finance/journal-export";
import { loader as reportsExportLoader } from "~/routes/admin/finance/reports-export";
import { loader as walletsLoader } from "~/routes/admin/finance/wallets";
import type { CustomerActor, EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { approvals, employeeRoles, expenses, fiscalPeriods, journalEntries, rolePermissions, roles, statementLines, walletLedger, walletTopups } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { runBatch } from "~/server/db/tx.server";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey, type Permission } from "~/server/permissions";
import { approveExpense, createExpense, voidExpense } from "~/server/services/accounting/expenses.server";
import { postSale } from "~/server/services/accounting/post.server";
import { profitAndLoss } from "~/server/services/accounting/reports.server";
import { cancelWalletTopup, requestWalletTopup, saveTopupProof } from "~/server/services/account/topups.server";
import { financeAnomalies } from "~/server/services/admin/finance/anomalies.server";
import { closeChecklist, closePeriod, listPeriods } from "~/server/services/admin/finance/close.server";
import { getEntry, listAccounts, listJournal, postManualEntry, reverseEntry, saveAccount } from "~/server/services/admin/finance/ledger.server";
import { realisedVsPending, salesDeductions } from "~/server/services/admin/finance/revenue.server";
import { importStatement, listStatementLines, matchExactLines, matchStatementLine, previewStatement, reviewStatementLine, ignoreStatementLine, restoreStatementLine, settlementOverview, unmatchStatementLine } from "~/server/services/admin/finance/settlements.server";
import { parseStatementCsv } from "~/server/services/admin/finance/statement-csv";
import { saveTaxRate, taxIncluded, taxReport } from "~/server/services/admin/finance/tax.server";
import { CHANNEL_LIST, parseAmount, parsePercentBps, parseRange, PRODUCT_KIND_LIST, WALLET_KIND_LIST } from "~/server/services/admin/finance/types";
import { ORDER_CHANNELS, PRODUCT_KINDS, WALLET_ENTRY_KINDS } from "~/server/db/schema";
import { customerWallet, decideTopup, decideWalletAdjustment, getTopupReview, listTopups, requestWalletAdjustment, TOPUP_SECOND_APPROVAL_ABOVE_IQD, topupProofFile, walletOverview } from "~/server/services/admin/finance/wallets.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { kvBlobStore } from "~/server/storage.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const novRange = () => parseRange(new URLSearchParams("period=2026-11"), NOW);

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<DefaultRoleKey | "finance2", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  for (const key of ["owner", "manager", "finance", "cashier", "support"] as const) staff[key] = await employee(key);
  staff.finance2 = await employee("finance");
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
const custom = (permissions: Permission[], id = newId("emp")): EmployeeActor => ({ kind: "employee", id, permissions: new Set(permissions) });

async function failureOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return appError;
  }
  throw new Error("expected the operation to fail");
}

/** A tiny valid PNG (the upload pipeline checks the real bytes). */
function png(width: number, height: number, tone = 200): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set([tone, (x * 7) % 255, (y * 5) % 255], y * (width * 3 + 1) + 1 + x * 3);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

let tone = 10;
/** A customer's top-up request with its private proof, through the account services. */
async function topupRequest(customerId: string, amount: number, reference?: string): Promise<string> {
  const shopper: CustomerActor = { kind: "customer", id: customerId };
  const proof = await saveTopupProof(t.db, kvBlobStore(t.kv), shopper, new Blob([png(64, 48, (tone += 3) % 250) as Uint8Array<ArrayBuffer>], { type: "image/png" }), NOW);
  const { topup } = await requestWalletTopup(t.db, shopper, { method: "bank_transfer", declaredAmountIqd: amount, reference, fileId: proof.fileId, idempotencyKey: randomToken(12) }, NOW);
  return topup.id;
}

// ───────────────────────────────────────────────────────────────── pure helpers

describe("pure helpers", () => {
  test("amounts typed by people: Arabic-Indic and Persian digits, separators, signs; fractions refused", () => {
    expect(parseAmount("١٥٠٬٠٠٠")).toBe(150_000);
    expect(parseAmount("۷۵۴۰۰۰")).toBe(754_000);
    expect(parseAmount("754,000")).toBe(754_000);
    expect(parseAmount("12,000.00")).toBe(12_000);
    expect(parseAmount("12.5")).toBeNaN();
    expect(parseAmount("-25,000")).toBeNaN();
    expect(parseAmount("-25,000", { signed: true })).toBe(-25_000);
    expect(parseAmount("(2,500)", { signed: true })).toBe(-2_500);
    expect(parseAmount("")).toBeUndefined();
    expect(parsePercentBps("15")).toBe(1500);
    expect(parsePercentBps("٢٫٥")).toBe(250);
    expect(parsePercentBps("abc")).toBeNaN();
  });

  test("ranges: a month, two days (swapped when reversed), the current month by default; Baghdad midnight", () => {
    expect(parseRange(new URLSearchParams("period=2026-10"), NOW)).toMatchObject({ period: "2026-10", from: "2026-10-01", to: "2026-10-31", fromMs: Date.UTC(2026, 9, 1) - 3 * HOUR });
    expect(parseRange(new URLSearchParams("from=2026-11-09&to=2026-11-02&demo=1"), NOW)).toMatchObject({ period: null, from: "2026-11-02", to: "2026-11-09", demo: true });
    expect(parseRange(new URLSearchParams(""), NOW)).toMatchObject({ period: "2026-11" });
    expect(parseRange(new URLSearchParams("period=2026-13"), NOW).period).toBe("2026-11");
  });

  test("the client-side copies of schema enums match the schema", () => {
    expect([...PRODUCT_KIND_LIST]).toEqual([...PRODUCT_KINDS]);
    expect([...CHANNEL_LIST]).toEqual([...ORDER_CHANNELS]);
    expect([...WALLET_KIND_LIST]).toEqual([...WALLET_ENTRY_KINDS]);
  });

  test("statement CSV: Arabic headers, semicolons, day-first dates, money out, bad rows explained", () => {
    const parsed = parseStatementCsv("﻿التاريخ;المبلغ;المرجع;الاسم\n09/11/2026 14:30;\"١٥٠٬٠٠٠\";TT-7K4M;علي\n2026-11-10;(2,500);;البنك\n31/02/2026;100;;x\n2026-11-10;12.5;;y\n2026-11-10;0;;z");
    expect(parsed.problem).toBeNull();
    expect(parsed.columns).toMatchObject({ date: "التاريخ", amount: "المبلغ", reference: "المرجع", counterparty: "الاسم" });
    expect(parsed.rows.map((row) => [row.amountIqd, row.error])).toEqual([
      [150_000, null],
      [-2_500, null],
      [100, "date_invalid"],
      [null, "amount_invalid"],
      [0, "amount_zero"],
    ]);
    expect(parsed.rows[0].occurredAt).toBe(Date.UTC(2026, 10, 9, 14, 30) - 3 * HOUR);
    expect(parseStatementCsv("a,b\n1,2").problem).toBe("no_date_column");
    expect(parseStatementCsv("date,credit,debit\n2026-11-01,,25000").rows[0].amountIqd).toBe(-25_000);
  });

  test("tax inside a tax-inclusive price", () => {
    expect(taxIncluded(115_000, 1500)).toBe(15_000);
    expect(taxIncluded(100_000, 0)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── authorization and cost hiding

describe("authorization per role and cost hiding", () => {
  test("the books need finance.journal.read AND cost.read; cashier and support see nothing of finance", async () => {
    const range = { ...novRange(), account: null, refType: null, q: "", page: 1 };
    await expect(listJournal(t.db, as("finance"), range, "ar")).resolves.toBeTruthy();
    await expect(listJournal(t.db, as("manager"), range, "ar")).resolves.toBeTruthy();
    expect(await failureOf(listJournal(t.db, as("cashier"), range, "ar"))).toMatchObject({ code: "forbidden", status: 403 });
    expect(await failureOf(listJournal(t.db, custom(["finance.journal.read"]), range, "ar"))).toMatchObject({ code: "forbidden", detail: "cost.read" });
    expect(await failureOf(listAccounts(t.db, custom(["finance.journal.read", "finance.report.read"]), novRange(), "ar"))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(settlementOverview(t.db, as("support"), novRange()))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(walletOverview(t.db, as("cashier"), novRange()))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(financeAnomalies(t.db, as("support"), NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(taxReport(t.db, as("cashier"), novRange(), "ar"))).toMatchObject({ code: "forbidden" });
  });

  test("10.03/10.04: revenue for finance.report.read; COGS and margin only with their permissions", async () => {
    const orderId = newId("ord");
    await runBatch(t.db, [...postSale(t.db, { at: NOW, createdBy: "system:test", isDemo: false, orderId, ref: "TT-AUTH1", subtotalIqd: 40_000, discountIqd: 0, shippingIqd: 5_000, totalIqd: 45_000 })]);
    const reportOnly = custom(["finance.report.read"]);
    const position = await realisedVsPending(t.db, reportOnly, novRange());
    expect(position.realised.grossIqd).toBeGreaterThanOrEqual(40_000);
    const deductions = await salesDeductions(t.db, reportOnly, novRange());
    expect(deductions.cost).toBeNull();
    expect(deductions.margin).toBeNull();
    expect((await salesDeductions(t.db, as("finance"), novRange())).margin).not.toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────── ledger

describe("the ledger: manual entries, reversals, the chart of accounts", () => {
  const entry = (key: string, lines: { accountId: string; debitIqd?: number; creditIqd?: number; costCenter?: string }[], date = "2026-11-10") => ({ date, memo: "قيد اختبار", reason: "تسوية اختبار", lines, idempotencyKey: `manual-${key}` });

  test("a balanced manual entry posts once; unbalanced, one-sided, wallet and future entries are refused", async () => {
    const lines = [
      { accountId: accountId("operating_expenses"), debitIqd: 12_000 },
      { accountId: accountId("cash"), creditIqd: 12_000 },
    ];
    const posted = await postManualEntry(t.db, as("finance"), entry("ok", lines), NOW);
    expect(posted.replayed).toBe(false);
    expect(await postManualEntry(t.db, as("finance"), entry("ok", lines), NOW)).toEqual({ entryId: posted.entryId, replayed: true });
    const view = await getEntry(t.db, as("finance"), posted.entryId, "ar");
    expect(view).toMatchObject({ refType: "manual", totalIqd: 12_000, canReverse: true, reverseBlocked: null });
    expect(await failureOf(postManualEntry(t.db, as("finance"), entry("unbalanced", [lines[0], { accountId: accountId("cash"), creditIqd: 11_000 }]), NOW))).toMatchObject({ code: "journal_unbalanced", status: 400 });
    expect(await failureOf(postManualEntry(t.db, as("finance"), entry("both", [{ accountId: accountId("cash"), debitIqd: 5, creditIqd: 5 }, lines[1]]), NOW))).toMatchObject({ code: "invalid", fields: { "lines.0.amount": "journal_line_invalid" } });
    expect(await failureOf(postManualEntry(t.db, as("finance"), entry("wallet", [{ accountId: accountId("wallet_liability"), debitIqd: 1_000 }, { accountId: accountId("cash"), creditIqd: 1_000 }]), NOW))).toMatchObject({ code: "invalid", fields: { "lines.0.accountId": "journal_wallet_manual" } });
    expect(await failureOf(postManualEntry(t.db, as("finance"), entry("future", lines, "2026-11-11"), NOW))).toMatchObject({ code: "invalid", fields: { date: "journal_date_future" } });
    expect(await failureOf(postManualEntry(t.db, as("finance"), entry("one-line", [lines[0]]), NOW))).toMatchObject({ code: "invalid" });
    // the manager reads the books but does not post by hand
    expect(await failureOf(postManualEntry(t.db, as("manager"), entry("manager", lines), NOW))).toMatchObject({ code: "forbidden" });
  });

  test("a manual entry is reversed once by a mirror entry dated now; automatic entries are not reversed here", async () => {
    const posted = await postManualEntry(t.db, as("finance"), entry("to-reverse", [{ accountId: accountId("marketing"), debitIqd: 7_000 }, { accountId: accountId("bank_clearing"), creditIqd: 7_000 }], "2026-11-03"), NOW);
    const reversal = await reverseEntry(t.db, as("owner"), { entryId: posted.entryId, reason: "خطأ في الحساب" }, NOW);
    const row = await t.db.select().from(journalEntries).where(eq(journalEntries.id, reversal.reversalId)).get();
    expect(row).toMatchObject({ reversesId: posted.entryId, idempotencyKey: `reversal:${posted.entryId}`, period: "2026-11", at: NOW });
    expect(await reverseEntry(t.db, as("finance"), { entryId: posted.entryId, reason: "مرة ثانية" }, NOW)).toEqual({ reversalId: reversal.reversalId, replayed: true });
    expect(await failureOf(reverseEntry(t.db, as("finance"), { entryId: reversal.reversalId, reason: "عكس العكس" }, NOW))).toMatchObject({ code: "reverse_reversal" });
    const orderId = newId("ord");
    await runBatch(t.db, postSale(t.db, { at: NOW, createdBy: "system:test", isDemo: false, orderId, ref: "TT-REV1", subtotalIqd: 10_000, discountIqd: 0, shippingIqd: 0, totalIqd: 10_000 }));
    const sale = await t.db.select().from(journalEntries).where(eq(journalEntries.refId, orderId)).get();
    expect(await failureOf(reverseEntry(t.db, as("finance"), { entryId: sale!.id, reason: "تجربة" }, NOW))).toMatchObject({ code: "reverse_not_manual" });
    expect((await getEntry(t.db, as("finance"), sale!.id, "ar")).reverseBlocked).toBe("not_manual");
  });

  test("the chart: unique codes, parents of the same type, system accounts stay on, no switching off with a balance", async () => {
    const owner = as("owner");
    expect(await failureOf(saveAccount(t.db, owner, { code: "1000", nameAr: "صندوق ثان", type: "asset", isActive: true, reason: "إضافة" }, NOW))).toMatchObject({ code: "account_code_taken" });
    expect(await failureOf(saveAccount(t.db, owner, { code: "6450", nameAr: "إعلانات", type: "expense", parentId: accountId("cash"), isActive: true, reason: "إضافة" }, NOW))).toMatchObject({ code: "account_parent_invalid" });
    const created = await saveAccount(t.db, owner, { code: "6450", nameAr: "إعلانات فيسبوك", nameEn: "Facebook ads", type: "expense", parentId: accountId("marketing"), isActive: true, reason: "تفصيل التسويق" }, NOW);
    expect(created.created).toBe(true);
    expect(await failureOf(saveAccount(t.db, owner, { id: accountId("cash"), code: "1000", nameAr: "الصندوق", isActive: false, reason: "إيقاف" }, NOW))).toMatchObject({ code: "account_system_locked" });
    await postManualEntry(t.db, as("finance"), entry("fb", [{ accountId: created.accountId, debitIqd: 3_000 }, { accountId: accountId("cash"), creditIqd: 3_000 }]), NOW);
    expect(await failureOf(saveAccount(t.db, owner, { id: created.accountId, code: "6450", nameAr: "إعلانات فيسبوك", isActive: false, reason: "إيقاف" }, NOW))).toMatchObject({ code: "account_has_balance" });
    // renumbering a system account keeps every posting working (they use the system key)
    await saveAccount(t.db, owner, { id: accountId("marketing"), code: "6401", nameAr: "تسويق وإعلان", isActive: true, reason: "ترقيم جديد" }, NOW);
    const chart = await listAccounts(t.db, as("finance"), novRange(), "ar");
    expect(chart.totals.balanced).toBe(true);
    expect(chart.rows.find((row) => row.id === created.accountId)).toMatchObject({ depth: 2, balanceIqd: 3_000 });
    expect(await failureOf(saveAccount(t.db, as("manager"), { code: "7000", nameAr: "حساب", type: "expense", isActive: true, reason: "x x x" }, NOW))).toMatchObject({ code: "forbidden" });
  });
});

// ───────────────────────────────────────────────────────────────── statements and settlements

describe("statements: import, match, set aside", () => {
  let orderRef: string;
  let paidId: string;
  let pendingId: string;

  beforeAll(async () => {
    const product = await make.product({ priceIqd: 90_000 });
    const order = await make.order([{ ...product, qty: 1 }]);
    orderRef = order.ref;
    paidId = await make.payment(order.orderId, 95_000, { method: "bank_transfer", status: "paid", verifiedBy: as("finance").id, verifiedAt: NOW, paidAt: NOW - HOUR, reference: "BT-55501" });
    const other = await make.order([{ ...product, qty: 1 }]);
    pendingId = await make.payment(other.orderId, 95_000, { method: "bank_transfer", status: "pending_verification", reference: "BT-55502" });
  });

  test("preview then import; importing the same file again adds nothing", async () => {
    const csv = `التاريخ,المبلغ,المرجع,الاسم\n10/11/2026 08:00,"٩٥٬٠٠٠",BT-55501,زبون\n10/11/2026 09:00,"95,000",BT-55502,زبون\n10/11/2026 10:00,-1500,,البنك\nnot a date,5,,x`;
    const preview = await previewStatement(t.db, as("finance"), { source: "bank_card", csv });
    expect(preview.counts).toEqual({ total: 4, fresh: 3, duplicate: 0, error: 1 });
    expect(preview).toMatchObject({ inIqd: 190_000, outIqd: 1_500 });
    const first = await importStatement(t.db, as("finance"), { source: "bank_card", csv }, NOW);
    expect(first).toMatchObject({ inserted: 3, errors: 1 });
    const again = await importStatement(t.db, as("finance"), { source: "bank_card", csv }, NOW);
    expect(again).toMatchObject({ inserted: 0, skipped: 3 });
    expect((await previewStatement(t.db, as("finance"), { source: "bank_card", csv })).counts.duplicate).toBe(3);
    expect(await failureOf(importStatement(t.db, as("cashier"), { source: "bank_card", csv }, NOW))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(previewStatement(t.db, as("finance"), { source: "bank_card", csv: "x,y\n1,2" }))).toMatchObject({ code: "statement_no_date_column" });
  });

  test("a line proves a PAID payment once; a pending payment cannot be matched; a difference needs a note", async () => {
    const lines = await listStatementLines(t.db, as("finance"), { ...novRange(), source: "bank_card", status: "unmatched", q: "", page: 1 });
    const line = (ref: string) => lines.rows.find((row) => row.reference === ref)!;
    const review = await reviewStatementLine(t.db, as("finance"), line("BT-55501").id, "");
    expect(review.candidates[0]).toMatchObject({ id: paidId, matchable: true, reasons: expect.arrayContaining(["amount", "reference"]) });
    expect(await failureOf(matchStatementLine(t.db, as("finance"), { lineId: line("BT-55502").id, paymentId: pendingId }, NOW))).toMatchObject({ code: "payment_not_paid" });
    await matchStatementLine(t.db, as("finance"), { lineId: line("BT-55501").id, paymentId: paidId }, NOW);
    expect(await matchStatementLine(t.db, as("finance"), { lineId: line("BT-55501").id, paymentId: paidId }, NOW)).toEqual({ replayed: true });
    expect(await failureOf(matchStatementLine(t.db, as("finance"), { lineId: line("BT-55502").id, paymentId: paidId }, NOW))).toMatchObject({ code: "payment_already_matched" });
    const fee = lines.rows.find((row) => row.amountIqd < 0)!;
    expect(await failureOf(matchStatementLine(t.db, as("finance"), { lineId: fee.id, paymentId: paidId }, NOW))).toMatchObject({ code: "line_money_out" });
    await ignoreStatementLine(t.db, as("finance"), { lineId: fee.id, reason: "رسوم البنك" }, NOW);
    const listed = await listStatementLines(t.db, as("finance"), { ...novRange(), source: null, status: "ignored", q: "", page: 1 });
    expect(listed.rows.find((row) => row.id === fee.id)).toMatchObject({ status: "ignored", note: "رسوم البنك" });
    await restoreStatementLine(t.db, as("finance"), { lineId: fee.id, reason: "خطأ" }, NOW);
    await unmatchStatementLine(t.db, as("finance"), { lineId: line("BT-55501").id, reason: "مراجعة" }, NOW);
    expect(await unmatchStatementLine(t.db, as("finance"), { lineId: line("BT-55501").id, reason: "مرة ثانية" }, NOW)).toEqual({ replayed: true });
    // two people matching the same line at once: one wins
    const raced = await Promise.allSettled([matchStatementLine(t.db, as("finance"), { lineId: line("BT-55501").id, paymentId: paidId }, NOW), matchStatementLine(t.db, as("finance2"), { lineId: line("BT-55501").id, paymentId: paidId }, NOW)]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect((await t.db.select().from(statementLines).where(eq(statementLines.matchedPaymentId, paidId))).length).toBe(1);
    expect(await failureOf(restoreStatementLine(t.db, as("finance"), { lineId: line("BT-55501").id, reason: "ليس مستبعداً" }, NOW))).toMatchObject({ code: "line_not_ignored" });
  });

  test("a different amount is matched only with a note; the bulk match takes the unambiguous ones only", async () => {
    const product = await make.product({ priceIqd: 40_000 });
    const order = await make.order([{ ...product, qty: 1 }]);
    const paid = await make.payment(order.orderId, 45_000, { method: "zaincash", status: "paid", verifiedBy: as("finance").id, verifiedAt: NOW, paidAt: NOW, reference: "ZC-9001" });
    const csv = `date,amount,reference\n2026-11-10 11:00,44000,ZC-9001\n2026-11-10 11:30,45000,ZC-9001\n`;
    await importStatement(t.db, as("finance"), { source: "zaincash", csv }, NOW);
    const rows = (await listStatementLines(t.db, as("finance"), { ...novRange(), source: "zaincash", status: "unmatched", q: "", page: 1 })).rows;
    const short = rows.find((row) => row.amountIqd === 44_000)!;
    expect(await failureOf(matchStatementLine(t.db, as("finance"), { lineId: short.id, paymentId: paid }, NOW))).toMatchObject({ code: "match_note_required" });
    const bulk = await matchExactLines(t.db, as("finance"), novRange(), NOW);
    expect(bulk.matched).toBe(1);
    expect((await t.db.select().from(statementLines).where(eq(statementLines.matchedPaymentId, paid)).get())?.amountIqd).toBe(45_000);
    const overview = await settlementOverview(t.db, as("finance"), novRange());
    expect(overview.transfers.find((row) => row.method === "zaincash")?.matched.count).toBeGreaterThanOrEqual(1);
    expect(overview.card).toEqual({ count: 0, iqd: 0 });
    void orderRef;
  });
});

// ───────────────────────────────────────────────────────────────── wallet top-ups and adjustments

describe("wallet top-ups and adjustments", () => {
  let customerId: string;
  beforeAll(async () => {
    customerId = await make.customer({ isDemo: false });
  });
  const ledgerRows = (key: string) => t.db.select().from(walletLedger).where(eq(walletLedger.idempotencyKey, key));

  test("approve once: the wallet is credited through creditWallet (topup:<id>), posted, and never twice", async () => {
    const topupId = await topupRequest(customerId, 50_000, "TR-1");
    expect(await failureOf(decideTopup(t.db, as("support"), { topupId, decision: "approve" }, NOW))).toMatchObject({ code: "forbidden" });
    const result = await decideTopup(t.db, as("finance"), { topupId, decision: "approve" }, NOW);
    expect(result).toMatchObject({ status: "approved", replayed: false });
    expect(await getWalletBalance(t.db, customerId)).toBe(50_000);
    expect(await decideTopup(t.db, as("finance2"), { topupId, decision: "approve" }, NOW)).toMatchObject({ status: "approved", replayed: true });
    expect(await ledgerRows(`topup:${topupId}`)).toHaveLength(1);
    const row = await t.db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).get();
    expect(row).toMatchObject({ status: "approved", verifiedBy: as("finance").id, walletLedgerId: result.entryId });
    const posting = await t.db.select().from(journalEntries).where(eq(journalEntries.refId, result.entryId as string)).get();
    expect(posting).toMatchObject({ refType: "wallet_ledger", idempotencyKey: `wallet:${result.entryId}` });
    expect(await failureOf(decideTopup(t.db, as("finance"), { topupId, decision: "reject", note: "متأخر" }, NOW))).toMatchObject({ code: "topup_not_pending" });
  });

  test("a different amount needs a note; a rejection needs a reason the customer reads", async () => {
    const topupId = await topupRequest(customerId, 20_000, "TR-2");
    expect(await failureOf(decideTopup(t.db, as("finance"), { topupId, decision: "approve", amountIqd: 19_000 }, NOW))).toMatchObject({ code: "topup_amount_note_required" });
    expect(await failureOf(decideTopup(t.db, as("finance"), { topupId, decision: "reject" }, NOW))).toMatchObject({ code: "topup_reject_reason_required" });
    await decideTopup(t.db, as("finance"), { topupId, decision: "reject", note: "الصورة غير واضحة" }, NOW);
    expect(await t.db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).get()).toMatchObject({ status: "rejected", rejectReason: "الصورة غير واضحة" });
    expect(await ledgerRows(`topup:${topupId}`)).toHaveLength(0);
  });

  test("above the limit two people decide: a first approval credits nothing; the same person cannot confirm; send back", async () => {
    const amount = TOPUP_SECOND_APPROVAL_ABOVE_IQD + 250_000;
    const topupId = await topupRequest(customerId, amount, "TR-3");
    const before = await getWalletBalance(t.db, customerId);
    expect(await decideTopup(t.db, as("finance"), { topupId, decision: "approve" }, NOW)).toMatchObject({ status: "awaiting_second" });
    expect(await getWalletBalance(t.db, customerId)).toBe(before);
    expect(await failureOf(decideTopup(t.db, as("finance"), { topupId, decision: "approve" }, NOW))).toMatchObject({ code: "topup_second_person", status: 403 });
    const review = await getTopupReview(t.db, as("finance2"), topupId, (id) => `/proof/${id}`);
    expect(review.firstApproval).toMatchObject({ amountIqd: amount, byMe: false });
    // the second person sends it back; then a new first approval and a confirmation
    expect(await failureOf(decideTopup(t.db, as("finance"), { topupId, decision: "return", note: "خطأ" }, NOW))).toMatchObject({ code: "topup_second_person" });
    expect(await decideTopup(t.db, as("finance2"), { topupId, decision: "return", note: "المبلغ يحتاج تأكيد" }, NOW)).toMatchObject({ status: "pending" });
    await decideTopup(t.db, as("finance2"), { topupId, decision: "approve" }, NOW);
    expect(await failureOf(decideTopup(t.db, as("finance"), { topupId, decision: "approve", amountIqd: amount - 1 }, NOW))).toMatchObject({ code: "topup_amount_changed" });
    expect(await decideTopup(t.db, as("finance"), { topupId, decision: "approve" }, NOW)).toMatchObject({ status: "approved" });
    expect(await getWalletBalance(t.db, customerId)).toBe(before + amount);
    expect(await t.db.select().from(approvals).where(and(eq(approvals.entityId, topupId), eq(approvals.status, "approved")))).toHaveLength(1);
  });

  test("the customer's cancel racing an approval: exactly one wins, and money moves only when the approval won", async () => {
    const topupId = await topupRequest(customerId, 10_000, "TR-4");
    const before = await getWalletBalance(t.db, customerId);
    const results = await Promise.allSettled([decideTopup(t.db, as("finance"), { topupId, decision: "approve" }, NOW), cancelWalletTopup(t.db, { kind: "customer", id: customerId }, topupId, NOW)]);
    const row = await t.db.select().from(walletTopups).where(eq(walletTopups.id, topupId)).get();
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await getWalletBalance(t.db, customerId)).toBe(row?.status === "approved" ? before + 10_000 : before);
  });

  test("an approval whose credit was interrupted is finished by approving again, once", async () => {
    const topupId = await topupRequest(customerId, 15_000, "TR-5");
    // the decision was recorded but the credit never ran (a crash between the two writes)
    await t.db.update(walletTopups).set({ status: "approved", verifiedBy: as("finance").id, verifiedAt: NOW, amountIqd: 15_000 }).where(eq(walletTopups.id, topupId));
    const report = await financeAnomalies(t.db, as("finance"), NOW);
    expect(report.checks.find((check) => check.check === "wallet.topup_not_credited")?.findings.map((finding) => finding.entityId)).toContain(topupId);
    expect((await listTopups(t.db, as("finance"), { status: "approved", page: 1 })).rows.find((row) => row.id === topupId)?.notCredited).toBe(true);
    const before = await getWalletBalance(t.db, customerId);
    await decideTopup(t.db, as("finance2"), { topupId, decision: "approve" }, NOW);
    await decideTopup(t.db, as("finance2"), { topupId, decision: "approve" }, NOW);
    expect(await getWalletBalance(t.db, customerId)).toBe(before + 15_000);
    expect(await ledgerRows(`topup:${topupId}`)).toHaveLength(1);
  });

  test("the proof is private: payment_proof.read and finance.wallet.read; no proof URL in the review without it", async () => {
    const topupId = await topupRequest(customerId, 12_000, "TR-6");
    expect(await topupProofFile(t.db, as("finance"), topupId)).toBeTruthy();
    expect(await failureOf(topupProofFile(t.db, custom(["finance.wallet.read"]), topupId))).toMatchObject({ code: "forbidden" });
    expect(await failureOf(topupProofFile(t.db, as("support"), topupId))).toMatchObject({ code: "forbidden" });
    const review = await getTopupReview(t.db, custom(["finance.wallet.read"]), topupId, (id) => `/proof/${id}`);
    expect(review).toMatchObject({ hasProof: true, proofUrl: null, canDecide: false });
  });

  test("adjustments: two people always; the request is idempotent; the credit happens once", async () => {
    const key = randomToken(12);
    const request = await requestWalletAdjustment(t.db, as("finance"), { customerId, amountIqd: 7_000, reason: "تعويض عن تأخير التوصيل", idempotencyKey: key }, NOW);
    expect(await requestWalletAdjustment(t.db, as("finance"), { customerId, amountIqd: 7_000, reason: "تعويض عن تأخير التوصيل", idempotencyKey: key }, NOW)).toEqual({ approvalId: request.approvalId, replayed: true });
    expect(await failureOf(requestWalletAdjustment(t.db, as("finance"), { customerId, amountIqd: 7_000, reason: "قصير", idempotencyKey: randomToken(12) }, NOW))).toMatchObject({ code: "invalid" });
    expect(await failureOf(decideWalletAdjustment(t.db, as("finance"), { approvalId: request.approvalId, decision: "approve" }, NOW))).toMatchObject({ code: "adjustment_self_approval", status: 403 });
    const before = await getWalletBalance(t.db, customerId);
    await decideWalletAdjustment(t.db, as("finance2"), { approvalId: request.approvalId, decision: "approve" }, NOW);
    await decideWalletAdjustment(t.db, as("owner"), { approvalId: request.approvalId, decision: "approve" }, NOW);
    expect(await getWalletBalance(t.db, customerId)).toBe(before + 7_000);
    const credited = await ledgerRows(`adjustment:${request.approvalId}`);
    expect(credited).toHaveLength(1);
    expect(credited[0]).toMatchObject({ kind: "adjustment", refType: "approval", refId: request.approvalId });
    const withdraw = await requestWalletAdjustment(t.db, as("finance"), { customerId, amountIqd: 3_000, reason: "تعويض إضافي غير لازم", idempotencyKey: randomToken(12) }, NOW);
    expect(await decideWalletAdjustment(t.db, as("finance"), { approvalId: withdraw.approvalId, decision: "reject", note: "سحب الطلب" }, NOW)).toMatchObject({ status: "rejected" });
    const wallet = await customerWallet(t.db, as("finance"), customerId, 1);
    expect(wallet.balanceIqd).toBe(await getWalletBalance(t.db, customerId));
    // the wallet ledger and its account agree to the dinar after all of this
    const overview = await walletOverview(t.db, as("finance"), novRange());
    expect(overview.differenceIqd).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── tax, close, anomalies

describe("tax configuration and report", () => {
  test("nothing configured by default; a rate is reported from tax-inclusive prices; stale edits refused", async () => {
    expect((await taxReport(t.db, as("finance"), novRange(), "ar")).configured).toBe(false);
    const created = await saveTaxRate(t.db, as("finance"), { code: "test-tax", nameAr: "ضريبة اختبار", rateBps: 1000, productKinds: ["console"], channels: [], isActive: true, reason: "اختبار التقرير" }, NOW);
    const product = await make.product({ kind: "console", priceIqd: 110_000 });
    const order = await make.order([{ ...product, qty: 1 }], { status: "delivered", deliveredAt: NOW });
    void order;
    const report = await taxReport(t.db, as("finance"), novRange(), "ar");
    const row = report.rows.find((item) => item.rate.id === created.id);
    expect(row?.baseIqd).toBeGreaterThanOrEqual(110_000);
    expect(row?.taxIqd).toBe(Math.round((row!.baseIqd * 1000) / 11_000));
    expect(row?.rate.isInclusive).toBe(true);
    expect(await failureOf(saveTaxRate(t.db, as("finance"), { id: created.id, code: "TEST-TAX", nameAr: "ضريبة", rateBps: 500, isActive: true, reason: "تعديل قديم", expectedUpdatedAt: NOW - 1 }, NOW))).toMatchObject({ code: "tax_rate_changed" });
    expect(await failureOf(saveTaxRate(t.db, as("finance"), { code: "TEST-TAX", nameAr: "ضريبة", rateBps: 500, isActive: true, reason: "مكرر" }, NOW))).toMatchObject({ code: "tax_code_taken" });
    expect(await failureOf(saveTaxRate(t.db, as("finance"), { code: "BAD", nameAr: "ضريبة", rateBps: 10_001, isActive: true, reason: "كبيرة" }, NOW))).toMatchObject({ code: "invalid" });
  });
});

describe("the monthly close", () => {
  test("not before the month is over, in order, final for every posting dated in it; manager cannot close", async () => {
    const lines = (amount: number) => [
      { accountId: accountId("operating_expenses"), debitIqd: amount },
      { accountId: accountId("cash"), creditIqd: amount },
    ];
    await postManualEntry(t.db, as("finance"), { date: "2026-07-15", memo: "تموز", reason: "اختبار الإغلاق", lines: lines(1_000), idempotencyKey: "close-july" }, NOW);
    await postManualEntry(t.db, as("finance"), { date: "2026-08-15", memo: "شهر آب", reason: "اختبار الإغلاق", lines: lines(2_000), idempotencyKey: "close-august" }, NOW);
    const current = await closeChecklist(t.db, as("finance"), "2026-11", NOW);
    expect(current.items.find((item) => item.key === "month_over")?.state).toBe("block");
    expect(await failureOf(closePeriod(t.db, as("finance"), { period: "2026-11", reason: "مبكر" }, NOW))).toMatchObject({ code: "period_not_over" });
    const august = await closeChecklist(t.db, as("finance"), "2026-08", NOW);
    expect(august.items.find((item) => item.key === "earlier_open")).toMatchObject({ state: "block", periods: expect.arrayContaining(["2026-07"]) });
    expect(await failureOf(closePeriod(t.db, as("finance"), { period: "2026-08", reason: "ترتيب" }, NOW))).toMatchObject({ code: "period_earlier_open" });
    expect(await failureOf(closePeriod(t.db, as("manager"), { period: "2026-07", reason: "مدير" }, NOW))).toMatchObject({ code: "forbidden" });
    // earlier test months (May, June) hold entries too: close them first, in order
    for (const period of (await listPeriods(t.db, as("finance"), NOW)).filter((row) => row.period < "2026-07" && row.entries > 0 && row.status === "open").map((row) => row.period).sort()) {
      await closePeriod(t.db, as("finance"), { period, reason: "إغلاق سابق" }, NOW);
    }
    expect(await closePeriod(t.db, as("finance"), { period: "2026-07", reason: "راجعنا الكشوف" }, NOW)).toEqual({ replayed: false });
    expect(await closePeriod(t.db, as("finance2"), { period: "2026-07", reason: "مرة ثانية" }, NOW)).toEqual({ replayed: true });
    expect(await t.db.select().from(fiscalPeriods).where(eq(fiscalPeriods.period, "2026-07")).get()).toMatchObject({ status: "closed", closedBy: as("finance").id, note: "راجعنا الكشوف" });
    // the database and the services refuse anything dated into a closed month
    expect(await failureOf(postManualEntry(t.db, as("finance"), { date: "2026-07-20", memo: "متأخر", reason: "تصحيح", lines: lines(500), idempotencyKey: "close-late" }, NOW))).toMatchObject({ code: "period_closed" });
    const draft = await createExpense(t.db, as("finance"), { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), amountIqd: 900, description: "مصروف آب", incurredOn: "2026-08-20", idempotencyKey: "close-expense-aug" }, NOW);
    expect((await closeChecklist(t.db, as("finance"), "2026-08", NOW)).items.find((item) => item.key === "draft_expenses")).toMatchObject({ state: "warn", count: 1 });
    await closePeriod(t.db, as("finance"), { period: "2026-08", reason: "شهر آب" }, NOW);
    expect(await failureOf(approveExpense(t.db, as("finance2"), { expenseId: draft.expenseId }, NOW))).toMatchObject({ code: "period_closed" });
    // a correction of July goes into an open month as a reversal
    const july = await t.db.select().from(journalEntries).where(eq(journalEntries.memo, "تموز")).get();
    const reversal = await reverseEntry(t.db, as("finance"), { entryId: july!.id, reason: "تصحيح تموز" }, NOW);
    expect((await t.db.select().from(journalEntries).where(eq(journalEntries.id, reversal.reversalId)).get())?.period).toBe("2026-11");
  });
});

describe("anomaly checks (10.10)", () => {
  test("a non-integer amount, a negative cash account and a matched line with a different amount are found; the books checks need cost.read", async () => {
    await t.db.insert(statementLines).values({ id: newId("stl"), source: "bank_card", occurredAt: NOW, amountIqd: 2.5 as unknown as number, dedupeHash: randomToken(16), createdAt: NOW });
    await postManualEntry(t.db, as("finance"), { date: "2026-11-10", memo: "سحب كبير", reason: "اختبار السالب", lines: [{ accountId: accountId("owner_equity"), debitIqd: 50_000_000 }, { accountId: accountId("cash"), creditIqd: 50_000_000 }], idempotencyKey: "anomaly-negative-cash" }, NOW);
    const report = await financeAnomalies(t.db, as("finance"), NOW);
    const check = (key: string) => report.checks.find((item) => item.check === key)!;
    expect(check("money.not_integer").findings.map((finding) => finding.entityType)).toContain("statement_lines");
    expect(check("accounts.wrong_side").findings).toEqual(expect.arrayContaining([expect.objectContaining({ entityId: accountId("cash"), severity: "critical" })]));
    expect(check("journal.trial_balance").status).toBe("ok");
    expect(check("wallet.ledger_vs_journal").status).toBe("ok");
    const noCost = await financeAnomalies(t.db, custom(["finance.anomaly.read"]), NOW);
    expect(noCost.checks.find((item) => item.check === "accounts.wrong_side")?.status).toBe("needs_cost");
    expect(noCost.checks.find((item) => item.check === "journal.trial_balance")?.status).toBe("needs_cost");
    expect(JSON.stringify(noCost.checks.filter((item) => item.status === "needs_cost"))).not.toMatch(/balanceIqd/);
  });

  test("expenses: a voided draft (never posted) and a voided posted expense (reversed) are sound; a posted expense without its entry is critical", async () => {
    const base = { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), incurredOn: "2026-11-10" };
    const draft = await createExpense(t.db, as("finance"), { ...base, amountIqd: 12_000, description: "مسودة ستُلغى", idempotencyKey: "anomaly-exp-draft" }, NOW);
    await voidExpense(t.db, as("finance"), { expenseId: draft.expenseId, reason: "سُجّل مرتين" }, NOW);
    const posted = await createExpense(t.db, as("finance"), { ...base, amountIqd: 13_000, description: "مصروف يُرحّل ثم يُلغى", idempotencyKey: "anomaly-exp-posted" }, NOW);
    await approveExpense(t.db, as("finance"), { expenseId: posted.expenseId }, NOW);
    await voidExpense(t.db, as("finance"), { expenseId: posted.expenseId, reason: "أُعيدت الفاتورة" }, NOW);
    const broken = await createExpense(t.db, as("finance"), { ...base, amountIqd: 14_000, description: "مرحّل بلا قيد", idempotencyKey: "anomaly-exp-broken" }, NOW);
    await t.db.update(expenses).set({ status: "posted" }).where(eq(expenses.id, broken.expenseId));

    const report = await financeAnomalies(t.db, as("finance"), NOW);
    const flagged = report.checks.find((item) => item.check === "expenses.entry_missing")!.findings.map((finding) => finding.entityId);
    expect(flagged).toContain(broken.expenseId);
    expect(flagged).not.toContain(draft.expenseId);
    expect(flagged).not.toContain(posted.expenseId);
  });
});

// ───────────────────────────────────────────────────────────────── routes behind a real session

describe("route loaders", () => {
  function request(): { ctx: RequestCtx; setCookies: string[] } {
    const setCookies: string[] = [];
    const ctx: RequestCtx = {
      requestId: `finance-${randomToken(6)}`,
      nonce: "n",
      origin: "http://localhost:5173",
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
      setCookie: (serialized) => {
        setCookies.push(serialized);
      },
    };
    return { ctx, setCookies };
  }
  function cookieOf(setCookies: string[]): string {
    const jar = new Map<string, string>();
    for (const serialized of setCookies) {
      const [pair] = serialized.split("; ");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  async function signedIn(roleKey: DefaultRoleKey | Permission[]): Promise<string> {
    const password = "finance-staff-password-1";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("fin")}@finance.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    if (Array.isArray(roleKey)) {
      const customRole = newId("rol");
      await t.db.insert(roles).values({ id: customRole, key: `fin_${make.next("r")}`, name: { ar: "دور مالي", en: "Finance custom" }, createdAt: NOW });
      await t.db.insert(rolePermissions).values(roleKey.map((permission) => ({ roleId: customRole, permission })));
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: customRole });
    } else {
      await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(roleKey) });
    }
    const signIn = request();
    const result = await signInEmployee(signIn.ctx, t.db, { email, password });
    if (result.status !== "signed_in") throw new Error("sign-in failed");
    return cookieOf(signIn.setCookies);
  }
  async function call<T>(cookie: string, path: string, run: (args: { request: Request; context: RouterContextProvider; params: Record<string, string>; url: URL; pattern: string }) => Promise<T>): Promise<unknown> {
    const req = new Request(`http://localhost:5173${path}`, { headers: { cookie } });
    const context = new RouterContextProvider();
    try {
      let out: unknown;
      await requestContextMiddleware({ request: req, context, url: new URL(req.url), pattern: "/", params: {} }, async () => {
        out = await run({ request: req, context, params: {}, url: new URL(req.url), pattern: path });
        return new Response(null);
      });
      return out;
    } catch (error) {
      return error;
    }
  }
  const status = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

  test("a cashier is refused the module; finance opens it; a report-only role cannot open the books or their export", async () => {
    const cashier = await signedIn("cashier");
    expect(status(await call(cashier, "/admin/finance", (args) => financeIndexLoader(args as never)))).toBe(403);
    const finance = await signedIn("finance");
    const home = (await call(finance, "/admin/finance", (args) => financeIndexLoader(args as never))) as { overview: { access: { books: boolean } } };
    expect(home.overview.access.books).toBe(true);
    const reportOnly = await signedIn(["finance.report.read", "finance.journal.read"]);
    expect(status(await call(reportOnly, "/admin/finance/journal", (args) => journalLoader(args as never)))).toBe(403);
    expect(status(await call(reportOnly, "/admin/finance/accounts", (args) => accountsLoader(args as never)))).toBe(403);
    expect(status(await call(reportOnly, "/admin/finance/journal/export", (args) => journalExportLoader(args as never)))).toBe(403);
    const csv = (await call(reportOnly, "/admin/finance/reports/export?period=2026-11", (args) => reportsExportLoader(args as never))) as Response;
    const text = await csv.text();
    expect(text).toContain("صافي الإيراد");
    expect(text).not.toMatch(/تكلفة البضاعة المباعة|مجمل الربح|صافي الربح/);
    const financeCsv = (await call(finance, "/admin/finance/reports/export?period=2026-11", (args) => reportsExportLoader(args as never))) as Response;
    expect(await financeCsv.text()).toMatch(/تكلفة البضاعة المباعة/);
    expect(status(await call(cashier, "/admin/finance/wallets", (args) => walletsLoader(args as never)))).toBe(403);
    const wallets = await call(finance, "/admin/finance/wallets?tab=ledger", (args) => walletsLoader(args as never));
    expect(JSON.stringify(wallets)).not.toMatch(/\+9647\d{9}/);
  });

  test("the P&L of a report-only employee carries no cost in its data", async () => {
    const pl = await profitAndLoss(t.db, custom(["finance.report.read"]), { from: novRange().fromMs, to: novRange().toMs });
    expect(pl.cost).toBeNull();
    expect(Object.keys(pl)).toContain("cost");
    void sql;
  });
});
