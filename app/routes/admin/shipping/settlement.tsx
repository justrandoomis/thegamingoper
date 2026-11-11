import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/settlement";
import { useFormat } from "~/i18n/react";
import { AppError, invalid, throwAsResponse } from "~/server/errors";
import { assertStatementOpen, attachStatement, discardSettlement, disputeSettlement, getSettlement, removeSettlementItems, reopenSettlement, updateSettlementItem } from "~/server/services/admin/shipping/cod.server";
import { codFeeFor } from "~/server/services/admin/shipping/rules";
import { reconcileCodSettlement, submitCodSettlement } from "~/server/services/orders/shipments.server";
import { saveImageUpload } from "~/server/uploads.server";
import { EmptyState } from "~/ui/EmptyState";
import { Radio, FieldGroup, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog, Code, FormError, Money, Note, PageHead, Pair, ParcelStatus, ResponsiveList, Section, SettlementStatus, When, digitsOnly, useActionToast, useShipT, wholeValue } from "./components/kit";
import { shippingBlobStore } from "./env.server";
import { shippingMeta } from "./meta";
import { amount, enforceUploadLimit, failed, ok, openShipping, optional, signedAmount, text } from "./shipping.server";

/**
 * /admin/shipping/cod/:settlementId — one settlement (11.04). A DRAFT is corrected parcel by parcel against the
 * carrier's statement (the cash each courier brought; a difference from what was due needs a reason; the carrier's
 * charge). SUBMIT fixes what the carrier remitted (negative when the store paid the carrier) and computes the
 * difference (a difference needs a note). RECONCILE — the commerce core: the cash of each parcel is recorded through
 * recordCodCollection and the settlement is posted to the journal (cash/bank, shipping costs, cash over/short); with
 * a difference it is a second person's decision (never who prepared or submitted it). DISPUTE holds it while the
 * carrier is asked; REOPEN goes back to a draft; a draft can be DISCARDED (its parcels become eligible again).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openShipping(context, "shipping.cod.settle");
  try {
    return { settlement: await getSettlement(db, actor, params.settlementId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ params, request, context }: Route.ActionArgs) {
  const req = await openShipping(context, "shipping.cod.settle");
  const form = await request.formData();
  const intent = text(form, "intent");
  const id = params.settlementId;
  try {
    switch (intent) {
      case "item": {
        const value = amount(form, "amountIqd");
        const fee = amount(form, "feeIqd");
        if (value === undefined || Number.isNaN(value)) throw invalid({ amountIqd: value === undefined ? "required" : "invalid" });
        if (fee === undefined || Number.isNaN(fee)) throw invalid({ feeIqd: fee === undefined ? "required" : "invalid" });
        return ok(intent, await updateSettlementItem(req.db, req.actor, { settlementId: id, shipmentId: text(form, "shipmentId"), amountIqd: value, feeIqd: fee, reason: optional(form, "reason") }, req.now));
      }
      case "remove":
        return ok(intent, await removeSettlementItems(req.db, req.actor, { settlementId: id, shipmentIds: [text(form, "shipmentId")] }, req.now));
      case "submit": {
        const received = signedAmount(form, "receivedIqd");
        if (received === undefined || Number.isNaN(received)) throw invalid({ receivedIqd: received === undefined ? "required" : "invalid" });
        const value = text(form, "direction") === "paid" ? -Math.abs(received) : Math.abs(received);
        return ok(intent, await submitCodSettlement(req.db, req.actor, { settlementId: id, receivedIqd: value, note: optional(form, "note") ?? optional(form, "reason") }, req.now));
      }
      case "reconcile":
        return ok(intent, await reconcileCodSettlement(req.db, req.actor, { settlementId: id, receivedInto: text(form, "receivedInto") as never, reason: optional(form, "reason"), reference: optional(form, "reference") }, req.now));
      case "dispute":
        await disputeSettlement(req.db, req.actor, { settlementId: id, note: text(form, "reason") }, req.now);
        return ok(intent);
      case "reopen":
        await reopenSettlement(req.db, req.actor, { settlementId: id, reason: text(form, "reason") }, req.now);
        return ok(intent);
      case "discard":
        await discardSettlement(req.db, req.actor, { settlementId: id, reason: text(form, "reason") }, req.now);
        return ok(intent);
      case "statement": {
        const file = form.get("file");
        if (!(file instanceof File) || file.size === 0) throw invalid({ file: "upload_missing" });
        // what attachStatement would refuse is refused BEFORE the photo is stored (no file kept for a refused request)
        await assertStatementOpen(req.db, req.actor, id);
        await enforceUploadLimit(req);
        const { file: saved } = await saveImageUpload(req.db, shippingBlobStore(), file, { visibility: "private", kind: "cod_statement", ownerType: "cod_settlement", ownerId: id, createdBy: req.actor, now: req.now });
        await attachStatement(req.db, req.actor, { settlementId: id, fileId: saved.id }, req.now);
        return ok(intent);
      }
      default:
        throw new AppError("invalid", 400, { fields: { intent: "invalid" } });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "settlement.title", { ref: args.loaderData?.settlement.ref ?? "" });

type Settlement = Route.ComponentProps["loaderData"]["settlement"];

export default function SettlementPage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const { settlement } = loaderData;
  const [dialog, setDialog] = useState<null | "reconcile" | "dispute" | "reopen" | "discard">(null);
  const close = () => setDialog(null);
  const totals = settlement.totals;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/shipping/cod" className="adm-link">
            {t("settlement.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Code>{settlement.ref}</Code>
            <SettlementStatus status={settlement.status} />
          </span>
        }
        lead={t("settlement.lead", { carrier: settlement.carrier.name })}
      />
      {settlement.items.some((item) => item.isDemo) ? <Note>{t("settlement.demo")}</Note> : null}

      <div className="shp-split">
        <div className="min-w-0">
          <Section id="parcels" title={t("settlement.parcels", { count: settlement.items.length })}>
            {settlement.can.edit ? (
              // a draft is corrected parcel by parcel: one card per parcel at every width (the editor squeezed the
              // table's status and amount columns into nothing on desktop)
              settlement.items.length === 0 ? (
                <EmptyState icon="package" title={t("settlement.empty")} />
              ) : (
                <ul role="list" aria-label={t("settlement.parcels", { count: settlement.items.length })} className="grid gap-2 xl:grid-cols-2">
                  {settlement.items.map((row) => (
                    <li key={row.shipmentId} className="adm-card gap-1.5">
                      <ItemCard row={row} />
                      <ItemEditor settlement={settlement} item={row} />
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <ResponsiveList
                caption={t("settlement.parcels", { count: settlement.items.length })}
                rows={settlement.items}
                rowKey={(row) => row.shipmentId}
                columns={[
                  { key: "code", header: t("common.parcel"), cell: (row) => <Link to={`/admin/shipping/shipments/${encodeURIComponent(row.shipmentId)}`} className="adm-link"><Code>{row.code}</Code></Link> },
                  { key: "status", header: t("common.status"), cell: (row) => <ParcelStatus status={row.status} /> },
                  { key: "due", header: t("settlement.due"), numeric: true, cell: (row) => <Money iqd={row.dueIqd} unknown={t("settlement.noCash")} /> },
                  { key: "amount", header: t("settlement.collected"), numeric: true, cell: (row) => <Money iqd={row.amountIqd} className={row.dueIqd !== null && row.amountIqd !== row.dueIqd ? "text-red-ink" : undefined} /> },
                  { key: "fee", header: t("settlement.fee"), numeric: true, cell: (row) => <Money iqd={row.feeIqd} /> },
                  { key: "pay", header: t("settlement.payment"), cell: (row) => (row.paymentStatus ? t(`codPayment.${row.paymentStatus}`) : "—") },
                ]}
                card={(row) => <ItemCard row={row} />}
                empty={<EmptyState icon="package" title={t("settlement.empty")} />}
              />
            )}
          </Section>

          {settlement.can.submit ? <SubmitForm settlement={settlement} /> : null}
          <StatementSection settlement={settlement} />

          <Section id="history" title={t("settlement.history")}>
            <ol role="list" className="shp-timeline">
              {[...settlement.history].reverse().map((entry) => (
                <li key={entry.id}>
                  <p className="type-label">{t(`settlementEvent.${entry.action.split(".").pop() ?? "other"}`)}</p>
                  <p className="type-caption text-ink-2">
                    <When at={entry.at} />
                    {entry.actor ? ` · ${entry.actor}` : ""}
                  </p>
                  {entry.reason ? <p className="type-caption">{entry.reason}</p> : null}
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside className="grid min-w-0 gap-4" aria-label={t("settlement.totals")}>
          <div className="adm-card">
            <h2 className="adm-h3">{t("settlement.totals")}</h2>
            <dl className="shp-ledger">
              <div>
                <dt>{t("cod.expected")}</dt>
                <dd>
                  <Money iqd={totals.expectedIqd} />
                </dd>
              </div>
              <div>
                <dt>{t("cod.fees")}</dt>
                <dd>
                  <Money iqd={-totals.feesIqd} />
                </dd>
              </div>
              <div className="shp-ledger__total">
                <dt>{t("cod.netDue")}</dt>
                <dd>
                  <Money iqd={totals.netDueIqd} />
                </dd>
              </div>
              <div>
                <dt>{t("cod.received")}</dt>
                <dd>
                  <Money iqd={settlement.receivedIqd} unknown={t("cod.notYet")} />
                </dd>
              </div>
              <div className="shp-ledger__total">
                <dt>{t("cod.variance")}</dt>
                <dd>
                  <Money iqd={totals.varianceIqd} unknown={t("cod.notYet")} signed />
                </dd>
              </div>
            </dl>
            {totals.varianceIqd !== null && totals.varianceIqd !== 0 ? <p className="type-caption text-red-ink">{totals.varianceIqd < 0 ? t("settlement.short") : t("settlement.over")}</p> : null}
          </div>

          <div className="adm-card">
            <h2 className="adm-h3">{t("settlement.people")}</h2>
            <Pair label={t("settlement.createdBy")}>{settlement.createdBy ?? "—"}</Pair>
            <Pair label={t("settlement.submittedBy")}>{settlement.submittedBy ?? "—"}</Pair>
            <Pair label={t("settlement.reconciledBy")}>{settlement.reconciledBy ?? "—"}</Pair>
            <Pair label={t("cod.created")}>
              <When at={settlement.createdAt} />
            </Pair>
            {settlement.periodFrom ? (
              <Pair label={t("settlement.period")}>
                <When at={settlement.periodFrom} kind="date" /> – <When at={settlement.periodTo} kind="date" />
              </Pair>
            ) : null}
            {settlement.journalEntryId ? (
              <Pair label={t("settlement.journal")}>
                <Code>{settlement.journalEntryId}</Code>
              </Pair>
            ) : null}
            {settlement.notes ? <p className="whitespace-pre-line type-caption">{settlement.notes}</p> : null}
          </div>

          <div className="adm-card">
            <h2 className="adm-h3">{t("settlement.next")}</h2>
            <div className="shp-actions">
              {settlement.status === "submitted" ? (
                <Key variant="commit" icon="scales" disabled={!settlement.can.reconcile} aria-describedby={settlement.can.reconcileReason ? "reconcile-why" : undefined} onClick={() => setDialog("reconcile")}>
                  {t("settlement.reconcile")}
                </Key>
              ) : null}
              {settlement.can.dispute ? <Key onClick={() => setDialog("dispute")}>{t("settlement.dispute")}</Key> : null}
              {settlement.can.reopen ? <Key onClick={() => setDialog("reopen")}>{t("settlement.reopen")}</Key> : null}
              {settlement.can.discard ? <Key onClick={() => setDialog("discard")}>{t("settlement.discard")}</Key> : null}
            </div>
            {settlement.can.reconcileReason ? (
              <p id="reconcile-why" className="type-caption text-ink-2">
                {t(`settlement.blocked.${settlement.can.reconcileReason}`)}
              </p>
            ) : settlement.corrected && settlement.status !== "reconciled" ? (
              <p className="type-caption text-ink-2">{t("settlement.correctedNote")}</p>
            ) : null}
            {settlement.status === "reconciled" ? <p className="type-caption text-ink-2">{t("settlement.reconciledNote")}</p> : null}
          </div>
        </aside>
      </div>

      <ReconcileDialog settlement={settlement} open={dialog === "reconcile"} onClose={close} />
      <ActionDialog
        open={dialog === "dispute"}
        onClose={close}
        title={t("settlement.disputeTitle", { ref: settlement.ref })}
        consequence={t("settlement.disputeConsequence")}
        confirmLabel={t("settlement.dispute")}
        reason={{ label: t("settlement.disputeNote") }}
        fields={{ intent: "dispute" }}
        successMessage={t("settlement.disputed")}
      />
      <ActionDialog
        open={dialog === "reopen"}
        onClose={close}
        title={t("settlement.reopenTitle", { ref: settlement.ref })}
        consequence={t("settlement.reopenConsequence")}
        confirmLabel={t("settlement.reopen")}
        reason={{ label: t("zones.reason") }}
        fields={{ intent: "reopen" }}
        successMessage={t("settlement.reopened")}
      />
      <ActionDialog
        open={dialog === "discard"}
        onClose={close}
        tone="destructive"
        title={t("settlement.discardTitle", { ref: settlement.ref })}
        consequence={t("settlement.discardConsequence", { count: settlement.items.length })}
        confirmLabel={t("settlement.discard")}
        reason={{ label: t("zones.reason") }}
        fields={{ intent: "discard" }}
        successMessage={t("settlement.discarded")}
      />
    </>
  );
}

/** One parcel of a settlement as a card: code, status, what was due, what was collected, the carrier's charge. */
function ItemCard({ row }: { row: Settlement["items"][number] }) {
  const t = useShipT();
  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/admin/shipping/shipments/${encodeURIComponent(row.shipmentId)}`} className="adm-link type-strong">
          <Code>{row.code}</Code>
        </Link>
        <ParcelStatus status={row.status} />
      </div>
      <Pair label={t("settlement.due")}>
        <Money iqd={row.dueIqd} unknown={t("settlement.noCash")} />
      </Pair>
      <Pair label={t("settlement.collected")}>
        <Money iqd={row.amountIqd} className={row.dueIqd !== null && row.amountIqd !== row.dueIqd ? "text-red-ink" : undefined} />
      </Pair>
      <Pair label={t("settlement.fee")}>
        <Money iqd={row.feeIqd} />
      </Pair>
      {row.paymentStatus ? <Pair label={t("settlement.payment")}>{t(`codPayment.${row.paymentStatus}`)}</Pair> : null}
    </>
  );
}

function ItemEditor({ settlement, item }: { settlement: Settlement; item: Settlement["items"][number] }) {
  const t = useShipT();
  const fetcher = useFetcher<typeof action>();
  const failure = useActionToast(fetcher, t("settlement.itemSaved"));
  const remove = useFetcher<typeof action>();
  const removeFailure = useActionToast(remove, t("settlement.itemRemoved"));
  const f = useFormat();
  const [value, setValue] = useState(String(item.amountIqd));
  const [fee, setFee] = useState(String(item.feeIqd));
  const typed = wholeValue(value);
  const typedFee = wholeValue(fee);
  // the server's rule: cash other than what was due, or a charge other than the carrier's rate and cash fee, needs a reason
  const due = item.dueIqd ?? 0;
  const suggested = (item.rateIqd ?? 0) + codFeeFor(typed !== null && Number.isSafeInteger(typed) ? typed : 0, settlement.carrier);
  const differs = (typed !== null && Number.isSafeInteger(typed) && typed !== due) || (typedFee !== null && Number.isSafeInteger(typedFee) && typedFee !== suggested);
  const fields = fetcher.data && !fetcher.data.ok ? fetcher.data.fields : undefined;
  return (
    <div className="grid gap-2">
      <fetcher.Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="item" />
        <input type="hidden" name="shipmentId" value={item.shipmentId} />
        <TextField name="amountIqd" label={t("settlement.collected")} inputMode="numeric" value={value} onChange={(event) => setValue(digitsOnly(event.currentTarget.value))} className="w-32" error={fields?.amountIqd ?? (typed !== null && Number.isNaN(typed) ? t("common.wholeDinars") : undefined)} />
        <TextField name="feeIqd" label={t("settlement.fee")} inputMode="numeric" value={fee} onChange={(event) => setFee(digitsOnly(event.currentTarget.value))} className="w-28" error={fields?.feeIqd ?? (typedFee !== null && Number.isNaN(typedFee) ? t("common.wholeDinars") : undefined)} />
        {differs ? <TextField name="reason" label={t("settlement.diffReason")} hint={t("settlement.diffHint", { fee: f.iqd(suggested) })} required maxLength={500} className="w-56" error={fields?.reason} /> : null}
        <Key type="submit" size="sm" loading={fetcher.state !== "idle"}>
          {t("common.save")}
        </Key>
      </fetcher.Form>
      <remove.Form method="post">
        <input type="hidden" name="intent" value="remove" />
        <input type="hidden" name="shipmentId" value={item.shipmentId} />
        <Key type="submit" size="sm" variant="quiet" loading={remove.state !== "idle"}>
          {t("settlement.removeItem")}
        </Key>
      </remove.Form>
      <FormError message={(fields ? null : failure) ?? removeFailure} />
    </div>
  );
}

function SubmitForm({ settlement }: { settlement: Settlement }) {
  const t = useShipT();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const failure = useActionToast(fetcher, t("settlement.submitted"));
  const due = settlement.totals.netDueIqd;
  const [direction, setDirection] = useState<"received" | "paid">(due < 0 ? "paid" : "received");
  const [value, setValue] = useState(String(Math.abs(due)));
  const typed = value === "" ? null : Number(value) * (direction === "paid" ? -1 : 1);
  const variance = typed === null ? null : typed - due;
  const fields = fetcher.data && !fetcher.data.ok ? fetcher.data.fields : undefined;
  return (
    <Section id="submit" title={t("settlement.submitTitle")}>
      <fetcher.Form method="post" className="adm-card grid gap-3">
        <input type="hidden" name="intent" value="submit" />
        <p className="type-caption text-ink-2">{due >= 0 ? t("settlement.owes", { amount: f.iqd(due) }) : t("settlement.weOwe", { amount: f.iqd(-due) })}</p>
        <FieldGroup legend={t("settlement.direction")} layout="row">
          <Radio name="direction" value="received" label={t("settlement.dirReceived")} checked={direction === "received"} onChange={() => setDirection("received")} />
          <Radio name="direction" value="paid" label={t("settlement.dirPaid")} checked={direction === "paid"} onChange={() => setDirection("paid")} />
        </FieldGroup>
        <TextField name="receivedIqd" label={direction === "paid" ? t("settlement.paidAmount") : t("settlement.receivedAmount")} inputMode="numeric" value={value} onChange={(event) => setValue(digitsOnly(event.currentTarget.value))} required error={fields?.receivedIqd} />
        <p className="type-label">
          {t("cod.variance")}: <Money iqd={variance} unknown={t("cod.notYet")} signed />
        </p>
        {variance !== null && variance !== 0 ? <TextArea name="note" label={t("settlement.varianceNote")} required rows={2} maxLength={500} hint={t("settlement.varianceHint")} error={fields?.note} /> : null}
        <FormError message={fields ? null : failure} />
        <div>
          <Key type="submit" variant="ink" icon="paper-plane-tilt" loading={fetcher.state !== "idle"} disabled={settlement.items.length === 0}>
            {t("settlement.submit")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}

function StatementSection({ settlement }: { settlement: Settlement }) {
  const t = useShipT();
  const fetcher = useFetcher<typeof action>();
  const failure = useActionToast(fetcher, t("settlement.statementSaved"));
  return (
    <Section id="statement" title={t("settlement.statement")}>
      {settlement.statementUrl ? (
        <a href={settlement.statementUrl} target="_blank" rel="noopener noreferrer" className="w-40">
          <img src={settlement.statementUrl} alt={t("settlement.statementAlt", { ref: settlement.ref })} width={160} height={160} loading="lazy" className="rounded-xs bg-niche" />
        </a>
      ) : (
        <p className="type-body text-ink-2">{t("settlement.noStatement")}</p>
      )}
      {settlement.status !== "reconciled" ? (
        <fetcher.Form method="post" encType="multipart/form-data" className="adm-card grid gap-2">
          <input type="hidden" name="intent" value="statement" />
          <label className="grid gap-1">
            <span className="type-label">{t("settlement.statementFile")}</span>
            <input type="file" name="file" accept="image/jpeg,image/png,image/webp" required className="type-body" />
            <span className="type-caption text-ink-2">{t("settlement.statementHint")}</span>
          </label>
          <FormError message={failure} />
          <div>
            <Key type="submit" size="sm" icon="upload-simple" loading={fetcher.state !== "idle"}>
              {t("settlement.statementAdd")}
            </Key>
          </div>
        </fetcher.Form>
      ) : null}
    </Section>
  );
}

function ReconcileDialog({ settlement, open, onClose }: { settlement: Settlement; open: boolean; onClose: () => void }) {
  const t = useShipT();
  const f = useFormat();
  const [into, setInto] = useState<"cash" | "bank_clearing">("bank_clearing");
  const [reference, setReference] = useState("");
  const totals = settlement.totals;
  const variance = totals.varianceIqd ?? 0;
  const pending = settlement.items.filter((item) => item.amountIqd > 0 && item.paymentStatus === "pending").length;
  // a reason whenever the books take a difference (the core's rule): a variance, a hand correction, cash other than due
  const differs = settlement.secondPerson || settlement.items.some((item) => item.dueIqd !== null && item.amountIqd !== item.dueIqd && item.paymentStatus === "pending");
  return (
    <ActionDialog
      open={open}
      onClose={onClose}
      tone="commit"
      title={t("settlement.reconcileTitle", { ref: settlement.ref })}
      consequence={t("settlement.reconcileConsequence")}
      confirmLabel={t("settlement.reconcile")}
      impact={[
        { label: t("settlement.impactCash"), value: t("settlement.impactCashValue", { count: pending }) },
        { label: into === "cash" ? t("settlement.impactIntoCash") : t("settlement.impactIntoBank"), value: f.iqd(settlement.receivedIqd ?? 0), negative: (settlement.receivedIqd ?? 0) < 0 },
        { label: t("settlement.impactCosts"), value: f.iqd(totals.feesIqd) },
        { label: t("settlement.impactVariance"), value: `${variance > 0 ? "+" : variance < 0 ? "−" : ""}${f.iqd(Math.abs(variance))}`, negative: variance < 0 },
      ]}
      reason={variance !== 0 || differs ? { label: t("settlement.reconcileReason"), hint: t("settlement.reconcileReasonHint") } : undefined}
      fields={{ intent: "reconcile", receivedInto: into, reference }}
      successMessage={t("settlement.reconciled")}
    >
      <div className="grid gap-3">
        <FieldGroup legend={t("settlement.receivedInto")} layout="row">
          <Radio name="into" value="bank_clearing" label={t("settlement.intoBank")} checked={into === "bank_clearing"} onChange={() => setInto("bank_clearing")} />
          <Radio name="into" value="cash" label={t("settlement.intoCash")} checked={into === "cash"} onChange={() => setInto("cash")} />
        </FieldGroup>
        <TextField label={t("settlement.reference")} value={reference} onChange={(event) => setReference(event.currentTarget.value)} optional maxLength={100} ltr />
      </div>
    </ActionDialog>
  );
}
