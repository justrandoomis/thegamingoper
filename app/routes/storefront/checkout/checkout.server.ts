/**
 * Server side of the checkout area (cart, checkout, order page, tracking). THIN: every rule — prices, stock, totals,
 * coupons, delivery fees, payment switches, who may see an order — belongs to the commerce core (docs/CONTRACTS.md §1);
 * this file only reads what the pages need, turns form posts into the core's inputs, and turns the core's refusals
 * into `{ ok: false, code, fields, cart }` values the pages can show. Nothing here writes a commerce table.
 *
 * Cross-area (integration pass): the cart's and the order's recommendation shelves (devices area, streamed), the
 * purchase signal after a new order (devices area's recordPurchaseSignals — consent only, never in the commerce
 * core), and the signed-in customer's default address as the checkout's starting draft (account area).
 */
import { sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { serializeCookie, type RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, toAppError } from "~/server/errors";
import { getSetting } from "~/server/settings.server";
import { CART_COOKIE } from "~/server/shell.server";
import { saveAddress } from "~/server/services/account/addresses.server";
import type { AddressView } from "~/server/services/account/types";
import { isCartToken, type CartViewData } from "~/server/services/cart.server";
import {
  newRecSessionToken,
  orderItemsOf,
  personalizationFor,
  REC_SESSION_COOKIE,
  REC_SESSION_MAX_AGE_SEC,
  recommendationsFor,
  recordPurchaseSignals,
  usedUnitVariantIds,
  type RecommendationResult,
} from "~/server/services/recommendations.server";
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
  /**
   * The days a delivery preference can name. EMPTY until the owner configures dispatch days in the admin (Design
   * System v2 §4.9, §13 #5): until then the preference is the time of day alone, and no day or date is offered.
   */
  days: DayChoice[];
};

/** What the cart page states next to the total: the delivery fee rule and whether cash on delivery is on. Reads only. */
export type CartFacts = { deliveryFeeIqd: number; overridesEnabled: boolean; cod: boolean };

export async function loadCartFacts(db: Db): Promise<CartFacts> {
  const [policy, payment] = await Promise.all([getShippingPolicy(db), getPaymentInstructions(db)]);
  return { deliveryFeeIqd: policy.flatFeeIqd, overridesEnabled: policy.overridesEnabled, cod: payment.cod.enabled };
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
    // no dispatch days are configured (there is no such setting yet): the period alone
    days: [],
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
  // "any time" is no preference (the time cells post it without script)
  const timeOfDay = text(form, "preferredWindow");
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
    preferredWindow: (timeOfDay === "any" ? "" : timeOfDay) as CheckoutInput["preferredWindow"],
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
  const names = ["contactName", "phone", "governorateId", "districtId", "areaText", "addressText", "notes", "preferredDay", "preferredWindow", "paymentMethod", "marketingConsent", "saveAddress"];
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

// ───────────────────────────────────────────────────────────────── cross-area (integration pass)

/** A shelf is worth a rail from three items (Design System v2 §4.22): fewer is never padded, it is left out. */
const MIN_RAIL_ITEMS = 3;

/** One rail at most, and only one with enough to show (§6.10 cart, §6.11 order): the engine's first such shelf. */
export function oneRail(result: RecommendationResult): RecommendationResult {
  if (!result.ok) return result;
  const first = result.shelves.find((shelf) => shelf.items.length >= MIN_RAIL_ITEMS);
  return { ok: true, shelves: first ? [first] : [] };
}

/**
 * The cart's recommendation rail (devices area, context "cart"), for the loader to stream: anchored on every line —
 * a used unit through its catalogue variant; one rail («أكمل تجهيزك», verified add-ons, ≥3). Never rejects (a failure
 * is `ok: false`); an empty cart asks for nothing.
 */
export async function cartShelves(db: Db, ctx: Pick<RequestCtx, "cookie" | "locale" | "now">, customerId: string | null, cart: Pick<CartViewData, "lines">): Promise<RecommendationResult> {
  try {
    const used = cart.lines.flatMap((line) => (line.usedUnitId ? [line.usedUnitId] : []));
    const variantIds = [...cart.lines.flatMap((line) => (line.variantId ? [line.variantId] : [])), ...(used.length > 0 ? await usedUnitVariantIds(db, used) : [])];
    if (variantIds.length === 0) return { ok: true, shelves: [] };
    return oneRail(await recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale: ctx.locale, context: "cart", cartVariantIds: variantIds, now: ctx.now }, 8));
  } catch (error) {
    console.error("[checkout] cart shelves failed", error);
    return { ok: false, shelves: [] };
  }
}

/**
 * Four in-stock products under the empty cart (§6.10): the store's own picks for the home page (the engine's honest
 * reason line, its in-stock rule, the shopper's consent for anything personal). Never rejects.
 */
export async function emptyCartShelves(db: Db, ctx: Pick<RequestCtx, "cookie" | "locale" | "now">, customerId: string | null): Promise<RecommendationResult> {
  try {
    return oneRail(await recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale: ctx.locale, context: "home", now: ctx.now }, 4));
  } catch (error) {
    console.error("[checkout] empty-cart shelf failed", error);
    return { ok: false, shelves: [] };
  }
}

/** The order page's cross-sell (context "post_purchase", anchored on what was bought): at most one rail of four. Never rejects. */
export async function orderShelves(db: Db, ctx: Pick<RequestCtx, "cookie" | "locale" | "now">, customerId: string | null, ref: string): Promise<RecommendationResult> {
  try {
    const { variantIds } = await orderItemsOf(db, ref);
    if (variantIds.length === 0) return { ok: true, shelves: [] };
    return oneRail(await recommendationsFor(db, { cookie: ctx.cookie, customerId }, { locale: ctx.locale, context: "post_purchase", cartVariantIds: variantIds, now: ctx.now }, 4));
  } catch (error) {
    console.error("[checkout] order shelves failed", error);
    return { ok: false, shelves: [] };
  }
}

/**
 * "Save this address for your next orders" (§6.10, signed-in customers, unticked by default): after placeOrder
 * returned a NEW order, the posted delivery fields go to the account area's address book (saveAddress validates them
 * again with its own limits). Best effort and never inside the commerce core: a refusal (the book is full, a field
 * over the book's limits) is logged and reported as `false` — the order is already placed and is never touched.
 */
export async function saveCheckoutAddress(db: Db, customer: { id: string; ip: string | null }, form: FormData, now: number): Promise<boolean> {
  const value = (name: string) => {
    const item = form.get(name);
    return typeof item === "string" ? item : "";
  };
  const district = value("districtId");
  try {
    await saveAddress(
      db,
      { kind: "customer", id: customer.id, ip: customer.ip },
      {
        recipientName: value("contactName"),
        phone: value("phone"),
        governorateId: value("governorateId"),
        districtId: district === OTHER_DISTRICT ? "" : district,
        areaText: value("areaText"),
        addressText: value("addressText"),
        notes: value("notes"),
      },
      now,
    );
    return true;
  } catch (error) {
    console.error("[checkout] address not saved", error);
    return false;
  }
}

/** The posted "save this address" box was ticked. */
export const wantsAddressSaved = (form: FormData) => ["on", "true", "1"].includes(String(form.get("saveAddress") ?? ""));

/**
 * The purchase signal (devices area) after a NEW order — server side only, here and never inside the commerce core:
 * one "purchase" per product, only with the shopper's personalization consent (the account's answer, else this
 * device's `tt_consent`). A consenting guest without a session key gets one now (the `tt_rs` cookie, as the events
 * endpoint does on a first signal). A replayed attempt records nothing. A failure is logged and never touches the
 * order: the shopper is already on their way to it.
 */
export async function recordPurchase(db: Db, ctx: RequestCtx, customerId: string | null, result: CheckoutSuccess): Promise<void> {
  if (result.replayed) return;
  try {
    let who = await personalizationFor(db, { cookie: ctx.cookie, customerId });
    if (!who.consent) return;
    if (!customerId && !who.sessionHash) {
      const token = newRecSessionToken();
      ctx.setCookie(serializeCookie(ctx, REC_SESSION_COOKIE, token, { maxAge: REC_SESSION_MAX_AGE_SEC, httpOnly: true, sameSite: "Lax" }));
      who = { ...who, sessionHash: await sha256Hex(token) };
    }
    const { productIds } = await orderItemsOf(db, result.ref);
    await recordPurchaseSignals(db, who, productIds, ctx.now);
  } catch (error) {
    console.error("[checkout] purchase signal not recorded", error);
  }
}

/** A signed-in customer's default address as the checkout's starting values (the shopper may change all of it). */
export type SavedAddressPrefill = {
  /** The address's own label ("البيت"), when it has one — the page says which address it started from. */
  label: string | null;
  contactName: string;
  phone: string;
  governorateId: string;
  /** "" when the saved district is gone or none was saved: the shopper chooses (never assumed). */
  districtId: string;
  areaText: string;
  addressText: string;
  notes: string;
};

/**
 * The account area's default address (getDefaultAddress) as checkout fields — only a place the checkout serves now:
 * a governorate that is not served (or no longer active) gives no prefill at all; a district that is no longer in
 * that governorate's list is left for the shopper to choose. Pure (the page data is already read).
 */
export function addressPrefill(address: AddressView | null, page: Pick<CheckoutPageData, "governorates" | "districts">): SavedAddressPrefill | null {
  if (!address) return null;
  const governorate = page.governorates.find((g) => g.id === address.governorateId);
  if (!governorate || governorate.feeIqd === null) return null;
  const districts = page.districts[address.governorateId] ?? [];
  return {
    label: address.label,
    contactName: address.recipientName ?? "",
    phone: address.phoneE164 ? nationalPhone(address.phoneE164) : "",
    governorateId: address.governorateId,
    districtId: address.districtId && districts.some((d) => d.id === address.districtId) ? address.districtId : "",
    areaText: address.areaText ?? "",
    addressText: address.addressText,
    notes: address.notes ?? "",
  };
}

/** The customer's own phone as the field shows it ("0771 234 5678"), for prefilling the checkout. */
export function nationalPhone(e164: string | null | undefined): string {
  const normalized = normalizeIraqPhone(e164 ?? "");
  if (!normalized) return "";
  const n = normalized.replace(/^\+964/, "0");
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
}
