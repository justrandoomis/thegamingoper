/**
 * DEMO exchange rate and coupons.
 *
 * The rate is a placeholder so the currency switch has something to show; its source label says
 * so, and the payable currency is always IQD. It is inserted once and never refreshed, so a rate
 * the owner sets later (newer `effective_at`) always wins.
 */
import type { CouponKind } from "../../schema";

export const DEMO_FX_RATE = {
  quote: "USD",
  iqdPerUnit: 1310,
  source: "سعر تجريبي — يحدده المتجر",
} as const;

export type CouponSeed = {
  /** Stored upper-case. */
  code: string;
  kind: CouponKind;
  /** `fixed`: IQD. `percent`: basis points (10% = 1000). */
  value: number;
  minSubtotalIqd: number;
  maxDiscountIqd?: number;
  usageLimit: number;
  perCustomerLimit: number;
  description: string;
};

export const DEMO_COUPONS: readonly CouponSeed[] = [
  {
    code: "DEMO10",
    kind: "percent",
    value: 1000,
    minSubtotalIqd: 50_000,
    maxDiscountIqd: 25_000,
    usageLimit: 500,
    perCustomerLimit: 1,
    description: "قسيمة تجريبية: خصم 10% بحد أقصى 25,000 د.ع على الطلبات من 50,000 د.ع فأكثر، مرة واحدة لكل زبون.",
  },
  {
    code: "DEMO5000",
    kind: "fixed",
    value: 5000,
    minSubtotalIqd: 100_000,
    usageLimit: 200,
    perCustomerLimit: 1,
    description: "قسيمة تجريبية: خصم 5,000 د.ع على الطلبات من 100,000 د.ع فأكثر، مرة واحدة لكل زبون.",
  },
];
