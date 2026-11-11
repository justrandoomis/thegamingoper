import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/refunds";
import { useFormat } from "~/i18n/react";
import { listRefundReviews, reviewRefund, type RefundReviewRow } from "~/server/services/admin/security/refund-reviews.server";
import { REFUND_REVIEW_OUTCOMES, REFUND_THRESHOLDS, REFUND_VIEWS, parseRefundFilters, searchOf } from "~/server/services/admin/security/types";
import { invalid } from "~/server/errors";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { FieldGroup, Radio } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { ActionDialog, Code, LinkChips, Money, Note, PageHead, Pair, ResponsiveList, Section, When, useListSep, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { ok, text } from "./route-kit.server";
import { sec } from "./security.server";

/**
 * /admin/security/refunds — 20.08: a second look at the refunds of the last 90 days. Fixed signals with their numbers
 * (a high amount, money returned another way than it came, one person asking and issuing, one employee asking for many
 * in a day, a customer with repeated refunds); a reviewer records "cleared" or "suspicious" with a note — never on a
 * refund they asked for or approved. Nothing here moves money: refunds stay with the orders module and the core.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await sec.open(context, "security.fraud.review");
  const filters = parseRefundFilters(new URL(request.url).searchParams);
  return { page: await sec.orRespond(() => listRefundReviews(db, actor, filters, now)), filters };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await sec.open(context, "security.fraud.review");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "review") throw invalid({ intent: "invalid" });
    return ok(intent, await reviewRefund(req.db, req.actor, { refundId: text(form, "refundId"), outcome: text(form, "outcome"), note: text(form, "reason") }, req.now));
  } catch (error) {
    return sec.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "refunds.title");

export default function RefundReviewsPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const sep = useListSep();
  const f = useFormat();
  const { page, filters } = loaderData;
  const [target, setTarget] = useState<RefundReviewRow | null>(null);
  const [outcome, setOutcome] = useState<(typeof REFUND_REVIEW_OUTCOMES)[number]>("cleared");
  const signals = (row: RefundReviewRow) =>
    row.signals.length ? (
      <span className="flex flex-wrap gap-1">
        {row.signals.map((signal) => (
          <Status key={signal} tone="warn">
            {t(`refunds.signal.${signal}`)}
          </Status>
        ))}
      </span>
    ) : (
      <span className="text-ink-2">—</span>
    );
  const review = (row: RefundReviewRow) =>
    row.review ? (
      <span className="grid">
        <Status tone={row.review.outcome === "cleared" ? "ok" : "bad"}>{t(`refunds.outcome.${row.review.outcome}`)}</Status>
        <span className="type-caption text-ink-2">{row.review.by ?? "—"}</span>
      </span>
    ) : row.canReview ? (
      <Key size="sm" onClick={() => setTarget(row)}>
        {t("refunds.review")}
      </Key>
    ) : (
      <span className="type-caption text-ink-2">{t("refunds.involved")}</span>
    );
  const columns: DataColumn<RefundReviewRow>[] = [
    {
      key: "order",
      header: t("refunds.col.order"),
      cell: (row) => (
        <Link to={`/admin/orders/${row.orderRef}`} className="adm-link">
          <Code>{row.orderRef}</Code>
        </Link>
      ),
    },
    { key: "amount", header: t("refunds.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} /> },
    { key: "method", header: t("refunds.col.method"), cell: (row) => t("refunds.methodLine", { refund: t(`refunds.method.${row.method}`), paid: t(`refunds.payment.${row.paymentMethod}`) }) },
    { key: "people", header: t("refunds.col.people"), cell: (row) => <span className="grid type-caption"><span>{t("refunds.asked", { name: row.createdBy ?? "—" })}</span><span>{t("refunds.issued", { name: row.approvedBy ?? "—" })}</span></span> },
    { key: "signals", header: t("refunds.col.signals"), cell: signals },
    { key: "at", header: t("refunds.col.at"), cell: (row) => <When at={row.createdAt} /> },
    { key: "review", header: t("refunds.col.review"), cell: review },
  ];
  return (
    <>
      <PageHead title={t("refunds.title")} lead={t("refunds.lead")} />
      <LinkChips label={t("refunds.views")} items={REFUND_VIEWS.map((view) => ({ value: view, label: t(`refunds.view.${view}`), href: `/admin/security/refunds${searchOf({ view: view === "flagged" ? null : view })}` || "/admin/security/refunds", selected: filters.view === view, count: page.counts[view] }))} />
      <Section id="list" title={t(`refunds.view.${filters.view}`)} className="mt-4">
        <ResponsiveList
          caption={t(`refunds.view.${filters.view}`)}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("refunds.empty")} text={t("refunds.emptyHint")} icon="hand-coins" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/security/refunds${searchOf({ view: filters.view === "flagged" ? null : filters.view, page: n > 1 ? n : null })}` || "?"} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/orders/${row.orderRef}`} className="adm-link type-strong">
                  <Code>{row.orderRef}</Code>
                </Link>
                <Money iqd={row.amountIqd} />
              </div>
              <Pair label={t("refunds.col.method")}>{t(`refunds.method.${row.method}`)}</Pair>
              <Pair label={t("refunds.col.people")}>{`${row.createdBy ?? "—"} · ${row.approvedBy ?? "—"}`}</Pair>
              {signals(row)}
              <div>{review(row)}</div>
            </>
          )}
        />
        <Note>
          <p>{t("refunds.rulesNote", { high: f.iqd(REFUND_THRESHOLDS.highValueIqd), burst: REFUND_THRESHOLDS.burstCount, repeat: REFUND_THRESHOLDS.repeatCount })}</p>
        </Note>
      </Section>
      <ActionDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={t("refunds.reviewTitle", { ref: target?.orderRef ?? "" })}
        consequence={t("refunds.reviewConsequence")}
        confirmLabel={t("refunds.record")}
        impact={target ? [{ label: t("refunds.col.amount"), value: f.iqd(target.amountIqd) }, { label: t("refunds.col.signals"), value: target.signals.map((signal) => t(`refunds.signal.${signal}`)).join(sep) || "—" }] : undefined}
        reason={{ label: t("refunds.note"), hint: t("refunds.noteHint") }}
        fields={{ intent: "review", refundId: target?.id ?? "", outcome }}
        successMessage={t("refunds.recorded")}
      >
        <FieldGroup legend={t("refunds.verdict")}>
          {REFUND_REVIEW_OUTCOMES.map((value) => (
            <Radio key={value} row name="refund-outcome" value={value} label={t(`refunds.outcome.${value}`)} checked={outcome === value} onChange={() => setOutcome(value)} />
          ))}
        </FieldGroup>
      </ActionDialog>
    </>
  );
}
