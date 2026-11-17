/**
 * The payout decision (10.07, 2026-11-13) as a route action — shared by /admin/finance/wallets (the queue) and
 * /admin/finance/wallets/:customerId (one customer's wallet). The service checks everything again (decidePayout →
 * the core's decideWalletPayout: customers.wallet.adjust, never the requester, the amount the decider saw).
 */
import { decidePayout } from "~/server/services/admin/finance/wallets.server";
import { failed, financeT, ok, text, type FinanceRequest } from "./finance.server";
import { parseAmount } from "~/server/services/admin/finance/types";

export const PAYOUT_INTENT = "payout";

export async function payoutAction(req: FinanceRequest, form: FormData) {
  // the service's schema refuses anything but approve / reject (a malformed form must never become a rejection)
  const decision = text(form, "decision") as "approve" | "reject";
  try {
    const result = await decidePayout(
      req.db,
      req.actor,
      { approvalId: text(form, "approvalId"), decision, expectedAmountIqd: parseAmount(text(form, "amountIqd")) ?? Number.NaN, note: text(form, "reason") || undefined, reference: text(form, "reference") || undefined },
      req.now,
    );
    return ok({ intent: PAYOUT_INTENT, message: financeT(req.locale)(result.status === "paid" ? "payouts.paid" : "payouts.rejected") });
  } catch (error) {
    return failed(error, req.locale, PAYOUT_INTENT);
  }
}
