import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/order-print";
import { Logo } from "~/art/Logo";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { purchaseOrderDocument } from "~/server/services/admin/purchasing/orders.server";
import { rateToText } from "~/server/services/admin/purchasing/rules";
import { Key } from "~/ui/Key";
import { Code, Minor, Money, Note, usePrintInLight, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { openPurchasing } from "./purchasing.server";

/**
 * /admin/purchasing/orders/:poId/print — the purchase order as a document for the supplier, printed (or saved as PDF)
 * by the browser — no printer integration. Prices, totals and the rate only for cost.read; for everyone else it is a
 * goods list (SKU, name, quantity), never a document with blanks where the prices were.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.po.read");
  try {
    return await purchaseOrderDocument(db, actor, params.poId, locale, now);
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "print.title", { ref: args.loaderData?.detail.order.ref ?? "" });

export default function OrderPrint({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const { detail, supplier, contact } = loaderData;
  const { order } = detail;
  const withCost = order.totalMinor !== undefined;
  const sheet = useRef<HTMLDivElement | null>(null);
  usePrintInLight(sheet);
  const unprinted = order.status === "draft" || order.status === "pending_approval" || order.status === "cancelled";

  return (
    <>
      <header className="adm-page-head pur-no-print">
        <p className="adm-eyebrow">
          <Link to={`/admin/purchasing/orders/${order.id}`} className="adm-link">
            {t("orderForm.backToOrder")}
          </Link>
        </p>
        <h1 className="adm-title">{t("print.title", { ref: order.ref })}</h1>
        <p className="type-body text-ink-2">{withCost ? t("print.lead") : t("print.leadNoCost")}</p>
        <div>
          <Key icon="printer" variant="ink" onClick={() => window.print()}>
            {t("print.print")}
          </Key>
        </div>
      </header>
      {unprinted ? (
        <Note tone="warn" icon="warning" className="mb-4 pur-no-print">
          {t("print.notApproved", { status: t(`poStatus.${order.status}`) })}
        </Note>
      ) : null}
      <div ref={sheet} className="pur-print">
        <article className="pur-doc" aria-label={t("print.title", { ref: order.ref })}>
          <div className="pur-doc__head">
            <div className="grid gap-1">
              <Logo className="h-9 w-auto" />
              <p className="type-caption text-ink-2">{t("print.store")}</p>
            </div>
            <div className="grid gap-1 text-end">
              <p className="type-sub">{withCost ? t("print.docTitle") : t("print.goodsTitle")}</p>
              <p className="type-strong">
                <Code>{order.ref}</Code>
              </p>
              <p className="type-caption text-ink-2">
                {t("print.date")} {f.date(order.approvedAt ?? order.createdAt, "medium")}
              </p>
              {unprinted ? <p className="type-label text-red-ink">{t(`poStatus.${order.status}`)}</p> : null}
            </div>
          </div>
          <div className="pur-doc__parties">
            <div className="grid gap-0.5">
              <p className="type-caption text-ink-2">{t("print.supplier")}</p>
              <p className="type-strong">{supplier?.legalName ?? supplier?.name ?? order.supplier.name}</p>
              {supplier?.address ? <p className="type-body">{supplier.address}</p> : null}
              {supplier?.country ? <p className="type-body">{supplier.country}</p> : null}
              {contact ? (
                <p className="type-body">
                  {contact.name}
                  {contact.phone ? (
                    <>
                      {" · "}
                      <Code>{contact.phone}</Code>
                    </>
                  ) : null}
                </p>
              ) : supplier?.phone ? (
                <p className="type-body">
                  <Code>{supplier.phone}</Code>
                </p>
              ) : null}
              {(contact?.email ?? supplier?.email) ? (
                <p className="type-body">
                  <Code>{contact?.email ?? supplier?.email}</Code>
                </p>
              ) : null}
            </div>
            <div className="grid gap-0.5">
              <p className="type-caption text-ink-2">{t("print.deliverTo")}</p>
              <p className="type-strong">{order.location ? `${order.location.name}` : "—"}</p>
              {order.location ? (
                <p className="type-body">
                  <Code>{order.location.code}</Code>
                </p>
              ) : null}
              <p className="type-body">
                {t("print.expected")} {order.expectedAt ? f.date(order.expectedAt, "medium") : "—"}
              </p>
            </div>
            <div className="grid gap-0.5">
              <p className="type-caption text-ink-2">{t("print.terms")}</p>
              <p className="type-body">{order.paymentTerms ?? supplier?.paymentTerms ?? "—"}</p>
              <p className="type-body">
                {t("supplier.currency")} <Code>{order.currency}</Code>
              </p>
              {withCost && order.currency !== "IQD" && order.fxRateMicros ? (
                <p className="type-caption text-ink-2">
                  <Code>{`1 ${order.currency} = ${rateToText(order.fxRateMicros)} IQD`}</Code>
                </p>
              ) : null}
            </div>
          </div>
          <div className="pur-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t("common.sku")}</th>
                  <th scope="col">{t("common.product")}</th>
                  <th scope="col" className="is-num">
                    {t("common.qty")}
                  </th>
                  {withCost ? (
                    <>
                      <th scope="col" className="is-num">
                        {t("order.unitCost", { currency: order.currency })}
                      </th>
                      <th scope="col" className="is-num">
                        {t("order.lineTotal", { currency: order.currency })}
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {detail.lines.map((line, index) => (
                  <tr key={line.id}>
                    <td className="nums">{f.number(index + 1)}</td>
                    <td>
                      <Code>{line.variant.sku}</Code>
                    </td>
                    <td>{line.variant.name}</td>
                    <td className="is-num">
                      <bdi>{f.number(line.qtyOrdered)}</bdi>
                    </td>
                    {withCost ? (
                      <>
                        <td className="is-num">
                          <Minor minor={line.unitCostMinor} currency={order.currency} />
                        </td>
                        <td className="is-num">
                          <Minor minor={line.lineTotalMinor} currency={order.currency} />
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {withCost ? (
            <dl className="grid justify-end gap-1">
              {[
                ["order.subtotal", order.subtotalMinor],
                ...(order.shippingMinor ? [["print.shipping", order.shippingMinor] as const] : []),
                ...(order.otherMinor ? [["print.other", order.otherMinor] as const] : []),
                ["order.total", order.totalMinor],
              ].map(([key, value]) => (
                <div key={String(key)} className="flex justify-between gap-8">
                  <dt className="type-label">{t(String(key))}</dt>
                  <dd className="type-strong">
                    <Minor minor={Number(value)} currency={order.currency} />
                  </dd>
                </div>
              ))}
              {order.currency !== "IQD" ? (
                <div className="flex justify-between gap-8">
                  <dt className="type-caption text-ink-2">{t("order.totalIqd")}</dt>
                  <dd className="type-caption">
                    <Money iqd={order.totalIqd} />
                  </dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          {order.notes ? (
            <p className="type-body">
              {t("orderForm.notes")}: {order.notes}
            </p>
          ) : null}
          <div className="pur-doc__sign">
            <div>
              <p className="type-caption text-ink-2">{t("print.approvedBy")}</p>
              <p className="type-body">{order.approvedBy ?? "—"}</p>
            </div>
            <div>
              <p className="type-caption text-ink-2">{t("print.supplierSignature")}</p>
            </div>
          </div>
        </article>
      </div>
    </>
  );
}
