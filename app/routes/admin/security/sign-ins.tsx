import { Form, Link } from "react-router";

import type { Route } from "./+types/sign-ins";
import { useFormat } from "~/i18n/react";
import { listAuthEvents, signinOverview } from "~/server/services/admin/security/signins.server";
import { SIGNIN_THRESHOLDS, SIGNIN_WINDOWS, parseSigninFilters, signinSearch, type AuthEventView, type SigninAlert } from "~/server/services/admin/security/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { Code, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, When, tOr, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { sec } from "./security.server";

/**
 * /admin/security/sign-ins — 20.08: abnormal sign-in attempts as fixed rules with their numbers (lockouts, repeated
 * failures per email or phone and per address, spraying of unknown emails, disabled accounts, wrong second-step codes,
 * refused attempts to turn two-step off, staff signing in from a new address), then the security log itself, in the
 * URL's window (24 hours, 7 or 30 days) and filters. Phone numbers are masked without customer.phone.read_full.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await sec.open(context, "security.auth_event.read");
  const filters = parseSigninFilters(new URL(request.url).searchParams);
  const [overview, events] = await Promise.all([sec.orRespond(() => signinOverview(db, actor, filters.window, now)), sec.orRespond(() => listAuthEvents(db, actor, filters, now))]);
  return { overview, events, filters };
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "signins.title");

function Who({ identifier, masked, name }: { identifier: string | null; masked: boolean; name: string | null }) {
  const t = useModuleT();
  return (
    <span className="grid">
      {name ? <span>{name}</span> : null}
      {identifier ? (
        <bdi dir="ltr" className="nums break-all type-caption">
          {identifier}
          {masked ? <span className="sr-only"> {t("signins.masked")}</span> : null}
        </bdi>
      ) : (
        <span className="text-ink-2">—</span>
      )}
    </span>
  );
}

export default function SignInsPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { overview, events, filters } = loaderData;
  const href = (patch: Partial<typeof filters>) => `/admin/security/sign-ins${signinSearch({ ...filters, ...patch, page: 1 })}` || "/admin/security/sign-ins";
  const alertColumns: DataColumn<SigninAlert>[] = [
    { key: "rule", header: t("signins.col.rule"), cell: (row) => <Status tone={row.rule === "new_address" ? "info" : "warn"}>{t(`signins.rule.${row.rule}`)}</Status> },
    { key: "who", header: t("signins.col.who"), cell: (row) => (row.subjectId ? <Link to={`/admin/security/staff/${row.subjectId}`} className="adm-link"><Who identifier={row.identifier} masked={row.identifierMasked} name={row.subjectName} /></Link> : <Who identifier={row.identifier} masked={row.identifierMasked} name={null} />) },
    { key: "ip", header: t("signins.col.ip"), cell: (row) => (row.ip ? <Code>{row.ip}</Code> : "—") },
    { key: "count", header: t("signins.col.count"), numeric: true, cell: (row) => f.number(row.count) },
    { key: "last", header: t("signins.col.last"), cell: (row) => <When at={row.lastAt} /> },
  ];
  const columns: DataColumn<AuthEventView>[] = [
    { key: "at", header: t("signins.col.at"), cell: (row) => <When at={row.at} /> },
    { key: "kind", header: t("signins.col.kind"), cell: (row) => <Status tone={row.success ? "ok" : "warn"}>{tOr(t, `kind.${row.kind}`, row.kind)}</Status> },
    { key: "reason", header: t("signins.col.reason"), cell: (row) => (row.reason ? tOr(t, `reason.${row.reason}`, row.reason) : "—") },
    { key: "who", header: t("signins.col.who"), cell: (row) => <Who identifier={row.identifier} masked={row.identifierMasked} name={row.subjectName} /> },
    { key: "subject", header: t("signins.col.subject"), cell: (row) => t(`signins.subject.${row.subjectKind}`) },
    { key: "ip", header: t("signins.col.ip"), cell: (row) => (row.ip ? <Code>{row.ip}</Code> : "—") },
    { key: "device", header: t("signins.col.device"), cell: (row) => [row.browser, row.system].filter(Boolean).join(" · ") || "—" },
  ];
  return (
    <>
      <PageHead title={t("signins.title")} lead={t("signins.lead")} />
      <LinkChips label={t("signins.window")} items={SIGNIN_WINDOWS.map((window) => ({ value: window, label: t(`signins.windows.${window}`), href: href({ window }), selected: filters.window === window }))} />

      <Section id="totals" title={t("signins.totals")} className="mt-4">
        <div className="sec-kpis">
          <Kpi label={t("signins.kpi.attempts")} value={f.number(overview.totals.attempts)} />
          <Kpi label={t("signins.kpi.failures")} value={f.number(overview.totals.failures)} hint={t("signins.kpi.split", { staff: overview.totals.staffFailures, customers: overview.totals.customerFailures })} />
          <Kpi label={t("signins.kpi.lockouts")} value={f.number(overview.totals.lockouts)} />
          <Kpi label={t("signins.kpi.alerts")} value={f.number(overview.alerts.length)} />
        </div>
      </Section>

      <Section id="alerts" title={t("signins.alerts")}>
        <ResponsiveList
          caption={t("signins.alerts")}
          columns={alertColumns}
          rows={overview.alerts}
          rowKey={(row) => row.key}
          empty={<EmptyState title={t("signins.noAlerts")} text={t("signins.noAlertsHint")} icon="shield-check" />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Status tone={row.rule === "new_address" ? "info" : "warn"}>{t(`signins.rule.${row.rule}`)}</Status>
                <bdi className="nums type-strong">{f.number(row.count)}</bdi>
              </div>
              <Who identifier={row.identifier} masked={row.identifierMasked} name={row.subjectName} />
              {row.ip ? (
                <Pair label={t("signins.col.ip")}>
                  <Code>{row.ip}</Code>
                </Pair>
              ) : null}
              <Pair label={t("signins.col.last")}>
                <When at={row.lastAt} />
              </Pair>
            </>
          )}
        />
        <p className="type-caption text-ink-2">{t("signins.rulesNote", { identifier: SIGNIN_THRESHOLDS.identifierFailures, ip: SIGNIN_THRESHOLDS.ipFailures, unknown: SIGNIN_THRESHOLDS.unknownFromIp, mfa: SIGNIN_THRESHOLDS.mfaFailures, days: SIGNIN_THRESHOLDS.newAddressDays })}</p>
      </Section>

      <Section id="log" title={t("signins.log")} aside={<span className="type-caption text-ink-2">{t("signins.count", { count: events.total })}</span>}>
        <Form method="get" action="/admin/security/sign-ins" className="sec-filters">
          {filters.window !== "7d" ? <input type="hidden" name="window" value={filters.window} /> : null}
          <TextField name="q" type="search" label={t("signins.search")} hint={t("signins.searchHint")} defaultValue={filters.q} />
          <Select
            name="outcome"
            label={t("signins.outcome")}
            defaultValue={filters.outcome ?? ""}
            options={[
              { value: "", label: t("common.any") },
              { value: "failed", label: t("signins.failed") },
              { value: "succeeded", label: t("signins.succeeded") },
            ]}
          />
          <Select
            name="subject"
            label={t("signins.col.subject")}
            defaultValue={filters.subject ?? ""}
            options={[
              { value: "", label: t("common.any") },
              { value: "employee", label: t("signins.subject.employee") },
              { value: "customer", label: t("signins.subject.customer") },
            ]}
          />
          <Select name="kind" label={t("signins.col.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("common.any") }, ...events.kinds.map((kind) => ({ value: kind, label: tOr(t, `kind.${kind}`, kind) }))]} />
          <div className="flex items-end gap-2">
            <Key type="submit" size="sm" variant="ink" icon="funnel">
              {t("common.apply")}
            </Key>
            <Key as={Link} to="/admin/security/sign-ins" size="sm">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        <ResponsiveList
          caption={t("signins.log")}
          columns={columns}
          rows={events.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("signins.empty")} text={t("signins.emptyHint")} icon="sign-in" />}
          footer={<Pagination page={events.page} pageCount={events.pageCount} href={(n) => `/admin/security/sign-ins${signinSearch(filters, n)}` || "?"} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Status tone={row.success ? "ok" : "warn"}>{tOr(t, `kind.${row.kind}`, row.kind)}</Status>
                <When at={row.at} />
              </div>
              <Who identifier={row.identifier} masked={row.identifierMasked} name={row.subjectName} />
              {row.reason ? <Pair label={t("signins.col.reason")}>{tOr(t, `reason.${row.reason}`, row.reason)}</Pair> : null}
              {row.ip ? (
                <Pair label={t("signins.col.ip")}>
                  <Code>{row.ip}</Code>
                </Pair>
              ) : null}
            </>
          )}
        />
        <Note>
          <p>{t("signins.retention")}</p>
        </Note>
      </Section>
    </>
  );
}
