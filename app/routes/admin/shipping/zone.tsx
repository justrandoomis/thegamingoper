import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/zone";
import { useFormat } from "~/i18n/react";
import { assertCan } from "~/server/actor";
import { invalid, throwAsResponse } from "~/server/errors";
import { effectiveFee } from "~/server/services/admin/shipping/rules";
import { getZone, saveDistrict, setDistrictActive, setGovernorateAvailability, setGovernorateEta, setOverrideFee } from "~/server/services/admin/shipping/zones.server";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, Code, FormError, Money, Note, PageHead, Pair, ResponsiveList, Section, When, digitsOnly, useActionToast, useShipT, wholeValue } from "./components/kit";
import { shippingMeta } from "./meta";
import { amount, days, failed, ok, openShipping, optional, text } from "./shipping.server";

/**
 * /admin/shipping/zones/:governorateId — one governorate (11.01): whether delivery is offered there (pausing it stops
 * checkout from taking new orders to it; open orders keep going), its own fee (an override, applied while
 * per-governorate fees are switched on), its delivery estimate (shown as an estimate, confirmed by phone), its
 * districts (added, renamed — the id never changes — or switched off), and what each carrier charges there (11.02).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openShipping(context);
  try {
    return { detail: await getZone(db, actor, params.governorateId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const req = await openShipping(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    // the permission before the input: a role without it gets 403, never a field error
    if (intent === "override") assertCan(req.actor, "shipping.rate.manage");
    else if (intent === "availability" || intent === "eta" || intent === "district" || intent === "district_active") assertCan(req.actor, "shipping.zone.manage");
    switch (intent) {
      case "availability": {
        const result = await setGovernorateAvailability(req.db, req.actor, { governorateId: params.governorateId, isActive: text(form, "isActive") === "1", reason: text(form, "reason") }, req.now);
        return ok(intent, result);
      }
      case "eta": {
        const min = days(form, "etaDaysMin");
        const max = days(form, "etaDaysMax");
        if (Number.isNaN(min) || Number.isNaN(max)) throw invalid({ etaDaysMax: "invalid" });
        const result = await setGovernorateEta(req.db, req.actor, { governorateId: params.governorateId, etaDaysMin: min, etaDaysMax: max }, req.now);
        return ok(intent, result);
      }
      case "override": {
        const fee = amount(form, "feeIqd");
        if (Number.isNaN(fee)) throw invalid({ feeIqd: "invalid" });
        const expected = text(form, "expected");
        const result = await setOverrideFee(req.db, req.actor, { governorateId: params.governorateId, feeIqd: fee ?? null, expectedIqd: expected === "" ? null : Number(expected), reason: text(form, "reason") }, req.now);
        return ok(intent, { applies: result.applies });
      }
      case "district": {
        const result = await saveDistrict(req.db, req.actor, { governorateId: params.governorateId, districtId: optional(form, "districtId"), nameAr: text(form, "nameAr"), nameEn: optional(form, "nameEn"), nameCkb: optional(form, "nameCkb") }, req.now);
        return ok(intent, result);
      }
      case "district_active": {
        // the district must be one of this page's governorate (an id from the form is never trusted to belong here)
        const result = await setDistrictActive(req.db, req.actor, { governorateId: params.governorateId, districtId: text(form, "districtId"), isActive: text(form, "isActive") === "1", reason: text(form, "reason") }, req.now);
        return ok(intent, result);
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "zone.title", { name: args.loaderData?.detail.zone.name ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];

export default function ZonePage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { detail } = loaderData;
  const { zone, policy } = detail;
  const [pause, setPause] = useState(false);
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/shipping/zones" className="adm-link">
            {t("zone.back")}
          </Link>
        }
        title={zone.name}
        lead={detail.can.cost ? t("zone.lead") : t("zone.leadNoCost")}
      />
      <div className="shp-split">
        <div className="min-w-0">
          <Section id="availability" title={t("zone.availability")}>
            <div className="adm-card">
              <p>
                <Status tone={zone.isActive ? "ok" : "warn"}>{zone.isActive ? t("zones.active") : t("zones.paused")}</Status>
              </p>
              <p className="type-caption text-ink-2">{zone.isActive ? t("zone.activeHint") : t("zone.pausedHint")}</p>
              {detail.can.zones ? (
                <div>
                  <Key size="sm" onClick={() => setPause(true)}>
                    {zone.isActive ? t("zone.pause") : t("zone.resume")}
                  </Key>
                </div>
              ) : null}
            </div>
            <ActionDialog
              open={pause}
              onClose={() => setPause(false)}
              tone={zone.isActive ? "destructive" : "neutral"}
              title={zone.isActive ? t("zone.pauseTitle", { name: zone.name }) : t("zone.resumeTitle", { name: zone.name })}
              consequence={zone.isActive ? t("zone.pauseConsequence") : t("zone.resumeConsequence", { fee: f.iqd(effectiveFee(policy, zone.overrideIqd)) })}
              confirmLabel={zone.isActive ? t("zone.pause") : t("zone.resume")}
              impact={[
                { label: t("zone.impactCheckout"), value: zone.isActive ? t("zone.impactRefused") : f.iqd(effectiveFee(policy, zone.overrideIqd)) },
                { label: t("zones.openOrders"), value: t("zone.impactOpen", { count: zone.openOrders }) },
              ]}
              reason={{ label: t("zones.reason"), hint: t("zones.reasonHint") }}
              fields={{ intent: "availability", isActive: zone.isActive ? "0" : "1" }}
              successMessage={t("zone.availabilityDone")}
            />
          </Section>

          <FeeSection detail={detail} />
          <EtaSection detail={detail} />
          <DistrictsSection detail={detail} />
        </div>

        <aside className="grid min-w-0 gap-4" aria-label={t("zone.summary")}>
          <div className="adm-card">
            <h2 className="adm-h3">{t("zone.summary")}</h2>
            <Pair label={t("zones.fee")}>{zone.feeIqd === null ? t("zones.notOffered") : <Money iqd={zone.feeIqd} />}</Pair>
            <Pair label={t("zones.eta")}>{zone.etaDaysMin === null ? t("zones.noEta") : t("zones.etaRange", { min: zone.etaDaysMin, max: zone.etaDaysMax ?? zone.etaDaysMin })}</Pair>
            <Pair label={t("zones.openOrders")}>{f.number(zone.openOrders)}</Pair>
            <Pair label={t("zone.slug")}>
              <Code>{zone.slug}</Code>
            </Pair>
          </div>
          <div className="adm-card">
            <h2 className="adm-h3">{detail.can.cost ? t("zone.carriers") : t("zone.carriersNoCost")}</h2>
            {detail.carrierRates.length === 0 ? (
              <p className="type-caption text-ink-2">{t("zone.noCarriers")}</p>
            ) : (
              <ul role="list" className="grid gap-2">
                {detail.carrierRates.map((rate) => (
                  <li key={`${rate.carrierId}-${rate.serviceLevel}`} className="grid gap-0.5">
                    <span className="flex items-center justify-between gap-2">
                      <Link to={`/admin/shipping/carriers/${encodeURIComponent(rate.carrierId)}`} className="adm-link type-label">
                        {rate.carrier}
                      </Link>
                      {"costIqd" in rate ? <Money iqd={rate.costIqd} /> : null}
                    </span>
                    <span className="type-caption text-ink-2">
                      {t(`level.${rate.serviceLevel}`)}
                      {rate.etaDaysMin !== null ? ` · ${t("zones.etaRange", { min: rate.etaDaysMin, max: rate.etaDaysMax ?? rate.etaDaysMin })}` : ""}
                      {!rate.rateActive || !rate.isActive ? ` · ${t("zone.rateOff")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

function FeeSection({ detail }: { detail: Detail }) {
  const t = useShipT();
  const f = useFormat();
  const { zone, policy } = detail;
  const [value, setValue] = useState(zone.overrideIqd === null ? "" : String(zone.overrideIqd));
  const [open, setOpen] = useState(false);
  const fee = wholeValue(value);
  const bad = fee !== null && Number.isNaN(fee);
  const before = zone.isActive ? effectiveFee(policy, zone.overrideIqd) : null;
  const after = zone.isActive && !bad ? effectiveFee(policy, fee) : null;
  const impact = useMemo(
    () => [
      { label: t("zone.feeNow"), value: before === null ? t("zones.notOffered") : f.iqd(before) },
      { label: t("zone.feeAfter"), value: after === null ? t("zones.notOffered") : f.iqd(after), negative: before !== null && after !== null && after < before },
    ],
    [after, before, f, t],
  );
  return (
    <Section id="fee" title={t("zone.fee")}>
      <div className="adm-card">
        <p className="type-body">{zone.overrideIqd === null ? t("zone.noOverride", { fee: f.iqd(policy.flatFeeIqd) }) : t("zone.hasOverride", { fee: f.iqd(zone.overrideIqd) })}</p>
        <p className="type-caption text-ink-2">{policy.overridesEnabled ? t("zones.overrideApplies") : t("zones.overrideDormant")}</p>
        {detail.can.rates ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!bad && fee !== zone.overrideIqd) setOpen(true);
            }}
          >
            <TextField label={t("zone.overrideField")} inputMode="numeric" value={value} onChange={(event) => setValue(digitsOnly(event.currentTarget.value))} hint={t("zones.emptyRemoves")} error={bad ? t("common.wholeDinars") : undefined} />
            <Key type="submit" size="sm" disabled={bad || fee === zone.overrideIqd}>
              {fee === null ? t("zones.removeOverride") : t("zones.saveOverride")}
            </Key>
          </form>
        ) : null}
      </div>
      {detail.overrideHistory.length ? (
        <details className="type-caption">
          <summary className="adm-link">{t("zone.history", { count: detail.overrideHistory.length })}</summary>
          <ul role="list" className="mt-2 grid gap-1">
            {detail.overrideHistory.map((row) => (
              <li key={row.id}>
                <Money iqd={row.feeIqd} /> · {row.isActive ? t("zone.historyActive") : t("zone.historyOld")} · <When at={row.updatedAt} />
                {row.updatedBy ? ` · ${row.updatedBy}` : ""}
                {row.note ? ` · ${row.note}` : ""}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={fee === null ? t("zone.removeTitle", { name: zone.name }) : t("zone.overrideTitle", { name: zone.name })}
        consequence={policy.overridesEnabled ? t("zones.overrideApplies") : t("zones.overrideDormant")}
        confirmLabel={fee === null ? t("zones.removeOverride") : t("zones.saveOverride")}
        impact={impact}
        reason={{ label: t("zones.reason"), hint: t("zones.reasonHint") }}
        fields={{ intent: "override", feeIqd: value, expected: zone.overrideIqd === null ? "" : String(zone.overrideIqd) }}
        successMessage={t("zones.overrideDone")}
      />
    </Section>
  );
}

function EtaSection({ detail }: { detail: Detail }) {
  const t = useShipT();
  const fetcher = useFetcher();
  const failure = useActionToast(fetcher as never, t("zone.etaDone"));
  const { zone } = detail;
  const [min, setMin] = useState(zone.etaDaysMin === null ? "" : String(zone.etaDaysMin));
  const [max, setMax] = useState(zone.etaDaysMax === null ? "" : String(zone.etaDaysMax));
  const fields = (fetcher.data as { fields?: Record<string, string> } | undefined)?.fields;
  return (
    <Section id="eta" title={t("zone.eta")}>
      <p className="type-caption text-ink-2">{t("zone.etaLead")}</p>
      {detail.can.zones ? (
        <fetcher.Form method="post" className="adm-card flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value="eta" />
          <TextField name="etaDaysMin" label={t("zone.etaMin")} inputMode="numeric" value={min} onChange={(event) => setMin(digitsOnly(event.currentTarget.value))} error={fields?.etaDaysMin} />
          <TextField name="etaDaysMax" label={t("zone.etaMax")} inputMode="numeric" value={max} onChange={(event) => setMax(digitsOnly(event.currentTarget.value))} error={fields?.etaDaysMax} />
          <Key type="submit" size="sm" loading={fetcher.state !== "idle"}>
            {t("zone.etaSave")}
          </Key>
          <p className="w-full type-caption text-ink-2">{t("zone.etaHint")}</p>
          <FormError message={fields ? null : failure} />
        </fetcher.Form>
      ) : (
        <p className="type-body">{zone.etaDaysMin === null ? t("zones.noEta") : t("zones.etaRange", { min: zone.etaDaysMin, max: zone.etaDaysMax ?? zone.etaDaysMin })}</p>
      )}
    </Section>
  );
}

function DistrictsSection({ detail }: { detail: Detail }) {
  const t = useShipT();
  const f = useFormat();
  const add = useFetcher();
  const addFailure = useActionToast(add as never, t("zone.districtSaved"));
  const [toggle, setToggle] = useState<Detail["districts"][number] | null>(null);
  const [rename, setRename] = useState<Detail["districts"][number] | null>(null);
  const addFields = (add.data as { fields?: Record<string, string> } | undefined)?.fields;
  return (
    <Section id="districts" title={t("zone.districts", { count: detail.districts.length })}>
      <ResponsiveList
        caption={t("zone.districts", { count: detail.districts.length })}
        rows={detail.districts}
        rowKey={(row) => row.id}
        columns={[
          { key: "name", header: t("zone.district"), cell: (row) => row.name },
          { key: "state", header: t("zones.delivery"), cell: (row) => <Status tone={row.isActive ? "ok" : "warn"}>{row.isActive ? t("zones.active") : t("zones.paused")}</Status> },
          { key: "open", header: t("zones.openOrders"), numeric: true, cell: (row) => f.number(row.openOrders) },
          // no empty "Actions" column for a role that cannot change districts
          ...(detail.can.zones
            ? [
                {
                  key: "actions",
                  header: t("common.actions"),
                  cell: (row: Detail["districts"][number]) => (
                    <span className="flex flex-wrap gap-2">
                      <Key size="sm" variant="quiet" onClick={() => setRename(row)}>
                        {t("zone.rename")}
                      </Key>
                      <Key size="sm" variant="quiet" onClick={() => setToggle(row)}>
                        {row.isActive ? t("zone.districtOff") : t("zone.districtOn")}
                      </Key>
                    </span>
                  ),
                },
              ]
            : []),
        ]}
        card={(row) => (
          <>
            <div className="flex items-start justify-between gap-2">
              <span className="type-strong">{row.name}</span>
              <Status tone={row.isActive ? "ok" : "warn"}>{row.isActive ? t("zones.active") : t("zones.paused")}</Status>
            </div>
            <Pair label={t("zones.openOrders")}>{f.number(row.openOrders)}</Pair>
            {detail.can.zones ? (
              <span className="flex flex-wrap gap-2">
                <Key size="sm" onClick={() => setRename(row)}>
                  {t("zone.rename")}
                </Key>
                <Key size="sm" onClick={() => setToggle(row)}>
                  {row.isActive ? t("zone.districtOff") : t("zone.districtOn")}
                </Key>
              </span>
            ) : null}
          </>
        )}
        empty={<EmptyState icon="map-pin" title={t("zone.noDistricts")} />}
      />
      {detail.can.zones ? (
        <add.Form method="post" className="adm-card shp-grid-form" aria-label={t("zone.addDistrict")}>
          <input type="hidden" name="intent" value="district" />
          <h3 className="adm-h3 shp-wide">{t("zone.addDistrict")}</h3>
          <TextField name="nameAr" label={t("zone.nameAr")} required maxLength={80} error={addFields?.nameAr} />
          <TextField name="nameEn" label={t("zone.nameEn")} optional maxLength={80} />
          <TextField name="nameCkb" label={t("zone.nameCkb")} optional maxLength={80} />
          <div className="shp-wide">
            <Key type="submit" size="sm" icon="plus" loading={add.state !== "idle"}>
              {t("zone.addDistrict")}
            </Key>
          </div>
          <FormError message={addFields ? null : addFailure} />
        </add.Form>
      ) : null}
      {toggle ? (
        <ActionDialog
          open
          onClose={() => setToggle(null)}
          tone={toggle.isActive ? "destructive" : "neutral"}
          title={toggle.isActive ? t("zone.districtOffTitle", { name: toggle.name }) : t("zone.districtOnTitle", { name: toggle.name })}
          consequence={toggle.isActive ? t("zone.districtOffConsequence") : t("zone.districtOnConsequence")}
          confirmLabel={toggle.isActive ? t("zone.districtOff") : t("zone.districtOn")}
          impact={[{ label: t("zones.openOrders"), value: t("zone.impactOpen", { count: toggle.openOrders }) }]}
          reason={{ label: t("zones.reason") }}
          fields={{ intent: "district_active", districtId: toggle.id, isActive: toggle.isActive ? "0" : "1" }}
          successMessage={t("zone.districtSaved")}
        />
      ) : null}
      {rename ? <RenameDialog district={rename} onClose={() => setRename(null)} /> : null}
      <Note>{t("zone.districtNote")}</Note>
    </Section>
  );
}

function RenameDialog({ district, onClose }: { district: Detail["districts"][number]; onClose: () => void }) {
  const t = useShipT();
  const [ar, setAr] = useState(district.names.ar);
  const [en, setEn] = useState(district.names.en ?? "");
  const [ckb, setCkb] = useState(district.names.ckb ?? "");
  return (
    <ActionDialog
      open
      onClose={onClose}
      title={t("zone.renameTitle", { name: district.name })}
      consequence={t("zone.renameConsequence")}
      confirmLabel={t("zone.rename")}
      fields={{ intent: "district", districtId: district.id, nameAr: ar, nameEn: en, nameCkb: ckb }}
      successMessage={t("zone.districtSaved")}
    >
      <div className="grid gap-3">
        <TextField label={t("zone.nameAr")} value={ar} onChange={(event) => setAr(event.currentTarget.value)} required maxLength={80} />
        <TextField label={t("zone.nameEn")} value={en} onChange={(event) => setEn(event.currentTarget.value)} optional maxLength={80} />
        <TextField label={t("zone.nameCkb")} value={ckb} onChange={(event) => setCkb(event.currentTarget.value)} optional maxLength={80} />
      </div>
    </ActionDialog>
  );
}
