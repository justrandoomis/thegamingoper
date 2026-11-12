/**
 * Checkout — placeOrder (docs/CONTRACTS.md §1, brief §4 and §14). Guests never need an account.
 *
 *   const result = await placeOrder(db, { cartToken, customer, locale, ip, storeMode }, input, ctx.now);
 *   // → { ref, orderId, accessToken, paymentStatus, totalIqd, replayed }
 *   // guest confirmation link: /order/<ref>?t=<accessToken>
 *
 * WHAT IT CHECKS (before writing anything)
 *   · input (zod): phone required and normalised (normalizeIraqPhone → +9647XXXXXXXXX), governorate +
 *     area + detailed address required, district optional but must belong to the governorate,
 *     notes / recipient name / preferred day and window optional (an optional field sent empty —
 *     "" from a form — counts as not given), marketing consent explicit (false unless the shopper
 *     ticked it), payment method enabled in settings.
 *   · wallet: signed-in customers only (a guest gets 403 "wallet_requires_account").
 *   · the cart is priced again on the server (getCheckoutCart: today's prices, stock, coupon with
 *     this phone, the governorate's delivery fee). Nothing the browser sends is a price. If the
 *     total differs from `expectedTotalIqd` (what the shopper confirmed) → CheckoutError
 *     "totals_changed" (409) carrying the fresh cart, and nothing is written. No cart or no lines →
 *     "cart_empty"; a line that cannot be bought (sold out, off sale) — also when that is every
 *     line — → "cart_blocked" (both 409 with the cart as it is now).
 *
 * WHAT IT WRITES — ONE db.batch, all or nothing
 *   guest contact (guests) · order (contact, address, preference fields, totals that satisfy the
 *   CHECKs, access-token hash, demo flag) · order lines (price/name snapshots, cost snapshot [P]) ·
 *   the cart marked converted and emptied (guarded: a cart converts once) · stock reservations
 *   (bundles reserve components; shortage aborts: "insufficient_stock") · used-unit reservations ·
 *   coupon redemption (usage limits re-checked inside the batch) · payment row · for wallet: the
 *   ledger debit (the overdraft trigger aborts the WHOLE order: "wallet_insufficient") and its
 *   journal entry · marketing consent row (only when given) · order event · audit event.
 *
 * OUTCOMES
 *   cod                        status new,              payment cod_due   (payment row pending)
 *   wallet                     status confirmed,        payment paid      (paid from the ledger now)
 *   bank_transfer / zaincash   status awaiting_payment, payment unpaid    (payment row pending until a proof
 *                              is submitted; stock is held until `payment_due_at` = now + settings
 *                              "checkout.transfer_proof_hours" — never shorter than
 *                              "checkout.reservation_minutes" — after which the scheduled job cancels it)
 *   NOTHING TO PAY (review 2026-11-12): a total of 0 (points and free delivery covered everything) is paid when
 *                              placed — cash on delivery: status new, payment paid (a paid payment row of 0: no
 *                              cash to collect), its digital lines get their codes; a transfer of 0 is refused
 *                              (payment_method_unavailable, detail "nothing_to_pay", field paymentMethod)
 *   SPLIT (since 2026-11-12): `walletIqd` > 0 with cod / bank_transfer / zaincash — that much is paid from the
 *   wallet now (a paid `wallet` payment row, its ledger debit and posting; trade-in store credit is wallet money
 *   like any other) and the rest is a second payment row of the chosen method, which decides the order's status
 *   as above (orders.paid_iqd = the wallet part). Signed-in customers only; the wallet part is below the total.
 *   In demo mode (STORE_MODE=demo) the order is flagged is_demo.
 *
 * PROMOTIONS (since 2026-11-12; ./promotions.ts and ./promotions.server.ts): the priced cart already carries the flash
 * prices, the automatic rules, the coupon, the membership discount, redeemed points (`redeemPoints`, signed in) and
 * the delivery waiver — the order's discount_iqd is their sum and shipping_iqd is after the waiver. The batch also
 * claims each flash line's units from its sale's allowance (guarded: the sale still runs at that price and the
 * allowance holds them; the per-customer limit counted with this order), writes the points' 'redeem' row (the
 * loyalty overdraft trigger refuses more than the balance), records a typed referral code (module 08's rules: a
 * code switched on and below its cap — guarded —, not the shopper's own, a number referred once) and the order event
 * "promotions" with all of it, as charged. A paid order's digital lines get their codes in the same batch
 * (./digital.server.ts).
 *
 * IDEMPOTENCY
 *   The checkout page sends `idempotencyKey` = randomToken() (22–128 URL-safe characters), one per
 *   attempt. The order stores sha256 of it (UNIQUE). A retry — or two concurrent submissions — with
 *   the same key returns the first order: same ref, same orderId, same access token, nothing
 *   written twice. A replay is answered only to the same shopper (same customer, or the cookie of
 *   the cart that became the order); anyone else gets "idempotency_conflict" (409).
 *
 * GUEST ACCESS TOKEN (/order/<ref>?t=<token>)
 *   token = base64url(sha256("tamtam.order.access.v2|" + orderId + "|" + idempotencyKey)): 256 bits
 *   that depend on two random secrets — the shopper's key (never stored; only its hash is) and the
 *   order id (80 random bits generated here, never shown to shoppers). Only sha256(token) is
 *   stored, so a database reader cannot rebuild the link, yet a retry with the same key gets the
 *   same token back without the token ever being stored.
 *
 * Must not import "cloudflare:workers".
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { PaymentStatus } from "~/lib/dto";
import { newId, publicRef, sha256Hex } from "~/lib/ids";
import type { L10n, Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import type { Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  bundleItems,
  carts,
  consents,
  couponRedemptions,
  coupons,
  customers,
  districts,
  guestContacts,
  orderEvents,
  orderItems,
  orders,
  payments,
  usedUnits,
  variantCosts,
  variants,
  type NewOrder,
  type NewOrderItem,
  type OrderPaymentStatus,
  type PaymentMethod as StoredPaymentMethod,
} from "~/server/db/schema";
import { batchSql, chunkRows, expectChanged, expectThat, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, unauthorized, type AppErrorOptions } from "~/server/errors";
import { RATE_LIMITS, enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { getSettings } from "~/server/settings.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { mapPostingError, postWalletPayment } from "../accounting/post.server";
import { getCartView, getCheckoutCart, type CartViewData, type PricedCartLine } from "../cart.server";
import { reserveStatements, reserveUsedUnitStatements } from "../inventory/stock.server";
import { getShippingFee } from "../shipping/fees.server";
import { getWalletBalance, walletDebitStatement } from "../wallet.server";
import { assignDigitalCodesStatements } from "./digital.server";
import { flashClaimStatements, flashLimitGuards, hasPromotions, pointsRedeemStatement, promotionsEventStatement, referralStatements, type FlashClaim, type PromotionsRecord } from "./promotions.server";
import { PREFERRED_WINDOWS, type PlaceOrderResult } from "./types";

export type { PlaceOrderResult } from "./types";

/** Error keys placeOrder can produce (besides invalid / not_found / rate_limited and the field keys). */
export const CHECKOUT_ERROR_KEYS = [
  "cart_empty",
  "cart_blocked",
  "cart_changed",
  "totals_changed",
  "insufficient_stock",
  "used_unit_not_available",
  "payment_method_unavailable",
  "wallet_requires_account",
  "wallet_insufficient",
  "shipping_unavailable",
  "district_invalid",
  "preferred_day_invalid",
  "phone_invalid",
  "idempotency_conflict",
  "account_blocked",
  "coupon_usage_limit",
  "coupon_customer_limit",
  "period_closed",
  // since 2026-11-12 (promotions, split payments)
  "points_insufficient",
  "points_requires_account",
  "referral_code_unknown",
  "referral_code_inactive",
  "referral_cap_reached",
  "referral_self",
  "referral_phone_used",
  "wallet_split_invalid",
] as const;

/** Methods a shopper can choose at checkout (POS methods are for the store's own till). */
export const CHECKOUT_METHODS = ["cod", "wallet", "bank_transfer", "zaincash"] as const;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{22,128}$/;
/** Free text: control, bidi-override and invisible characters are removed first (~/server/text.server). */
const optionalText = (max: number, multiline = false) =>
  z
    .string()
    .overwrite(multiline ? cleanBlock : cleanLine)
    .trim()
    .max(max, "too_long")
    .optional()
    .nullable()
    .transform((value) => (value ? value : null));

export const CheckoutInput = z.object({
  /** randomToken() generated by the checkout page once per attempt. */
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY, "invalid"),
  /** Recipient name — optional. */
  contactName: optionalText(100),
  phone: z.string().trim().min(1, "required").max(40, "too_long"),
  governorateId: idSchema,
  /** Optional. "" (what an untouched <select> posts) means "not given", like the optional text fields. */
  districtId: z.union([z.literal(""), idSchema]).nullish().transform((value) => value || null),
  areaText: z.string().overwrite(cleanLine).trim().min(2, "required").max(200, "too_long"),
  addressText: z.string().overwrite(cleanBlock).trim().min(5, "too_short").max(500, "too_long"),
  notes: optionalText(500, true),
  /** "YYYY-MM-DD" (Asia/Baghdad), today to 30 days ahead — a preference, never a promise. */
  preferredDay: optionalText(10),
  /** Optional; "" means "no preference". */
  preferredWindow: z.union([z.literal(""), z.enum(PREFERRED_WINDOWS)]).nullish().transform((value) => value || null),
  /** Never pre-checked: false unless the shopper ticked it. */
  marketingConsent: z.boolean().default(false),
  paymentMethod: z.enum(CHECKOUT_METHODS),
  /** The total the shopper saw and confirmed, in IQD. */
  expectedTotalIqd: z.number().int("invalid").min(0, "too_small"),
  /** Signed-in customers: loyalty points to redeem (0 = none). Priced like the cart showed them (never more than the balance). */
  redeemPoints: z.number().int("invalid").min(0, "too_small").max(10_000_000, "too_big").optional().default(0),
  /** A friend's referral code (optional; "" = none). It changes no price — module 08 rewards the referrer later. */
  referralCode: z.string().trim().max(40, "too_long").optional().nullable().transform((value) => (value ? value : null)),
  /** A split payment: this much from the wallet now, the rest by `paymentMethod` (cod / transfer). 0 = none. */
  walletIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000_000, "too_big").optional().default(0),
});
export type CheckoutInput = z.input<typeof CheckoutInput>;

/** Who is checking out. `customer` is the signed-in customer (null for guests). */
export type CheckoutWho = {
  cartToken: string | null;
  customer: { id: string } | null;
  locale: Locale;
  ip: string | null;
  storeMode: "demo" | "live";
  requestId?: string | null;
};

/** A refused checkout that carries the cart as it is now, so the page can show what changed. */
export class CheckoutError extends AppError {
  readonly cart: CartViewData | null;
  constructor(code: string, status: number, cart: CartViewData | null, options: AppErrorOptions = {}) {
    super(code, status, options);
    this.name = "CheckoutError";
    this.cart = cart;
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const BAGHDAD_OFFSET_MS = 3 * HOUR_MS;
const baghdadDay = (at: number) => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

function validPreferredDay(day: string, now: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) return false;
  return day >= baghdadDay(now) && day <= baghdadDay(now + 30 * DAY_MS);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** What `orders.idempotency_key` stores for a checkout key. */
export async function orderKeyHash(idempotencyKey: string): Promise<string> {
  return sha256Hex(`tamtam.order.idempotency.v1|${idempotencyKey}`);
}

/** The guest access token of the order `orderId` placed with this key (only its sha256 is stored). */
export async function orderAccessToken(orderId: string, idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tamtam.order.access.v2|${orderId}|${idempotencyKey}`));
  return base64Url(new Uint8Array(digest));
}

/**
 * The payment status an order starts with, by method — and by total since the review of 2026-11-12: an order with
 * nothing to pay (points and free delivery covered all of it) is paid when it is placed, whatever the method.
 */
export function initialPaymentStatus(method: StoredPaymentMethod | null, totalIqd?: number): PaymentStatus {
  if (method === "wallet" || totalIqd === 0) return "paid";
  if (method === "cod") return "cod_due";
  return "unpaid";
}

const METHOD_SETTING = { cod: "payments.cod", wallet: "payments.wallet", bank_transfer: "payments.bank_transfer", zaincash: "payments.zaincash" } as const;

/** Lower-cased (NFKC), single-spaced — how a variant title is compared with its product's name. */
const foldName = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const WORD_CHAR = /[\p{L}\p{N}]/u;

/** True when `phrase` occurs in `text` as whole words ("FC 26" in "EA SPORTS FC 26", not "PS" in "PS5"). */
function hasPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + 1)) {
    const before = at > 0 ? text[at - 1] : "";
    const after = text[at + phrase.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
  }
  return false;
}

/** " – " / " — " / " - " between a title's lead and its detail ("DualSense – أبيض"). */
const TITLE_SEPARATOR = /\s+[–—-]\s+/;

/** One locale of a line name: the product's name and the variant's title, without saying the product's name twice. */
function joinLineName(name: string | undefined, rawTitle: string | undefined): string | undefined {
  if (!name) return undefined;
  const title = rawTitle?.trim();
  if (!title) return name;
  const foldedName = foldName(name);
  // The title already names the product ("Resident Evil Requiem لجهاز PS5"): it is the whole line name.
  if (hasPhrase(foldName(title), foldedName)) return title;
  // The title opens with the product's short name ("DualSense – أبيض" of "يد التحكم اللاسلكية DualSense"): keep its detail.
  const separator = TITLE_SEPARATOR.exec(title);
  if (separator && separator.index > 0) {
    const lead = foldName(title.slice(0, separator.index));
    const detail = title.slice(separator.index + separator[0].length).trim();
    if (detail && hasPhrase(foldedName, lead)) return `${name} — ${detail}`;
  }
  return `${name} — ${title}`;
}

/**
 * What an order line is called, in every locale the product name has: "PS5 Slim — نسخة الأقراص". A variant title that
 * already contains the product's name stands alone ("Resident Evil Requiem لجهاز PS5", never "Resident Evil Requiem —
 * Resident Evil Requiem لجهاز PS5"), and one that opens with the product's short name keeps only its detail
 * ("يد التحكم اللاسلكية DualSense — أبيض"). A locale without its own title borrows the Arabic one.
 */
export function lineName(productName: L10n, variantTitle: L10n | null): L10n {
  if (!variantTitle) return productName;
  const out: L10n = { ar: joinLineName(productName.ar, variantTitle.ar) ?? productName.ar };
  const en = joinLineName(productName.en, variantTitle.en ?? variantTitle.ar);
  const ckb = joinLineName(productName.ckb, variantTitle.ckb ?? variantTitle.ar);
  if (en) out.en = en;
  if (ckb) out.ckb = ckb;
  return out;
}

type ExistingOrder = { id: string; ref: string; customerId: string | null; paymentMethod: StoredPaymentMethod | null; totalIqd: number };

async function findByKey(db: Db, keyHash: string): Promise<ExistingOrder | null> {
  const row = await db
    .select({ id: orders.id, ref: orders.ref, customerId: orders.customerId, paymentMethod: orders.paymentMethod, totalIqd: orders.totalIqd })
    .from(orders)
    .where(eq(orders.idempotencyKey, keyHash))
    .get();
  return row ?? null;
}

/** The first result again — only for the shopper who placed it. */
async function replayFor(db: Db, existing: ExistingOrder, who: CheckoutWho, idempotencyKey: string): Promise<PlaceOrderResult> {
  let same = false;
  if (existing.customerId) {
    same = who.customer?.id === existing.customerId;
  } else if (who.cartToken) {
    const cart = await db
      .select({ id: carts.id })
      .from(carts)
      .where(and(eq(carts.convertedOrderId, existing.id), eq(carts.tokenHash, await sha256Hex(who.cartToken))))
      .get();
    same = cart !== undefined;
  }
  if (!same) throw new AppError("idempotency_conflict", 409);
  return { ref: existing.ref, orderId: existing.id, accessToken: await orderAccessToken(existing.id, idempotencyKey), paymentStatus: initialPaymentStatus(existing.paymentMethod, existing.totalIqd), totalIqd: existing.totalIqd, replayed: true };
}

/**
 * Places the order for the shopper's cart. See the file header for every rule. Throws AppError
 * (400 invalid with field keys, 403, 409 — CheckoutError with the fresh cart for cart problems,
 * 429 rate_limited); never writes anything when it throws.
 */
export async function placeOrder(db: Db, who: CheckoutWho, raw: CheckoutInput, now: number): Promise<PlaceOrderResult> {
  const input = CheckoutInput.parse(raw);
  const phone = normalizeIraqPhone(input.phone);
  if (!phone) throw invalid({ phone: "phone_invalid" });
  if (input.preferredDay && !validPreferredDay(input.preferredDay, now)) throw invalid({ preferredDay: "preferred_day_invalid" });

  const keyHash = await orderKeyHash(input.idempotencyKey);
  const earlier = await findByKey(db, keyHash);
  if (earlier) return replayFor(db, earlier, who, input.idempotencyKey);

  try {
    return await placeNew(db, who, input, phone, keyHash, now);
  } catch (error) {
    // Another call with the same key may have won the race (or committed while we were pricing).
    const winner = await findByKey(db, keyHash);
    if (winner) return replayFor(db, winner, who, input.idempotencyKey);
    throw error;
  }
}

type ParsedCheckout = z.output<typeof CheckoutInput>;

async function placeNew(db: Db, who: CheckoutWho, input: ParsedCheckout, phone: string, keyHash: string, now: number): Promise<PlaceOrderResult> {
  const customerId = who.customer?.id ?? null;
  const method = input.paymentMethod;
  if (method === "wallet" && !customerId) throw new AppError("wallet_requires_account", 403, { fields: { paymentMethod: "wallet_requires_account" } });
  // a split payment: part from the wallet (signed in), the rest by cash on delivery or a transfer
  const split = method !== "wallet" && input.walletIqd > 0;
  if (split && !customerId) throw new AppError("wallet_requires_account", 403, { fields: { walletIqd: "wallet_requires_account" } });
  if (input.redeemPoints > 0 && !customerId) throw new AppError("points_requires_account", 403, { fields: { redeemPoints: "points_requires_account" } });

  const settings = await getSettings(db, ["payments.cod", "payments.wallet", "payments.bank_transfer", "payments.zaincash", "checkout.transfer_proof_hours", "checkout.reservation_minutes"]);
  if (!settings[METHOD_SETTING[method]].enabled) throw new AppError("payment_method_unavailable", 409, { fields: { paymentMethod: "payment_method_unavailable" }, detail: method });
  if (split && !settings["payments.wallet"].enabled) throw new AppError("payment_method_unavailable", 409, { fields: { walletIqd: "payment_method_unavailable" }, detail: "wallet" });

  if (customerId) {
    const customer = await db.select({ id: customers.id, status: customers.status }).from(customers).where(eq(customers.id, customerId)).get();
    if (!customer) throw unauthorized("customer");
    if (customer.status !== "active") throw new AppError("account_blocked", 403);
  }

  await enforceRateLimit(db, await limitKey("checkout", "ip", who.ip), RATE_LIMITS.checkout, now);
  await enforceRateLimit(db, await limitKey("checkout", "phone", phone), RATE_LIMITS.checkout, now);

  await getShippingFee(db, input.governorateId); // throws shipping_unavailable (409, fields.governorateId)
  if (input.districtId) {
    const district = await db.select({ governorateId: districts.governorateId, isActive: districts.isActive }).from(districts).where(eq(districts.id, input.districtId)).get();
    if (!district || district.governorateId !== input.governorateId || !district.isActive) throw invalid({ districtId: "district_invalid" });
  }

  const cartRequest = { cartToken: who.cartToken, customerId, locale: who.locale, governorateId: input.governorateId, redeemPoints: input.redeemPoints, referralCode: input.referralCode };
  const priced = await getCheckoutCart(db, { ...cartRequest, phoneE164: phone }, now);
  const freshView = () => getCartView(db, cartRequest, now).catch(() => null);
  // The cart a refusal BEFORE the write shows (an empty or blocked cart, a total that moved): priced for this number —
  // its total is what placeOrder will charge —, but its referral code said the way the cart page says it, without the
  // typed number (security review 2026-11-12: a deliberately wrong total answered whether THAT number owns the code or
  // was referred before, so anyone could test numbers against a public code without placing anything). The order
  // itself still refuses such a number on the field below — after a correct, complete checkout.
  const refusalView = async (): Promise<CartViewData> => (priced.view.referral ? { ...priced.view, referral: (await freshView())?.referral ?? null } : priced.view);
  const lines = priced.lines.filter((entry) => entry.purchasable);
  const cartId = priced.cartId;
  // An empty cart is "cart_empty"; a cart whose lines all sold out (or went off sale) is still a cart the page shows,
  // line by line, so it is "cart_blocked" like any other cart with a line that cannot be bought.
  if (!cartId || priced.lines.length === 0) throw new CheckoutError("cart_empty", 409, await refusalView());
  if (lines.length === 0 || priced.view.blocked) throw new CheckoutError("cart_blocked", 409, await refusalView());
  if (priced.view.shippingIqd === null) throw new AppError("shipping_unavailable", 409, { fields: { governorateId: "shipping_unavailable" }, detail: input.governorateId });
  if (priced.view.totalIqd !== input.expectedTotalIqd) {
    throw new CheckoutError("totals_changed", 409, await refusalView(), { detail: `${input.expectedTotalIqd}→${priced.view.totalIqd}` });
  }
  // a referral code that cannot count says why, on its field (the order is not placed: the shopper removes or fixes it)
  const referral = priced.promotions?.referral ?? null;
  if (referral && !referral.ok) throw new AppError(referral.issue, 409, { fields: { referralCode: referral.issue }, detail: referral.code });
  // Nothing to pay (points and free delivery covered everything): there is no transfer to send and no cash to collect
  // (review 2026-11-12 — such an order stayed "cash due" for ever and its digital codes never came). Cash on delivery
  // and the wallet place it as paid; a transfer of nothing is not asked for.
  const nothingToPay = priced.view.totalIqd === 0;
  if (nothingToPay && (method === "bank_transfer" || method === "zaincash")) throw new AppError("payment_method_unavailable", 409, { fields: { paymentMethod: "payment_method_unavailable" }, detail: "nothing_to_pay" });
  // the wallet part of a split: below the total (all of it is the wallet method), within the balance
  const walletPart = split ? input.walletIqd : 0;
  if (split && walletPart >= priced.view.totalIqd) throw invalid({ walletIqd: "wallet_split_invalid" }, `${walletPart} ≥ ${priced.view.totalIqd}`);
  if (split && customerId && (await getWalletBalance(db, customerId)) < walletPart) throw new AppError("wallet_insufficient", 409, { fields: { walletIqd: "wallet_insufficient" } });

  // What the order lines snapshot: variant titles and options, and the cost [P].
  const variantIds = [...new Set(lines.map((entry) => entry.line.variantId as string))];
  const usedIds = lines.flatMap((entry) => (entry.line.usedUnitId ? [entry.line.usedUnitId] : []));
  const [variantRows, bundleRows, usedRows] = await Promise.all([
    db.select({ id: variants.id, title: variants.title, options: variants.options }).from(variants).where(inArray(variants.id, variantIds)),
    db.select({ bundleId: bundleItems.bundleVariantId, componentId: bundleItems.componentVariantId, qty: bundleItems.qty }).from(bundleItems).where(inArray(bundleItems.bundleVariantId, variantIds)),
    usedIds.length ? db.select({ id: usedUnits.id, grade: usedUnits.grade, costIqd: usedUnits.acquisitionCostIqd }).from(usedUnits).where(inArray(usedUnits.id, usedIds)) : Promise.resolve([]),
  ]);
  const costIds = [...new Set([...variantIds, ...bundleRows.map((row) => row.componentId)])];
  const costRows = await db.select({ variantId: variantCosts.variantId, landedCostIqd: variantCosts.landedCostIqd }).from(variantCosts).where(inArray(variantCosts.variantId, costIds));
  const variantOf = new Map(variantRows.map((row) => [row.id, row]));
  const landed = new Map(costRows.map((row) => [row.variantId, row.landedCostIqd]));
  const usedOf = new Map(usedRows.map((row) => [row.id, row]));
  const componentsOf = new Map<string, { componentId: string; qty: number }[]>();
  for (const row of bundleRows) componentsOf.set(row.bundleId, [...(componentsOf.get(row.bundleId) ?? []), { componentId: row.componentId, qty: row.qty }]);
  const unitCost = (entry: PricedCartLine): number | null => {
    if (entry.line.usedUnitId) return usedOf.get(entry.line.usedUnitId)?.costIqd ?? null;
    const parts = componentsOf.get(entry.line.variantId as string);
    if (!parts) return landed.get(entry.line.variantId as string) ?? null;
    let sum = 0;
    for (const part of parts) {
      const cost = landed.get(part.componentId);
      if (cost === undefined || cost === null) return null;
      sum += cost * part.qty;
    }
    return sum;
  };

  const coupon = priced.coupon;
  const couponRow = coupon ? await db.select({ usageLimit: coupons.usageLimit, perCustomerLimit: coupons.perCustomerLimit }).from(coupons).where(eq(coupons.id, coupon.couponId)).get() : undefined;
  const guestContact = customerId
    ? null
    : await db
        .select({ id: guestContacts.id })
        .from(guestContacts)
        .where(eq(guestContacts.phoneE164, phone))
        .orderBy(sql`${guestContacts.createdAt} DESC`)
        .limit(1)
        .get();

  const totals = priced.view;
  const isDemo = who.storeMode === "demo";
  const transfer = method === "bank_transfer" || method === "zaincash";
  const paymentDueAt = transfer ? now + settings["checkout.transfer_proof_hours"] * HOUR_MS : null;
  // the stock of an order waiting for its transfer is held for the proof window, never shorter than the store's
  // reservation time (setting checkout.reservation_minutes); a proof that arrives keeps it held while staff review it
  const reservationExpiresAt = paymentDueAt === null ? null : Math.max(paymentDueAt, now + settings["checkout.reservation_minutes"] * 60_000);
  const actor: Actor = customerId ? { kind: "customer", id: customerId, ip: who.ip, requestId: who.requestId ?? null } : { kind: "guest", ip: who.ip, requestId: who.requestId ?? null };
  const status: NewOrder["status"] = method === "cod" ? "new" : method === "wallet" ? "confirmed" : "awaiting_payment";
  const paymentStatus: OrderPaymentStatus = initialPaymentStatus(method, totals.totalIqd);
  /** Paid in full when placed: by the wallet, or nothing to pay (a cash-on-delivery order of 0 is recorded paid). */
  const paidNow = method === "wallet" || nothingToPay;
  const outcome = priced.promotions?.outcome ?? null;
  const pointsUsed = outcome?.pointsUsed ?? 0;
  /** What the wallet pays now: everything (wallet), a part (split), or nothing. */
  const walletPays = method === "wallet" ? totals.totalIqd : walletPart;

  for (let attempt = 1; ; attempt++) {
    const orderId = newId("ord");
    const ref = publicRef("TT");
    const accessToken = await orderAccessToken(orderId, input.idempotencyKey);
    const accessTokenHash = await sha256Hex(accessToken);
    const guestContactId = customerId ? null : (guestContact?.id ?? newId("gst"));
    const paymentId = newId("pay");
    const walletPaymentId = split ? newId("pay") : null;
    const ledgerId = walletPays > 0 ? newId("wal") : null;

    const orderRow: NewOrder = {
      id: orderId,
      ref,
      idempotencyKey: keyHash,
      channel: "web",
      customerId,
      guestContactId,
      status,
      paymentStatus,
      paymentMethod: method,
      subtotalIqd: totals.subtotalIqd,
      discountIqd: totals.discountIqd,
      shippingIqd: totals.shippingIqd ?? 0,
      taxIqd: 0,
      totalIqd: totals.totalIqd,
      paidIqd: walletPays,
      refundedIqd: 0,
      couponId: coupon?.couponId ?? null,
      couponCode: coupon?.code ?? null,
      contactName: input.contactName,
      contactPhoneE164: phone,
      governorateId: input.governorateId,
      districtId: input.districtId,
      areaText: input.areaText,
      addressText: input.addressText,
      notes: input.notes,
      preferredDay: input.preferredDay,
      preferredWindow: input.preferredWindow,
      marketingConsent: input.marketingConsent,
      locale: who.locale,
      accessTokenHash,
      isDemo,
      riskFlags: null,
      placedAt: now,
      confirmedAt: method === "wallet" ? now : null,
      paymentDueAt,
      updatedAt: now,
    };
    const itemRows: NewOrderItem[] = lines.map((entry) => {
      const variant = variantOf.get(entry.line.variantId as string);
      const used = entry.line.usedUnitId ? usedOf.get(entry.line.usedUnitId) : undefined;
      const options = { ...(variant?.options ?? {}), ...(used ? { grade: used.grade } : {}) };
      return {
        id: newId("oit"),
        orderId,
        variantId: entry.line.variantId as string,
        usedUnitId: entry.line.usedUnitId,
        sku: entry.sku,
        nameSnapshot: lineName(entry.name, variant?.title ?? null),
        optionsSnapshot: Object.keys(options).length ? options : null,
        unitPriceIqd: entry.line.unitPriceIqd,
        qty: entry.line.qty,
        discountIqd: 0,
        totalIqd: entry.line.unitPriceIqd * entry.line.qty,
        costSnapshotIqd: unitCost(entry),
        refundedQty: 0,
        warrantyMonths: entry.warrantyMonths,
        warrantyDays: entry.warrantyDays,
        isPreorder: false,
      };
    });

    const statements: BatchStatement[] = [];
    if (guestContactId && !guestContact) statements.push(db.insert(guestContacts).values({ id: guestContactId, phoneE164: phone, name: input.contactName, createdAt: now }));
    statements.push(db.insert(orders).values(orderRow));
    for (const rows of chunkRows(orderItems, itemRows)) statements.push(db.insert(orderItems).values(rows));
    // The cart becomes this order exactly once (two tabs, a double click with different keys…).
    statements.push(
      db
        .update(carts)
        .set({ convertedOrderId: orderId, updatedAt: now })
        .where(and(eq(carts.id, cartId), sql`${carts.convertedOrderId} IS NULL`)),
      expectChanged(db, 1, { code: "CART_CHANGED", detail: cartId }),
      batchSql(db, sql`DELETE FROM cart_items WHERE cart_id = ${cartId}`),
    );
    const stockLines = lines.filter((entry) => !entry.line.usedUnitId).map((entry) => ({ variantId: entry.line.variantId as string, qty: entry.line.qty }));
    statements.push(...reserveStatements(db, { orderId, lines: stockLines, expiresAt: reservationExpiresAt, actor, now }));
    for (const usedUnitId of usedIds) statements.push(...reserveUsedUnitStatements(db, { usedUnitId, orderId, now }));
    if (coupon) {
      statements.push(db.insert(couponRedemptions).values({ id: newId("crd"), couponId: coupon.couponId, orderId, customerId, phoneE164: phone, amountIqd: coupon.discountIqd, at: now }));
      if (couponRow?.usageLimit !== null && couponRow?.usageLimit !== undefined) {
        statements.push(
          expectThat(db, sql`(SELECT count(*) FROM coupon_redemptions WHERE coupon_id = ${coupon.couponId} AND voided_at IS NULL) <= ${couponRow.usageLimit}`, { code: "COUPON_USAGE_LIMIT", detail: coupon.couponId }),
        );
      }
      if (couponRow?.perCustomerLimit !== null && couponRow?.perCustomerLimit !== undefined) {
        const identity = customerId ? sql`(customer_id = ${customerId} OR phone_e164 = ${phone})` : sql`phone_e164 = ${phone}`;
        statements.push(
          expectThat(db, sql`(SELECT count(*) FROM coupon_redemptions WHERE coupon_id = ${coupon.couponId} AND voided_at IS NULL AND ${identity}) <= ${couponRow.perCustomerLimit}`, {
            code: "COUPON_CUSTOMER_LIMIT",
            detail: coupon.couponId,
          }),
        );
      }
    }
    // ── promotions: the record (one "promotions" order event), the flash claims and the per-customer limits, points, referral
    const itemIdOf = new Map(lines.map((entry, index) => [entry.line.id, itemRows[index]?.id as string]));
    const claims: FlashClaim[] = lines.flatMap((entry) =>
      entry.flash
        ? [{ itemId: entry.flash.itemId, saleId: entry.flash.saleId, orderItemId: itemIdOf.get(entry.line.id) as string, variantId: entry.line.variantId as string, units: entry.line.qty, salePriceIqd: entry.flash.salePriceIqd, regularPriceIqd: entry.flash.regularPriceIqd, endsAt: entry.flash.endsAt, name: entry.flash.name, perCustomerLimit: entry.flash.perCustomerLimit }]
        : [],
    );
    const facts = priced.promotions?.facts ?? null;
    const referralId = referral?.ok ? newId("rfr") : null;
    const record: PromotionsRecord = {
      v: 1,
      flash: claims,
      discounts: (outcome?.discounts ?? []).map((entry): PromotionsRecord["discounts"][number] => {
        switch (entry.kind) {
          case "rule":
            return { kind: "rule", ruleId: entry.ruleId, name: facts?.rules.find((rule) => rule.id === entry.ruleId)?.name ?? { ar: entry.label }, amountIqd: entry.amountIqd };
          case "coupon":
            return { kind: "coupon", code: entry.code, label: entry.label, amountIqd: entry.amountIqd };
          case "member":
            return { kind: "member", membershipId: facts?.member?.membershipId ?? "", tierId: facts?.member?.tierId ?? "", name: facts?.member?.name ?? { ar: entry.label }, bps: entry.bps, amountIqd: entry.amountIqd };
          case "points":
            return { kind: "points", points: entry.points, amountIqd: entry.amountIqd };
        }
      }),
      shipping: outcome?.shippingWaiver
        ? {
            by: outcome.shippingWaiver.by,
            ...(outcome.shippingWaiver.ruleId ? { ruleId: outcome.shippingWaiver.ruleId } : {}),
            ...(outcome.shippingWaiver.by === "member" && facts?.member ? { membershipId: facts.member.membershipId } : {}),
            name: outcome.shippingWaiver.by === "member" ? (facts?.member?.name ?? { ar: outcome.shippingWaiver.label }) : (facts?.rules.find((rule) => rule.id === outcome.shippingWaiver?.ruleId)?.name ?? { ar: outcome.shippingWaiver.label }),
            feeIqd: outcome.shippingWaiver.feeIqd,
            waivedIqd: outcome.shippingWaiver.waivedIqd,
          }
        : null,
      referral: referral?.ok && referralId ? { code: referral.code, referralId } : null,
    };
    statements.push(...flashClaimStatements(db, claims, now));
    if (hasPromotions(record)) statements.push(promotionsEventStatement(db, { orderId, record, actor, now }));
    // after the event: this order's own units count against a per-customer limit
    statements.push(...flashLimitGuards(db, claims, { customerId, phoneE164: phone }));
    if (pointsUsed > 0 && customerId) statements.push(pointsRedeemStatement(db, { orderId, ref, customerId, points: pointsUsed, actor, now }));
    if (referral?.ok && referralId) statements.push(...referralStatements(db, { referralId, codeId: referral.codeId, orderId, phoneE164: phone, customerId, now }));

    // ── money: the wallet's part (all of it, or a split's part), then the rest by the chosen method
    if (customerId && ledgerId && walletPays > 0) {
      statements.push(walletDebitStatement(db, { id: ledgerId, customerId, amountIqd: walletPays, refType: "order", refId: orderId, idempotencyKey: `order:${orderId}:wallet`, actor, now }));
    }
    if (split && walletPaymentId) {
      statements.push(
        db.insert(payments).values({ id: walletPaymentId, orderId, method: "wallet", status: "paid", amountIqd: walletPays, idempotencyKey: `order:${orderId}:payment:wallet`, createdAt: now, paidAt: now, updatedAt: now, walletLedgerId: ledgerId }),
        ...postWalletPayment(db, { paymentId: walletPaymentId, orderId, ref, amountIqd: walletPays, at: now, createdBy: `customer:${customerId}`, isDemo }),
      );
    }
    statements.push(
      db.insert(payments).values({
        id: paymentId,
        orderId,
        method,
        status: paidNow ? "paid" : "pending",
        amountIqd: totals.totalIqd - (split ? walletPays : 0),
        idempotencyKey: `order:${orderId}:payment`,
        createdAt: now,
        paidAt: paidNow ? now : null,
        updatedAt: now,
        walletLedgerId: method === "wallet" && totals.totalIqd > 0 ? ledgerId : null,
      }),
    );
    if (method === "wallet") statements.push(...postWalletPayment(db, { paymentId, orderId, ref, amountIqd: totals.totalIqd, at: now, createdBy: `customer:${customerId}`, isDemo }));
    if (paidNow) {
      // paid now: the digital lines get their codes in this batch
      statements.push(...(await assignDigitalCodesStatements(db, { orderId, lines: itemRows.map((row) => ({ orderItemId: row.id as string, variantId: row.variantId, qty: row.qty })), isDemo, actor, now })));
    }
    if (input.marketingConsent) {
      statements.push(
        db.insert(consents).values({ id: newId("cns"), subjectType: customerId ? "customer" : "guest_contact", subjectId: (customerId ?? guestContactId) as string, kind: "marketing", granted: true, source: "checkout", at: now, ip: who.ip }),
      );
    }
    statements.push(
      db.insert(orderEvents).values({
        id: newId("oev"),
        orderId,
        kind: "placed",
        data: { status, paymentStatus, paymentMethod: method, totalIqd: totals.totalIqd, lines: itemRows.length, isDemo, ...(split ? { walletIqd: walletPays } : {}) },
        actorKind: actor.kind,
        actorId: customerId,
        at: now,
      }),
      auditStatement(db, {
        actor,
        action: "orders.order.place",
        entityType: "order",
        entityId: orderId,
        after: {
          ref,
          status,
          paymentMethod: method,
          paymentStatus,
          totalIqd: totals.totalIqd,
          discountIqd: totals.discountIqd,
          shippingIqd: totals.shippingIqd,
          coupon: coupon?.code ?? null,
          lines: itemRows.length,
          isDemo,
          ...(split ? { walletIqd: walletPays } : {}),
          ...(hasPromotions(record) ? { promotions: { flash: claims.length, discounts: record.discounts.map((entry) => ({ kind: entry.kind, amountIqd: entry.amountIqd })), shippingWaivedIqd: record.shipping?.waivedIqd ?? 0, points: pointsUsed, referral: record.referral?.code ?? null } } : {}),
        },
        at: now,
      }),
    );

    try {
      await runBatch(db, statements);
      return { ref, orderId, accessToken, paymentStatus, totalIqd: totals.totalIqd, replayed: false };
    } catch (error) {
      if (isUniqueViolation(error, "orders.ref") && attempt < 4) continue;
      if (isUniqueViolation(error, "orders.idempotency_key")) throw error; // the caller answers with the winner
      const posting = mapPostingError(error);
      if (posting) throw posting;
      const info = mapDbError(error);
      switch (info?.code) {
        case "INSUFFICIENT_STOCK":
          throw new CheckoutError("insufficient_stock", 409, await freshView(), { detail: info.detail, cause: error });
        case "USED_UNIT_NOT_AVAILABLE":
        case "SERIAL_NOT_AVAILABLE":
          throw new CheckoutError("used_unit_not_available", 409, await freshView(), { detail: info.detail, cause: error });
        case "CART_CHANGED":
          throw new CheckoutError("cart_changed", 409, await freshView(), { cause: error });
        case "COUPON_USAGE_LIMIT":
          throw new CheckoutError("coupon_usage_limit", 409, await freshView(), { detail: info.detail, cause: error });
        case "COUPON_CUSTOMER_LIMIT":
          throw new CheckoutError("coupon_customer_limit", 409, await freshView(), { detail: info.detail, cause: error });
        case "WALLET_OVERDRAFT":
          throw new AppError("wallet_insufficient", 409, { fields: split ? { walletIqd: "wallet_insufficient" } : { paymentMethod: "wallet_insufficient" }, cause: error });
        case "LOYALTY_OVERDRAFT":
          // the points were spent meanwhile (another order, an expiry): the cart priced again says how many are left
          throw new CheckoutError("points_insufficient", 409, await freshView(), { detail: info.detail, cause: error });
        case "FLASH_CHANGED":
        case "FLASH_LIMIT":
          // the sale ended, its price changed or its allowance ran out meanwhile: the price moved
          throw new CheckoutError("totals_changed", 409, await freshView(), { detail: `${info.code}:${info.detail}`, cause: error });
        case "REFERRAL_CAP":
          throw new AppError("referral_cap_reached", 409, { fields: { referralCode: "referral_cap_reached" }, detail: info.detail, cause: error });
        default:
          if (isUniqueViolation(error, "referral_redemptions.referred_phone_e164")) throw new AppError("referral_phone_used", 409, { fields: { referralCode: "referral_phone_used" }, cause: error });
          throw error;
      }
    }
  }
}
