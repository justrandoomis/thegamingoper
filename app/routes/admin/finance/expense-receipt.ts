import type { Route } from "./+types/expense-receipt";
import { expenseReceiptFile } from "~/server/services/admin/finance/expense-views.server";
import { fileResponse, getFile } from "~/server/storage.server";
import { financeBlobStore } from "./env.server";
import { openFinance } from "./finance.server";

/**
 * GET /admin/finance/expenses/:expenseId/receipt — the photo of an expense's receipt. A PRIVATE file (SECURITY.md §9):
 * only for employees holding finance.expense.manage, sent with `Cache-Control: private, no-store`, a sandboxing CSP
 * and nosniff (fileResponse). Never served by /media.
 */
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { db, actor } = await openFinance(context, "finance.expense.manage");
  const fileId = await expenseReceiptFile(db, actor, params.expenseId);
  if (!fileId) return notFound();
  const stored = await getFile(db, financeBlobStore(), fileId);
  if (!stored || stored.record.visibility !== "private" || stored.record.kind !== "expense_receipt") return notFound();
  return fileResponse({ mime: stored.record.mime, sha256: stored.record.sha256, visibility: "private" }, stored.bytes, request);
}
