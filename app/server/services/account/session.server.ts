/**
 * What happens around signing in, and the numbers of the account overview.
 *
 *   const after = await afterSignIn(db, { customerId, cartToken, wishToken, devicePersonalization }, ctx.now);
 *   // → the guest cart became the account's (commerce core mergeGuestCart), guest favourites joined the account,
 *   //   guest history joined it too when consent allows; `personalization` is the account's stored answer.
 *   const counts = await getAccountCounts(db, customerId, ctx.now);
 *
 * A signed-in customer is never asked to sign in again at checkout: sessions last 30 days from the last visit
 * (~/server/auth/customer.server) and the sign-in page returns to `next` (e.g. /checkout).
 * Must not import "cloudflare:workers".
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { sha256Hex } from "~/lib/ids";
import type { Db } from "~/server/db/drizzle.server";
import { addresses, notifications, orders, recentlyViewed, savedDevices, walletTopups, wishlistItems } from "~/server/db/schema";
import { mergeGuestCart } from "~/server/services/cart.server";
import { mergeGuestWishlist } from "~/server/services/wishlist.server";
import { getConsent } from "./preferences.server";
import { mergeGuestRecentlyViewed } from "./recently-viewed.server";
import type { AccountCounts } from "./types";

const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

export type SignInContext = {
  customerId: string;
  /** `tt_cart` */
  cartToken: string | null;
  /** `tt_wish` */
  wishToken: string | null;
  /** This device's personalization answer (`tt_consent`): true / false / null = never asked here. */
  devicePersonalization: boolean | null;
};

/**
 * Brings the guest's things into the account right after sign-in or sign-up. Returns the account's stored
 * personalization answer, so the route can give this device the same answer when it has none.
 */
export async function afterSignIn(db: Db, input: SignInContext, now: number): Promise<{ personalization: boolean | null }> {
  const cartToken = input.cartToken && TOKEN.test(input.cartToken) ? input.cartToken : null;
  const wishToken = input.wishToken && TOKEN.test(input.wishToken) ? input.wishToken : null;
  await mergeGuestCart(db, { cartToken, customerId: input.customerId }, now);
  await mergeGuestWishlist(db, { customerId: input.customerId, cartToken, wishToken }, now);

  const personalization = await getConsent(db, { subjectType: "customer", subjectId: input.customerId }, "personalization");
  if (cartToken) {
    if (input.devicePersonalization === true && personalization !== false) {
      await mergeGuestRecentlyViewed(db, input.customerId, cartToken);
    } else {
      // The account said no (or this device never agreed): the guest history is not kept.
      const hash = await sha256Hex(cartToken);
      await db.delete(recentlyViewed).where(and(isNull(recentlyViewed.customerId), eq(recentlyViewed.cartTokenHash, hash)));
    }
  }
  return { personalization };
}

const OPEN_ORDER_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped"] as const;

/** The numbers beside the account's sections. One round trip. */
export async function getAccountCounts(db: Db, customerId: string): Promise<AccountCounts> {
  const count = sql<number>`count(*)`;
  const [allOrders, open, addressRows, devices, unread, wished, pending] = await db.batch([
    db.select({ n: count }).from(orders).where(eq(orders.customerId, customerId)),
    db
      .select({ n: count })
      .from(orders)
      .where(and(eq(orders.customerId, customerId), inArray(orders.status, [...OPEN_ORDER_STATUSES]))),
    db.select({ n: count }).from(addresses).where(eq(addresses.customerId, customerId)),
    db.select({ n: count }).from(savedDevices).where(eq(savedDevices.customerId, customerId)),
    db
      .select({ n: count })
      .from(notifications)
      .where(and(eq(notifications.customerId, customerId), isNull(notifications.readAt))),
    db.select({ n: count }).from(wishlistItems).where(eq(wishlistItems.customerId, customerId)),
    db
      .select({ n: count })
      .from(walletTopups)
      .where(and(eq(walletTopups.customerId, customerId), eq(walletTopups.status, "pending_verification"))),
  ]);
  const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
  return {
    orders: n(allOrders),
    openOrders: n(open),
    addresses: n(addressRows),
    savedDevices: n(devices),
    unreadNotifications: n(unread),
    wishlist: n(wished),
    pendingTopups: n(pending),
  };
}
