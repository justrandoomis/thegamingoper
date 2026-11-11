import { Form, Link } from "react-router";

import type { Route } from "./+types/consents";
import { throwAsResponse } from "~/server/errors";
import { consentSources, listConsentLog, type ConsentLogRow } from "~/server/services/admin/customers/privacy.server";
import { CONSENT_FILTERS, CONSENT_KIND_LIST, consentSearch, parseConsentFilters } from "~/server/services/admin/customers/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { openCustomers } from "./customers.server";
import { customersMeta } from "./meta";
import { Notice, PhoneText, Ref, sourceLabel, useCustomersT, When } from "./ui";

/**
 * /admin/customers/consents — 07.04: the consent log across customers and guests, newest first: marketing and the
 * other questions, every grant and withdrawal (the unsubscribes view is "marketing · withdrawn"), where it was given and
 * which policy version the person saw. Append-only: there is nothing to edit here. Filters in the URL.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor } = await openCustomers(context, "customers.consent.read");
  const filters = parseConsentFilters(new URL(request.url).searchParams);
  try {
    const [page, sources] = await Promise.all([listConsentLog(db, actor, filters), consentSources(db, actor)]);
    return { page, sources, filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "consentLog.title");

export default function ConsentLogPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { page, sources, filters } = loaderData;
  const filtered = Boolean(filters.q || filters.kind || filters.answer !== "all" || filters.source);
  const unsubscribes = consentSearch({ kind: "marketing", answer: "withdrawn" });
  const columns: DataColumn<ConsentLogRow>[] = [
    { key: "at", header: t("consentLog.col.at"), cell: (row) => <span className="whitespace-nowrap"><When at={row.at} /></span> },
    {
      key: "who",
      header: t("consentLog.col.who"),
      cell: (row) =>
        row.customer ? (
          <span className="grid py-1">
            <Link to={`/admin/customers/${encodeURIComponent(row.customer.id)}/privacy`} className="adm-link">
              {row.customer.status === "deleted" ? t("customer.erasedTitle") : (row.customer.name ?? t("list.noName"))}
            </Link>
            <span className="type-caption text-ink-2">
              <PhoneText phone={row.customer.phone} />
            </span>
          </span>
        ) : (
          <span className="grid py-1">
            <span>{t(`consentLog.subject.${row.subjectType}`)}</span>
            {row.guestPhone ? (
              <span className="type-caption text-ink-2">
                <PhoneText phone={row.guestPhone} />
              </span>
            ) : null}
          </span>
        ),
    },
    { key: "kind", header: t("consentLog.col.kind"), cell: (row) => t(`consentKind.${row.kind}`) },
    { key: "answer", header: t("consentLog.col.answer"), cell: (row) => <Status tone={row.granted ? "ok" : "neutral"}>{t(row.granted ? "consent.granted" : "consent.withdrawn")}</Status> },
    { key: "source", header: t("consentLog.col.source"), cell: (row) => sourceLabel(t, row.source) },
    { key: "policy", header: t("consentLog.col.policy"), cell: (row) => (row.policyVersion ? <Ref value={row.policyVersion} /> : "—") },
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("consentLog.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("consentLog.lead")}</p>
      </header>
      <section className="adm-section" aria-labelledby="consent-log">
        <div className="adm-section__head">
          <h2 id="consent-log" className="adm-h2">
            {t("consentLog.listTitle")}
          </h2>
          <Key as={Link} to={`/admin/customers/consents${unsubscribes}`} size="sm" held={filters.kind === "marketing" && filters.answer === "withdrawn"}>
            {t("consentLog.unsubscribes")}
          </Key>
        </div>
        <Notice>{t("consentLog.appendOnly")}</Notice>
        <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={filtered}>
          <Form method="get" action="/admin/customers/consents" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <TextField name="q" type="search" label={t("consentLog.search")} hint={t("consentLog.searchHint")} defaultValue={filters.q} maxLength={40} />
            <Select name="kind" label={t("consentLog.col.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("consentLog.anyKind") }, ...CONSENT_KIND_LIST.map((kind) => ({ value: kind, label: t(`consentKind.${kind}`) }))]} />
            <Select name="answer" label={t("consentLog.col.answer")} defaultValue={filters.answer} options={CONSENT_FILTERS.map((answer) => ({ value: answer, label: t(`consentLog.answers.${answer}`) }))} />
            <Select name="source" label={t("consentLog.col.source")} defaultValue={filters.source ?? ""} options={[{ value: "", label: t("consentLog.anySource") }, ...sources.map((source) => ({ value: source, label: sourceLabel(t, source) }))]} />
            <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
              <Key type="submit" variant="ink" icon="funnel">
                {t("list.apply")}
              </Key>
              <Key as={Link} to="/admin/customers/consents">
                {t("list.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("consentLog.count", { count: page.total })}
        </p>
        {page.rows.length === 0 ? (
          <EmptyState title={filtered ? t("list.emptyFiltered") : t("consentLog.empty")} text={filtered ? t("list.emptyFilteredHint") : t("consentLog.emptyHint")} icon="check-circle" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("consentLog.listTitle")} columns={columns} rows={page.rows} rowKey={(row) => row.id} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => consentSearch({ ...filters, page: n }) || "?"} />} />
            </div>
            <div className="md:hidden">
              <ul className="cus-cards" aria-label={t("consentLog.listTitle")}>
                {page.rows.map((row) => (
                  <li key={row.id} className="cus-card">
                    <span className="cus-card__top">
                      <span className="type-strong">{t(`consentKind.${row.kind}`)}</span>
                      <Status tone={row.granted ? "ok" : "neutral"}>{t(row.granted ? "consent.granted" : "consent.withdrawn")}</Status>
                    </span>
                    <span className="cus-card__top type-caption text-ink-2">
                      <span>{row.customer ? (row.customer.status === "deleted" ? t("customer.erasedTitle") : (row.customer.name ?? t("list.noName"))) : t(`consentLog.subject.${row.subjectType}`)}</span>
                      <When at={row.at} />
                    </span>
                    <span className="type-caption text-ink-2">
                      {t("consentLog.source")}: {sourceLabel(t, row.source)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => consentSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
