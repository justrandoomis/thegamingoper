/**
 * The checkout form's new fields (2026-11-12, commerce core): points to redeem (typed in any digits, never more than the
 * cart can take), the referral code, and «use my wallet» — the wallet part of a split payment, sent as `walletIqd` and
 * answered by the server under that name. Pure helpers of routes/storefront/checkout/checkout-form.ts.
 */
import { describe, expect, test } from "vitest";
import { draftFromPosted, draftToForm, EMPTY_DRAFT, issuesFromServer, parsePoints, PAYMENT_FIELDS, REVIEW_FIELDS, stepOfField, validateField, validateStep, type ValidationContext } from "~/routes/storefront/checkout/checkout-form";

const CONTEXT: ValidationContext = { districtIds: [], days: [], methods: ["cod", "wallet", "bank_transfer"], walletEnough: false, pointsMax: 500 };
const KEY = "k".repeat(22);

describe("checkout form — points, referral code, the wallet part", () => {
  test("points as typed: Latin or Arabic-Indic digits, separators allowed, empty is none; anything else is not a number", () => {
    expect(parsePoints("")).toBe(0);
    expect(parsePoints("  ")).toBe(0);
    expect(parsePoints(" 1,200 ")).toBe(1200);
    expect(parsePoints("١٢٠")).toBe(120);
    expect(parsePoints("۱۵۰")).toBe(150);
    expect(parsePoints("12.5")).toBeNull();
    expect(parsePoints("-5")).toBeNull();
    expect(parsePoints("ten")).toBeNull();
    expect(parsePoints("123456789")).toBeNull();
  });

  test("points above what the cart can take, or anything but a whole number, are named; the referral code has a length limit", () => {
    expect(validateField("redeemPoints", { ...EMPTY_DRAFT, redeemPoints: "300" }, CONTEXT)).toBeNull();
    expect(validateField("redeemPoints", { ...EMPTY_DRAFT, redeemPoints: "501" }, CONTEXT)).toEqual({ code: "too_many", count: 500 });
    expect(validateField("redeemPoints", { ...EMPTY_DRAFT, redeemPoints: "x" }, CONTEXT)).toEqual({ code: "invalid" });
    // a guest or an empty balance: nothing to redeem (an older caller without pointsMax counts as none)
    expect(validateField("redeemPoints", { ...EMPTY_DRAFT, redeemPoints: "1" }, { ...CONTEXT, pointsMax: undefined })).toEqual({ code: "too_many", count: 0 });
    expect(validateField("referralCode", { ...EMPTY_DRAFT, referralCode: "A".repeat(41) }, CONTEXT)).toEqual({ code: "too_long", count: 40 });
    expect(validateField("useWallet", { ...EMPTY_DRAFT, useWallet: true }, CONTEXT)).toBeNull();
    // the fields live on their steps: points and the wallet box on payment, the code on review
    expect(PAYMENT_FIELDS).toEqual(["paymentMethod", "useWallet", "redeemPoints"]);
    expect(REVIEW_FIELDS).toEqual(["referralCode"]);
    expect(stepOfField("redeemPoints")).toBe("payment");
    expect(stepOfField("referralCode")).toBe("review");
    expect(validateStep("payment", { ...EMPTY_DRAFT, paymentMethod: "cod", redeemPoints: "900" }, CONTEXT)).toEqual({ redeemPoints: { code: "too_many", count: 500 } });
  });

  test("the posted form carries the points, the code and the wallet part only when the box is ticked and the wallet is not the whole payment", () => {
    const draft = { ...EMPTY_DRAFT, paymentMethod: "cod" as const, redeemPoints: "١٬٢٠٠", referralCode: "  FRIEND10 ", useWallet: true };
    expect(draftToForm(draft, { idempotencyKey: KEY, expectedTotalIqd: 90_000, walletIqd: 40_000 })).toMatchObject({ redeemPoints: "1200", referralCode: "FRIEND10", walletIqd: "40000", paymentMethod: "cod" });
    // unticked, paying all from the wallet, or nothing in it: no split
    expect(draftToForm({ ...draft, useWallet: false }, { idempotencyKey: KEY, expectedTotalIqd: 90_000, walletIqd: 40_000 }).walletIqd).toBe("");
    expect(draftToForm({ ...draft, paymentMethod: "wallet" }, { idempotencyKey: KEY, expectedTotalIqd: 90_000, walletIqd: 40_000 }).walletIqd).toBe("");
    expect(draftToForm(draft, { idempotencyKey: KEY, expectedTotalIqd: 90_000 }).walletIqd).toBe("");
    // no points typed (or nonsense): nothing redeemed
    expect(draftToForm({ ...draft, redeemPoints: "" }, { idempotencyKey: KEY, expectedTotalIqd: 1 }).redeemPoints).toBe("");
    expect(draftToForm({ ...draft, redeemPoints: "abc" }, { idempotencyKey: KEY, expectedTotalIqd: 1 }).redeemPoints).toBe("");
    // a no-script post comes back as the same draft (the box included)
    expect(draftFromPosted({ paymentMethod: "cod", useWallet: "on", redeemPoints: "1200", referralCode: "FRIEND10" })).toMatchObject({ useWallet: true, redeemPoints: "1200", referralCode: "FRIEND10" });
  });

  test("the server's field names map onto this form: the wallet part is the «use my wallet» box", () => {
    expect(issuesFromServer({ walletIqd: "wallet_split_invalid", redeemPoints: "points_insufficient", referralCode: "referral_self" })).toEqual({
      useWallet: { code: "server.wallet_split_invalid" },
      redeemPoints: { code: "server.points_insufficient" },
      referralCode: { code: "server.referral_self" },
    });
  });
});
