/**
 * The sections of the trade-in page (/admin/devices/trade-ins/:ref). Every change is a POST to the page's action (one
 * intent each, trade-in.server.ts) through a fetcher; money and offers open the confirm-with-reason dialog that shows
 * their impact first. Forms work without JavaScript where they are plain forms (the inspection, the price difference).
 */
import { useState } from "react";
import { Form, Link } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { GRADE_LIST, MAX_OFFER_IQD, OFFER_VALID_DAYS, PIPELINE_STEPS, baghdadParts, parseWhole, pipelineStep, type TradeInDetail } from "~/server/services/admin/devices/types";
import { ConfirmDialog, Dialog, type ImpactRow } from "~/ui/Dialog";
import { Checkbox, FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { Check, ChecklistFields, ChecklistTable, Facts, Failure, GradeTag, Money, Name, PhoneText, Ref, Section, useDevicesT, useIntent, When } from "./ui";

type Props = { ti: TradeInDetail };

// ───────────────────────────────────────────────────────────────── the workflow

export function PipelineSection({ ti }: Props) {
  const t = useDevicesT();
  const current = pipelineStep({ status: ti.status, inspected: ti.inspection !== null, dataWiped: ti.dataWiped, unitListed: ti.usedUnit?.status === "listed" || ti.usedUnit?.status === "reserved" || ti.usedUnit?.status === "sold" });
  return (
    <div className="dev-noprint min-w-0 overflow-x-auto">
      <ProgressSteps aria-label={t("detail.workflow")} steps={PIPELINE_STEPS.map((step) => ({ label: t(`step.${step}`) }))} current={Math.min(current, PIPELINE_STEPS.length - 1)} />
      {ti.status === "cancelled" ? <p className="mt-2 type-caption text-ink-2">{t("detail.cancelledNote")}</p> : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── the next step

export function ActionsSection({ ti }: Props) {
  const t = useDevicesT();
  const can = ti.can;
  const any = can.schedule || can.offer || can.answer || can.wipe || can.payout || can.cancel;
  return (
    <section className="adm-section dev-noprint" aria-labelledby="ti-actions">
      <h2 id="ti-actions" className="adm-h2">
        {t("detail.next")}
      </h2>
      <p className="type-body">{t(`next.${ti.offerExpired ? "expired" : ti.status}`)}</p>
      <div className="dev-actions">
        {can.schedule ? <ScheduleButton ti={ti} /> : null}
        {can.inspect ? (
          <Key as="a" href="#ti-inspection" size="sm" icon="clipboard-text">
            {ti.inspection ? t("inspect.again") : t("inspect.start")}
          </Key>
        ) : null}
        {can.offer ? <OfferButton ti={ti} /> : null}
        {can.answer ? <AnswerButtons ti={ti} /> : null}
        {can.wipe ? <WipeButton ti={ti} /> : null}
        {can.payout ? <PayoutButton ti={ti} /> : null}
        {can.cancel ? <CancelButton ti={ti} /> : null}
        <Key as={Link} to={`/admin/devices/trade-ins/${ti.ref}/print`} size="sm" icon="printer">
          {t("detail.print")}
        </Key>
      </div>
      {can.offer && ti.offerBlockers.length > 0 ? <Blockers title={t("offer.blockedTitle")} keys={ti.offerBlockers} /> : null}
      {can.payout && ti.payoutBlockers.length > 0 ? <Blockers title={t("payout.blockedTitle")} keys={ti.payoutBlockers} /> : null}
      {ti.usedUnit ? (
        <p className="flex items-center gap-1 type-body">
          <Icon name="game-controller" size={16} />
          <Link to={`/admin/devices/used/${ti.usedUnit.id}`} className="adm-link">
            {t("detail.usedUnit", { status: t(`usedStatus.${ti.usedUnit.status}`) })}
          </Link>
        </p>
      ) : null}
      {!any && !ti.usedUnit ? <p className="type-caption text-ink-2">{t("detail.noActions")}</p> : null}
    </section>
  );
}

function Blockers({ title, keys }: { title: string; keys: string[] }) {
  const t = useDevicesT();
  return (
    <div className="grid gap-1">
      <p className="type-label">{title}</p>
      <ul className="dev-blockers">
        {keys.map((key) => (
          <li key={key}>
            <Icon name="warning" size={16} className="mt-0.5 flex-none text-warn" />
            <span>{t(`errors.${key}`)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ScheduleButton({ ti }: Props) {
  const t = useDevicesT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message, fields } = useIntent("schedule", "done.scheduled", () => setOpen(false));
  // Moving an appointment starts from the booked one; a first booking from the day the customer asked for.
  const booked = ti.inspectionAt !== null ? baghdadParts(ti.inspectionAt) : null;
  const initialDay = booked?.day ?? ti.preferred?.day ?? "";
  return (
    <>
      <Key size="sm" icon="calendar-blank" onClick={() => setOpen(true)}>
        {ti.inspectionAt ? t("schedule.move") : t("schedule.open")}
      </Key>
      <Dialog
        open={open}
        onClose={() => (pending ? undefined : setOpen(false))}
        title={t("schedule.title", { ref: ti.ref })}
        description={t("schedule.what")}
        dismissible={!pending}
        onSubmit={(event) => {
          event.preventDefault();
          fetcher.submit(new FormData(event.currentTarget), { method: "post" });
        }}
        footer={
          <>
            <Key onClick={() => setOpen(false)} disabled={pending}>
              {t("back")}
            </Key>
            <Key type="submit" variant="ink" loading={pending}>
              {t("schedule.confirm")}
            </Key>
          </>
        }
      >
        <input type="hidden" name="intent" value="schedule" />
        <div className="grid gap-3">
          {ti.preferred?.day || ti.preferred?.window ? <p className="type-caption text-ink-2">{t("schedule.preferred", { day: ti.preferred.day ?? "—", window: ti.preferred.window ? t(`window.${ti.preferred.window}`) : "—" })}</p> : null}
          <div className="dev-grid-2">
            <TextField name="day" type="date" label={t("schedule.day")} required defaultValue={initialDay} ltr error={fields.day} />
            <TextField name="time" type="time" label={t("schedule.time")} required defaultValue={booked?.time ?? "12:00"} ltr error={fields.time} />
          </div>
          <TextField name="note" label={t("schedule.note")} optional error={fields.note} />
          <Failure message={message} />
        </div>
      </Dialog>
    </>
  );
}

function OfferButton({ ti }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const suggested = ti.valuation?.suggestedIqd ?? null;
  const [amount, setAmount] = useState(String(ti.offer?.amountIqd ?? suggested ?? ""));
  const [days, setDays] = useState("7");
  const { fetcher, pending, message, fields } = useIntent("offer", "done.offered", () => setOpen(false));
  const typed = parseWhole(amount);
  const valid = typeof typed === "number" && Number.isFinite(typed) && typed > 0 && typed <= MAX_OFFER_IQD;
  const above = valid && (suggested === null || typed > suggested);
  const blocked = ti.offerBlockers.length > 0;
  const impact: ImpactRow[] = [
    { label: t("offer.amount"), value: valid ? f.iqd(typed as number) : "—" },
    { label: t("offer.suggested"), value: suggested !== null ? f.iqd(suggested) : t("offer.noGuide") },
    { label: t("offer.validFor"), value: t("offer.days", { count: parseWhole(days) ?? 0 }) },
  ];
  return (
    <>
      <Key size="sm" variant="ink" icon="scales" onClick={() => setOpen(true)} disabled={blocked} aria-describedby={blocked ? "ti-offer-blocked" : undefined}>
        {ti.offer ? t("offer.again") : t("offer.open")}
      </Key>
      {blocked ? (
        <span id="ti-offer-blocked" className="sr-only">
          {t("offer.blockedTitle")}
        </span>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("offer.title", { ref: ti.ref })}
        consequence={t("offer.what")}
        confirmLabel={ti.offer ? t("offer.again") : t("offer.open")}
        impact={impact}
        reason={{ label: t("offer.note"), noteRequired: false, minLength: 0, hint: t("offer.noteHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "offer", amountIqd: amount, validDays: days, note: reason }, { method: "post" })}
      >
        <div className="grid gap-3">
          <TextField label={t("offer.amount")} inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} required ltr error={fields.amountIqd} hint={t("offer.amountHint")} end={<span className="type-caption">{t("iqd")}</span>} />
          <TextField label={t("offer.validDays")} inputMode="numeric" value={days} onChange={(event) => setDays(event.target.value)} required ltr error={fields.validDays} hint={t("offer.validHint", { min: OFFER_VALID_DAYS.min, max: OFFER_VALID_DAYS.max })} />
          {above || ti.can.ownGuide ? (
            <p className="flex items-start gap-1 type-caption">
              <Icon name="users" size={16} className="mt-0.5 flex-none text-warn" />
              {above ? t("offer.aboveGuide") : t("offer.ownGuide")}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

function AnswerButtons({ ti }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  const [mode, setMode] = useState<"accept" | "decline" | null>(null);
  const [payout, setPayout] = useState<"cash" | "store_credit">(ti.customer.hasAccount ? "store_credit" : "cash");
  const { fetcher, pending, message, fields } = useIntent("answer", (result) => (result.status === "accepted" ? "done.accepted" : "done.declined"), () => setMode(null));
  return (
    <>
      <Key size="sm" icon="check" onClick={() => setMode("accept")}>
        {t("answer.accept")}
      </Key>
      <Key size="sm" icon="x" onClick={() => setMode("decline")}>
        {t("answer.decline")}
      </Key>
      <ConfirmDialog
        open={mode !== null}
        onClose={() => setMode(null)}
        tone={mode === "decline" ? "destructive" : "neutral"}
        title={mode === "accept" ? t("answer.acceptTitle") : t("answer.declineTitle")}
        consequence={mode === "accept" ? t("answer.acceptWhat", { amount: ti.offer ? f.iqd(ti.offer.amountIqd) : "—" }) : t("answer.declineWhat")}
        confirmLabel={mode === "accept" ? t("answer.accept") : t("answer.decline")}
        reason={mode === "decline" ? { label: t("answer.reason"), noteRequired: false, minLength: 0 } : undefined}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit(mode === "accept" ? { intent: "answer", decision: "accept", payout } : { intent: "answer", decision: "decline", reason }, { method: "post" })}
      >
        {mode === "accept" ? (
          <FieldGroup legend={t("answer.payout")} error={fields.payout}>
            <Radio row name="payout-choice" value="store_credit" label={t("payout.store_credit")} hint={ti.customer.hasAccount ? t("answer.creditHint") : t("answer.creditNeedsAccount")} checked={payout === "store_credit"} disabled={!ti.customer.hasAccount} onChange={() => setPayout("store_credit")} />
            <Radio row name="payout-choice" value="cash" label={t("payout.cash")} hint={t("answer.cashHint")} checked={payout === "cash"} onChange={() => setPayout("cash")} />
          </FieldGroup>
        ) : null}
        <p className="type-caption text-ink-2">{t("answer.inPerson")}</p>
      </ConfirmDialog>
    </>
  );
}

function WipeButton({ ti }: Props) {
  const t = useDevicesT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("wipe", "done.wiped", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="shield-check" onClick={() => setOpen(true)}>
        {t("wipe.open")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("wipe.title")}
        consequence={t("wipe.what")}
        confirmLabel={t("wipe.confirm")}
        reason={{ label: t("wipe.note"), noteRequired: false, minLength: 0, hint: t("wipe.noteHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "wipe", note: reason }, { method: "post" })}
      >
        <ul className="dev-blockers">
          {(["accounts", "reset", "lock"] as const).map((key) => (
            <li key={key}>
              <Icon name="check" size={16} className="mt-0.5 flex-none" />
              <span>{t(`wipe.steps.${key}`)}</span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </>
  );
}

function PayoutButton({ ti }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const chosen = ti.payout.method;
  const [method, setMethod] = useState<"cash" | "store_credit">(chosen ?? (ti.customer.hasAccount ? "store_credit" : "cash"));
  const [locationId, setLocationId] = useState(ti.locations[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const { fetcher, pending, message, fields } = useIntent("payout", "done.paid", () => setOpen(false));
  const amount = ti.offer?.amountIqd ?? 0;
  const blocked = ti.payoutBlockers.filter((key) => key !== "payout_method_required").length > 0;
  const changed = chosen !== null && method !== chosen;
  const impact: ImpactRow[] = [
    method === "store_credit" ? { label: t("payout.walletCredit"), value: `+${f.iqd(amount)}` } : { label: t("payout.cashOut"), value: `−${f.iqd(amount)}`, negative: true },
    { label: t("payout.inventory"), value: `+${f.iqd(amount)}` },
    { label: t("payout.unit"), value: t("payout.unitWhat") },
  ];
  return (
    <>
      <Key size="sm" variant="ink" icon="hand-coins" onClick={() => setOpen(true)} disabled={blocked}>
        {t("payout.open")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("payout.title", { ref: ti.ref })}
        consequence={t("payout.what", { amount: f.iqd(amount) })}
        confirmLabel={t("payout.confirm")}
        impact={impact}
        pending={pending}
        error={message}
        onConfirm={() => fetcher.submit({ intent: "payout", method, locationId, reason }, { method: "post" })}
      >
        <div className="grid gap-3">
          <FieldGroup legend={t("payout.method")} error={fields.method}>
            <Radio row name="payout-method" value="store_credit" label={t("payout.store_credit")} hint={ti.customer.hasAccount ? t("answer.creditHint") : t("answer.creditNeedsAccount")} checked={method === "store_credit"} disabled={!ti.customer.hasAccount} onChange={() => setMethod("store_credit")} />
            <Radio row name="payout-method" value="cash" label={t("payout.cash")} hint={t("answer.cashHint")} checked={method === "cash"} onChange={() => setMethod("cash")} />
          </FieldGroup>
          {changed ? <TextField label={t("payout.changeReason")} required value={reason} onChange={(event) => setReason(event.target.value)} error={fields.reason} hint={t("payout.changeHint", { method: t(`payout.${chosen}`) })} /> : null}
          <Select label={t("payout.location")} value={locationId} onChange={(event) => setLocationId(event.target.value)} error={fields.locationId} options={ti.locations.map((location) => ({ value: location.id, label: `${location.code} · ${location.name}` }))} />
          {ti.can.payoutNeedsSecond ? <p className="type-caption text-ink-2">{t("payout.secondPersonNote")}</p> : null}
        </div>
      </ConfirmDialog>
    </>
  );
}

function CancelButton({ ti }: Props) {
  const t = useDevicesT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("cancel", "done.cancelled", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="x-circle" onClick={() => setOpen(true)}>
        <span className="text-red-ink">{t("cancelTi.open")}</span>
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("cancelTi.title", { ref: ti.ref })}
        consequence={t("cancelTi.what")}
        confirmLabel={t("cancelTi.open")}
        reason={{ label: t("cancelTi.reason"), hint: t("cancelTi.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "cancel", reason }, { method: "post" })}
      />
    </>
  );
}

// ───────────────────────────────────────────────────────────────── facts

export function FactsSection({ ti }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  const answers = Object.entries(ti.answers).filter(([key]) => ["power", "body", "screen", "account", "missing", "included"].includes(key));
  return (
    <Section id="ti-facts" title={t("detail.facts")}>
      <Facts
        rows={[
          { label: t("detail.customer"), value: ti.customer.name ?? t("noName") },
          { label: t("detail.phone"), value: <PhoneText phone={ti.customer.phone} /> },
          { label: t("detail.account"), value: ti.customer.hasAccount ? t("detail.hasAccount") : t("detail.guest") },
          { label: t("detail.device"), value: <Name text={ti.device.variant?.label ?? ti.device.modelName ?? ti.device.text ?? "—"} /> },
          { label: t("detail.sku"), value: ti.device.variant ? <Ref value={ti.device.variant.sku} /> : t("detail.variantLater"), hidden: !ti.device.variant && !ti.device.modelName },
          { label: t("detail.checklistKind"), value: t(`kind.${ti.device.kind}`) },
          { label: t("detail.source"), value: t(ti.counter ? "source.counter" : "source.online") },
          { label: t("detail.created"), value: <When at={ti.createdAt} /> },
          { label: t("detail.estimate"), value: ti.estimate ? <span><Money iqd={ti.estimate.minIqd} /> – <Money iqd={ti.estimate.maxIqd} /></span> : t("tradeIns.noEstimate") },
          { label: t("detail.estimateUntil"), value: <When at={ti.estimate?.expiresAt ?? null} style="date" />, hidden: !ti.estimate?.expiresAt },
          { label: t("detail.preferred"), value: ti.preferred ? `${ti.preferred.day ?? "—"} · ${ti.preferred.window ? t(`window.${ti.preferred.window}`) : "—"}` : "—" },
          { label: t("detail.inspectionAt"), value: <When at={ti.inspectionAt} /> },
          { label: t("detail.customerNotes"), value: ti.preferred?.notes ?? "—", hidden: !ti.preferred?.notes },
        ]}
      />
      {answers.length > 0 ? (
        <div className="grid gap-1">
          <p className="type-label">{t("detail.answers")}</p>
          <ul className="grid gap-1 type-body">
            {answers.map(([key, value]) => (
              <li key={key}>
                <span className="text-ink-2">{t(`answers.labels.${key}`)}:</span>{" "}
                {key === "missing" || key === "included" ? value.split(",").filter(Boolean).map((item) => t(`accessory.${item}`)).join("، ") || "—" : t(`answers.${key}.${value}`)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {ti.serialOrigin ? (
        <p className="flex items-start gap-1 type-body">
          <Icon name="info" size={16} className="mt-0.5 flex-none text-info" />
          <span>
            {t("detail.serialOrigin", { order: ti.serialOrigin.orderRef ?? "—" })}
            {ti.serialOrigin.warrantyEndsAt ? ` ${t("detail.serialWarranty", { date: f.date(ti.serialOrigin.warrantyEndsAt) })}` : ""}
          </span>
        </p>
      ) : null}
    </Section>
  );
}

export function OfferSection({ ti }: Props) {
  const t = useDevicesT();
  if (!ti.offer) return null;
  return (
    <Section id="ti-offer" title={t("detail.offer")}>
      <dl className="dev-ledger">
        <div className="is-total">
          <dt>{t("offer.amount")}</dt>
          <dd>
            <Money iqd={ti.offer.amountIqd} />
          </dd>
        </div>
        <div>
          <dt>{t("offer.validUntil")}</dt>
          <dd>
            <When at={ti.offer.expiresAt} />
          </dd>
        </div>
        <div>
          <dt>{t("offer.by")}</dt>
          <dd>{ti.offer.offeredBy ?? "—"}</dd>
        </div>
        <div>
          <dt>{t("offer.at")}</dt>
          <dd>
            <When at={ti.offer.offeredAt} />
          </dd>
        </div>
        {ti.payout.method ? (
          <div>
            <dt>{t("payout.method")}</dt>
            <dd>{t(`payout.${ti.payout.method}`)}</dd>
          </div>
        ) : null}
        {ti.payout.paidAt ? (
          <div>
            <dt>{t("payout.paidAt")}</dt>
            <dd>
              <When at={ti.payout.paidAt} />
            </dd>
          </div>
        ) : null}
        {ti.declineReason ? (
          <div>
            <dt>{t("answer.reason")}</dt>
            <dd>{ti.declineReason}</dd>
          </div>
        ) : null}
      </dl>
      {ti.offerExpired ? <p className="type-caption text-ink-2">{t("offer.expiredNote")}</p> : null}
      <p className="type-caption text-ink-2">
        <Check value={ti.dataWiped} yes={t("wipe.done")} no={t("wipe.notDone")} unknown={t("wipe.notDone")} />
      </p>
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── inspection (13.02, 13.08, 13.09)

export function InspectionSection({ ti }: Props) {
  const t = useDevicesT();
  const insp = ti.inspection;
  return (
    <Section id="ti-inspection" title={t("detail.inspection")}>
      {insp ? (
        <div className="grid gap-3">
          <Facts
            rows={[
              { label: t("inspect.grade"), value: <GradeTag grade={insp.grade} /> },
              { label: t("inspect.serial"), value: insp.serial ? <Ref value={insp.serial} /> : "—" },
              { label: t("inspect.battery"), value: insp.batteryPct !== null ? <bdi className="nums">{insp.batteryPct} %</bdi> : t("checklist.notMeasurable") },
              { label: t("inspect.included"), value: insp.included.length ? insp.included.map((key) => t(`accessory.${key}`)).join("، ") : t("inspect.nothingIncluded") },
              { label: t("inspect.ownership"), value: <Check value={ti.ownershipOk} yes={t("inspect.ownershipYes")} no={t("inspect.ownershipNo")} unknown={t("inspect.notChecked")} /> },
              { label: t("inspect.lock"), value: <Check value={ti.accountLockOk} yes={t("inspect.lockYes")} no={t("inspect.lockNo")} unknown={t("inspect.notChecked")} /> },
              { label: t("inspect.by"), value: insp.inspectedBy ?? "—" },
              { label: t("inspect.at"), value: <When at={insp.inspectedAt} /> },
              { label: t("inspect.notes"), value: insp.notes ?? "—", hidden: !insp.notes },
            ]}
          />
          <ChecklistTable checklist={insp.checklist} />
        </div>
      ) : (
        <p className="type-body text-ink-2">{t("inspect.none")}</p>
      )}
      {ti.can.inspect ? <InspectionForm ti={ti} /> : null}
    </Section>
  );
}

function InspectionForm({ ti }: Props) {
  const t = useDevicesT();
  const { fetcher, pending, message, fields } = useIntent("inspect", (result) => (result.status === "complete" ? "done.inspected" : "done.inspectedPartial"));
  const insp = ti.inspection;
  const form = ti.checklistForm;
  if (!form.templateId) return <p className="type-body text-ink-2">{t("checklist.noTemplateFor", { kind: t(`kind.${ti.device.kind}`) })}</p>;
  return (
    <Disclose title={insp ? t("inspect.again") : t("inspect.start")} defaultOpen={!insp}>
      <fetcher.Form method="post" className="grid gap-4" noValidate>
        <input type="hidden" name="intent" value="inspect" />
        <input type="hidden" name="templateId" value={form.templateId} />
        <div className="dev-grid-2">
          <Select
            name="variantId"
            label={t("inspect.variant")}
            required
            defaultValue={ti.device.variant?.id ?? ""}
            error={fields.variantId}
            hint={t("inspect.variantHint")}
            options={[{ value: "", label: t("inspect.chooseVariant") }, ...ti.variants.map((variant) => ({ value: variant.id, label: `${variant.label} · ${variant.sku}` }))]}
          />
          <TextField name="serial" label={t("inspect.serial")} hint={t("inspect.serialHint")} defaultValue={insp?.serial ?? ""} ltr autoComplete="off" error={fields.serial} />
          <Select name="grade" label={t("inspect.grade")} defaultValue={insp?.grade ?? ""} error={fields.grade} hint={t("inspect.gradeHint")} options={[{ value: "", label: t("grade.none") }, ...GRADE_LIST.map((grade) => ({ value: grade, label: `${grade} · ${t(`gradeWord.${grade}`)}` }))]} />
        </div>
        <ChecklistFields checklist={form} errors={fields} />
        {ti.accessories.length > 0 ? (
          <FieldGroup legend={t("inspect.included")} hint={t("inspect.includedHint")} layout="row">
            {[...ti.accessories, "original_box"].map((key) => (
              <Checkbox key={key} name="included" value={key} label={t(`accessory.${key}`)} defaultChecked={insp ? insp.included.includes(key) : (ti.answers.included ?? "").split(",").includes(key)} />
            ))}
          </FieldGroup>
        ) : null}
        {ti.can.verify ? (
          <div className="dev-grid-2">
            <FieldGroup legend={t("inspect.ownership")} hint={t("inspect.ownershipHint")} required error={fields.ownershipOk}>
              <Radio name="ownershipOk" value="yes" label={t("inspect.ownershipYes")} defaultChecked={ti.ownershipOk === true} />
              <Radio name="ownershipOk" value="no" label={t("inspect.ownershipNo")} defaultChecked={ti.ownershipOk === false} />
            </FieldGroup>
            <FieldGroup legend={t("inspect.lock")} hint={t("inspect.lockHint")} required error={fields.accountLockOk}>
              <Radio name="accountLockOk" value="yes" label={t("inspect.lockYes")} defaultChecked={ti.accountLockOk === true} />
              <Radio name="accountLockOk" value="no" label={t("inspect.lockNo")} defaultChecked={ti.accountLockOk === false} />
            </FieldGroup>
          </div>
        ) : (
          // 13.08: confirming ownership and the lock is devices.ownership.verify's — shown here, not asked.
          <div className="grid gap-1">
            <Facts
              rows={[
                { label: t("inspect.ownership"), value: <Check value={ti.ownershipOk} yes={t("inspect.ownershipYes")} no={t("inspect.ownershipNo")} unknown={t("inspect.notChecked")} /> },
                { label: t("inspect.lock"), value: <Check value={ti.accountLockOk} yes={t("inspect.lockYes")} no={t("inspect.lockNo")} unknown={t("inspect.notChecked")} /> },
              ]}
            />
            <p className="type-caption text-ink-2">{t("inspect.verifyOnly")}</p>
          </div>
        )}
        <TextArea name="notes" label={t("inspect.notes")} optional defaultValue={insp?.notes ?? ""} error={fields.notes} />
        <Failure message={fields.templateId ?? message} />
        <div className="dev-actions">
          <Key type="submit" variant="ink" icon="floppy-disk" loading={pending}>
            {t("inspect.save")}
          </Key>
        </div>
      </fetcher.Form>
    </Disclose>
  );
}

function Disclose({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details className="grid gap-3" open={defaultOpen}>
      <summary className="cursor-pointer type-strong">{title}</summary>
      <div className="pt-3">{children}</div>
    </details>
  );
}

// ───────────────────────────────────────────────────────────────── valuation (13.03) and price difference (13.04)

export function ValuationSection({ ti }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  const v = ti.valuation;
  return (
    <Section id="ti-valuation" title={t("valuation.title")}>
      <p className="type-caption text-ink-2">{t("valuation.lead")}</p>
      {v ? (
        <dl className="dev-ledger">
          <div>
            <dt>{t("valuation.base")}</dt>
            <dd>
              <Money iqd={v.baseIqd} />
            </dd>
          </div>
          <div>
            <dt>{t("valuation.grade", { grade: v.grade, share: v.multiplierBps !== null ? f.number(v.multiplierBps / 100) : "—" })}</dt>
            <dd>
              <Money iqd={v.gradeValueIqd} />
            </dd>
          </div>
          {v.deductions.map((line) => (
            <div key={line.key}>
              <dt>{t("valuation.missing", { item: t(`accessory.${line.key}`) })}</dt>
              <dd className="text-red-ink">
                <Money iqd={-line.amountIqd} />
              </dd>
            </div>
          ))}
          <div className="is-total">
            <dt>{t("valuation.suggested")}</dt>
            <dd>{v.suggestedIqd !== null ? <Money iqd={v.suggestedIqd} /> : t("valuation.noMultiplier")}</dd>
          </div>
        </dl>
      ) : (
        <p className="type-body text-ink-2">{ti.inspection?.grade ? t("valuation.noGuide") : t("valuation.needsGrade")}</p>
      )}
      {v ? <p className="type-caption text-ink-2">{t("valuation.guideAt", { date: f.date(v.guideUpdatedAt) })}</p> : null}
      {ti.references.length > 0 ? (
        <div className="grid gap-1">
          <p className="type-label">{t("valuation.references")}</p>
          <ul className="dev-ledger">
            {ti.references.map((ref, index) => (
              <li key={`${ref.sku}-${index}`} className="flex justify-between gap-4">
                <span>
                  <span className="dev-tag me-1">{t(`condition.${ref.kind}`)}</span>
                  {ref.href ? (
                    <Link to={ref.href} className="adm-link">
                      <Name text={ref.label} />
                    </Link>
                  ) : (
                    <Name text={ref.label} />
                  )}
                </span>
                <Money iqd={ref.priceIqd} />
              </li>
            ))}
          </ul>
          <p className="type-caption text-ink-2">{t("valuation.referencesNote")}</p>
        </div>
      ) : null}
    </Section>
  );
}

export function DifferenceSection({ ti, target }: Props & { target: string }) {
  const t = useDevicesT();
  const d = ti.difference;
  return (
    <Section id="ti-difference" title={t("difference.title")}>
      <p className="type-caption text-ink-2">{t("difference.lead")}</p>
      <Form method="get" className="flex flex-wrap items-end gap-2" preventScrollReset>
        <TextField name="target" label={t("difference.target")} hint={t("difference.targetHint")} defaultValue={target} ltr autoComplete="off" className="min-w-[14rem] flex-1" />
        <Key type="submit" icon="scales">
          {t("difference.compute")}
        </Key>
      </Form>
      {target && !d ? <p className="type-body text-ink-2">{ti.offer || ti.valuation?.suggestedIqd ? t("difference.notFound") : t("difference.noValue")}</p> : null}
      {d ? (
        <dl className="dev-ledger">
          <div>
            <dt>
              <span className="dev-tag me-1">{t(`condition.${d.target.kind}`)}</span>
              <Name text={d.target.label} />
            </dt>
            <dd>
              <Money iqd={d.target.priceIqd} />
            </dd>
          </div>
          <div>
            <dt>{ti.offer ? t("difference.offer") : t("difference.suggested")}</dt>
            <dd className="text-red-ink">
              <Money iqd={-d.offerIqd} />
            </dd>
          </div>
          <div className="is-total">
            <dt>{d.covered ? t("difference.creditLeft") : t("difference.toPay")}</dt>
            <dd>
              <Money iqd={Math.abs(d.differenceIqd)} />
            </dd>
          </div>
        </dl>
      ) : null}
      {d ? <p className="type-caption text-ink-2">{t("difference.note")}</p> : null}
    </Section>
  );
}

// ───────────────────────────────────────────────────────────────── photos and history

export function PhotosSection({ ti }: Props) {
  const t = useDevicesT();
  const { fetcher, pending, message } = useIntent("photo", "done.photo");
  const customer = ti.photos.filter((photo) => photo.kind === "customer");
  const inspection = ti.photos.filter((photo) => photo.kind === "inspection");
  return (
    <Section id="ti-photos" title={t("photos.title")}>
      <p className="type-caption text-ink-2">{t("photos.private")}</p>
      {[
        { key: "customer", list: customer },
        { key: "inspection", list: inspection },
      ].map((group) => (
        <div key={group.key} className="grid gap-2">
          <p className="type-label">{t(`photos.${group.key}`, { count: group.list.length })}</p>
          {group.list.length === 0 ? (
            <p className="type-caption text-ink-2">{t("photos.none")}</p>
          ) : (
            <ul className="dev-photos">
              {group.list.map((photo, index) => (
                <li key={photo.id} className="dev-photo">
                  <a href={photo.url} target="_blank" rel="noreferrer">
                    <img src={photo.url} alt={t("photos.alt", { n: index + 1 })} width={photo.width ?? 240} height={photo.height ?? 180} loading="lazy" />
                  </a>
                  <span className="type-caption text-ink-2">
                    <When at={photo.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {ti.can.photo ? (
        <fetcher.Form method="post" encType="multipart/form-data" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="intent" value="photo" />
          <div className="grid gap-1">
            <label htmlFor="ti-photo" className="type-label">
              {t("photos.add")}
            </label>
            <input id="ti-photo" name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="type-body" aria-describedby="ti-photo-hint" />
            <p id="ti-photo-hint" className="type-caption text-ink-2">
              {t("photos.addHint")}
            </p>
          </div>
          <Key type="submit" size="sm" icon="upload-simple" loading={pending}>
            {t("photos.upload")}
          </Key>
          <Failure message={message} />
        </fetcher.Form>
      ) : null}
    </Section>
  );
}

export function HistorySection({ ti }: Props) {
  const t = useDevicesT();
  const f = useFormat();
  if (ti.history.length === 0) return null;
  return (
    <Section id="ti-history" title={t("history.title")}>
      <ol className="dev-timeline">
        {[...ti.history].reverse().map((entry) => {
          const amount = typeof entry.data.amountIqd === "number" ? f.iqd(entry.data.amountIqd) : "";
          const at = typeof entry.data.at === "number" ? f.dateTime(entry.data.at) : "";
          const payout = typeof entry.data.payout === "string" ? t(`payout.${entry.data.payout}`) : "";
          const reason = typeof entry.data.reason === "string" ? entry.data.reason : typeof entry.data.note === "string" ? entry.data.note : "";
          return (
            <li key={entry.id} data-actor={entry.actorKind}>
              <p className="type-body">
                {t(`history.kinds.${entry.kind}`, { amount, at, payout, grade: typeof entry.data.grade === "string" ? entry.data.grade : "—" })}
                {entry.data.inPerson === true ? <span className="dev-tag ms-2">{t("history.inPerson")}</span> : null}
                {entry.data.counter === true ? <span className="dev-tag ms-2">{t("source.counter")}</span> : null}
              </p>
              <p className="type-caption text-ink-2">
                <When at={entry.at} /> · {entry.actor ?? t(`actor.${entry.actorKind}`)}
              </p>
              {reason ? <p className="type-caption">{reason}</p> : null}
            </li>
          );
        })}
      </ol>
    </Section>
  );
}
