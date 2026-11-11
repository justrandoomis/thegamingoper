import { useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/receipt";
import { useFormat } from "~/i18n/react";
import { canAny } from "~/server/actor";
import { AppError, throwAsResponse } from "~/server/errors";
import { PRICING_PERMISSIONS } from "~/server/services/admin/pricing/access";
import { addLandedCost, allocateLandedCost, removeLandedCost } from "~/server/services/admin/pricing/landed.server";
import { cancelReceipt, getReceipt, postReceipt } from "~/server/services/admin/purchasing/receipts.server";
import { ALLOCATION_METHOD_LIST, COST_CURRENCIES, LANDED_KIND_LIST } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, FormError, History, Kpi, Minor, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { checked, failed, newKey, ok, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/receipts/:receiptId — one receipt (09.04, 09.05): what was counted per order line (received, refused
 * at inspection and why, accepted, serials), its landed-cost bills spread over the units through pricing's allocation
 * functions (cost.read), and posting it into stock (through the stock core, line by line) and the books (Dr inventory /
 * Cr accounts payable through the core's posting) — with the stock and money it moves shown first. A posting that
 * stopped half way says so and can be resumed after its lease.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, ["purchasing.po.read", "purchasing.receipt.create"]);
  try {
    return { detail: await getReceipt(db, actor, params.receiptId, locale, now), access: purchasingAccess(actor), pricingPage: canAny(actor, PRICING_PERMISSIONS) && purchasingAccess(actor).cost, key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const landed = intent.startsWith("landed.");
  const { db, actor, locale, now } = await openPurchasing(context, landed ? "cost.read" : "purchasing.receipt.create");
  const receiptId = params.receiptId;
  try {
    switch (intent) {
      case "post": {
        const result = await postReceipt(db, actor, { receiptId }, now);
        return ok({ intent, units: result.units, resumed: result.resumed, replayed: result.replayed });
      }
      case "cancel":
        await cancelReceipt(db, actor, { receiptId, reason: text(form, "reason") }, now);
        return ok({ intent });
      case "landed.add": {
        const added = await addLandedCost(
          db,
          actor,
          { receiptId, kind: text(form, "kind"), description: text(form, "description"), currency: text(form, "currency"), amount: text(form, "amount"), fxRate: text(form, "fxRate"), method: text(form, "method"), reason: text(form, "reason"), idempotencyKey: text(form, "key") },
          now,
        );
        try {
          await allocateLandedCost(db, actor, { landedCostId: added.landedCostId, receiptId, updateVariantCosts: checked(form, "updateVariantCosts"), reason: text(form, "reason") }, now);
        } catch (error) {
          // The bill is kept as a draft: the page shows why it could not be spread (no weight, no value…).
          return failed(error, locale, "landed.spread");
        }
        return ok({ intent });
      }
      case "landed.allocate":
        await allocateLandedCost(db, actor, { landedCostId: text(form, "landedCostId"), receiptId, updateVariantCosts: true, reason: text(form, "reason") }, now);
        return ok({ intent });
      case "landed.remove":
        await removeLandedCost(db, actor, { landedCostId: text(form, "landedCostId"), receiptId, reason: text(form, "reason") }, now);
        return ok({ intent });
      default:
        return failed(new AppError("invalid", 400), locale, intent);
    }
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "receipt.title", { ref: args.loaderData?.detail.receipt.ref ?? "" });

type Detail = Route.ComponentProps["loaderData"]["detail"];
type Line = Detail["lines"][number];

export default function ReceiptPage({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { detail, access, pricingPage, key } = loaderData;
  const { receipt, lines, units, can } = detail;
  const [dialog, setDialog] = useState<null | { kind: "post" } | { kind: "cancel" } | { kind: "remove"; billId: string } | { kind: "allocate"; billId: string }>(null);
  const [currency, setCurrency] = useState("IQD");
  const withCost = detail.money !== undefined;
  const failure = result && !result.ok ? result : null;
  const landedFields = failure && (failure.intent === "landed.add" || failure.intent === "landed.spread") ? (failure.fields ?? {}) : {};
  const value = withCost && lines.every((line) => (line.landedUnitCostIqd ?? line.unitCostIqd) !== null && (line.landedUnitCostIqd ?? line.unitCostIqd) !== undefined) ? lines.reduce((sum, line) => sum + (line.landedUnitCostIqd ?? line.unitCostIqd ?? 0) * line.qtyAccepted, 0) : null;
  const draftBills = (detail.bills ?? []).filter((bill) => bill.status === "draft").length;
  const movedLines = lines.filter((line) => line.inStock).length;
  const acceptedLines = lines.filter((line) => line.qtyAccepted > 0).length;

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/receipts" className="adm-link type-label">
          {t("receipt.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            {receipt.supplier?.name ?? "—"} · {receipt.po ? <RowLink to={`/admin/purchasing/orders/${receipt.po.id}`}><Code>{receipt.po.ref}</Code></RowLink> : "—"}
          </>
        }
        title={t("receipt.title", { ref: receipt.ref })}
        actions={<StateTag group="receipt" value={receipt.state} label={t(`receiptState.${receipt.state}`)} />}
      />

      {receipt.state === "draft" ? (
        <Note icon="info" className="mb-4">
          {t("receipt.draftNote")}
        </Note>
      ) : null}
      {receipt.state === "posting" && receipt.posting ? (
        <Note tone="warn" icon="warning" className="mb-4">
          <p className="type-body">{t("receipt.postingNote", { moved: f.number(movedLines), total: f.number(acceptedLines) })}</p>
          <p className="type-caption">
            {t("receipt.postingSince")} <When at={receipt.posting.since} /> · {receipt.posting.resumable ? t("receipt.resumableNow") : <>{t("receipt.resumableAt")} <When at={receipt.posting.resumableAt} /></>}
          </p>
        </Note>
      ) : null}
      {receipt.state === "posted" ? (
        <Note icon="check-circle" className="mb-4">
          <p className="type-body">
            {t("receipt.postedNote", { location: receipt.location.code })} <When at={receipt.postedAt} />
          </p>
          {detail.money ? (
            <p className="type-caption">
              {t("receipt.postedBooks")} <Money iqd={detail.money.postedIqd} unknownLabel={t("receipt.notPosted")} />
            </p>
          ) : null}
          {detail.money && detail.money.postedIqd !== null && detail.money.goodsIqd !== null && detail.money.postedIqd !== detail.money.goodsIqd + detail.money.landedIqd ? (
            <p className="type-caption text-ink-2">{t("receipt.roundingNote", { amount: f.iqd(Math.abs(detail.money.postedIqd - detail.money.goodsIqd - detail.money.landedIqd)) })}</p>
          ) : null}
        </Note>
      ) : null}
      {receipt.state === "cancelled" ? (
        <Note icon="x-circle" className="mb-4">
          {t("receipt.cancelledNote")}
        </Note>
      ) : null}

      <div className="pur-kpis mb-5">
        <Kpi label={t("receipt.unitsReceived")} value={f.number(units.received)} />
        <Kpi label={t("receipt.unitsAccepted")} value={f.number(units.accepted)} />
        <Kpi label={t("receipt.unitsRejected")} value={f.number(units.rejected)} />
        <Kpi label={t("receipt.unitsInStock")} value={f.number(units.inStock)} />
        {detail.money ? <Kpi wide label={t("receipt.goodsValue")} value={<Money iqd={detail.money.goodsIqd} />} hint={detail.money.landedIqd > 0 ? t("receipt.plusLanded", { amount: f.iqd(detail.money.landedIqd) }) : undefined} /> : null}
      </div>

      <dl className="adm-card mb-5 grid gap-2 sm:grid-cols-3">
        <div>
          <dt className="type-caption text-ink-2">{t("common.location")}</dt>
          <dd className="type-body">
            <Code>{receipt.location.code}</Code> · {receipt.location.name}
          </dd>
        </div>
        <div>
          <dt className="type-caption text-ink-2">{t("receive.docNo")}</dt>
          <dd className="type-body">{receipt.supplierDocNo ? <Code>{receipt.supplierDocNo}</Code> : "—"}</dd>
        </div>
        <div>
          <dt className="type-caption text-ink-2">{t("receipt.receivedAt")}</dt>
          <dd className="type-body">
            <When at={receipt.receivedAt} /> {receipt.receivedBy ? `· ${receipt.receivedBy}` : ""}
          </dd>
        </div>
        {receipt.notes ? <p className="type-body sm:col-span-3">{receipt.notes}</p> : null}
      </dl>

      {failure && (failure.intent === "post" || failure.intent === "cancel") ? (
        <div className="mb-4">
          <FormError result={failure} />
        </div>
      ) : null}
      {result && result.ok && result.intent === "post" ? (
        <p role="status" className="mb-4 type-label text-ok">
          {t("receipt.posted", { count: Number("units" in result ? result.units : 0) })}
        </p>
      ) : null}

      {can.post || can.resume || can.cancel ? (
        <Section id="next" title={t("receipt.next")}>
          <div className="flex flex-wrap gap-2">
            {can.post || can.resume ? (
              <Key variant="commit" icon="package" disabled={can.post && draftBills > 0} aria-describedby={can.post && draftBills > 0 ? "draft-bills" : undefined} onClick={() => setDialog({ kind: "post" })}>
                {can.resume ? t("receipt.resume") : t("receipt.post")}
              </Key>
            ) : null}
            {can.cancel ? (
              <Key icon="x-circle" className="[--on:var(--red-ink)]" onClick={() => setDialog({ kind: "cancel" })}>
                {t("receipt.cancel")}
              </Key>
            ) : null}
          </div>
          {can.post && draftBills > 0 ? (
            <p id="draft-bills" className="type-caption text-red-ink">
              {t("receipt.draftBillsBlock", { count: draftBills })}
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section id="lines" title={t("receipt.lines", { count: lines.length })}>
        <ResponsiveList
          caption={t("receipt.lines", { count: lines.length })}
          rows={lines}
          rowKey={(line) => line.id}
          columns={[
            { key: "sku", header: t("common.sku"), cell: (line: Line) => <Code>{line.variant.sku}</Code> },
            { key: "name", header: t("common.product"), cell: (line: Line) => <span className="line-clamp-2 min-w-[11rem]">{line.variant.name}</span> },
            { key: "ordered", header: t("order.ordered"), numeric: true, cell: (line: Line) => <Num value={line.qtyOrdered} /> },
            { key: "received", header: t("receipt.received"), numeric: true, cell: (line: Line) => <Num value={line.qtyReceived} /> },
            { key: "accepted", header: t("receipt.accepted"), numeric: true, cell: (line: Line) => <Num value={line.qtyAccepted} /> },
            { key: "rejected", header: t("receipt.rejected"), cell: (line: Line) => (line.qtyRejected > 0 ? <span className="text-red-ink"><Num value={line.qtyRejected} /> · {line.rejectReason}</span> : "—") },
            { key: "stock", header: t("receipt.inStock"), cell: (line: Line) => (line.qtyAccepted === 0 ? "—" : line.inStock ? t("receipt.yes") : t("receipt.notYet")) },
            ...(lines.some((line) => line.serials) ? [{ key: "serials", header: t("receipt.serials"), cell: (line: Line) => (line.serials ? <Code className="whitespace-normal">{line.serials.join(", ")}</Code> : "—") }] : []),
            ...(withCost
              ? [
                  { key: "unit", header: t("receipt.unitCostIqd"), numeric: true, cell: (line: Line) => <Money iqd={line.unitCostIqd} /> },
                  { key: "landed", header: t("receipt.landedUnitIqd"), numeric: true, cell: (line: Line) => <Money iqd={line.landedUnitCostIqd ?? line.unitCostIqd} /> },
                ]
              : []),
          ]}
          card={(line) => (
            <>
              <p className="type-strong">{line.variant.name}</p>
              <p className="type-caption text-ink-2">
                <Code>{line.variant.sku}</Code>
              </p>
              <Pair label={t("receipt.acceptedOf")}>
                <Num value={line.qtyAccepted} /> / <Num value={line.qtyReceived} />
              </Pair>
              {line.qtyRejected > 0 ? (
                <Pair label={t("receipt.rejected")}>
                  <span className="text-red-ink">
                    <Num value={line.qtyRejected} /> · {line.rejectReason}
                  </span>
                </Pair>
              ) : null}
              <Pair label={t("receipt.inStock")}>{line.qtyAccepted === 0 ? "—" : line.inStock ? t("receipt.yes") : t("receipt.notYet")}</Pair>
              {withCost ? (
                <Pair label={t("receipt.landedUnitIqd")}>
                  <Money iqd={line.landedUnitCostIqd ?? line.unitCostIqd} />
                </Pair>
              ) : null}
            </>
          )}
        />
        {units.rejected > 0 && can.claim ? (
          <div>
            <Key as={Link} to={`/admin/purchasing/claims?receipt=${receipt.id}#new`} icon="warning" size="sm">
              {t("receipt.claimRejected", { count: units.rejected })}
            </Key>
          </div>
        ) : null}
      </Section>

      {detail.bills ? (
        <Section
          id="landed"
          title={t("landed.title")}
          aside={
            pricingPage ? (
              <Link to={`/admin/pricing/landed/${receipt.id}`} className="adm-link type-label">
                {t("landed.pricingPage")}
              </Link>
            ) : undefined
          }
        >
          <p className="type-caption text-ink-2">{t("landed.lead")}</p>
          {detail.bills.length === 0 ? (
            <p className="type-body text-ink-2">{t("landed.none")}</p>
          ) : (
            <ul role="list" className="grid gap-2 sm:grid-cols-2">
              {detail.bills.map((bill) => (
                <li key={bill.id} className="adm-card gap-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="type-strong">{t(`landed.kinds.${bill.kind === "other" ? "misc" : bill.kind}`)}</p>
                    <StateTag group="receipt" value={bill.status === "allocated" ? "posted" : "draft"} label={t(`landed.status.${bill.status}`)} />
                  </div>
                  {bill.description ? <p className="type-caption text-ink-2">{bill.description}</p> : null}
                  <Pair label={t("landed.amount")}>
                    <Minor minor={bill.amountMinor} currency={bill.currency} />
                    {bill.currency !== "IQD" ? (
                      <>
                        {" · "}
                        <Money iqd={bill.amountIqd} />
                      </>
                    ) : null}
                  </Pair>
                  <Pair label={t("landed.method")}>{t(`landed.methods.${bill.method}`)}</Pair>
                  {can.landed ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {bill.status === "draft" ? (
                        <Key size="sm" icon="scales" onClick={() => setDialog({ kind: "allocate", billId: bill.id })}>
                          {t("landed.spread")}
                        </Key>
                      ) : null}
                      <Key size="sm" icon="trash" className="[--on:var(--red-ink)]" onClick={() => setDialog({ kind: "remove", billId: bill.id })}>
                        {t("landed.remove")}
                      </Key>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {failure && failure.intent === "landed.spread" ? <FormError result={failure} /> : null}
          {can.landed ? (
            <Form method="post" className="adm-card grid gap-4 lg:grid-cols-3" key={key}>
              <p className="type-label lg:col-span-3">{t("landed.addTitle")}</p>
              <input type="hidden" name="intent" value="landed.add" />
              <input type="hidden" name="key" value={key} />
              <Select name="kind" label={t("landed.kind")} options={LANDED_KIND_LIST.map((kind) => ({ value: kind, label: t(`landed.kinds.${kind === "other" ? "misc" : kind}`) }))} defaultValue="freight" error={landedFields.kind} />
              <TextField name="description" label={t("landed.description")} optional maxLength={200} error={landedFields.description} />
              <Select name="method" label={t("landed.method")} options={ALLOCATION_METHOD_LIST.map((method) => ({ value: method, label: t(`landed.methods.${method}`) }))} defaultValue="by_value" error={landedFields.method} />
              <Select name="currency" label={t("supplier.currency")} options={Object.keys(COST_CURRENCIES).map((code) => ({ value: code, label: code }))} value={currency} onChange={(event) => setCurrency(event.currentTarget.value)} />
              <TextField name="amount" label={t("landed.amountIn", { currency })} inputMode="decimal" ltr required error={landedFields.amount} />
              {currency !== "IQD" ? <TextField name="fxRate" label={t("orderForm.fxRate", { currency })} inputMode="decimal" ltr required error={landedFields.fxRate} /> : <span />}
              <TextField name="reason" label={t("landed.reason")} hint={t("landed.reasonHint")} required maxLength={500} className="lg:col-span-2" error={landedFields.reason} />
              <Checkbox name="updateVariantCosts" label={t("landed.updateSkuCost")} defaultChecked className="self-center" />
              {failure && failure.intent === "landed.add" && !failure.fields ? (
                <div className="lg:col-span-3">
                  <FormError result={failure} />
                </div>
              ) : null}
              <div className="lg:col-span-3">
                <Key type="submit" variant="ink" icon="plus" loading={navigation.state === "submitting" && navigation.formData?.get("intent") === "landed.add"}>
                  {t("landed.addAndSpread")}
                </Key>
              </div>
            </Form>
          ) : null}
        </Section>
      ) : null}

      {detail.claims.length > 0 ? (
        <Section id="claims" title={t("order.claims")}>
          <ul role="list" className="grid gap-2 sm:grid-cols-2">
            {detail.claims.map((claim) => (
              <li key={claim.id} className="adm-card gap-1">
                <div className="flex items-start justify-between gap-2">
                  {access.claim ? (
                    <RowLink to={`/admin/purchasing/claims/${claim.id}`}>
                      <Code>{claim.ref}</Code>
                    </RowLink>
                  ) : (
                    <Code>{claim.ref}</Code>
                  )}
                  <StateTag group="claim" value={claim.status} label={t(`claimStatus.${claim.status}`)} />
                </div>
                <p className="type-caption text-ink-2">{t(`claimKind.${claim.kind}`)}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="history" title={t("common.history")}>
        <History entries={detail.history} />
      </Section>

      <ActionDialog
        open={dialog?.kind === "post"}
        onClose={() => setDialog(null)}
        title={can.resume ? t("receipt.resumeTitle") : t("receipt.postTitle")}
        consequence={t("receipt.postConsequence", { location: receipt.location.code })}
        confirmLabel={can.resume ? t("receipt.resume") : t("receipt.post")}
        tone="commit"
        impact={[
          { label: t("receipt.stockAt", { location: receipt.location.code }), value: `+${f.number(units.accepted - units.inStock)}` },
          ...(units.rejected > 0 ? [{ label: t("receipt.unitsRejected"), value: t("receipt.rejectedStay", { count: units.rejected }) }] : []),
          ...(withCost ? [{ label: t("receipt.inventoryValue"), value: <Money iqd={value} /> }, { label: t("receipt.books"), value: t("receipt.booksEntry") }] : []),
        ]}
        fields={{ intent: "post" }}
        successMessage={t("receipt.posted", { count: units.accepted })}
      />
      <ActionDialog
        open={dialog?.kind === "cancel"}
        onClose={() => setDialog(null)}
        title={t("receipt.cancelTitle")}
        consequence={t("receipt.cancelConsequence")}
        confirmLabel={t("receipt.cancel")}
        tone="destructive"
        reason
        fields={{ intent: "cancel" }}
        successMessage={t("receipt.cancelled")}
      />
      <ActionDialog
        open={dialog?.kind === "allocate"}
        onClose={() => setDialog(null)}
        title={t("landed.spreadTitle")}
        consequence={t("landed.spreadConsequence")}
        confirmLabel={t("landed.spread")}
        reason={{ hint: t("landed.reasonHint") }}
        fields={{ intent: "landed.allocate", landedCostId: dialog?.kind === "allocate" ? dialog.billId : "" }}
        successMessage={t("landed.spreadDone")}
      />
      <ActionDialog
        open={dialog?.kind === "remove"}
        onClose={() => setDialog(null)}
        title={t("landed.removeTitle")}
        consequence={t("landed.removeConsequence")}
        confirmLabel={t("landed.remove")}
        tone="destructive"
        reason
        fields={{ intent: "landed.remove", landedCostId: dialog?.kind === "remove" ? dialog.billId : "" }}
        successMessage={t("landed.removed")}
      />
    </>
  );
}
