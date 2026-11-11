import { Link } from "react-router";

import type { Route } from "./+types/print";
import { Logo } from "~/art/Logo";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { getReturnDetail } from "~/server/services/admin/returns/rma.server";
import { Key } from "~/ui/Key";
import { code128Modules } from "../orders/code128";
import { returnsMeta } from "./meta";
import { openReturns, urls } from "./returns.server";
import { PhoneText, Ref, useReturnsT, When } from "./ui";

/**
 * /admin/returns/:rma/print — the return slip (12.01): the RMA reference as a Code 128 barcode a keyboard-wedge scanner
 * reads back, the order, the customer, the units with their serials, the reason, and the inspection result once there
 * is one, with two signature lines. The browser prints it (print CSS drops the admin's chrome); the slip is always ink
 * on paper (data-theme="light"), also from a dark screen. Nothing on it is cost data.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.rma.read", "returns.rma.create"]);
  try {
    return { rma: await getReturnDetail(db, actor, params.rma, locale, now, { photo: urls.file }) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "print.title", { rma: args.loaderData?.rma.rma ?? "" });

export default function ReturnSlip({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const f = useFormat();
  const { rma } = loaderData;
  return (
    <>
      <div className="ret-noprint ret-actions mb-4">
        <h1 className="adm-title sr-only">{t("print.title", { rma: rma.rma })}</h1>
        <Key icon="printer" variant="ink" onClick={() => window.print()}>
          {t("print.printNow")}
        </Key>
        <Key as={Link} to={`/admin/returns/${rma.rma}`} icon="arrow-left">
          {t("print.back")}
        </Key>
      </div>
      <article className="ret-doc" data-theme="light" aria-label={t("print.title", { rma: rma.rma })}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-1">
            <Logo className="h-8 w-auto text-logo" />
            <p className="type-sub">{t("print.slip")}</p>
          </div>
          <div className="grid justify-items-end gap-1">
            <Barcode text={rma.rma} label={t("print.barcode")} />
            <Ref value={rma.rma} className="type-strong" />
          </div>
        </div>
        <dl className="ret-facts">
          <div>
            <dt>{t("print.order")}</dt>
            <dd>
              <Ref value={rma.order.ref} />
            </dd>
          </div>
          <div>
            <dt>{t("print.date")}</dt>
            <dd>
              <When at={rma.createdAt} />
            </dd>
          </div>
          <div>
            <dt>{t("print.customer")}</dt>
            <dd>{rma.customer.name ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("print.phone")}</dt>
            <dd>
              <PhoneText phone={rma.customer.phone} />
            </dd>
          </div>
          <div>
            <dt>{t("print.reason")}</dt>
            <dd>{rma.reasonCode ? t(`reason.${rma.reasonCode}`) : "—"}</dd>
          </div>
          <div>
            <dt>{t("print.requested")}</dt>
            <dd>{rma.requestedResolution ? t(`resolution.${rma.requestedResolution}`) : "—"}</dd>
          </div>
        </dl>
        <table>
          <caption className="sr-only">{t("print.items")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("print.items")}</th>
              <th scope="col">{t("item.serial")}</th>
              <th scope="col">{t("item.qty")}</th>
              <th scope="col">{t("print.inspection")}</th>
            </tr>
          </thead>
          <tbody>
            {rma.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.name}
                  <br />
                  <Ref value={item.sku} className="type-caption" />
                </td>
                <td>{item.serial ? <Ref value={item.serial.serial} /> : "—"}</td>
                <td className="nums">{f.number(item.qty)}</td>
                <td>{item.condition && item.decision ? `${t(`condition.${item.condition}`)} · ${t(`decision.${item.decision}`)}` : t("print.notInspected")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rma.reason ? <p className="type-body">{rma.reason}</p> : null}
        <div className="ret-sign">
          <div>{t("print.signCustomer")}</div>
          <div>{t("print.signStaff")}</div>
        </div>
        <p className="type-caption text-ink-2">{t("print.note")}</p>
      </article>
    </>
  );
}

function Barcode({ text, label }: { text: string; label: string }) {
  const modules = code128Modules(text);
  if (!modules) return null;
  const quiet = 10;
  const total = modules.reduce((sum, width) => sum + width, 0) + quiet * 2;
  const bars: { x: number; w: number }[] = [];
  let x = quiet;
  modules.forEach((width, index) => {
    if (index % 2 === 0) bars.push({ x, w: width });
    x += width;
  });
  return (
    <svg className="ret-barcode" viewBox={`0 0 ${total} 40`} preserveAspectRatio="none" role="img" aria-label={label}>
      {bars.map((bar, index) => (
        <rect key={index} x={bar.x} y={0} width={bar.w} height={40} fill="currentColor" />
      ))}
    </svg>
  );
}
