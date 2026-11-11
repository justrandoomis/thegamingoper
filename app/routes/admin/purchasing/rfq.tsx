import { useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/rfq";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { awardQuote, cancelRfq, getRfq, markRfqSent, recordQuote } from "~/server/services/admin/purchasing/rfqs.server";
import { COST_CURRENCIES } from "~/server/services/admin/purchasing/rules";
import { supplierOptions } from "~/server/services/admin/purchasing/suppliers.server";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Facts, FormError, History, Minor, Money, Note, Num, PageHead, Pair, Percent, Section, StateTag, When, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { defaultLocation, orderChoices } from "./order-form.server";
import { failed, keyed, newKey, ok, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/rfqs/:rfqId — one request for quotation (09.02): the SKUs asked, every supplier's quote side by side
 * (total in its currency and in IQD at the store's rate, coverage, lead time, warranty, validity; the cheapest complete
 * quote, the fastest and the longest warranty marked), per-SKU unit prices, recording a quote, and the award that
 * turns the chosen quote into a draft purchase order. Prices only with cost.read.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.rfq.manage");
  try {
    const detail = await getRfq(db, actor, params.rfqId, locale, now);
    const [suppliers, choices] = await Promise.all([detail.can.quote ? supplierOptions(db, actor).catch(() => []) : Promise.resolve([]), detail.can.award ? orderChoices(db, actor) : Promise.resolve(null)]);
    return { detail, suppliers: suppliers.map((option) => ({ value: option.value, label: option.label, currency: option.currency })), locations: choices?.locations ?? [], defaultLocation: choices ? defaultLocation(choices.locations) : "", key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.rfq.manage");
  const rfqId = params.rfqId;
  try {
    switch (intent) {
      case "send":
        await markRfqSent(db, actor, { rfqId }, now);
        return ok({ intent });
      case "cancel":
        await cancelRfq(db, actor, { rfqId, reason: text(form, "reason") }, now);
        return ok({ intent });
      case "quote": {
        const lines = keyed(form, "line", ["unitCost", "qtyAvailable"] as const).map((line) => ({ rfqItemId: line.id, unitCost: line.unitCost, qtyAvailable: line.qtyAvailable }));
        const result = await recordQuote(db, actor, { rfqId, supplierId: text(form, "supplierId"), currency: text(form, "currency"), leadTimeDays: text(form, "leadTimeDays"), warrantyMonths: text(form, "warrantyMonths"), validUntil: text(form, "validUntil"), notes: text(form, "notes"), lines }, now);
        return ok({ intent, replaced: result.replaced });
      }
      case "award": {
        const { poId } = await awardQuote(db, actor, { rfqId, quoteId: text(form, "quoteId"), locationId: text(form, "locationId"), fxRate: text(form, "fxRate"), expectedOn: text(form, "expectedOn"), idempotencyKey: text(form, "key") }, now);
        throw redirect(`/admin/purchasing/orders/${poId}`);
      }
      default:
        return failed(new AppError("invalid", 400), locale, intent);
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "rfq.title", { ref: args.loaderData?.detail.rfq.ref ?? "" });

type Quote = Route.ComponentProps["loaderData"]["detail"]["quotes"][number];

export default function RfqPage({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { detail, suppliers, locations, key } = loaderData;
  const { rfq, items, quotes, can } = detail;
  const [dialog, setDialog] = useState<null | "send" | "cancel" | { kind: "award"; quote: Quote }>(null);
  const [currency, setCurrency] = useState(suppliers[0]?.currency ?? "USD");
  const award = useRef<{ locationId: string; fxRate: string; expectedOn: string }>({ locationId: loaderData.defaultLocation, fxRate: "", expectedOn: "" });
  const failure = result && !result.ok ? result : null;
  const fields = failure && failure.intent === "quote" ? (failure.fields ?? {}) : {};
  const withCost = quotes.some((quote) => quote.totalMinor !== undefined) || can.quote;

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/rfqs" className="adm-link type-label">
          {t("rfq.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={<Code>{rfq.ref}</Code>}
        title={rfq.title}
        actions={
          <>
            <StateTag group="rfq" value={rfq.status} label={t(`rfqStatus.${rfq.status}`)} />
            {can.send ? (
              <Key size="sm" icon="paper-plane-tilt" onClick={() => setDialog("send")}>
                {t("rfq.markSent")}
              </Key>
            ) : null}
            {can.cancel ? (
              <Key size="sm" icon="x-circle" className="[--on:var(--red-ink)]" onClick={() => setDialog("cancel")}>
                {t("rfq.cancel")}
              </Key>
            ) : null}
          </>
        }
      />
      {rfq.poId ? (
        <Note icon="check-circle" className="mb-4">
          {t("rfq.awardedNote")} <Link to={`/admin/purchasing/orders/${rfq.poId}`} className="adm-link">{t("rfq.openOrder")}</Link>
        </Note>
      ) : null}
      {failure && failure.intent !== "quote" ? <FormError result={failure} /> : null}

      <Section id="facts" title={t("rfq.details")}>
        <Facts
          items={[
            { label: t("rfqs.neededBy"), value: <When at={rfq.neededBy} kind="date" /> },
            { label: t("common.created"), value: <span>{rfq.createdBy ?? "—"} · <When at={rfq.createdAt} /></span> },
            { label: t("rfqs.quotesCount"), value: f.number(quotes.length) },
            ...(rfq.notes ? [{ label: t("rfqs.notes"), value: rfq.notes, wide: true }] : []),
          ]}
        />
      </Section>

      <Section id="compare" title={t("rfq.compare")}>
        {quotes.length === 0 ? (
          <p className="type-body text-ink-2">{t("rfq.noQuotes")}</p>
        ) : (
          <>
            <ul role="list" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {quotes.map((quote) => (
                <li key={quote.id} className="adm-card gap-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="type-strong">
                      <bdi>{quote.supplier.name}</bdi>
                    </p>
                    <StateTag group="quote" value={quote.expired ? "expired" : quote.status} label={t(`quoteStatus.${quote.expired ? "expired" : quote.status}`)} />
                  </div>
                  {quote.best ? (
                    <p className="type-caption">
                      {[quote.best.price ? t("rfq.bestPrice") : null, quote.best.lead ? t("rfq.bestLead") : null, quote.best.warranty ? t("rfq.bestWarranty") : null].filter(Boolean).join(" · ")}
                    </p>
                  ) : null}
                  {quote.totalMinor !== undefined ? (
                    <Pair label={t("rfq.total")}>
                      <span className={quote.best?.price ? "pur-best" : undefined}>
                        <Minor minor={quote.totalMinor} currency={quote.currency} />
                        {quote.currency !== "IQD" ? (
                          <>
                            {" ≈ "}
                            <Money iqd={quote.totalIqd} unknownLabel={t("rfq.noRate")} />
                          </>
                        ) : null}
                      </span>
                    </Pair>
                  ) : null}
                  <Pair label={t("rfq.coverage")}>
                    {quote.coverage.complete ? t("rfq.complete") : <span><Percent value={quote.coverage.units} /> {t("rfq.ofUnits")}</span>}
                  </Pair>
                  <Pair label={t("rfq.lead")}>{quote.lead === null ? "—" : <span className={quote.best?.lead ? "pur-best" : undefined}>{t("rating.days", { count: quote.lead })}</span>}</Pair>
                  <Pair label={t("rfq.warranty")}>{quote.warranty === null ? "—" : <span className={quote.best?.warranty ? "pur-best" : undefined}>{t("rfq.months", { count: quote.warranty })}</span>}</Pair>
                  <Pair label={t("rfq.validUntil")}>
                    <When at={quote.validUntil} kind="date" />
                  </Pair>
                  {quote.notes ? <p className="type-caption text-ink-2">{quote.notes}</p> : null}
                  {can.award && quote.status === "received" && !quote.expired ? (
                    <div className="pt-1">
                      <Key size="sm" icon="seal-check" onClick={() => setDialog({ kind: "award", quote })}>
                        {t("rfq.award")}
                      </Key>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
            {withCost ? (
              <div className="pur-scroll" role="region" aria-label={t("rfq.matrix")} tabIndex={0}>
                <table className="table">
                  <caption className="sr-only">{t("rfq.matrix")}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t("common.sku")}</th>
                      <th scope="col" className="is-num">
                        {t("common.qty")}
                      </th>
                      {quotes.map((quote) => (
                        <th key={quote.id} scope="col" className="is-num">
                          {quote.supplier.code}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.id}>
                        <th scope="row" className="font-normal">
                          <Code>{item.variant.sku}</Code>
                          <span className="block type-caption text-ink-2">{item.variant.name}</span>
                        </th>
                        <td className="is-num">
                          <bdi>{f.number(item.qty)}</bdi>
                        </td>
                        {quotes.map((quote) => {
                          const line = quote.lines.find((candidate) => candidate.rfqItemId === item.id);
                          return (
                            <td key={quote.id} className="is-num">
                              {line?.unitCostMinor !== undefined ? <Minor minor={line.unitCostMinor} currency={quote.currency} /> : <span className="text-ink-2">{t("rfq.notQuoted")}</span>}
                              {line?.qtyAvailable !== null && line?.qtyAvailable !== undefined && line.qtyAvailable < item.qty ? <span className="block type-caption text-red-ink">{t("rfq.only", { count: line.qtyAvailable })}</span> : null}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        )}
      </Section>

      <Section id="items" title={t("rfq.items", { count: items.length })}>
        <ul role="list" className="grid gap-2 sm:grid-cols-2">
          {items.map((item) => (
            <li key={item.id} className="adm-card gap-0.5">
              <p className="type-strong">{item.variant.name}</p>
              <Pair label={t("common.sku")}>
                <Code>{item.variant.sku}</Code>
              </Pair>
              <Pair label={t("common.qty")}>
                <Num value={item.qty} />
              </Pair>
            </li>
          ))}
        </ul>
      </Section>

      {can.quote ? (
        <Section id="quote" title={t("rfq.recordQuote")}>
          <p className="type-caption text-ink-2">{t("rfq.recordLead")}</p>
          {suppliers.length === 0 ? (
            <Note icon="info">{t("orderForm.noSuppliers")}</Note>
          ) : (
            <Form method="post" className="adm-card grid gap-4" key={key}>
              <input type="hidden" name="intent" value="quote" />
              <div className="grid gap-4 lg:grid-cols-3">
                <Select name="supplierId" label={t("common.supplier")} options={suppliers} required error={fields.supplierId} onChange={(event) => setCurrency(suppliers.find((option) => option.value === event.currentTarget.value)?.currency ?? currency)} />
                <Select name="currency" label={t("supplier.currency")} options={Object.keys(COST_CURRENCIES).map((code) => ({ value: code, label: code }))} value={currency} onChange={(event) => setCurrency(event.currentTarget.value)} error={fields.currency} />
                <TextField name="validUntil" type="date" label={t("rfq.validUntil")} ltr optional error={fields.validUntil} />
                <TextField name="leadTimeDays" label={t("rfq.leadDays")} inputMode="numeric" ltr optional error={fields.leadTimeDays} />
                <TextField name="warrantyMonths" label={t("rfq.warrantyMonths")} inputMode="numeric" ltr optional error={fields.warrantyMonths} />
                <TextField name="notes" label={t("rfqs.notes")} optional maxLength={1000} error={fields.notes} />
              </div>
              <ol className="grid gap-2">
                {items.map((item) => (
                  <li key={item.id} className="pur-line grid gap-2 rounded-xs p-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] sm:items-end">
                    <p className="type-body">
                      <Code>{item.variant.sku}</Code> · <Num value={item.qty} />
                      <span className="block type-caption text-ink-2">{item.variant.name}</span>
                    </p>
                    <TextField name={`line:${item.id}:unitCost`} label={t("rfq.unitPrice", { currency })} inputMode="decimal" ltr optional error={fields[`lines.${item.id}.unitCost`]} />
                    <TextField name={`line:${item.id}:qtyAvailable`} label={t("rfq.qtyAvailable")} inputMode="numeric" ltr optional error={fields[`lines.${item.id}.qtyAvailable`]} />
                  </li>
                ))}
              </ol>
              {failure && failure.intent === "quote" && (!failure.fields || failure.fields.lines) ? <FormError result={{ ...failure, message: failure.message ?? failure.fields?.lines }} /> : null}
              {result && result.ok && result.intent === "quote" ? (
                <p role="status" className="type-label text-ok">
                  {t("rfq.quoteSaved")}
                </p>
              ) : null}
              <div>
                <Key type="submit" variant="ink" icon="floppy-disk" loading={navigation.state === "submitting"}>
                  {t("rfq.saveQuote")}
                </Key>
              </div>
            </Form>
          )}
        </Section>
      ) : null}

      <Section id="history" title={t("common.history")}>
        <History entries={detail.history} />
      </Section>

      <ActionDialog open={dialog === "send"} onClose={() => setDialog(null)} title={t("rfq.sendTitle")} consequence={t("rfq.sendConsequence")} confirmLabel={t("rfq.markSent")} fields={{ intent: "send" }} successMessage={t("rfq.sent")} />
      <ActionDialog open={dialog === "cancel"} onClose={() => setDialog(null)} title={t("rfq.cancelTitle")} consequence={t("rfq.cancelConsequence")} confirmLabel={t("rfq.cancel")} tone="destructive" reason fields={{ intent: "cancel" }} successMessage={t("rfq.cancelled")} />
      <ActionDialog
        open={typeof dialog === "object" && dialog !== null}
        onClose={() => setDialog(null)}
        title={t("rfq.awardTitle")}
        consequence={typeof dialog === "object" && dialog ? t("rfq.awardConsequence", { supplier: dialog.quote.supplier.name }) : ""}
        confirmLabel={t("rfq.award")}
        impact={
          typeof dialog === "object" && dialog
            ? [
                ...(dialog.quote.totalMinor !== undefined ? [{ label: t("rfq.total"), value: <Minor minor={dialog.quote.totalMinor} currency={dialog.quote.currency} /> }] : []),
                { label: t("rfq.coverage"), value: dialog.quote.coverage.complete ? t("rfq.complete") : t("rfq.partial") },
                { label: t("rfq.others"), value: t("rfq.othersDeclined", { count: Math.max(0, quotes.filter((quote) => quote.status === "received").length - 1) }) },
              ]
            : undefined
        }
        fields={{ intent: "award", quoteId: typeof dialog === "object" && dialog ? dialog.quote.id : "", key }}
        extra={() => ({ locationId: award.current.locationId, fxRate: award.current.fxRate, expectedOn: award.current.expectedOn })}
      >
        <div className="grid gap-3">
          <Select label={t("orderForm.deliverTo")} options={locations} defaultValue={loaderData.defaultLocation} onChange={(event) => (award.current.locationId = event.currentTarget.value)} />
          {typeof dialog === "object" && dialog && dialog.quote.currency !== "IQD" ? <TextField label={t("orderForm.fxRate", { currency: dialog.quote.currency })} hint={t("rfq.rateHint")} inputMode="decimal" ltr optional onChange={(event) => (award.current.fxRate = event.currentTarget.value)} /> : null}
          <TextField type="date" label={t("orderForm.expectedOn")} hint={t("rfq.expectedHint")} ltr optional onChange={(event) => (award.current.expectedOn = event.currentTarget.value)} />
        </div>
      </ActionDialog>
    </>
  );
}
