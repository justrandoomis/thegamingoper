import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/repairs";
import { throwAsResponse } from "~/server/errors";
import { deviceOptions, listRepairs, openCounterRepair } from "~/server/services/admin/returns/repair.server";
import { parseRepairFilters, REPAIR_STATUS_LIST, REPAIR_VIEWS, repairSearch, type RepairListRow } from "~/server/services/admin/returns/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { returnsMeta } from "./meta";
import { failed, openReturns, text } from "./returns.server";
import { DemoNote, Due, Failure, PhoneText, Ref, RepairStatusBadge, useReturnsT, When } from "./ui";

/**
 * /admin/returns/repairs — repair tickets with their SLA timers (12.07): open, late, mine, under warranty, finished;
 * status and search in the URL (works without JavaScript); a device handed over at the shop opens a ticket here
 * (source "store", received at once, the SLA clock running). Every change happens on the ticket's page.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now, ctx } = await openReturns(context, ["returns.repair.manage", "returns.rma.read", "returns.warranty.read"]);
  try {
    const page = await listRepairs(db, actor, parseRepairFilters(new URL(request.url).searchParams), locale, now);
    return { page, devices: page.canManage ? await deviceOptions(db, locale) : [], key: crypto.randomUUID(), demo: ctx.storeMode === "demo" };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now, ctx } = await openReturns(context, "returns.repair.manage");
  const form = await request.formData();
  try {
    const device = text(form, "deviceModelId");
    const result = await openCounterRepair(
      db,
      actor,
      {
        phone: text(form, "phone"),
        contactName: text(form, "contactName") || undefined,
        deviceModelId: device && device !== "other" ? device : undefined,
        deviceText: device === "other" || !device ? text(form, "deviceText") || undefined : undefined,
        serial: text(form, "serial") || undefined,
        issue: text(form, "issue"),
        idempotencyKey: text(form, "idempotencyKey"),
      },
      now,
      ctx.storeMode,
    );
    throw redirect(`/admin/returns/repairs/${result.ref}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "counter");
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "repairs.title");

export default function Repairs({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const navigation = useNavigation();
  const result = useActionData<typeof action>();
  const failure = result && "ok" in result && !result.ok ? result : null;
  const { page, devices, key } = loaderData;
  const filters = page.filters;
  const columns: DataColumn<RepairListRow>[] = [
    {
      key: "ref",
      header: t("repairs.col.ref"),
      cell: (row) => (
        <Link to={`/admin/returns/repairs/${row.ref}`} className="adm-link whitespace-nowrap">
          <Ref value={row.ref} />
        </Link>
      ),
    },
    { key: "device", header: t("repairs.col.device"), cell: (row) => row.device ?? "—" },
    {
      key: "customer",
      header: t("repairs.col.customer"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <span>{row.customerName ?? "—"}</span>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("repairs.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1 whitespace-nowrap">
          <RepairStatusBadge status={row.status} />
          {row.isWarranty ? <span className="ret-tag">{t("repairs.warrantyTag")}</span> : null}
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "sla", header: t("repairs.col.sla"), cell: (row) => <span className="whitespace-nowrap">{row.slaDueAt ? <Due dueAt={row.slaDueAt} late={row.late} dueKey="repairs.slaDue" lateKey="repairs.slaLate" /> : t("repairs.slaNone")}</span> },
    { key: "assigned", header: t("repairs.col.assigned"), cell: (row) => row.assignedTo?.name ?? "—" },
    { key: "source", header: t("repairs.col.source"), cell: (row) => (row.rma ? <Ref value={row.rma} /> : t(`repairSource.${row.source}`)) },
    { key: "created", header: t("repairs.col.created"), cell: (row) => <span className="whitespace-nowrap"><When at={row.createdAt} /></span> },
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("repairs.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("repairs.lead")}</p>
      </header>

      <nav aria-label={t("repairs.viewsLabel")} className="flex flex-wrap gap-2">
        {REPAIR_VIEWS.map((view) => (
          <Key key={view} as={Link} to={`/admin/returns/repairs${repairSearch({ view })}`} size="sm" held={filters.view === view && !filters.q && !filters.status} aria-current={filters.view === view && !filters.q && !filters.status ? "true" : undefined}>
            {t(`repairs.views.${view}`)}
          </Key>
        ))}
      </nav>
      <Form method="get" action="/admin/returns/repairs" className="grid gap-3 sm:grid-cols-[1fr_minmax(12rem,auto)_auto] sm:items-end">
        {filters.view !== "open" ? <input type="hidden" name="view" value={filters.view} /> : null}
        <TextField name="q" type="search" label={t("repairs.search")} hint={t("repairs.searchHint")} defaultValue={filters.q} />
        <Select name="status" label={t("repairs.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("repairs.any") }, ...REPAIR_STATUS_LIST.map((status) => ({ value: status, label: t(`repairStatus.${status}`) }))]} />
        <Key type="submit" variant="ink" icon="magnifying-glass">
          {t("repairs.apply")}
        </Key>
      </Form>
      <p className="type-caption text-ink-2" aria-live="polite">
        {t("repairs.count", { count: page.total })}
      </p>
      {page.rows.length === 0 ? (
        <EmptyState title={filters.q || filters.status ? t("repairs.emptyFiltered") : t("repairs.empty")} text={filters.q || filters.status ? undefined : t("repairs.emptyHint")} icon="wrench" />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable
              caption={t("repairs.title")}
              columns={columns}
              rows={page.rows}
              rowKey={(row) => row.id}
              busy={navigation.state === "loading"}
              maxHeight={null}
              footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => repairSearch({ ...filters, page: n }) || "?"} />}
            />
          </div>
          <div className="md:hidden">
            <ul className="ret-cards" aria-label={t("repairs.title")}>
              {page.rows.map((row) => (
                <li key={row.id}>
                  <Link to={`/admin/returns/repairs/${row.ref}`} className="ret-card">
                    <span className="ret-card__top">
                      <span className="type-strong">
                        <Ref value={row.ref} />
                      </span>
                      <RepairStatusBadge status={row.status} />
                    </span>
                    <span className="type-body">{row.device ?? "—"}</span>
                    <span className="type-caption text-ink-2">{row.customerName ?? "—"}</span>
                    {row.slaDueAt ? <Due dueAt={row.slaDueAt} late={row.late} dueKey="repairs.slaDue" lateKey="repairs.slaLate" /> : null}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Pagination page={page.page} pageCount={page.pageCount} href={(n) => repairSearch({ ...filters, page: n }) || "?"} />
            </div>
          </div>
        </>
      )}

      {page.canManage ? (
        <Disclosure summary={t("repairs.new.title")} variant="panel" defaultOpen={failure !== null}>
          <p className="type-caption text-ink-2">{t("repairs.new.lead")}</p>
          <Form method="post" className="grid gap-3 md:grid-cols-2" noValidate>
            <input type="hidden" name="idempotencyKey" value={key} />
            <TextField name="phone" type="tel" label={t("repairs.new.phone")} required ltr error={failure?.fields?.phone} />
            <TextField name="contactName" label={t("repairs.new.name")} optional error={failure?.fields?.contactName} />
            <Select name="deviceModelId" label={t("repairs.new.device")} defaultValue="" options={[{ value: "", label: t("new.form.choose") }, ...devices.map((device) => ({ value: device.id, label: device.name })), { value: "other", label: t("repairs.new.deviceOther") }]} error={failure?.fields?.deviceModelId} />
            <TextField name="deviceText" label={t("repairs.new.deviceText")} optional error={failure?.fields?.deviceText} />
            <TextField name="serial" label={t("repairs.new.serial")} hint={t("repairs.new.serialHint")} optional ltr error={failure?.fields?.serial} />
            <TextArea name="issue" label={t("repairs.new.issue")} hint={t("repairs.new.issueHint")} required className="md:col-span-2" error={failure?.fields?.issue} />
            <div className="grid gap-2 md:col-span-2">
              <Failure message={failure ? (failure.message ?? t(`errors.${failure.code}`)) : null} />
              <div>
                <Key type="submit" variant="ink" icon="wrench" loading={navigation.state === "submitting"}>
                  {t("repairs.new.submit")}
                </Key>
              </div>
            </div>
          </Form>
        </Disclosure>
      ) : null}
    </>
  );
}
