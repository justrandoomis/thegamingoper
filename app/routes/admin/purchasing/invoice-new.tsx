import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/invoice-new";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { invoiceFormFor, recordInvoice } from "~/server/services/admin/purchasing/invoices.server";
import { baghdadDate, minorToText, rateToText } from "~/server/services/admin/purchasing/rules";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Code, FormError, Minor, Note, Num, PageHead, Pair, Section, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { assertCostReader } from "./order-form.server";
import { failed, keyed, newKey, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/orders/:poId/invoice — record the supplier's invoice against its order (09.04): number, dates, rate,
 * and per order line the units billed and the unit cost billed (prefilled with what was received and not billed yet,
 * at the order's price). It is matched with the order and the receipts as soon as it is saved (09.07).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.invoice.manage");
  assertCostReader(actor);
  try {
    return { form: await invoiceFormFor(db, actor, params.poId, locale), today: baghdadDate(now), key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.invoice.manage");
  const form = await request.formData();
  try {
    const { invoiceId } = await recordInvoice(
      db,
      actor,
      {
        poId: params.poId,
        invoiceNo: text(form, "invoiceNo"),
        issuedOn: text(form, "issuedOn"),
        dueOn: text(form, "dueOn"),
        fxRate: text(form, "fxRate"),
        shipping: text(form, "shipping"),
        other: text(form, "other"),
        lines: keyed(form, "line", ["qty", "unitCost"] as const).map((line) => ({ poItemId: line.id, qty: line.qty, unitCost: line.unitCost })),
        idempotencyKey: text(form, "key"),
      },
      now,
    );
    throw redirect(`/admin/purchasing/invoices/${invoiceId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "record");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "invoiceForm.title", { ref: args.loaderData?.form.order.ref ?? "" });

export default function NewInvoice({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { form, today, key } = loaderData;
  const { order } = form;
  const failure = result && !result.ok ? result : null;
  const fields = failure?.fields ?? {};

  return (
    <>
      <p className="mb-2">
        <Link to={`/admin/purchasing/orders/${order.id}`} className="adm-link type-label">
          {t("orderForm.backToOrder")}
        </Link>
      </p>
      <PageHead eyebrow={<bdi>{form.supplier.name}</bdi>} title={t("invoiceForm.title", { ref: order.ref })} lead={t("invoiceForm.lead")} />
      {!form.open ? (
        <Note tone="warn" icon="warning">
          {t("invoiceForm.notOpen", { status: t(`poStatus.${order.status}`) })}
        </Note>
      ) : (
        <Form method="post" className="grid gap-5">
          <input type="hidden" name="key" value={key} />
          <Section id="header" title={t("invoiceForm.header")}>
            <div className="adm-card grid gap-4 lg:grid-cols-3">
              <TextField name="invoiceNo" label={t("invoice.number")} required ltr maxLength={60} autoComplete="off" error={fields.invoiceNo} />
              <TextField name="issuedOn" type="date" label={t("invoice.issuedOn")} defaultValue={today} max={today} ltr error={fields.issuedOn} />
              <TextField name="dueOn" type="date" label={t("invoice.dueOn")} ltr optional error={fields.dueOn} />
              {order.currency !== "IQD" ? <TextField name="fxRate" label={t("orderForm.fxRate", { currency: order.currency })} hint={t("invoiceForm.rateHint")} defaultValue={rateToText(order.fxRateMicros)} inputMode="decimal" ltr error={fields.fxRate} /> : null}
              <TextField name="shipping" label={t("orderForm.shipping", { currency: order.currency })} defaultValue={order.shippingMinor ? minorToText(order.shippingMinor, order.currency) : ""} inputMode="decimal" ltr optional error={fields.shipping} />
              <TextField name="other" label={t("orderForm.other", { currency: order.currency })} defaultValue={order.otherMinor ? minorToText(order.otherMinor, order.currency) : ""} inputMode="decimal" ltr optional error={fields.other} />
            </div>
          </Section>
          <Section id="lines" title={t("invoiceForm.lines")}>
            <p className="type-caption text-ink-2">{t("invoiceForm.linesLead")}</p>
            <ol className="grid gap-3">
              {form.lines.map((line) => (
                <li key={line.poItemId} className="adm-card grid gap-3">
                  <div>
                    <p className="type-strong">{line.variant.name}</p>
                    <p className="type-caption text-ink-2">
                      <Code>{line.variant.sku}</Code>
                    </p>
                  </div>
                  <div className="grid gap-1 sm:max-w-md">
                    <Pair label={t("order.ordered")}>
                      <Num value={line.qtyOrdered} />
                    </Pair>
                    <Pair label={t("order.received")}>
                      <Num value={line.qtyReceived} />
                    </Pair>
                    <Pair label={t("invoiceForm.billedBefore")}>
                      <Num value={line.invoiced} />
                    </Pair>
                    <Pair label={t("order.unitCost", { currency: order.currency })}>
                      <Minor minor={line.unitCostMinor} currency={order.currency} />
                    </Pair>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <TextField name={`line:${line.poItemId}:qty`} label={t("invoiceForm.qtyBilled")} defaultValue={line.suggestedQty > 0 ? String(line.suggestedQty) : ""} inputMode="numeric" ltr error={fields[`lines.${line.poItemId}.qty`]} />
                    <TextField name={`line:${line.poItemId}:unitCost`} label={t("invoiceForm.unitCostBilled", { currency: order.currency })} defaultValue={minorToText(line.unitCostMinor, order.currency)} inputMode="decimal" ltr error={fields[`lines.${line.poItemId}.unitCost`]} />
                  </div>
                </li>
              ))}
            </ol>
          </Section>
          <FormError result={failure && (!failure.fields || failure.fields.lines) ? { ...failure, message: failure.message ?? failure.fields?.lines } : null} />
          <p className="type-caption text-ink-2">{t("invoiceForm.orderTotal")} <Minor minor={order.totalMinor} currency={order.currency} /> · {f.number(form.lines.length)} {t("invoiceForm.linesWord")}</p>
          <div>
            <Key type="submit" variant="ink" icon="file-text" loading={navigation.state === "submitting"}>
              {t("invoiceForm.save")}
            </Key>
          </div>
        </Form>
      )}
    </>
  );
}
