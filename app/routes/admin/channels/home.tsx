import type { Route } from "./+types/home";
import { useFormat } from "~/i18n/react";
import { channelsOverview } from "~/server/services/admin/channels/overview.server";
import { ModuleFunctions } from "../blueprint-status";
import { DecisionCard, Kpi, Note, PageHead, Section, useChT } from "./components/ui";
import { ch } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels — the module's front page: what waits for a person (deliveries that gave up, API keys about to
 * expire), the figures of each part this employee may open, the honest boundaries (no marketplace, no delivery
 * transport, no provider connected), and the status of the six blueprint functions.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args);
  return { overview: await ch.orRespond(() => channelsOverview(req.db, req.actor, req.now)) };
}

export const meta: Route.MetaFunction = (args) => chMeta(args, null);

export default function ChannelsHome({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { overview } = loaderData;
  const { access } = overview;
  const decisions = [
    { key: "gaveUp", icon: "warning" as const, count: overview.webhooks?.gaveUp ?? 0, to: "/admin/channels/monitor?status=gave_up#ch-deliveries", show: access.webhooks },
    { key: "expiring", icon: "key" as const, count: overview.apiKeys?.expiringSoon ?? 0, to: "/admin/channels/api", show: access.apiKeys },
  ].filter((entry) => entry.show && entry.count > 0);

  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      <Section id="ch-waiting" title={t("home.waiting")}>
        {decisions.length ? (
          <ul role="list" className="ch-decisions">
            {decisions.map((entry) => (
              <DecisionCard key={entry.key} icon={entry.icon} title={t(`home.decision.${entry.key}.title`)} count={entry.count} text={t(`home.decision.${entry.key}.text`)} to={entry.to} action={t(`home.decision.${entry.key}.action`)} />
            ))}
          </ul>
        ) : (
          <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
        )}
      </Section>

      <Section id="ch-figures" title={t("home.figures")}>
        <div className="ch-kpis">
          {overview.branches ? (
            <Kpi label={t("home.kpi.branches")} value={f.number(overview.branches.active)} hint={overview.branches.inactive ? t("home.kpi.branchesInactive", { count: overview.branches.inactive }) : t("home.kpi.branchesHint")} to="/admin/channels/branches" />
          ) : null}
          {overview.channels ? <Kpi label={t("home.kpi.channels")} value={f.number(overview.channels.total)} hint={t("home.kpi.channelsHint", { count: overview.channels.added })} to="/admin/channels/sales" /> : null}
          {overview.apiKeys ? <Kpi label={t("home.kpi.keys")} value={f.number(overview.apiKeys.active)} hint={t("home.kpi.keysHint", { count: overview.apiKeys.expiringSoon })} to="/admin/channels/api" /> : null}
          {overview.webhooks ? (
            <Kpi label={t("home.kpi.webhooks")} value={f.number(overview.webhooks.active)} hint={t("home.kpi.webhooksHint", { count: overview.webhooks.pending })} to={access.webhooks ? "/admin/channels/webhooks" : "/admin/channels/monitor"} />
          ) : null}
          {overview.providers ? <Kpi label={t("home.kpi.providers")} value={t("home.kpi.providersValue")} hint={t("home.kpi.providersHint", { count: overview.providers.withSecret })} to="/admin/channels/providers" /> : null}
        </div>
      </Section>

      <Section id="ch-limits" title={t("home.limits")}>
        <Note tone="warn" icon="warning">
          <p>{t("home.limit.marketplaces")}</p>
          <p>{t("home.limit.transport")}</p>
          <p>{t("home.limit.providers")}</p>
          <p>{t("home.limit.api")}</p>
        </Note>
      </Section>

      <ModuleFunctions moduleId="21" />
    </>
  );
}
