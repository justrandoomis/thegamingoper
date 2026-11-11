import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/segments";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { segmentOverview } from "~/server/services/admin/customers/rfm.server";
import { customerSearch, RFM_RULES } from "~/server/services/admin/customers/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { segmentsAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { Notice, Num, SegmentBadge, Section, useCustomersT, useIntent, When } from "./ui";

/**
 * /admin/customers/segments — 07.02: RFM segments computed from the store's real orders. The rules are written on the
 * page (recency, frequency and monetary bounds, then the segment map), the stored membership of the last recompute
 * sits next to what the orders say now, the recency × frequency grid shows where customers are, and a person with
 * customers.segment.manage recomputes on demand (one batch, audited).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.customer.read");
  try {
    return { overview: await segmentOverview(db, actor, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await segmentsAction(req.ctx, req.db, req.session, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "segments.title");

export default function SegmentsPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const f = useFormat();
  const { overview } = loaderData;
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("recompute", "done.recomputed", () => setOpen(false));
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("segments.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("segments.lead")}</p>
      </header>

      <Section
        id="segments-table"
        title={t("segments.tableTitle")}
        action={
          overview.canRecompute ? (
            <Key size="sm" icon="arrows-clockwise" variant={overview.stale ? "ink" : "clay"} onClick={() => setOpen(true)}>
              {t("segments.recompute")}
            </Key>
          ) : null
        }
      >
        <p className="type-caption text-ink-2" aria-live="polite">
          {overview.computedAt ? (
            <>
              {t("segments.computedAt")} <When at={overview.computedAt} />
            </>
          ) : (
            t("segments.neverComputed")
          )}
          {overview.stale ? ` · ${t("segments.stale")}` : ""}
        </p>
        <div className="overflow-x-auto">
          <table className="table">
            <caption className="sr-only">{t("segments.tableTitle")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("segments.col.segment")}</th>
                <th scope="col">{t("segments.col.rule")}</th>
                <th scope="col" className="is-num">
                  {t("segments.col.stored")}
                </th>
                <th scope="col" className="is-num">
                  {t("segments.col.now")}
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.rows.map((row) => (
                <tr key={row.segment}>
                  <td>
                    {row.stored ? (
                      <Link to={`/admin/customers${customerSearch({ segment: row.segment })}`} className="adm-link">
                        <SegmentBadge segment={row.segment} />
                      </Link>
                    ) : (
                      <SegmentBadge segment={row.segment} />
                    )}
                  </td>
                  <td className="type-caption">{t(`segment.${row.segment}.rule`)}</td>
                  <td className="is-num">{row.stored === null ? "—" : <Num value={row.stored} />}</td>
                  <td className="is-num">
                    <Num value={row.now} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="type-caption text-ink-2">{t("segments.total", { count: overview.total })}</p>
      </Section>

      <Section id="segments-rules" title={t("segments.rulesTitle")}>
        <ul className="grid gap-2">
          <li className="type-body">{t("segments.purchaseRule")}</li>
          <li className="type-body">{t("rfm.rule.r", { bounds: RFM_RULES.recencyDays.map((days) => f.number(days)).join(" / ") })}</li>
          <li className="type-body">{t("rfm.rule.f", { bounds: RFM_RULES.frequency.map((n) => f.number(n)).join(" / ") })}</li>
          <li className="type-body">{t("rfm.rule.m", { bounds: RFM_RULES.monetaryIqd.map((iqd) => f.iqd(iqd)).join(" / ") })}</li>
        </ul>
        <Notice>{t("segments.constantsNote")}</Notice>
      </Section>

      <Section id="segments-grid" title={t("segments.gridTitle")}>
        <p className="type-caption text-ink-2">{t("segments.gridLead")}</p>
        <div className="overflow-x-auto">
          <table className="cus-grid">
            <caption className="sr-only">{t("segments.gridTitle")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("segments.gridCorner")}</th>
                {overview.grid[0]?.cells.map((cell) => (
                  <th key={cell.f} scope="col">
                    {t("segments.f", { score: cell.f })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overview.grid.map((row) => (
                <tr key={row.r}>
                  <th scope="row">{t("segments.r", { score: row.r })}</th>
                  {row.cells.map((cell) => (
                    <td key={cell.f} data-empty={cell.count === 0 ? "true" : undefined}>
                      <bdi>{f.number(cell.count)}</bdi>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("segments.recomputeQ")}
        consequence={t("segments.recomputeWhat")}
        confirmLabel={t("segments.recompute")}
        impact={[{ label: t("segments.impactCustomers"), value: t("segments.impactValue", { count: overview.total }) }]}
        pending={pending}
        error={message}
        onConfirm={() => fetcher.submit({ intent: "recompute" }, { method: "post" })}
      />
    </>
  );
}
