import { Link } from "react-router";

import type { Route } from "./+types/environment";
import { useFormat } from "~/i18n/react";
import { environmentView } from "~/server/services/admin/settings/system.server";
import { Status } from "~/ui/Tag";
import { Note, PageHead, Pair, Section, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/environment — 22.06: the deployment's mode. STORE_MODE (demo | live) and APP_ENV are deploy
 * variables (wrangler), so this page shows them, what each one does, and how much demo data the database still holds —
 * it never offers a switch it cannot perform. Settings changes with their log and approvals are on /admin/settings and
 * /admin/settings/changes.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { ctx, db, actor } = await settingsKit.open(context, "settings.read");
  return { view: await settingsKit.orRespond(() => environmentView(db, actor, { STORE_MODE: ctx.storeMode, APP_ENV: ctx.isDev ? "development" : "production" })) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "environment.title");

export default function EnvironmentPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { view } = loaderData;
  return (
    <>
      <PageHead title={t("environment.title")} lead={t("environment.lead")} />
      <div className="sec-kpis">
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("environment.storeMode")}</p>
          <p className="type-kpi">
            <bdi dir="ltr">{view.storeMode}</bdi>
          </p>
          <Status tone={view.storeMode === "live" ? "ok" : "warn"}>{t(`environment.mode.${view.storeMode}`)}</Status>
        </div>
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("environment.appEnv")}</p>
          <p className="type-kpi">
            <bdi dir="ltr">{view.appEnv}</bdi>
          </p>
          <Status tone={view.appEnv === "production" ? "ok" : "info"}>{t(`environment.env.${view.appEnv}`)}</Status>
        </div>
      </div>
      <Section id="demo" title={t("environment.demoData")}>
        <div className="adm-card gap-1.5">
          {(["products", "orders", "customers", "usedUnits", "employees"] as const).map((key) => (
            <Pair key={key} label={t(`environment.count.${key}`)}>
              {f.number(view.demo[key])}
            </Pair>
          ))}
        </div>
        <Note>
          <p>{t(`environment.what.${view.storeMode}`)}</p>
          <p>{t("environment.howSwitch")}</p>
          <p>{t("environment.noStaging")}</p>
        </Note>
      </Section>
      <Section id="changes" title={t("environment.changes")}>
        <p className="type-body">{t("environment.changesText")}</p>
        <Link to="/admin/settings/changes" className="adm-link type-label">
          {t("nav.changes")}
        </Link>
      </Section>
    </>
  );
}
