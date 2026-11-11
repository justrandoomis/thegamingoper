import { Link } from "react-router";

import type { Route } from "./+types/templates";
import { useFormat } from "~/i18n/react";
import { listTemplates } from "~/server/services/admin/settings/templates.server";
import { TEMPLATE_LOCALES } from "~/server/services/admin/settings/catalog";
import { Status } from "~/ui/Tag";
import { Note, PageHead, Section, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/templates — 22.04: the messages the store queues (order statuses, payment decisions, pre-order
 * dates, sign-in codes) and their text in each language. BOUNDARY: no SMS / WhatsApp / e-mail provider is connected, so
 * every message is held in the outbox and none is sent; the texts are ready for when one is (module 21).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await settingsKit.open(context, "settings.read");
  return { list: await settingsKit.orRespond(() => listTemplates(db, actor, now)) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "templates.title");

export default function TemplatesPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { list } = loaderData;
  return (
    <>
      <PageHead title={t("templates.title")} lead={t("templates.lead")} />
      <Note tone="warn" icon="paper-plane-tilt">
        <p>{t("templates.boundary")}</p>
        <p>{t("templates.invoices")}</p>
      </Note>
      <Section id="list" title={t("templates.list")} className="mt-4">
        <ul role="list" className="grid gap-2 lg:grid-cols-2">
          {list.rows.map((row) => (
            <li key={row.key} className="adm-card gap-1.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Link to={`/admin/settings/templates/${row.key}`} className="adm-link type-strong">
                  {t(`template.${row.key}`)}
                </Link>
                <bdi dir="ltr" className="type-caption text-ink-2">
                  {row.key}
                </bdi>
              </div>
              <span className="flex flex-wrap gap-1">
                {TEMPLATE_LOCALES.map((locale) => (
                  <Status key={locale} tone={row.texts[locale] ? (row.texts[locale]?.isActive ? "ok" : "neutral") : "warn"}>
                    {t(`lang.${locale}`)}: {row.texts[locale] ? (row.texts[locale]?.isActive ? t("templates.written") : t("templates.paused")) : t("templates.missing")}
                  </Status>
                ))}
              </span>
              <span className="type-caption text-ink-2">{t("templates.queued", { held: f.number(row.queued.held), sent: f.number(row.queued.sent) })}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
