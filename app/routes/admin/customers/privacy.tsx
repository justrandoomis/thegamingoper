import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/privacy";
import { throwAsResponse } from "~/server/errors";
import { listPrivacyRequests, type PrivacyRequestRow } from "~/server/services/admin/customers/privacy.server";
import { parsePrivacyFilters, PRIVACY_DUE_DAYS, PRIVACY_KIND_LIST, PRIVACY_VIEWS, privacySearch } from "~/server/services/admin/customers/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { privacyQueueAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { Failure, newKey, PhoneText, PrivacyStatusBadge, Ref, Section, useCustomersT, useIntent, When } from "./ui";

/**
 * /admin/customers/privacy — 07.04: privacy requests (export, deletion, correction, unsubscribe) with their due date
 * (the store's own target), overdue ones first, filters in the URL; a request is opened here on the customer's behalf
 * (by phone number — it links to the account when there is one). Nothing is handed out or erased before the person is
 * verified; that happens on the request's own page.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.privacy.manage");
  const filters = parsePrivacyFilters(new URL(request.url).searchParams);
  try {
    return { page: await listPrivacyRequests(db, actor, filters, now), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await privacyQueueAction(req.ctx, req.db, req.session, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "privacy.title");

export default function PrivacyQueuePage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { page, filters } = loaderData;
  const columns: DataColumn<PrivacyRequestRow>[] = [
    {
      key: "ref",
      header: t("privacy.col.ref"),
      cell: (row) => (
        <span className="grid py-1">
          <Link to={`/admin/customers/privacy/${row.ref}`} className="adm-link">
            <Ref value={row.ref} />
          </Link>
          <span className="type-caption text-ink-2">
            <When at={row.createdAt} />
          </span>
        </span>
      ),
    },
    { key: "kind", header: t("privacy.col.kind"), cell: (row) => t(`privacy.kind.${row.kind}`) },
    {
      key: "customer",
      header: t("privacy.col.customer"),
      cell: (row) => (
        <span className="grid py-1">
          {row.customer ? (
            <Link to={`/admin/customers/${encodeURIComponent(row.customer.id)}`} className="adm-link">
              {row.customer.status === "deleted" ? t("customer.erasedTitle") : (row.customer.name ?? t("list.noName"))}
            </Link>
          ) : (
            <span>{t("privacy.noAccount")}</span>
          )}
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    { key: "status", header: t("privacy.col.status"), cell: (row) => <PrivacyStatusBadge status={row.status} /> },
    {
      key: "due",
      header: t("privacy.col.due"),
      cell: (row) => (
        <span className={row.overdue ? "whitespace-nowrap text-red-ink" : "whitespace-nowrap"}>
          {row.dueAt ? <When at={row.dueAt} style="date" /> : "—"}
          {row.overdue ? ` · ${t("privacy.overdue")}` : ""}
        </span>
      ),
    },
    { key: "verified", header: t("privacy.col.verified"), cell: (row) => (row.verifiedAt ? <When at={row.verifiedAt} style="date" /> : t("privacy.notVerified")) },
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("privacy.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("privacy.lead", { days: PRIVACY_DUE_DAYS })}</p>
      </header>
      <div className="cus-layout">
        <div className="cus-main">
          <Section id="privacy-list" title={t("privacy.listTitle")}>
            <nav aria-label={t("privacy.viewsLabel")} className="flex flex-wrap gap-2">
              {PRIVACY_VIEWS.map((view) => (
                <Key key={view} as={Link} to={`/admin/customers/privacy${privacySearch({ ...filters, view, page: 1 })}`} size="sm" held={filters.view === view} aria-current={filters.view === view ? "true" : undefined}>
                  {t(`privacy.views.${view}`)}
                </Key>
              ))}
            </nav>
            <Form method="get" className="flex flex-wrap items-end gap-2">
              {filters.view !== "open" ? <input type="hidden" name="view" value={filters.view} /> : null}
              <Select name="kind" label={t("privacy.col.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("privacy.anyKind") }, ...PRIVACY_KIND_LIST.map((kind) => ({ value: kind, label: t(`privacy.kind.${kind}`) }))]} />
              <Key type="submit" size="sm" icon="funnel">
                {t("list.apply")}
              </Key>
            </Form>
            <p className="type-caption text-ink-2" aria-live="polite">
              {t("privacy.count", { count: page.total })}
            </p>
            {page.rows.length === 0 ? (
              <EmptyState title={t("privacy.empty")} text={t("privacy.emptyHint")} icon="shield-check" />
            ) : (
              <>
                <div className="hidden md:block">
                  <DataTable caption={t("privacy.listTitle")} columns={columns} rows={page.rows} rowKey={(row) => row.id} rowLabel={(row) => row.ref} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => privacySearch({ ...filters, page: n }) || "?"} />} />
                </div>
                <div className="md:hidden">
                  <ul className="cus-cards" aria-label={t("privacy.listTitle")}>
                    {page.rows.map((row) => (
                      <li key={row.id}>
                        <Link to={`/admin/customers/privacy/${row.ref}`} className="cus-card">
                          <span className="cus-card__top">
                            <span className="type-strong">
                              <Ref value={row.ref} /> · {t(`privacy.kind.${row.kind}`)}
                            </span>
                            <PrivacyStatusBadge status={row.status} />
                          </span>
                          <span className="cus-card__top type-caption text-ink-2">
                            <span>{row.customer ? (row.customer.status === "deleted" ? t("customer.erasedTitle") : (row.customer.name ?? t("list.noName"))) : t("privacy.noAccount")}</span>
                            <PhoneText phone={row.phone} />
                          </span>
                          <span className={row.overdue ? "type-caption text-red-ink" : "type-caption text-ink-2"}>
                            {t("privacy.col.due")}: {row.dueAt ? <When at={row.dueAt} style="date" /> : "—"}
                            {row.overdue ? ` · ${t("privacy.overdue")}` : ""}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4">
                    <Pagination page={page.page} pageCount={page.pageCount} href={(n) => privacySearch({ ...filters, page: n }) || "?"} />
                  </div>
                </div>
              </>
            )}
          </Section>
        </div>
        <aside className="cus-side" aria-label={t("privacy.side")}>
          <NewRequest />
        </aside>
      </div>
    </>
  );
}

function NewRequest() {
  const t = useCustomersT();
  const [kind, setKind] = useState<string>("export");
  const [formKey, setFormKey] = useState(() => newKey());
  const { fetcher, pending, message, fields } = useIntent("request", "done.requestOpened", () => setFormKey(newKey()));
  const opened = fetcher.data && fetcher.data.ok && fetcher.data.intent === "request" ? String((fetcher.data as { ref?: string }).ref ?? "") : "";
  return (
    <Section id="privacy-new" title={t("privacy.form.title")}>
      <fetcher.Form method="post" className="grid gap-3">
        <input type="hidden" name="intent" value="request" />
        <input type="hidden" name="idempotencyKey" value={formKey} />
        <TextField name="phone" type="tel" inputMode="tel" label={t("privacy.form.phone")} hint={t("privacy.form.phoneHint")} maxLength={40} error={fields.phone} required />
        <Select name="kind" label={t("privacy.form.kind")} value={kind} onChange={(event) => setKind(event.currentTarget.value)} options={PRIVACY_KIND_LIST.map((value) => ({ value, label: t(`privacy.kind.${value}`) }))} />
        <p className="type-caption text-ink-2">{t(`privacy.kindHint.${kind}`)}</p>
        <TextArea name="details" label={t("privacy.form.details")} hint={t("privacy.form.detailsHint")} rows={3} maxLength={1000} error={fields.details} />
        <Failure message={Object.keys(fields).length ? null : message} />
        {opened ? (
          <p className="type-body" role="status">
            {t("privacy.form.opened")}{" "}
            <Link to={`/admin/customers/privacy/${opened}`} className="adm-link">
              <Ref value={opened} />
            </Link>
          </p>
        ) : null}
        <div>
          <Key type="submit" size="sm" icon="shield-check" loading={pending}>
            {t("privacy.form.open")}
          </Key>
        </div>
        <p className="type-caption text-ink-2">{t("privacy.form.due", { days: PRIVACY_DUE_DAYS })}</p>
      </fetcher.Form>
    </Section>
  );
}
