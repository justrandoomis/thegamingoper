import type { IconName } from "~/art/Icon";
import type { ActivityTone } from "./Activity";

/**
 * How the points and the wallet history read (Design v2.1, the rewards page and the wallet): which filter an entry
 * belongs under, its words, icon and tone. Pure — the page and the tests share it.
 */

/** The history's filter chips (`?show=`): all · earned · used · expired. */
export const POINTS_FILTERS = ["all", "earned", "used", "expired"] as const;
export type PointsFilter = (typeof POINTS_FILTERS)[number];

type PointsEntry = { kind: "earn" | "redeem" | "expire" | "adjust" | "reversal"; points: number; refType: string | null };

/** `?show=` as a filter ("all" for anything else). */
export function pointsFilter(value: unknown): PointsFilter {
  return typeof value === "string" && (POINTS_FILTERS as readonly string[]).includes(value) ? (value as PointsFilter) : "all";
}

/**
 * Whether an entry is shown under a filter. Each chip shows exactly what its name says: «المكتسبة» every credit (an
 * order, a referral, the store's own, points given back), «المستخدمة» the points redeemed in an order, «المنتهية» the
 * points that expired. Points taken back after a refund and the store's deductions show under «الكل» only.
 */
export function inPointsFilter(entry: PointsEntry, filter: PointsFilter): boolean {
  switch (filter) {
    case "earned":
      return entry.points > 0;
    case "used":
      return entry.kind === "redeem";
    case "expired":
      return entry.kind === "expire";
    default:
      return true;
  }
}

/** How many entries each chip holds. */
export function pointsFilterCounts(entries: readonly PointsEntry[]): Record<PointsFilter, number> {
  const counts: Record<PointsFilter, number> = { all: 0, earned: 0, used: 0, expired: 0 };
  for (const entry of entries) for (const filter of POINTS_FILTERS) if (inPointsFilter(entry, filter)) counts[filter] += 1;
  return counts;
}

/** The words (a `rewards.kinds.*` key), icon and tone of a points entry. */
export function pointsLook(entry: PointsEntry): { key: string; icon: IconName; tone: ActivityTone } {
  if (entry.kind === "earn" && entry.refType === "referral") return { key: "earnReferral", icon: "users", tone: "ok" };
  // a redemption given back (a cancelled order, a refund) — module 08's reversal rows of ref "redeem"
  if (entry.kind === "reversal" && entry.refType === "redeem") return { key: "returned", icon: "arrow-counter-clockwise", tone: "info" };
  switch (entry.kind) {
    case "earn":
      return { key: "earn", icon: "shopping-bag", tone: "ok" };
    case "redeem":
      return { key: "redeem", icon: "shopping-cart-simple", tone: "red" };
    case "expire":
      return { key: "expire", icon: "hourglass", tone: "neutral" };
    case "reversal":
      return { key: "reversal", icon: "arrow-counter-clockwise", tone: "red" };
    default:
      return { key: "adjust", icon: "storefront", tone: entry.points < 0 ? "red" : "ok" };
  }
}

export type WalletKind = "topup" | "purchase" | "refund" | "trade_in_credit" | "gift_card" | "adjustment";

/** The icon and tone of a wallet entry (its words are the kit's `ui-shop:wallet.kinds.*`). */
export function walletLook(entry: { kind: WalletKind; amountIqd: number }): { icon: IconName; tone: ActivityTone } {
  switch (entry.kind) {
    case "topup":
      return { icon: "plus", tone: "ok" };
    case "purchase":
      return { icon: "shopping-cart-simple", tone: "red" };
    case "refund":
      return { icon: "arrow-counter-clockwise", tone: "info" };
    case "trade_in_credit":
      return { icon: "recycle", tone: "ok" };
    case "gift_card":
      return { icon: "gift", tone: "ok" };
    default:
      return { icon: "storefront", tone: entry.amountIqd < 0 ? "red" : "ok" };
  }
}

/** A signed whole number as text: "+1,500", "−1,000" (a real minus), "0". */
export function signedText(value: number, number: (n: number) => string): { text: string; sign: "credit" | "debit" | "zero" } {
  if (value > 0) return { text: `+${number(value)}`, sign: "credit" };
  if (value < 0) return { text: `−${number(-value)}`, sign: "debit" };
  return { text: number(0), sign: "zero" };
}
