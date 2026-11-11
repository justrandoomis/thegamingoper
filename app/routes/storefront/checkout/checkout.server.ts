/**
 * Server side of the checkout area (cart, checkout, order page, tracking). THIN: every rule — prices, stock, totals,
 * coupons, delivery fees, payment switches, who may see an order — belongs to the commerce core (docs/CONTRACTS.md §1);
 * this file only reads what the pages need, turns form posts into the core's inputs, and turns the core's refusals
 * into `{ ok: false, code, fields, cart }` values the pages can show. Nothing here writes a table.
 */
import { LOCALES, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import type { RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, toAppError } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { CART_COOKIE } from "~/server/shell.server";
import { isCartToken, type CartViewData } from "~/server/services/cart.server";
import { getOrderByAccessToken, getOrderForCustomer, lookupGuestOrder, normalizeOrderRef } from "~/server/services/orders/manage.server";
import { CheckoutError, placeOrder, type CheckoutInput, type CheckoutWho } from "~/server/services/orders/place.server";
import type { OrderView } from "~/server/services/orders/types";
import { getPaymentInstructions } from "~/server/services/payments/payments.server";
import { getShippingFee, getShippingPolicy, listDistricts, listGovernorates, type DistrictOption } from "~/server/services/shipping/fees.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { OTHER_DISTRICT } from "./checkout-form";

export const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The `tt_cart` cookie's token, when it has the shape of one. */
export function cartTokenOf(ctx: Pick<RequestCtx, "cookie">): string | null {
  const value = ctx.cookie(CART_COOKIE);
  return isCartToken(value) ? value : null;
}

// ───────────────────────────────────────────────────────────────── the checkout page

export type GovernorateChoice = { id: string; name: string; /** Delivery fee to it (getShippingFee), null when not served. */ feeIqd: number | null };
export type DayChoice = { value: string; rel: "today" | "tomorrow" | "after"; weekday: string };
export type CheckoutMethods = { cod: boolean; wallet: boolean; bankTransfer: boolean; zaincash: boolean };

export type CheckoutPageData = {
  governorates: GovernorateChoice[];
  districts: Record<string, DistrictOption[]>;
  /** The flat fee and whether per-governorate overrides apply (settings, via getShippingPolicy). */
  shipping: { flatFeeIqd: number; overridesEnabled: boolean };
  methods: CheckoutMethods;
  /** Where manual transfers go — from settings, shown at the payment step. */
  transfer: { accountNumber: string; recipientName: string; zaincashNumber: string };
  /** Hours a transfer order waits for its proof (settings checkout.transfer_proof_hours). */
  proofHours: number;
  /** Signed-in customers: their wallet balance (the ledger's sum). Guests: null. */
  walletBalanceIqd: number | null;
  /** The days a delivery preference can name, in Baghdad time (placeOrder accepts today … +30 days). */
  days: DayChoice[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
const baghdadDay = (at: number) => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

/** Today, tomorrow and the day after in Baghdad, each with its weekday in the shopper's language. */
export function preferredDays(now: number, locale: Locale): DayChoice[] {
  const weekday = new Intl.DateTimeFormat(`${LOCALES[locale].bcp47}-u-nu-latn`, { weekday: "long", timeZone: "UTC" });
  return (["today", "tomorrow", "after"] as const).map((rel, index) => {
    const value = baghdadDay(now + index * DAY_MS);
    return { value, rel, weekday: weekday.format(new Date(`${value}T12:00:00Z`)) };
  });
}

/** Everything the checkout page shows besides the cart. Reads only. */
export async function loadCheckoutData(db: Db, input: { locale: Locale; now: number; customerId: string | null }): Promise<CheckoutPageData> {
  const [governorates, policy, payment, proofHours, walletBalanceIqd] = await Promise.all([
    listGovernorates(db, input.locale),
    getShippingPolicy(db),
    getPaymentInstructions(db, input.locale),
    getSetting(db, "checkout.transfer_proof_hours"),
    input.customerId ? getWalletBalance(db, input.customerId) : Promise.resolve(null),
  ]);
  const [districtLists, fees] = await Promise.all([
    Promise.all(governorates.map((g) => listDistricts(db, input.locale, g.id))),
    // With overrides off every governorate pays the flat fee (CONTRACTS §1); only then is asking per governorate unnecessary.
    policy.overridesEnabled
      ? Promise.all(governorates.map((g) => getShippingFee(db, g.id).catch((error: unknown) => (error instanceof AppError && error.code === "shipping_unavailable" ? null : Promise.reject(error)))))
      : Promise.resolve(governorates.map(() => policy.flatFeeIqd)),
  ]);
  return {
    governorates: governorates.map((g, index) => ({ id: g.id, name: g.name, feeIqd: fees[index] ?? null })),
    districts: Object.fromEntries(governorates.map((g, index) => [g.id, districtLists[index] ?? []])),
    shipping: policy,
    methods: { cod: payment.cod.enabled, wallet: payment.wallet.enabled, bankTransfer: payment.bankTransfer.enabled, zaincash: payment.zaincash.enabled },
    transfer: { accountNumber: payment.bankTransfer.accountNumber, recipientName: payment.bankTransfer.recipientName, zaincashNumber: payment.zaincash.number },
    proofHours,
    walletBalanceIqd,
    days: preferredDays(input.now, input.locale),
  };
}

// ───────────────────────────────────────────────────────────────── placing the order

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * The form post as placeOrder's raw input. Nothing is decided here: placeOrder parses and validates it (zod) and
 * prices the cart itself. "" for optional fields means "not given" (the core accepts that); the district select's
 * "not in the list" choice is sent as no district.
 */
export function checkoutInputFromForm(form: FormData): CheckoutInput {
  const total = text(form, "expectedTotalIqd").trim();
  const district = text(form, "districtId");
  const consent = text(form, "marketingConsent");
  return {
    idempotencyKey: text(form, "idempotencyKey"),
    contactName: text(form, "contactName"),
    phone: text(form, "phone"),
    governorateId: text(form, "governorateId"),
    districtId: district === OTHER_DISTRICT ? "" : district,
    areaText: text(form, "areaText"),
    addressText: text(form, "addressText"),
    notes: text(form, "notes"),
    preferredDay: text(form, "preferredDay"),
    preferredWindow: text(form, "preferredWindow") as CheckoutInput["preferredWindow"],
    marketingConsent: consent === "on" || consent === "true" || consent === "1",
    paymentMethod: text(form, "paymentMethod") as CheckoutInput["paymentMethod"],
    // A missing or malformed total is -1, which the core refuses as invalid (never a guessed number).
    expectedTotalIqd: /^\d{1,12}$/.test(total) ? Number(total) : -1,
  };
}

/**
 * A refused checkout, as the page shows it. `cart` (when the core sent one) is the cart as it is now; `values` are the
 * fields as posted, so a page rendered without script (a plain form post) shows them again with the problems.
 */
export type CheckoutFailure = { ok: false; code: string; status: number; fields?: Record<string, string>; cart?: CartViewData | null; retryAfterSec?: number; values?: Record<string, string> };

/** The draft fields of a posted checkout form, as strings (what a page needs to show the form again). */
export function postedValues(form: FormData): Record<string, string> {
  const names = ["contactName", "phone", "governorateId", "districtId", "areaText", "addressText", "notes", "preferredDay", "preferredWindow", "paymentMethod", "marketingConsent"];
  return Object.fromEntries(names.map((name) => [name, text(form, name).slice(0, 600)]));
}
export type CheckoutSuccess = { ok: true; ref: string; accessToken: string; replayed: boolean };

/** placeOrder, with its expected refusals as values. Unexpected errors are rethrown (the error page shows them). */
export async function placeCheckout(db: Db, who: CheckoutWho, form: FormData, now: number): Promise<CheckoutSuccess | CheckoutFailure> {
  try {
    const result = await placeOrder(db, who, checkoutInputFromForm(form), now);
    return { ok: true, ref: result.ref, accessToken: result.accessToken, replayed: result.replayed };
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    const failure: CheckoutFailure = { ok: false, code: appError.code, status: appError.status, values: postedValues(form) };
    if (appError.fields) failure.fields = { ...appError.fields };
    if (appError.retryAfterSec !== undefined) failure.retryAfterSec = appError.retryAfterSec;
    if (error instanceof CheckoutError) failure.cart = error.cart;
    return failure;
  }
}

/** Where the shopper goes after placing: the confirmation link of CONTRACTS §1 (`/order/<ref>?t=<token>`), locale-less. */
export function confirmationPath(ref: string, accessToken: string): string {
  return `/order/${encodeURIComponent(ref)}?t=${encodeURIComponent(accessToken)}`;
}

// ───────────────────────────────────────────────────────────────── the order page and tracking

/**
 * The order a shopper may see: their own (signed in), or the one their confirmation link opens. Null otherwise —
 * an order that does not exist and someone else's order look exactly the same.
 */
export async function findOrderForShopper(db: Db, input: { ref: string | undefined; token: string | null; customerId: string | null; locale: Locale; now: number }): Promise<{ order: OrderView; access: "customer" | "token" } | null> {
  const ref = normalizeOrderRef(input.ref);
  if (!ref) return null;
  if (input.customerId) {
    const own = await getOrderForCustomer(db, input.customerId, ref, input.locale, input.now);
    if (own) return { order: own, access: "customer" };
  }
  if (input.token) {
    const linked = await getOrderByAccessToken(db, ref, input.token, input.locale, input.now);
    if (linked) return { order: linked, access: "token" };
  }
  return null;
}

export type TrackResult = { ok: true; order: OrderView } | { ok: false; code: string; status: number; fields?: Record<string, string>; retryAfterSec?: number; values: { ref: string; phone: string } };

/**
 * Guest tracking: the order reference AND the phone it was placed with (lookupGuestOrder — rate-limited, the same
 * answer for a wrong reference and a wrong phone). A miss is `not_found`, whichever half was wrong.
 */
export async function trackOrder(db: Db, form: FormData, ctx: { ip: string | null; locale: Locale }, now: number): Promise<TrackResult> {
  const values = { ref: text(form, "ref").slice(0, 40), phone: text(form, "phone").slice(0, 40) };
  try {
    const order = await lookupGuestOrder(db, values, { ip: ctx.ip, locale: ctx.locale }, now);
    if (!order) return { ok: false, code: "not_found", status: 404, values };
    return { ok: true, order };
  } catch (error) {
    const appError = toAppError(error);
    if (!appError) throw error;
    return { ok: false, code: appError.code, status: appError.status, ...(appError.fields ? { fields: { ...appError.fields } } : {}), ...(appError.retryAfterSec !== undefined ? { retryAfterSec: appError.retryAfterSec } : {}), values };
  }
}

/** The customer's own phone as the field shows it ("0771 234 5678"), for prefilling the checkout. */
export function nationalPhone(e164: string | null | undefined): string {
  const normalized = normalizeIraqPhone(e164 ?? "");
  if (!normalized) return "";
  const n = normalized.replace(/^\+964/, "0");
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
}
