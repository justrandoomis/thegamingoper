import { useState } from "react";
import { Link, useSearchParams } from "react-router";

import type { Route } from "./+types/shift-report";
import { Logo } from "~/art/Logo";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { reviewShift, shiftReport } from "~/server/services/admin/pos/shifts.server";
import { IQD_DENOMINATIONS } from "~/server/services/admin/pos/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { posMeta } from "./meta";
import { failed, openPos, text, whole } from "./pos.server";
import { Money, Notice, Num, Ref, ShiftBadge, useIntent, usePosT, When } from "./ui";

/**
 * /admin/pos/shifts/:shiftId — one shift's report (the Z report, 06.02 and the daily close): register, who opened and
 * closed it and when, the float, sales by payment method, discounts given, cash moved by hand, the count by note,
 * what the system expected and the difference — money figures for supervisors only (the drawer's owner counted
 * blind). A difference waits for a second person (pos.shift.review, never who opened or closed the shift), who
 * approves it with a note; approving posts it to cash over/short once. Prints on 80 mm paper from the browser.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, ["pos.shift.review", "pos.shift.open", "pos.shift.close"]);
  try {
    return { report: await shiftReport(db, actor, params.shiftId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPos(context, "pos.shift.review");
  const form = await request.formData();
  try {
    const result = await reviewShift(db, actor, { shiftId: params.shiftId, expectedVarianceIqd: whole(form, "variance") ?? Number.NaN, note: text(form, "note") }, now);
    return { ok: true as const, intent: "review", replayed: result.replayed };
  } catch (error) {
    return failed(error, locale, "review");
  }
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "report.title", { register: args.loaderData?.report.register.code ?? "" });

export default function ShiftReportPage({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const f = useFormat();
  const { report } = loaderData;
  const [params] = useSearchParams();
  const closed = params.get("closed");
  const reviewer = report.cash.expectedIqd !== null || report.byMethod !== null;
  return (
    <>
      <div className="pos-noprint grid gap-3">
        <header className="adm-page-head">
          <h1 className="adm-title flex flex-wrap items-center gap-3">
            {t("report.title", { register: report.register.code })} <ShiftBadge state={report.state} />
          </h1>
          <p className="max-w-[70ch] type-body text-ink-2">{reviewer ? t("report.leadReviewer") : t("report.leadOwn")}</p>
        </header>
        {closed ? <Notice tone={closed === "review" ? "warn" : "ok"}>{closed === "review" ? t("shift.closedReview") : t("shift.closedOk")}</Notice> : null}
        {report.canReview ? <ReviewCard shiftId={report.id} variance={report.varianceIqd ?? 0} closedBy={report.closedBy?.name ?? "—"} /> : null}
        {report.reviewBlocked ? <Notice tone="warn" icon="lock">{t("report.ownShift")}</Notice> : null}
        <div className="pos-actions">
          <Key icon="printer" onClick={() => window.print()}>
            {t("report.print")}
          </Key>
          <Key as={Link} to={`/admin/pos/sales?shift=${report.id}`} icon="receipt">
            {t("report.sales")}
          </Key>
          <Key as={Link} to="/admin/pos/shifts" icon="arrow-left">
            {t("report.back")}
          </Key>
        </div>
      </div>

      <article className="pos-print mt-4" data-theme="light" aria-label={t("report.title", { register: report.register.code })}>
        <div className="pos-print__head">
          <Logo className="h-8 w-auto text-logo" />
          <p className="pos-print__big">{t("report.kind")}</p>
          <p className="pos-print__muted">
            <Ref value={report.register.code} /> · {report.register.name}
          </p>
        </div>
        <Row label={t("report.openedBy")} value={report.openedBy.name} />
        <Row label={t("report.openedAt")} value={<span className="nums">{f.dateTime(report.openedAt)}</span>} />
        <Row label={t("report.closedBy")} value={report.closedBy?.name ?? "—"} />
        <Row label={t("report.closedAt")} value={report.closedAt ? <span className="nums">{f.dateTime(report.closedAt)}</span> : "—"} />
        {report.approvedBy ? <Row label={t("report.approvedBy")} value={report.approvedBy.name} /> : null}
        <hr className="pos-print__rule" />
        <Row label={t("report.salesCount")} value={<Num value={report.sales.count} />} />
        {report.sales.totalIqd !== null ? <Row label={t("report.salesTotal")} value={<Money iqd={report.sales.totalIqd} />} /> : null}
        {report.byMethod?.map((entry) => (
          <Row key={entry.method} label={`${t(`method.${entry.method}`)} (${f.number(entry.count)})`} value={<Money iqd={entry.totalIqd} />} />
        ))}
        {report.discounts ? (
          <>
            <Row label={t("report.discountSales", { count: report.discounts.sales })} value={<Money iqd={-(report.discounts.lineIqd + report.discounts.orderIqd)} />} />
          </>
        ) : null}
        <hr className="pos-print__rule" />
        <Row label={t("report.float")} value={<Money iqd={report.openingFloatIqd} />} />
        {report.cash.salesIqd !== null ? <Row label={t("report.cashSales")} value={<Money iqd={report.cash.salesIqd} signed />} /> : null}
        {report.cash.refundsIqd ? <Row label={t("move.refund")} value={<Money iqd={report.cash.refundsIqd} signed />} /> : null}
        {report.cash.payInIqd ? <Row label={t("move.pay_in")} value={<Money iqd={report.cash.payInIqd} signed />} /> : null}
        {report.cash.payOutIqd ? <Row label={t("move.pay_out")} value={<Money iqd={report.cash.payOutIqd} signed />} /> : null}
        {report.cash.dropIqd ? <Row label={t("move.drop")} value={<Money iqd={report.cash.dropIqd} signed />} /> : null}
        {report.cash.expectedIqd !== null ? <Row label={t("report.expected")} value={<Money iqd={report.cash.expectedIqd} />} strong /> : null}
        <Row label={t("report.counted")} value={<Money iqd={report.countedCashIqd} />} strong />
        {report.varianceIqd !== null ? <Row label={t("report.variance")} value={<Money iqd={report.varianceIqd} signed />} strong /> : null}
        {report.varianceNote ? <p className="pos-print__muted">{t("report.varianceNote", { note: report.varianceNote })}</p> : null}
        {report.denominations ? (
          <>
            <hr className="pos-print__rule" />
            <p className="type-strong">{t("report.byNote")}</p>
            {IQD_DENOMINATIONS.filter((note) => (report.denominations?.[String(note)] ?? 0) > 0).map((note) => (
              <Row key={note} label={`${f.number(note)} × ${f.number(report.denominations?.[String(note)] ?? 0)}`} value={<Money iqd={note * (report.denominations?.[String(note)] ?? 0)} />} />
            ))}
          </>
        ) : null}
        {report.moves.length ? (
          <>
            <hr className="pos-print__rule" />
            <p className="type-strong">{t("report.moves")}</p>
            {report.moves.map((move) => (
              <div key={move.id} className="pos-print__item">
                <div className="pos-print__row">
                  <span>
                    {t(`move.${move.kind}`)}
                    {move.orderRef ? (
                      <>
                        {" · "}
                        <Ref value={move.orderRef} />
                      </>
                    ) : null}
                  </span>
                  <Money iqd={move.amountIqd} signed />
                </div>
                <span className="pos-print__muted">
                  <When at={move.at} /> · {move.by}
                  {move.reason ? ` · ${move.reason}` : ""}
                </span>
              </div>
            ))}
          </>
        ) : null}
        {report.notes ? <p className="pos-print__muted">{t("report.notes", { notes: report.notes })}</p> : null}
        {!reviewer ? <p className="pos-print__muted">{t("report.blind")}</p> : null}
      </article>
    </>
  );
}

function Row({ label, value, strong = false }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={strong ? "pos-print__row type-strong" : "pos-print__row"}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** The decision a supervisor takes (raised: a person must act), mobile-first. */
function ReviewCard({ shiftId, variance, closedBy }: { shiftId: string; variance: number; closedBy: string }) {
  const t = usePosT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("review", "done.reviewed", () => setOpen(false));
  return (
    <section className="adm-card adm-card--act" aria-labelledby="review-head">
      <h2 id="review-head" className="adm-h3">
        {t("report.reviewHead")}
      </h2>
      <p className="type-body">{t(variance < 0 ? "report.reviewShort" : "report.reviewOver", { name: closedBy })}</p>
      <p className="type-kpi">
        <Money iqd={variance} signed />
      </p>
      <div className="pos-actions">
        <Key variant="commit" icon="check" onClick={() => setOpen(true)}>
          {t("report.approve")}
        </Key>
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="commit"
        title={t("report.approveQ")}
        consequence={t(variance < 0 ? "report.approveShortWhat" : "report.approveOverWhat")}
        confirmLabel={t("report.approve")}
        impact={[
          { label: t("report.variance"), value: <Money iqd={variance} signed />, negative: variance < 0 },
          { label: t("report.books"), value: t(variance < 0 ? "report.booksShort" : "report.booksOver") },
        ]}
        reason={{ label: t("report.note"), hint: t("report.noteHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ note: reason, variance: String(variance) }, { method: "post" })}
      />
    </section>
  );
}
