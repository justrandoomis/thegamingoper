import { useEffect, useMemo, useRef, useState } from "react";
import { data, Form, Link, useFetcher, useNavigation } from "react-router";

import type { Route } from "./+types/sku";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { getCostDetail, setMarginRules, setVariantCost } from "~/server/services/admin/pricing/costs.server";
import { listsForVariant } from "~/server/services/admin/pricing/lists.server";
import { cancelPriceChange, getSkuPricing, listChanges, previewPriceChange, requestPriceChange, type ChangePreview } from "~/server/services/admin/pricing/prices.server";
import { BPS, COST_CURRENCIES, isCostCurrency, marginBps, parseDecimal, parsePercentBps, parseRateMicros, priceForMargin, purchaseCostIqd, type CostCurrency } from "~/server/services/admin/pricing/rules";
import { parseMarket, suggestForSku } from "~/server/services/admin/pricing/suggest.server";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { FieldGroup, Radio, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { failure, formKey, formObject, requirePricing } from "./route.server";
import { ByLine, failureOf, Iqd, iqdText, MarginStatus, PageHead, Pct, pctText, pricingMeta, RowLink, useArrow, usePricingT } from "./shared";

/**
 * /admin/pricing/skus/:variantId — one SKU's pricing: today's price and "was" price, the price change form with its
 * approval rules (03.05; clearance mode 03.07), the purchase and landed cost (03.01/03.02, cost.read), the margin rules
 * (03.03, profit.read), the advisory suggestion (03.08), bundle components, FIFO layers, price lists and the history.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db);
  const url = new URL(request.url);
  try {
    const pricing = await getSkuPricing(db, actor, params.variantId, ctx.locale, ctx.now);
    const marketText = (url.searchParams.get("market") ?? "").slice(0, 20);
    const [suggestion, cost, history, lists] = await Promise.all([
      pricing.can.suggest ? suggestForSku(db, actor, { variantId: pricing.variantId, marketIqd: parseMarket(marketText) }, ctx.now) : Promise.resolve(null),
      pricing.access.cost ? getCostDetail(db, actor, pricing.variantId, ctx.now) : Promise.resolve(null),
      listChanges(db, actor, { variantId: pricing.variantId, limit: 20 }, ctx.locale),
      pricing.can.request || pricing.can.approve ? listsForVariant(db, actor, pricing.variantId, ctx.locale, ctx.now) : Promise.resolve([]),
    ]);
    return { pricing, suggestion, marketText, cost, history: history.items, lists, formKey: formKey(), mode: url.searchParams.get("mode") === "clearance" ? ("clearance" as const) : ("standard" as const) };
  } catch (error) {
    throwAsResponse(error);
  }
}

const INTENT_PERMISSION = {
  preview: "pricing.price.update",
  request: "pricing.price.update",
  cancel: "pricing.price.update",
  cost: "pricing.cost.update",
  margins: "pricing.margin.manage",
} as const;
type Intent = keyof typeof INTENT_PERMISSION;

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "") as Intent;
  if (!(intent in INTENT_PERMISSION)) throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, INTENT_PERMISSION[intent]);
  const fields: Record<string, string> = { ...formObject(form), variantId: params.variantId };
  try {
    switch (intent) {
      case "preview":
        return { ok: true as const, intent, preview: await previewPriceChange(db, actor, fields, ctx.locale, ctx.now) };
      case "request":
        return { ok: true as const, intent, result: await requestPriceChange(db, actor, fields, ctx.locale, ctx.now) };
      case "cancel":
        return { ok: true as const, intent, result: await cancelPriceChange(db, actor, { requestId: fields.requestId, note: fields.note }, ctx.now) };
      case "cost":
        return { ok: true as const, intent, cost: await setVariantCost(db, actor, fields, ctx.now) };
      case "margins":
        return { ok: true as const, intent, margins: await setMarginRules(db, actor, fields, ctx.now) };
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "sku.metaTitle", { sku: args.loaderData?.pricing.sku ?? "" });

type LoaderData = Route.ComponentProps["loaderData"];

export default function SkuPricingPage({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const { pricing } = loaderData;
  const [prefill, setPrefill] = useState<{ price: string; source: "suggestion" } | null>(null);

  return (
    <>
      <PageHead
        eyebrow={
          <>
            <RowLink to="/admin/pricing/skus">{t("sku.back")}</RowLink> · <bdi dir="ltr">{pricing.sku}</bdi>
          </>
        }
        title={pricing.variantTitle ? (pricing.variantTitle.includes(pricing.name) ? pricing.variantTitle : `${pricing.name} · ${pricing.variantTitle}`) : pricing.name}
        lead={t("sku.lead", { kind: t(`kind.${pricing.kind}`), status: t(`productStatus.${pricing.productStatus}`) })}
        actions={
          <TextLink as={Link} to={`/admin/catalog/products/${pricing.productId}`}>
            {t("sku.openProduct")}
          </TextLink>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <PriceSummary data={loaderData} />
          {pricing.pending ? <PendingRequest data={loaderData} /> : null}
          {pricing.can.request ? <ChangeForm data={loaderData} prefill={prefill} /> : null}
          {pricing.components.length > 0 ? <Components data={loaderData} /> : null}
          <History data={loaderData} />
        </div>
        <div className="grid min-w-0 content-start gap-6">
          {loaderData.suggestion ? <SuggestionCard data={loaderData} onUse={(price) => setPrefill({ price: String(price), source: "suggestion" })} /> : null}
          {loaderData.cost ? <CostCard data={loaderData} /> : null}
          {pricing.access.profit && loaderData.cost ? <MarginCard data={loaderData} /> : null}
          {loaderData.lists.length > 0 ? <ListPrices data={loaderData} /> : null}
          {loaderData.cost && loaderData.cost.layers.length > 0 ? <Layers data={loaderData} /> : null}
          {!pricing.access.cost ? <p className="type-caption text-ink-2">{t("sku.noCostAccess")}</p> : null}
        </div>
      </div>
    </>
  );
}

/* ───────────────────────────── price today ───────────────────────────── */

function PriceSummary({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const { pricing } = data;
  return (
    <section className="adm-card" aria-labelledby="sku-price">
      <h2 id="sku-price" className="adm-h2">
        {t("sku.priceTitle")}
      </h2>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <dt className="type-caption text-ink-2">{t("sku.price")}</dt>
          <dd className="type-kpi">
            <Iqd value={pricing.priceIqd} />
          </dd>
        </div>
        <div>
          <dt className="type-caption text-ink-2">{t("sku.compareAt")}</dt>
          <dd className="type-strong">{pricing.compareAtIqd !== null ? <Iqd value={pricing.compareAtIqd} strike /> : t("sku.noCompareAt")}</dd>
        </div>
        <div>
          <dt className="type-caption text-ink-2">{t("sku.onHand")}</dt>
          <dd className="type-strong nums">{f.number(pricing.onHand)}</dd>
        </div>
        {pricing.margin ? (
          <>
            <div>
              <dt className="type-caption text-ink-2">{t("sku.margin")}</dt>
              <dd>
                <MarginStatus state={pricing.margin.state} bps={pricing.margin.bps} />
              </dd>
            </div>
            <div>
              <dt className="type-caption text-ink-2">{t("sku.floor")}</dt>
              <dd className="type-strong">
                <Iqd value={pricing.margin.floorIqd} />
              </dd>
            </div>
            <div>
              <dt className="type-caption text-ink-2">{t("sku.targetPrice")}</dt>
              <dd className="type-strong">
                <Iqd value={pricing.margin.targetIqd} />
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      <p className="type-caption text-ink-2">
        {pricing.compareAt.eligibleNow
          ? t("sku.wasEligible", { days: pricing.compareAt.currentDays })
          : t("sku.wasNotYet", { days: pricing.compareAt.currentDays, date: f.date(pricing.compareAt.eligibleFrom) })}
      </p>
      {pricing.cost && pricing.cost.basis?.source === "bundle" ? <p className="type-caption text-ink-2">{t("sku.bundleCost")}</p> : null}
      {pricing.margin?.state === "no_cost" ? <p className="type-caption text-ink-2">{t("margin.noCostHint")}</p> : null}
    </section>
  );
}

/* ───────────────────────────── a request waiting ───────────────────────────── */

function PendingRequest({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const pending = data.pricing.pending!;
  const fetcher = useFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setOpen(false);
      toast.success(t("sku.cancelled"));
    }
  }, [fetcher.state, fetcher.data, t]);
  return (
    <section className="adm-card adm-card--act" aria-labelledby="sku-pending">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="sku-pending" className="adm-h2">
          {t("sku.pendingTitle")}
        </h2>
        <Status tone="warn">{t("changes.status.pending")}</Status>
      </div>
      <p className="type-body text-ink">
        {t("sku.pendingText", { from: iqdText(f, pending.oldPriceIqd), to: iqdText(f, pending.newPriceIqd) })}
      </p>
      {pending.reasons.length > 0 ? <p className="type-caption text-ink-2">{pending.reasons.map((reason) => t(`reason.${reason}`)).join(" · ")}</p> : null}
      <ByLine name={pending.requestedBy?.name} at={pending.createdAt} />
      <div className="flex flex-wrap gap-2">
        <Key as={Link} to="/admin/pricing/changes" size="sm" variant="ink">
          {t("sku.openQueue")}
        </Key>
        {pending.mine ? (
          <Key size="sm" onClick={() => setOpen(true)}>
            {t("changes.cancel")}
          </Key>
        ) : null}
      </div>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("changes.cancelTitle")}
        consequence={t("changes.cancelConsequence")}
        confirmLabel={t("changes.cancel")}
        reason={{ noteRequired: false, label: t("common.note") }}
        pending={fetcher.state !== "idle"}
        error={failed?.message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "cancel", requestId: pending.id, note: reason }, { method: "post" })}
      />
    </section>
  );
}

/* ───────────────────────────── the change form (03.05, 03.07) ───────────────────────────── */

function previewRows(t: ReturnType<typeof usePricingT>, f: ReturnType<typeof useFormat>, preview: ChangePreview, arrow: string): ImpactRow[] {
  const rows: ImpactRow[] = [
    { label: t("impact.price"), value: `${iqdText(f, preview.oldPriceIqd)} ${arrow} ${iqdText(f, preview.newPriceIqd)}` },
    { label: t("impact.change"), value: pctText(f, preview.dropBps === null ? null : -preview.dropBps, true), negative: (preview.dropBps ?? 0) > 0 },
    // The 10 % limit counts from the highest price of the last 30 days: show it when it is not today's price.
    ...(preview.referencePriceIqd > preview.oldPriceIqd
      ? [{ label: t("impact.reference"), value: `${iqdText(f, preview.referencePriceIqd)} · ${pctText(f, preview.referenceDropBps === null ? null : -preview.referenceDropBps, true)}`, negative: (preview.referenceDropBps ?? 0) > 0 }]
      : []),
    { label: t("impact.compareAt"), value: preview.newCompareAtIqd !== null ? iqdText(f, preview.newCompareAtIqd) : t("impact.none") },
    {
      label: t("impact.stockValue", { count: preview.onHand }),
      value: iqdText(f, preview.stockValueDeltaIqd, true),
      negative: preview.stockValueDeltaIqd < 0,
    },
  ];
  if (preview.marginAfterBps !== undefined) {
    rows.push({ label: t("impact.margin"), value: `${pctText(f, preview.marginBeforeBps ?? null)} ${arrow} ${pctText(f, preview.marginAfterBps ?? null)}`, negative: (preview.marginAfterBps ?? 0) < (preview.marginBeforeBps ?? 0) });
    rows.push({ label: t("impact.floor"), value: iqdText(f, preview.floorIqd ?? null) });
  }
  rows.push({ label: t("impact.approval"), value: t(`impact.approval_${preview.approval}`) });
  return rows;
}

function ChangeForm({ data, prefill }: { data: LoaderData; prefill: { price: string; source: "suggestion" } | null }) {
  const t = usePricingT();
  const f = useFormat();
  const arrow = useArrow();
  const { pricing } = data;
  const previewer = useFetcher<typeof action>();
  const sender = useFetcher<typeof action>();
  const [price, setPrice] = useState("");
  const [compareAt, setCompareAt] = useState("");
  const [mode, setMode] = useState<"standard" | "clearance">(data.mode);
  const [source, setSource] = useState<"manual" | "suggestion">("manual");
  const [open, setOpen] = useState(false);
  const priceRef = useRef<HTMLInputElement | null>(null);
  const preview = previewer.data && "ok" in previewer.data && previewer.data.ok && previewer.data.intent === "preview" ? previewer.data.preview : null;
  const previewFail = failureOf(previewer.data);
  const sendFail = failureOf(sender.data);

  useEffect(() => {
    if (prefill) {
      setPrice(prefill.price);
      setSource(prefill.source);
      priceRef.current?.focus();
      priceRef.current?.scrollIntoView({ block: "center" });
    }
  }, [prefill]);
  useEffect(() => {
    if (previewer.state === "idle" && preview) setOpen(true);
  }, [previewer.state, preview]);
  useEffect(() => {
    if (sender.state === "idle" && sender.data && "ok" in sender.data && sender.data.ok && sender.data.intent === "request") {
      setOpen(false);
      setPrice("");
      setCompareAt("");
      setSource("manual");
      toast.success(sender.data.result.status === "applied" ? t("sku.applied") : t("sku.sentForApproval"));
    }
  }, [sender.state, sender.data, t]);

  const fields = { intent: "preview", newPriceIqd: price, newCompareAtIqd: compareAt, mode, source, idempotencyKey: data.formKey, reason: "preview" };
  const disabled = Boolean(pricing.pending);

  return (
    <section className="adm-card" aria-labelledby="sku-change">
      <h2 id="sku-change" className="adm-h2">
        {t("sku.changeTitle")}
      </h2>
      <p className="type-caption text-ink-2">{t("sku.changeLead")}</p>
      {disabled ? <p className="type-body text-ink">{t("sku.changeBlocked")}</p> : null}
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          previewer.submit(fields, { method: "post" });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            ref={priceRef}
            name="newPriceIqd"
            label={t("sku.newPrice")}
            inputMode="numeric"
            ltr
            value={price}
            onChange={(event) => {
              setPrice(event.currentTarget.value);
              setSource("manual");
            }}
            end={t("common.iqd")}
            required
            disabled={disabled}
            hint={source === "suggestion" ? t("sku.fromSuggestion") : t("sku.priceHint")}
            error={previewFail?.fields?.newPriceIqd}
          />
          <TextField
            name="newCompareAtIqd"
            label={t("sku.newCompareAt")}
            inputMode="numeric"
            ltr
            value={compareAt}
            onChange={(event) => setCompareAt(event.currentTarget.value)}
            end={t("common.iqd")}
            optional
            disabled={disabled}
            hint={t("sku.compareAtHint")}
            error={previewFail?.fields?.newCompareAtIqd}
          />
        </div>
        <FieldGroup legend={t("sku.mode")}>
          <Radio row name="mode" value="standard" label={t("sku.modeStandard")} hint={t("sku.modeStandardHint")} checked={mode === "standard"} onChange={() => setMode("standard")} disabled={disabled} />
          <Radio row name="mode" value="clearance" label={t("sku.modeClearance")} hint={t("sku.modeClearanceHint")} checked={mode === "clearance"} onChange={() => setMode("clearance")} disabled={disabled} />
        </FieldGroup>
        {previewFail && !previewFail.fields ? (
          <p className="type-body text-red-ink" role="alert">
            {previewFail.message ?? t("errors.generic")}
          </p>
        ) : null}
        <div>
          <Key type="submit" variant="ink" loading={previewer.state !== "idle"} disabled={disabled}>
            {t("sku.review")}
          </Key>
        </div>
      </form>
      {preview ? (
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          title={t("sku.confirmTitle", { sku: pricing.sku })}
          consequence={preview.approval === "not_required" ? t("sku.confirmApply") : preview.approval === "required" ? t("sku.confirmApproval") : t("sku.confirmDecided")}
          confirmLabel={preview.approval === "not_required" ? t("sku.apply") : t("sku.send")}
          impact={previewRows(t, f, preview, arrow)}
          reason={{ minLength: 3, label: t("common.reason"), hint: t("sku.reasonHint") }}
          pending={sender.state !== "idle"}
          error={sendFail ? (sendFail.message ?? Object.values(sendFail.fields ?? {}).join(" ")) : undefined}
          onConfirm={({ reason }) => sender.submit({ ...fields, intent: "request", reason }, { method: "post" })}
        >
          {preview.reasons.length > 0 ? (
            <ul className="grid gap-1 type-caption text-ink">
              {preview.reasons.map((reason) => (
                <li key={reason}>· {t(`reason.${reason}`)}</li>
              ))}
            </ul>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

/* ───────────────────────────── suggestion (03.08) ───────────────────────────── */

function SuggestionCard({ data, onUse }: { data: LoaderData; onUse: (price: number) => void }) {
  const t = usePricingT();
  const f = useFormat();
  const arrow = useArrow();
  const navigation = useNavigation();
  const suggestion = data.suggestion!;
  return (
    <section className="adm-card" aria-labelledby="sku-suggestion">
      <h2 id="sku-suggestion" className="adm-h2">
        {t("suggest.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("suggest.lead")}</p>
      <Form method="get" className="flex flex-wrap items-end gap-2" preventScrollReset>
        {data.mode === "clearance" ? <input type="hidden" name="mode" value="clearance" /> : null}
        <TextField name="market" label={t("suggest.market")} inputMode="numeric" ltr defaultValue={data.marketText} end={t("common.iqd")} optional hint={t("suggest.marketHint")} className="min-w-[12rem] grow" />
        <Key type="submit" size="sm" loading={navigation.state === "loading"}>
          {t("suggest.run")}
        </Key>
      </Form>
      {!suggestion.ok ? (
        <p className="type-body text-ink">{t(`suggest.${suggestion.reason}`)}</p>
      ) : (
        <>
          <p className="type-kpi">
            <Iqd value={suggestion.priceIqd} />
          </p>
          <p className="type-caption text-ink-2">
            {t("suggest.change", { change: pctText(f, suggestion.changeBps, true), current: iqdText(f, suggestion.currentPriceIqd) })}
            {suggestion.margins ? ` · ${t("suggest.marginAt", { margin: pctText(f, suggestion.margins.marginBps) })}` : ""}
          </p>
          <ol className="grid gap-1 type-caption text-ink">
            {suggestion.steps.map((step, index) => (
              <li key={`${step.rule}-${index}`}>
                {index + 1}. {t(`suggest.rule.${step.rule}`, { days: suggestion.inputs.recentDays })} {arrow} <Iqd value={step.priceIqd} />
              </li>
            ))}
          </ol>
          <p className="type-caption text-ink-2">
            {t("suggest.facts", { cost: iqdText(f, suggestion.inputs.landedIqd), onHand: suggestion.inputs.onHand, sold: suggestion.inputs.soldRecently, days: suggestion.inputs.recentDays })}
          </p>
          {data.pricing.can.request && !data.pricing.pending && suggestion.priceIqd !== data.pricing.priceIqd ? (
            <div>
              <Key size="sm" onClick={() => onUse(suggestion.priceIqd)}>
                {t("suggest.use")}
              </Key>
            </div>
          ) : null}
          <p className="type-caption text-ink-2">{t("suggest.advisory")}</p>
        </>
      )}
    </section>
  );
}

/* ───────────────────────────── cost (03.01, 03.02) ───────────────────────────── */

const CURRENCIES = Object.keys(COST_CURRENCIES) as CostCurrency[];

function CostCard({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const arrow = useArrow();
  const cost = data.cost!;
  const row = cost.row;
  const canEdit = data.pricing.can.editCost;
  const fetcher = useFetcher<typeof action>();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState<CostCurrency>(row && isCostCurrency(row.currency) ? row.currency : "USD");
  const decimals = COST_CURRENCIES[currency];
  const initialUnit = row ? (row.unitCostMinor / 10 ** row.decimals).toFixed(row.decimals) : "";
  const initialRate = row?.fxRateMicros ? String(row.fxRateMicros / 1_000_000) : cost.usdRateMicros ? String(cost.usdRateMicros / 1_000_000) : "";
  const [unit, setUnit] = useState(initialUnit);
  const [rate, setRate] = useState(initialRate);
  const [rateDate, setRateDate] = useState(row?.fxDate ?? cost.today);
  const [extras, setExtras] = useState(row?.extrasIqd !== null && row?.extrasIqd !== undefined ? String(row.extrasIqd) : "0");
  const failed = failureOf(fetcher.data);

  const planned = useMemo(() => {
    const minor = parseDecimal(unit, decimals);
    const micros = currency === "IQD" ? 1_000_000 : parseRateMicros(rate);
    const extra = extras.trim() === "" ? 0 : parseDecimal(extras, 0);
    if (minor === null || micros === null || extra === null) return null;
    const purchase = purchaseCostIqd(minor, decimals, micros);
    return { purchase, landed: purchase + extra };
  }, [unit, rate, extras, currency, decimals]);

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok && fetcher.data.intent === "cost") {
      setOpen(false);
      setEditing(false);
      toast.success(fetcher.data.cost.changed ? t("cost.saved") : t("cost.unchanged"));
    }
  }, [fetcher.state, fetcher.data, t]);

  const price = data.pricing.priceIqd;
  const impact: ImpactRow[] = planned
    ? [
        { label: t("cost.landed"), value: `${iqdText(f, row?.landedCostIqd ?? null)} ${arrow} ${iqdText(f, planned.landed)}`, negative: planned.landed > (row?.landedCostIqd ?? 0) },
        ...(data.pricing.access.profit
          ? [{ label: t("impact.margin"), value: `${pctText(f, row ? marginBps(price, row.landedCostIqd) : null)} ${arrow} ${pctText(f, marginBps(price, planned.landed))}` }]
          : []),
      ]
    : [];

  return (
    <section className="adm-card" aria-labelledby="sku-cost">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sku-cost" className="adm-h2">
          {t("cost.title")}
        </h2>
        {canEdit && !editing ? (
          <Key size="sm" icon="pencil-simple" onClick={() => setEditing(true)}>
            {row ? t("cost.edit") : t("cost.add")}
          </Key>
        ) : null}
      </div>
      {row ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="type-caption text-ink-2">{t("cost.unitCost")}</dt>
            <dd className="type-strong">
              <bdi dir="ltr" className="nums">
                {f.number(row.unitCostMinor / 10 ** row.decimals, { minimumFractionDigits: row.decimals, maximumFractionDigits: row.decimals })} {row.currency}
              </bdi>
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("cost.rate")}</dt>
            <dd className="type-strong">
              {row.currency === "IQD" ? (
                "—"
              ) : (
                <bdi dir="ltr" className="nums">
                  {row.fxRateMicros ? f.number(row.fxRateMicros / 1_000_000, { maximumFractionDigits: 6 }) : "—"}
                  {row.fxDate ? ` · ${row.fxDate}` : ""}
                </bdi>
              )}
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("cost.purchaseIqd")}</dt>
            <dd className="type-strong">
              <Iqd value={row.purchaseIqd} />
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("cost.extras")}</dt>
            <dd className="type-strong">
              <Iqd value={row.extrasIqd} />
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="type-caption text-ink-2">{t("cost.landed")}</dt>
            <dd className="type-kpi">
              <Iqd value={row.landedCostIqd} />
            </dd>
          </div>
        </dl>
      ) : (
        <EmptyState title={t("cost.noneTitle")} text={t("cost.noneText")} />
      )}
      {row ? <ByLine name={row.updatedBy?.name} at={row.updatedAt} /> : null}
      <p className="type-caption text-ink-2">{t("cost.fifoNote")}</p>

      {editing ? (
        <form
          className="grid gap-3 border-t border-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label={t("cost.currency")} value={currency} onChange={(event) => setCurrency(event.currentTarget.value as CostCurrency)} options={CURRENCIES.map((code) => ({ value: code, label: code }))} error={failed?.fields?.currency} />
            <TextField label={t("cost.unitCostIn", { currency })} inputMode="decimal" ltr value={unit} onChange={(event) => setUnit(event.currentTarget.value)} required error={failed?.fields?.unitCost} />
            {currency !== "IQD" ? (
              <>
                <TextField label={t("cost.rateIn", { currency })} inputMode="decimal" ltr value={rate} onChange={(event) => setRate(event.currentTarget.value)} required hint={cost.usdRateMicros && currency === "USD" ? t("cost.rateHint", { rate: f.number(cost.usdRateMicros / 1_000_000) }) : undefined} error={failed?.fields?.fxRate} />
                <TextField label={t("cost.rateDate")} type="date" ltr value={rateDate} max={cost.today} onChange={(event) => setRateDate(event.currentTarget.value)} required error={failed?.fields?.fxDate} />
              </>
            ) : null}
            <TextField label={t("cost.extrasIn")} inputMode="numeric" ltr value={extras} onChange={(event) => setExtras(event.currentTarget.value)} end={t("common.iqd")} hint={t("cost.extrasHint")} error={failed?.fields?.extrasIqd} />
          </div>
          <p className="type-body text-ink" aria-live="polite">
            {planned ? t("cost.preview", { purchase: iqdText(f, planned.purchase), landed: iqdText(f, planned.landed) }) : t("cost.previewMissing")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Key type="submit" variant="ink" disabled={!planned}>
              {t("cost.save")}
            </Key>
            <Key onClick={() => setEditing(false)} variant="quiet">
              {t("common.cancel")}
            </Key>
          </div>
        </form>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("cost.confirmTitle", { sku: data.pricing.sku })}
        consequence={t("cost.confirmConsequence")}
        confirmLabel={t("cost.save")}
        impact={impact}
        reason={{ minLength: 3, label: t("common.reason"), hint: t("cost.reasonHint") }}
        pending={fetcher.state !== "idle"}
        error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
        onConfirm={({ reason }) =>
          fetcher.submit(
            { intent: "cost", currency, unitCost: unit, fxRate: currency === "IQD" ? "" : rate, fxDate: currency === "IQD" ? "" : rateDate, extrasIqd: extras, reason, expectedUpdatedAt: String(row?.updatedAt ?? 0) },
            { method: "post" },
          )
        }
      />
    </section>
  );
}

/* ───────────────────────────── margin rules (03.03) ───────────────────────────── */

function MarginCard({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const arrow = useArrow();
  const row = data.cost!.row;
  const canEdit = data.pricing.can.editMargins && row !== null;
  const fetcher = useFetcher<typeof action>();
  const [min, setMin] = useState(row?.minMarginBps !== null && row?.minMarginBps !== undefined ? String(row.minMarginBps / 100) : "");
  const [target, setTarget] = useState(row?.targetMarginBps !== null && row?.targetMarginBps !== undefined ? String(row.targetMarginBps / 100) : "");
  const [open, setOpen] = useState(false);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok && fetcher.data.intent === "margins") {
      setOpen(false);
      toast.success(fetcher.data.margins.changed ? t("margin.saved") : t("cost.unchanged"));
    }
  }, [fetcher.state, fetcher.data, t]);
  const minBps = min.trim() === "" ? null : parsePercentBps(min);
  const floorAfter = row && minBps !== null && minBps < BPS ? priceForMargin(row.landedCostIqd, minBps) : null;
  const priceBelow = floorAfter !== null && data.pricing.priceIqd < floorAfter;
  return (
    <section className="adm-card" aria-labelledby="sku-margins">
      <h2 id="sku-margins" className="adm-h2">
        {t("margin.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("margin.lead")}</p>
      {row && !canEdit ? (
        <dl className="grid gap-2 sm:grid-cols-2">
          <div>
            <dt className="type-caption text-ink-2">{t("margin.min")}</dt>
            <dd className="type-strong">
              <Pct bps={row.minMarginBps} />
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("margin.target")}</dt>
            <dd className="type-strong">
              <Pct bps={row.targetMarginBps} />
            </dd>
          </div>
        </dl>
      ) : !row ? (
        <p className="type-body text-ink">{t("margin.needsCost")}</p>
      ) : null}
      {canEdit ? (
        <form
          className="grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label={t("margin.min")} inputMode="decimal" ltr value={min} onChange={(event) => setMin(event.currentTarget.value)} end="%" hint={t("margin.minHint")} error={failed?.fields?.minMargin} />
            <TextField label={t("margin.target")} inputMode="decimal" ltr value={target} onChange={(event) => setTarget(event.currentTarget.value)} end="%" hint={t("margin.targetHint")} error={failed?.fields?.targetMargin} />
          </div>
          <div>
            <Key type="submit" size="sm" variant="ink">
              {t("margin.save")}
            </Key>
          </div>
        </form>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("margin.confirmTitle", { sku: data.pricing.sku })}
        consequence={priceBelow ? t("margin.confirmBelow") : t("margin.confirmConsequence")}
        confirmLabel={t("margin.save")}
        impact={[
          { label: t("margin.min"), value: `${pctText(f, row?.minMarginBps ?? null)} ${arrow} ${min.trim() === "" ? "—" : pctText(f, minBps)}` },
          { label: t("impact.floor"), value: iqdText(f, floorAfter) },
          { label: t("sku.price"), value: iqdText(f, data.pricing.priceIqd), negative: priceBelow },
        ]}
        reason={{ minLength: 3, label: t("common.reason") }}
        pending={fetcher.state !== "idle"}
        error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
        onConfirm={({ reason }) => fetcher.submit({ intent: "margins", minMargin: min, targetMargin: target, reason }, { method: "post" })}
      />
    </section>
  );
}

/* ───────────────────────────── bundle, lists, layers, history ───────────────────────────── */

function Components({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const { pricing } = data;
  const separate = pricing.components.reduce((sum, part) => sum + part.priceIqd * part.qty, 0);
  return (
    <section className="adm-card" aria-labelledby="sku-components">
      <h2 id="sku-components" className="adm-h2">
        {t("sku.componentsTitle")}
      </h2>
      <ul className="grid gap-1">
        {pricing.components.map((part) => (
          <li key={part.variantId} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1">
            <span>
              <RowLink to={`/admin/pricing/skus/${part.variantId}`}>
                <bdi dir="ltr">{part.sku}</bdi>
              </RowLink>{" "}
              <span className="type-caption text-ink-2">
                × <bdi className="nums">{part.qty}</bdi> · {part.name}
              </span>
            </span>
            <span className="type-caption">
              <Iqd value={part.priceIqd} />
              {part.landedIqd !== undefined ? (
                <>
                  {" · "}
                  {t("col.landedIqd")}: <Iqd value={part.landedIqd} />
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="type-body text-ink">{t("sku.componentsSum", { sum: iqdText(f, separate), saving: iqdText(f, separate - pricing.priceIqd, true) })}</p>
    </section>
  );
}

function ListPrices({ data }: { data: LoaderData }) {
  const t = usePricingT();
  return (
    <section className="adm-card" aria-labelledby="sku-lists">
      <h2 id="sku-lists" className="adm-h2">
        {t("sku.listsTitle")}
      </h2>
      <ul className="grid gap-1">
        {data.lists.map((entry) => (
          <li key={`${entry.listId}-${entry.minQty}`} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1">
            <span>
              <RowLink to={`/admin/pricing/lists/${entry.listId}`}>
                <bdi dir="ltr">{entry.code}</bdi>
              </RowLink>{" "}
              <span className="type-caption text-ink-2">
                {entry.name} · {t(`lists.state.${entry.state}`)} · {t("lists.fromQty", { qty: entry.minQty })}
              </span>
            </span>
            <Iqd value={entry.priceIqd} />
          </li>
        ))}
      </ul>
      <p className="type-caption text-ink-2">{t("lists.notApplied")}</p>
    </section>
  );
}

function Layers({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  return (
    <section className="adm-card" aria-labelledby="sku-layers">
      <h2 id="sku-layers" className="adm-h2">
        {t("sku.layersTitle")}
      </h2>
      <ul className="grid gap-1">
        {data.cost!.layers.map((layer) => (
          <li key={layer.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1 type-caption">
            <span>
              <bdi className="nums">{f.date(layer.receivedAt)}</bdi> · {t(`layerSource.${layer.source}`)} · {t("sku.layerQty", { left: layer.qtyRemaining, received: layer.qtyReceived })}
            </span>
            <Iqd value={layer.unitCostIqd} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function History({ data }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const arrow = useArrow();
  return (
    <section className="adm-card" aria-labelledby="sku-history">
      <h2 id="sku-history" className="adm-h2">
        {t("sku.historyTitle")}
      </h2>
      {data.history.length === 0 ? (
        <p className="type-body text-ink-2">{t("sku.historyEmpty")}</p>
      ) : (
        <ol className="grid gap-2">
          {data.history.map((change) => (
            <li key={change.id} className="grid gap-0.5 border-b border-line pb-2">
              <span className="flex flex-wrap items-center gap-2">
                <Status tone={change.status === "applied" ? "ok" : change.status === "pending" ? "warn" : "neutral"}>{t(`changes.status.${change.status}`)}</Status>
                <span className="type-body nums">
                  {iqdText(f, change.oldPriceIqd)} {arrow} {iqdText(f, change.newPriceIqd)}
                </span>
                {change.mode === "clearance" ? <span className="type-caption text-ink-2">{t("sku.modeClearance")}</span> : null}
              </span>
              {change.reason ? <span className="type-caption text-ink">{change.reason}</span> : null}
              <ByLine name={change.requestedBy?.name} at={change.createdAt} />
              {change.decidedBy ? <ByLine name={change.decidedBy.name} at={change.decidedAt} /> : null}
            </li>
          ))}
        </ol>
      )}
      <TextLink as={Link} to={`/admin/pricing/changes?tab=history&q=${encodeURIComponent(data.pricing.sku)}`}>
        {t("sku.historyAll")}
      </TextLink>
    </section>
  );
}
