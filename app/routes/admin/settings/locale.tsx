import { Link } from "react-router";

import type { Route } from "./+types/locale";
import { getSetting } from "~/server/settings.server";
import { localeView } from "~/server/services/admin/settings/system.server";
import { Status } from "~/ui/Tag";
import { Note, PageHead, Pair, Section, When, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/locale — 22.05: Iraq time (Asia/Baghdad, UTC+3, no daylight saving — every business day, due time and
 * report uses it), the same instant as each language writes it with Latin and Arabic-Indic digits, the languages of the
 * store (Arabic right to left, English, Sorani right to left) and of the admin (Arabic, English), and the numeral
 * setting, which the store does not read yet (each shopper picks digits in their own preferences).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await settingsKit.open(context, "settings.read");
  return { view: localeView(actor, now), numbering: await getSetting(db, "locale.numbering") };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "locale.title");

export default function LocalePage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { view, numbering } = loaderData;
  return (
    <>
      <PageHead title={t("locale.title")} lead={t("locale.lead")} />
      <div className="sec-kpis">
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("locale.zone")}</p>
          <p className="type-kpi">
            <bdi dir="ltr">{view.timeZone}</bdi>
          </p>
          <p className="type-caption text-ink-2">
            <bdi dir="ltr">UTC{view.offset}</bdi> · {t("locale.noDst")}
          </p>
        </div>
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("locale.now")}</p>
          <p className="type-kpi nums">
            <When at={view.now} />
          </p>
          <p className="type-caption text-ink-2">{t("locale.nowHint")}</p>
        </div>
      </div>

      <Section id="formats" title={t("locale.formats")}>
        <ul role="list" className="grid gap-2 md:grid-cols-3">
          {view.samples.map((sample) => (
            <li key={sample.locale} className="adm-card gap-1" lang={sample.locale} dir={sample.locale === "en" ? "ltr" : "rtl"}>
              <span className="type-strong">{t(`lang.${sample.locale}`)}</span>
              <span className="nums">{sample.latn}</span>
              <span className="nums">{sample.arab}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="languages" title={t("locale.languages")}>
        <div className="adm-card gap-1.5">
          <Pair label={t("locale.store")}>{view.storefrontLanguages.map((code) => t(`lang.${code}`)).join(" · ")}</Pair>
          <Pair label={t("locale.admin")}>{view.adminLanguages.map((code) => t(`lang.${code}`)).join(" · ")}</Pair>
          <Pair label={t("locale.direction")}>{t("locale.directionValue")}</Pair>
        </div>
        <Note>
          <p>{t("locale.sorani")}</p>
        </Note>
      </Section>

      <Section id="numbering" title={t("locale.numbering")}>
        <div className="adm-card gap-1.5">
          {(["ar", "en", "ckb"] as const).map((code) => (
            <Pair key={code} label={t(`lang.${code}`)}>
              <Status tone="neutral">{t(`locale.digits.${numbering[code]}`)}</Status>
            </Pair>
          ))}
          <Link to="/admin/settings/keys/locale.numbering" className="adm-link type-label">
            {t("home.view")}
          </Link>
        </div>
        <Note tone="warn">
          <p>{t("key.unused.locale_numbering")}</p>
          <p>{t("locale.overrides")}</p>
        </Note>
      </Section>
    </>
  );
}
