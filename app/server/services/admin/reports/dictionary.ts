/**
 * Admin 18.07 — the metrics dictionary as the admin shows it (client-safe data; the words are in the "admin-reports"
 * namespace under `dict.metric.<id>`).
 *
 * docs/metrics.md is the ONE place TamTam's business numbers are defined, and accounting/reports.server.ts is the one
 * implementation of its revenue, cost and profit figures. This list mirrors that document — one entry per metric of
 * every metric table (§3–§6, §8 marketing; not §1 rules, §2 postings, §7 checks), under the same English name
 * (`docName`; tests/admin-reports.test.ts fails when the two drift apart: a metric added there needs its entry here and
 * its words under `dict.metric.<id>` in app/i18n/messages/admin-reports.ts) — and
 * adds the report-level figures (`origin: "module"`), each written as a composition of those definitions or as the
 * owning module's own rule (supplier rating 09, RFM 07, turnover 04, service times 14, staff sales 15), never as a
 * second formula. Changing a definition is a change to docs/metrics.md and its implementation, not a form in the admin.
 */
import type { ReportKey } from "./types";

export type MetricSection = "3" | "4" | "5" | "6" | "8";
export type MetricOrigin = { kind: "metrics"; section: MetricSection; docName: string } | { kind: "module"; module: "04" | "07" | "09" | "11" | "14" | "15" | "18" };

export type MetricEntry = {
  id: string;
  origin: MetricOrigin;
  /** Field permissions the figure needs (absent without them, never 0). */
  needs: readonly ("cost.read" | "profit.read")[];
  /** The reports that show it. */
  usedIn: readonly ReportKey[];
  /** The code that computes it — the single implementation staff can point to. */
  code: string;
  /** False = not measurable yet: shown as "not available", never estimated. */
  available: boolean;
};

const m = (id: string, section: MetricSection, docName: string, code: string, options: { needs?: MetricEntry["needs"]; usedIn?: ReportKey[]; available?: boolean } = {}): MetricEntry => ({
  id,
  origin: { kind: "metrics", section, docName },
  needs: options.needs ?? [],
  usedIn: options.usedIn ?? [],
  code,
  available: options.available ?? true,
});

const own = (id: string, module: "04" | "07" | "09" | "11" | "14" | "15" | "18", code: string, options: { needs?: MetricEntry["needs"]; usedIn?: ReportKey[] } = {}): MetricEntry => ({
  id,
  origin: { kind: "module", module },
  needs: options.needs ?? [],
  usedIn: options.usedIn ?? [],
  code,
  available: true,
});

const REPORTS = "services/admin/reports";
const CORE = "accounting/reports.server.ts";
const COST = ["cost.read"] as const;
const PROFIT = ["cost.read", "profit.read"] as const;

export const METRICS: readonly MetricEntry[] = [
  // §3 sales
  m("orders_placed", "3", "Orders placed", `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  m("open_orders", "3", "Open orders", "services/admin/finance/revenue.server.ts realisedVsPending"),
  m("gmv", "3", "Gross merchandise value (GMV)", `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  m("paid_sales", "3", "Paid sales", `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  m("revenue", "3", "Revenue (gross)", `${CORE} revenueRecognised`, { usedIn: ["sales", "margin"] }),
  m("shipping_income", "3", "Shipping income", `${CORE} revenueRecognised`, { usedIn: ["sales"] }),
  m("discounts", "3", "Discounts", `${CORE} revenueRecognised`, { usedIn: ["sales", "margin"] }),
  m("refunds", "3", "Refunds", `${CORE} revenueRecognised`, { usedIn: ["sales", "margin"] }),
  m("net_revenue", "3", "Net revenue", `${CORE} revenueRecognised`, { usedIn: ["sales", "margin", "inventory"] }),
  m("aov", "3", 'Average order value (AOV, "average basket")', `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  m("units_sold", "3", "Units sold", `${REPORTS}/revenue.server.ts unitsByDimension`, { usedIn: ["sales", "margin", "inventory"] }),
  m("cancellation_rate", "3", "Cancellation rate", `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  m("refund_rate", "3", "Refund rate", `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  m("return_rate", "3", "Return rate", `${REPORTS}/sales.server.ts`, { usedIn: ["sales"] }),
  // §4 cost and profit
  m("cogs", "4", "COGS (landed)", `${CORE} profitAndLoss`, { needs: COST, usedIn: ["margin"] }),
  m("gross_profit", "4", "Gross profit", `${CORE} profitAndLoss`, { needs: PROFIT }),
  m("gross_margin", "4", "Gross margin", `${CORE} profitAndLoss`, { needs: PROFIT }),
  m("commissions", "4", "Commissions", `${CORE} profitAndLoss`, { needs: PROFIT, usedIn: ["margin"] }),
  m("shipping_costs", "4", "Shipping costs", `${CORE} profitAndLoss`, { needs: COST, usedIn: ["margin"] }),
  m("shipping_subsidy", "4", "Shipping subsidy", `${CORE} profitAndLoss`, { needs: COST, usedIn: ["margin"] }),
  m("net_profit", "4", "Net profit", `${CORE} profitAndLoss`, { needs: PROFIT, usedIn: ["margin"] }),
  m("net_margin", "4", "Net margin", `${CORE} profitAndLoss`, { needs: PROFIT, usedIn: ["margin"] }),
  m("operating_result", "4", "Operating result", `${CORE} profitAndLoss`, { needs: PROFIT }),
  m("order_profit", "4", "Profit of one order", `${REPORTS}/margin.server.ts`, { needs: PROFIT, usedIn: ["margin"] }),
  // §5 money held and owed
  m("wallet_liability", "5", "Wallet liability", "wallet.server.ts getWalletBalance · finance 10.07"),
  m("cod_outstanding", "5", "Cash on delivery outstanding", "services/admin/shipping/shipments.server.ts shippingOverview"),
  m("customer_advances", "5", "Customer advances", "services/admin/finance/revenue.server.ts realisedVsPending"),
  m("transfers_awaiting", "5", "Transfers awaiting verification", "services/admin/orders/queues.server.ts"),
  m("verification_time", "5", "Payment verification time", "—", { available: false }),
  m("stock_value", "5", "Stock value (inventory as an asset)", `${CORE} inventoryAsset`, { needs: COST }),
  // §6 conversion and funnel
  m("cart_conversion", "6", "Cart-to-order conversion", "—", { available: false }),
  m("checkout_completion", "6", "Checkout completion", "—", { available: false }),
  m("visitor_conversion", "6", "Visitor conversion rate", "—", { available: false }),
  // §8 marketing (admin 16) — the marketing module's definitions, shown here so every definition sits in one place
  m("marketing_spend", "8", "Marketing spend", "services/admin/marketing/performance.server.ts"),
  m("marketing_customer", "8", "Customer", "services/admin/marketing/performance.server.ts"),
  m("new_customer", "8", "New customer", "services/admin/marketing/performance.server.ts"),
  m("cac", "8", "CAC", "services/admin/marketing/performance.server.ts"),
  m("attributed_order", "8", "Attributed order", "services/admin/marketing/links.server.ts"),
  m("attributed_sales", "8", "Attributed sales", "services/admin/marketing/performance.server.ts"),
  m("roas", "8", "ROAS", "services/admin/marketing/performance.server.ts"),
  m("ltv", "8", "LTV", "services/admin/marketing/performance.server.ts"),
  m("ltv_cac", "8", "LTV ÷ CAC", "services/admin/marketing/performance.server.ts"),
  // the reports' own figures, each built from the definitions above or from the owning module's rule
  own("sales_attribution", "18", `${REPORTS}/revenue.server.ts`, { usedIn: ["sales"] }),
  own("sku_net_margin", "18", `${REPORTS}/margin.server.ts`, { needs: PROFIT, usedIn: ["margin"] }),
  own("abc_class", "18", `${REPORTS}/inventory.server.ts classify`, { usedIn: ["inventory"] }),
  own("turnover", "04", "services/admin/inventory/analytics.server.ts inventoryReport", { usedIn: ["inventory"] }),
  own("dead_stock", "04", "services/admin/inventory/analytics.server.ts inventoryReport", { usedIn: ["inventory"] }),
  own("cohort_retention", "18", `${REPORTS}/customers.server.ts`, { usedIn: ["customers"] }),
  own("repeat_rate", "18", `${REPORTS}/customers.server.ts`, { usedIn: ["customers"] }),
  own("customer_value", "07", "services/admin/customers/rfm.server.ts rfmFacts (paid − refunded)", { usedIn: ["customers"] }),
  own("rfm_segment", "07", "services/admin/customers/types.ts rfmOf", { usedIn: ["customers"] }),
  own("supplier_rating", "09", "services/admin/purchasing/rules.ts rateSupplier", { usedIn: ["performance"] }),
  own("employee_sales", "15", "services/admin/staff/performance.server.ts performance", { usedIn: ["performance"] }),
  own("delivery_success", "18", `${REPORTS}/performance.server.ts shippingPerformance`, { usedIn: ["performance"] }),
  own("first_attempt", "18", `${REPORTS}/performance.server.ts shippingPerformance`, { usedIn: ["performance"] }),
  own("failed_attempts", "11", `${REPORTS}/performance.server.ts shippingPerformance (delivery_attempts)`, { usedIn: ["performance"] }),
  own("cod_settlement_time", "18", `${REPORTS}/performance.server.ts shippingPerformance`, { usedIn: ["performance"] }),
  own("first_response", "14", "services/admin/support/metrics.server.ts supportMetrics", { usedIn: ["performance"] }),
  own("resolution_time", "14", "services/admin/support/metrics.server.ts supportMetrics", { usedIn: ["performance"] }),
];

export const METRIC_GROUPS = ["3", "4", "5", "6", "8", "reports"] as const;
export type MetricGroup = (typeof METRIC_GROUPS)[number];

export const groupOf = (entry: MetricEntry): MetricGroup => (entry.origin.kind === "metrics" ? entry.origin.section : "reports");
