import { data, Link } from "react-router";

import type { Route } from "./+types/trade-in";
import { throwAsResponse } from "~/server/errors";
import { getTradeInDetail } from "~/server/services/admin/devices/tradeins.server";
import { devicesBlobStore } from "./env.server";
import { openDevices, urls } from "./devices.server";
import { devicesMeta } from "./meta";
import { tradeInAction } from "./trade-in.server";
import { ActionsSection, DifferenceSection, FactsSection, HistorySection, InspectionSection, OfferSection, PhotosSection, PipelineSection, ValuationSection } from "./trade-in-parts";
import { DemoNote, Ref, TradeInBadge, useDevicesT } from "./ui";

/**
 * /admin/devices/trade-ins/:ref — one trade-in through the blueprint's workflow (valuation → inspection & ownership →
 * offer → approval → receipt & data wipe → cost entry → relisting): the customer's request, the inspection with the
 * checklist, grade, variant, serial and ownership checks (13.02, 13.08), the guide's valuation and reference prices
 * (13.03), the price difference against any product and the final offer with its validity (13.04), the customer's
 * answer, the data wipe and the payout that creates the used unit, photos and the history the tracking page shows.
 * Every change is a POST to this page's action (trade-in.server.ts).
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openDevices(context, ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"]);
  const target = new URL(request.url).searchParams.get("target")?.trim().slice(0, 80) ?? "";
  try {
    return { ti: await getTradeInDetail(db, actor, params.ref, locale, now, { file: urls.file, target: target || null }), target };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openDevices(context);
  const result = await tradeInAction(req.ctx, req.db, req.session, params.ref, await request.formData(), devicesBlobStore);
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, null, undefined, args.loaderData?.ti.ref);

export default function TradeInPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const { ti, target } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/devices/trade-ins" className="adm-link">
            {t("detail.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <Ref value={ti.ref} />
          <DemoNote show={ti.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <TradeInBadge status={ti.status} expired={ti.offerExpired} />
          <span className="type-caption text-ink-2">{t(ti.counter ? "source.counter" : "source.online")}</span>
        </div>
      </header>

      <PipelineSection ti={ti} />
      <ActionsSection ti={ti} />

      <div className="dev-layout">
        <div className="grid min-w-0 gap-6">
          <InspectionSection ti={ti} />
          <ValuationSection ti={ti} />
          <DifferenceSection ti={ti} target={target} />
          <PhotosSection ti={ti} />
          <HistorySection ti={ti} />
        </div>
        <aside className="dev-side">
          <FactsSection ti={ti} />
          <OfferSection ti={ti} />
        </aside>
      </div>
    </>
  );
}
