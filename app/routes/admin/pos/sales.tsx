import { Form, Link } from "react-router";

import type { Route } from "./+types/sales";
import { throwAsResponse } from "~/server/errors";
import { listSales } from "~/server/services/admin/pos/sale.server";
import { parseSaleFilters, saleSearch, TILL_METHODS } from "~/server/services/admin/pos/types";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { posMeta } from "./meta";
import { openPos } from "./pos.server";
import { Money, Num, Ref, usePosT, When } from "./ui";

/**
 * /admin/pos/sales — sales rung up at the tills (orders of channel "pos"), newest first, filters in the URL (register,
 * shift, Baghdad day, payment method, a reference or receipt number). Supervisors see every till of their branch and the
 * day's total; a cashier sees the sales of their own shifts. Each row opens its receipt (a copy is printed only through
 * "print a copy", recorded) and the order in module 05 (refunds and returns go through modules 05 and 12).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, ["pos.shift.review", "pos.receipt.reprint", "pos.sale.create"]);
  const filters = parseSaleFilters(new URL(request.url).searchParams);
  try {
    return { page: await listSales(db, actor, filters, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "sales.title");

export default function Sales({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { page, filters } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("sales.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{page.all ? t("sales.leadAll") : t("sales.leadOwn")}</p>
      </header>
      <Form method="get" className="mb-4 flex flex-wrap items-end gap-3">
        {filters.shift ? <input type="hidden" name="shift" value={filters.shift} /> : null}
        <TextField name="q" label={t("sales.q")} defaultValue={filters.q} ltr autoComplete="off" />
        <Select name="register" label={t("sales.register")} defaultValue={filters.register ?? ""} options={[{ value: "", label: t("shifts.anyRegister") }, ...page.registers.map((register) => ({ value: register.id, label: `${register.code} · ${register.name}` }))]} />
        <Select name="method" label={t("sales.method")} defaultValue={filters.method ?? ""} options={[{ value: "", label: t("sales.anyMethod") }, ...TILL_METHODS.map((method) => ({ value: method, label: t(`method.${method}`) }))]} />
        <TextField name="day" type="date" label={t("sales.day")} defaultValue={filters.day ?? ""} ltr />
        <Key type="submit" icon="funnel">
          {t("shifts.apply")}
        </Key>
        {filters.shift || filters.q || filters.register || filters.method || filters.day ? (
          <Key as={Link} to="/admin/pos/sales" variant="quiet" icon="x">
            {t("sales.clear")}
          </Key>
        ) : null}
      </Form>
      {page.totals ? (
        <p className="mb-4 type-body">
          {t("sales.summary", { count: page.totals.count })} · <Money iqd={page.totals.totalIqd} />
        </p>
      ) : null}
      {page.rows.length === 0 ? (
        <EmptyState title={t("sales.empty")} text={t("sales.emptyHint")} icon="receipt" action={<Key as={Link} to="/admin/pos/sell">{t("sales.toTill")}</Key>} />
      ) : (
        <>
          <div className="pos-table overflow-x-auto">
            <table className="table">
              <caption className="sr-only">{t("sales.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("sales.col.receipt")}</th>
                  <th scope="col">{t("sales.col.at")}</th>
                  <th scope="col">{t("sales.col.register")}</th>
                  <th scope="col">{t("sales.col.cashier")}</th>
                  <th scope="col">{t("sales.col.customer")}</th>
                  <th scope="col">{t("sales.col.methods")}</th>
                  <th scope="col" className="is-num">{t("sales.col.discount")}</th>
                  <th scope="col" className="is-num">{t("sales.col.total")}</th>
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.orderId}>
                    <td>
                      <Link to={`/admin/pos/receipts/${row.ref}`} className="adm-link">
                        <Ref value={row.receiptNumber ?? row.ref} />
                      </Link>
                      <span className="block type-caption text-ink-2">
                        <Ref value={row.ref} />
                        {row.isDemo ? ` · ${t("sales.demo")}` : ""}
                      </span>
                    </td>
                    <td>
                      <When at={row.at} />
                      {row.offlineAt ? <span className="block type-caption text-ink-2">{t("sales.offline")}</span> : null}
                    </td>
                    <td>{row.register ? <Ref value={row.register.code} /> : "—"}</td>
                    <td>{row.cashier ?? "—"}</td>
                    <td>{row.customer ?? "—"}</td>
                    <td>{row.methods.map((method) => t(`method.${method}`)).join(" + ") || "—"}</td>
                    <td className="is-num">
                      <Money iqd={row.discountIqd || null} />
                    </td>
                    <td className="is-num">
                      <Money iqd={row.totalIqd} />
                      {row.refundedIqd > 0 ? (
                        <span className="block">
                          <Status tone="warn">{t("sales.refunded")}</Status>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="pos-cards pos-cards--phone" aria-label={t("sales.title")}>
            {page.rows.map((row) => (
              <li key={row.orderId}>
                <Link to={`/admin/pos/receipts/${row.ref}`} className="pos-card">
                  <div className="pos-card__row">
                    <Ref value={row.receiptNumber ?? row.ref} className="type-strong" />
                    <Money iqd={row.totalIqd} className="type-strong" />
                  </div>
                  <p className="type-caption text-ink-2">
                    <When at={row.at} /> · {row.register ? <Ref value={row.register.code} /> : "—"} · {row.methods.map((method) => t(`method.${method}`)).join(" + ")}
                  </p>
                  {row.refundedIqd > 0 ? <Status tone="warn">{t("sales.refunded")}</Status> : null}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="type-caption text-ink-2">
              <Num value={page.total} /> {t("sales.rows")}
            </p>
            <Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/pos/sales${saleSearch({ ...filters, page: n })}`} />
          </div>
        </>
      )}
    </>
  );
}
