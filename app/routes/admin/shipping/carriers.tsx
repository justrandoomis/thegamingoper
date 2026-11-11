import { Link } from "react-router";

import type { Route } from "./+types/carriers";
import { useFormat } from "~/i18n/react";
import { invalid, throwAsResponse } from "~/server/errors";
import { listCarriers, saveCarrier } from "~/server/services/admin/shipping/carriers.server";
import { shippingAccess } from "~/server/services/admin/shipping/shared.server";
import { EmptyState } from "~/ui/EmptyState";
import { Status } from "~/ui/Tag";
import { CarrierForm } from "./components/CarrierForm";
import { Code, Money, Note, PageHead, Pair, ResponsiveList, RowLink, Section, useShipT } from "./components/kit";
import { shippingMeta } from "./meta";
import { carrierFromForm, failed, ok, openShipping, text } from "./shipping.server";

/**
 * /admin/shipping/carriers — 11.02: the delivery companies and the store's own drivers, with what each serves, what it
 * charges, whether it collects cash and what it keeps from it, the parcels it holds and the cash its couriers still
 * hold. A carrier is a record: no courier API is connected; pickups are booked by phone or on the carrier's portal.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openShipping(context);
  try {
    return { carriers: await listCarriers(db, actor), access: shippingAccess(actor) };
  } catch (error) {
    // a role that passes the module's gate without the page's permission: 403, not a crash
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openShipping(context, "shipping.carrier.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "carrier") throw invalid({ intent: "invalid" });
    const input = carrierFromForm(form);
    const result = await saveCarrier(req.db, req.actor, { ...input, carrierId: undefined }, req.now, { demo: req.ctx.storeMode === "demo" });
    return ok(intent, result);
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "carriers.title");

export default function Carriers({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { carriers, access } = loaderData;
  return (
    <>
      <PageHead title={t("carriers.title")} lead={t("carriers.lead")} />
      <Note icon="plugs-connected">{t("carriers.boundary")}</Note>
      <Section id="list" title={t("carriers.list", { count: carriers.length })}>
        <ResponsiveList
          caption={t("carriers.list", { count: carriers.length })}
          rows={carriers}
          rowKey={(row) => row.id}
          columns={[
            { key: "name", header: t("carriers.name"), cell: (row) => <RowLink to={`/admin/shipping/carriers/${encodeURIComponent(row.id)}`}>{row.name}</RowLink> },
            { key: "code", header: t("carriers.code"), cell: (row) => <Code>{row.code}</Code> },
            { key: "kind", header: t("carriers.kind"), cell: (row) => t(`carrierKind.${row.kind}`) },
            { key: "state", header: t("common.status"), cell: (row) => <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("carriers.active") : t("carriers.inactive")}</Status> },
            { key: "zones", header: t("carriers.zones"), numeric: true, cell: (row) => f.number(row.zones) },
            {
              key: "cod",
              header: t("carriers.codShort"),
              cell: (row) => (row.codSupported ? ("codFeeIqd" in row ? t("carriers.codYes", { fee: feeText(f, row.codFeeIqd ?? null, row.codFeeBps ?? null) }) : t("carriers.codYesShort")) : t("carriers.codNo")),
            },
            { key: "road", header: t("carriers.onRoad"), numeric: true, cell: (row) => f.number(row.onRoad) },
            { key: "held", header: t("carriers.held"), numeric: true, cell: (row) => <Money iqd={row.codOutstandingIqd} /> },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/shipping/carriers/${encodeURIComponent(row.id)}`} className="adm-link type-strong">
                  {row.name}
                </Link>
                <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("carriers.active") : t("carriers.inactive")}</Status>
              </div>
              <Pair label={t("carriers.kind")}>{t(`carrierKind.${row.kind}`)}</Pair>
              <Pair label={t("carriers.zones")}>{f.number(row.zones)}</Pair>
              <Pair label={t("carriers.onRoad")}>{f.number(row.onRoad)}</Pair>
              <Pair label={t("carriers.held")}>
                <Money iqd={row.codOutstandingIqd} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="truck" title={t("carriers.empty")} text={access.carriers ? t("carriers.emptyHint") : undefined} />}
        />
      </Section>
      {access.carriers ? (
        <Section id="new" title={t("carriers.new")}>
          <CarrierForm submitLabel={t("carriers.create")} />
        </Section>
      ) : null}
    </>
  );
}

function feeText(f: ReturnType<typeof useFormat>, flat: number | null, bps: number | null): string {
  const parts: string[] = [];
  if (flat) parts.push(f.iqd(flat));
  if (bps) parts.push(`${f.number(bps / 100)}%`);
  return parts.length ? parts.join(" + ") : "—";
}
