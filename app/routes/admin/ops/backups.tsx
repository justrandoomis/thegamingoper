import { Link } from "react-router";

import type { Route } from "./+types/backups";
import { backupsMonitor } from "~/server/services/admin/ops/overview.server";
import { RUN_STATUS_TONE, type RunStatus } from "~/server/services/admin/ops/types";
import { Key } from "~/ui/Key";
import { Code, Kpi, Note, PageHead, Pair, Section, StatusText, When, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops/backups — 23.04, monitoring only: how fresh the evidence of a working restore is (the restore tests module
 * 20 records at /admin/security/backups — never recorded twice), the daily seal of the audit trail (its head hash goes
 * to the Workers logs, the off-site anchor), what Cloudflare keeps (D1 Time Travel; KV files have no history) and how
 * to look at it. Backups and restores themselves are Cloudflare's and the owner's, never this page's.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.backup.read");
  return { monitor: await ops.orRespond(req, () => backupsMonitor(req.db, req.actor, req.now)) };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "backups.title");

export default function BackupsPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { monitor } = loaderData;
  const { restore, seal, lastSeal } = monitor;
  return (
    <>
      <PageHead
        title={t("backups.title")}
        lead={t("backups.lead")}
        actions={
          monitor.canRecord ? (
            <Key as={Link} to="/admin/security/backups" icon="database">
              {t("backups.record")}
            </Key>
          ) : null
        }
      />
      {restore.due ? (
        <Note tone="warn" icon="warning">
          <p>{restore.ageDays === null ? t("backups.neverTested") : t("backups.due", { days: restore.ageDays, interval: restore.intervalDays })}</p>
          <p className="type-caption text-ink-2">{monitor.canRecord ? t("backups.dueAction") : t("backups.dueOwner")}</p>
        </Note>
      ) : null}
      <Section id="ops-backups-figures" title={t("backups.figures")}>
        <div className="ops-kpis">
          <Kpi label={t("backups.lastTest")} value={restore.ageDays === null ? "—" : t("common.days", { count: restore.ageDays })} hint={restore.ageDays === null ? t("home.kpi.restoreNever") : t("home.kpi.restoreHint", { days: restore.intervalDays })} />
          <Kpi label={t("backups.timeTravel")} value={t("common.days", { count: monitor.timeTravelDays })} hint={t("backups.timeTravelHint")} />
        </div>
      </Section>
      <Section id="ops-backups-seal" title={t("backups.seal")}>
        <div className="adm-card gap-2">
          <Pair label={t("backups.sealJob")}>
            {seal ? (
              <span className="flex flex-wrap items-center justify-end gap-2">
                <StatusText tone={RUN_STATUS_TONE[seal.status as RunStatus] ?? "neutral"}>{t(`run.status.${seal.status}`)}</StatusText>
                <When at={seal.at} />
              </span>
            ) : (
              t("jobs.neverRan")
            )}
          </Pair>
          <Pair label={t("backups.lastSeal")}>{lastSeal ? <span><When at={lastSeal.createdAt} /> · {t("backups.upTo", { seq: lastSeal.toSeq })}</span> : t("backups.noSeal")}</Pair>
          {seal?.error ? <p className="type-caption text-red-ink">{seal.error}</p> : null}
        </div>
        <p className="type-caption text-ink-2">{t("backups.sealHint")}</p>
      </Section>
      <Section id="ops-backups-how" title={t("backups.how")}>
        <div className="adm-card gap-3">
          <ol className="ops-steps type-body text-ink">
            <li>{t("backups.step.timeTravel")}</li>
            <li>
              {t("backups.step.info")} <Code>npx wrangler d1 time-travel info tamtam-db</Code>
            </li>
            <li>{t("backups.step.test")}</li>
            <li>{t("backups.step.record")}</li>
          </ol>
          <Note icon="warning" tone="warn">
            <p>{t("backups.kv")}</p>
          </Note>
        </div>
        <p className="type-caption text-ink-2">{monitor.canRecord ? t("backups.moduleTwenty") : t("backups.moduleTwentyOwner")}</p>
      </Section>
    </>
  );
}
