import { data, Link, useFetcher } from "react-router";

import type { Route } from "./+types/print";
import { Logo } from "~/art/Logo";
import { useFormat, useLocale } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { issueInvoices, orderIdsForRefs, printDocuments, type InvoiceDoc, type LabelDoc, type PackingDoc } from "~/server/services/admin/orders/documents.server";
import { PRINT_KINDS, type PrintKind } from "~/server/services/admin/orders/types";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ordersMeta } from "./meta";
import { code128Modules } from "./code128";
import { failure } from "./common.server";
import { Failure, PhoneText, useOrdersT } from "./ui";

/**
 * /admin/orders/print?kind=invoice|packing|label&id=<order id>&id=… (or &ref=TT-…) — 05.06 batch printing. The browser
 * prints (print CSS hides the admin's chrome and puts each document on its own page); no printer integration exists
 * or is needed. Invoices show their number once issued (POST "issue the missing invoices": numbers are taken once,
 * gap-free); nothing on any document is cost data. Labels carry the order reference as a Code 128 barcode.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.document.print");
  const url = new URL(request.url);
  const kind = (PRINT_KINDS as readonly string[]).includes(url.searchParams.get("kind") ?? "") ? (url.searchParams.get("kind") as PrintKind) : "invoice";
  const ids = [...url.searchParams.getAll("id"), ...(await orderIdsForRefs(db, url.searchParams.getAll("ref")))].filter((id) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)).slice(0, 50);
  try {
    const docs = ids.length ? await printDocuments(db, actor, { kind, orderIds: ids }, ctx.locale) : [];
    return { kind, ids, docs, now: ctx.now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.document.print");
  const form = await request.formData();
  try {
    const result = await issueInvoices(
      db,
      actor,
      form.getAll("id").map((value) => String(value)),
      ctx.now,
    );
    return { ok: true as const, intent: "invoice", issued: result.issued };
  } catch (error) {
    const result = failure(error, ctx.locale, "invoice");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "print.title");

export default function PrintPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const fetcher = useFetcher<typeof action>();
  const { kind, ids, docs } = loaderData;
  const missing = kind === "invoice" ? (docs as InvoiceDoc[]).filter((doc) => doc.number === null && doc.invoiceable) : [];
  const query = (next: PrintKind) => `/admin/orders/print?kind=${next}&${ids.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`;
  const error = fetcher.data && !fetcher.data.ok ? (fetcher.data.message ?? t(`errors.${fetcher.data.code}`)) : null;
  return (
    <>
      <header className="adm-page-head ord-noprint">
        <p className="adm-eyebrow">
          <Link to="/admin/orders" className="adm-link">
            {t("detail.back")}
          </Link>
        </p>
        <h1 className="adm-title">{t("print.title")}</h1>
        <p className="type-body text-ink-2">{t("print.lead", { count: docs.length })}</p>
        <nav aria-label={t("print.kinds")} className="flex flex-wrap gap-2">
          {PRINT_KINDS.map((option) => (
            <Key key={option} as={Link} to={query(option)} size="sm" held={option === kind} aria-current={option === kind ? "page" : undefined}>
              {t(`print.${option}`)}
            </Key>
          ))}
        </nav>
        <div className="ord-actions">
          <Key icon="printer" variant="ink" disabled={docs.length === 0} onClick={() => window.print()}>
            {t("print.print")}
          </Key>
          {missing.length ? (
            <fetcher.Form method="post">
              {missing.map((doc) => (
                <input key={doc.orderId} type="hidden" name="id" value={doc.orderId} />
              ))}
              <Key type="submit" icon="receipt" loading={fetcher.state !== "idle"}>
                {t("print.issueMissing", { count: missing.length })}
              </Key>
            </fetcher.Form>
          ) : null}
        </div>
        <Failure message={error} />
      </header>

      {docs.length === 0 ? (
        <EmptyState title={t("print.empty")} text={t("print.emptyHint")} icon="printer" />
      ) : (
        <div className="ord-docs">
          {docs.map((doc, index) =>
            doc.kind === "invoice" ? <InvoiceSheet key={`${doc.orderId}-${index}`} doc={doc} /> : doc.kind === "packing" ? <PackingSheet key={`${doc.orderId}-${index}`} doc={doc} /> : <LabelSheet key={`${doc.orderId}-${index}`} doc={doc} />,
          )}
        </div>
      )}
    </>
  );
}

function DocHead({ title, ref, sub }: { title: string; ref: string; sub?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="grid gap-1">
        <Logo className="h-8 w-auto" />
        <p className="type-caption text-ink-2">TamTam Games · طمطم</p>
      </div>
      <div className="grid justify-items-end gap-1 text-end">
        <p className="adm-h2">{title}</p>
        <p className="type-strong">
          <bdi dir="ltr">{ref}</bdi>
        </p>
        {sub}
      </div>
    </div>
  );
}

function InvoiceSheet({ doc }: { doc: InvoiceDoc }) {
  const t = useOrdersT();
  const f = useFormat();
  return (
    <article className="ord-doc" aria-label={t("print.invoiceOf", { ref: doc.ref })}>
      <DocHead
        title={doc.number ? t("print.invoiceTitle") : t("print.proforma")}
        ref={doc.ref}
        sub={
          <p className="type-caption text-ink-2">
            {doc.number ? (
              <>
                {t("invoice.number")} <bdi dir="ltr">{doc.number}</bdi> · {doc.issuedAt ? f.date(doc.issuedAt) : ""}
              </>
            ) : doc.invoiceable ? (
              t("print.notIssued")
            ) : (
              t("print.notInvoiceable", { status: t(`status.${doc.status}`) })
            )}
          </p>
        }
      />
      {doc.isDemo ? <p className="type-caption text-ink-2">{t("print.demo")}</p> : null}
      <div className="grid gap-1 type-body">
        <p className="type-strong">{doc.contactName ?? t("list.noName")}</p>
        <p>
          <PhoneText phone={doc.phone} />
        </p>
        <p>{[doc.governorate, doc.district, doc.area].filter(Boolean).join(" · ")}</p>
        <p>{doc.address}</p>
        <p className="type-caption text-ink-2">
          {t("print.placed")} {f.dateTime(doc.placedAt)} · {doc.paymentMethod ? t(`method.${doc.paymentMethod}`) : "—"}
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("detail.item")}</th>
            <th scope="col">{t("detail.sku")}</th>
            <th scope="col" className="is-num">
              {t("detail.qty")}
            </th>
            <th scope="col" className="is-num">
              {t("detail.unitPrice")}
            </th>
            <th scope="col" className="is-num">
              {t("detail.lineTotal")}
            </th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((line, index) => (
            <tr key={index}>
              <td>{line.name}</td>
              <td>
                <bdi dir="ltr">{line.sku}</bdi>
              </td>
              <td className="is-num">{f.number(line.qty)}</td>
              <td className="is-num">{f.number(line.unitPriceIqd)}</td>
              <td className="is-num">{f.number(line.totalIqd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="ord-ledger ms-auto w-full max-w-xs">
        <div>
          <dt>{t("detail.subtotal")}</dt>
          <dd>{f.iqd(doc.totals.subtotalIqd)}</dd>
        </div>
        {doc.totals.discountIqd > 0 ? (
          <div>
            <dt>
              {t("detail.discount")} {doc.couponCode ? <bdi dir="ltr">({doc.couponCode})</bdi> : null}
            </dt>
            <dd>−{f.iqd(doc.totals.discountIqd)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("detail.shipping")}</dt>
          <dd>{f.iqd(doc.totals.shippingIqd)}</dd>
        </div>
        <div className="ord-ledger__total">
          <dt>{t("detail.total")}</dt>
          <dd>{f.iqd(doc.totals.totalIqd)}</dd>
        </div>
      </dl>
      <p className="type-caption text-ink-2">{t("print.invoiceFoot")}</p>
    </article>
  );
}

function PackingSheet({ doc }: { doc: PackingDoc }) {
  const t = useOrdersT();
  const f = useFormat();
  return (
    <article className="ord-doc" aria-label={t("print.packingOf", { ref: doc.ref })}>
      <DocHead title={t("print.packingTitle")} ref={doc.ref} sub={<p className="type-caption text-ink-2">{t("print.parcelOf", { parcel: doc.parcel, parcels: doc.parcels })}</p>} />
      {doc.isDemo ? <p className="type-caption text-ink-2">{t("print.demo")}</p> : null}
      {!doc.shippable ? <p className="type-strong">{t("print.notShippable", { status: t(`status.${doc.status}`) })}</p> : null}
      <p className="type-body">
        {doc.contactName ?? t("list.noName")} · {doc.governorate ?? "—"}
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">{t("print.check")}</th>
            <th scope="col">{t("detail.item")}</th>
            <th scope="col">{t("detail.sku")}</th>
            <th scope="col" className="is-num">
              {t("detail.qty")}
            </th>
            <th scope="col">{t("detail.serials")}</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((line, index) => (
            <tr key={index}>
              <td aria-hidden="true">☐</td>
              <td>{line.name}</td>
              <td>
                <bdi dir="ltr">{line.sku}</bdi>
              </td>
              <td className="is-num">{f.number(line.qty)}</td>
              <td>
                {line.serials.map((serial) => (
                  <bdi key={serial} dir="ltr" className="block">
                    {serial}
                  </bdi>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="type-caption text-ink-2">{t("print.packingFoot")}</p>
    </article>
  );
}

function LabelSheet({ doc }: { doc: LabelDoc }) {
  const t = useOrdersT();
  const f = useFormat();
  const locale = useLocale();
  return (
    <article className="ord-doc ord-doc--label" aria-label={t("print.labelOf", { ref: doc.ref })} lang={locale}>
      <p className="type-caption text-ink-2">{t("print.parcelOf", { parcel: doc.parcel, parcels: doc.parcels })}</p>
      <Barcode text={doc.ref} label={t("print.barcodeOf", { ref: doc.ref })} />
      <p className="type-title text-center">
        <bdi dir="ltr">{doc.ref}</bdi>
      </p>
      <p className="type-strong">{doc.contactName ?? t("list.noName")}</p>
      <p className="type-strong">
        <PhoneText phone={doc.phone} />
      </p>
      <p className="type-body">{[doc.governorate, doc.district, doc.area].filter(Boolean).join(" · ")}</p>
      <p className="type-body">{doc.address}</p>
      {doc.notes ? <p className="type-caption text-ink-2">{doc.notes}</p> : null}
      <p className="type-strong">
        {doc.payment === "collect"
          ? doc.collectIqd > 0
            ? t("print.collect", { amount: f.iqd(doc.collectIqd) })
            : t("print.collectWithFirst")
          : doc.payment === "prepaid"
            ? t("print.prepaid")
            : t("print.unpaid")}
      </p>
      {!doc.shippable ? <p className="type-strong">{t("print.notShippable", { status: t(`status.${doc.status}`) })}</p> : null}
      {doc.trackingNo ? (
        <p className="type-caption">
          {t("parcel.tracking")} <bdi dir="ltr">{doc.trackingNo}</bdi>
        </p>
      ) : null}
      {doc.isDemo ? <p className="type-caption text-ink-2">{t("print.demo")}</p> : null}
    </article>
  );
}

/** The reference as Code 128 bars (./code128) with a 10-module quiet zone; ink on paper, no colour. */
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
    <svg className="ord-barcode" viewBox={`0 0 ${total} 40`} preserveAspectRatio="none" role="img" aria-label={label}>
      {bars.map((bar, index) => (
        <rect key={index} x={bar.x} y={0} width={bar.w} height={40} fill="currentColor" />
      ))}
    </svg>
  );
}
