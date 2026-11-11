import { Link, redirect, useActionData } from "react-router";

import type { Route } from "./+types/order-edit";
import { throwAsResponse } from "~/server/errors";
import { getPurchaseOrder, savePurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { PO_SPENDING_LIMIT_IQD, baghdadDate, minorToText, rateToText } from "~/server/services/admin/purchasing/rules";
import { OrderForm } from "./components/OrderForm";
import { Code, PageHead, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { assertCostReader, orderChoices, orderInput } from "./order-form.server";
import { failed, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/orders/:poId/edit — a draft's header and lines (09.03). Only drafts are edited (an order waiting
 * for approval or approved is fixed — rejecting sends it back to draft); the save carries the version the form was
 * built on, so a change made meanwhile in another tab is refused rather than overwritten.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.create");
  assertCostReader(actor);
  try {
    const detail = await getPurchaseOrder(db, actor, params.poId, locale, now);
    if (!detail.can.edit) throw redirect(`/admin/purchasing/orders/${params.poId}`);
    const choices = await orderChoices(db, actor);
    const order = detail.order;
    // A supplier made inactive since keeps showing on its own draft, so the form says why it cannot be saved as is.
    const suppliers = choices.suppliers.some((option) => option.value === order.supplier.id) ? choices.suppliers : [{ value: order.supplier.id, label: `${order.supplier.name} · ${order.supplier.code}`, currency: order.currency, paymentTerms: null }, ...choices.suppliers];
    return {
      ref: order.ref,
      poId: order.id,
      version: order.updatedAt,
      suppliers,
      locations: choices.locations,
      values: {
        supplierId: order.supplier.id,
        locationId: order.location?.id ?? "",
        currency: order.currency,
        fxRate: order.currency === "IQD" ? "" : rateToText(order.fxRateMicros ?? null),
        expectedOn: order.expectedAt === null ? "" : baghdadDate(order.expectedAt),
        paymentTerms: order.paymentTerms ?? "",
        notes: order.notes ?? "",
        shipping: order.shippingMinor ? minorToText(order.shippingMinor, order.currency) : "",
        other: order.otherMinor ? minorToText(order.otherMinor, order.currency) : "",
        lines: detail.lines.map((line) => ({ code: line.variant.sku, qty: String(line.qtyOrdered), unitCost: minorToText(line.unitCostMinor ?? null, order.currency) })),
      },
      limitIqd: PO_SPENDING_LIMIT_IQD,
    };
  } catch (error) {
    if (error instanceof Response) throw error;
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.create");
  const form = await request.formData();
  try {
    await savePurchaseOrder(db, actor, { ...orderInput(form), poId: params.poId, version: text(form, "version") }, now, locale);
    throw redirect(`/admin/purchasing/orders/${params.poId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "orderForm.editTitle", { ref: args.loaderData?.ref ?? "" });

export default function EditOrder({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const result = useActionData<typeof action>();
  const failure = result && !result.ok ? result : null;
  return (
    <>
      <p className="mb-2">
        <Link to={`/admin/purchasing/orders/${loaderData.poId}`} className="adm-link type-label">
          {t("orderForm.backToOrder")}
        </Link>
      </p>
      <PageHead eyebrow={<Code>{loaderData.ref}</Code>} title={t("orderForm.editTitle", { ref: loaderData.ref })} lead={t("orderForm.editLead")} />
      <OrderForm suppliers={loaderData.suppliers} locations={loaderData.locations} values={loaderData.values} version={loaderData.version} failure={failure} limitIqd={loaderData.limitIqd} submitLabel={t("orderForm.saveChanges")} />
    </>
  );
}
