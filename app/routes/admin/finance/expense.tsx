import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/expense";
import { useFormat } from "~/i18n/react";
import { approveExpense, voidExpense } from "~/server/services/accounting/expenses.server";
import { invalid } from "~/server/errors";
import { getExpense } from "~/server/services/admin/finance/expense-views.server";
import { Key } from "~/ui/Key";
import { failed, financeT, ok, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { ActionDialog, Code, Day, DemoTag, Ledger, Money, Note, PageHead, PeriodName, Section, StateTag, useFinanceLayout, useFinT, When } from "./ui";

/**
 * /admin/finance/expenses/:expenseId — one expense (10.05): what, how much, which account and cost centre, who
 * recorded and approved it, its journal entry, its receipt. Approve and post (one journal entry — the screen's commit;
 * above the limit not by whoever recorded it), void (a draft is dropped; a posted one is reversed in an open month).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.expense.manage");
  const expense = await orRespond(() => getExpense(db, actor, params.expenseId, locale, now));
  return { expense };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.expense.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = financeT(req.locale);
  try {
    if (intent === "approve") {
      const { replayed } = await approveExpense(req.db, req.actor, { expenseId: params.expenseId, note: text(form, "reason") || undefined }, req.now);
      return ok({ intent, message: t(replayed ? "expense.alreadyPosted" : "expense.posted") });
    }
    if (intent === "void") {
      const { reversalId } = await voidExpense(req.db, req.actor, { expenseId: params.expenseId, reason: text(form, "reason") }, req.now);
      return ok({ intent, message: t(reversalId ? "expense.voidedReversed" : "expense.voided") });
    }
    // a form this page never sends: refused like any invalid input (400), not a server error
    return failed(invalid({ intent: "invalid" }), req.locale, intent);
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "expense.title");

export default function ExpensePage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const layout = useFinanceLayout();
  const [params] = useSearchParams();
  const { expense } = loaderData;
  const [dialog, setDialog] = useState<"approve" | "void" | null>(null);
  const books = layout?.access.books ?? false;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHead
        eyebrow={
          <Link to="/admin/finance/expenses" className="adm-link">
            {t("expenseNew.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {expense.description}
            <DemoTag show={expense.isDemo} />
          </span>
        }
        lead={<StateTag group="expense" value={expense.status} label={t(`expenseStatus.${expense.status}`)} />}
      />
      {params.get("created") ? (
        <Note icon="check-circle" tone="ok">
          <p>{t("expense.createdNow")}</p>
        </Note>
      ) : null}

      <Section id="exp-facts" title={t("expense.facts")} className="mt-4">
        <Ledger
          className="adm-card"
          rows={[
            { label: t("expenseNew.amount"), value: <Money iqd={expense.amountIqd} />, strong: true },
            { label: t("expenseNew.date"), value: <Day day={expense.incurredOn} /> },
            { label: t("expense.period"), value: <PeriodName period={expense.period} /> },
            { label: t("expenseNew.account"), value: expense.account },
            { label: t("expenseNew.paidFrom"), value: expense.paidFrom ?? "—" },
            { label: t("expenseNew.center"), value: expense.costCenter ? <Code>{expense.costCenter}</Code> : "—" },
            { label: t("expenseNew.vendor"), value: expense.vendor ?? "—" },
            { label: t("expense.recordedBy"), value: <span>{expense.createdBy ?? "—"} · <When at={expense.createdAt} /></span> },
            { label: t("expense.approvedBy"), value: expense.approvedBy ? <span>{expense.approvedBy} · <When at={expense.approvedAt} /></span> : "—" },
          ]}
        />
        {expense.hasReceipt ? (
          <a href={`/admin/finance/expenses/${expense.id}/receipt`} target="_blank" rel="noreferrer" className="adm-link">
            {t("expense.openReceipt")}
          </a>
        ) : (
          <p className="type-caption text-ink-2">{t("expense.noReceipt")}</p>
        )}
      </Section>

      <Section id="exp-books" title={t("expense.inTheBooks")}>
        {expense.journalEntryId ? (
          <p className="type-body">
            {t("expense.entry")}{" "}
            {books ? (
              <Link to={`/admin/finance/journal/${expense.journalEntryId}`} className="adm-link">
                <Code>{expense.journalEntryId}</Code>
              </Link>
            ) : (
              <Code>{expense.journalEntryId}</Code>
            )}
            {expense.reversalId ? (
              <>
                {" · "}
                {t("expense.reversal")}{" "}
                {books ? (
                  <Link to={`/admin/finance/journal/${expense.reversalId}`} className="adm-link">
                    <Code>{expense.reversalId}</Code>
                  </Link>
                ) : (
                  <Code>{expense.reversalId}</Code>
                )}
              </>
            ) : null}
          </p>
        ) : (
          <p className="type-body text-ink-2">{t("expense.notInBooks")}</p>
        )}
        {expense.monthClosed ? (
          <Note icon="lock" tone="warn">
            <p>{t("expense.monthClosed")}</p>
          </Note>
        ) : null}
        {expense.needsOther ? (
          <Note icon="users" tone="warn">
            <p>{t("expense.needsOther", { limit: f.iqd(expense.threshold) })}</p>
            {expense.selfApprovedIqd > 0 ? <p className="type-caption">{t("expense.selfSoFar", { amount: f.iqd(expense.selfApprovedIqd) })}</p> : null}
          </Note>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {expense.canApprove ? (
            <Key variant="commit" icon="seal-check" onClick={() => setDialog("approve")}>
              {t("expense.approve")}
            </Key>
          ) : null}
          {expense.canVoid ? (
            <Key icon="x-circle" className="enabled:[--on:var(--red-ink)]" onClick={() => setDialog("void")}>
              {t("expense.void")}
            </Key>
          ) : null}
        </div>
      </Section>

      <ActionDialog
        open={dialog === "approve"}
        onClose={() => setDialog(null)}
        tone="commit"
        title={t("expense.approveQ")}
        consequence={t("expense.approveWhat")}
        confirmLabel={t("expense.approve")}
        impact={[
          { label: expense.account, value: f.iqd(expense.amountIqd) },
          { label: expense.paidFrom ?? "—", value: f.iqd(expense.amountIqd), negative: true },
        ]}
        reason={{ label: t("common.noteOptional"), noteRequired: false, minLength: 0 }}
        fields={{ intent: "approve" }}
      />
      <ActionDialog
        open={dialog === "void"}
        onClose={() => setDialog(null)}
        tone="destructive"
        title={t("expense.voidQ")}
        consequence={expense.status === "posted" ? t("expense.voidPostedWhat") : t("expense.voidDraftWhat")}
        confirmLabel={t("expense.void")}
        impact={expense.status === "posted" ? [{ label: expense.account, value: f.iqd(expense.amountIqd), negative: true }] : undefined}
        reason={{ label: t("common.reason"), minLength: 3 }}
        fields={{ intent: "void" }}
      />
    </div>
  );
}
