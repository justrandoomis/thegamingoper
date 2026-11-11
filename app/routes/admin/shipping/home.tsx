import { Link } from "react-router";

import type { Route } from "./+types/home";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { shippingAccess } from "~/server/services/admin/shipping/shared.server";
import { shippingOverview } from "~/server/services/admin/shipping/shipments.server";
import { listZones } from "~/server/services/admin/shipping/zones.server";
import { ModuleFunctions } from "../blueprint-status";
import { DecisionCard, Kpi, Money, Note, PageHead, Section, useShipT } from "./components/kit";
import { shippingMeta } from "./meta";
import { openShipping } from "./shipping.server";

/**
 * /admin/shipping — the module's front page: what waits for a person (raised cards only for decisions: failed
 * deliveries, parcels coming back, settlements to reconcile, sensitive parcels without a packing photo), the figures
 * of the parcels on their way, the delivery fee in force, and the status of the six blueprint functions.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openShipping(context);
  const access = shippingAccess(actor);
  const [overview, zones] = await Promise.all([access.read ? shippingOverview(db, actor, now) : Promise.resolve(null), access.read || access.zones || access.rates || access.carriers ? listZones(db, actor, locale) : Promise.resolve(null)]);
  const fees = zones ? { flatFeeIqd: zones.policy.flatFeeIqd, overridesEnabled: zones.policy.overridesEnabled, paused: zones.rows.filter((row) => !row.isActive).length, overrides: zones.rows.filter((row) => row.overrideIqd !== null).length } : null;
  return { overview, fees, access, recordCod: can(actor, "orders.payment.record") };
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, null);

export default function ShippingHome({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { overview, fees, access } = loaderData;
  const decisions = overview
    ? [
        { key: "failed", icon: "warning" as const, count: overview.failed, to: "/admin/shipping/attempts", show: access.read },
        { key: "returning", icon: "arrow-counter-clockwise" as const, count: overview.returning, to: "/admin/shipping/shipments?status=returning", show: access.read },
        { key: "toReconcile", icon: "scales" as const, count: overview.toReconcile, to: "/admin/shipping/cod?status=submitted", show: access.cod },
        { key: "undocumented", icon: "camera" as const, count: overview.undocumented, to: "/admin/shipping/shipments?status=open&flag=undocumented", show: access.read },
      ].filter((entry) => entry.show && entry.count > 0)
    : [];
  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      {overview ? (
        <>
          <Section id="waiting" title={t("home.waiting")}>
            {decisions.length ? (
              <ul role="list" className="shp-decisions">
                {decisions.map((entry) => (
                  <DecisionCard key={entry.key} icon={entry.icon} title={t(`home.decision.${entry.key}.title`)} count={entry.count} text={t(`home.decision.${entry.key}.text`)} to={entry.to} action={t(`home.decision.${entry.key}.action`)} />
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
            )}
          </Section>

          <Section id="figures" title={t("home.figures")}>
            <div className="shp-kpis">
              <Kpi label={t("home.kpi.toPrepare")} value={f.number(overview.toPrepare)} hint={t("home.kpi.toPrepareHint")} to="/admin/shipping/shipments?status=packed&flag=no_waybill" />
              <Kpi label={t("home.kpi.ready")} value={f.number(overview.readyForPickup)} hint={t("home.kpi.readyHint")} to="/admin/shipping/shipments?status=packed" />
              <Kpi label={t("home.kpi.onRoad")} value={f.number(overview.onRoad)} to="/admin/shipping/shipments?status=on_road" />
              <Kpi label={t("home.kpi.dueRetry")} value={f.number(overview.dueRetry)} hint={t("home.kpi.dueRetryHint")} to="/admin/shipping/attempts" />
              <Kpi
                label={t("home.kpi.codOutstanding")}
                value={<Money iqd={overview.codOutstanding.amountIqd} />}
                hint={t("home.kpi.codOutstandingHint", { count: overview.codOutstanding.parcels })}
                to={access.cod ? "/admin/shipping/cod" : undefined}
              />
              <Kpi label={t("home.kpi.unsettled")} value={f.number(overview.unsettled)} hint={t("home.kpi.unsettledHint")} to={access.cod ? "/admin/shipping/cod" : undefined} />
            </div>
            {overview.carriers === 0 ? (
              <Note tone="warn" icon="truck">
                <p>{t("home.noCarriers")}</p>
                {access.carriers ? (
                  <Link to="/admin/shipping/carriers" className="adm-link type-label">
                    {t("home.addCarrier")}
                  </Link>
                ) : null}
              </Note>
            ) : null}
          </Section>
        </>
      ) : null}

      {fees ? (
        <Section id="fees" title={t("home.fees")}>
          <div className="adm-card">
            <p className="type-body text-ink">
              {fees.overridesEnabled ? t("home.feeWithOverrides", { fee: f.iqd(fees.flatFeeIqd), count: fees.overrides }) : t("home.feeFlat", { fee: f.iqd(fees.flatFeeIqd) })}
            </p>
            {fees.paused > 0 ? <p className="type-caption text-ink-2">{t("home.paused", { count: fees.paused })}</p> : null}
            <p className="type-caption text-ink-2">{t("home.feeNote")}</p>
            <Link to="/admin/shipping/zones" className="adm-link type-label">
              {t("home.openZones")}
            </Link>
          </div>
        </Section>
      ) : null}

      <Section id="boundaries" title={t("home.boundariesTitle")}>
        <Note icon="plugs-connected">
          <p>{t("home.boundaryCourier")}</p>
          <p>{t("home.boundaryPrint")}</p>
          <p>{t("home.boundarySms")}</p>
        </Note>
      </Section>

      <Section id="shortcuts" title={t("home.shortcuts")}>
        <ul role="list" className="adm-grid">
          {[
            { to: "/admin/shipping/shipments", icon: "package" as const, key: "shipments", show: access.read },
            { to: "/admin/shipping/attempts", icon: "warning" as const, key: "attempts", show: access.read },
            { to: "/admin/shipping/cod", icon: "hand-coins" as const, key: "cod", show: access.cod },
            { to: "/admin/shipping/carriers", icon: "truck" as const, key: "carriers", show: access.read || access.carriers },
            { to: "/admin/shipping/zones", icon: "map-pin" as const, key: "zones", show: access.read || access.zones || access.rates || access.carriers },
          ]
            .filter((entry) => entry.show)
            .map((entry) => (
              <li key={entry.key}>
                <Link to={entry.to} className="adm-module-link">
                  <Icon name={entry.icon} size={22} className="text-ink-2" />
                  <span className="grid gap-0.5">
                    <span className="type-strong">{t(`nav.${entry.key}`)}</span>
                    <span className="type-caption text-ink-2">{t(`home.shortcut.${entry.key}`)}</span>
                  </span>
                </Link>
              </li>
            ))}
        </ul>
      </Section>

      <ModuleFunctions moduleId="11" />
    </>
  );
}
