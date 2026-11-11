import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/print";
import { Logo } from "~/art/Logo";
import { useFormat, useLocale } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { manifestDocs, waybillDocs, type ManifestDoc, type WaybillDoc } from "~/server/services/admin/shipping/shipments.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Barcode } from "../inventory/components/Barcode";
import { CodText, Code, Money, PhoneText, useShipT, usePrintInLight } from "./components/kit";
import { shippingMeta } from "./meta";
import { openShipping } from "./shipping.server";

/**
 * /admin/shipping/print?kind=waybill|manifest&id=<shipment id>&id=… — 11.03 printed documents. The browser prints (print
 * CSS drops the admin's chrome and starts each document on a page; no printer integration exists or is needed):
 *   waybill    one per parcel — the waybill number REF-n as Code 128, the carrier's tracking number, sender and
 *              recipient, the cash to collect (or "prepaid" / "do not hand over"), what is inside (no prices), a
 *              fragile-device note, and two signature boxes: the courier at pickup and the receiver at the door (the
 *              signed copy photographed is the proof of receipt, 11.06)
 *   manifest   per carrier — the parcels a courier signs for at pickup, with the cash each collects and the total
 * Phones are shown in full only to employees with customer.phone.read_full (couriers need the number: the fulfilment
 * role holds it). Nothing printed is cost data.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openShipping(context, "shipping.shipment.read");
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "manifest" ? ("manifest" as const) : ("waybill" as const);
  const ids = url.searchParams
    .getAll("id")
    .filter((id) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))
    .slice(0, 50);
  try {
    if (kind === "manifest") return { kind, ids, waybills: [] as WaybillDoc[], manifests: ids.length ? await manifestDocs(db, actor, ids, locale, now) : [] };
    return { kind, ids, waybills: ids.length ? await waybillDocs(db, actor, ids, locale) : [], manifests: [] as ManifestDoc[] };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "print.title");

export default function PrintPage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const { kind, ids, waybills, manifests } = loaderData;
  const docs = useRef<HTMLDivElement>(null);
  usePrintInLight(docs);
  const count = kind === "waybill" ? waybills.length : manifests.length;
  const href = (next: "waybill" | "manifest") => `/admin/shipping/print?kind=${next}&${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`;
  return (
    <>
      <header className="adm-page-head shp-noprint">
        <p className="adm-eyebrow">
          <Link to="/admin/shipping/shipments" className="adm-link">
            {t("print.back")}
          </Link>
        </p>
        <h1 className="adm-title">{t("print.title")}</h1>
        <p className="type-body text-ink-2">{t(`print.lead.${kind}`, { count })}</p>
        <nav aria-label={t("print.kinds")} className="flex flex-wrap gap-2">
          {(["waybill", "manifest"] as const).map((option) => (
            <Key key={option} as={Link} to={href(option)} size="sm" held={option === kind} aria-current={option === kind ? "page" : undefined}>
              {t(`print.kind.${option}`)}
            </Key>
          ))}
        </nav>
        <div className="shp-actions mt-2">
          <Key icon="printer" variant="ink" disabled={count === 0} onClick={() => window.print()}>
            {t("print.print")}
          </Key>
        </div>
      </header>

      {count === 0 ? (
        <EmptyState icon="printer" title={t("print.empty")} text={t("print.emptyHint")} />
      ) : (
        <div ref={docs} className="shp-docs">
          {kind === "waybill" ? waybills.map((doc) => <WaybillSheet key={doc.shipmentId} doc={doc} />) : manifests.map((doc, index) => <ManifestSheet key={doc.carrier?.id ?? `none-${index}`} doc={doc} />)}
        </div>
      )}
    </>
  );
}

function WaybillSheet({ doc }: { doc: WaybillDoc }) {
  const t = useShipT();
  const f = useFormat();
  const locale = useLocale();
  return (
    <article className="shp-doc" aria-label={t("print.waybillOf", { code: doc.code })} lang={locale}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <Logo className="h-8 w-auto" />
          <p className="type-caption text-ink-2">TamTam Games · طمطم</p>
        </div>
        <div className="grid justify-items-end gap-1 text-end">
          <p className="adm-h2">{t("print.waybillTitle")}</p>
          <p className="type-strong">
            <Code>{doc.code}</Code>
          </p>
          <p className="type-caption text-ink-2">{t("print.parcelOf", { number: doc.number, count: doc.parcels })}</p>
        </div>
      </div>
      <div className="shp-barcode">
        <Barcode value={doc.code} label={t("print.barcodeOf", { code: doc.code })} />
      </div>
      {doc.isDemo ? <p className="type-caption text-ink-2">{t("print.demo")}</p> : null}
      {!doc.shippable ? <p className="type-strong text-red-ink">{t("print.notShippable", { status: t(`orderStatus.${doc.orderStatus}`) })}</p> : null}

      <div className="shp-doc__cols">
        <div className="shp-doc__box">
          <p className="type-caption text-ink-2">{t("print.carrier")}</p>
          <p className="type-strong">{doc.carrier?.name ?? t("print.noCarrier")}</p>
          {doc.carrier?.phone ? (
            <p className="type-caption">
              <Code>{doc.carrier.phone}</Code>
            </p>
          ) : null}
          <p className="type-caption">
            {t("waybill.level")}: {doc.serviceLevel ? t(`level.${doc.serviceLevel}`) : "—"}
          </p>
          <p className="type-caption">
            {t("common.tracking")}: {doc.trackingNo ? <Code>{doc.trackingNo}</Code> : "—"}
          </p>
        </div>
        <div className="shp-doc__box">
          <p className="type-caption text-ink-2">{t("print.sender")}</p>
          <p className="type-strong">TamTam Games · طمطم</p>
          {doc.sender.phone ? (
            <p className="type-caption">
              <Code>{doc.sender.phone}</Code>
            </p>
          ) : null}
          {doc.sender.address ? <p className="type-caption">{doc.sender.address}</p> : <p className="type-caption text-ink-2">{t("print.senderNoAddress")}</p>}
        </div>
      </div>

      <div className="shp-doc__box">
        <p className="type-caption text-ink-2">{t("print.recipient")}</p>
        <p className="type-strong">{doc.recipient.name ?? t("common.noName")}</p>
        <p className="type-strong">
          <PhoneText phone={doc.recipient.phone} />
        </p>
        {doc.recipient.phone && !doc.recipient.phone.full ? <p className="type-caption text-ink-2">{t("print.phoneHidden")}</p> : null}
        <p className="type-body">{[doc.recipient.governorate, doc.recipient.district, doc.recipient.area].filter(Boolean).join(" · ")}</p>
        <p className="type-body">{doc.recipient.address}</p>
        {doc.recipient.notes ? <p className="type-caption">{doc.recipient.notes}</p> : null}
        {doc.preferredDay || doc.preferredWindow ? (
          <p className="type-caption text-ink-2">{t("print.preferred", { day: doc.preferredDay ?? "—", window: doc.preferredWindow ? t(`window.${doc.preferredWindow}`) : "—" })}</p>
        ) : null}
      </div>

      <div className="shp-doc__money">
        {doc.shippable && doc.cod.kind === "collect" ? (
          <span>
            {t("print.collect")} <Money iqd={doc.cod.amountIqd} />
          </span>
        ) : doc.shippable && doc.cod.kind === "unpaid" ? (
          <span>{t("print.doNotHandOver")}</span>
        ) : (
          <CodText cod={doc.cod} status={doc.status} />
        )}
      </div>

      <table>
        <caption className="sr-only">{t("print.contents")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("print.item")}</th>
            <th scope="col">SKU</th>
            <th scope="col" className="is-num">
              {t("print.qty")}
            </th>
          </tr>
        </thead>
        <tbody>
          {doc.contents.map((line, index) => (
            <tr key={index}>
              <td>{line.name}</td>
              <td>
                <Code>{line.sku}</Code>
              </td>
              <td className="is-num">{f.number(line.qty)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {doc.sensitive ? <p className="type-strong">{t("print.fragile")}</p> : null}

      <div className="shp-sign">
        <div>
          <p className="type-caption text-ink-2">{t("print.signPickup")}</p>
          <p className="type-caption">{t("print.signLine")}</p>
        </div>
        <div>
          <p className="type-caption text-ink-2">{t("print.signReceiver")}</p>
          <p className="type-caption">{t("print.signLine")}</p>
        </div>
      </div>
      <p className="type-caption text-ink-2">{t("print.waybillFoot")}</p>
    </article>
  );
}

function ManifestSheet({ doc }: { doc: ManifestDoc }) {
  const t = useShipT();
  const f = useFormat();
  return (
    <article className="shp-doc" aria-label={t("print.manifestOf", { carrier: doc.carrier?.name ?? t("print.noCarrier") })}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="grid gap-1">
          <Logo className="h-8 w-auto" />
          <p className="type-caption text-ink-2">TamTam Games · طمطم</p>
        </div>
        <div className="grid justify-items-end gap-1 text-end">
          <p className="adm-h2">{t("print.manifestTitle")}</p>
          <p className="type-strong">{doc.carrier?.name ?? t("print.noCarrier")}</p>
          <p className="type-caption text-ink-2">
            <Code>{doc.day}</Code>
          </p>
        </div>
      </div>
      <table>
        <caption className="sr-only">{t("print.manifestTitle")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("common.parcel")}</th>
            <th scope="col">{t("common.tracking")}</th>
            <th scope="col">{t("common.governorate")}</th>
            <th scope="col" className="is-num">
              {t("print.collectHead")}
            </th>
            <th scope="col">{t("print.received")}</th>
          </tr>
        </thead>
        <tbody>
          {doc.rows.map((row) => (
            <tr key={row.code} className={row.shippable ? undefined : "shp-doc__off"}>
              <td>
                <Code>{row.code}</Code>
              </td>
              <td>{row.trackingNo ? <Code>{row.trackingNo}</Code> : "—"}</td>
              <td>{row.governorate ?? "—"}</td>
              <td className="is-num">{row.collectIqd > 0 ? f.number(row.collectIqd) : "—"}</td>
              {/* a parcel that must not leave stays on the sheet, said in words, outside the totals */}
              {row.shippable ? <td aria-hidden="true">☐</td> : <td className="type-label">{t("print.notToHandOver")} · {t(`status.${row.status}`)}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={3}>
              {t("print.totals", { count: doc.totals.parcels })}
            </th>
            <td className="is-num">
              <Money iqd={doc.totals.collectIqd} />
            </td>
            <td />
          </tr>
        </tfoot>
      </table>
      <div className="shp-sign">
        <div>
          <p className="type-caption text-ink-2">{t("print.signStore")}</p>
          <p className="type-caption">{t("print.signLine")}</p>
        </div>
        <div>
          <p className="type-caption text-ink-2">{t("print.signCourier")}</p>
          <p className="type-caption">{t("print.signLine")}</p>
        </div>
      </div>
    </article>
  );
}
