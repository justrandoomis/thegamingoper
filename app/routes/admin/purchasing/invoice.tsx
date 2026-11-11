import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/invoice";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { approveInvoice, getInvoice, rematchInvoice, voidInvoice } from "~/server/services/admin/purchasing/invoices.server";
import { decimalsOf, rateToText } from "~/server/services/admin/purchasing/rules";
import { BidiText } from "~/ui/BidiText";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Day, Facts, FormError, History, Kpi, Minor, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { assertCostReader } from "./order-form.server";
import { failed, ok, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/invoices/:invoiceId — one supplier invoice and its three-way match (09.04, 09.07): per line what was
 * ordered, received (accepted into stock), billed before and billed here, the order's and the invoice's unit cost, and
 * every variance in words. Approving a matched invoice is one step; approving one with variances accepts them — a
 * reason and a second person (not the one who recorded it). Re-run the match after goods arrive; void with a reason.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPurchasing(context, "purchasing.invoice.manage");
  assertCostReader(actor);
  try {
    return { detail: await getInvoice(db, actor, params.invoiceId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.invoice.manage");
  const invoiceId = params.invoiceId;
  try {
    switch (intent) {
      case "approve": {
        const result = await approveInvoice(db, actor, { invoiceId, reason: text(form, "reason") || undefined }, now);
        return ok({ intent, variances: result.variances });
      }
      case "rematch": {
        const result = await rematchInvoice(db, actor, { invoiceId }, now);
        return ok({ intent, status: result.status, variances: result.variances });
      }
      case "void":
        await voidInvoice(db, actor, { invoiceId, reason: text(form, "reason") }, now);
        return ok({ intent });
      default:
        return failed(new AppError("invalid", 400), locale, intent);
    }
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "invoice.title", { number: args.loaderData?.detail.invoice.invoiceNo ?? "" });

type Line = Route.ComponentProps["loaderData"]["detail"]["lines"][number];

export default function InvoicePage({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const { detail } = loaderData;
  const { invoice, lines, discrepancies, can } = detail;
  const [dialog, setDialog] = useState<null | "approve" | "void">(null);
  const rematch = useFetcher<typeof action>();
  const variance = discrepancies.length > 0;
  const label = (variantId: string) => lines.find((line) => line.variant.id === variantId)?.variant.sku ?? variantId;
  /** An amount in the invoice's currency as text (for a sentence); "—" when unknown. */
  const minorText = (minor: number | null, currency: string) => {
    if (minor === null || !Number.isFinite(minor)) return "—";
    if (currency === "IQD") return f.iqd(minor);
    const decimals = decimalsOf(currency);
    return `${f.number(minor / 10 ** decimals, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${currency}`;
  };

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/invoices" className="adm-link type-label">
          {t("invoice.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            <bdi>{invoice.supplier.name}</bdi>
            {invoice.po ? (
              <>
                {" · "}
                <RowLink to={`/admin/purchasing/orders/${invoice.po.id}`}>
                  <Code>{invoice.po.ref}</Code>
                </RowLink>
              </>
            ) : null}
          </>
        }
        title={t("invoice.title", { number: invoice.invoiceNo })}
        actions={<StateTag group="invoice" value={invoice.status} label={t(`invoiceStatus.${invoice.status}`)} />}
      />

      <div className="pur-kpis mb-5">
        <Kpi wide label={t("order.totalIqd")} value={<Money iqd={invoice.totalIqd} />} hint={invoice.currency !== "IQD" ? <Minor minor={invoice.totalMinor} currency={invoice.currency} /> : undefined} />
        {invoice.po ? <Kpi wide label={t("invoice.orderTotal")} value={<Money iqd={invoice.po.totalIqd} />} hint={invoice.po.currency !== "IQD" ? <Minor minor={invoice.po.totalMinor} currency={invoice.po.currency} /> : undefined} /> : null}
        <Kpi label={t("invoice.variances")} value={f.number(discrepancies.length)} />
      </div>

      {variance ? (
        <Note tone="bad" icon="warning" className="mb-4">
          <p className="type-strong">{t("invoice.varianceTitle", { count: discrepancies.length })}</p>
          <ul className="grid gap-1">
            {discrepancies.map((item, index) => (
              <li key={index} className="type-body">
                {item.field === "charges" ? (
                  <BidiText text={t("invoice.varianceCharges", { billed: minorText(item.invoiced, invoice.currency), ordered: minorText(item.po, invoice.currency) })} />
                ) : item.field === "qty" ? (
                  item.po === null ? (
                    t("invoice.varianceNotOrdered", { sku: label(item.variantId), invoiced: f.number(item.invoiced ?? 0) })
                  ) : (
                    t("invoice.varianceQty", { sku: label(item.variantId), invoiced: f.number(item.invoiced ?? 0), received: f.number(item.received ?? 0), ordered: f.number(item.po) })
                  )
                ) : (
                  t("invoice.variancePrice", { sku: label(item.variantId) })
                )}
              </li>
            ))}
          </ul>
        </Note>
      ) : invoice.status === "matched" || invoice.status === "approved" ? (
        <Note icon="check-circle" className="mb-4">
          {t("invoice.matchedNote")}
        </Note>
      ) : null}

      <Section id="match" title={t("invoice.matchTitle")}>
        <ResponsiveList
          caption={t("invoice.matchTitle")}
          rows={lines}
          rowKey={(line) => line.poItemId ?? line.variant.id}
          columns={[
            { key: "sku", header: t("common.sku"), cell: (line: Line) => <Code>{line.variant.sku}</Code> },
            { key: "name", header: t("common.product"), cell: (line: Line) => <span className="line-clamp-2 min-w-[10rem]">{line.variant.name}</span> },
            { key: "ordered", header: t("order.ordered"), numeric: true, cell: (line: Line) => <Num value={line.qtyOrdered} /> },
            { key: "received", header: t("order.received"), numeric: true, cell: (line: Line) => <Num value={line.qtyReceived} /> },
            { key: "before", header: t("invoiceForm.billedBefore"), numeric: true, cell: (line: Line) => <Num value={line.invoicedElsewhere} /> },
            { key: "billed", header: t("invoice.billed"), numeric: true, negative: (line: Line) => line.qtyVariance, cell: (line: Line) => <span className={line.qtyVariance ? "text-red-ink" : undefined}><Num value={line.qtyInvoiced} /></span> },
            { key: "poCost", header: t("invoice.poUnit", { currency: invoice.currency }), numeric: true, cell: (line: Line) => <Minor minor={line.poUnitCostMinor} currency={invoice.currency} /> },
            { key: "invCost", header: t("invoice.invoiceUnit", { currency: invoice.currency }), numeric: true, negative: (line: Line) => line.priceVariance, cell: (line: Line) => <span className={line.priceVariance ? "text-red-ink" : undefined}><Minor minor={line.invoiceUnitCostMinor} currency={invoice.currency} /></span> },
          ]}
          card={(line) => (
            <>
              <p className="type-strong">{line.variant.name}</p>
              <p className="type-caption text-ink-2">
                <Code>{line.variant.sku}</Code>
              </p>
              <Pair label={t("invoice.billedOfReceived")}>
                <span className={line.qtyVariance ? "text-red-ink" : undefined}>
                  <Num value={line.qtyInvoiced + line.invoicedElsewhere} /> / <Num value={line.qtyReceived} />
                </span>
              </Pair>
              <Pair label={t("invoice.invoiceUnit", { currency: invoice.currency })}>
                <span className={line.priceVariance ? "text-red-ink" : undefined}>
                  <Minor minor={line.invoiceUnitCostMinor} currency={invoice.currency} />
                </span>
              </Pair>
              <Pair label={t("invoice.poUnit", { currency: invoice.currency })}>
                <Minor minor={line.poUnitCostMinor} currency={invoice.currency} />
              </Pair>
            </>
          )}
        />
      </Section>

      <Section id="details" title={t("invoice.details")}>
        <Facts
          items={[
            { label: t("invoice.issuedOn"), value: <Day value={invoice.issuedOn} /> },
            { label: t("invoice.dueOn"), value: <Day value={invoice.dueOn} /> },
            { label: t("order.fxRate"), value: invoice.currency === "IQD" ? "—" : <Code>{`1 ${invoice.currency} = ${rateToText(invoice.fxRateMicros)} IQD`}</Code> },
            { label: t("order.subtotal"), value: <Minor minor={invoice.subtotalMinor} currency={invoice.currency} /> },
            { label: t("invoice.charges"), value: <Minor minor={invoice.shippingMinor + invoice.otherMinor} currency={invoice.currency} /> },
            ...(invoice.po ? [{ label: t("invoice.orderCharges"), value: <Minor minor={invoice.po.shippingMinor + invoice.po.otherMinor} currency={invoice.po.currency} /> }] : []),
            { label: t("invoice.recordedBy"), value: invoice.createdBy ?? "—" },
          ]}
        />
      </Section>

      {can.approve || can.rematch || can.void ? (
        <Section id="next" title={t("invoice.next")}>
          <div className="flex flex-wrap gap-2">
            {can.approve ? (
              <Key variant="commit" icon="seal-check" onClick={() => setDialog("approve")}>
                {variance ? t("invoice.acceptVariances") : t("invoice.approve")}
              </Key>
            ) : null}
            {can.rematch ? (
              <Key icon="arrows-clockwise" loading={rematch.state !== "idle"} onClick={() => rematch.submit({ intent: "rematch" }, { method: "post" })}>
                {t("invoice.rematch")}
              </Key>
            ) : null}
            {can.void ? (
              <Key icon="x-circle" className="[--on:var(--red-ink)]" onClick={() => setDialog("void")}>
                {t("invoice.void")}
              </Key>
            ) : null}
          </div>
          {can.approveNeedsSecondPerson ? <p className="type-caption text-ink-2">{t("invoice.secondPerson")}</p> : null}
          {rematch.data && rematch.state === "idle" ? (rematch.data.ok ? <p role="status" className="type-label text-ok">{t("invoice.rematched")}</p> : <FormError result={rematch.data} />) : null}
        </Section>
      ) : null}

      <Section id="history" title={t("common.history")}>
        <History entries={detail.history} />
      </Section>

      <ActionDialog
        open={dialog === "approve"}
        onClose={() => setDialog(null)}
        title={variance ? t("invoice.acceptTitle") : t("invoice.approveTitle")}
        consequence={variance ? t("invoice.acceptConsequence", { count: discrepancies.length }) : t("invoice.approveConsequence")}
        confirmLabel={variance ? t("invoice.acceptVariances") : t("invoice.approve")}
        tone="commit"
        reason={variance ? { hint: t("invoice.acceptHint") } : undefined}
        impact={[
          { label: t("order.total"), value: <Minor minor={invoice.totalMinor} currency={invoice.currency} /> },
          { label: t("order.totalIqd"), value: <Money iqd={invoice.totalIqd} /> },
          { label: t("invoice.variances"), value: f.number(discrepancies.length) },
        ]}
        fields={{ intent: "approve" }}
        successMessage={t("invoice.approved")}
      />
      <ActionDialog open={dialog === "void"} onClose={() => setDialog(null)} title={t("invoice.voidTitle")} consequence={t("invoice.voidConsequence")} confirmLabel={t("invoice.void")} tone="destructive" reason fields={{ intent: "void" }} successMessage={t("invoice.voided")} />
    </>
  );
}
