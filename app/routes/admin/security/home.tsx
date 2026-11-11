import type { Route } from "./+types/home";
import { useFormat } from "~/i18n/react";
import { securityOverview } from "~/server/services/admin/security/overview.server";
import { ModuleFunctions } from "../blueprint-status";
import { DecisionCard, Kpi, Note, PageHead, Section, When, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { sec } from "./security.server";

/**
 * /admin/security — the module's front page: what waits for a person (raised cards only for decisions: staff without
 * two-step verification, sign-in alerts, refunds to review, a restore test or access reviews that are due), the figures
 * of the trail and the sessions, the honest limits, and the status of the eight blueprint functions.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await sec.open(context);
  return { overview: await securityOverview(db, actor, now) };
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, null);

export default function SecurityHome({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { staff, alerts, refunds, chain, restore, reviewsDue } = loaderData.overview;
  const noTwoStep = staff ? staff.active - staff.withTwoStep : 0;
  const decisions = [
    { key: "noTwoStep", icon: "key" as const, count: noTwoStep, to: "/admin/security/staff?twostep=off&status=active", show: staff !== null },
    { key: "alerts", icon: "warning" as const, count: alerts ?? 0, to: "/admin/security/sign-ins?window=24h", show: alerts !== null },
    { key: "refunds", icon: "hand-coins" as const, count: refunds ?? 0, to: "/admin/security/refunds?view=unreviewed", show: refunds !== null },
    { key: "restore", icon: "database" as const, count: restore?.due ? 1 : 0, to: "/admin/security/backups", show: restore !== null },
    { key: "reviews", icon: "users" as const, count: reviewsDue ?? 0, to: "/admin/security/retention#reviews", show: reviewsDue !== null },
  ].filter((entry) => entry.show && entry.count > 0);
  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      <Section id="waiting" title={t("home.waiting")}>
        {decisions.length ? (
          <ul role="list" className="sec-decisions">
            {decisions.map((entry) => (
              <DecisionCard key={entry.key} icon={entry.icon} title={t(`home.decision.${entry.key}.title`)} count={entry.count} text={t(`home.decision.${entry.key}.text`, { days: restore?.ageDays ?? 0 })} to={entry.to} action={t(`home.decision.${entry.key}.action`)} />
            ))}
          </ul>
        ) : (
          <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
        )}
      </Section>

      <Section id="figures" title={t("home.figures")}>
        <div className="sec-kpis">
          {staff ? (
            <>
              <Kpi label={t("home.kpi.active")} value={f.number(staff.active)} to="/admin/security/staff?status=active" />
              <Kpi label={t("home.kpi.twoStep")} value={staff.active ? `${f.number(Math.floor((staff.withTwoStep * 100) / staff.active))}%` : "—"} hint={t("home.kpi.twoStepHint", { count: staff.withTwoStep, total: staff.active })} />
              <Kpi label={t("home.kpi.sessions")} value={f.number(staff.liveSessions)} hint={t("home.kpi.sessionsHint")} />
            </>
          ) : null}
          {chain ? (
            <>
              <Kpi label={t("home.kpi.events")} value={f.number(chain.total)} to="/admin/security/audit" />
              <Kpi label={t("home.kpi.unsealed")} value={f.number(chain.unsealed)} hint={t("home.kpi.unsealedHint")} />
              <Kpi label={t("home.kpi.lastSeal")} value={chain.lastSeal ? <When at={chain.lastSeal.createdAt} kind="date" /> : "—"} hint={chain.lastSeal ? t("home.kpi.lastSealHint", { seq: chain.lastSeal.toSeq }) : t("home.kpi.neverSealed")} />
            </>
          ) : null}
          {restore ? <Kpi label={t("home.kpi.restore")} value={restore.ageDays === null ? "—" : t("common.days", { count: restore.ageDays })} hint={restore.ageDays === null ? t("home.kpi.restoreNever") : t("home.kpi.restoreHint")} to="/admin/security/backups" /> : null}
        </div>
      </Section>

      <Section id="limits" title={t("home.limits")}>
        <Note tone="warn" icon="warning">
          <p>{t("home.limit.twoStepRole")}</p>
          <p>{t("home.limit.trusted")}</p>
          <p>{t("home.limit.backups")}</p>
          <p>{t("home.limit.webhooks")}</p>
        </Note>
      </Section>

      <ModuleFunctions moduleId="20" />
    </>
  );
}
