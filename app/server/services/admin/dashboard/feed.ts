/**
 * Admin 01.07 — which audit events the activity feed shows, and to whom. Data for activity.server.ts (tested).
 *
 * The feed shows three kinds of event from the audit trail: price changes, returns and approvals (the decisions of a
 * second person on a request). Every action it shows is listed here with the permissions that open the module's own
 * screen of that record (ANY of them): an employee sees a line only when they hold one of them, and a link only to a
 * page they may open. An action that is not listed never appears (fail closed) — new actions are added here on
 * purpose. `branchScoped` lines come from modules that limit their lists to the employee's branch: an employee with a
 * branch limit does not see them here (the feed cannot apply each module's branch rule; their module screens do).
 * Where a module exports its readers, they are reused, not copied (the used-device price page: SPECIAL_READERS).
 */
import type { Permission } from "~/server/permissions";
import { SPECIAL_READERS } from "~/server/services/admin/pricing/special.server";
import type { FeedKind } from "./types";

/** What the record of a line is, which decides its label and its link. */
export type FeedEntity =
  | "variant"
  | "used_unit"
  | "return"
  | "refund"
  | "payment"
  | "purchase_order"
  | "supplier_invoice"
  | "expense"
  | "wallet_topup"
  | "wallet_adjustment"
  | "cycle_count"
  | "leave_request"
  | "payroll_run"
  | "advance"
  | "setting"
  | "knowledge_article"
  | "pos_shift"
  | "coupon"
  | "discount_rule"
  | "flash_sale"
  | "points"
  | "gift_card";

export type FeedRule = {
  kind: FeedKind;
  entity: FeedEntity;
  read: readonly Permission[];
  branchScoped?: boolean;
  price?: boolean;
  /**
   * A JSON path of the event's `after` that must be set for the event to be a line: a gift card's issue is an approval
   * only when it carries the approval it follows (a card issued alone, under the limit, is no decision of a second
   * person). Read in SQL, nothing else of the snapshot.
   */
  onlyWith?: "$.approvalId";
};

/** Every pricing permission opens the SKU price pages (pricing's SKU_READERS). */
const PRICING: readonly Permission[] = [
  "pricing.price.update",
  "pricing.price.approve",
  "pricing.cost.update",
  "pricing.margin.manage",
  "pricing.simulation.run",
  "pricing.suggestion.read",
  "pricing.price_list.manage",
  "pricing.discount.override",
  "pricing.used.update",
  "pricing.fx_rate.manage",
];
const RETURNS: readonly Permission[] = ["returns.rma.read"];
const ORDERS: readonly Permission[] = ["orders.order.read"];
const WALLETS: readonly Permission[] = ["finance.wallet.read"];
const STAFF_LEAVE: readonly Permission[] = ["staff.leave.approve", "staff.employee.read"];
const STAFF_PAY: readonly Permission[] = ["staff.payroll.read", "staff.payroll.run", "staff.payroll.approve"];
// promotions' SECTION_READ (services/admin/promotions/shared.server.ts)
const COUPONS: readonly Permission[] = ["promotions.promotion.read", "promotions.coupon.manage"];
const RULES: readonly Permission[] = ["promotions.promotion.read", "promotions.rule.manage"];
const FLASH: readonly Permission[] = ["promotions.promotion.read", "promotions.flash_sale.manage"];
const POINTS: readonly Permission[] = ["promotions.promotion.read", "promotions.loyalty.manage", "promotions.loyalty.adjust"];
const GIFT_CARDS: readonly Permission[] = ["promotions.promotion.read", "promotions.gift_card.issue", "promotions.gift_card.manage"];

/**
 * A price change. A used device's price lives on the pricing module's used-device page (/admin/pricing/special): it
 * opens only for SPECIAL_READERS (no exchange-rate or price-list permission), and an employee limited to a branch sees
 * the devices kept at their branch only (SECURITY §7) — so those lines are theirs only without a branch limit.
 */
const price = (entity: "variant" | "used_unit", withPrice: boolean): FeedRule =>
  entity === "used_unit" ? { kind: "price", entity, read: SPECIAL_READERS, price: withPrice, branchScoped: true } : { kind: "price", entity, read: PRICING, price: withPrice };
const ret = (): FeedRule => ({ kind: "return", entity: "return", read: RETURNS });
const approval = (entity: FeedEntity, read: readonly Permission[], branchScoped = false): FeedRule => ({ kind: "approval", entity, read, branchScoped });

export const FEED_RULES: Readonly<Record<string, FeedRule>> = {
  // ── price changes (03): a change applied at once, a request, its decision
  "pricing.price.change": price("variant", true),
  "pricing.price.request": price("variant", true),
  "pricing.price.approve": price("variant", true),
  "pricing.price.reject": price("variant", false),
  "pricing.price.cancel": price("variant", false),
  "pricing.used.price": price("used_unit", true),
  "pricing.used.request": price("used_unit", true),
  "pricing.used.approve": price("used_unit", true),
  "pricing.used.reject": price("used_unit", false),
  "pricing.used.cancel": price("used_unit", false),

  // ── returns (12)
  "returns.rma.create": ret(),
  "returns.rma.approve": ret(),
  "returns.rma.reject": ret(),
  "returns.rma.in_transit": ret(),
  "returns.rma.inspect": ret(),
  "returns.rma.refund": ret(),
  "returns.rma.refund_approved": ret(),
  "returns.rma.refund_rejected": ret(),
  "returns.rma.repair": ret(),
  "returns.rma.close": ret(),
  "returns.rma.cancel": ret(),

  // ── approvals: a second person's decision on a request
  "orders.refund.approve": approval("refund", ORDERS),
  "orders.refund.reject": approval("refund", ORDERS),
  "orders.payment.verify": approval("payment", ORDERS),
  "orders.payment.override": approval("payment", ORDERS),
  "orders.payment.reject": approval("payment", ORDERS),
  "purchasing.po.approve": approval("purchase_order", ["purchasing.po.read"], true),
  "purchasing.po.reject": approval("purchase_order", ["purchasing.po.read"], true),
  "purchasing.invoice.approve": approval("supplier_invoice", ["purchasing.invoice.manage"], true),
  "finance.expense.approve": approval("expense", ["finance.expense.manage"]),
  "finance.wallet.topup_first_approval": approval("wallet_topup", WALLETS),
  "finance.wallet.topup_approve": approval("wallet_topup", WALLETS),
  "finance.wallet.topup_reject": approval("wallet_topup", WALLETS),
  "finance.wallet.adjustment_approve": approval("wallet_adjustment", WALLETS),
  "finance.wallet.adjustment_reject": approval("wallet_adjustment", WALLETS),
  "inventory.count.approve": approval("cycle_count", ["inventory.stock.read"], true),
  "staff.leave.approve": approval("leave_request", STAFF_LEAVE, true),
  "staff.leave.reject": approval("leave_request", STAFF_LEAVE, true),
  "staff.payroll.run_approve": approval("payroll_run", STAFF_PAY, true),
  "staff.payroll.advance_approve": approval("advance", STAFF_PAY, true),
  "staff.payroll.advance_reject": approval("advance", STAFF_PAY, true),
  "settings.change.approve": approval("setting", ["settings.read"]),
  "settings.change.reject": approval("setting", ["settings.read"]),
  "support.knowledge.approve": approval("knowledge_article", ["support.knowledge.manage", "support.knowledge.approve"]),
  "support.knowledge.reject": approval("knowledge_article", ["support.knowledge.manage", "support.knowledge.approve"]),
  // a pending revision of an approved article, decided by a second person
  "support.knowledge.revision_approve": approval("knowledge_article", ["support.knowledge.manage", "support.knowledge.approve"]),
  "support.knowledge.revision_reject": approval("knowledge_article", ["support.knowledge.manage", "support.knowledge.approve"]),
  "pos.shift.review": approval("pos_shift", ["pos.shift.review"], true),
  "promotions.coupon.approve": approval("coupon", COUPONS),
  "promotions.coupon.reject": approval("coupon", COUPONS),
  "promotions.rule.approve": approval("discount_rule", RULES),
  "promotions.rule.reject": approval("discount_rule", RULES),
  "promotions.flash.approve": approval("flash_sale", FLASH),
  "promotions.flash.reject": approval("flash_sale", FLASH),
  "promotions.loyalty.approve": approval("points", POINTS),
  "promotions.loyalty.reject": approval("points", POINTS),
  // the module records a second person's approval as the card's issue, carrying the approval (giftcards.server.ts)
  "promotions.gift_card.issue": { ...approval("gift_card", GIFT_CARDS), onlyWith: "$.approvalId" },
  "promotions.gift_card.reject": approval("gift_card", GIFT_CARDS),
};

export const FEED_ACTIONS: readonly string[] = Object.keys(FEED_RULES);

/** The page of a line's record, from the entity's id and the label the feed resolved; null when there is none. */
export function feedHref(entity: FeedEntity, id: string | null, label: string | null): string | null {
  if (!id) return null;
  const at = encodeURIComponent(id);
  switch (entity) {
    case "variant":
      return `/admin/pricing/skus/${at}`;
    case "used_unit":
      return "/admin/pricing/special";
    case "return":
      return label && /^RMA-[A-Z0-9]+$/.test(label) ? `/admin/returns/${label}` : "/admin/returns";
    case "refund":
    case "payment":
      return label ? `/admin/orders/${encodeURIComponent(label)}` : null;
    case "purchase_order":
      return `/admin/purchasing/orders/${at}`;
    case "supplier_invoice":
      return `/admin/purchasing/invoices/${at}`;
    case "expense":
      return `/admin/finance/expenses/${at}`;
    case "wallet_topup":
      return `/admin/finance/wallets/topups/${at}`;
    case "wallet_adjustment":
      return `/admin/finance/wallets/${at}`;
    case "cycle_count":
      return `/admin/inventory/counts/${at}`;
    case "leave_request":
      return "/admin/staff/leave";
    case "payroll_run":
      return `/admin/staff/payroll/${at}`;
    case "advance":
      return "/admin/staff/payroll/advances";
    case "setting":
      return `/admin/settings/keys/${at}`;
    case "knowledge_article":
      return `/admin/support/knowledge/${at}`;
    case "pos_shift":
      return `/admin/pos/shifts/${at}`;
    case "coupon":
      return `/admin/promotions/coupons/${at}`;
    case "discount_rule":
      return `/admin/promotions/rules/${at}`;
    case "flash_sale":
      return `/admin/promotions/flash/${at}`;
    case "points":
      return `/admin/promotions/points/${at}`;
    case "gift_card":
      return `/admin/promotions/gift-cards/${at}`;
  }
}
