import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/receipt";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { addLandedCost, allocateLandedCost, getReceiptLanded, previewAllocation, removeLandedCost, type AllocationPreview, type LandedBillView } from "~/server/services/admin/pricing/landed.server";
import { LANDED_COST_KINDS } from "~/server/db/schema";
import { ALLOCATION_METHODS, COST_CURRENCIES, purchaseCostIqd, parseDecimal, parseRateMicros, type CostCurrency } from "~/server/services/admin/pricing/rules";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { failure, formKey, formObject, requirePricing } from "./route.server";
import { failureOf, Iqd, iqdText, PageHead, pricingMeta, RowLink, useArrow, usePricingT } from "./shared";

/**
 * /admin/pricing/landed/:receiptId — one receipt: its lines, its landed-cost bills and how each bill spreads over the
 * lines (03.02). Bills are added and spread while the receipt is a draft; the shares are shown per line and per unit
 * before anything is stored.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db, "cost.read");
  try {
    return { ...(await getReceiptLanded(db, actor, params.receiptId, ctx.locale)), kinds: [...LANDED_COST_KINDS], methods: [...ALLOCATION_METHODS], formKey: formKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (!["add", "preview", "allocate", "remove"].includes(intent)) throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, "cost.read");
  const fields = formObject(form);
  // Every intent acts on THIS receipt: a bill id of another receipt is not found from here.
  const receiptId = params.receiptId;
  try {
    switch (intent) {
      case "add":
        return { ok: true as const, intent, added: await addLandedCost(db, actor, { ...fields, receiptId }, ctx.now) };
      case "preview":
        return { ok: true as const, intent, preview: await previewAllocation(db, actor, { landedCostId: fields.landedCostId, receiptId }) };
      case "allocate":
        return { ok: true as const, intent, preview: await allocateLandedCost(db, actor, { landedCostId: fields.landedCostId, receiptId, updateVariantCosts: fields.updateVariantCosts === "1", reason: fields.reason }, ctx.now) };
      default:
        await removeLandedCost(db, actor, { landedCostId: fields.landedCostId, receiptId, reason: fields.reason }, ctx.now);
        return { ok: true as const, intent, removed: true };
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "landed.metaTitle", { ref: args.loaderData?.receipt.ref ?? "" });

type LoaderData = Route.ComponentProps["loaderData"];
/** The message key of a bill kind ("other" is reserved for plural forms in the message files). */
const kindKey = (kind: string) => (kind === "other" ? "misc" : kind);
const CURRENCIES = Object.keys(COST_CURRENCIES) as CostCurrency[];

export default function ReceiptLanded({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const { receipt, lines, bills, editable } = loaderData;
  return (
    <>
      <PageHead
        eyebrow={<RowLink to="/admin/pricing/landed">{t("landed.back")}</RowLink>}
        title={
          <>
            {t("landed.receipt")} <bdi dir="ltr">{receipt.ref}</bdi>
          </>
        }
        lead={[receipt.supplier, receipt.poRef ? `PO ${receipt.poRef}` : null, receipt.location, receipt.supplierDocNo].filter(Boolean).join(" · ")}
        actions={<Status tone={receipt.status === "draft" ? "warn" : "ok"}>{t(`landed.status.${receipt.status}`)}</Status>}
      />
      {!editable ? (
        <p className="mb-4 max-w-[70ch] rounded-sm bg-niche p-3 type-body text-ink" role="note">
          {t("landed.postedLocked")}
        </p>
      ) : null}

      <section className="adm-section" aria-labelledby="receipt-lines">
        <h2 id="receipt-lines" className="adm-h2">
          {t("landed.lines", { count: lines.length })}
        </h2>
        {lines.length === 0 ? (
          <EmptyState title={t("landed.noLines")} />
        ) : (
          <div className="scroll-thin overflow-x-auto rounded-sm border border-line" role="region" aria-label={t("landed.lines", { count: lines.length })} tabIndex={0}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{t("col.sku")}</th>
                  <th scope="col" className="is-num">
                    {t("landed.qty")}
                  </th>
                  <th scope="col" className="is-num">
                    {t("landed.unitCost")}
                  </th>
                  <th scope="col" className="is-num">
                    {t("landed.landedUnit")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>
                      <span className="grid">
                        <RowLink to={`/admin/pricing/skus/${line.variantId}`}>
                          <bdi dir="ltr">{line.sku}</bdi>
                        </RowLink>
                        <span className="type-caption text-ink-2">{line.name}</span>
                      </span>
                    </td>
                    <td className="is-num">
                      <bdi>{f.number(line.qty)}</bdi>
                      {line.qtyAccepted > 0 && line.qtyAccepted !== line.qtyReceived ? <span className="block type-caption text-ink-2">{t("landed.ofReceived", { count: line.qtyReceived })}</span> : null}
                    </td>
                    <td className="is-num">
                      <Iqd value={line.unitCostIqd} />
                    </td>
                    <td className="is-num">
                      <Iqd value={line.landedUnitCostIqd} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="type-caption text-ink-2">{t("landed.goodsLine", { goods: iqdText(f, receipt.goodsIqd), bills: iqdText(f, receipt.billsIqd) })}</p>
      </section>

      <Bills data={loaderData} />
      {editable ? <AddBill data={loaderData} /> : null}
    </>
  );
}

function Bills({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const { bills, lines, editable } = loaderData;
  const arrow = useArrow();
  const previewer = useFetcher<typeof action>();
  const doer = useFetcher<typeof action>();
  const [dialog, setDialog] = useState<{ kind: "allocate" | "remove"; bill: LandedBillView } | null>(null);
  const [updateCosts, setUpdateCosts] = useState(true);
  const preview: AllocationPreview | null = previewer.data && "ok" in previewer.data && previewer.data.ok && previewer.data.intent === "preview" ? (previewer.data.preview ?? null) : null;
  const previewFail = failureOf(previewer.data);
  const failed = failureOf(doer.data);
  useEffect(() => {
    if (doer.state === "idle" && doer.data && "ok" in doer.data && doer.data.ok) {
      setDialog(null);
      toast.success(doer.data.intent === "remove" ? t("landed.removed") : t("landed.allocatedDone"));
    }
  }, [doer.state, doer.data, t]);

  const impact: ImpactRow[] =
    dialog?.kind === "allocate" && preview
      ? preview.shares.map((share) => ({
          label: (
            <>
              <bdi dir="ltr">{share.sku}</bdi> × <bdi className="nums">{share.qty}</bdi>
            </>
          ),
          value: `${iqdText(f, share.amountIqd)} · ${t("landed.perUnit", { amount: iqdText(f, share.perUnitIqd) })} · ${iqdText(f, share.landedBeforeIqd)} ${arrow} ${iqdText(f, share.landedAfterIqd)}`,
        }))
      : dialog?.kind === "remove"
        ? [{ label: t("landed.billAmount"), value: iqdText(f, -dialog.bill.amountIqd), negative: true }]
        : [];

  return (
    <section className="adm-section" aria-labelledby="receipt-bills">
      <h2 id="receipt-bills" className="adm-h2">
        {t("landed.billsTitle", { count: bills.length })}
      </h2>
      {bills.length === 0 ? (
        <EmptyState title={t("landed.noBillsTitle")} text={editable ? t("landed.noBillsText") : undefined} />
      ) : (
        <ul role="list" className="grid gap-3 md:grid-cols-2">
          {bills.map((bill) => (
            <li key={bill.id} className={bill.status === "draft" && editable ? "adm-card adm-card--act" : "adm-card"}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <span className="grid">
                  <span className="type-strong">{t(`landed.kind.${kindKey(bill.kind)}`)}</span>
                  {bill.description ? <span className="type-caption text-ink-2">{bill.description}</span> : null}
                </span>
                <span className="grid justify-items-end">
                  <Iqd value={bill.amountIqd} className="type-strong" />
                  {bill.currency !== "IQD" ? (
                    <bdi dir="ltr" className="type-caption text-ink-2 nums">
                      {f.number(bill.amountMinor / 10 ** (COST_CURRENCIES[bill.currency as CostCurrency] ?? 2))} {bill.currency} × {bill.fxRateMicros ? f.number(bill.fxRateMicros / 1_000_000) : "—"}
                    </bdi>
                  ) : null}
                </span>
              </div>
              <p className="type-caption text-ink-2">
                {t(`landed.method.${bill.method}`)} · <Status tone={bill.status === "allocated" ? "ok" : "warn"}>{t(`landed.billStatus.${bill.status}`)}</Status>
              </p>
              {bill.shares.length > 0 ? (
                <ul className="grid gap-0.5 type-caption">
                  {bill.shares.map((share) => {
                    const line = lines.find((candidate) => candidate.id === share.lineId);
                    return (
                      <li key={share.lineId} className="flex justify-between gap-2">
                        <bdi dir="ltr">{line?.sku ?? share.lineId}</bdi>
                        <span>
                          <Iqd value={share.amountIqd} /> · {t("landed.perUnit", { amount: iqdText(f, share.perUnitIqd) })}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {editable ? (
                <div className="flex flex-wrap gap-2">
                  <Key
                    size="sm"
                    variant="ink"
                    loading={previewer.state !== "idle" && dialog?.bill.id === bill.id}
                    onClick={() => {
                      setDialog({ kind: "allocate", bill });
                      previewer.submit({ intent: "preview", landedCostId: bill.id }, { method: "post" });
                    }}
                  >
                    {bill.status === "allocated" ? t("landed.reallocate") : t("landed.allocate")}
                  </Key>
                  <Key size="sm" onClick={() => setDialog({ kind: "remove", bill })}>
                    <span className="text-red-ink">{t("landed.remove")}</span>
                  </Key>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {dialog && (dialog.kind === "remove" || preview || previewFail) ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          tone={dialog.kind === "remove" ? "destructive" : "neutral"}
          title={dialog.kind === "remove" ? t("landed.removeTitle") : t("landed.allocateTitle", { amount: iqdText(f, dialog.bill.amountIqd) })}
          consequence={dialog.kind === "remove" ? t("landed.removeConsequence") : previewFail ? (previewFail.message ?? t("errors.generic")) : t("landed.allocateConsequence", { method: t(`landed.method.${dialog.bill.method}`) })}
          confirmLabel={dialog.kind === "remove" ? t("landed.remove") : t("landed.allocate")}
          impact={impact}
          reason={dialog.kind === "remove" ? { minLength: 3, label: t("common.reason") } : { noteRequired: false, label: t("common.note") }}
          pending={doer.state !== "idle"}
          error={failed ? (failed.message ?? t("errors.generic")) : undefined}
          onConfirm={({ reason }) => {
            if (dialog.kind === "remove") doer.submit({ intent: "remove", landedCostId: dialog.bill.id, reason }, { method: "post" });
            else if (preview) doer.submit({ intent: "allocate", landedCostId: dialog.bill.id, updateVariantCosts: updateCosts ? "1" : "", reason }, { method: "post" });
          }}
        >
          {dialog.kind === "allocate" && preview ? <Checkbox label={t("landed.updateCosts")} hint={t("landed.updateCostsHint")} checked={updateCosts} onChange={(event) => setUpdateCosts(event.currentTarget.checked)} /> : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function AddBill({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const [kind, setKind] = useState<string>("freight");
  const [description, setDescription] = useState("");
  const [currency, setCurrency] = useState<CostCurrency>(loaderData.receipt.currency && loaderData.receipt.currency in COST_CURRENCIES ? (loaderData.receipt.currency as CostCurrency) : "IQD");
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState(loaderData.receipt.fxRateMicros ? String(loaderData.receipt.fxRateMicros / 1_000_000) : "");
  const [method, setMethod] = useState<string>("by_value");
  const [open, setOpen] = useState(false);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok && fetcher.data.intent === "add") {
      setOpen(false);
      setAmount("");
      setDescription("");
      toast.success(t("landed.added"));
    }
  }, [fetcher.state, fetcher.data, t]);
  const decimals = COST_CURRENCIES[currency];
  const minor = parseDecimal(amount, decimals);
  const micros = currency === "IQD" ? 1_000_000 : parseRateMicros(rate);
  const amountIqd = minor !== null && micros !== null ? purchaseCostIqd(minor, decimals, micros) : null;
  return (
    <section className="adm-card" aria-labelledby="receipt-add">
      <h2 id="receipt-add" className="adm-h2">
        {t("landed.addTitle")}
      </h2>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setOpen(true);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Select label={t("landed.kindLabel")} value={kind} onChange={(event) => setKind(event.currentTarget.value)} options={loaderData.kinds.map((value) => ({ value, label: t(`landed.kind.${kindKey(value)}`) }))} />
          <TextField label={t("landed.description")} value={description} onChange={(event) => setDescription(event.currentTarget.value)} optional maxLength={200} />
          <Select label={t("landed.method.label")} value={method} onChange={(event) => setMethod(event.currentTarget.value)} options={loaderData.methods.filter((value) => value !== "manual").map((value) => ({ value, label: t(`landed.method.${value}`) }))} hint={t("landed.methodHint")} />
          <Select label={t("cost.currency")} value={currency} onChange={(event) => setCurrency(event.currentTarget.value as CostCurrency)} options={CURRENCIES.map((code) => ({ value: code, label: code }))} />
          <TextField label={t("landed.amountIn", { currency })} inputMode="decimal" ltr value={amount} onChange={(event) => setAmount(event.currentTarget.value)} required error={failed?.fields?.amount} />
          {currency !== "IQD" ? <TextField label={t("cost.rateIn", { currency })} inputMode="decimal" ltr value={rate} onChange={(event) => setRate(event.currentTarget.value)} required error={failed?.fields?.fxRate} /> : null}
        </div>
        <p className="type-body text-ink" aria-live="polite">
          {amountIqd !== null ? t("landed.amountPreview", { amount: iqdText(f, amountIqd) }) : t("cost.previewMissing")}
        </p>
        <div>
          <Key type="submit" variant="ink" icon="plus" disabled={amountIqd === null || amountIqd <= 0}>
            {t("landed.add")}
          </Key>
        </div>
      </form>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("landed.addConfirmTitle", { kind: t(`landed.kind.${kindKey(kind)}`) })}
        consequence={t("landed.addConsequence")}
        confirmLabel={t("landed.add")}
        impact={[{ label: t("landed.billAmount"), value: iqdText(f, amountIqd) }]}
        reason={{ minLength: 3, label: t("common.reason") }}
        pending={fetcher.state !== "idle"}
        error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
        onConfirm={({ reason }) => fetcher.submit({ intent: "add", kind, description, currency, amount, fxRate: currency === "IQD" ? "" : rate, method, reason, idempotencyKey: loaderData.formKey }, { method: "post" })}
      />
    </section>
  );
}
