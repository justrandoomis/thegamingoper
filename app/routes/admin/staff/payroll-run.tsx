import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/payroll-run";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { approveRun, deferAdvance, getRun, payRun, recomputeRun, updateItem, voidRun } from "~/server/services/admin/staff/payroll.server";
import { PAID_FROM_LIST, type RunItemView } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { staffMeta } from "./meta";
import { amount, failed, int, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { ActionDialog, ByName, Code, DemoTag, FormDialog, Kpi, Ledger, Money, Note, PageHead, Pair, PeriodName, PrintKey, ResponsiveTable, Section, StateTag, When, usePrintInLight, useStaffT } from "./ui";

/**
 * /admin/staff/payroll/:runId — 15.04 one payroll run: every employee's line (base and how it was reached, commission,
 * bonus, advances, other deductions, net). While a draft, who prepares (staff.payroll.run) recomputes it, adds a bonus
 * or a deduction with a note, or leaves an advance for a later run; another person (staff.payroll.approve, never one
 * who took part or changed a salary in it) approves exactly what they see; then pays it — one batch with the books
 * (Dr payroll / Dr commissions / Cr cash or bank). Payslips print from here (print CSS, one per page).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, now } = await openStaff(context);
  const detail = await orRespond(() => getRun(db, actor, params.runId, now));
  return { detail, now };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const runId = params.runId;
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "recompute": {
        const result = await recomputeRun(req.db, req.actor, { runId }, req.now);
        return ok(intent, { message: t("run.recomputed", { count: result.employees }) });
      }
      case "item":
        await updateItem(req.db, req.actor, { runId, employeeId: text(form, "employeeId"), bonusIqd: amount(form, "bonusIqd", 0) as number, otherDeductionIqd: amount(form, "otherDeductionIqd", 0) as number, notes: optional(form, "notes"), expectedNetIqd: int(form, "expectedNetIqd") }, req.now);
        return ok(intent, { message: t("run.itemSaved") });
      case "defer":
        await deferAdvance(req.db, req.actor, { runId, advanceId: text(form, "advanceId"), reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("run.deferred") });
      case "approve":
        await approveRun(req.db, req.actor, { runId, expectedNetIqd: int(form, "expectedNetIqd"), expectedItems: int(form, "expectedItems"), note: optional(form, "note") }, req.now);
        return ok(intent, { message: t("run.approvedMsg") });
      case "pay": {
        const result = await payRun(req.db, req.actor, { runId, paidFrom: text(form, "paidFrom") as never, reference: optional(form, "reference") }, req.now);
        return ok(intent, { message: result.replayed ? t("run.alreadyPaid") : t("run.paidMsg") });
      }
      case "void":
        await voidRun(req.db, req.actor, { runId, reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("run.voided") });
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "run.title", { ref: args.loaderData?.detail.run.ref ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];
type Dialogs = { kind: "item"; item: RunItemView } | { kind: "defer"; item: RunItemView; advance: RunItemView["advances"][number] } | { kind: "approve" | "pay" | "void" | "recompute" } | null;

export default function PayrollRunPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const f = useFormat();
  const { detail } = loaderData;
  const { run, totals } = detail;
  const [dialog, setDialog] = useState<Dialogs>(null);
  const close = () => setDialog(null);
  const columns: DataColumn<RunItemView>[] = [
    {
      key: "employee",
      header: t("payroll.col.employee"),
      cell: (row) => (
        <span className="grid py-1">
          <span className="inline-flex flex-wrap items-center gap-1">
            <Link to={`/admin/staff/employees/${row.employee.id}`} className="adm-link">
              {row.employee.name}
            </Link>
            <DemoTag show={row.employee.isDemo} />
            {row.employee.status === "disabled" ? <Status tone="bad">{t("employeeStatus.disabled")}</Status> : null}
            {row.salaryChangedAt ? <Status tone="warn">{t("run.salaryChanged")}</Status> : null}
          </span>
          {row.employee.jobTitle ? <span className="type-caption text-ink-2">{row.employee.jobTitle}</span> : null}
        </span>
      ),
    },
    {
      key: "base",
      header: t("payroll.col.base"),
      numeric: true,
      cell: (row) => (
        <span className="grid justify-items-end">
          <Money iqd={row.baseIqd} />
          {run.status === "draft" && row.basis.monthlyIqd ? <span className="type-caption text-ink-2">{t("run.basisDays", { days: row.basis.payableDays, of: row.basis.monthDays })}</span> : null}
        </span>
      ),
    },
    { key: "commission", header: t("payroll.col.commission"), numeric: true, cell: (row) => <Money iqd={row.commissionIqd} /> },
    { key: "bonus", header: t("payroll.col.bonus"), numeric: true, cell: (row) => <Money iqd={row.bonusIqd} /> },
    { key: "advances", header: t("payroll.col.advances"), numeric: true, cell: (row) => <Money iqd={row.advanceDeductionIqd ? -row.advanceDeductionIqd : 0} /> },
    { key: "other", header: t("payroll.col.other"), numeric: true, cell: (row) => <Money iqd={row.otherDeductionIqd ? -row.otherDeductionIqd : 0} /> },
    { key: "net", header: t("payroll.col.net"), numeric: true, negative: (row) => row.netIqd < 0, cell: (row) => <Money iqd={row.netIqd} className="type-strong" /> },
    ...(detail.can.edit
      ? [
          {
            key: "act",
            header: <span className="sr-only">{t("common.actions")}</span>,
            cell: (row: RunItemView) => <ItemActions row={row} onEdit={() => setDialog({ kind: "item", item: row })} onDefer={(advance) => setDialog({ kind: "defer", item: row, advance })} />,
          },
        ]
      : []),
  ];
  return (
    <div className="stf-print">
      <PageHead
        eyebrow={
          <Link to="/admin/staff/payroll" className="adm-link">
            {t("payroll.title")}
          </Link>
        }
        title={
          <>
            {t("run.heading")} · <PeriodName period={run.period} />
          </>
        }
        lead={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Code>{run.ref}</Code>
            <StateTag group="run" value={run.status} label={t(`runStatus.${run.status}`)} />
            <DemoTag show={run.isDemo} />
          </span>
        }
        actions={<PrintKey label={t("run.printSlips")} />}
      />

      <div className="stf-noprint grid gap-2">
        {detail.stale ? (
          <Note tone="warn">
            <p>{t("run.stale", { net: f.iqd(detail.stale.netNowIqd), count: detail.stale.employeesNow })}</p>
          </Note>
        ) : null}
        {detail.payrollExpenses.count ? (
          <Note tone="warn">
            <p>{t("run.expensesWarning", { count: detail.payrollExpenses.count, amount: f.iqd(detail.payrollExpenses.iqd) })}</p>
          </Note>
        ) : null}
        {detail.blockers.netNegative ? (
          <Note tone="bad" icon="warning-circle">
            <p>{t("run.netNegative", { count: detail.blockers.netNegative })}</p>
          </Note>
        ) : null}
        {run.status === "draft" && detail.involved.me ? (
          <Note>
            <p>{t("run.youTookPart")}</p>
          </Note>
        ) : null}
        {run.status === "draft" && detail.involved.names.length ? <p className="type-caption text-ink-2">{t("run.involved", { names: detail.involved.names.join(" · ") })}</p> : null}
      </div>

      <div className="stf-kpis my-5 stf-noprint">
        <Kpi label={t("payroll.col.employees")} value={f.number(detail.items.length)} />
        <Kpi label={t("payroll.col.base")} value={<Money iqd={totals.baseIqd} />} />
        <Kpi label={t("payroll.col.commission")} value={<Money iqd={totals.commissionIqd} />} />
        <Kpi label={t("payroll.col.bonus")} value={<Money iqd={totals.bonusIqd} />} />
        <Kpi label={t("payroll.col.deductions")} value={<Money iqd={-(totals.advanceDeductionIqd + totals.otherDeductionIqd)} />} />
        <Kpi label={t("payroll.col.net")} value={<Money iqd={totals.netIqd} />} />
      </div>

      <Section id="items" title={t("run.items")} className="stf-noprint">
        <ResponsiveTable
          caption={t("run.items")}
          columns={columns}
          rows={detail.items}
          rowKey={(row) => row.employee.id}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{row.employee.name}</span>
                <Money iqd={row.netIqd} className="type-strong" />
              </div>
              <Pair label={t("payroll.col.base")}>
                <Money iqd={row.baseIqd} />
              </Pair>
              <Pair label={t("payroll.col.commission")}>
                <Money iqd={row.commissionIqd} />
              </Pair>
              {row.bonusIqd ? (
                <Pair label={t("payroll.col.bonus")}>
                  <Money iqd={row.bonusIqd} />
                </Pair>
              ) : null}
              {row.advanceDeductionIqd ? (
                <Pair label={t("payroll.col.advances")}>
                  <Money iqd={-row.advanceDeductionIqd} />
                </Pair>
              ) : null}
              {row.otherDeductionIqd ? (
                <Pair label={t("payroll.col.other")}>
                  <Money iqd={-row.otherDeductionIqd} />
                </Pair>
              ) : null}
              {row.notes ? <p className="type-caption text-ink-2">{row.notes}</p> : null}
              {detail.can.edit ? <ItemActions row={row} onEdit={() => setDialog({ kind: "item", item: row })} onDefer={(advance) => setDialog({ kind: "defer", item: row, advance })} /> : null}
            </>
          )}
        />
        {detail.excluded.length ? <p className="type-caption text-ink-2">{t("run.excludedList", { names: detail.excluded.map((person) => person.name).join(" · ") })}</p> : null}
      </Section>

      <RunFacts detail={detail} />

      {detail.can.edit || detail.can.approve || detail.can.pay || detail.can.void ? (
        <div className="stf-taskbar stf-noprint">
          {detail.can.void ? (
            <Key variant="ghost" icon="x-circle" onClick={() => setDialog({ kind: "void" })}>
              {t("run.void")}
            </Key>
          ) : null}
          {detail.can.edit ? (
            <Key icon="arrows-clockwise" onClick={() => setDialog({ kind: "recompute" })}>
              {t("run.recompute")}
            </Key>
          ) : null}
          {detail.can.approve ? (
            <Key variant="primary" icon="seal-check" disabled={detail.blockers.netNegative > 0} onClick={() => setDialog({ kind: "approve" })}>
              {t("run.approve")}
            </Key>
          ) : null}
          {detail.can.pay ? (
            <Key variant="primary" icon="money" onClick={() => setDialog({ kind: "pay" })}>
              {t("run.pay")}
            </Key>
          ) : null}
        </div>
      ) : null}

      <Payslips detail={detail} />

      {dialog?.kind === "item" ? <ItemForm item={dialog.item} onClose={close} /> : null}
      {dialog?.kind === "defer" ? (
        <ActionDialog
          open
          onClose={close}
          title={t("run.deferQ", { name: dialog.item.employee.name })}
          consequence={t("run.deferWhat")}
          impact={[{ label: t("run.advance"), value: <Money iqd={dialog.advance.amountIqd} /> }, { label: t("payroll.col.net"), value: <Money iqd={dialog.item.netIqd + dialog.advance.amountIqd} /> }]}
          confirmLabel={t("run.defer")}
          reason
          fields={{ intent: "defer", advanceId: dialog.advance.id }}
          successMessage={t("run.deferred")}
        />
      ) : null}
      {dialog?.kind === "recompute" ? (
        <ActionDialog open onClose={close} title={t("run.recomputeQ")} consequence={t("run.recomputeWhat")} confirmLabel={t("run.recompute")} fields={{ intent: "recompute" }} successMessage={t("run.recomputedShort")} />
      ) : null}
      {dialog?.kind === "approve" ? (
        <ActionDialog
          open
          onClose={close}
          tone="commit"
          title={t("run.approveQ", { ref: run.ref })}
          consequence={t("run.approveWhat")}
          impact={[
            { label: t("payroll.col.employees"), value: f.number(detail.items.length) },
            { label: t("payroll.col.gross"), value: <Money iqd={totals.baseIqd + totals.commissionIqd + totals.bonusIqd} /> },
            { label: t("payroll.col.deductions"), value: <Money iqd={-(totals.advanceDeductionIqd + totals.otherDeductionIqd)} />, negative: true },
            { label: t("payroll.col.net"), value: <Money iqd={totals.netIqd} /> },
          ]}
          reason={{ label: t("run.approveNote"), minLength: 0, noteRequired: false }}
          reasonName="note"
          confirmLabel={t("run.approve")}
          fields={{ intent: "approve", expectedNetIqd: String(totals.netIqd), expectedItems: String(detail.items.length) }}
          successMessage={t("run.approvedMsg")}
        />
      ) : null}
      {dialog?.kind === "pay" ? <PayForm detail={detail} onClose={close} /> : null}
      {dialog?.kind === "void" ? (
        <ActionDialog open onClose={close} tone="destructive" title={t("run.voidQ", { ref: run.ref })} consequence={t("run.voidWhat")} confirmLabel={t("run.void")} reason fields={{ intent: "void" }} successMessage={t("run.voided")} />
      ) : null}
    </div>
  );
}

function ItemActions({ row, onEdit, onDefer }: { row: RunItemView; onEdit: () => void; onDefer: (advance: RunItemView["advances"][number]) => void }) {
  const t = useStaffT();
  return (
    <span className="inline-flex flex-wrap gap-1 stf-noprint">
      <Key size="sm" variant="ghost" icon="pencil-simple" onClick={onEdit} aria-label={t("run.editFor", { name: row.employee.name })}>
        {t("run.adjust")}
      </Key>
      {row.advances.map((advance) => (
        <Key key={advance.id} size="sm" variant="ghost" icon="hourglass" onClick={() => onDefer(advance)}>
          {t("run.deferShort")}
        </Key>
      ))}
    </span>
  );
}

function ItemForm({ item, onClose }: { item: RunItemView; onClose: () => void }) {
  const t = useStaffT();
  return (
    <FormDialog title={t("run.adjustTitle", { name: item.employee.name })} description={t("run.adjustWhat")} submitLabel={t("run.saveAdjust")} onClose={onClose} successMessage={t("run.itemSaved")} hidden={{ intent: "item", employeeId: item.employee.id, expectedNetIqd: String(item.netIqd) }}>
      {(fields) => (
        <>
          <Ledger
            rows={[
              { label: t("payroll.col.base"), value: <Money iqd={item.baseIqd} /> },
              { label: t("payroll.col.commission"), value: <Money iqd={item.commissionIqd} /> },
              { label: t("payroll.col.advances"), value: <Money iqd={item.advanceDeductionIqd ? -item.advanceDeductionIqd : 0} /> },
            ]}
          />
          <div className="grid grid-cols-2 gap-3">
            <TextField name="bonusIqd" label={t("run.bonusField")} inputMode="numeric" defaultValue={item.bonusIqd ? String(item.bonusIqd) : ""} ltr error={fields.bonusIqd} />
            <TextField name="otherDeductionIqd" label={t("run.otherField")} inputMode="numeric" defaultValue={item.otherDeductionIqd ? String(item.otherDeductionIqd) : ""} ltr error={fields.otherDeductionIqd} />
          </div>
          <TextField name="notes" label={t("run.notesField")} hint={t("run.notesHint")} defaultValue={item.notes ?? ""} maxLength={300} error={fields.notes} />
        </>
      )}
    </FormDialog>
  );
}

function PayForm({ detail, onClose }: { detail: Detail; onClose: () => void }) {
  const t = useStaffT();
  return (
    <FormDialog title={t("run.payQ", { ref: detail.run.ref })} description={t("run.payWhat")} submitLabel={t("run.pay")} onClose={onClose} successMessage={t("run.paidMsg")} hidden={{ intent: "pay" }}>
      {(fields) => (
        <>
          <Ledger
            rows={[
              { label: t("run.payrollLine"), value: <Money iqd={detail.totals.baseIqd + detail.totals.bonusIqd - detail.totals.advanceDeductionIqd - detail.totals.otherDeductionIqd} /> },
              { label: t("run.commissionLine"), value: <Money iqd={detail.totals.commissionIqd} /> },
              { label: t("run.cashLine"), value: <Money iqd={-detail.totals.netIqd} />, strong: true },
            ]}
          />
          <Select name="paidFrom" label={t("run.paidFrom")} required defaultValue="bank_clearing" error={fields.paidFrom} options={PAID_FROM_LIST.map((value) => ({ value, label: t(`paidFrom.${value}`) }))} />
          <TextField name="reference" label={t("run.reference")} optional maxLength={80} ltr hint={t("run.referenceHint")} error={fields.reference} />
        </>
      )}
    </FormDialog>
  );
}

function RunFacts({ detail }: { detail: Detail }) {
  const t = useStaffT();
  const { run } = detail;
  return (
    <Section id="facts" title={t("run.facts")} className="stf-noprint">
      <div className="adm-card gap-2">
        <Pair label={t("payroll.col.preparedBy")}>
          <ByName by={run.createdBy} /> · <When at={run.createdAt} />
        </Pair>
        <Pair label={t("payroll.col.approvedBy")}>{run.approvedBy ? <span><ByName by={run.approvedBy} /> · <When at={run.approvedAt} /></span> : "—"}</Pair>
        <Pair label={t("payroll.col.paidAt")}>
          {run.paidAt && run.paidBy ? (
            <span>
              <ByName by={run.paidBy} /> · <When at={run.paidAt} />
            </span>
          ) : (
            <When at={run.paidAt} />
          )}
        </Pair>
        {run.notes ? <Pair label={t("payroll.notes")}>{run.notes}</Pair> : null}
        {run.journalEntryId ? (
          <Pair label={t("run.journal")}>
            {detail.can.journal ? (
              <Link to={`/admin/finance/journal/${run.journalEntryId}`} className="adm-link">
                <Code>{run.journalEntryId}</Code>
              </Link>
            ) : (
              <Code>{run.journalEntryId}</Code>
            )}
          </Pair>
        ) : null}
      </div>
    </Section>
  );
}

function Payslips({ detail }: { detail: Detail }) {
  const t = useStaffT();
  usePrintInLight();
  return (
    <div className="stf-print-only">
      <div className="stf-slips">
        {detail.items.map((item) => (
          <article key={item.employee.id} className="stf-slip">
            <h2 className="adm-h2">
              {t("run.slipTitle")} · <PeriodName period={detail.run.period} />
            </h2>
            <p className="type-body">
              {item.employee.name}
              {item.employee.jobTitle ? ` · ${item.employee.jobTitle}` : ""}
            </p>
            <p className="type-caption text-ink-2">
              <Code>{detail.run.ref}</Code> · {t(`runStatus.${detail.run.status}`)}
              {detail.run.isDemo ? ` · ${t("common.demo")}` : ""}
            </p>
            <Ledger
              rows={[
                { label: t("payroll.col.base"), value: <Money iqd={item.baseIqd} /> },
                { label: t("payroll.col.commission"), value: <Money iqd={item.commissionIqd} /> },
                { label: t("payroll.col.bonus"), value: <Money iqd={item.bonusIqd} />, hidden: !item.bonusIqd },
                { label: t("payroll.col.advances"), value: <Money iqd={-item.advanceDeductionIqd} />, hidden: !item.advanceDeductionIqd },
                { label: t("payroll.col.other"), value: <Money iqd={-item.otherDeductionIqd} />, hidden: !item.otherDeductionIqd },
                { label: t("payroll.col.net"), value: <Money iqd={item.netIqd} />, strong: true },
              ]}
            />
            {item.notes ? <p className="type-caption">{item.notes}</p> : null}
            <p className="type-caption text-ink-2">{t("run.slipSign")}</p>
          </article>
        ))}
      </div>
    </div>
  );
}
