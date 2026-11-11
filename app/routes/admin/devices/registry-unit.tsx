import { Link } from "react-router";

import type { Route } from "./+types/registry-unit";
import { throwAsResponse } from "~/server/errors";
import { getRegistryDetail } from "~/server/services/admin/devices/registry.server";
import { openDevices } from "./devices.server";
import { devicesMeta } from "./meta";
import { SourceText } from "./registry-parts";
import { Facts, GradeTag, Money, Name, Ref, Section, SerialBadge, TradeInBadge, UsedBadge, useDevicesT, When } from "./ui";

/**
 * /admin/devices/registry/:serialId — one device in the registry (13.01): what it is, its condition and where it came
 * from, the used unit it is now, the trade-ins that named it, every order it was sold on (at most one open), its
 * warranties and — with inventory.movement.read — its stock movements (unit cost only with cost.read).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, "devices.registry.read");
  try {
    return { unit: await getRegistryDetail(db, actor, params.serialId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, null, undefined, args.loaderData?.unit.serial);

export default function RegistryUnitPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const { unit } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/devices/registry" className="adm-link">
            {t("registry.back")}
          </Link>
        </p>
        <h1 className="adm-title">
          <Ref value={unit.serial} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <SerialBadge status={unit.status} />
          {unit.condition === "used" ? <GradeTag grade={unit.grade} /> : <span className="dev-tag">{t("condition.new")}</span>}
        </div>
      </header>
      <div className="dev-layout">
        <div className="grid min-w-0 gap-6">
          <Section id="reg-orders" title={t("registry.orders")}>
            {unit.orders.length === 0 ? (
              <p className="type-body text-ink-2">{t("registry.noOrders")}</p>
            ) : (
              <ul className="dev-ledger">
                {unit.orders.map((order) => (
                  <li key={`${order.ref}-${order.attachedAt}`} className="flex flex-wrap justify-between gap-2">
                    <Ref value={order.ref} />
                    <span className="type-caption text-ink-2">
                      <When at={order.attachedAt} /> {order.releasedAt ? <>· {t("registry.released")} <When at={order.releasedAt} /></> : <>· {t("registry.open")}</>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section id="reg-tradeins" title={t("registry.tradeIns")}>
            {unit.tradeIns.length === 0 ? (
              <p className="type-body text-ink-2">{t("registry.noTradeIns")}</p>
            ) : (
              <ul className="dev-ledger">
                {unit.tradeIns.map((trade) => (
                  <li key={trade.ref} className="flex flex-wrap justify-between gap-2">
                    <Link to={`/admin/devices/trade-ins/${trade.ref}`} className="adm-link">
                      <Ref value={trade.ref} />
                    </Link>
                    <span className="inline-flex items-center gap-2">
                      <TradeInBadge status={trade.status} />
                      <span className="type-caption text-ink-2">
                        <When at={trade.at} style="date" />
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          {unit.movements ? (
            <Section id="reg-moves" title={t("registry.movements")}>
              {unit.movements.length === 0 ? (
                <p className="type-body text-ink-2">{t("registry.noMovements")}</p>
              ) : (
                <ul className="dev-ledger">
                  {unit.movements.map((move) => (
                    <li key={move.id} className="flex flex-wrap justify-between gap-2">
                      <span>
                        {t(`movement.${move.kind}`)} {move.refId ? <span className="type-caption text-ink-2">· <Ref value={move.refId} /></span> : null}
                      </span>
                      <span className="type-caption text-ink-2">
                        {move.location ?? "—"} · <When at={move.at} />
                        {"unitCostIqd" in move ? <> · <Money iqd={move.unitCostIqd ?? null} /></> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
        </div>
        <aside className="dev-side">
          <Section id="reg-facts" title={t("registry.facts")}>
            <Facts
              rows={[
                { label: t("registry.col.device"), value: <Name text={unit.name} /> },
                { label: t("unit.sku"), value: <Ref value={unit.sku} /> },
                { label: t("registry.col.source"), value: <SourceText source={unit.source} /> },
                { label: t("registry.col.location"), value: unit.location ? <Ref value={unit.location} /> : "—" },
                { label: t("registry.col.cost"), value: <Money iqd={unit.costIqd ?? null} />, hidden: !("costIqd" in unit) },
                { label: t("registry.created"), value: <When at={unit.createdAt} /> },
                { label: t("registry.notes"), value: unit.notes ?? "—", hidden: !unit.notes },
              ]}
            />
            {unit.usedUnit ? (
              <p className="flex flex-wrap items-center gap-2 type-body">
                <Link to={`/admin/devices/used/${unit.usedUnit.id}`} className="adm-link">
                  {t("registry.usedUnit")}
                </Link>
                <UsedBadge status={unit.usedUnit.status} />
              </p>
            ) : null}
          </Section>
          <Section id="reg-warranties" title={t("registry.warranties")}>
            {unit.warranties.length === 0 ? (
              <p className="type-body text-ink-2">{t("registry.noWarranties")}</p>
            ) : (
              <ul className="dev-ledger">
                {unit.warranties.map((warranty) => (
                  <li key={warranty.id} className="flex flex-wrap justify-between gap-2">
                    <span>{t(`warranty.${warranty.status}`)}</span>
                    <span className="type-caption text-ink-2">
                      {t("registry.until")} <When at={warranty.endsAt} style="date" />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </aside>
      </div>
    </>
  );
}
