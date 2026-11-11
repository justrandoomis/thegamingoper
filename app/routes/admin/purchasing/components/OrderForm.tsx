/**
 * The purchase-order form (new order and draft edit, 09.03): supplier, delivery location, currency and its dated rate,
 * expected day, terms, line rows (SKU or barcode — a scanner works — quantity, unit cost in the supplier's currency),
 * shipping and other charges. A running total (in the currency and in IQD at the typed rate) says before saving whether
 * the order will need a second person's approval; the server computes everything again and decides.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, useNavigation } from "react-router";

import { useFormat } from "~/i18n/react";
import { COST_CURRENCIES, decimalsOf, needsApproval, parseCount, parseDecimal, parseRateMicros, poTotals, toIqd } from "~/server/services/admin/purchasing/rules";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { LineRows } from "./LineRows";
import { FormError, Minor, Money, Note, usePurT } from "./kit";

export type OrderFormValues = {
  supplierId: string;
  locationId: string;
  currency: string;
  fxRate: string;
  expectedOn: string;
  paymentTerms: string;
  notes: string;
  shipping: string;
  other: string;
  lines: { code: string; qty: string; unitCost: string }[];
};

type Option = { value: string; label: string };

const CURRENCIES = Object.keys(COST_CURRENCIES);

function estimate(form: HTMLFormElement | null, currency: string) {
  if (!form) return null;
  const data = new FormData(form);
  const decimals = decimalsOf(currency);
  const lines: { qty: number; unitCostMinor: number }[] = [];
  for (const [key, value] of data.entries()) {
    const match = /^lines\.(\d+)\.qty$/.exec(key);
    if (!match) continue;
    const qty = parseCount(String(value));
    const cost = parseDecimal(String(data.get(`lines.${match[1]}.unitCost`) ?? ""), decimals);
    if (qty !== undefined && !Number.isNaN(qty) && qty > 0 && cost !== null) lines.push({ qty, unitCostMinor: cost });
  }
  const shipping = parseDecimal(String(data.get("shipping") || "0"), decimals) ?? 0;
  const other = parseDecimal(String(data.get("other") || "0"), decimals) ?? 0;
  try {
    const { totalMinor } = poTotals(lines, shipping, other);
    const rate = currency === "IQD" ? 1_000_000 : parseRateMicros(String(data.get("fxRate") ?? ""));
    return { totalMinor, totalIqd: toIqd(totalMinor, currency, rate), lines: lines.length };
  } catch {
    return null;
  }
}

export function OrderForm({
  suppliers,
  locations,
  values,
  version,
  formKey,
  failure,
  limitIqd,
  submitLabel,
}: {
  suppliers: (Option & { currency: string })[];
  locations: Option[];
  values: OrderFormValues;
  version?: number;
  formKey?: string;
  failure: { ok: false; message?: string; code?: string; fields?: Record<string, string> } | null;
  limitIqd: number;
  submitLabel: string;
}) {
  const t = usePurT();
  const f = useFormat();
  const navigation = useNavigation();
  const [currency, setCurrency] = useState(values.currency);
  const [total, setTotal] = useState<ReturnType<typeof estimate>>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fields = failure?.fields ?? {};
  const recompute = (event: FormEvent<HTMLFormElement>) => setTotal(estimate(event.currentTarget, currency));
  const linesError = fields.lines;
  // the lines already on the form (an edited draft, a refused submission) count from the start, and again in a new currency
  useEffect(() => setTotal(estimate(formRef.current, currency)), [currency]);

  return (
    <Form ref={formRef} method="post" className="grid gap-5" onInput={recompute} onChange={recompute}>
      {formKey ? <input type="hidden" name="key" value={formKey} /> : null}
      {version !== undefined ? <input type="hidden" name="version" value={version} /> : null}
      <div className="adm-card grid gap-4 lg:grid-cols-2">
        <Select
          name="supplierId"
          label={t("common.supplier")}
          options={suppliers}
          defaultValue={values.supplierId}
          placeholder={t("orderForm.chooseSupplier")}
          required
          error={fields.supplierId}
          onChange={(event) => {
            const next = suppliers.find((option) => option.value === event.currentTarget.value);
            if (next) setCurrency(next.currency);
          }}
        />
        <Select name="locationId" label={t("orderForm.deliverTo")} options={locations} defaultValue={values.locationId} required error={fields.locationId} />
        <Select name="currency" label={t("supplier.currency")} options={CURRENCIES.map((code) => ({ value: code, label: code }))} value={currency} onChange={(event) => setCurrency(event.currentTarget.value)} required error={fields.currency} />
        {currency !== "IQD" ? (
          <TextField name="fxRate" label={t("orderForm.fxRate", { currency })} hint={t("orderForm.fxRateHint")} defaultValue={values.fxRate} inputMode="decimal" ltr required error={fields.fxRate} />
        ) : (
          <p className="type-caption self-center text-ink-2">{t("orderForm.iqdNoRate")}</p>
        )}
        <TextField name="expectedOn" type="date" label={t("orderForm.expectedOn")} hint={t("orderForm.expectedHint")} defaultValue={values.expectedOn} ltr optional error={fields.expectedOn} />
        <TextField name="paymentTerms" label={t("supplier.paymentTerms")} defaultValue={values.paymentTerms} optional maxLength={120} error={fields.paymentTerms} />
      </div>

      <div className="adm-card grid gap-3">
        <LineRows
          legend={t("orderForm.lines")}
          fields={[
            { name: "code", label: t("orderForm.code"), wide: true, ltr: true },
            { name: "qty", label: t("common.qty"), numeric: true },
            { name: "unitCost", label: t("orderForm.unitCost", { currency }), numeric: true },
          ]}
          initial={values.lines}
          errors={fields}
        />
        {linesError ? (
          <p role="alert" className="type-label text-red-ink">
            {linesError}
          </p>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField name="shipping" label={t("orderForm.shipping", { currency })} defaultValue={values.shipping} inputMode="decimal" ltr optional error={fields.shipping} />
          <TextField name="other" label={t("orderForm.other", { currency })} defaultValue={values.other} inputMode="decimal" ltr optional error={fields.other} />
        </div>
        <TextArea name="notes" label={t("orderForm.notes")} defaultValue={values.notes} optional maxLength={1000} rows={2} error={fields.notes} />
      </div>

      <div aria-live="polite" className="grid gap-2">
        {total && total.lines > 0 ? (
          <p className="type-body">
            {t("orderForm.estimate", { count: total.lines })} <Minor minor={total.totalMinor} currency={currency} />
            {currency !== "IQD" ? (
              <>
                {" ≈ "}
                <Money iqd={total.totalIqd} unknownLabel={t("order.noRate")} />
              </>
            ) : null}
          </p>
        ) : null}
        <Note icon="scales" tone={total?.totalIqd != null && needsApproval(total.totalIqd, limitIqd) ? "warn" : "info"}>
          <p className="type-body">{total?.totalIqd != null && needsApproval(total.totalIqd, limitIqd) ? t("orderForm.willNeedApproval", { limit: f.iqd(limitIqd) }) : t("orderForm.limitRule", { limit: f.iqd(limitIqd) })}</p>
        </Note>
      </div>
      <FormError result={failure && !failure.fields ? failure : null} />
      <div className="flex flex-wrap gap-2">
        <Key type="submit" variant="ink" icon="floppy-disk" loading={navigation.state === "submitting"}>
          {submitLabel}
        </Key>
      </div>
    </Form>
  );
}
