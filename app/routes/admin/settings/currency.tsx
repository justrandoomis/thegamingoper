import { Link } from "react-router";

import type { Route } from "./+types/currency";
import { useFormat } from "~/i18n/react";
import { currencyView } from "~/server/services/admin/settings/system.server";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Money, Note, PageHead, Pair, Section, When, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/currency — 22.01: the base currency (IQD: every amount is a whole number of dinars, by design), the
 * store's USD rate with the moment it took effect and who set it, rates scheduled for later, and the history. The rate
 * is changed in pricing (/admin/pricing/fx), which dates and audits every change and feeds supplier costs and the
 * shoppers' converted prices (always labelled as approximate; payment is in dinars).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await settingsKit.open(context, "settings.read");
  return { view: await settingsKit.orRespond(() => currencyView(db, actor, now)) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "currency.title");

export default function CurrencyPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { view } = loaderData;
  return (
    <>
      <PageHead
        title={t("currency.title")}
        lead={t("currency.lead")}
        actions={
          <Key as={Link} to="/admin/pricing/fx" size="sm" iconEnd="arrow-right">
            {view.canManage ? t("currency.change") : t("currency.open")}
          </Key>
        }
      />
      <div className="sec-kpis">
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("currency.base")}</p>
          <p className="type-kpi">
            <bdi dir="ltr">IQD</bdi>
          </p>
          <p className="type-caption text-ink-2">{t("currency.baseHint")}</p>
        </div>
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("currency.rate")}</p>
          <p className="type-kpi nums">{view.current ? <Money iqd={view.current.iqdPerUnit} /> : "—"}</p>
          <p className="type-caption text-ink-2">{view.current ? t("currency.perUsd") : t("currency.noRate")}</p>
          {view.current?.isDemo ? <Status tone="warn">{t("currency.demo")}</Status> : null}
        </div>
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("currency.since")}</p>
          <p className="type-kpi nums">{view.current ? <When at={view.current.effectiveAt} kind="date" /> : "—"}</p>
          <p className="type-caption text-ink-2">{view.current ? t("currency.setBy", { who: view.current.by ?? t("currency.seed"), source: view.current.source }) : null}</p>
        </div>
      </div>

      {view.scheduled.length ? (
        <Section id="scheduled" title={t("currency.scheduled")}>
          <ul role="list" className="grid gap-1">
            {view.scheduled.map((rate) => (
              <li key={rate.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                <Money iqd={rate.iqdPerUnit} />
                <span className="type-caption">
                  {t("currency.from")} <When at={rate.effectiveAt} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="history" title={t("currency.history")}>
        {view.history.length === 0 ? (
          <p className="type-body text-ink-2">{t("currency.noHistory")}</p>
        ) : (
          <ul role="list" className="grid gap-1">
            {view.history.map((rate) => (
              <li key={rate.id} className="grid gap-0.5 border-b border-line py-1">
                <span className="flex flex-wrap justify-between gap-2">
                  <Money iqd={rate.iqdPerUnit} />
                  <When at={rate.effectiveAt} />
                </span>
                <span className="type-caption text-ink-2">
                  {rate.by ?? t("currency.seed")} · {rate.source}
                  {rate.isDemo ? ` · ${t("currency.demo")}` : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Note>
        <p>{t("currency.note")}</p>
        <Pair label={t("currency.example")}>{view.current ? <span className="nums">{t("currency.exampleValue", { usd: f.number(100), iqd: f.number(view.current.iqdPerUnit * 100) })}</span> : "—"}</Pair>
      </Note>
    </>
  );
}
