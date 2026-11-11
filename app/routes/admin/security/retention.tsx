import { Link } from "react-router";

import type { Route } from "./+types/retention";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { listRoles } from "~/server/services/admin/security/roles.server";
import { retentionView } from "~/server/services/admin/security/retention.server";
import { ACCESS_REVIEW_INTERVAL_DAYS } from "~/server/services/admin/security/types";
import type { DataColumn } from "~/ui/DataTable";
import { Status } from "~/ui/Tag";
import { Note, PageHead, Pair, ResponsiveList, RowLink, Section, When, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { sec } from "./security.server";

/**
 * /admin/security/retention — 20.07: the retention and deletion policy as the nightly job runs it (read-only: the
 * periods are fixed in code, so there is no form that would pretend to change them), what is never deleted and why,
 * the last run's counts; and the periodic access review of every role (who reviewed it and when, what is due — each
 * review is made on the role's page).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await sec.open(context);
  const view = await sec.orRespond(() => retentionView(db, actor));
  const roles = can(actor, "staff.manage") || can(actor, "security.access_review.perform") || can(actor, "security.session.read") ? await listRoles(db, actor, locale, now) : null;
  return { view, roles, canReview: can(actor, "security.access_review.perform") };
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "retention.title");

type RoleRow = NonNullable<Route.ComponentProps["loaderData"]["roles"]>[number];

export default function RetentionPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { view, roles, canReview } = loaderData;
  const stats = (view.lastRun?.stats ?? {}) as Record<string, unknown>;
  const columns: DataColumn<RoleRow>[] = [
    { key: "name", header: t("roles.col.name"), cell: (row) => <RowLink to={`/admin/security/roles/${row.id}#review`}>{row.name}</RowLink> },
    { key: "members", header: t("roles.col.members"), numeric: true, cell: (row) => f.number(row.activeMembers) },
    { key: "last", header: t("retention.lastReview"), cell: (row) => (row.lastReview ? <When at={row.lastReview.at} kind="date" /> : "—") },
    { key: "by", header: t("retention.reviewer"), cell: (row) => row.lastReview?.by ?? "—" },
    { key: "state", header: t("retention.state"), cell: (row) => <Status tone={row.reviewDue ? "warn" : "ok"}>{row.reviewDue ? t("roles.reviewDue") : t("roles.reviewed")}</Status> },
  ];
  return (
    <>
      <PageHead title={t("retention.title")} lead={t("retention.lead")} />

      <Section id="policy" title={t("retention.policy")}>
        <div className="grid gap-2">
          <ul role="list" className="sec-kpis">
            {view.rows.map((row) => (
              <li key={row.key} className="adm-card gap-1">
                <span className="type-strong">{t(`retention.row.${row.key}`)}</span>
                <span className="type-kpi nums">{t("common.days", { count: row.days })}</span>
                <span className="type-caption text-ink-2">{t(`retention.after.${row.after}`)}</span>
                {typeof stats[row.key] === "number" ? <span className="type-caption">{t("retention.lastDeleted", { count: stats[row.key] as number })}</span> : null}
              </li>
            ))}
          </ul>
          <Note>
            <p>{t("retention.kept")}</p>
            <p>{t("retention.fixed")}</p>
          </Note>
          <div className="adm-card gap-1">
            <h3 className="adm-h3">{t("retention.lastRun")}</h3>
            {view.lastRun ? (
              <>
                <Pair label={t("retention.ranAt")}>
                  <When at={view.lastRun.at} />
                </Pair>
                <Pair label={t("retention.status")}>
                  <Status tone={view.lastRun.status === "succeeded" ? "ok" : view.lastRun.status === "failed" ? "bad" : "neutral"}>{t(`retention.run.${view.lastRun.status}`)}</Status>
                </Pair>
                {view.lastRun.error ? <p className="type-caption text-red-ink">{view.lastRun.error}</p> : null}
              </>
            ) : (
              <p className="type-body text-ink-2">{t("retention.neverRan")}</p>
            )}
          </div>
        </div>
      </Section>

      {roles ? (
        <Section id="reviews" title={t("retention.reviews")} aside={<span className="type-caption text-ink-2">{t("retention.every", { days: ACCESS_REVIEW_INTERVAL_DAYS })}</span>}>
          {!canReview ? (
            <Note>
              <p>{t("retention.reviewOwner")}</p>
            </Note>
          ) : null}
          <ResponsiveList
            caption={t("retention.reviews")}
            columns={columns}
            rows={roles}
            rowKey={(row) => row.id}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/security/roles/${row.id}#review`} className="adm-link type-strong">
                    {row.name}
                  </Link>
                  <Status tone={row.reviewDue ? "warn" : "ok"}>{row.reviewDue ? t("roles.reviewDue") : t("roles.reviewed")}</Status>
                </div>
                <Pair label={t("retention.lastReview")}>{row.lastReview ? <When at={row.lastReview.at} kind="date" /> : "—"}</Pair>
                <Pair label={t("roles.col.members")}>{f.number(row.activeMembers)}</Pair>
              </>
            )}
          />
        </Section>
      ) : null}
    </>
  );
}
