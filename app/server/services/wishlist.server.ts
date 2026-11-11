/**
 * Favourites (docs/CONTRACTS.md §3, account area) — "المفضلة".
 *
 *   const ids = await getWishlistIds(db, { customerId, cartToken });                 // hearts on a page
 *   const { wished, guestToken } = await toggleWishlist(db, who, productId, ctx.now);  // POST /api/wishlist
 *   await mergeGuestWishlist(db, { customerId, cartToken, wishToken }, ctx.now);      // on sign-in / sign-up
 *
 * OWNERS
 *   · A signed-in customer's favourites belong to the account (`wishlist_items.customer_id`).
 *   · A guest's favourites hang on the CART COOKIE: rows carry sha256(token) in `cart_token_hash` — the same token as
 *     `tt_cart`, so every area that knows the cart token can read them. Only the hash is stored.
 *   · A guest who has no cart yet gets a token minted here; the route keeps it in the `tt_wish` cookie (it is not a
 *     cart, so it never goes into `tt_cart`).
 *   · The cart service gives a guest a NEW token when it creates their first cart, or the next cart after an order.
 *     `tt_wish` remembers which token the rows were saved under, so the next wishlist call through this service
 *     (`reconcileGuestWishlist`) moves them to the current cart token instead of losing them. Readers that pass only
 *     `cartToken` see the moved rows from then on; passing `wishToken` too (see `wishlistWho`) sees them at once.
 *   · On sign-in the guest rows join the account and the guest rows are deleted, so the next person on a shared device
 *     does not see them.
 *
 * Limits: WISHLIST_LIMIT items per owner (`wishlist_full`, 409). Only published products can be added; removing
 * always works (a product that was archived meanwhile can still be taken off the list).
 *
 * Must not import "cloudflare:workers".
 */
import { and, desc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { ProductCardData } from "~/lib/dto";
import { newId, randomToken, sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { products, wishlistItems } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { getCardsByIds, MAX_CARD_IDS } from "~/server/services/catalog/cards.server";

/** Items one owner may keep. */
export const WISHLIST_LIMIT = 200;
/** The guest bridge cookie (see the file header). Same lifetime as the cart cookie. */
export const WISH_COOKIE = "tt_wish";
export const WISH_COOKIE_MAX_AGE_SEC = 60 * 24 * 60 * 60;
/** The cart cookie this service reads (owned by the commerce core; never written here). */
export const CART_COOKIE_NAME = "tt_cart";

export const WISHLIST_ERROR_KEYS = ["wishlist_full", "not_found", "invalid", "required"] as const;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Who the wishlist belongs to. `customerId` wins when set. `cartToken` is the `tt_cart` cookie; `wishToken` the
 * `tt_wish` cookie (optional — the contract's two fields are enough while the cart token has not changed).
 */
export type WishlistWho = { customerId: string | null; cartToken: string | null; wishToken?: string | null };

const isToken = (value: unknown): value is string => typeof value === "string" && TOKEN_PATTERN.test(value);
const isId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

/** Reads both cookies into a WishlistWho — for routes and the integration pass. */
export function wishlistWho(cookie: (name: string) => string | null, customerId: string | null): WishlistWho {
  const cartToken = cookie(CART_COOKIE_NAME);
  const wishToken = cookie(WISH_COOKIE);
  return { customerId: isId(customerId) ? customerId : null, cartToken: isToken(cartToken) ? cartToken : null, wishToken: isToken(wishToken) ? wishToken : null };
}

type Owner = { kind: "customer"; customerId: string } | { kind: "guest"; token: string; hash: string } | { kind: "none" };
type KnownOwner = Exclude<Owner, { kind: "none" }>;

function ownerWhere(owner: KnownOwner) {
  return owner.kind === "customer" ? eq(wishlistItems.customerId, owner.customerId) : and(isNull(wishlistItems.customerId), eq(wishlistItems.cartTokenHash, owner.hash));
}

/**
 * Statements that move guest rows from one token hash to another owner (a newer token, or an account), skipping
 * products the target already holds, then drop what is left under the old key.
 */
function moveStatements(db: Db, fromHash: string, to: { customerId: string } | { hash: string }): BatchStatement[] {
  const fromRows = and(isNull(wishlistItems.customerId), eq(wishlistItems.cartTokenHash, fromHash));
  const targetHas =
    "customerId" in to
      ? db.select({ productId: wishlistItems.productId }).from(wishlistItems).where(eq(wishlistItems.customerId, to.customerId))
      : db
          .select({ productId: wishlistItems.productId })
          .from(wishlistItems)
          .where(and(isNull(wishlistItems.customerId), eq(wishlistItems.cartTokenHash, to.hash)));
  const set = "customerId" in to ? { customerId: to.customerId, cartTokenHash: null } : { cartTokenHash: to.hash };
  return [db.update(wishlistItems).set(set).where(and(fromRows, notInArray(wishlistItems.productId, targetHas))), db.delete(wishlistItems).where(fromRows)];
}

/**
 * When the cart token changed since the guest's rows were saved (`wishToken` ≠ `cartToken`), moves the rows to the
 * cart token. Returns the token the guest's rows are keyed by now (what `tt_wish` should hold), or null when there is
 * no guest token at all. Signed-in customers: nothing to do (null).
 */
export async function reconcileGuestWishlist(db: Db, who: WishlistWho): Promise<string | null> {
  if (isId(who.customerId)) return null;
  const cart = isToken(who.cartToken) ? who.cartToken : null;
  const bridge = isToken(who.wishToken) ? who.wishToken : null;
  if (cart && bridge && cart !== bridge) {
    await runBatch(db, moveStatements(db, await sha256Hex(bridge), { hash: await sha256Hex(cart) }));
    return cart;
  }
  return cart ?? bridge;
}

/** The owner after reconciling a guest's tokens. */
async function resolveOwner(db: Db, who: WishlistWho): Promise<Owner> {
  if (isId(who.customerId)) return { kind: "customer", customerId: who.customerId };
  const token = await reconcileGuestWishlist(db, who);
  return token ? { kind: "guest", token, hash: await sha256Hex(token) } : { kind: "none" };
}

/** Product ids on the owner's list, newest first. A guest without any token has none. Never writes. */
export async function getWishlistIds(db: Db, who: WishlistWho): Promise<string[]> {
  if (isId(who.customerId)) {
    const rows = await db
      .select({ productId: wishlistItems.productId })
      .from(wishlistItems)
      .where(eq(wishlistItems.customerId, who.customerId))
      .orderBy(desc(wishlistItems.createdAt), desc(wishlistItems.id))
      .limit(WISHLIST_LIMIT);
    return rows.map((row) => row.productId);
  }
  const tokens = [who.cartToken, who.wishToken].filter(isToken);
  if (tokens.length === 0) return [];
  const hashes = [...new Set(await Promise.all(tokens.map((token) => sha256Hex(token))))];
  const rows = await db
    .select({ productId: wishlistItems.productId })
    .from(wishlistItems)
    .where(and(isNull(wishlistItems.customerId), inArray(wishlistItems.cartTokenHash, hashes)))
    .orderBy(desc(wishlistItems.createdAt), desc(wishlistItems.id))
    .limit(WISHLIST_LIMIT * hashes.length);
  return [...new Set(rows.map((row) => row.productId))].slice(0, WISHLIST_LIMIT);
}

/** Number of items on the owner's list. Never writes. */
export async function countWishlist(db: Db, who: WishlistWho): Promise<number> {
  return (await getWishlistIds(db, who)).length;
}

export type WishlistChange = {
  /** On the list after the call. */
  wished: boolean;
  /** Items on the list after the call. */
  count: number;
  /** Guests: the token the rows are keyed by now — keep it in the `tt_wish` cookie. Null for customers. */
  guestToken: string | null;
};

function parseProductId(productId: unknown): string {
  const value = typeof productId === "string" ? productId.trim() : "";
  if (value === "") throw invalid({ productId: "required" });
  if (!isId(value)) throw invalid({ productId: "invalid" });
  return value;
}

async function countFor(db: Db, owner: KnownOwner): Promise<number> {
  const row = await db.select({ n: sql<number>`count(*)` }).from(wishlistItems).where(ownerWhere(owner)).get();
  return Number(row?.n ?? 0);
}

async function hasRow(db: Db, owner: Owner, productId: string): Promise<boolean> {
  if (owner.kind === "none") return false;
  const row = await db
    .select({ id: wishlistItems.id })
    .from(wishlistItems)
    .where(and(ownerWhere(owner), eq(wishlistItems.productId, productId)))
    .get();
  return row !== undefined;
}

async function applyWish(db: Db, resolved: Owner, productId: string, wished: boolean, now: number): Promise<WishlistChange> {
  let owner = resolved;
  if (owner.kind === "none") {
    if (!wished) return { wished: false, count: 0, guestToken: null };
    const token = randomToken();
    owner = { kind: "guest", token, hash: await sha256Hex(token) };
  }
  const guestToken = owner.kind === "guest" ? owner.token : null;

  if (!wished) {
    await db.delete(wishlistItems).where(and(ownerWhere(owner), eq(wishlistItems.productId, productId)));
    return { wished: false, count: await countFor(db, owner), guestToken };
  }

  const product = await db.select({ status: products.status }).from(products).where(eq(products.id, productId)).get();
  if (!product || product.status !== "published") throw notFound("product");
  if (await hasRow(db, owner, productId)) return { wished: true, count: await countFor(db, owner), guestToken };
  if ((await countFor(db, owner)) >= WISHLIST_LIMIT) throw new AppError("wishlist_full", 409, { detail: String(WISHLIST_LIMIT) });

  await db
    .insert(wishlistItems)
    .values({
      id: newId("wsh"),
      customerId: owner.kind === "customer" ? owner.customerId : null,
      cartTokenHash: owner.kind === "guest" ? owner.hash : null,
      productId,
      createdAt: now,
    })
    // Two taps at once: the partial unique index (owner, product) keeps one row.
    .onConflictDoNothing();
  return { wished: true, count: await countFor(db, owner), guestToken };
}

/**
 * Puts a product on the list (`wished: true`) or takes it off (`false`). Idempotent. Adding needs a published product
 * (`not_found`, 404) and room on the list (`wishlist_full`, 409). A guest with no token gets a new one (`guestToken`).
 */
export async function setWished(db: Db, who: WishlistWho, productId: unknown, wished: boolean, now: number): Promise<WishlistChange> {
  const id = parseProductId(productId);
  return applyWish(db, await resolveOwner(db, who), id, wished, now);
}

/** Flips a product on or off the list (the contract's call; POST /api/wishlist intent=toggle). */
export async function toggleWishlist(db: Db, who: WishlistWho, productId: unknown, now: number): Promise<WishlistChange> {
  const id = parseProductId(productId);
  const owner = await resolveOwner(db, who);
  return applyWish(db, owner, id, !(await hasRow(db, owner, id)), now);
}

/**
 * On sign-in or sign-up: the guest's favourites (under the cart token and/or the bridge token) join the account;
 * products already on the account's list are kept once. Returns how many products joined.
 */
export async function mergeGuestWishlist(db: Db, who: WishlistWho, now: number): Promise<{ moved: number }> {
  void now;
  if (!isId(who.customerId)) return { moved: 0 };
  const customerId = who.customerId;
  const tokens = [...new Set([who.cartToken, who.wishToken].filter(isToken))];
  if (tokens.length === 0) return { moved: 0 };
  const hashes = await Promise.all(tokens.map((token) => sha256Hex(token)));
  const before = await countFor(db, { kind: "customer", customerId });
  await runBatch(
    db,
    hashes.flatMap((hash) => moveStatements(db, hash, { customerId })),
  );
  return { moved: (await countFor(db, { kind: "customer", customerId })) - before };
}

/**
 * For the commerce core, should it ever give an existing guest cart a new token on the same device: moves the guest
 * rows of the old token to the new one. (The cart does not call it today — `tt_wish` covers the cases it creates.)
 */
export async function rekeyGuestWishlist(db: Db, fromToken: string, toToken: string): Promise<void> {
  if (!isToken(fromToken) || !isToken(toToken) || fromToken === toToken) return;
  await runBatch(db, moveStatements(db, await sha256Hex(fromToken), { hash: await sha256Hex(toToken) }));
}

export type WishlistPage = {
  /** Cards of the products that can still be shown, newest addition first. */
  items: ProductCardData[];
  /** Product ids on the list (all of them, including those no longer shown). */
  ids: string[];
  /** On the list but no longer in the catalogue (unpublished, or without an active variant). */
  unavailable: number;
};

/** The wishlist page: the cards of the owner's favourites. Never writes (reconcile first if the cookies differ). */
export async function listWishlist(db: Db, who: WishlistWho, locale: Locale, now: number): Promise<WishlistPage> {
  const ids = await getWishlistIds(db, who);
  const items: ProductCardData[] = [];
  for (let i = 0; i < ids.length; i += MAX_CARD_IDS) items.push(...(await getCardsByIds(db, locale, ids.slice(i, i + MAX_CARD_IDS), { now })));
  return { items, ids, unavailable: ids.length - items.length };
}

/** True when the product is on the owner's list. Never writes. */
export async function isWished(db: Db, who: WishlistWho, productId: string): Promise<boolean> {
  if (!isId(productId)) return false;
  return (await getWishlistIds(db, who)).includes(productId);
}

/** The ids among `productIds` that are on the owner's list — for pages that show many hearts. Never writes. */
export async function wishedAmong(db: Db, who: WishlistWho, productIds: readonly string[]): Promise<Set<string>> {
  const wanted = new Set(productIds.filter(isId));
  if (wanted.size === 0) return new Set();
  return new Set((await getWishlistIds(db, who)).filter((id) => wanted.has(id)));
}
