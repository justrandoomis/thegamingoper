import { Link, redirect, useActionData } from "react-router";

import type { Route } from "./+types/order-new";
import { savePurchaseOrder } from "~/server/services/admin/purchasing/orders.server";
import { getSetting } from "~/server/settings.server";
import { OrderForm } from "./components/OrderForm";
import { PageHead, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { assertCostReader, defaultLocation, defaultRateText, orderChoices, orderInput } from "./order-form.server";
import { failed, newKey, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/orders/new — a new purchase order, saved as a draft (09.03). `?supplier=<id>` preselects the
 * supplier (from its profile). Submitting it for approval happens on the order's page.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, now } = await openPurchasing(context, "purchasing.po.create");
  assertCostReader(actor);
  const choices = await orderChoices(db, actor);
  const wanted = new URL(request.url).searchParams.get("supplier");
  const supplier = choices.suppliers.find((option) => option.value === wanted) ?? null;
  const currency = supplier?.currency ?? "USD";
  return {
    ...choices,
    values: {
      supplierId: supplier?.value ?? "",
      locationId: defaultLocation(choices.locations),
      currency,
      fxRate: await defaultRateText(db, currency, now),
      expectedOn: "",
      paymentTerms: supplier?.paymentTerms ?? "",
      notes: "",
      shipping: "",
      other: "",
      lines: [],
    },
    key: newKey(),
    limitIqd: await getSetting(db, "purchasing.po_approval_limit_iqd"),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.create");
  const form = await request.formData();
  try {
    const { poId } = await savePurchaseOrder(db, actor, { ...orderInput(form), idempotencyKey: text(form, "key") }, now, locale);
    throw redirect(`/admin/purchasing/orders/${poId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "orderForm.newTitle");

export default function NewOrder({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const result = useActionData<typeof action>();
  const failure = result && !result.ok ? result : null;
  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/orders" className="adm-link type-label">
          {t("order.back")}
        </Link>
      </p>
      <PageHead title={t("orderForm.newTitle")} lead={t("orderForm.newLead")} />
      {loaderData.suppliers.length === 0 ? (
        <p className="adm-card type-body">{t("orderForm.noSuppliers")}</p>
      ) : (
        <OrderForm suppliers={loaderData.suppliers} locations={loaderData.locations} values={loaderData.values} formKey={loaderData.key} failure={failure} limitIqd={loaderData.limitIqd} submitLabel={t("orderForm.saveDraft")} />
      )}
    </>
  );
}
