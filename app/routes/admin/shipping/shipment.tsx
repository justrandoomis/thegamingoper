import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/shipment";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { carrierChoices } from "~/server/services/admin/shipping/carriers.server";
import { FAILURE_OUTCOMES, MAX_ATTEMPTS, SERVICE_LEVELS, type CarrierOption } from "~/server/services/admin/shipping/rules";
import { getShipment } from "~/server/services/admin/shipping/shipments.server";
import { Dialog } from "~/ui/Dialog";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { toast } from "~/ui/toast-store";
import { ActionDialog, CodText, Code, FormError, Money, Note, PageHead, Pair, ParcelStatus, PhoneText, Section, When, digitsOnly, failureText, useActionToast, useArrow, useShipT } from "./components/kit";
import { shippingBlobStore } from "./env.server";
import { shippingMeta } from "./meta";
import { parcelAction } from "./shipment.server";
import { failed, openShipping } from "./shipping.server";

/**
 * /admin/shipping/shipments/:shipmentId — one parcel (11.03 / 11.05 / 11.06): its waybill (carrier chosen by zone,
 * cost and service level — 11.02), the handover to the courier (the order ships through the orders module's rules),
 * the courier's statuses, failed tries and retries, delivery with proof of receipt, the way back, the packing photos
 * of a sensitive device, the cash to collect and its settlement, and the parcel's whole history. Every action names
 * what it changes before it runs; the order-moving ones show their impact.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openShipping(context, "shipping.shipment.read");
  try {
    const [parcel, carriers] = await Promise.all([getShipment(db, actor, params.shipmentId, locale, now), carrierChoices(db)]);
    return { parcel, carriers, orders: can(actor, "orders.order.read"), cod: can(actor, "shipping.cod.settle") };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  // the page's own permission first (403 before the form is read or the parcel looked up); each intent's service then
  // checks its own (waybill, statuses, tries, delivery, proofs)
  const req = await openShipping(context, "shipping.shipment.read");
  const form = await request.formData();
  try {
    return { ok: true as const, ...(await parcelAction(req, params.shipmentId, form, shippingBlobStore)) };
  } catch (error) {
    return failed(error, req.locale, typeof form.get("intent") === "string" ? String(form.get("intent")) : null);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "parcel.title", { code: args.loaderData?.parcel.code ?? "" });

type Parcel = Route.ComponentProps["loaderData"]["parcel"];

export default function ParcelPage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const { parcel, carriers, orders, cod } = loaderData;
  const [dialog, setDialog] = useState<null | "pickup" | "returning" | "attempt" | "deliver" | "return">(null);
  const close = () => setDialog(null);
  const move = useFetcher<typeof action>();
  const moveError = useActionToast(move, t("parcel.moved"));
  const sync = useFetcher<typeof action>();
  const syncError = useActionToast(sync, t("parcel.synced"));
  const can = parcel.can;
  const failedTries = parcel.attempts.filter((attempt) => attempt.outcome !== "delivered").length;

  return (
    <>
      <PageHead
        eyebrow={
          <>
            {t("parcel.eyebrow", { number: parcel.number, count: parcel.parcels.length })} ·{" "}
            {orders ? (
              <Link to={`/admin/orders/${encodeURIComponent(parcel.order.ref)}`} className="adm-link">
                <Code>{parcel.order.ref}</Code>
              </Link>
            ) : (
              <Code>{parcel.order.ref}</Code>
            )}
          </>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Code>{parcel.code}</Code>
            <ParcelStatus status={parcel.status} />
          </span>
        }
        actions={
          <Key as={Link} to={`/admin/shipping/print?kind=waybill&id=${encodeURIComponent(parcel.id)}`} icon="printer" variant="quiet">
            {t("parcel.printWaybill")}
          </Key>
        }
      />

      <div className="grid gap-3">
        {parcel.order.isDemo ? <Note>{t("common.demoOrder")}</Note> : null}
        {parcel.order.onHold ? (
          <Note tone="warn" icon="flag">
            {t("parcel.onHold")}
          </Note>
        ) : null}
        {parcel.outOfStep ? (
          <Note tone="warn" icon="arrows-clockwise">
            <p>{t("parcel.outOfStep", { status: t(`orderStatus.${parcel.order.status}`) })}</p>
            {can.sync ? (
              <sync.Form method="post">
                <input type="hidden" name="intent" value="sync" />
                <Key type="submit" size="sm" loading={sync.state !== "idle"}>
                  {t("parcel.sync")}
                </Key>
              </sync.Form>
            ) : null}
            <FormError message={syncError} />
          </Note>
        ) : null}
        {parcel.sensitive && parcel.packingPhotos.length === 0 && (parcel.status === "pending" || parcel.status === "packed") ? (
          <Note tone="warn" icon="camera">
            {t("parcel.needsPackingPhoto")}
          </Note>
        ) : null}
        {parcel.status === "failed" && failedTries >= MAX_ATTEMPTS ? (
          <Note tone="warn" icon="warning">
            {t("parcel.maxAttempts", { count: failedTries })}
          </Note>
        ) : null}
      </div>

      <div className="shp-split mt-5">
        <div className="min-w-0">
          <Section id="next" title={t("parcel.next")}>
            <div className="shp-actions">
              {can.pickup ? (
                <Key variant="commit" icon="package" disabled={parcel.pickupBlock !== null} aria-describedby={parcel.pickupBlock ? "pickup-why" : undefined} onClick={() => setDialog("pickup")}>
                  {t("parcel.pickup")}
                </Key>
              ) : null}
              {can.move && parcel.status === "handed_over" ? (
                <Key onClick={() => move.submit({ intent: "move", to: "in_transit", from: parcel.status }, { method: "post" })} loading={move.state !== "idle" && move.formData?.get("to") === "in_transit"}>
                  {t("move.in_transit")}
                </Key>
              ) : null}
              {can.move && (parcel.status === "handed_over" || parcel.status === "in_transit") ? (
                <Key onClick={() => move.submit({ intent: "move", to: "out_for_delivery", from: parcel.status }, { method: "post" })} loading={move.state !== "idle" && move.formData?.get("to") === "out_for_delivery"}>
                  {t("move.out_for_delivery")}
                </Key>
              ) : null}
              {can.attempt && parcel.status === "failed" ? (
                <Key icon="arrows-clockwise" onClick={() => move.submit({ intent: "move", to: "out_for_delivery", from: parcel.status }, { method: "post" })} loading={move.state !== "idle"}>
                  {t("move.retry")}
                </Key>
              ) : null}
              {can.deliver ? (
                <Key variant={can.pickup ? "clay" : "ink"} icon="check-circle" onClick={() => setDialog("deliver")}>
                  {t("parcel.deliver")}
                </Key>
              ) : null}
              {can.attempt && (parcel.status === "handed_over" || parcel.status === "in_transit" || parcel.status === "out_for_delivery") ? (
                <Key icon="warning" onClick={() => setDialog("attempt")}>
                  {t("parcel.attempt")}
                </Key>
              ) : null}
              {can.attempt && parcel.status !== "returning" && can.move ? (
                <Key icon="arrow-counter-clockwise" onClick={() => setDialog("returning")}>
                  {t("move.returning")}
                </Key>
              ) : null}
              {can.receiveReturn ? (
                <Key icon="storefront" onClick={() => setDialog("return")}>
                  {t("parcel.receiveReturn")}
                </Key>
              ) : null}
            </div>
            {can.pickup && parcel.pickupBlock ? (
              <p id="pickup-why" className="type-caption text-ink-2">
                {t(`parcel.pickupBlocked.${parcel.pickupBlock}`)}
              </p>
            ) : null}
            {!can.pickup && !can.move && !can.deliver && !can.receiveReturn ? <p className="type-caption text-ink-2">{t(`parcel.nextNone.${parcel.status}`)}</p> : null}
            <FormError message={moveError} />
          </Section>

          {can.waybill ? <WaybillForm parcel={parcel} carriers={carriers} /> : null}

          <Section id="contents" title={t("parcel.contents")}>
            <ul role="list" className="grid gap-2">
              {parcel.items.map((item) => (
                <li key={item.orderItemId} className="adm-card gap-1">
                  <div className="flex items-start justify-between gap-3">
                    <span className="type-strong">{item.name}</span>
                    <span className="type-data nums">×{item.qty}</span>
                  </div>
                  <p className="type-caption text-ink-2">
                    <Code>{item.sku}</Code>
                  </p>
                  {item.serials && item.serials.length ? (
                    <p className="type-caption">
                      {t("parcel.serials")}{" "}
                      {item.serials.map((serial) => (
                        <Code key={serial} className="me-2">
                          {serial}
                        </Code>
                      ))}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            {parcel.sensitive ? <p className="type-caption text-ink-2">{t("parcel.sensitive")}</p> : null}
          </Section>

          <PackingSection parcel={parcel} />
          <ProofSection parcel={parcel} />

          <Section id="attempts" title={t("parcel.attempts")}>
            {parcel.attempts.length === 0 ? (
              <p className="type-body text-ink-2">{t("parcel.noAttempts")}</p>
            ) : (
              <ol role="list" className="grid gap-2">
                {parcel.attempts.map((attempt) => (
                  <li key={attempt.attemptNo} className="adm-card gap-1">
                    <p className="type-strong">
                      {t("parcel.attemptNo", { n: attempt.attemptNo })} · {t(`outcome.${attempt.outcome}`)}
                    </p>
                    <p className="type-caption text-ink-2">
                      <When at={attempt.attemptedAt} />
                      {attempt.recordedBy ? ` · ${attempt.recordedBy}` : ""}
                    </p>
                    {attempt.reason ? <p className="type-body">{attempt.reason}</p> : null}
                    {attempt.notes ? <p className="type-caption text-ink-2">{attempt.notes}</p> : null}
                    {attempt.nextAttemptAt ? (
                      <p className="type-caption">
                        {t("parcel.nextTry")} <When at={attempt.nextAttemptAt} kind="date" />
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section id="history" title={t("parcel.history")}>
            {parcel.events.length === 0 ? (
              <p className="type-body text-ink-2">{t("parcel.noHistory")}</p>
            ) : (
              <ol role="list" className="shp-timeline">
                {[...parcel.events].reverse().map((event) => (
                  <li key={event.id} data-auto={event.actor ? undefined : ""}>
                    <p className="type-label text-ink">{eventText(t, event.kind, event.data)}</p>
                    <p className="type-caption text-ink-2">
                      <When at={event.at} />
                      {event.actor ? ` · ${event.actor}` : ""}
                    </p>
                    {event.note ? <p className="type-caption text-ink">{event.note}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>

        <aside className="grid min-w-0 gap-4" aria-label={t("parcel.summary")}>
          <div className="adm-card">
            <h2 className="adm-h3">{t("parcel.delivery")}</h2>
            <Pair label={t("common.status")}>
              <ParcelStatus status={parcel.status} />
            </Pair>
            <Pair label={t("common.carrier")}>{parcel.carrier ? parcel.carrier.name : t("shipments.noCarrier")}</Pair>
            {parcel.carrier?.phone ? (
              <Pair label={t("parcel.carrierPhone")}>
                <a href={`tel:${parcel.carrier.phone.replace(/\s/g, "")}`} className="adm-link nums" dir="ltr">
                  {parcel.carrier.phone}
                </a>
              </Pair>
            ) : null}
            <Pair label={t("waybill.level")}>{parcel.serviceLevel ? t(`level.${parcel.serviceLevel}`) : "—"}</Pair>
            <Pair label={t("common.tracking")}>{parcel.trackingNo ? <Code>{parcel.trackingNo}</Code> : "—"}</Pair>
            {parcel.carrier?.trackingUrl ? (
              <a href={parcel.carrier.trackingUrl} target="_blank" rel="noopener noreferrer" className="adm-link type-label">
                {t("parcel.trackingPage")} <Icon name="arrow-square-out" size={14} className="inline align-[-2px]" />
              </a>
            ) : null}
            {"costIqd" in parcel ? (
              <Pair label={t("parcel.carrierCost")}>
                <Money iqd={parcel.costIqd} unknown={t("parcel.costUnknown")} />
              </Pair>
            ) : null}
            {"deliveryMarginIqd" in parcel ? (
              <Pair label={t("parcel.deliveryMargin")}>
                <Money iqd={parcel.deliveryMarginIqd} unknown={t("parcel.marginUnknown")} />
              </Pair>
            ) : null}
            <Pair label={t("parcel.shippedAt")}>
              <When at={parcel.shippedAt} />
            </Pair>
            <Pair label={t("parcel.deliveredAt")}>
              <When at={parcel.deliveredAt ?? parcel.returnedAt} />
            </Pair>
          </div>

          <div className="adm-card">
            <h2 className="adm-h3">{t("parcel.money")}</h2>
            <p className="type-body">
              <CodText cod={parcel.cod} status={parcel.status} />
            </p>
            {parcel.settlement ? (
              <p className="type-caption">
                {t("parcel.inSettlement")}{" "}
                {cod ? (
                  <Link to={`/admin/shipping/cod/${encodeURIComponent(parcel.settlement.id)}`} className="adm-link">
                    <Code>{parcel.settlement.ref}</Code>
                  </Link>
                ) : (
                  <Code>{parcel.settlement.ref}</Code>
                )}{" "}
                · {t(`settlementStatus.${parcel.settlement.status}`)}
              </p>
            ) : parcel.status === "delivered" || parcel.status === "returned" ? (
              <p className="type-caption text-ink-2">{t("parcel.notSettled")}</p>
            ) : null}
            <Pair label={t("parcel.orderPayment")}>{t(`paymentStatus.${parcel.order.paymentStatus}`)}</Pair>
          </div>

          <div className="adm-card">
            <h2 className="adm-h3">{t("parcel.recipient")}</h2>
            <p className="type-strong">{parcel.recipient.name ?? t("common.noName")}</p>
            <p>
              <PhoneText phone={parcel.recipient.phone} />
            </p>
            <p className="type-body">{[parcel.recipient.governorate, parcel.recipient.district, parcel.recipient.area].filter(Boolean).join(" · ")}</p>
            <p className="type-body">{parcel.recipient.address}</p>
            {parcel.recipient.notes ? <p className="type-caption text-ink-2">{parcel.recipient.notes}</p> : null}
            {parcel.order.preferredDay || parcel.order.preferredWindow ? (
              <p className="type-caption text-ink-2">
                {t("parcel.preferred", { day: parcel.order.preferredDay ?? "—", window: parcel.order.preferredWindow ? t(`window.${parcel.order.preferredWindow}`) : "—" })}
              </p>
            ) : null}
          </div>

          {parcel.parcels.length > 1 ? (
            <div className="adm-card">
              <h2 className="adm-h3">{t("parcel.others")}</h2>
              <ul role="list" className="grid gap-1">
                {parcel.parcels.map((other) => (
                  <li key={other.id} className="flex items-center justify-between gap-2">
                    {other.id === parcel.id ? (
                      <span className="type-label">{t("parcel.thisOne", { n: other.number })}</span>
                    ) : (
                      <Link to={`/admin/shipping/shipments/${encodeURIComponent(other.id)}`} className="adm-link type-label">
                        {t("parcel.numberN", { n: other.number })}
                      </Link>
                    )}
                    <ParcelStatus status={other.status} />
                  </li>
                ))}
              </ul>
              <p className="type-caption text-ink-2">{t("parcel.together")}</p>
            </div>
          ) : null}
        </aside>
      </div>

      <PickupDialog parcel={parcel} open={dialog === "pickup"} onClose={close} />
      <ReturningDialog parcel={parcel} open={dialog === "returning"} onClose={close} />
      <AttemptDialog parcel={parcel} open={dialog === "attempt"} onClose={close} />
      <DeliverDialog parcel={parcel} open={dialog === "deliver"} onClose={close} />
      <ReturnDialog parcel={parcel} open={dialog === "return"} onClose={close} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────── waybill (11.02 / 11.03)

function WaybillForm({ parcel, carriers }: { parcel: Parcel; carriers: { id: string; name: string; codSupported: boolean }[] }) {
  const t = useShipT();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const failure = useActionToast(fetcher, t("waybill.saved"));
  const [level, setLevel] = useState<string>(parcel.serviceLevel ?? "standard");
  const options = useMemo(() => parcel.carrierOptions.filter((option: CarrierOption) => option.serviceLevel === level), [parcel.carrierOptions, level]);
  const best = options.find((option) => option.eligible);
  const [carrierId, setCarrierId] = useState<string>(parcel.carrier?.id ?? best?.carrierId ?? "");
  const [cost, setCost] = useState<string>(parcel.costIqd != null ? String(parcel.costIqd) : best && !parcel.carrier ? String(best.costIqd) : "");
  const onRoad = parcel.status !== "pending" && parcel.status !== "packed";
  const collects = parcel.cod.kind === "collect";
  const others = carriers.filter((carrier) => !options.some((option) => option.carrierId === carrier.id));
  const fields = fetcher.data && !fetcher.data.ok ? fetcher.data.fields : undefined;
  return (
    <Section id="waybill" title={t("waybill.title")}>
      <p className="type-caption text-ink-2">{onRoad ? t("waybill.leadOnRoad") : t("waybill.lead")}</p>
      <fetcher.Form method="post" className="adm-card grid gap-4">
        <input type="hidden" name="intent" value="waybill" />
        <input type="hidden" name="from" value={parcel.status} />
        <Select name="serviceLevel" label={t("waybill.level")} value={level} onChange={(event) => setLevel(event.currentTarget.value)} options={SERVICE_LEVELS.map((value) => ({ value, label: t(`level.${value}`) }))} />
        <fieldset className="grid gap-2">
          <legend className="type-label mb-2">{t("waybill.carrier")}</legend>
          {options.length === 0 ? <p className="type-caption text-ink-2">{t("waybill.noRates")}</p> : null}
          <div className="shp-options">
            {options.map((option, index) => (
              <label key={`${option.carrierId}-${option.serviceLevel}`} className="shp-option" aria-disabled={!option.eligible}>
                <input
                  type="radio"
                  name="carrierId"
                  value={option.carrierId}
                  checked={carrierId === option.carrierId}
                  disabled={!option.eligible}
                  onChange={() => {
                    setCarrierId(option.carrierId);
                    setCost(String(option.costIqd));
                  }}
                />
                <span className="grid gap-0.5">
                  <span className="type-label">
                    {option.name}
                    {index === 0 && option.eligible ? <span className="type-caption text-ink-2"> · {t("waybill.cheapest")}</span> : null}
                  </span>
                  <span className="type-caption text-ink-2">
                    {option.etaDaysMin !== null && option.etaDaysMax !== null ? t("waybill.eta", { min: option.etaDaysMin, max: option.etaDaysMax }) : t("waybill.etaUnknown")}
                    {option.codFeeIqd > 0 ? ` · ${t("waybill.codFee", { fee: f.iqd(option.codFeeIqd) })}` : ""}
                    {option.eligible ? "" : ` · ${t("waybill.noCod")}`}
                  </span>
                </span>
                <span className="type-data nums">
                  <Money iqd={option.totalIqd} />
                </span>
              </label>
            ))}
          </div>
          {others.length ? (
            <Select
              label={t("waybill.otherCarrier")}
              hint={t("waybill.otherCarrierHint")}
              value={options.some((option) => option.carrierId === carrierId) ? "" : carrierId}
              onChange={(event) => {
                setCarrierId(event.currentTarget.value);
                setCost("");
              }}
              options={[{ value: "", label: t("common.none") }, ...others.map((carrier) => ({ value: carrier.id, label: collects && !carrier.codSupported ? `${carrier.name} (${t("waybill.noCod")})` : carrier.name, disabled: collects && !carrier.codSupported }))]}
            />
          ) : null}
          {!options.some((option) => option.carrierId === carrierId) && carrierId ? <input type="hidden" name="carrierId" value={carrierId} /> : null}
          {fields?.carrierId ? <p className="type-label text-red-ink">{fields.carrierId}</p> : null}
        </fieldset>
        <div className="shp-grid-form">
          <TextField name="trackingNo" label={t("waybill.tracking")} hint={t("waybill.trackingHint", { code: parcel.code })} defaultValue={parcel.trackingNo ?? ""} ltr spellCheck={false} maxLength={60} error={fields?.trackingNo} />
          <TextField name="costIqd" label={t("waybill.cost")} hint={t("waybill.costHint")} inputMode="numeric" value={cost} onChange={(event) => setCost(digitsOnly(event.currentTarget.value))} error={fields?.costIqd} />
          {onRoad ? <TextField name="reason" label={t("waybill.reason")} hint={t("waybill.reasonHint")} className="shp-wide" maxLength={500} error={fields?.reason} /> : null}
        </div>
        <p className="type-caption text-ink-2">
          <CodText cod={parcel.cod} />
        </p>
        <FormError message={failure} />
        <div>
          <Key type="submit" variant="ink" icon="floppy-disk" disabled={!carrierId} loading={fetcher.state !== "idle"}>
            {parcel.carrier ? t("waybill.update") : t("waybill.create")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── packing photos and proof of receipt (11.06)

function UploadForm({ intent, label, hint, submit, withName, defaultName }: { intent: "packing" | "proof"; label: string; hint: string; submit: string; withName?: boolean; defaultName?: string | null }) {
  const t = useShipT();
  const fetcher = useFetcher<typeof action>();
  const failure = useActionToast(fetcher, t(intent === "packing" ? "packing.saved" : "proof.saved"));
  return (
    <fetcher.Form method="post" encType="multipart/form-data" className="adm-card grid gap-3">
      <input type="hidden" name="intent" value={intent} />
      <label className="grid gap-1">
        <span className="type-label">{label}</span>
        <input type="file" name="file" accept="image/jpeg,image/png,image/webp" capture="environment" required className="type-body" />
        <span className="type-caption text-ink-2">{hint}</span>
      </label>
      {withName ? <TextField name="receivedByName" label={t("proof.receiver")} defaultValue={defaultName ?? ""} required maxLength={100} /> : <TextField name="note" label={t("packing.note")} optional maxLength={300} />}
      <FormError message={failure} />
      <div>
        <Key type="submit" icon="upload-simple" loading={fetcher.state !== "idle"}>
          {submit}
        </Key>
      </div>
    </fetcher.Form>
  );
}

function PackingSection({ parcel }: { parcel: Parcel }) {
  const t = useShipT();
  const atStore = parcel.status === "pending" || parcel.status === "packed";
  if (!parcel.sensitive && parcel.packingPhotos.length === 0 && !(parcel.can.proof && atStore)) return null;
  return (
    <Section id="packing" title={t("packing.title")}>
      <p className="type-caption text-ink-2">{parcel.sensitive ? t("packing.leadSensitive") : t("packing.lead")}</p>
      {parcel.packingPhotos.length ? (
        <ul role="list" className="shp-photos">
          {parcel.packingPhotos.map((photo) => (
            <li key={photo.fileId} className="grid gap-1">
              <a href={photo.url} target="_blank" rel="noopener noreferrer">
                <img src={photo.url} alt={t("packing.photoAlt", { code: parcel.code })} width={160} height={160} loading="lazy" />
              </a>
              <span className="type-caption text-ink-2">
                <When at={photo.at} />
                {photo.note ? ` · ${photo.note}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("packing.none")}</p>
      )}
      {parcel.can.proof && atStore ? <UploadForm intent="packing" label={t("packing.file")} hint={t("packing.fileHint")} submit={t("packing.add")} /> : null}
    </Section>
  );
}

function ProofSection({ parcel }: { parcel: Parcel }) {
  const t = useShipT();
  if (parcel.status !== "delivered") return null;
  return (
    <Section id="proof" title={t("proof.title")}>
      {parcel.proof ? (
        <div className="grid gap-2">
          <a href={parcel.proof.url} target="_blank" rel="noopener noreferrer" className="w-40">
            <img src={parcel.proof.url} alt={t("proof.photoAlt", { code: parcel.code })} width={160} height={160} loading="lazy" className="rounded-xs bg-niche" />
          </a>
          <p className="type-body">{t("proof.receivedBy", { name: parcel.proof.receivedByName ?? "—" })}</p>
        </div>
      ) : (
        <p className="type-body text-ink-2">{parcel.receivedByName ? t("proof.nameOnly", { name: parcel.receivedByName }) : t("proof.none")}</p>
      )}
      {parcel.can.proof ? <UploadForm intent="proof" label={t("proof.file")} hint={t("proof.fileHint")} submit={t("proof.add")} withName defaultName={parcel.receivedByName} /> : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── dialogs

function PickupDialog({ parcel, open, onClose }: { parcel: Parcel; open: boolean; onClose: () => void }) {
  const t = useShipT();
  const f = useFormat();
  const arrow = useArrow();
  const others = parcel.parcels.filter((other) => other.id !== parcel.id).length;
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      tone="commit"
      title={t("pickupDialog.title", { code: parcel.code })}
      consequence={t("pickupDialog.consequence", { ref: parcel.order.ref, carrier: parcel.carrier?.name ?? "—" })}
      confirmLabel={t("parcel.pickup")}
      impact={[
        { label: t("pickupDialog.order"), value: `${t(`orderStatus.${parcel.order.status}`)} ${arrow} ${t("orderStatus.shipped")}` },
        { label: t("pickupDialog.parcels"), value: f.number(others + 1) },
        { label: t("pickupDialog.stock"), value: t("pickupDialog.stockValue"), negative: true },
        { label: t("pickupDialog.cash"), value: parcel.cod.kind === "collect" ? f.iqd(parcel.cod.amountIqd) : t(`cod.${parcel.cod.kind === "with_first" ? "withFirst" : parcel.cod.kind}`) },
      ]}
      fields={{ intent: "pickup", from: parcel.status }}
      successMessage={t("pickupDialog.done")}
    />
  );
}

function ReturningDialog({ parcel, open, onClose }: { parcel: Parcel; open: boolean; onClose: () => void }) {
  const t = useShipT();
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t("returningDialog.title", { code: parcel.code })}
      consequence={t("returningDialog.consequence")}
      confirmLabel={t("move.returning")}
      reason={{ label: t("returningDialog.reason"), hint: t("returningDialog.hint") }}
      fields={{ intent: "move", to: "returning", from: parcel.status }}
      successMessage={t("parcel.moved")}
    />
  );
}

function AttemptDialog({ parcel, open, onClose }: { parcel: Parcel; open: boolean; onClose: () => void }) {
  const t = useShipT();
  const [day, setDay] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      title={t("attemptDialog.title", { code: parcel.code })}
      consequence={t("attemptDialog.consequence", { n: parcel.attempts.filter((attempt) => attempt.outcome !== "delivered").length + 1 })}
      confirmLabel={t("parcel.attempt")}
      reason={{ codes: FAILURE_OUTCOMES.map((value) => ({ value, label: t(`outcome.${value}`) })), codeLabel: t("attemptDialog.outcome"), noteRequired: false, label: t("attemptDialog.reason"), hint: t("attemptDialog.reasonHint") }}
      fields={{ intent: "attempt", from: parcel.status, nextAttemptDay: day, notes }}
      successMessage={t("attemptDialog.done")}
    >
      <div className="grid gap-3">
        <TextField type="date" label={t("attemptDialog.nextDay")} hint={t("attemptDialog.nextDayHint")} value={day} onChange={(event) => setDay(event.currentTarget.value)} ltr />
        <TextArea label={t("attemptDialog.notes")} optional value={notes} onChange={(event) => setNotes(event.currentTarget.value)} rows={2} maxLength={500} />
      </div>
    </ActionDialog>
  );
}

function DeliverDialog({ parcel, open, onClose }: { parcel: Parcel; open: boolean; onClose: () => void }) {
  const t = useShipT();
  const fetcher = useFetcher<typeof action>();
  const others = parcel.parcels.filter((other) => other.id !== parcel.id && other.status !== "delivered").length;
  const deliversOrder = others === 0 && parcel.order.status === "shipped";
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(deliversOrder ? t("deliverDialog.doneOrder") : t("deliverDialog.done"));
      onClose();
    }
  }, [fetcher.data, fetcher.state, deliversOrder, onClose, t]);
  const done = false;
  const failure = fetcher.state === "idle" && fetcher.data && !fetcher.data.ok ? failureText(t, fetcher.data) : null;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    fetcher.submit(new FormData(event.currentTarget), { method: "post", encType: "multipart/form-data" });
  };
  return (
    <Dialog
      open={open && !done}
      onClose={onClose}
      dismissible={fetcher.state === "idle"}
      title={t("deliverDialog.title", { code: parcel.code })}
      description={deliversOrder ? t("deliverDialog.consequenceOrder", { ref: parcel.order.ref }) : t("deliverDialog.consequence", { count: others })}
      onSubmit={submit}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"}>
            {t("common.back")}
          </Key>
          <Key type="submit" variant="ink" icon="check-circle" loading={fetcher.state !== "idle"}>
            {t("parcel.deliver")}
          </Key>
        </>
      }
    >
      <input type="hidden" name="intent" value="deliver" />
      <input type="hidden" name="from" value={parcel.status} />
      <div className="grid gap-3">
        {deliversOrder ? (
          <ul className="grid gap-1 type-caption text-ink-2">
            <li>{t("deliverDialog.impactWarranty")}</li>
            <li>{t("deliverDialog.impactRevenue")}</li>
            {parcel.cod.kind === "collect" ? <li>{t("deliverDialog.impactCash")}</li> : null}
          </ul>
        ) : null}
        <TextField name="receivedByName" label={t("proof.receiver")} required={parcel.sensitive} optional={!parcel.sensitive} hint={parcel.sensitive ? t("deliverDialog.receiverRequired") : undefined} maxLength={100} />
        {parcel.can.proof ? (
          <label className="grid gap-1">
            <span className="type-label">{t("proof.file")}</span>
            <input type="file" name="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="type-body" />
            <span className="type-caption text-ink-2">{t("proof.fileHint")}</span>
          </label>
        ) : null}
        <TextArea name="note" label={t("deliverDialog.note")} optional rows={2} maxLength={500} />
        <FormError message={failure} />
      </div>
    </Dialog>
  );
}

function ReturnDialog({ parcel, open, onClose }: { parcel: Parcel; open: boolean; onClose: () => void }) {
  const t = useShipT();
  const f = useFormat();
  const arrow = useArrow();
  const [disp, setDisp] = useState<Record<string, "restock" | "scrap">>({});
  const fields: Record<string, string> = { intent: "receive_return" };
  for (const line of parcel.returnLines) fields[`disp:${line.orderItemId}`] = disp[line.orderItemId] ?? "restock";
  const scrapped = parcel.returnLines.filter((line) => (disp[line.orderItemId] ?? "restock") === "scrap");
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      tone="destructive"
      title={t("returnDialog.title", { ref: parcel.order.ref })}
      consequence={t("returnDialog.consequence")}
      confirmLabel={t("parcel.receiveReturn")}
      impact={[
        { label: t("returnDialog.order"), value: `${t("orderStatus.shipped")} ${arrow} ${t("orderStatus.returned")}` },
        { label: t("returnDialog.restocked"), value: String(parcel.returnLines.length - scrapped.length) },
        { label: t("returnDialog.scrapped"), value: String(scrapped.length), negative: scrapped.length > 0 },
        {
          // the money this return moves, with the amount where this page knows it exactly (the pending cash on delivery)
          label: t("returnDialog.money"),
          value:
            parcel.cod.kind === "collect"
              ? `${t("returnDialog.cashCancelled")} · ${f.iqd(parcel.cod.amountIqd)}`
              : parcel.cod.kind === "with_first"
                ? t("returnDialog.cashCancelled")
                : parcel.cod.kind === "unpaid"
                  ? t("returnDialog.noMoney")
                  : t("returnDialog.refundPending"),
          negative: parcel.cod.kind === "collect",
        },
      ]}
      reason={{ label: t("returnDialog.reason"), hint: t("returnDialog.reasonHint") }}
      fields={fields}
      successMessage={t("returnDialog.done")}
    >
      <fieldset className="grid gap-2">
        <legend className="type-label mb-1">{t("returnDialog.lines")}</legend>
        {parcel.returnLines.map((line) => (
          <Select
            key={line.orderItemId}
            label={`${line.name} ×${line.qty}`}
            value={disp[line.orderItemId] ?? "restock"}
            onChange={(event) => setDisp((current) => ({ ...current, [line.orderItemId]: event.currentTarget.value === "scrap" ? "scrap" : "restock" }))}
            options={[
              { value: "restock", label: t("returnDialog.restock") },
              { value: "scrap", label: t("returnDialog.scrap") },
            ]}
          />
        ))}
      </fieldset>
    </ActionDialog>
  );
}

/** Event kinds with their own sentence; anything else (a kind another module writes) says "updated: <kind>". */
const KNOWN_EVENTS = new Set([
  "scan",
  "scan_manual",
  "scan_rejected",
  "split",
  "packed",
  "waybill",
  "handed_over",
  "in_transit",
  "out_for_delivery",
  "retry",
  "attempt_failed",
  "returning",
  "delivered",
  "returned",
  "cancelled",
  "packing_photo",
  "delivery_proof",
  "cod_settled",
]);

function eventText(t: (key: string, vars?: Record<string, string | number>) => string, kind: string, data: Record<string, string | number | boolean | null>): string {
  const vars: Record<string, string | number> = { kind };
  for (const [key, value] of Object.entries(data)) vars[key] = value === null ? "—" : typeof value === "boolean" ? String(value) : value;
  if (kind === "attempt_failed" && typeof data.outcome === "string") vars.outcome = t(`outcome.${data.outcome}`);
  if (kind === "waybill" && typeof data.serviceLevel === "string") vars.serviceLevel = t(`level.${data.serviceLevel}`);
  return KNOWN_EVENTS.has(kind) ? t(`event.${kind}`, vars) : t("event.other", vars);
}
