/**
 * The cart (docs/CONTRACTS.md §1, brief §4). Guests never need an account to buy.
 *
 *   const { cartToken, view } = await addToCart(db, { cartToken, customerId, locale }, { variantId, qty: 1 }, now);
 *   ctx.setCookie(serializeCookie(ctx, CART_COOKIE, cartToken, { maxAge: CART_COOKIE_MAX_AGE_SEC }));
 *   const view = await getCartView(db, { cartToken, customerId, locale, governorateId }, now);
 *
 * IDENTITY
 *   · A cart is created lazily, on the first add. Its secret is a randomToken() kept in the httpOnly
 *     `tt_cart` cookie (SameSite=Lax, 60 days, renewed on every change); the database stores only
 *     sha256Hex(token) in `carts.token_hash` — the same lookup shell.server uses for the badge
 *     (SUM(cart_items.qty) of that hash while converted_order_id IS NULL).
 *   · A cart that belongs to a customer is only ever shown to that customer: a guest holding an old
 *     cookie of a signed-in customer's cart gets a fresh cart instead.
 *   · A signed-in customer's cart is the cookie's cart when it is theirs (or nobody's — then it is
 *     claimed), otherwise their most recently updated cart. When addToCart (or a route-facing change
 *     with `rekey`) reaches it the second way, the cart gets a new token so this device's cookie
 *     points at it (the badge counts by cookie); a device holding the old token then falls back to
 *     the customer lookup. setLineQty / removeLine / applyCoupon never re-key: they cannot hand a
 *     new token back.
 *   · mergeGuestCart (on sign-in) folds the customer's other cart into the cookie's cart.
 *   · The route-facing changeLineQty / deleteLine / changeCoupon return `{ cartToken, view }` so
 *     /api/cart can renew the cookie; the contract functions return the view only.
 *   · Abandoned carts are never deleted here; a cleanup job is not part of this module.
 *
 * PRICES AND STOCK ARE RE-CHECKED ON EVERY READ — nothing the browser sends is trusted:
 *   · unit price = the variant's (or used unit's) current price; `price_snapshot_iqd` remembers the
 *     price when the shopper last touched the line, and a difference is flagged `price_changed`.
 *   · problems, most serious first: `unavailable` (product not published, variant off, used unit no
 *     longer listed), `out_of_stock`, `qty_reduced` (more in the cart than can be sold — the view
 *     shows the reduced quantity and prices that), `price_changed`.
 *   · `out_of_stock` and `unavailable` lines are excluded from the totals and block checkout
 *     (`blocked`); `qty_reduced` and `price_changed` are notices.
 *   · Reads never write. The stored quantity is brought down to what can be sold on the next change.
 *   · A line holds at most 10 units (and never more than are available); a used unit is one line of
 *     qty 1 and must be `listed`; a cart holds at most 50 lines.
 *   · The coupon code is stored on the cart and evaluated again on every read. When it no longer
 *     applies the view drops it (discount 0, `coupon: null`) and says why in `couponIssue`; the code
 *     stays stored, so it comes back if the cart qualifies again — unless the coupon is gone for good
 *     (not found, expired, used up), in which case the next change removes it.
 *   · Shipping: the fee of the chosen governorate, or — before one is chosen — the flat fee as an
 *     estimate. Null for an empty cart or a governorate that is not served.
 *
 * Every service here takes `db` first and never imports "cloudflare:workers".
 */
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { CartLine, CartLineProblem, CartView, ImageRef, StockState } from "~/lib/dto";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import { DEFAULT_LOCALE, isLocale, pick, type L10n, type Locale } from "~/lib/locales";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { cartItems, carts, customers, files, media, products, usedUnits, variants, type Cart } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, invalid, isAppError, notFound } from "~/server/errors";
import { COUPON_ERROR_KEYS, evaluateCoupon, normalizeCouponCode, type CouponRejection } from "./coupons.server";
import { getAvailability } from "./inventory/stock.server";
import { computeTotals } from "./orders/totals";
import { getShippingFee, getShippingPolicy } from "./shipping/fees.server";

// ───────────────────────────────────────────────────────────────── constants and types

export const MAX_LINE_QTY = 10;
export const MAX_CART_LINES = 50;
/** `tt_cart` lives 60 days and is renewed on every change. */
export const CART_COOKIE_MAX_AGE_SEC = 60 * 24 * 60 * 60;

/** Error keys the cart can answer with (besides the coupon_* keys and the generic invalid / not_found / rate_limited). */
export const CART_ERROR_KEYS = ["unavailable", "out_of_stock", "insufficient_stock", "max_qty_reached", "cart_full", ...COUPON_ERROR_KEYS] as const;

/** Same shape the shell accepts for the cookie: 16–128 URL-safe characters. */
const CART_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const idSchema = z.string().regex(ID_PATTERN, "invalid");

/** Who the cart belongs to: the cookie's token and/or the signed-in customer. */
export type CartOwner = { cartToken: string | null; customerId: string | null };
/** Owner plus how the returned view should be presented. */
export type CartRequest = CartOwner & { locale?: Locale; governorateId?: string | null };

/** Why a stored coupon is not applied right now. */
export type CartCouponIssue = { code: string; reason: CouponRejection };

/**
 * CartView (~/lib/dto) plus `couponIssue`: the stored coupon that did not apply on this read and why
 * (show it as `errors.coupon_<reason>`). Null when no coupon is stored or it applied.
 */
export type CartViewData = CartView & { couponIssue: CartCouponIssue | null };

/** Problems that stop checkout. */
const BLOCKING: ReadonlySet<CartLineProblem> = new Set<CartLineProblem>(["out_of_stock", "unavailable"]);
/** Coupon refusals that will not change by themselves — the code is removed on the next change. */
const PERMANENT_COUPON_FAILURES: ReadonlySet<CouponRejection> = new Set<CouponRejection>(["not_found", "expired", "usage_limit"]);

export function isCartToken(value: unknown): value is string {
  return typeof value === "string" && CART_TOKEN_PATTERN.test(value);
}

function normalizeOwner(owner: CartOwner): CartOwner {
  return {
    cartToken: isCartToken(owner?.cartToken) ? owner.cartToken : null,
    customerId: typeof owner?.customerId === "string" && ID_PATTERN.test(owner.customerId) ? owner.customerId : null,
  };
}

const localeOf = (request: { locale?: Locale | string | null }): Locale => (isLocale(request.locale) ? request.locale : DEFAULT_LOCALE);

export function emptyCartView(): CartViewData {
  return { id: null, lines: [], count: 0, subtotalIqd: 0, discountIqd: 0, coupon: null, shippingIqd: null, totalIqd: 0, blocked: false, couponIssue: null };
}

// ───────────────────────────────────────────────────────────────── finding the cart

type FoundCart = { cart: Cart; via: "token" | "customer" };

async function findCart(db: Db, rawOwner: CartOwner): Promise<FoundCart | null> {
  const owner = normalizeOwner(rawOwner);
  if (owner.cartToken) {
    const byToken = await db
      .select()
      .from(carts)
      .where(and(eq(carts.tokenHash, await sha256Hex(owner.cartToken)), isNull(carts.convertedOrderId)))
      .get();
    if (byToken && (byToken.customerId === null || byToken.customerId === owner.customerId)) return { cart: byToken, via: "token" };
  }
  if (owner.customerId) {
    const byCustomer = await db
      .select()
      .from(carts)
      .where(and(eq(carts.customerId, owner.customerId), isNull(carts.convertedOrderId)))
      .orderBy(desc(carts.updatedAt), desc(carts.id))
      .limit(1)
      .get();
    if (byCustomer) return { cart: byCustomer, via: "customer" };
  }
  return null;
}

type ChangeTarget = { cartId: string; token: string | null; statements: BatchStatement[] };

/**
 * The cart a change applies to, with the statements that create, claim or re-key it, and the token
 * the cookie must hold afterwards (null = leave the cookie as it is). Nothing is written until the
 * caller runs the statements.
 *   · cookie cart → itself (claimed for the signed-in customer when nobody owned it);
 *   · customer's cart reached without the cookie → re-keyed only when `rekey` (the caller then MUST
 *     set the new token as the cookie), otherwise used as is;
 *   · no cart → `create` makes one (with a fresh token), otherwise null.
 */
async function cartForChange(db: Db, rawOwner: CartOwner, locale: Locale, now: number, options: { rekey: boolean; create: boolean }): Promise<ChangeTarget | null> {
  const owner = normalizeOwner(rawOwner);
  const found = await findCart(db, owner);
  if (found?.via === "token" && owner.cartToken) {
    const set = found.cart.customerId === null && owner.customerId ? { customerId: owner.customerId, updatedAt: now } : { updatedAt: now };
    return { cartId: found.cart.id, token: owner.cartToken, statements: [db.update(carts).set(set).where(eq(carts.id, found.cart.id))] };
  }
  if (found) {
    if (!options.rekey) return { cartId: found.cart.id, token: null, statements: [db.update(carts).set({ updatedAt: now }).where(eq(carts.id, found.cart.id))] };
    const token = randomToken();
    return { cartId: found.cart.id, token, statements: [db.update(carts).set({ tokenHash: await sha256Hex(token), updatedAt: now }).where(eq(carts.id, found.cart.id))] };
  }
  if (!options.create) return null;
  const token = randomToken();
  const cartId = newId("crt");
  return {
    cartId,
    token,
    statements: [db.insert(carts).values({ id: cartId, tokenHash: await sha256Hex(token), customerId: owner.customerId, couponCode: null, createdAt: now, updatedAt: now, locale })],
  };
}

// ───────────────────────────────────────────────────────────────── pricing a cart

type StoredLine = {
  id: string;
  variantId: string;
  usedUnitId: string | null;
  qty: number;
  priceSnapshotIqd: number | null;
  sku: string;
  variantTitle: L10n | null;
  variantOptions: Record<string, string> | null;
  variantPriceIqd: number;
  variantActive: boolean;
  productId: string;
  productSlug: string;
  productName: L10n;
  productKind: string;
  productStatus: string;
  publishAt: number | null;
  warrantyMonths: number | null;
  usedSlug: string | null;
  usedStatus: string | null;
  usedPriceIqd: number | null;
  usedGrade: string | null;
  usedWarrantyDays: number | null;
};

/** A priced line: the view line plus what an order line needs (server-side only). */
export type PricedCartLine = {
  line: CartLine;
  /** Counts towards the totals and can be ordered. */
  purchasable: boolean;
  sku: string;
  productId: string;
  productKind: string;
  name: L10n;
  options: Record<string, string> | null;
  /** New items: months from the product; used units: days from the unit. */
  warrantyMonths: number | null;
  warrantyDays: number | null;
};

/** The cart priced right now — what getCartView shows and what checkout orders. Server-side only. */
export type PricedCart = {
  view: CartViewData;
  cartId: string | null;
  lines: PricedCartLine[];
  /** The coupon as applied to this read (couponId for the redemption row), or null. */
  coupon: { couponId: string; code: string; discountIqd: number } | null;
};

function isSellableProduct(status: string, publishAt: number | null, now: number): boolean {
  return status === "published" || (status === "scheduled" && publishAt !== null && publishAt <= now);
}

async function loadStoredLines(db: Db, cartId: string): Promise<StoredLine[]> {
  return db
    .select({
      id: cartItems.id,
      variantId: cartItems.variantId,
      usedUnitId: cartItems.usedUnitId,
      qty: cartItems.qty,
      priceSnapshotIqd: cartItems.priceSnapshotIqd,
      sku: variants.sku,
      variantTitle: variants.title,
      variantOptions: variants.options,
      variantPriceIqd: variants.priceIqd,
      variantActive: variants.isActive,
      productId: products.id,
      productSlug: products.slug,
      productName: products.name,
      productKind: products.kind,
      productStatus: products.status,
      publishAt: products.publishAt,
      warrantyMonths: products.warrantyMonths,
      usedSlug: usedUnits.slug,
      usedStatus: usedUnits.status,
      usedPriceIqd: usedUnits.priceIqd,
      usedGrade: usedUnits.grade,
      usedWarrantyDays: usedUnits.warrantyDays,
    })
    .from(cartItems)
    .innerJoin(variants, eq(variants.id, cartItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(usedUnits, eq(usedUnits.id, cartItems.usedUnitId))
    .where(eq(cartItems.cartId, cartId))
    .orderBy(asc(cartItems.addedAt), asc(cartItems.id));
}

/** The first picture of each owner: used units prefer real photos; others keep the gallery order. */
async function loadImages(db: Db, owners: { variant: string[]; product: string[]; used_unit: string[] }): Promise<Map<string, ImageRef & { _alt: L10n | null }>> {
  const out = new Map<string, ImageRef & { _alt: L10n | null }>();
  if (owners.variant.length + owners.product.length + owners.used_unit.length === 0) return out;
  const rows = await db
    .select({
      ownerType: media.ownerType,
      ownerId: media.ownerId,
      artKey: media.artKey,
      alt: media.alt,
      isIllustration: media.isIllustration,
      sort: media.sort,
      storageKey: files.storageKey,
      visibility: files.visibility,
      width: files.width,
      height: files.height,
    })
    .from(media)
    .leftJoin(files, eq(files.id, media.fileId))
    .where(
      sql`${media.kind} IN ('image', 'render') AND (
        (${media.ownerType} = 'variant' AND ${media.ownerId} IN (SELECT value FROM json_each(${JSON.stringify(owners.variant)})))
        OR (${media.ownerType} = 'product' AND ${media.ownerId} IN (SELECT value FROM json_each(${JSON.stringify(owners.product)})))
        OR (${media.ownerType} = 'used_unit' AND ${media.ownerId} IN (SELECT value FROM json_each(${JSON.stringify(owners.used_unit)})))
      )`,
    )
    .orderBy(asc(media.sort), asc(media.id));
  // Per owner: used units real photos first, then gallery order; everything else gallery order.
  const sorted = [...rows].sort(
    (a, b) =>
      a.ownerType.localeCompare(b.ownerType) ||
      a.ownerId.localeCompare(b.ownerId) ||
      (a.ownerType === "used_unit" ? Number(a.isIllustration) - Number(b.isIllustration) : 0) ||
      a.sort - b.sort,
  );
  for (const row of sorted) {
    const key = `${row.ownerType}:${row.ownerId}`;
    if (out.has(key)) continue;
    // An uploaded file is only shown when it is public; a render needs its art key.
    const mediaKey = row.storageKey && row.visibility === "public" ? row.storageKey : null;
    if (!mediaKey && !row.artKey) continue;
    out.set(key, {
      artKey: mediaKey ? null : row.artKey,
      mediaKey,
      alt: "",
      _alt: row.alt,
      isIllustration: row.isIllustration,
      ...(mediaKey && row.width && row.height ? { width: row.width, height: row.height } : {}),
    });
  }
  return out;
}

async function customerPhone(db: Db, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  const row = await db.select({ phone: customers.phoneE164 }).from(customers).where(eq(customers.id, customerId)).get();
  return row?.phone ?? null;
}

type PriceOptions = {
  locale: Locale;
  customerId: string | null;
  governorateId?: string | null;
  /** The phone given at checkout, for per-customer coupon limits of guests. */
  phoneE164?: string | null;
  /** Evaluate this code instead of the stored one (applyCoupon). */
  couponCode?: string | null;
};

async function priceCart(db: Db, cart: Pick<Cart, "id" | "couponCode"> | null, options: PriceOptions, now: number): Promise<PricedCart> {
  if (!cart) return { view: emptyCartView(), cartId: null, lines: [], coupon: null };
  const stored = await loadStoredLines(db, cart.id);
  const variantLineIds = stored.filter((row) => row.usedUnitId === null).map((row) => row.variantId);
  const [availability, images] = await Promise.all([
    getAvailability(db, variantLineIds),
    loadImages(db, {
      variant: [...new Set(stored.filter((row) => row.usedUnitId === null).map((row) => row.variantId))],
      product: [...new Set(stored.map((row) => row.productId))],
      used_unit: stored.flatMap((row) => (row.usedUnitId ? [row.usedUnitId] : [])),
    }),
  ]);

  const priced: PricedCartLine[] = stored.map((row) => {
    const name = pick(row.productName, options.locale);
    const variantTitle = pick(row.variantTitle, options.locale) || null;
    let problem: CartLineProblem | null = null;
    let qty = row.qty;
    let maxQty: number;
    let stock: StockState;
    let unitPriceIqd: number;
    let image = images.get(`variant:${row.variantId}`) ?? images.get(`product:${row.productId}`);

    if (row.usedUnitId) {
      unitPriceIqd = row.usedPriceIqd ?? row.variantPriceIqd;
      image = images.get(`used_unit:${row.usedUnitId}`) ?? image;
      qty = 1;
      if (row.usedStatus === "listed") {
        stock = "in_stock";
        maxQty = 1;
      } else {
        problem = "unavailable";
        stock = "out_of_stock";
        maxQty = 0;
      }
    } else {
      unitPriceIqd = row.variantPriceIqd;
      const available = availability.get(row.variantId) ?? { available: 0, state: "out_of_stock" as const };
      stock = available.state;
      maxQty = Math.min(MAX_LINE_QTY, available.available);
      if (!row.variantActive || !isSellableProduct(row.productStatus, row.publishAt, now)) {
        problem = "unavailable";
        maxQty = 0;
      } else if (available.available <= 0) {
        problem = "out_of_stock";
        maxQty = 0;
      } else if (qty > maxQty) {
        qty = maxQty;
        problem = "qty_reduced";
      }
    }
    if (problem === null && row.priceSnapshotIqd !== null && row.priceSnapshotIqd !== unitPriceIqd) problem = "price_changed";
    const purchasable = problem === null || !BLOCKING.has(problem);
    const usedLabel = row.usedUnitId ? [variantTitle, row.usedGrade].filter(Boolean).join(" · ") || null : null;

    const line: CartLine = {
      id: row.id,
      kind: row.usedUnitId ? "used_unit" : "variant",
      variantId: row.variantId,
      usedUnitId: row.usedUnitId,
      href: row.usedUnitId && row.usedSlug ? `/used/${row.usedSlug}` : `/p/${row.productSlug}`,
      name,
      optionsLabel: row.usedUnitId ? usedLabel : variantTitle,
      unitPriceIqd,
      qty,
      maxQty,
      lineTotalIqd: unitPriceIqd * qty,
      image: image ? { artKey: image.artKey, mediaKey: image.mediaKey, alt: pick(image._alt, options.locale) || name, isIllustration: image.isIllustration, ...(image.width ? { width: image.width, height: image.height } : {}) } : { artKey: null, mediaKey: null, alt: name, isIllustration: true },
      stock,
      problem,
    };
    return {
      line,
      purchasable,
      sku: row.sku,
      productId: row.productId,
      productKind: row.productKind,
      name: row.productName,
      options: row.variantOptions,
      warrantyMonths: row.usedUnitId ? null : row.warrantyMonths,
      warrantyDays: row.usedUnitId ? row.usedWarrantyDays : null,
    };
  });

  const buyable = priced.filter((entry) => entry.purchasable);
  const subtotal = computeTotals({ lines: buyable.map((entry) => ({ unitPriceIqd: entry.line.unitPriceIqd, qty: entry.line.qty })), discountIqd: 0, shippingIqd: 0 }).subtotalIqd;

  // Coupon: evaluated on every read against the lines that can be bought.
  let coupon: PricedCart["coupon"] = null;
  let couponIssue: CartCouponIssue | null = null;
  let couponView: CartView["coupon"] = null;
  const code = options.couponCode !== undefined ? options.couponCode : cart.couponCode;
  if (code) {
    const phone = options.phoneE164 ?? (await customerPhone(db, options.customerId));
    const result = await evaluateCoupon(
      db,
      { code, subtotalIqd: subtotal, lines: buyable.map((entry) => ({ variantId: entry.line.variantId as string, qty: entry.line.qty, unitPriceIqd: entry.line.unitPriceIqd })), customerId: options.customerId, phoneE164: phone },
      now,
    );
    if (result.ok) {
      coupon = { couponId: result.couponId, code: result.code, discountIqd: result.discountIqd };
      couponView = { code: result.code, label: result.label };
    } else {
      couponIssue = { code: normalizeCouponCode(code) ?? code, reason: result.reason };
    }
  }

  let shippingIqd: number | null = null;
  if (buyable.length > 0) {
    if (options.governorateId) {
      try {
        shippingIqd = await getShippingFee(db, options.governorateId);
      } catch (error) {
        if (!isAppError(error, "shipping_unavailable")) throw error;
      }
    } else {
      shippingIqd = (await getShippingPolicy(db)).flatFeeIqd;
    }
  }

  const totals = computeTotals({
    lines: buyable.map((entry) => ({ unitPriceIqd: entry.line.unitPriceIqd, qty: entry.line.qty })),
    discountIqd: coupon?.discountIqd ?? 0,
    shippingIqd: shippingIqd ?? 0,
  });
  const view: CartViewData = {
    id: cart.id,
    lines: priced.map((entry) => entry.line),
    count: priced.reduce((sum, entry) => sum + entry.line.qty, 0),
    subtotalIqd: totals.subtotalIqd,
    discountIqd: totals.discountIqd,
    coupon: couponView,
    shippingIqd,
    totalIqd: totals.totalIqd,
    blocked: priced.some((entry) => entry.line.problem !== null && BLOCKING.has(entry.line.problem)),
    couponIssue,
  };
  return { view, cartId: cart.id, lines: priced, coupon };
}

/**
 * Statements that bring the stored cart in line with what can be sold (run with every change):
 * quantities above the limit or the stock come down, used units hold 1, and a coupon that is gone
 * for good is removed. Unavailable and out-of-stock lines stay until the shopper removes them, so
 * the cart can say what happened.
 */
function normalizeStatements(db: Db, cartId: string, priced: PricedCart): BatchStatement[] {
  const statements: BatchStatement[] = [];
  for (const entry of priced.lines) {
    if (entry.line.problem === "qty_reduced" && entry.line.qty > 0) {
      statements.push(db.update(cartItems).set({ qty: entry.line.qty }).where(and(eq(cartItems.id, entry.line.id), eq(cartItems.cartId, cartId))));
    }
  }
  if (priced.view.couponIssue && PERMANENT_COUPON_FAILURES.has(priced.view.couponIssue.reason)) {
    statements.push(db.update(carts).set({ couponCode: null }).where(eq(carts.id, cartId)));
  }
  return statements;
}

// ───────────────────────────────────────────────────────────────── reading

/** The cart as the shopper sees it right now. Never writes. */
export async function getCartView(db: Db, input: CartRequest, now: number): Promise<CartViewData> {
  const found = await findCart(db, input);
  return (await priceCart(db, found?.cart ?? null, { locale: localeOf(input), customerId: normalizeOwner(input).customerId, governorateId: input.governorateId ?? null }, now)).view;
}

/**
 * The cart priced for checkout — the view plus, per line, what an order line snapshots (sku, name,
 * options, warranty) and the applied coupon's id. Server-side only; placeOrder builds the order
 * from this, never from what the browser sent.
 */
export async function getCheckoutCart(db: Db, input: CartRequest & { phoneE164?: string | null }, now: number): Promise<PricedCart> {
  const found = await findCart(db, input);
  return priceCart(db, found?.cart ?? null, { locale: localeOf(input), customerId: normalizeOwner(input).customerId, governorateId: input.governorateId ?? null, phoneE164: input.phoneE164 ?? null }, now);
}

/** Number of items (sum of quantities) in the owner's cart. */
export async function getCartCount(db: Db, owner: CartOwner): Promise<number> {
  const found = await findCart(db, owner);
  if (!found) return 0;
  const row = await db
    .select({ n: sql<number>`coalesce(sum(${cartItems.qty}), 0)` })
    .from(cartItems)
    .where(eq(cartItems.cartId, found.cart.id))
    .get();
  return Number(row?.n ?? 0);
}

// ───────────────────────────────────────────────────────────────── changes

export const AddToCartInput = z
  .object({
    variantId: idSchema.optional(),
    usedUnitId: idSchema.optional(),
    qty: z.number().int("invalid").min(1, "too_small").max(MAX_LINE_QTY, "too_big").default(1),
  })
  .superRefine((value, ctx) => {
    if ((value.variantId ? 1 : 0) + (value.usedUnitId ? 1 : 0) !== 1) ctx.addIssue({ code: "custom", path: ["variantId"], message: "required" });
    if (value.usedUnitId && value.qty !== 1) ctx.addIssue({ code: "custom", path: ["qty"], message: "invalid" });
  });
export type AddToCartInput = z.input<typeof AddToCartInput>;

/**
 * What a change returns to the /api/cart route: the view, and the token the `tt_cart` cookie must
 * hold now (null = keep the cookie as it is). Set it on every change — it also renews the cookie.
 */
export type CartChangeResult = { cartToken: string | null; view: CartViewData };

/** Runs a change, prices the cart afresh, and brings the stored cart in line with what can be sold. */
async function finish(db: Db, target: ChangeTarget, statements: BatchStatement[], request: CartRequest, now: number): Promise<CartChangeResult> {
  await runBatch(db, statements);
  const cart = await db.select({ id: carts.id, couponCode: carts.couponCode }).from(carts).where(eq(carts.id, target.cartId)).get();
  const priced = await priceCart(db, cart ?? null, { locale: localeOf(request), customerId: normalizeOwner(request).customerId, governorateId: request.governorateId ?? null }, now);
  const cleanup = cart ? normalizeStatements(db, cart.id, priced) : [];
  // The view already shows the reduced quantities and the dropped coupon; this only stores them.
  if (cleanup.length > 0) await runBatch(db, cleanup);
  return { cartToken: target.token, view: priced.view };
}

/**
 * Adds a variant (qty 1–10) or one used unit. Creates the cart on first use and returns the token
 * for the `tt_cart` cookie (set it on every change). `added` is how many units actually went in:
 * the line never exceeds 10 or the stock.
 * Errors (AppError, 409 unless noted): unavailable · out_of_stock · insufficient_stock (no more
 * units than already in the cart) · max_qty_reached · cart_full · not_found (404) · invalid (400).
 */
export async function addToCart(db: Db, request: CartRequest, raw: unknown, now: number): Promise<{ cartToken: string; view: CartViewData; added: number }> {
  const input = AddToCartInput.parse(raw);
  const locale = localeOf(request);

  let line: { variantId: string; usedUnitId: string | null; priceIqd: number; cap: number };
  if (input.usedUnitId) {
    const unit = await db.select({ id: usedUnits.id, variantId: usedUnits.variantId, status: usedUnits.status, priceIqd: usedUnits.priceIqd }).from(usedUnits).where(eq(usedUnits.id, input.usedUnitId)).get();
    if (!unit) throw notFound("used_unit");
    if (unit.status !== "listed") throw new AppError("unavailable", 409, { detail: unit.id });
    line = { variantId: unit.variantId, usedUnitId: unit.id, priceIqd: unit.priceIqd, cap: 1 };
  } else {
    const variantId = input.variantId as string;
    const variant = await db
      .select({ id: variants.id, priceIqd: variants.priceIqd, isActive: variants.isActive, status: products.status, publishAt: products.publishAt })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(variants.id, variantId))
      .get();
    if (!variant) throw notFound("variant");
    if (!variant.isActive || !isSellableProduct(variant.status, variant.publishAt, now)) throw new AppError("unavailable", 409, { detail: variantId });
    const available = (await getAvailability(db, [variantId])).get(variantId)?.available ?? 0;
    if (available <= 0) throw new AppError("out_of_stock", 409, { detail: variantId });
    line = { variantId, usedUnitId: null, priceIqd: variant.priceIqd, cap: Math.min(MAX_LINE_QTY, available) };
  }

  // Adding always leaves this device holding the cart's token (a new cart, or a re-keyed one).
  const target = (await cartForChange(db, request, locale, now, { rekey: true, create: true })) as ChangeTarget & { token: string };
  const existing = await db
    .select({ id: cartItems.id, qty: cartItems.qty })
    .from(cartItems)
    .where(and(eq(cartItems.cartId, target.cartId), line.usedUnitId ? eq(cartItems.usedUnitId, line.usedUnitId) : and(eq(cartItems.variantId, line.variantId), isNull(cartItems.usedUnitId))))
    .get();
  if (line.usedUnitId && existing) {
    // Already in the cart: nothing to add, nothing to fail.
    const result = await finish(db, target, target.statements, request, now);
    return { cartToken: target.token, view: result.view, added: 0 };
  }
  const have = existing?.qty ?? 0;
  if (have >= MAX_LINE_QTY) throw new AppError("max_qty_reached", 409, { detail: line.variantId });
  if (have >= line.cap) throw new AppError("insufficient_stock", 409, { detail: line.variantId });
  if (!existing) {
    const lines = await db.select({ n: sql<number>`count(*)` }).from(cartItems).where(eq(cartItems.cartId, target.cartId)).get();
    if (Number(lines?.n ?? 0) >= MAX_CART_LINES) throw new AppError("cart_full", 409);
  }
  const addQty = Math.min(input.qty, line.cap - have);

  const statements = [...target.statements];
  if (line.usedUnitId) {
    statements.push(
      db
        .insert(cartItems)
        .values({ id: newId("cit"), cartId: target.cartId, variantId: line.variantId, usedUnitId: line.usedUnitId, qty: 1, addedAt: now, priceSnapshotIqd: line.priceIqd })
        // The only unique key a used-unit line can hit is (cart_id, used_unit_id): already in the cart.
        .onConflictDoNothing(),
    );
  } else {
    statements.push(
      db
        .insert(cartItems)
        .values({ id: newId("cit"), cartId: target.cartId, variantId: line.variantId, usedUnitId: null, qty: addQty, addedAt: now, priceSnapshotIqd: line.priceIqd })
        .onConflictDoUpdate({
          target: [cartItems.cartId, cartItems.variantId],
          targetWhere: sql`${cartItems.usedUnitId} IS NULL`,
          // A concurrent add cannot push the line past what was available when this one was checked.
          set: { qty: sql`min(${cartItems.qty} + excluded.qty, ${line.cap})`, priceSnapshotIqd: line.priceIqd },
        }),
    );
  }
  const result = await finish(db, target, statements, request, now);
  return { cartToken: target.token, view: result.view, added: line.usedUnitId ? 1 : addQty };
}

/**
 * `rekey`: whether a customer's cart reached without the cookie may get a new token. Only callers
 * that set the returned token as the cookie may pass true (the /api/cart route); the contract
 * functions below pass false so they never strand a token.
 */
type ChangeOptions = { rekey?: boolean };

async function targetLine(db: Db, request: CartRequest, lineId: string, now: number, options: ChangeOptions) {
  if (typeof lineId !== "string" || !ID_PATTERN.test(lineId)) throw invalid({ lineId: "invalid" });
  const target = await cartForChange(db, request, localeOf(request), now, { rekey: options.rekey === true, create: false });
  if (!target) return null;
  const row = await db
    .select({ id: cartItems.id, variantId: cartItems.variantId, usedUnitId: cartItems.usedUnitId, qty: cartItems.qty })
    .from(cartItems)
    .where(and(eq(cartItems.id, lineId), eq(cartItems.cartId, target.cartId)))
    .get();
  return { target, row: row ?? null };
}

/** setLineQty, also returning the cookie token (for the route). */
export async function changeLineQty(db: Db, request: CartRequest, lineId: string, qty: number, now: number, options: ChangeOptions = {}): Promise<CartChangeResult> {
  if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty < 0 || qty > MAX_LINE_QTY) throw invalid({ qty: typeof qty === "number" && qty > MAX_LINE_QTY ? "too_big" : "invalid" });
  if (qty === 0) return deleteLine(db, request, lineId, now, options);
  const found = await targetLine(db, request, lineId, now, options);
  if (!found?.row) throw notFound("cart_line");
  const { target, row } = found;
  const statements = [...target.statements];
  if (row.usedUnitId) {
    if (qty !== 1) throw invalid({ qty: "invalid" });
    return finish(db, target, statements, request, now);
  }
  const variant = await db
    .select({ priceIqd: variants.priceIqd, isActive: variants.isActive, status: products.status, publishAt: products.publishAt })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.id, row.variantId))
    .get();
  if (!variant || !variant.isActive || !isSellableProduct(variant.status, variant.publishAt, now)) throw new AppError("unavailable", 409, { detail: row.variantId });
  const available = (await getAvailability(db, [row.variantId])).get(row.variantId)?.available ?? 0;
  if (available <= 0) throw new AppError("out_of_stock", 409, { detail: row.variantId });
  const kept = Math.min(qty, MAX_LINE_QTY, available);
  // Touching the line acknowledges today's price.
  statements.push(db.update(cartItems).set({ qty: kept, priceSnapshotIqd: variant.priceIqd }).where(and(eq(cartItems.id, row.id), eq(cartItems.cartId, target.cartId))));
  return finish(db, target, statements, request, now);
}

/** removeLine, also returning the cookie token (for the route). */
export async function deleteLine(db: Db, request: CartRequest, lineId: string, now: number, options: ChangeOptions = {}): Promise<CartChangeResult> {
  const found = await targetLine(db, request, lineId, now, options);
  if (!found) return { cartToken: null, view: emptyCartView() };
  const statements = [...found.target.statements, db.delete(cartItems).where(and(eq(cartItems.id, lineId), eq(cartItems.cartId, found.target.cartId)))];
  return finish(db, found.target, statements, request, now);
}

/** applyCoupon, also returning the cookie token (for the route). */
export async function changeCoupon(db: Db, request: CartRequest, code: string | null, now: number, options: ChangeOptions = {}): Promise<CartChangeResult> {
  const typed = typeof code === "string" ? code.trim() : "";
  const wanted = typed === "" ? null : normalizeCouponCode(typed);
  if (typed !== "" && wanted === null) throw new AppError("coupon_not_found", 409, { fields: { code: "coupon_not_found" } });
  const locale = localeOf(request);
  const target = await cartForChange(db, request, locale, now, { rekey: options.rekey === true, create: false });
  if (!target) {
    if (wanted === null) return { cartToken: null, view: emptyCartView() };
    throw new AppError("coupon_not_applicable", 409, { fields: { code: "coupon_not_applicable" }, detail: wanted });
  }
  let stored: string | null = null;
  if (wanted !== null) {
    const priced = await priceCart(db, { id: target.cartId, couponCode: null }, { locale, customerId: normalizeOwner(request).customerId, governorateId: request.governorateId ?? null, couponCode: wanted }, now);
    if (!priced.coupon) {
      const reason = priced.view.couponIssue?.reason ?? "not_applicable";
      throw new AppError(`coupon_${reason}`, 409, { fields: { code: `coupon_${reason}` }, detail: wanted });
    }
    stored = priced.coupon.code;
  }
  return finish(db, target, [...target.statements, db.update(carts).set({ couponCode: stored }).where(eq(carts.id, target.cartId))], request, now);
}

/**
 * Sets a line's quantity (0 removes it). The quantity is limited to 10 and to the stock — the view
 * shows what was kept; a used unit only takes 1. Errors: not_found (404) · invalid (400) ·
 * unavailable · out_of_stock (409).
 */
export async function setLineQty(db: Db, request: CartRequest, lineId: string, qty: number, now: number): Promise<CartViewData> {
  return (await changeLineQty(db, request, lineId, qty, now)).view;
}

/** Removes a line. Removing a line that is already gone (or from no cart) is not an error. */
export async function removeLine(db: Db, request: CartRequest, lineId: string, now: number): Promise<CartViewData> {
  return (await deleteLine(db, request, lineId, now)).view;
}

/**
 * Applies a coupon code to the cart (null or "" removes it). The code is checked against the cart as
 * it is now; a refusal is AppError(`coupon_<reason>`, 409, { fields: { code } }) and leaves the cart
 * as it was.
 */
export async function applyCoupon(db: Db, request: CartRequest, code: string | null, now: number): Promise<CartViewData> {
  return (await changeCoupon(db, request, code, now)).view;
}

/**
 * On sign-in: the cart behind the cookie becomes the customer's cart, and the customer's other open
 * cart (another device, an earlier visit) is folded into it — quantities added up to the line limit,
 * used units kept once, the cookie cart's coupon preferred — then deleted. A cookie cart that belongs
 * to a different customer is left alone.
 */
export async function mergeGuestCart(db: Db, owner: CartOwner, now: number): Promise<void> {
  const { cartToken, customerId } = normalizeOwner(owner);
  if (!customerId || !cartToken) return;
  const guest = await db
    .select()
    .from(carts)
    .where(and(eq(carts.tokenHash, await sha256Hex(cartToken)), isNull(carts.convertedOrderId)))
    .get();
  if (!guest || (guest.customerId !== null && guest.customerId !== customerId)) return;
  const other = await db
    .select()
    .from(carts)
    .where(and(eq(carts.customerId, customerId), isNull(carts.convertedOrderId), ne(carts.id, guest.id)))
    .orderBy(desc(carts.updatedAt), desc(carts.id))
    .limit(1)
    .get();

  const statements: BatchStatement[] = [db.update(carts).set({ customerId, updatedAt: now, ...(guest.couponCode === null && other?.couponCode ? { couponCode: other.couponCode } : {}) }).where(eq(carts.id, guest.id))];
  if (other) {
    const [mine, theirs] = await Promise.all([
      db.select({ variantId: cartItems.variantId, usedUnitId: cartItems.usedUnitId }).from(cartItems).where(eq(cartItems.cartId, guest.id)),
      db.select().from(cartItems).where(eq(cartItems.cartId, other.id)).orderBy(desc(cartItems.addedAt), desc(cartItems.id)),
    ]);
    let room = MAX_CART_LINES - mine.length;
    const present = new Set(mine.map((row) => row.usedUnitId ?? `v:${row.variantId}`));
    for (const item of theirs) {
      const key = item.usedUnitId ?? `v:${item.variantId}`;
      if (present.has(key)) {
        if (!item.usedUnitId) {
          statements.push(
            db
              .update(cartItems)
              .set({ qty: sql`min(${cartItems.qty} + ${item.qty}, ${MAX_LINE_QTY})` })
              .where(and(eq(cartItems.cartId, guest.id), eq(cartItems.variantId, item.variantId), isNull(cartItems.usedUnitId))),
          );
        }
        continue;
      }
      if (room <= 0) continue;
      room--;
      present.add(key);
      statements.push(
        db.insert(cartItems).values({ id: newId("cit"), cartId: guest.id, variantId: item.variantId, usedUnitId: item.usedUnitId, qty: item.usedUnitId ? 1 : Math.min(item.qty, MAX_LINE_QTY), addedAt: item.addedAt, priceSnapshotIqd: item.priceSnapshotIqd }),
      );
    }
    statements.push(db.delete(carts).where(eq(carts.id, other.id)));
  }
  await runBatch(db, statements);
}
