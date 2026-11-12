/**
 * The account's points, membership and referral page, its gift-card redemption and its privacy-request form
 * (2026-11-12, commerce core): account/rewards.server, account/giftcards.server, account/privacy.server — module 08's
 * and module 07's services for the customer's own account, rate-limited. Real local D1.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { newId, randomToken } from "~/lib/ids";
import type { CustomerActor } from "~/server/actor";
import { giftCards, loyaltyLedger, membershipTiers, memberships, privacyRequests, walletLedger } from "~/server/db/schema";
import { toAppError, type AppError } from "~/server/errors";
import { checkOwnGiftCard, GIFT_ATTEMPTS, redeemOwnGiftCard } from "~/server/services/account/giftcards.server";
import { fileOwnPrivacyRequest, listOwnPrivacyRequests, PRIVACY_FILINGS } from "~/server/services/account/privacy.server";
import { getRewards, issueOwnReferralCode } from "~/server/services/account/rewards.server";
import { giftCodeHash } from "~/server/services/admin/promotions/giftcards.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures } from "./helpers/factories";

const NOW = TEST_NOW;
const DAY = 24 * 60 * 60 * 1000;

let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db);
});
afterAll(async () => {
  await t.dispose();
});

const me = (id: string, ip: string | null = null): CustomerActor => ({ kind: "customer", id, ip });

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

async function points(customerId: string, value: number, extra: { kind?: "earn" | "redeem" | "adjust" | "reversal"; refType?: string; refId?: string | null; expiresAt?: number | null; at?: number } = {}) {
  await t.db.insert(loyaltyLedger).values({
    id: newId("lyl"),
    customerId,
    points: value,
    kind: extra.kind ?? (value > 0 ? "earn" : "redeem"),
    refType: extra.refType ?? "test",
    refId: extra.refId ?? null,
    reason: "test",
    expiresAt: extra.expiresAt === undefined ? (value > 0 ? NOW + 300 * DAY : null) : extra.expiresAt,
    actorKind: "system",
    actorId: "test",
    idempotencyKey: `test:${randomToken()}`,
    at: extra.at ?? NOW - DAY,
  });
}

describe("points, membership and the referral code", () => {
  test("the balance, its worth, what expires within 30 days (oldest first), the history with the customer's own order references", async () => {
    const customerId = await make.customer();
    const other = await make.customer();
    const product = await make.product({ priceIqd: 30_000, stock: 5 });
    const own = await make.order([{ ...product, qty: 1 }], { customerId });
    const foreign = await make.order([{ ...product, qty: 1 }], { customerId: other });
    const ownRef = own.ref;
    await points(customerId, 300, { refType: "order", refId: own.orderId, expiresAt: NOW + 10 * DAY, at: NOW - 3 * DAY });
    await points(customerId, 500, { refType: "order", refId: foreign.orderId, expiresAt: NOW + 200 * DAY, at: NOW - 2 * DAY });
    await points(customerId, -100, { kind: "redeem", refType: "order", refId: own.orderId, at: NOW - DAY });

    const view = await getRewards(t.db, customerId, "en", NOW);
    expect(view.points).toMatchObject({ balance: 700, pointValueIqd: 10, valueIqd: 7_000, expiringSoon: 200, nextExpiryAt: NOW + 10 * DAY, expiryDays: 365 });
    expect(view.points.entries.map((entry) => [entry.kind, entry.points, entry.orderRef])).toEqual([
      ["redeem", -100, ownRef],
      // someone else's order is never named
      ["earn", 500, null],
      ["earn", 300, ownRef],
    ]);
    expect(view.membership).toBeNull();
    expect(view.referral).toBeNull();
    expect(view.referralRewardPoints).toBeGreaterThan(0);
    // another customer's page shows none of it
    expect((await getRewards(t.db, other, "en", NOW)).points).toMatchObject({ balance: 0, expiringSoon: 0, entries: [] });
  });

  test("the next expiry follows the FIFO rule: points spent used the oldest credits, and points given back carry their own date", async () => {
    const customerId = await make.customer();
    await points(customerId, 1_000, { expiresAt: NOW + 20 * DAY, at: NOW - 5 * DAY });
    await points(customerId, -1_000, { kind: "redeem", at: NOW - 4 * DAY });
    // a cancelled order's redemption given back, with a fresh expiry
    await points(customerId, 1_000, { kind: "reversal", refType: "redeem", expiresAt: NOW + 365 * DAY, at: NOW - 3 * DAY });
    const view = await getRewards(t.db, customerId, "en", NOW);
    // nothing really expires in 20 days: those 1,000 were the ones spent
    expect(view.points).toMatchObject({ balance: 1_000, expiringSoon: 0, nextExpiryAt: NOW + 365 * DAY });
    expect(view.points.entries[0]).toMatchObject({ kind: "reversal", refType: "redeem", points: 1_000 });
  });

  test("a membership shows what the checkout applies: the tier's discount within the store's limits, free delivery, the multiplier", async () => {
    const customerId = await make.customer();
    const tierId = newId("mtr");
    await t.db.insert(membershipTiers).values({ id: tierId, key: `vip-${tierId}`, name: { ar: "كبار الزبائن", en: "VIP" }, benefits: { discountBps: 3_000, freeShipping: true, pointsMultiplierBps: 15_000 }, isActive: true });
    await t.db.insert(memberships).values({ id: newId("mbr"), customerId, tierId, status: "active", startsAt: NOW - DAY, endsAt: NOW + 60 * DAY, source: "grant", createdAt: NOW - DAY });
    const view = await getRewards(t.db, customerId, "en", NOW);
    // 30% written on the tier, 20% applied (the store's limit while no second person approves a tier's discount)
    expect(view.membership).toEqual({ tier: "VIP", endsAt: NOW + 60 * DAY, discountBps: 3_000, appliedBps: 2_000, perOrderIqd: 50_000, freeShipping: true, multiplierBps: 15_000 });
    expect((await getRewards(t.db, customerId, "ar", NOW)).membership?.tier).toBe("كبار الزبائن");
    // an ended membership is not shown
    expect((await getRewards(t.db, customerId, "en", NOW + 61 * DAY)).membership).toBeNull();
  });

  test("a customer gets their own referral code once (asking again returns it), and the page shows its uses", async () => {
    const customerId = await make.customer();
    const first = await issueOwnReferralCode(t.db, me(customerId), NOW);
    expect(first.code).toMatch(/^[A-Z0-9-]{4,}$/);
    const again = await issueOwnReferralCode(t.db, me(customerId), NOW);
    expect(again.code).toBe(first.code);
    expect((await getRewards(t.db, customerId, "en", NOW)).referral).toMatchObject({ code: first.code, uses: 0, active: true });
  });
});

describe("a gift card into the customer's own wallet", () => {
  async function card(amountIqd: number, extra: { status?: "active" | "redeemed" | "void"; expiresAt?: number | null; isDemo?: boolean } = {}) {
    const code = `GIFT-${randomToken().replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase().padEnd(4, "X")}-2345-6789`;
    await t.db.insert(giftCards).values({ id: newId("gfc"), codeHash: await giftCodeHash(code), codeHint: "6789", amountIqd, status: extra.status ?? "active", expiresAt: extra.expiresAt ?? null, isDemo: extra.isDemo ?? false, createdAt: NOW - DAY });
    return code;
  }

  test("checked first (its amount, nothing changes), then redeemed once; the same form again answers its first result", async () => {
    const customerId = await make.customer();
    const code = await card(25_000, { expiresAt: NOW + 90 * DAY });
    // typed loosely: lower case, spaces
    const checked = await checkOwnGiftCard(t.db, me(customerId), { code: ` ${code.toLowerCase().replace(/-/g, " ")} ` }, NOW);
    expect(checked).toMatchObject({ amountIqd: 25_000, expiresAt: NOW + 90 * DAY });
    expect(await getWalletBalance(t.db, customerId)).toBe(0);

    const key = `tku_${randomToken()}`;
    expect(await redeemOwnGiftCard(t.db, me(customerId), { code, idempotencyKey: key }, NOW)).toEqual({ amountIqd: 25_000, replayed: false });
    expect(await redeemOwnGiftCard(t.db, me(customerId), { code, idempotencyKey: key }, NOW)).toEqual({ amountIqd: 25_000, replayed: true });
    expect(await getWalletBalance(t.db, customerId)).toBe(25_000);
    expect(await t.db.select().from(walletLedger).where(eq(walletLedger.customerId, customerId))).toHaveLength(1);
    expect((await failureOf(redeemOwnGiftCard(t.db, me(customerId), { code, idempotencyKey: `tku_${randomToken()}` }, NOW))).code).toBe("gift_card_used");
  });

  test("an unknown, void, expired or demo card is refused in the customer's words; a missing code or key is a field error", async () => {
    const customerId = await make.customer();
    expect((await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" }, NOW))).code).toBe("gift_card_unknown");
    expect((await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: await card(5_000, { status: "void" }) }, NOW))).code).toBe("gift_card_void");
    expect((await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: await card(5_000, { expiresAt: NOW - DAY }) }, NOW))).code).toBe("gift_card_expired");
    expect((await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: await card(5_000, { isDemo: true }) }, NOW))).code).toBe("gift_card_demo_mismatch");
    expect((await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: "" }, NOW))).fields).toEqual({ code: "required" });
    expect((await failureOf(redeemOwnGiftCard(t.db, me(customerId), { code: await card(5_000) }, NOW))).fields).toEqual({ code: "invalid" });
  });

  test("checks and redemptions are counted per customer and per network address, so a code cannot be guessed", async () => {
    const customerId = await make.customer();
    for (let i = 0; i < GIFT_ATTEMPTS.limit; i += 1) await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: `NOPE-NOPE-NOPE-${String(1000 + i)}` }, NOW));
    expect((await failureOf(checkOwnGiftCard(t.db, me(customerId), { code: await card(5_000) }, NOW))).code).toBe("rate_limited");
    // the same address, another account: the address's own count stops it too
    const ip = "198.51.100.23";
    const first = await make.customer();
    for (let i = 0; i < GIFT_ATTEMPTS.limit; i += 1) await failureOf(checkOwnGiftCard(t.db, me(first, ip), { code: `MISS-MISS-MISS-${String(1000 + i)}` }, NOW));
    expect((await failureOf(checkOwnGiftCard(t.db, me(await make.customer(), ip), { code: await card(5_000) }, NOW))).code).toBe("rate_limited");
  });
});

describe("the privacy-request form", () => {
  test("a copy, a correction or a deletion of the customer's own account: filed for staff to verify; one open request per kind; the same form twice is one request", async () => {
    const customerId = await make.customer();
    const attempt = `prv_${randomToken()}`;
    const filed = await fileOwnPrivacyRequest(t.db, me(customerId), { kind: "export", details: "", attempt }, NOW);
    expect(filed.replayed).toBe(false);
    expect(await fileOwnPrivacyRequest(t.db, me(customerId), { kind: "export", details: "", attempt }, NOW)).toEqual({ ref: filed.ref, replayed: true });
    expect((await failureOf(fileOwnPrivacyRequest(t.db, me(customerId), { kind: "export", details: "", attempt: `prv_${randomToken()}` }, NOW))).code).toBe("privacy_open_exists");

    const row = await t.db.select().from(privacyRequests).where(eq(privacyRequests.ref, filed.ref)).get();
    // nothing happens by itself: the request waits for a person to confirm who is asking
    expect(row).toMatchObject({ customerId, kind: "export", status: "open", verifiedAt: null });
    expect((await listOwnPrivacyRequests(t.db, customerId)).map((request) => [request.ref, request.kind, request.status])).toEqual([[filed.ref, "export", "open"]]);
    expect(await listOwnPrivacyRequests(t.db, await make.customer())).toEqual([]);
  });

  test("a correction says what to correct; an unsubscribe is not filed here; the form is rate-limited", async () => {
    const customerId = await make.customer();
    expect((await failureOf(fileOwnPrivacyRequest(t.db, me(customerId), { kind: "rectify", details: " ", attempt: `prv_${randomToken()}` }, NOW))).fields).toEqual({ details: "required" });
    expect((await failureOf(fileOwnPrivacyRequest(t.db, me(customerId), { kind: "unsubscribe", details: "", attempt: `prv_${randomToken()}` }, NOW))).fields).toHaveProperty("kind");
    const rectified = await fileOwnPrivacyRequest(t.db, me(customerId), { kind: "rectify", details: "اسمي مكتوب خطأ", attempt: `prv_${randomToken()}` }, NOW);
    expect((await t.db.select().from(privacyRequests).where(eq(privacyRequests.ref, rectified.ref)).get())?.kind).toBe("rectify");

    // every filing that passes the fields counts (a refused duplicate too)
    const busy = await make.customer();
    for (let i = 0; i < PRIVACY_FILINGS.limit; i += 1) await fileOwnPrivacyRequest(t.db, me(busy), { kind: "export", details: "", attempt: `prv_${randomToken()}` }, NOW).catch(() => null);
    expect((await failureOf(fileOwnPrivacyRequest(t.db, me(busy), { kind: "delete", details: "", attempt: `prv_${randomToken()}` }, NOW))).code).toBe("rate_limited");
  });
});
