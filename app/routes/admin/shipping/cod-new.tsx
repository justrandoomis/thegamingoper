import { useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/cod-new";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { carrierChoices } from "~/server/services/admin/shipping/carriers.server";
import { createSettlement, eligibleParcels } from "~/server/services/admin/shipping/cod.server";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextArea } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Code, FormError, Money, Note, PageHead, ParcelStatus, Section, When, failureText, useShipT } from "./components/kit";
import { shippingMeta } from "./meta";
import { all, failed, newKey, openShipping, optional, text } from "./shipping.server";

/**
 * /admin/shipping/cod/new?carrier=<id> — 11.04: a new settlement DRAFT from the carrier's statement. The carrier's
 * completed parcels that no settlement holds are listed with the cash each delivered one brought (the order's
 * cash-on-delivery amount, on the order's first parcel) and the carrier's suggested charge (its rate on the waybill
 * plus its cash fee). Ticked parcels become the draft (works without JavaScript); amounts are corrected on the draft.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openShipping(context, "shipping.cod.settle");
  const carrierId = new URL(request.url).searchParams.get("carrier");
  const carriers = await carrierChoices(db);
  try {
    const eligible = carrierId ? await eligibleParcels(db, actor, carrierId, locale) : null;
    return { carriers, eligible, key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openShipping(context, "shipping.cod.settle");
  const form = await request.formData();
  try {
    const result = await createSettlement(req.db, req.actor, { carrierId: text(form, "carrierId"), shipmentIds: all(form, "shipmentId"), notes: optional(form, "notes"), idempotencyKey: text(form, "key") }, req.now, req.locale);
    throw redirect(`/admin/shipping/cod/${encodeURIComponent(result.settlementId)}`);
  } catch (error) {
    return failed(error, req.locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "codNew.title");

export default function NewSettlement({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { carriers, eligible, key } = loaderData;
  const [chosen, setChosen] = useState<string[]>(() => eligible?.parcels.map((parcel) => parcel.shipmentId) ?? []);
  const picked = eligible?.parcels.filter((parcel) => chosen.includes(parcel.shipmentId)) ?? [];
  const expected = picked.reduce((sum, parcel) => sum + parcel.amountIqd, 0);
  const fees = picked.reduce((sum, parcel) => sum + parcel.feeIqd, 0);
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/shipping/cod" className="adm-link">
            {t("codNew.back")}
          </Link>
        }
        title={t("codNew.title")}
        lead={t("codNew.lead")}
      />
      <Form method="get" className="adm-card flex flex-wrap items-end gap-3">
        <Select name="carrier" label={t("common.carrier")} defaultValue={eligible?.carrier.id ?? ""} options={[{ value: "", label: t("codNew.chooseCarrier") }, ...carriers.map((carrier) => ({ value: carrier.id, label: carrier.name }))]} />
        <Key type="submit" icon="funnel">
          {t("codNew.show")}
        </Key>
      </Form>

      {eligible ? (
        <Section id="parcels" title={t("codNew.parcels", { carrier: eligible.carrier.name, count: eligible.parcels.length })}>
          {eligible.parcels.length === 0 ? (
            <EmptyState icon="check-circle" title={t("codNew.none")} />
          ) : (
            <Form method="post" className="grid gap-3">
              <input type="hidden" name="key" value={key} />
              <input type="hidden" name="carrierId" value={eligible.carrier.id} />
              <div className="flex flex-wrap gap-2">
                <Key size="sm" variant="quiet" onClick={() => setChosen(eligible.parcels.map((parcel) => parcel.shipmentId))}>
                  {t("carrier.selectAll")}
                </Key>
                <Key size="sm" variant="quiet" onClick={() => setChosen([])}>
                  {t("carrier.selectNone")}
                </Key>
              </div>
              <ul role="list" className="grid gap-2">
                {eligible.parcels.map((parcel) => (
                  <li key={parcel.shipmentId} className="adm-card gap-1">
                    <Checkbox
                      name="shipmentId"
                      value={parcel.shipmentId}
                      checked={chosen.includes(parcel.shipmentId)}
                      onChange={(event) => {
                        const on = event.currentTarget.checked;
                        setChosen((current) => (on ? [...current, parcel.shipmentId] : current.filter((id) => id !== parcel.shipmentId)));
                      }}
                      label={
                        <span className="flex flex-wrap items-center gap-2">
                          <Code>{parcel.code}</Code>
                          <ParcelStatus status={parcel.status} />
                          {parcel.isDemo ? <span className="type-caption text-ink-2">{t("common.demo")}</span> : null}
                        </span>
                      }
                    />
                    <p className="flex flex-wrap gap-x-4 gap-y-1 type-caption text-ink-2">
                      <span>{parcel.governorate ?? "—"}</span>
                      <span>
                        <When at={parcel.completedAt} />
                      </span>
                      <span>
                        {t("codNew.cash")} <Money iqd={parcel.amountIqd} />
                      </span>
                      <span>
                        {t("codNew.fee")} <Money iqd={parcel.feeIqd} />
                        {parcel.feeKnown ? "" : ` (${t("codNew.feeGuess")})`}
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
              <TextArea name="notes" label={t("codNew.notes")} optional rows={2} maxLength={1000} hint={t("codNew.notesHint")} />
              <dl className="shp-ledger max-w-sm">
                <div>
                  <dt>{t("cod.expected")}</dt>
                  <dd>
                    <Money iqd={expected} />
                  </dd>
                </div>
                <div>
                  <dt>{t("cod.fees")}</dt>
                  <dd>
                    <Money iqd={fees} />
                  </dd>
                </div>
                <div className="shp-ledger__total">
                  <dt>{t("cod.netDue")}</dt>
                  <dd>
                    <Money iqd={expected - fees} />
                  </dd>
                </div>
              </dl>
              <Note>{t("codNew.draftNote")}</Note>
              <FormError message={result && !result.ok ? failureText(t, result) : null} />
              <div className="shp-sticky" data-adm-sticky-end>
                <span className="me-auto self-center type-label nums">{t("codNew.selected", { count: f.number(chosen.length) })}</span>
                <Key type="submit" variant="ink" icon="clipboard-text" disabled={chosen.length === 0} loading={navigation.state === "submitting"}>
                  {t("codNew.create")}
                </Key>
              </div>
            </Form>
          )}
        </Section>
      ) : (
        <p className="mt-4 type-body text-ink-2">{t("codNew.pickCarrier")}</p>
      )}
    </>
  );
}
