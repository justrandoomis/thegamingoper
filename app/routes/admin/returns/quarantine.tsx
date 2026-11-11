import { useState } from "react";
import { data, Link } from "react-router";

import type { Route } from "./+types/quarantine";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { listQuarantine, resolveQuarantine } from "~/server/services/admin/returns/inspect.server";
import { SLA, type QuarantineRow } from "~/server/services/admin/returns/types";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { returnsMeta } from "./meta";
import { failure, openReturns, text } from "./returns.server";
import { Due, Failure, Ref, useIntent, useReturnsT, When } from "./ui";

/**
 * /admin/returns/quarantine — returned units kept where nothing is sold from (12.07): waiting to be refurbished or to go
 * back to their supplier, with the days they waited against SLA.quarantineDays. Each leaves through the commerce core
 * (returns/receive.server exitQuarantine): back on sale at its cost, written off (a loss in the books; needs
 * inventory.stock.adjust too), or to its supplier (a return claim, the supplier owes its cost).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.rma.inspect", "returns.supplier_return.manage"]);
  try {
    return { ...(await listQuarantine(db, actor, locale, now)), now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.rma.inspect", "returns.supplier_return.manage"]);
  const form = await request.formData();
  try {
    const result = await resolveQuarantine(db, actor, { itemId: text(form, "itemId"), to: text(form, "to") as never, locationId: text(form, "locationId") || undefined, supplierId: text(form, "supplierId") || undefined, reason: text(form, "reason") }, now);
    return { ok: true as const, intent: "resolve", replayed: result.replayed, claimRef: result.claimRef };
  } catch (error) {
    const result = failure(error, locale, "resolve");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "quarantine.title");

export default function Quarantine({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const { rows } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("quarantine.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("quarantine.lead", { days: SLA.quarantineDays })}</p>
      </header>
      {rows.length === 0 ? (
        <EmptyState title={t("quarantine.empty")} text={t("quarantine.emptyHint")} icon="package" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={t("quarantine.title")}>
          {rows.map((row) => (
            <li key={row.itemId}>
              <QuarantineCard row={row} data={loaderData} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

type Data = Route.ComponentProps["loaderData"];

function QuarantineCard({ row, data: page }: { row: QuarantineRow; data: Data }) {
  const t = useReturnsT();
  const f = useFormat();
  const days = Math.max(0, Math.floor((page.now - row.since) / (24 * 60 * 60 * 1000)));
  return (
    <article className={row.late ? "adm-card adm-card--act" : "adm-card"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="type-strong">{row.name}</p>
          <p className="type-caption text-ink-2">
            <Ref value={row.sku} />
            {row.serial ? (
              <>
                {" · "}
                <Ref value={row.serial.serial} />
              </>
            ) : null}
            {" · "}× <bdi className="nums">{f.number(row.qty)}</bdi>
          </p>
        </div>
        <Status tone={row.decision === "return_to_supplier" ? "info" : "warn"}>{t(`decision.${row.decision}`)}</Status>
      </div>
      <dl className="ret-ledger">
        <div>
          <dt>{t("quarantine.col.rma")}</dt>
          <dd>
            <Link to={`/admin/returns/${row.rma}`} className="adm-link">
              <Ref value={row.rma} />
            </Link>
          </dd>
        </div>
        <div>
          <dt>{t("quarantine.col.location")}</dt>
          <dd>{row.location ? <Ref value={row.location.code} /> : t("quarantine.unknownLocation")}</dd>
        </div>
        <div>
          <dt>{t("quarantine.col.waiting")}</dt>
          <dd>
            {t("quarantine.waited", { count: days })} · <When at={row.since} style="date" />
          </dd>
        </div>
      </dl>
      {row.condition ? <p className="type-caption text-ink-2">{t(`condition.${row.condition}`)}{row.notes ? ` · ${row.notes}` : ""}</p> : null}
      <Due dueAt={row.dueAt} late={row.late} />
      <div className="ret-actions">
        {page.can.release ? <ExitButton row={row} to="stock" page={page} /> : null}
        {page.can.supplier ? <ExitButton row={row} to="supplier" page={page} /> : null}
        {page.can.scrap ? <ExitButton row={row} to="scrap" page={page} /> : page.can.release ? <span className="type-caption text-ink-2">{t("quarantine.scrapNeeds")}</span> : null}
      </div>
    </article>
  );
}

function ExitButton({ row, to, page }: { row: QuarantineRow; to: "stock" | "scrap" | "supplier"; page: Data }) {
  const t = useReturnsT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [locationId, setLocationId] = useState(page.sellable[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState(page.suppliers?.[0]?.id ?? "");
  const { fetcher, pending, message, fields } = useIntent("resolve", "done.quarantine", () => setOpen(false));
  const label = to === "stock" ? t("quarantine.release") : to === "scrap" ? t("quarantine.scrap") : t("quarantine.supplier");
  const units = f.number(row.qty);
  const impact: ImpactRow[] = [
    { label: t("quarantine.impact.stock"), value: to === "stock" ? `${t("quarantine.impact.leaves", { count: units })} · ${t("quarantine.impact.sellable", { count: units })}` : t("quarantine.impact.leaves", { count: units }), negative: to !== "stock" },
    { label: t("quarantine.impact.books"), value: to === "stock" ? t("quarantine.impact.none") : to === "scrap" ? t("quarantine.impact.loss") : t("quarantine.impact.supplierOwes"), negative: to === "scrap" },
  ];
  const noSuppliers = to === "supplier" && (page.suppliers ?? []).length === 0;
  return (
    <>
      <Key size="sm" variant={to === "stock" ? "ink" : "clay"} icon={to === "stock" ? "storefront" : to === "scrap" ? "trash" : "truck"} className={to === "scrap" ? "enabled:[--on:var(--red-ink)]" : undefined} onClick={() => setOpen(true)}>
        {label}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone={to === "stock" ? "neutral" : "destructive"}
        title={t(to === "stock" ? "quarantine.releaseQ" : to === "scrap" ? "quarantine.scrapQ" : "quarantine.supplierQ", { name: row.name })}
        consequence={t(to === "stock" ? "quarantine.releaseWhat" : to === "scrap" ? "quarantine.scrapWhat" : "quarantine.supplierWhat")}
        confirmLabel={label}
        impact={impact}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ itemId: row.itemId, to, locationId: to === "stock" ? locationId : "", supplierId: to === "supplier" ? supplierId : "", reason }, { method: "post" })}
      >
        {to === "stock" ? (
          <Select label={t("quarantine.location")} value={locationId} onChange={(event) => setLocationId(event.target.value)} required error={fields.locationId} options={page.sellable.map((location) => ({ value: location.id, label: `${location.code} · ${location.name}` }))} />
        ) : null}
        {to === "supplier" ? (
          noSuppliers ? (
            <Failure message={t("quarantine.noSuppliers")} />
          ) : (
            <Select label={t("quarantine.supplierPick")} value={supplierId} onChange={(event) => setSupplierId(event.target.value)} required error={fields.supplierId} options={(page.suppliers ?? []).map((supplier) => ({ value: supplier.id, label: `${supplier.code} · ${supplier.name}` }))} />
          )
        ) : null}
      </ConfirmDialog>
    </>
  );
}
