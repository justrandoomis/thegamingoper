import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/carrier";
import { useFormat } from "~/i18n/react";
import { invalid, throwAsResponse } from "~/server/errors";
import { applyCarrierRate, getCarrier, saveCarrier, setCarrierActive } from "~/server/services/admin/shipping/carriers.server";
import { SERVICE_LEVELS } from "~/server/services/admin/shipping/rules";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { CarrierForm } from "./components/CarrierForm";
import { ActionDialog, Code, FormError, Money, PageHead, Pair, ResponsiveList, Section, digitsOnly, useActionToast, useShipT } from "./components/kit";
import { shippingMeta } from "./meta";
import { all, amount, carrierFromForm, days, failed, ok, openShipping, text } from "./shipping.server";

/**
 * /admin/shipping/carriers/:carrierId — one carrier (11.02): its record, whether it is offered for new parcels (parcels
 * already with it keep it), and what it charges the store per governorate and service level with its estimate — the
 * figures the parcel page ranks carriers by. One rate can be applied to many governorates at once.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openShipping(context);
  try {
    return { detail: await getCarrier(db, actor, params.carrierId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const req = await openShipping(context, "shipping.carrier.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "carrier": {
        const result = await saveCarrier(req.db, req.actor, { ...carrierFromForm(form), carrierId: params.carrierId }, req.now);
        return ok(intent, result);
      }
      case "active": {
        const result = await setCarrierActive(req.db, req.actor, { carrierId: params.carrierId, isActive: text(form, "isActive") === "1", reason: text(form, "reason") }, req.now);
        return ok(intent, result);
      }
      case "rate": {
        const cost = amount(form, "costIqd");
        const min = days(form, "etaDaysMin");
        const max = days(form, "etaDaysMax");
        if (Number.isNaN(cost)) throw invalid({ costIqd: "invalid" });
        if (Number.isNaN(min) || Number.isNaN(max)) throw invalid({ etaDaysMax: "invalid" });
        const result = await applyCarrierRate(req.db, req.actor, { carrierId: params.carrierId, governorateIds: all(form, "governorateId"), serviceLevel: text(form, "serviceLevel") as never, costIqd: cost ?? null, etaDaysMin: min, etaDaysMax: max }, req.now);
        return ok(intent, result);
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "carrier.title", { name: args.loaderData?.detail.carrier.name ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];

export default function CarrierPage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { detail } = loaderData;
  const { carrier } = detail;
  const [toggle, setToggle] = useState(false);
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/shipping/carriers" className="adm-link">
            {t("carrier.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {carrier.name}
            <Status tone={carrier.isActive ? "ok" : "neutral"}>{carrier.isActive ? t("carriers.active") : t("carriers.inactive")}</Status>
          </span>
        }
        lead={detail.can.cost ? t("carrier.lead") : t("carrier.leadNoCost")}
        actions={
          detail.can.manage ? (
            <Key size="sm" onClick={() => setToggle(true)}>
              {carrier.isActive ? t("carrier.deactivate") : t("carrier.activate")}
            </Key>
          ) : undefined
        }
      />
      <div className="shp-split">
        <div className="min-w-0">
          <RatesSection detail={detail} />
          {detail.can.manage ? (
            <Section id="edit" title={t("carrier.edit")}>
              <CarrierForm
                submitLabel={t("carrier.save")}
                initial={{ id: carrier.id, code: carrier.code, name: carrier.name, kind: carrier.kind, contactName: carrier.contactName, phone: carrier.phone, trackingUrlTemplate: carrier.trackingUrlTemplate, codSupported: carrier.codSupported, codFeeIqd: carrier.codFeeIqd ?? null, codFeeBps: carrier.codFeeBps ?? null, notes: carrier.notes }}
              />
            </Section>
          ) : null}
        </div>
        <aside className="grid min-w-0 gap-4" aria-label={t("carrier.summary")}>
          <div className="adm-card">
            <h2 className="adm-h3">{t("carrier.summary")}</h2>
            <Pair label={t("carriers.code")}>
              <Code>{carrier.code}</Code>
            </Pair>
            <Pair label={t("carriers.kind")}>{t(`carrierKind.${carrier.kind}`)}</Pair>
            <Pair label={t("carriers.phone")}>{carrier.phone ? <Code>{carrier.phone}</Code> : "—"}</Pair>
            <Pair label={t("carriers.contact")}>{carrier.contactName ?? "—"}</Pair>
            <Pair label={t("carriers.codShort")}>{carrier.codSupported ? t("carriers.codYesShort") : t("carriers.codNo")}</Pair>
            {carrier.codSupported && detail.can.cost ? (
              <Pair label={t("carriers.codFee")}>
                {carrier.codFeeIqd ? f.iqd(carrier.codFeeIqd) : "—"}
                {carrier.codFeeBps ? ` + ${f.number(carrier.codFeeBps / 100)}%` : ""}
              </Pair>
            ) : null}
            <Pair label={t("carriers.onRoad")}>{f.number(carrier.onRoad)}</Pair>
            <Pair label={t("carriers.held")}>
              <Money iqd={carrier.codOutstandingIqd} />
            </Pair>
            {carrier.trackingUrlTemplate ? <p className="break-all type-caption text-ink-2" dir="ltr">{carrier.trackingUrlTemplate}</p> : <p className="type-caption text-ink-2">{t("carrier.noTrackingPage")}</p>}
            {carrier.notes ? <p className="type-caption">{carrier.notes}</p> : null}
            {carrier.isDemo ? <p className="type-caption text-ink-2">{t("common.demo")}</p> : null}
          </div>
        </aside>
      </div>
      <ActionDialog
        open={toggle}
        onClose={() => setToggle(false)}
        tone={carrier.isActive ? "destructive" : "neutral"}
        title={carrier.isActive ? t("carrier.deactivateTitle", { name: carrier.name }) : t("carrier.activateTitle", { name: carrier.name })}
        consequence={carrier.isActive ? t("carrier.deactivateConsequence") : t("carrier.activateConsequence")}
        confirmLabel={carrier.isActive ? t("carrier.deactivate") : t("carrier.activate")}
        impact={[{ label: t("carriers.onRoad"), value: t("carrier.keepParcels", { count: carrier.onRoad }) }]}
        reason={{ label: t("zones.reason") }}
        fields={{ intent: "active", isActive: carrier.isActive ? "0" : "1" }}
        successMessage={t("carriers.saved")}
      />
    </>
  );
}

function RatesSection({ detail }: { detail: Detail }) {
  const t = useShipT();
  const fetcher = useFetcher<{ ok: boolean; fields?: Record<string, string>; message?: string; code?: string; changed?: number }>();
  const failure = useActionToast(fetcher, t("carrier.ratesSaved"));
  const [level, setLevel] = useState<string>("standard");
  const [cost, setCost] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const fields = fetcher.data && !fetcher.data.ok ? fetcher.data.fields : undefined;
  const levelCell = (row: Detail["rates"][number], value: (typeof SERVICE_LEVELS)[number]) => {
    const rate = row.levels[value];
    if (!rate || !rate.isActive) return <span className="text-ink-2">—</span>;
    const eta = rate.etaDaysMin !== null ? t("zones.etaRange", { min: rate.etaDaysMin, max: rate.etaDaysMax ?? rate.etaDaysMin }) : null;
    // without carrier cost (a role that only reads parcels): the level is served, with its estimate, never its price
    if (!("costIqd" in rate)) return <span className="type-caption">{eta ?? t("carrier.served")}</span>;
    return (
      <span className="grid">
        <Money iqd={rate.costIqd} />
        {eta ? <span className="type-caption text-ink-2">{eta}</span> : null}
      </span>
    );
  };
  const title = detail.can.cost ? t("carrier.rates") : t("carrier.coverage");
  return (
    <Section id="rates" title={title}>
      <p className="type-caption text-ink-2">{detail.can.cost ? t("carrier.ratesLead") : t("carrier.ratesLeadNoCost")}</p>
      <ResponsiveList
        caption={title}
        rows={detail.rates}
        rowKey={(row) => row.governorateId}
        columns={[
          { key: "gov", header: t("common.governorate"), cell: (row) => (row.isActive ? row.governorate : `${row.governorate} · ${t("zones.paused")}`) },
          ...SERVICE_LEVELS.map((value) => ({ key: value, header: t(`level.${value}`), numeric: true, cell: (row: Detail["rates"][number]) => levelCell(row, value) })),
        ]}
        card={(row) => (
          <>
            <p className="type-strong">{row.governorate}</p>
            {SERVICE_LEVELS.map((value) => (
              <Pair key={value} label={t(`level.${value}`)}>
                {levelCell(row, value)}
              </Pair>
            ))}
          </>
        )}
      />
      {detail.can.manage ? (
        <fetcher.Form method="post" className="adm-card grid gap-3" aria-label={t("carrier.setRate")}>
          <input type="hidden" name="intent" value="rate" />
          <h3 className="adm-h3">{t("carrier.setRate")}</h3>
          <div className="shp-grid-form">
            <Select name="serviceLevel" label={t("waybill.level")} value={level} onChange={(event) => setLevel(event.currentTarget.value)} options={SERVICE_LEVELS.map((value) => ({ value, label: t(`level.${value}`) }))} />
            <TextField name="costIqd" label={t("carrier.cost")} inputMode="numeric" value={cost} onChange={(event) => setCost(digitsOnly(event.currentTarget.value))} hint={t("carrier.costHint")} error={fields?.costIqd} />
            <TextField name="etaDaysMin" label={t("zone.etaMin")} inputMode="numeric" value={min} onChange={(event) => setMin(digitsOnly(event.currentTarget.value))} optional />
            <TextField name="etaDaysMax" label={t("zone.etaMax")} inputMode="numeric" value={max} onChange={(event) => setMax(digitsOnly(event.currentTarget.value))} optional error={fields?.etaDaysMax} />
          </div>
          <fieldset className="grid gap-2">
            <legend className="type-label mb-1">{t("carrier.governorates")}</legend>
            <div className="flex flex-wrap gap-2">
              <Key size="sm" variant="quiet" onClick={() => setChosen(detail.rates.map((row) => row.governorateId))}>
                {t("carrier.selectAll")}
              </Key>
              <Key size="sm" variant="quiet" onClick={() => setChosen([])}>
                {t("carrier.selectNone")}
              </Key>
            </div>
            <div className="shp-checks">
              {detail.rates.map((row) => (
                <Checkbox
                  key={row.governorateId}
                  name="governorateId"
                  value={row.governorateId}
                  label={row.governorate}
                  checked={chosen.includes(row.governorateId)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    setChosen((current) => (on ? [...current, row.governorateId] : current.filter((id) => id !== row.governorateId)));
                  }}
                />
              ))}
            </div>
            {fields?.governorateIds ? <p className="type-label text-red-ink">{fields.governorateIds}</p> : null}
          </fieldset>
          <FormError message={fields ? null : failure} />
          <div>
            <Key type="submit" variant="ink" icon="floppy-disk" disabled={chosen.length === 0} loading={fetcher.state !== "idle"}>
              {cost === "" ? t("carrier.removeRate", { count: chosen.length }) : t("carrier.applyRate", { count: chosen.length })}
            </Key>
          </div>
        </fetcher.Form>
      ) : null}
    </Section>
  );
}
