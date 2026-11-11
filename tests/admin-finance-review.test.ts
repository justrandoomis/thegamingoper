/**
 * Admin module 10 "finance" — the adversarial review (2026-11-11). Each test below failed on the builder's code and
 * guards the fix that followed it:
 *
 *   · a closed month is final: nothing may be dated on or before the last closed month (a manual entry or an expense
 *     dated into an earlier month that was still open changed the closed month's closing balances)
 *   · an account that holds postings keeps its family: moving it under another system account would re-write closed
 *     months' statements (marketing → cost of goods) or the wallet liability, which only the wallet ledger may move
 *   · four eyes cannot be split: top-ups approved by one person for one customer, and expenses an employee recorded
 *     and approved alone, count together over 24 hours against the limit (also when two tabs approve at once)
 *   · a manual entry's key reused with other content is refused, never answered with the first entry
 *   · account, cost-centre and tax codes typed with Arabic-Indic or Persian digits are read as digits
 *   · a request with an unknown intent is a 400, not a server error
 */
import { eq } from "drizzle-orm";
import { deflateSync } from "node:zlib";
import { RouterContextProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import { action as expenseAction } from "~/routes/admin/finance/expense";
import { action as expenseNewAction } from "~/routes/admin/finance/expense-new";
import { action as walletsAction } from "~/routes/admin/finance/wallets";
import { action as statementLineAction } from "~/routes/admin/finance/statement-line";
import type { CustomerActor, EmployeeActor } from "~/server/actor";
import { signInEmployee } from "~/server/auth/admin.server";
import { seedRoles } from "~/server/auth/seed-roles";
import { requestContextMiddleware, type RequestCtx } from "~/server/context.server";
import { hashPassword } from "~/server/crypto.server";
import { accounts, approvals, employeeRoles, expenses, files, statementLines } from "~/server/db/schema";
import { accountId } from "~/server/db/seed/reference";
import { toAppError, type AppError } from "~/server/errors";
import { defaultRolePermissions, roleId, type DefaultRoleKey } from "~/server/permissions";
import { approveExpense, createExpense } from "~/server/services/accounting/expenses.server";
import { profitAndLoss, trialBalance } from "~/server/services/accounting/reports.server";
import { requestWalletTopup, saveTopupProof } from "~/server/services/account/topups.server";
import { closePeriod } from "~/server/services/admin/finance/close.server";
import { countDecidableExpenses, getExpense, saveCostCenter } from "~/server/services/admin/finance/expense-views.server";
import { postManualEntry, saveAccount } from "~/server/services/admin/finance/ledger.server";
import { financeOverview } from "~/server/services/admin/finance/overview.server";
import { saveTaxRate } from "~/server/services/admin/finance/tax.server";
import { parseRange } from "~/server/services/admin/finance/types";
import { decideTopup, getTopupReview, requestWalletAdjustment, TOPUP_SECOND_APPROVAL_ABOVE_IQD, walletOverview } from "~/server/services/admin/finance/wallets.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { kvBlobStore } from "~/server/storage.server";
import { createTestDb, TEST_NOW, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const HOUR = 60 * 60 * 1000;
const novRange = () => parseRange(new URLSearchParams("period=2026-11"), NOW);

let t: TestDb;
let make: Fixtures;
const staff: Partial<Record<"owner" | "financeA" | "financeB", EmployeeActor>> = {};

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
  await seedRoles(t.db, NOW);
  staff.owner = await employee("owner");
  staff.financeA = await employee("finance");
  staff.financeB = await employee("finance");
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

const lines = (debitAccount: string, creditAccount: string, amount: number) => [
  { accountId: debitAccount, debitIqd: amount },
  { accountId: creditAccount, creditIqd: amount },
];

// ───────────────────────────────────────────────────────────────── a closed month is final

describe("a closed month is final, earlier months included", () => {
  test("after October is closed, nothing can be dated into September (an open month before it)", async () => {
    // a draft expense of late September, recorded before the close
    const draft = await createExpense(t.db, as("financeA"), { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), amountIqd: 7_000, description: "إيجار مخزن أيلول", incurredOn: "2026-09-28", idempotencyKey: "review-sept-draft" }, NOW);
    await postManualEntry(t.db, as("financeA"), { date: "2026-10-15", memo: "مصروف تشرين الأول", reason: "اختبار الإغلاق", lines: lines(accountId("operating_expenses"), accountId("cash"), 5_000), idempotencyKey: "review-october" }, NOW);
    // September holds nothing, so October may be closed
    expect(await closePeriod(t.db, as("financeA"), { period: "2026-10", reason: "راجعنا كشوف تشرين الأول" }, NOW)).toEqual({ replayed: false });
    const endOfOctober = Date.UTC(2026, 10, 1) - 3 * HOUR;
    const before = await trialBalance(t.db, as("financeA"), { to: endOfOctober });

    expect(await failureOf(postManualEntry(t.db, as("financeA"), { date: "2026-09-20", memo: "قيد متأخر", reason: "تصحيح", lines: lines(accountId("operating_expenses"), accountId("cash"), 9_000), idempotencyKey: "review-september-late" }, NOW))).toMatchObject({ code: "period_closed", status: 409 });
    expect(await failureOf(createExpense(t.db, as("financeA"), { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), amountIqd: 4_000, description: "مصروف أيلول المتأخر", incurredOn: "2026-09-25", idempotencyKey: "review-sept-new" }, NOW))).toMatchObject({ code: "period_closed" });
    expect(await failureOf(approveExpense(t.db, as("financeB"), { expenseId: draft.expenseId }, NOW))).toMatchObject({ code: "period_closed" });

    // October's closing balances are what they were when it was closed
    const after = await trialBalance(t.db, as("financeA"), { to: endOfOctober });
    expect(after.rows.map((row) => [row.account.id, row.balanceDebit, row.balanceCredit])).toEqual(before.rows.map((row) => [row.account.id, row.balanceDebit, row.balanceCredit]));
    // November is open
    await expect(postManualEntry(t.db, as("financeA"), { date: "2026-11-02", memo: "قيد تشرين الثاني", reason: "تسوية", lines: lines(accountId("operating_expenses"), accountId("cash"), 1_000), idempotencyKey: "review-november" }, NOW)).resolves.toMatchObject({ replayed: false });
  });
});

// ───────────────────────────────────────────────────────────────── accounts keep their family

describe("an account that holds postings keeps its family", () => {
  test("moving a marketing sub-account with postings under cost of goods is refused; the P&L does not change", async () => {
    const owner = as("owner");
    const ads = await saveAccount(t.db, owner, { code: "6455", nameAr: "إعلانات إنستغرام", type: "expense", parentId: accountId("marketing"), isActive: true, reason: "تفصيل التسويق" }, NOW);
    await postManualEntry(t.db, as("financeA"), { date: "2026-11-09", memo: "حملة إنستغرام", reason: "فاتورة الحملة", lines: lines(ads.accountId, accountId("cash"), 40_000), idempotencyKey: "review-ads" }, NOW);
    const scope = { from: novRange().fromMs, to: novRange().toMs };
    const cogsBefore = (await profitAndLoss(t.db, owner, scope)).cost?.cogsIqd;

    expect(await failureOf(saveAccount(t.db, owner, { id: ads.accountId, code: "6455", nameAr: "إعلانات إنستغرام", parentId: accountId("cogs"), isActive: true, reason: "نقل" }, NOW))).toMatchObject({ code: "account_family_locked", status: 409 });
    expect((await profitAndLoss(t.db, owner, scope)).cost?.cogsIqd).toBe(cogsBefore);
    expect((await t.db.select().from(accounts).where(eq(accounts.id, ads.accountId)).get())?.parentId).toBe(accountId("marketing"));

    // inside its family it may move, and an account without postings may go anywhere of its type
    const social = await saveAccount(t.db, owner, { code: "6460", nameAr: "تواصل اجتماعي", type: "expense", parentId: accountId("marketing"), isActive: true, reason: "تجميع" }, NOW);
    await expect(saveAccount(t.db, owner, { id: ads.accountId, code: "6455", nameAr: "إعلانات إنستغرام", parentId: social.accountId, isActive: true, reason: "تحت التواصل" }, NOW)).resolves.toMatchObject({ created: false });
    const empty = await saveAccount(t.db, owner, { code: "6465", nameAr: "حساب بلا حركة", type: "expense", parentId: accountId("marketing"), isActive: true, reason: "تجربة" }, NOW);
    await expect(saveAccount(t.db, owner, { id: empty.accountId, code: "6465", nameAr: "حساب بلا حركة", parentId: accountId("payroll"), isActive: true, reason: "مكانه الرواتب" }, NOW)).resolves.toMatchObject({ created: false });
  });

  test("a liability holding money cannot be moved under the wallet liability (only the wallet ledger moves it)", async () => {
    const owner = as("owner");
    const deposits = await saveAccount(t.db, owner, { code: "2190", nameAr: "أمانات", type: "liability", isActive: true, reason: "أمانات العملاء" }, NOW);
    await postManualEntry(t.db, as("financeA"), { date: "2026-11-09", memo: "أمانة نقدية", reason: "إيداع أمانة", lines: lines(accountId("cash"), deposits.accountId, 1_000_000), idempotencyKey: "review-deposit" }, NOW);
    expect((await walletOverview(t.db, as("financeA"), novRange())).differenceIqd).toBe(0);
    expect(await failureOf(saveAccount(t.db, owner, { id: deposits.accountId, code: "2190", nameAr: "أمانات", parentId: accountId("wallet_liability"), isActive: true, reason: "نقل" }, NOW))).toMatchObject({ code: "account_family_locked" });
    expect((await walletOverview(t.db, as("financeA"), novRange())).differenceIqd).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── four eyes cannot be split

/** A tiny valid PNG (the upload pipeline checks the real bytes). */
function png(tone: number): Uint8Array {
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
  const [width, height] = [40, 30];
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

let tone = 20;
async function topupRequest(customerId: string, amount: number): Promise<string> {
  const shopper: CustomerActor = { kind: "customer", id: customerId };
  const proof = await saveTopupProof(t.db, kvBlobStore(t.kv), shopper, new Blob([png((tone += 7) % 250) as Uint8Array<ArrayBuffer>], { type: "image/png" }), NOW);
  const { topup } = await requestWalletTopup(t.db, shopper, { method: "bank_transfer", declaredAmountIqd: amount, reference: `RV-${randomToken(4)}`, fileId: proof.fileId, idempotencyKey: randomToken(12) }, NOW);
  return topup.id;
}

describe("four eyes cannot be split into small decisions", () => {
  test("top-ups one person approves alone for one customer count together over 24 hours", async () => {
    const customerId = await make.customer();
    const part = 300_000;
    expect(part * 2).toBeGreaterThan(TOPUP_SECOND_APPROVAL_ABOVE_IQD);
    const first = await topupRequest(customerId, part);
    const second = await topupRequest(customerId, part);
    expect(await decideTopup(t.db, as("financeA"), { topupId: first, decision: "approve" }, NOW)).toMatchObject({ status: "approved" });
    const review = await getTopupReview(t.db, as("financeA"), second, (id) => `/proof/${id}`, NOW);
    expect(review.needsTwo).toBe(true);
    // the same person, the same day, the same customer: a first approval only
    expect(await decideTopup(t.db, as("financeA"), { topupId: second, decision: "approve" }, NOW + HOUR)).toMatchObject({ status: "awaiting_second" });
    expect(await getWalletBalance(t.db, customerId)).toBe(part);
    expect(await decideTopup(t.db, as("financeB"), { topupId: second, decision: "approve" }, NOW + HOUR)).toMatchObject({ status: "approved" });
    expect(await getWalletBalance(t.db, customerId)).toBe(part * 2);
    // a day later the same person decides alone again
    const third = await topupRequest(customerId, part);
    expect(await decideTopup(t.db, as("financeA"), { topupId: third, decision: "approve" }, NOW + 25 * HOUR)).toMatchObject({ status: "approved" });
  });

  test("two tabs approving two small top-ups of one customer at once: one is approved, the other waits for a second person", async () => {
    const customerId = await make.customer();
    const [a, b] = [await topupRequest(customerId, 300_000), await topupRequest(customerId, 300_000)];
    const results = await Promise.all([decideTopup(t.db, as("financeA"), { topupId: a, decision: "approve" }, NOW), decideTopup(t.db, as("financeA"), { topupId: b, decision: "approve" }, NOW)]);
    expect(results.map((result) => result.status).sort()).toEqual(["approved", "awaiting_second"]);
    expect(await getWalletBalance(t.db, customerId)).toBe(300_000);
  });

  test("expenses an employee records and approves alone count together over 24 hours", async () => {
    const base = { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), incurredOn: "2026-11-09" };
    const one = await createExpense(t.db, as("financeA"), { ...base, amountIqd: 300_000, description: "صيانة المولدة", idempotencyKey: "review-split-1" }, NOW);
    const two = await createExpense(t.db, as("financeA"), { ...base, amountIqd: 300_000, description: "صيانة المولدة ج2", idempotencyKey: "review-split-2" }, NOW);
    expect(await approveExpense(t.db, as("financeA"), { expenseId: one.expenseId }, NOW)).toMatchObject({ status: "posted", replayed: false });
    const view = await getExpense(t.db, as("financeA"), two.expenseId, "ar", NOW);
    expect(view).toMatchObject({ needsOther: true, canApprove: false });
    const queueBefore = await countDecidableExpenses(t.db, as("financeA"), NOW);
    expect(await failureOf(approveExpense(t.db, as("financeA"), { expenseId: two.expenseId }, NOW + HOUR))).toMatchObject({ code: "expense_self_approval", status: 403 });
    expect((await t.db.select().from(expenses).where(eq(expenses.id, two.expenseId)).get())?.status).toBe("draft");
    expect(await countDecidableExpenses(t.db, as("financeB"), NOW)).toBeGreaterThan(queueBefore ?? 0);
    expect(await approveExpense(t.db, as("financeB"), { expenseId: two.expenseId }, NOW + HOUR)).toMatchObject({ status: "posted" });
  });

  test("two tabs self-approving two small expenses at once: only one is posted", async () => {
    const base = { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), incurredOn: "2026-11-09" };
    const financeC = await employee("finance");
    const one = await createExpense(t.db, financeC, { ...base, amountIqd: 400_000, description: "قطع غيار", idempotencyKey: "review-race-1" }, NOW);
    const two = await createExpense(t.db, financeC, { ...base, amountIqd: 400_000, description: "قطع غيار ج2", idempotencyKey: "review-race-2" }, NOW);
    const results = await Promise.allSettled([approveExpense(t.db, financeC, { expenseId: one.expenseId }, NOW), approveExpense(t.db, financeC, { expenseId: two.expenseId }, NOW)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(toAppError(rejected.reason)).toMatchObject({ code: "expense_self_approval" });
  });
});

// ───────────────────────────────────────────────────────────────── field permissions

describe("field permissions on the module's home", () => {
  test("cash and bank balances are books: a report-only role gets no balance (null, never 0); finance gets them", async () => {
    const reportOnly: EmployeeActor = { kind: "employee", id: newId("emp"), permissions: new Set(["finance.report.read"]) };
    const home = await financeOverview(t.db, reportOnly, NOW);
    expect(home.revenue).not.toBeNull();
    expect(home.cash).toBeNull();
    expect(JSON.stringify(home)).not.toMatch(/cashIqd|bankIqd/);
    expect((await financeOverview(t.db, as("financeA"), NOW)).cash).toMatchObject({ cashIqd: expect.any(Number), bankIqd: expect.any(Number) });
  });
});

// ───────────────────────────────────────────────────────────────── idempotency and digits

describe("idempotency keys and typed digits", () => {
  test("a manual entry key reused with other content is refused (not answered with the first entry)", async () => {
    const first = await postManualEntry(t.db, as("financeA"), { date: "2026-11-09", memo: "مصروف نثري", reason: "شاي وقهوة", lines: lines(accountId("operating_expenses"), accountId("cash"), 12_000), idempotencyKey: "review-reused-key" }, NOW);
    expect(await postManualEntry(t.db, as("financeA"), { date: "2026-11-09", memo: "مصروف نثري", reason: "شاي وقهوة", lines: lines(accountId("operating_expenses"), accountId("cash"), 12_000), idempotencyKey: "review-reused-key" }, NOW)).toEqual({ entryId: first.entryId, replayed: true });
    expect(await failureOf(postManualEntry(t.db, as("financeA"), { date: "2026-11-09", memo: "شيء آخر", reason: "قيد مختلف", lines: lines(accountId("marketing"), accountId("bank_clearing"), 50_000), idempotencyKey: "review-reused-key" }, NOW))).toMatchObject({ code: "idempotency_mismatch", status: 409 });
  });

  test("codes typed with Arabic-Indic or Persian digits are read as digits", async () => {
    const created = await saveAccount(t.db, as("owner"), { code: "٦٤٧٠", nameAr: "مطبوعات", type: "expense", parentId: accountId("marketing"), isActive: true, reason: "حساب جديد" }, NOW);
    expect((await t.db.select().from(accounts).where(eq(accounts.id, created.accountId)).get())?.code).toBe("6470");
    const center = await saveCostCenter(t.db, as("financeA"), { code: "br-۲", nameAr: "الفرع الثاني", isActive: true }, NOW);
    expect(center.id).toBe("cc_br_2");
    const rate = await saveTaxRate(t.db, as("financeA"), { code: "vat-١٥", nameAr: "ضريبة", rateBps: 0, isActive: false, reason: "إعداد" }, NOW);
    expect(rate.id).toBe("tax_vat-15");
  });
});

// ───────────────────────────────────────────────────────────────── routes: unknown intents

describe("route actions", () => {
  function request(): { ctx: RequestCtx; setCookies: string[] } {
    const setCookies: string[] = [];
    const ctx: RequestCtx = {
      requestId: `finance-review-${randomToken(6)}`,
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
  async function signedIn(roleKey: DefaultRoleKey): Promise<string> {
    const password = "finance-review-password-1";
    const hashed = await hashPassword(password, 1000);
    const email = `${make.next("rev")}@finance.test`;
    const id = await make.employee({ email, passwordHash: hashed.hash, passwordIters: hashed.iterations });
    await t.db.insert(employeeRoles).values({ employeeId: id, roleId: roleId(roleKey) });
    const signIn = request();
    const result = await signInEmployee(signIn.ctx, t.db, { email, password });
    if (result.status !== "signed_in") throw new Error("sign-in failed");
    const jar = new Map<string, string>();
    for (const serialized of signIn.setCookies) {
      const [pair] = serialized.split("; ");
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }
  async function post(cookie: string, path: string, body: Record<string, string | File>, params: Record<string, string>, run: (args: { request: Request; context: RouterContextProvider; params: Record<string, string> }) => Promise<unknown>): Promise<unknown> {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) form.set(key, value);
    const req = new Request(`http://localhost:5173${path}`, { method: "POST", body: form, headers: { cookie, origin: "http://localhost:5173" } });
    const context = new RouterContextProvider();
    try {
      let out: unknown;
      await requestContextMiddleware({ request: req, context, url: new URL(req.url), pattern: "/", params }, async () => {
        out = await run({ request: req, context, params });
        return new Response(null);
      });
      return out;
    } catch (error) {
      return error;
    }
  }
  const status = (value: unknown) => (value as { init?: { status?: number } } | null)?.init?.status ?? (value instanceof Response ? value.status : 200);

  test("an unknown intent is refused with 400 on the expense and statement-line pages (not a server error)", async () => {
    const cookie = await signedIn("finance");
    const draft = await createExpense(t.db, as("financeA"), { accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), amountIqd: 1_000, description: "مصروف للاختبار", incurredOn: "2026-11-09", idempotencyKey: "review-intent" }, NOW);
    const onExpense = await post(cookie, `/admin/finance/expenses/${draft.expenseId}`, { intent: "delete", reason: "x x x" }, { expenseId: draft.expenseId }, (args) => expenseAction(args as never));
    expect(onExpense).not.toBeInstanceOf(Error);
    expect(status(onExpense)).toBe(400);
    const lineId = newId("stl");
    await t.db.insert(statementLines).values({ id: lineId, source: "bank_card", occurredAt: NOW, amountIqd: 5_000, dedupeHash: randomToken(16), createdAt: NOW });
    const onLine = await post(cookie, `/admin/finance/settlements/${lineId}`, { intent: "erase", reason: "x x x" }, { lineId }, (args) => statementLineAction(args as never));
    expect(onLine).not.toBeInstanceOf(Error);
    expect(status(onLine)).toBe(400);
    expect((await t.db.select().from(statementLines).where(eq(statementLines.id, lineId)).get())?.status).toBe("unmatched");
  });

  test("a malformed decision on a wallet adjustment is refused (400), never read as a rejection", async () => {
    const cookie = await signedIn("finance");
    const customerId = await make.customer();
    const { approvalId } = await requestWalletAdjustment(t.db, as("financeA"), { customerId, amountIqd: 9_000, reason: "تعويض عن تأخير الطلب", idempotencyKey: randomToken(12) }, NOW);
    const out = await post(cookie, "/admin/finance/wallets", { intent: "adjustment", approvalId, decision: "later", reason: "سأراجعه لاحقاً" }, {}, (args) => walletsAction(args as never));
    expect(out).not.toBeInstanceOf(Error);
    expect(status(out)).toBe(400);
    expect((await t.db.select().from(approvals).where(eq(approvals.id, approvalId)).get())?.status).toBe("pending");
  });

  test("an expense form with a mistake stores no receipt photo (no orphaned private files)", async () => {
    const cookie = await signedIn("finance");
    const receipts = async () => (await t.db.select({ id: files.id }).from(files).where(eq(files.kind, "expense_receipt"))).length;
    const before = await receipts();
    const photo = new File([png(77) as Uint8Array<ArrayBuffer>], "receipt.png", { type: "image/png" });
    const out = await post(
      cookie,
      "/admin/finance/expenses/new",
      { key: randomToken(12), accountId: accountId("operating_expenses"), paidFromAccountId: accountId("cash"), amountIqd: "12.5", description: "وقود المولدة", incurredOn: "2026-11-09", receipt: photo },
      {},
      (args) => expenseNewAction(args as never),
    );
    expect(out).not.toBeInstanceOf(Error);
    expect(status(out)).toBe(400);
    expect(await receipts()).toBe(before);
  });
});
