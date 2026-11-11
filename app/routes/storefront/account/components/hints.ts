import type { Formatters } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { iqdText, isIqd } from "~/ui/PriceTag";
import type { AccountSectionKey } from "./AccountNav";
import { amount } from "./text";

type HintData = {
  counts: { orders: number; openOrders: number; addresses: number; savedDevices: number; unreadNotifications: number; wishlist: number; pendingTopups: number };
  wallet: { balanceIqd: number; pendingIqd: number };
};

/** The short facts beside each account section ("3 طلبات", the wallet balance, "2 جديد"). */
export function navHints(t: TFunction, f: Formatters, data: HintData): Partial<Record<AccountSectionKey | "wishlist", string | null>> {
  const { counts, wallet } = data;
  return {
    orders: counts.openOrders > 0 ? t("overview.openOrders", { count: counts.openOrders }) : t("overview.hintOrders", { count: counts.orders }),
    wallet: isIqd(wallet.balanceIqd) ? amount(iqdText(f, wallet.balanceIqd)) + (counts.pendingTopups > 0 ? ` · ${t("overview.hintTopups", { count: counts.pendingTopups })}` : "") : null,
    addresses: t("overview.hintAddresses", { count: counts.addresses }),
    devices: t("overview.hintDevices", { count: counts.savedDevices }),
    notifications: counts.unreadNotifications > 0 ? t("overview.hintNotifications", { count: counts.unreadNotifications }) : null,
    wishlist: counts.wishlist > 0 ? t("overview.hintWishlist", { count: counts.wishlist }) : null,
  };
}
