import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/attempts";
import { invalid } from "~/server/errors";
import { MAX_ATTEMPTS } from "~/server/services/admin/shipping/rules";
import { shippingAccess } from "~/server/services/admin/shipping/shared.server";
import { attemptsQueue, moveParcels, type QueueRow } from "~/server/services/admin/shipping/shipments.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ActionDialog, CodText, Code, FormError, PageHead, ParcelStatus, PhoneText, Section, When, useActionToast, useShipT } from "./components/kit";
import { shippingMeta } from "./meta";
import { failed, ok, openShipping, optional, text } from "./shipping.server";

/**
 * /admin/shipping/attempts — 11.05 on a phone: the parcels whose delivery failed and the parcels on their way back,
 * the oldest decision first. Each card says what happened at the door, when the next try is planned, the customer's
 * number to call (full only with customer.phone.read_full), and offers the next step: try again, send it back, or
 * open the parcel to take it back into stock.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openShipping(context, "shipping.shipment.read");
  return { rows: await attemptsQueue(db, actor, locale), access: shippingAccess(actor) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openShipping(context, "shipping.attempt.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "retry" && intent !== "returning") throw invalid({ intent: "invalid" });
    const result = await moveParcels(req.db, req.actor, { shipmentIds: [text(form, "id")], to: intent === "retry" ? "out_for_delivery" : "returning", note: optional(form, "reason"), from: optional(form, "from") as never }, req.now);
    return ok(intent, result);
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "attempts.title");

export default function Attempts({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const { rows, access } = loaderData;
  const failedRows = rows.filter((row) => row.status === "failed");
  const returning = rows.filter((row) => row.status === "returning");
  return (
    <>
      <PageHead title={t("attempts.title")} lead={t("attempts.lead", { max: MAX_ATTEMPTS })} />
      <Section id="failed" title={t("attempts.failed", { count: failedRows.length })}>
        {failedRows.length === 0 ? <EmptyState icon="check-circle" title={t("attempts.noneFailed")} /> : <ul role="list" className="grid gap-3">{failedRows.map((row) => <QueueCard key={row.id} row={row} canAct={access.attempts} />)}</ul>}
      </Section>
      <Section id="returning" title={t("attempts.returning", { count: returning.length })}>
        {returning.length === 0 ? <EmptyState icon="arrow-counter-clockwise" title={t("attempts.noneReturning")} /> : <ul role="list" className="grid gap-3">{returning.map((row) => <QueueCard key={row.id} row={row} canAct={access.attempts} />)}</ul>}
      </Section>
    </>
  );
}

function QueueCard({ row, canAct }: { row: QueueRow; canAct: boolean }) {
  const t = useShipT();
  const retry = useFetcher<typeof action>();
  const failure = useActionToast(retry, t("parcel.moved"));
  const [back, setBack] = useState(false);
  const last = row.attempts[row.attempts.length - 1];
  const tooMany = row.attempts.length >= MAX_ATTEMPTS;
  return (
    <li className={row.status === "failed" ? "adm-card adm-card--act" : "adm-card"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link to={`/admin/shipping/shipments/${encodeURIComponent(row.id)}`} className="adm-link type-strong">
          <Code>{row.code}</Code>
        </Link>
        <ParcelStatus status={row.status} />
      </div>
      <p className="type-body">
        {row.recipient.name ?? t("common.noName")} · <PhoneText phone={row.recipient.phone} />
      </p>
      <p className="type-caption text-ink-2">
        {[row.recipient.governorate, row.carrier].filter(Boolean).join(" · ")}
        {row.trackingNo ? (
          <>
            {" · "}
            <Code>{row.trackingNo}</Code>
          </>
        ) : null}
      </p>
      <p className="type-caption">
        <CodText cod={row.cod} status={row.status} />
      </p>
      {last ? (
        <p className="type-label">
          {t("attempts.last", { n: last.attemptNo, outcome: t(`outcome.${last.outcome}`) })} · <When at={last.attemptedAt} />
          {last.reason ? ` · ${last.reason}` : ""}
        </p>
      ) : row.failureReason ? (
        <p className="type-label">{row.failureReason}</p>
      ) : null}
      {last?.nextAttemptAt ? (
        <p className="type-caption">
          {t("parcel.nextTry")} <When at={last.nextAttemptAt} kind="date" />
        </p>
      ) : null}
      {tooMany && row.status === "failed" ? <p className="type-caption text-red-ink">{t("attempts.tooMany", { count: row.attempts.length })}</p> : null}
      {row.isDemo ? <p className="type-caption text-ink-2">{t("common.demo")}</p> : null}
      {canAct ? (
        <div className="shp-actions">
          {row.status === "failed" ? (
            <Key size="sm" icon="arrows-clockwise" loading={retry.state !== "idle"} onClick={() => retry.submit({ intent: "retry", id: row.id, from: row.status }, { method: "post" })}>
              {t("move.retry")}
            </Key>
          ) : null}
          {row.status === "failed" ? (
            <Key size="sm" icon="arrow-counter-clockwise" onClick={() => setBack(true)}>
              {t("move.returning")}
            </Key>
          ) : null}
          {row.orderStatus === "shipped" ? (
            <Key size="sm" as={Link} to={`/admin/shipping/shipments/${encodeURIComponent(row.id)}`} icon="storefront">
              {t("attempts.receive")}
            </Key>
          ) : null}
        </div>
      ) : null}
      <FormError message={failure} />
      <ActionDialog
        open={back}
        onClose={() => setBack(false)}
        title={t("returningDialog.title", { code: row.code })}
        consequence={t("returningDialog.consequence")}
        confirmLabel={t("move.returning")}
        reason={{ label: t("returningDialog.reason"), hint: t("returningDialog.hint") }}
        fields={{ intent: "returning", id: row.id, from: row.status }}
        successMessage={t("parcel.moved")}
      />
    </li>
  );
}
