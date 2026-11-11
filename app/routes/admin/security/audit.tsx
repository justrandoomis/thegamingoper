import { useEffect, useRef } from "react";
import { Form, Link, useFetcher } from "react-router";

import type { Route } from "./+types/audit";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { listAuditEvents, sealNow, verifyChain, type AuditRow } from "~/server/services/admin/security/audit-log.server";
import { staffOptions } from "~/server/services/admin/security/staff.server";
import { auditSearch, parseAuditFilters } from "~/server/services/admin/security/types";
import { invalid } from "~/server/errors";
import type { DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { Code, FormError, Note, PageHead, Pair, ResponsiveList, RowLink, Section, When, failureText, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { ok, text } from "./route-kit.server";
import { sec } from "./security.server";

/**
 * /admin/security/audit — 20.03: the audit trail, newest first, filtered in the URL (module, person, record type and
 * id, Baghdad days, text), 50 a page, CSV of the same filters (audited). The chain panel shows the last seal and its
 * head hash — compare it with the copies the daily job logs outside the database — and verifies or seals on demand
 * (security.audit.verify). There is no way to edit or delete an event: the database refuses it.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await sec.open(context, "audit.read");
  const filters = parseAuditFilters(new URL(request.url).searchParams);
  const [page, people] = await Promise.all([sec.orRespond(() => listAuditEvents(db, actor, filters)), can(actor, "security.session.read") ? staffOptions(db, actor) : Promise.resolve([])]);
  return { page, filters, people, canVerify: can(actor, "security.audit.verify"), search: auditSearch(filters) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await sec.open(context, "security.audit.verify");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent === "verify") return ok(intent, { report: await verifyChain(req.db, req.actor, req.now) });
    if (intent === "seal") return ok(intent, { seal: await sealNow(req.db, req.actor, req.now) });
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return sec.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "audit.title");

export default function AuditPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { page, filters, people, canVerify, search } = loaderData;
  const columns: DataColumn<AuditRow>[] = [
    { key: "at", header: t("audit.col.at"), cell: (row) => <RowLink to={`/admin/security/audit/${row.id}`}>{f.dateTime(row.at)}</RowLink> },
    { key: "who", header: t("audit.col.who"), cell: (row) => (row.actorKind === "system" ? <span className="text-ink-2">{t("audit.system", { job: row.actorLabel ?? row.actorId ?? "" })}</span> : (row.actorLabel ?? row.actorId ?? "—")) },
    { key: "action", header: t("audit.col.action"), cell: (row) => <Code>{row.action}</Code> },
    { key: "record", header: t("audit.col.record"), cell: (row) => (row.entityType ? <span className="grid"><span className="type-caption text-ink-2">{row.entityType}</span><Code>{row.entityId ?? ""}</Code></span> : "—") },
    { key: "reason", header: t("audit.col.reason"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.reason ?? row.summary ?? "—"}</span> },
    { key: "change", header: t("audit.col.change"), cell: (row) => (row.withheld ? <Status tone="neutral">{t("audit.withheld")}</Status> : row.hasChange ? t("audit.hasChange") : "—") },
  ];
  return (
    <>
      <PageHead
        title={t("audit.title")}
        lead={t("audit.lead")}
        actions={
          <Key as="a" href={`/admin/security/audit/export${search}`} size="sm" icon="download-simple" download>
            {t("common.exportCsv")}
          </Key>
        }
      />
      <Chain head={page.head} canVerify={canVerify} />

      <Section id="events" title={t("audit.events")} aside={<span className="type-caption text-ink-2">{t("audit.count", { count: page.total })}</span>}>
        <Disclosure summary={t("common.filters")} variant="row" defaultOpen={Boolean(filters.q || filters.module || filters.actor || filters.entityType || filters.entityId || filters.from || filters.to)}>
          <Form method="get" action="/admin/security/audit" className="sec-filters pt-2">
            <TextField name="q" type="search" label={t("audit.search")} hint={t("audit.searchHint")} defaultValue={filters.q} />
            <Select name="module" label={t("audit.module")} defaultValue={filters.module ?? ""} options={[{ value: "", label: t("common.any") }, ...page.modules.map((module) => ({ value: module, label: module }))]} />
            <Select name="actor" label={t("audit.person")} defaultValue={filters.actor ?? ""} options={[{ value: "", label: t("common.any") }, { value: "system", label: t("audit.systemJobs") }, ...people.map((person) => ({ value: person.id, label: person.name }))]} />
            <Select name="type" label={t("audit.recordType")} defaultValue={filters.entityType ?? ""} options={[{ value: "", label: t("common.any") }, ...page.entityTypes.map((type) => ({ value: type, label: type }))]} />
            <TextField name="entity" label={t("audit.recordId")} defaultValue={filters.entityId ?? ""} ltr />
            <TextField name="from" type="date" label={t("audit.from")} defaultValue={filters.from ?? ""} />
            <TextField name="to" type="date" label={t("audit.to")} defaultValue={filters.to ?? ""} />
            <div className="flex items-end gap-2">
              <Key type="submit" size="sm" variant="ink" icon="funnel">
                {t("common.apply")}
              </Key>
              <Key as={Link} to="/admin/security/audit" size="sm">
                {t("common.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>
        <ResponsiveList
          caption={t("audit.events")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("audit.empty")} text={t("audit.emptyHint")} icon="clipboard-text" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/security/audit${auditSearch(filters, n)}` || "?"} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/security/audit/${row.id}`} className="adm-link type-strong">
                  <Code>{row.action}</Code>
                </Link>
                <When at={row.at} />
              </div>
              <Pair label={t("audit.col.who")}>{row.actorKind === "system" ? t("audit.system", { job: row.actorLabel ?? "" }) : (row.actorLabel ?? "—")}</Pair>
              {row.entityType ? (
                <Pair label={t("audit.col.record")}>
                  <Code>{`${row.entityType} ${row.entityId ?? ""}`}</Code>
                </Pair>
              ) : null}
              {row.reason ? <p className="type-caption text-ink-2">{row.reason}</p> : null}
            </>
          )}
        />
      </Section>
    </>
  );
}

type ChainResult = { ok: boolean; intent?: string | null; report?: { ok: boolean; sealsChecked: number; eventsChecked: number; problems: { kind: string; fromSeq: number; toSeq: number }[]; unsealedEvents: number; headHash: string | null }; seal?: { seals: number; events: number; headHash: string | null } } & Record<string, unknown>;

function Chain({ head, canVerify }: { head: Route.ComponentProps["loaderData"]["page"]["head"]; canVerify: boolean }) {
  const t = useModuleT();
  const f = useFormat();
  const fetcher = useFetcher<ChainResult>();
  const handled = useRef<unknown>(null);
  useEffect(() => {
    const data = fetcher.data;
    if (!data || fetcher.state !== "idle" || handled.current === data) return;
    handled.current = data;
    if (data.ok && data.intent === "seal") toast.success(t("audit.sealed", { count: data.seal?.events ?? 0 }));
  }, [fetcher.data, fetcher.state, t]);
  const report = fetcher.data?.ok && fetcher.data.intent === "verify" ? fetcher.data.report : null;
  return (
    <Section id="chain" title={t("audit.chain")}>
      <div className="adm-card gap-2">
        <Pair label={t("audit.lastSeal")}>{head.lastSeal ? <When at={head.lastSeal.createdAt} /> : t("audit.neverSealed")}</Pair>
        {head.lastSeal ? (
          <>
            <Pair label={t("audit.sealedUpTo")}>
              <bdi className="nums">#{f.number(head.lastSeal.toSeq)}</bdi>
            </Pair>
            <div className="grid gap-1">
              <span className="type-caption text-ink-2">{t("audit.headHash")}</span>
              <Code className="type-data-sm">{head.lastSeal.hash}</Code>
            </div>
          </>
        ) : null}
        <Pair label={t("audit.unsealed")}>{f.number(head.unsealed)}</Pair>
        <p className="type-caption text-ink-2">{t("audit.chainNote")}</p>
        {canVerify ? (
          <fetcher.Form method="post" className="sec-actions">
            <Key type="submit" name="intent" value="verify" size="sm" icon="seal-check" loading={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "verify"}>
              {t("audit.verify")}
            </Key>
            <Key type="submit" name="intent" value="seal" size="sm" icon="lock" disabled={head.unsealed === 0} loading={fetcher.state !== "idle" && fetcher.formData?.get("intent") === "seal"}>
              {t("audit.sealNow")}
            </Key>
          </fetcher.Form>
        ) : null}
        <FormError message={fetcher.data && !fetcher.data.ok ? failureText(t, fetcher.data) : null} />
        {report ? (
          <Note tone={!report.ok ? "bad" : report.sealsChecked === 0 ? "warn" : "ok"} icon={report.ok && report.sealsChecked > 0 ? "check-circle" : "warning-circle"}>
            <p role="status">{!report.ok ? t("audit.verifyBad", { count: f.number(report.problems.length) }) : report.sealsChecked === 0 ? t("audit.verifyNothing") : t("audit.verifyOk", { seals: f.number(report.sealsChecked), events: f.number(report.eventsChecked) })}</p>
            {report.problems.slice(0, 10).map((problem) => (
              <p key={`${problem.kind}:${problem.fromSeq}`} className="type-caption">
                {t(`audit.problem.${problem.kind}`, { from: problem.fromSeq, to: problem.toSeq })}
              </p>
            ))}
            {report.unsealedEvents ? <p className="type-caption">{t("audit.verifyUnsealed", { count: report.unsealedEvents })}</p> : null}
          </Note>
        ) : null}
      </div>
    </Section>
  );
}
