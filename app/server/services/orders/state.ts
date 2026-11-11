/**
 * The order state machine — pure data, client-safe (the admin shows the next possible actions).
 *
 *   new ──────────────► confirmed ──► preparing ──► shipped ──► delivered ──► returned
 *    │                     ▲   │          │            │
 *    │  awaiting_payment ──┼───┼──────────┼────────────┴──► returned (delivery failed, parcel back)
 *    │     │    ▲          │   │          │
 *    │     ▼    │ reject   │   │          │
 *    │  payment_review ────┘ approve      │
 *    ▼     ▼                ▼             ▼
 *  cancelled ◄──────────────┴─────────────┘
 *
 * Entry states: cash on delivery → `new`; wallet → `confirmed` (paid at checkout);
 * bank transfer / Zain Cash → `awaiting_payment`.
 *
 * The moves between awaiting_payment, payment_review and confirmed belong to the payment flow
 * (submitPaymentProof, verifyPayment): transitionOrder refuses them, so an order is never
 * confirmed without a verified payment.
 */
import type { OrderStatus } from "~/lib/dto";

export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "cancelled"],
  awaiting_payment: ["payment_review", "cancelled"],
  payment_review: ["confirmed", "awaiting_payment", "cancelled"],
  confirmed: ["preparing", "shipped", "cancelled"],
  preparing: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
  cancelled: [],
  returned: [],
};

/** Moves made only by the payment services. */
export const PAYMENT_DRIVEN_TRANSITIONS: readonly (readonly [OrderStatus, OrderStatus])[] = [
  ["awaiting_payment", "payment_review"],
  ["payment_review", "confirmed"],
  ["payment_review", "awaiting_payment"],
];

/** Statuses after which nothing more happens to the order itself. */
export const FINAL_ORDER_STATUSES: readonly OrderStatus[] = ["cancelled", "returned"];

/** An order whose goods have left the store (stock committed). */
export const SHIPPED_ORDER_STATUSES: readonly OrderStatus[] = ["shipped", "delivered", "returned"];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isPaymentDriven(from: OrderStatus, to: OrderStatus): boolean {
  return PAYMENT_DRIVEN_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

/** The transitions an employee can make from `from` by hand (what the admin offers as actions). */
export function manualTransitions(from: OrderStatus): OrderStatus[] {
  return (ORDER_TRANSITIONS[from] ?? []).filter((to) => !isPaymentDriven(from, to));
}
