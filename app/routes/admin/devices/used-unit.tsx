import { data, Link } from "react-router";

import type { Route } from "./+types/used-unit";
import { throwAsResponse } from "~/server/errors";
import { getUsedUnitDetail } from "~/server/services/admin/devices/used.server";
import { devicesBlobStore } from "./env.server";
import { openDevices, urls } from "./devices.server";
import { devicesMeta } from "./meta";
import { unitAction } from "./used-unit.server";
import { ChecksSection, GameSection, GradingSection, ReadinessSection, UnitChecklistSection, UnitFactsSection, UnitHistorySection, UnitPhotosSection } from "./used-parts";
import { DemoNote, GradeTag, Name, Ref, UsedBadge, useDevicesT } from "./ui";

/**
 * /admin/devices/used/:id — one used unit: what keeps it from the shop window, the checklist (13.02), grade and the
 * words a customer reads (13.09), ownership and data wipe (13.08), its photos and which of them show THIS unit
 * (13.09), the price (pricing 03's rules), a game's region and platform facts (13.05), listing and the history.
 * Every change is a POST to this page's action (used-unit.server.ts).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, ["devices.registry.read", "devices.used.intake", "devices.used.inspect", "devices.used.grade", "devices.used.list", "devices.ownership.verify"]);
  try {
    return { unit: await getUsedUnitDetail(db, actor, params.id, locale, { file: urls.file }) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openDevices(context);
  const result = await unitAction(req.ctx, req.db, req.session, params.id, await request.formData(), devicesBlobStore);
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, null, undefined, args.loaderData?.unit.name);

export default function UsedUnitPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const { unit } = loaderData;
  const onSale = unit.status === "listed" || unit.status === "reserved" || unit.status === "sold";
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/devices/used" className="adm-link">
            {t("unit.back")}
          </Link>
        </p>
        <h1 className="adm-title">
          <Name text={unit.name} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <UsedBadge status={unit.status} />
          <GradeTag grade={unit.grade} />
          <DemoNote show={unit.isDemo} />
          <span className="type-caption text-ink-2">
            <Ref value={unit.slug} />
          </span>
          {onSale ? (
            <a href={`/used/${unit.slug}`} className="adm-link type-caption" target="_blank" rel="noreferrer">
              {t("unit.storePage")}
            </a>
          ) : null}
          {unit.serial ? (
            <Link to={`/admin/devices/registry/${unit.serial.id}`} className="adm-link type-caption">
              {t("unit.inRegistry")}
            </Link>
          ) : null}
        </div>
      </header>

      <ReadinessSection unit={unit} />

      <div className="dev-layout">
        <div className="grid min-w-0 gap-6">
          <UnitChecklistSection unit={unit} />
          <GradingSection unit={unit} />
          <UnitPhotosSection unit={unit} />
          <GameSection unit={unit} />
          <UnitHistorySection unit={unit} />
        </div>
        <aside className="dev-side">
          <UnitFactsSection unit={unit} />
          <ChecksSection unit={unit} />
        </aside>
      </div>
    </>
  );
}
