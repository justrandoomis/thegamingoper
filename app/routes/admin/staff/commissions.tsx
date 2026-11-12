import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/commissions";
import { invalid } from "~/server/errors";
import { commissionLedger, endPlan, listPlans, saveRuleVersion, syncCommissions } from "~/server/services/admin/staff/commissions.server";
import { bpsText, COMMISSION_BASIS_LIST, parseCommissionFilters, parseRateBps, PRODUCT_KIND_LIST, RULE_SCOPE_LIST, searchOf, shiftPeriod, type CommissionLine, type CommissionTotals, type RulePlanView } from "~/server/services/admin/staff/types";
import type { DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { staffMeta } from "./meta";
import { failed, ok, openStaff, optional, orRespond, staffT, text } from "./staff.server";
import { ActionDialog, Code, Day, DemoTag, FormDialog, Kpi, Money, Note, PageHead, Pair, PeriodName, Rate, ResponsiveTable, Section, StateTag, When, usePeriodLabel, useStaffT } from "./ui";

/**
 * /admin/staff/commissions — 15.03: the commission plans (versioned: a change is a new version that starts now or on a
 * later day; ending a plan ends its latest version; a profit plan only with profit.read) and the month's commissions per
 * employee and line by line (sales or realised profit, net of returns; the base and rate of a profit row only with
 * profit.read). "Compute" writes the month's differences; a payroll run computes too before it plans. Month and
 * employee in the URL.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openStaff(context);
  const filters = parseCommissionFilters(new URL(request.url).searchParams, now);
  const [plans, ledger] = await Promise.all([orRespond(() => listPlans(db, actor, locale, now)), orRespond(() => commissionLedger(db, actor, filters))]);
  return { plans, ledger, filters, now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openStaff(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = staffT(req.locale);
  try {
    switch (intent) {
      case "save": {
        const rate = parseRateBps(text(form, "rate"));
        const result = await saveRuleVersion(
          req.db,
          req.actor,
          {
            planId: optional(form, "planId"),
            name: text(form, "name"),
            basis: text(form, "basis") as never,
            rateBps: rate === undefined ? Number.NaN : rate,
            scope: text(form, "scope") as never,
            roleId: optional(form, "roleId"),
            employeeId: optional(form, "employeeId"),
            productKind: (optional(form, "productKind") ?? "*") as never,
            categoryId: optional(form, "categoryId"),
            channel: (optional(form, "channel") ?? "") as never,
            startsOn: optional(form, "startsOn"),
            endsOn: optional(form, "endsOn"),
            reason: text(form, "reason"),
          },
          req.now,
        );
        return ok(intent, { message: result.version === 1 ? t("commissions.planCreated") : t("commissions.versionCreated", { version: result.version }) });
      }
      case "end":
        await endPlan(req.db, req.actor, { planId: text(form, "planId"), endsOn: optional(form, "endsOn"), reason: text(form, "reason") }, req.now);
        return ok(intent, { message: t("commissions.planEnded") });
      case "sync": {
        const result = await syncCommissions(req.db, req.actor, { period: text(form, "period") }, req.now);
        return ok(intent, { message: t("commissions.synced", { earned: result.earned, clawbacks: result.clawbacks, uncosted: result.uncosted }) });
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "commissions.title");

type Plans = Route.ComponentProps["loaderData"]["plans"];

export default function CommissionsPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const label = usePeriodLabel();
  const { plans, ledger, filters, now } = loaderData;
  const [editing, setEditing] = useState<RulePlanView | "new" | null>(null);
  const [ending, setEnding] = useState<RulePlanView | null>(null);
  const [syncing, setSyncing] = useState(false);
  const periodHref = (period: string) => `/admin/staff/commissions${searchOf({ period, employee: filters.employee })}`;
  const totalColumns: DataColumn<CommissionTotals>[] = [
    {
      key: "employee",
      header: t("commissions.col.employee"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Link to={`/admin/staff/commissions${searchOf({ period: filters.period, employee: row.employee.id })}`} className="adm-link">
            {row.employee.name}
          </Link>
          <DemoTag show={row.employee.isDemo} />
        </span>
      ),
    },
    { key: "earn", header: t("commissions.col.earned"), numeric: true, cell: (row) => <Money iqd={row.earnIqd} /> },
    { key: "claw", header: t("commissions.col.clawedBack"), numeric: true, cell: (row) => (row.clawbackIqd ? <Money iqd={-row.clawbackIqd} /> : <Money iqd={0} />) },
    { key: "net", header: t("commissions.col.net"), numeric: true, cell: (row) => <Money iqd={row.netIqd} className="type-strong" /> },
    { key: "accrued", header: t("commissions.col.accrued"), numeric: true, cell: (row) => <Money iqd={row.accruedIqd} /> },
    { key: "inRun", header: t("commissions.col.inRun"), numeric: true, cell: (row) => <Money iqd={row.inRunIqd} /> },
    { key: "paid", header: t("commissions.col.paid"), numeric: true, cell: (row) => <Money iqd={row.paidIqd} /> },
  ];
  const lineColumns: DataColumn<CommissionLine>[] = [
    { key: "order", header: t("commissions.col.order"), cell: (row) => <Code>{row.orderRef}</Code> },
    { key: "employee", header: t("commissions.col.employee"), cell: (row) => row.employee.name },
    { key: "kind", header: t("commissions.col.kind"), cell: (row) => t(`commissionKind.${row.kind}`) },
    { key: "basis", header: t("commissions.col.basis"), cell: (row) => t(`basis.${row.basis}`) },
    { key: "base", header: t("commissions.col.base"), numeric: true, cell: (row) => <Money iqd={row.baseIqd} unknown={t("commissions.needsProfit")} /> },
    { key: "rate", header: t("commissions.col.rate"), numeric: true, cell: (row) => <Rate bps={row.rateBps} unknown={t("commissions.needsProfit")} /> },
    { key: "amount", header: t("commissions.col.amount"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} signed /> },
    { key: "status", header: t("commissions.col.status"), cell: (row) => <StateTag group="commission" value={row.status} label={t(`commissionStatus.${row.status}`)} /> },
    { key: "at", header: t("commissions.col.computed"), cell: (row) => <When at={row.createdAt} /> },
  ];
  return (
    <>
      <PageHead
        title={t("commissions.title")}
        lead={t("commissions.lead")}
        actions={
          plans.can.manage ? (
            <Key size="sm" icon="plus" onClick={() => setEditing("new")}>
              {t("commissions.newPlan")}
            </Key>
          ) : null
        }
      />

      <Section id="plans" title={t("commissions.plans")}>
        {plans.plans.length ? (
          <ul role="list" className="grid gap-2">
            {plans.plans.map((plan) => (
              <PlanCard key={plan.planId} plan={plan} canManage={plans.can.manage && (plan.current.basis === "sales" || plans.can.profit)} onEdit={() => setEditing(plan)} onEnd={() => setEnding(plan)} />
            ))}
          </ul>
        ) : (
          <EmptyState title={t("commissions.noPlans")} text={t("commissions.noPlansHint")} icon="hand-coins" />
        )}
      </Section>

      <Section
        id="ledger"
        title={
          <>
            {t("commissions.ledger")} · <PeriodName period={filters.period} />
          </>
        }
        aside={
          ledger.can.sync ? (
            <Key size="sm" icon="arrows-clockwise" onClick={() => setSyncing(true)}>
              {t("commissions.sync")}
            </Key>
          ) : null
        }
      >
        <div className="stf-noprint flex flex-wrap items-end gap-2">
          <Key as={Link} to={periodHref(shiftPeriod(filters.period, -1))} size="sm" icon="caret-left">
            {label(shiftPeriod(filters.period, -1))}
          </Key>
          <Key as={Link} to={periodHref(shiftPeriod(filters.period, 1))} size="sm" iconEnd="caret-right">
            {label(shiftPeriod(filters.period, 1))}
          </Key>
          <Form method="get" action="/admin/staff/commissions" className="flex flex-wrap items-end gap-2">
            <TextField name="period" type="month" label={t("common.month")} defaultValue={filters.period} ltr className="w-44" />
            <Select name="employee" label={t("commissions.col.employee")} defaultValue={filters.employee ?? ""} options={[{ value: "", label: t("common.any") }, ...ledger.employees.map((person) => ({ value: person.id, label: person.name }))]} />
            <Key type="submit" size="sm" icon="funnel">
              {t("common.apply")}
            </Key>
          </Form>
        </div>
        <div className="stf-kpis">
          <Kpi label={t("commissions.col.earned")} value={<Money iqd={ledger.sum.earnIqd} />} />
          <Kpi label={t("commissions.col.clawedBack")} value={<Money iqd={ledger.sum.clawbackIqd ? -ledger.sum.clawbackIqd : 0} />} />
          <Kpi label={t("commissions.col.net")} value={<Money iqd={ledger.sum.netIqd} />} />
          <Kpi label={t("commissions.col.paid")} value={<Money iqd={ledger.sum.paidIqd} />} />
        </div>
        <ResponsiveTable
          caption={t("commissions.byEmployee")}
          columns={totalColumns}
          rows={ledger.totals}
          rowKey={(row) => row.employee.id}
          empty={<EmptyState title={t("commissions.emptyMonth")} text={ledger.can.sync ? t("commissions.emptyMonthSync") : t("commissions.emptyMonthHint")} icon="hand-coins" />}
          card={(row) => (
            <>
              <span className="type-strong">{row.employee.name}</span>
              <Pair label={t("commissions.col.earned")}>
                <Money iqd={row.earnIqd} />
              </Pair>
              <Pair label={t("commissions.col.clawedBack")}>
                <Money iqd={row.clawbackIqd ? -row.clawbackIqd : 0} />
              </Pair>
              <Pair label={t("commissions.col.net")}>
                <Money iqd={row.netIqd} className="type-strong" />
              </Pair>
            </>
          )}
        />
        {ledger.lines.length ? (
          <Disclosure variant="row" summary={t("commissions.lines", { count: ledger.total })} defaultOpen={Boolean(filters.employee)}>
            <ResponsiveTable
              caption={t("commissions.lineList")}
              columns={lineColumns}
              rows={ledger.lines}
              rowKey={(row) => row.id}
              footer={<Pagination page={ledger.page} pageCount={ledger.pageCount} href={(n) => `/admin/staff/commissions${searchOf({ period: filters.period, employee: filters.employee, page: n })}` || "?"} />}
              card={(row) => (
                <>
                  <div className="flex items-baseline justify-between gap-2">
                    <Code>{row.orderRef}</Code>
                    <Money iqd={row.amountIqd} signed className="type-strong" />
                  </div>
                  <Pair label={t("commissions.col.kind")}>{t(`commissionKind.${row.kind}`)}</Pair>
                  <Pair label={t("commissions.col.base")}>
                    <Money iqd={row.baseIqd} unknown={t("commissions.needsProfit")} />
                  </Pair>
                  <Pair label={t("commissions.col.rate")}>
                    <Rate bps={row.rateBps} unknown={t("commissions.needsProfit")} />
                  </Pair>
                </>
              )}
            />
          </Disclosure>
        ) : null}
      </Section>
      <Note>
        <p>{t("commissions.rules")}</p>
      </Note>

      {editing ? <PlanForm plans={plans} plan={editing === "new" ? null : editing} now={now} onClose={() => setEditing(null)} /> : null}
      {ending ? (
        <ActionDialog
          open
          onClose={() => setEnding(null)}
          tone="destructive"
          title={t("commissions.endQ", { name: ending.current.name })}
          consequence={t("commissions.endWhat")}
          confirmLabel={t("commissions.end")}
          reason
          fields={{ intent: "end", planId: ending.planId }}
          successMessage={t("commissions.planEnded")}
        />
      ) : null}
      <ActionDialog
        open={syncing}
        onClose={() => setSyncing(false)}
        title={t("commissions.syncQ", { month: label(filters.period) })}
        consequence={t("commissions.syncWhat")}
        impact={[{ label: t("commissions.col.net"), value: <Money iqd={ledger.sum.netIqd} /> }]}
        confirmLabel={t("commissions.sync")}
        fields={{ intent: "sync", period: filters.period }}
        successMessage={t("commissions.syncedShort")}
      />
    </>
  );
}

function PlanCard({ plan, canManage, onEdit, onEnd }: { plan: RulePlanView; canManage: boolean; onEdit: () => void; onEnd: () => void }) {
  const t = useStaffT();
  const current = plan.current;
  return (
    <li className="adm-card gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="grid">
          <span className="type-strong">{current.name}</span>
          <span className="type-caption text-ink-2">
            {t(`ruleScope.${current.scope}`)}
            {current.target ? ` · ${current.target}` : ""} · {t("commissions.versionN", { version: current.version })}
          </span>
        </span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <StateTag group="commission" value={current.state === "current" ? "approved" : current.state === "scheduled" ? "accrued" : "void"} label={t(`ruleState.${current.state}`)} />
        </span>
      </div>
      <div className="grid max-w-3xl gap-x-10 gap-y-1 sm:grid-cols-2">
        <Pair label={t("commissions.col.basis")}>{t(`basis.${current.basis}`)}</Pair>
        <Pair label={t("commissions.col.rate")}>
          <Rate bps={current.rateBps} unknown={t("commissions.needsProfit")} />
        </Pair>
        <Pair label={t("commissions.productKind")}>{current.productKind === "*" ? t("commissions.allKinds") : t(`productKind.${current.productKind}`)}</Pair>
        <Pair label={t("commissions.channel")}>{current.channel ? t(`channel.${current.channel}`) : t("commissions.allChannels")}</Pair>
        {current.category ? <Pair label={t("commissions.category")}>{current.category}</Pair> : null}
        <Pair label={t("commissions.from")}>{current.startsAt ? <When at={current.startsAt} kind="date" /> : "—"}</Pair>
        <Pair label={t("commissions.until")}>{current.endsAt ? <When at={current.endsAt} kind="date" /> : t("commissions.openEnded")}</Pair>
      </div>
      {plan.versions.length > 1 ? (
        <Disclosure variant="row" summary={t("commissions.history", { count: plan.versions.length })}>
          <ol role="list" className="grid gap-1 py-2">
            {plan.versions.map((version) => (
              <li key={version.id} className="flex flex-wrap items-baseline justify-between gap-2 type-caption">
                <span>
                  {t("commissions.versionN", { version: version.version })} · {t(`basis.${version.basis}`)} · <Rate bps={version.rateBps} unknown={t("commissions.needsProfit")} />
                </span>
                <span className="text-ink-2">
                  {version.startsAt ? <When at={version.startsAt} kind="date" /> : "—"} → {version.endsAt ? <When at={version.endsAt} kind="date" /> : t("commissions.openEnded")}
                  {version.createdBy ? ` · ${version.createdBy}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
      {canManage && current.state !== "ended" ? (
        <div className="flex flex-wrap gap-2 stf-noprint">
          <Key size="sm" icon="pencil-simple" onClick={onEdit}>
            {t("commissions.newVersion")}
          </Key>
          <Key size="sm" variant="ghost" icon="x" onClick={onEnd}>
            {t("commissions.end")}
          </Key>
        </div>
      ) : null}
    </li>
  );
}

function PlanForm({ plans, plan, now, onClose }: { plans: Plans; plan: RulePlanView | null; now: number; onClose: () => void }) {
  const t = useStaffT();
  const [scope, setScope] = useState<string>(plan?.current.scope ?? "everyone");
  const current = plan?.current;
  return (
    <FormDialog
      title={plan ? t("commissions.versionTitle", { name: plan.current.name }) : t("commissions.newTitle")}
      description={plan ? t("commissions.versionWhat") : t("commissions.newWhat")}
      submitLabel={plan ? t("commissions.saveVersion") : t("commissions.savePlan")}
      onClose={onClose}
      successMessage={t("commissions.saved")}
      hidden={{ intent: "save", ...(plan ? { planId: plan.planId } : {}) }}
    >
      {(fields) => (
        <>
          <TextField name="name" label={t("commissions.name")} required minLength={3} maxLength={80} defaultValue={current?.name ?? ""} error={fields.name} />
          <div className="grid grid-cols-2 gap-3">
            <Select name="basis" label={t("commissions.col.basis")} defaultValue={current?.basis ?? "sales"} error={fields.basis} options={COMMISSION_BASIS_LIST.filter((basis) => basis === "sales" || plans.can.profit).map((basis) => ({ value: basis, label: t(`basis.${basis}`) }))} />
            <TextField name="rate" label={t("commissions.rateField")} required inputMode="decimal" defaultValue={current?.rateBps ? bpsText(current.rateBps) : ""} ltr end={<span className="type-caption text-ink-2">%</span>} error={fields.rateBps} />
          </div>
          <Select name="scope" label={t("commissions.scope")} value={scope} onChange={(event) => setScope(event.currentTarget.value)} options={RULE_SCOPE_LIST.map((value) => ({ value, label: t(`ruleScope.${value}`) }))} />
          {scope === "role" ? <Select name="roleId" label={t("commissions.role")} required error={fields.roleId} options={[{ value: "", label: t("common.choose") }, ...plans.roles.map((role) => ({ value: role.id, label: role.name }))]} /> : null}
          {scope === "employee" ? <Select name="employeeId" label={t("commissions.col.employee")} required error={fields.employeeId} options={[{ value: "", label: t("common.choose") }, ...plans.employees.map((person) => ({ value: person.id, label: person.name }))]} /> : null}
          <div className="grid grid-cols-2 gap-3">
            <Select name="productKind" label={t("commissions.productKind")} defaultValue={current?.productKind ?? "*"} options={[{ value: "*", label: t("commissions.allKinds") }, ...PRODUCT_KIND_LIST.map((kind) => ({ value: kind, label: t(`productKind.${kind}`) }))]} />
            <Select name="channel" label={t("commissions.channel")} defaultValue={current?.channel ?? ""} options={[{ value: "", label: t("commissions.allChannels") }, { value: "pos", label: t("channel.pos") }, { value: "web", label: t("channel.web") }]} />
          </div>
          <Select name="categoryId" label={t("commissions.category")} optional defaultValue="" error={fields.categoryId} options={[{ value: "", label: t("commissions.anyCategory") }, ...plans.categories.map((category) => ({ value: category.id, label: category.name }))]} />
          <div className="grid grid-cols-2 gap-3">
            <TextField name="startsOn" type="date" label={t("commissions.from")} hint={t("commissions.fromHint")} ltr error={fields.startsOn} />
            <TextField name="endsOn" type="date" label={t("commissions.until")} optional ltr error={fields.endsOn} />
          </div>
          <TextField name="reason" label={t("common.reason")} required minLength={3} maxLength={500} error={fields.reason} />
          <p className="type-caption text-ink-2">
            {t("commissions.todayIs")} <Day day={new Date(now + 3 * 3_600_000).toISOString().slice(0, 10)} />
          </p>
        </>
      )}
    </FormDialog>
  );
}
