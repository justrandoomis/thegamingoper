/**
 * The carrier form (11.02) — a new carrier on /admin/shipping/carriers, the same fields on a carrier's page. Posts
 * through a fetcher (intent "carrier"); field errors come back from the server's validation.
 */
import { useState } from "react";
import { useFetcher } from "react-router";

import { CARRIER_KIND_LIST } from "~/server/services/admin/shipping/rules";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { FormError, digitsOnly, percentOnly, useActionToast, useShipT } from "./kit";

export type CarrierValues = {
  id?: string;
  code: string;
  name: string;
  kind: "in_house" | "third_party";
  contactName: string | null;
  phone: string | null;
  trackingUrlTemplate: string | null;
  codSupported: boolean;
  codFeeIqd: number | null;
  codFeeBps: number | null;
  notes: string | null;
};

export function CarrierForm({ initial, submitLabel }: { initial?: CarrierValues; submitLabel: string }) {
  const t = useShipT();
  const fetcher = useFetcher<{ ok: boolean; fields?: Record<string, string>; message?: string; code?: string }>();
  const failure = useActionToast(fetcher, initial ? t("carriers.saved") : t("carriers.created"));
  const fields = fetcher.data && !fetcher.data.ok ? fetcher.data.fields : undefined;
  const [cod, setCod] = useState(initial?.codSupported ?? true);
  const [flat, setFlat] = useState(initial?.codFeeIqd != null ? String(initial.codFeeIqd) : "");
  const [bps, setBps] = useState(initial?.codFeeBps != null ? String(initial.codFeeBps / 100) : "");
  return (
    <fetcher.Form method="post" className="adm-card shp-grid-form" key={initial?.id ?? "new"}>
      <input type="hidden" name="intent" value="carrier" />
      {initial?.id ? <input type="hidden" name="carrierId" value={initial.id} /> : null}
      <TextField name="name" label={t("carriers.name")} defaultValue={initial?.name ?? ""} required maxLength={80} error={fields?.name} />
      <TextField name="code" label={t("carriers.code")} defaultValue={initial?.code ?? ""} required maxLength={20} ltr hint={t("carriers.codeHint")} error={fields?.code} />
      <Select
        name="kind"
        label={t("carriers.kind")}
        defaultValue={initial?.kind ?? "third_party"}
        options={CARRIER_KIND_LIST.map((kind) => ({ value: kind, label: t(`carrierKind.${kind}`) }))}
      />
      <TextField name="contactName" label={t("carriers.contact")} defaultValue={initial?.contactName ?? ""} optional maxLength={80} />
      <TextField name="phone" type="tel" label={t("carriers.phone")} defaultValue={initial?.phone ?? ""} optional maxLength={30} error={fields?.phone} />
      <TextField name="trackingUrlTemplate" type="url" label={t("carriers.trackingUrl")} defaultValue={initial?.trackingUrlTemplate ?? ""} optional hint={t("carriers.trackingUrlHint")} maxLength={300} error={fields?.trackingUrlTemplate} className="shp-wide" />
      <Checkbox name="codSupported" label={t("carriers.cod")} hint={t("carriers.codHint")} checked={cod} onChange={(event) => setCod(event.currentTarget.checked)} className="shp-wide" />
      {cod ? (
        <>
          <TextField name="codFeeIqd" label={t("carriers.codFlat")} inputMode="numeric" value={flat} onChange={(event) => setFlat(digitsOnly(event.currentTarget.value))} optional error={fields?.codFeeIqd} />
          <TextField name="codFeePct" label={t("carriers.codPct")} inputMode="decimal" value={bps} onChange={(event) => setBps(percentOnly(event.currentTarget.value))} optional hint={t("carriers.codPctHint")} error={fields?.codFeeBps} />
        </>
      ) : null}
      <TextArea name="notes" label={t("carriers.notes")} defaultValue={initial?.notes ?? ""} optional rows={2} maxLength={1000} className="shp-wide" />
      <FormError message={fields ? null : failure} />
      <div className="shp-wide">
        <Key type="submit" variant="ink" icon="floppy-disk" loading={fetcher.state !== "idle"}>
          {submitLabel}
        </Key>
      </div>
    </fetcher.Form>
  );
}
