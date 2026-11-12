import { Link } from "react-router";

import type { Route } from "./+types/policies";
import { useFormat } from "~/i18n/react";
import { policiesView } from "~/server/services/admin/settings/policies.server";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Money, Note, PageHead, Pair, Section, When, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/policies — 22.02: the delivery fee and its switch (module 11 changes them, with their impact), the
 * tax rates (module 10; checkout adds no tax today), the return window and trade-in validity (settings keys), the
 * return eligibility rules (module 12), and the six policy texts with their state on the storefront: the returns and
 * warranty texts are approved here; the others belong to the content module (17).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await settingsKit.open(context, "settings.read");
  return { view: await settingsKit.orRespond(() => policiesView(db, actor, locale, now)) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "policies.title");

export default function PoliciesPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { view } = loaderData;
  return (
    <>
      <PageHead title={t("policies.title")} lead={t("policies.lead")} />

      <div className="sec-kpis">
        <div className="adm-card gap-1.5">
          <h2 className="adm-h3">{t("policies.shipping")}</h2>
          <Pair label={t("policies.fee")}>
            <Money iqd={view.shipping.flatFeeIqd} />
          </Pair>
          <Pair label={t("policies.overrides")}>
            <Status tone={view.shipping.overridesEnabled ? "info" : "neutral"}>{view.shipping.overridesEnabled ? t("value.on") : t("value.off")}</Status>
          </Pair>
          <Link to="/admin/shipping/zones" className="adm-link type-label">
            {t("home.editIn.shipping")}
          </Link>
        </div>
        <div className="adm-card gap-1.5">
          <h2 className="adm-h3">{t("policies.tax")}</h2>
          {view.tax.active.length === 0 ? (
            <p className="type-body">{t("policies.noTax")}</p>
          ) : (
            view.tax.active.map((rate) => (
              <Pair key={rate.code} label={rate.name}>
                <bdi className="nums" dir="ltr">{`${(rate.rateBps / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`}</bdi>
              </Pair>
            ))
          )}
          <p className="type-caption text-ink-2">{t("policies.taxNote")}</p>
          <Link to="/admin/finance/tax" className="adm-link type-label">
            {t("home.editIn.finance")}
          </Link>
        </div>
        <div className="adm-card gap-1.5">
          <h2 className="adm-h3">{t("policies.returns")}</h2>
          <Pair label={t("policies.window")}>{view.values.returnDays > 0 ? t("unit.days", { count: view.values.returnDays }) : t("policies.noReturns")}</Pair>
          <Pair label={t("policies.tradeIn")}>{t("unit.days", { count: view.values.tradeInDays })}</Pair>
          <Link to="/admin/settings/keys/returns.window_days" className="adm-link type-label">
            {t("policies.changeWindow")}
          </Link>
          <Link to="/admin/returns/policies" className="adm-link type-label">
            {t("policies.rules")}
          </Link>
        </div>
        <div className="adm-card gap-1.5">
          <h2 className="adm-h3">{t("policies.warranty")}</h2>
          <p className="type-body">{t("policies.warrantyPending")}</p>
          <Pair label={t("policies.undecided")}>{f.number(view.warrantyUndecided)}</Pair>
        </div>
      </div>

      <Section id="texts" title={t("policies.texts")}>
        <ul role="list" className="grid gap-2 lg:grid-cols-2">
          {view.policies.map((policy) => (
            <li key={policy.slug} className="adm-card gap-1.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="type-strong">{policy.title}</span>
                <Status tone={policy.approved ? "ok" : "warn"}>{policy.approved ? t("policies.approved") : t("policies.draft")}</Status>
              </div>
              {policy.row ? (
                <p className="type-caption text-ink-2">
                  {t(`policies.row.${policy.row.status}`)} · <When at={policy.row.updatedAt} />
                  {policy.row.hasDraft ? ` · ${t("policies.hasDraft")}` : ""}
                </p>
              ) : (
                <p className="type-caption text-ink-2">{t("policies.codeDraft")}</p>
              )}
              <div className="sec-actions">
                {policy.editable ? (
                  <Key as={Link} to={`/admin/settings/policies/${policy.slug}`} size="sm" icon="pencil-simple">
                    {view.can.edit || view.can.publish ? t("policies.edit") : t("policies.view")}
                  </Key>
                ) : policy.contentHref ? (
                  <Key as={Link} to={policy.contentHref} size="sm" icon="pencil-simple">
                    {t("policies.openInContent")}
                  </Key>
                ) : (
                  <span className="type-caption text-ink-2">{t("policies.contentModule")}</span>
                )}
                <Key as="a" href={`/policies/${policy.slug}`} size="sm" iconEnd="arrow-square-out" target="_blank" rel="noopener">
                  {t("policies.onStore")}
                </Key>
              </div>
            </li>
          ))}
        </ul>
        <Note>
          <p>{t("policies.how")}</p>
        </Note>
      </Section>
    </>
  );
}
