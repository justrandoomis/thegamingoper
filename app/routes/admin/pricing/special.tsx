import { useEffect, useState } from "react";
import { data, Link, useFetcher } from "react-router";

import type { Route } from "./+types/special";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import {
  cancelUsedPrice,
  decideUsedPrice,
  listBundles,
  listClearance,
  listUsedForPricing,
  setUsedUnitPrice,
  SPECIAL_READERS,
  type BundleView,
  type ClearanceView,
  type UsedView,
} from "~/server/services/admin/pricing/special.server";
import { Chip } from "~/ui/Chip";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { failure, formObject, requirePricing } from "./route.server";
import { ByLine, failureOf, Iqd, iqdText, MarginStatus, PageHead, pctText, pricingMeta, RowLink, typedIqd, useArrow, usePricingT } from "./shared";

type Tab = "bundles" | "clearance" | "used";
const TABS: Tab[] = ["bundles", "clearance", "used"];

/**
 * /admin/pricing/special — separate pricing for bundle offers, clearance and used devices (03.07). Bundles and
 * clearance prices change through the normal price-change flow (clearance: mode "clearance", always two people);
 * used devices are priced one unit at a time here.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  // The same permissions the services ask for: any other pricing role gets a 403 here, not a server error.
  const { actor } = await requirePricing(ctx, db, SPECIAL_READERS);
  const url = new URL(request.url);
  const tab: Tab = TABS.includes(url.searchParams.get("tab") as Tab) ? (url.searchParams.get("tab") as Tab) : "bundles";
  const all = url.searchParams.get("all") === "1";
  try {
    return {
      tab,
      all,
      bundles: tab === "bundles" ? await listBundles(db, actor, ctx.locale) : null,
      clearance: tab === "clearance" ? await listClearance(db, actor, { minAgeDays: all ? 0 : undefined }, ctx.locale, ctx.now) : null,
      used: tab === "used" ? await listUsedForPricing(db, actor, {}, ctx.locale) : null,
      canRequest: can(actor, "pricing.price.update"),
    };
  } catch (error) {
    throwAsResponse(error);
  }
}

const INTENT_PERMISSION = {
  "used-price": "pricing.used.update",
  "used-cancel": "pricing.used.update",
  "used-approve": "pricing.price.approve",
  "used-reject": "pricing.price.approve",
} as const;
type Intent = keyof typeof INTENT_PERMISSION;

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "") as Intent;
  if (!(intent in INTENT_PERMISSION)) throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, INTENT_PERMISSION[intent]);
  const fields = formObject(form);
  try {
    switch (intent) {
      case "used-price":
        return { ok: true as const, intent, result: await setUsedUnitPrice(db, actor, fields, ctx.now) };
      case "used-cancel":
        return { ok: true as const, intent, result: await cancelUsedPrice(db, actor, { approvalId: fields.approvalId, note: fields.note }, ctx.now) };
      default:
        return { ok: true as const, intent, result: await decideUsedPrice(db, actor, { approvalId: fields.approvalId, decision: intent === "used-approve" ? "approve" : "reject", note: fields.note }, ctx.now) };
    }
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "special.title");

type LoaderData = Route.ComponentProps["loaderData"];

export default function SpecialPricing({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  return (
    <>
      <PageHead title={t("special.title")} lead={t("special.lead")} />
      <nav aria-label={t("special.tabs")} className="mb-4 flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <Chip key={tab} as={Link} to={`?tab=${tab}`} selected={loaderData.tab === tab}>
            {t(`special.tab.${tab}`)}
          </Chip>
        ))}
      </nav>
      {loaderData.tab === "bundles" ? <Bundles data={loaderData} /> : loaderData.tab === "clearance" ? <Clearance data={loaderData} /> : <Used data={loaderData} />}
    </>
  );
}

/* ───────────────────────────── bundles ───────────────────────────── */

function Bundles({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const result = loaderData.bundles!;
  const columns: DataColumn<BundleView>[] = [
    {
      key: "sku",
      header: t("col.sku"),
      cell: (row) => (
        <span className="grid min-w-[12rem]">
          <RowLink to={`/admin/pricing/skus/${row.variantId}`}>
            <bdi dir="ltr">{row.sku}</bdi>
          </RowLink>
          <span className="type-caption text-ink-2">{row.name}</span>
        </span>
      ),
    },
    {
      key: "parts",
      header: t("special.components"),
      cell: (row) => (
        <span className="grid type-caption">
          {row.components.map((part) => (
            <span key={part.variantId}>
              <bdi dir="ltr">{part.sku}</bdi> × <bdi className="nums">{part.qty}</bdi>
            </span>
          ))}
        </span>
      ),
    },
    { key: "price", header: t("col.priceIqd"), numeric: true, cell: (row) => <Iqd value={row.priceIqd} /> },
    { key: "separate", header: t("special.separate"), numeric: true, cell: (row) => <Iqd value={row.separateIqd} /> },
    { key: "saving", header: t("special.saving"), numeric: true, cell: (row) => <Iqd value={row.savingIqd} />, negative: (row) => row.savingIqd < 0 },
  ];
  if (result.access.cost) columns.push({ key: "landed", header: t("col.landedIqd"), numeric: true, cell: (row) => (row.cost ? <span className="grid justify-items-end"><Iqd value={row.cost.landedIqd} />{row.cost.source ? <span className="type-caption text-ink-2">{t(`special.costSource.${row.cost.source}`)}</span> : null}</span> : null) });
  if (result.access.profit) columns.push({ key: "margin", header: t("col.margin"), cell: (row) => (row.margin ? <MarginStatus state={row.margin.state} bps={row.margin.bps} /> : null) });
  return (
    <section aria-labelledby="special-bundles" className="grid gap-3">
      <h2 id="special-bundles" className="adm-h2">
        {t("special.bundlesTitle")}
      </h2>
      <p className="max-w-[70ch] type-caption text-ink-2">{t("special.bundlesLead")}</p>
      {result.bundles.length === 0 ? (
        <EmptyState title={t("special.bundlesEmpty")} text={t("special.bundlesEmptyText")} />
      ) : (
        <DataTable caption={t("special.bundlesTitle")} columns={columns} rows={result.bundles} rowKey={(row) => row.variantId} />
      )}
    </section>
  );
}

/* ───────────────────────────── clearance ───────────────────────────── */

function Clearance({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const result = loaderData.clearance!;
  const columns: DataColumn<ClearanceView>[] = [
    {
      key: "sku",
      header: t("col.sku"),
      cell: (row) => (
        <span className="grid min-w-[12rem]">
          <RowLink to={`/admin/pricing/skus/${row.variantId}`}>
            <bdi dir="ltr">{row.sku}</bdi>
          </RowLink>
          <span className="type-caption text-ink-2">{row.name}</span>
        </span>
      ),
    },
    { key: "price", header: t("col.priceIqd"), numeric: true, cell: (row) => <Iqd value={row.priceIqd} /> },
    { key: "stock", header: t("col.onHand"), numeric: true, cell: (row) => f.number(row.onHand) },
    { key: "age", header: t("special.age"), numeric: true, cell: (row) => (row.oldestStockDays === null ? "—" : t("special.days", { count: row.oldestStockDays })) },
    { key: "last", header: t("special.lastSale"), cell: (row) => (row.lastSoldAt ? <bdi className="nums">{f.date(row.lastSoldAt)}</bdi> : t("special.noSale")) },
  ];
  if (result.access.cost) columns.push({ key: "landed", header: t("col.landedIqd"), numeric: true, cell: (row) => <Iqd value={row.cost?.landedIqd ?? null} /> });
  if (result.access.profit) columns.push({ key: "margin", header: t("col.margin"), cell: (row) => (row.margin ? <MarginStatus state={row.margin.state} bps={row.margin.bps} /> : null) });
  columns.push({
    key: "act",
    header: t("col.action"),
    cell: (row) =>
      row.pendingId ? (
        <Status tone="warn">{t("skus.waiting")}</Status>
      ) : loaderData.canRequest ? (
        <RowLink to={`/admin/pricing/skus/${row.variantId}?mode=clearance`}>{t("special.priceForClearance")}</RowLink>
      ) : null,
  });
  return (
    <section aria-labelledby="special-clearance" className="grid gap-3">
      <h2 id="special-clearance" className="adm-h2">
        {t("special.clearanceTitle")}
      </h2>
      <p className="max-w-[70ch] type-caption text-ink-2">{t("special.clearanceLead", { days: result.minAgeDays })}</p>
      <div className="flex flex-wrap gap-2">
        <Chip as={Link} to="?tab=clearance" selected={!loaderData.all}>
          {t("special.slowOnly")}
        </Chip>
        <Chip as={Link} to="?tab=clearance&all=1" selected={loaderData.all}>
          {t("special.allUnsold")}
        </Chip>
      </div>
      {result.items.length === 0 ? (
        <EmptyState icon="seal-check" title={t("special.clearanceEmpty")} text={t("special.clearanceEmptyText")} />
      ) : (
        <DataTable caption={t("special.clearanceTitle")} columns={columns} rows={result.items} rowKey={(row) => row.variantId} />
      )}
    </section>
  );
}

/* ───────────────────────────── used devices ───────────────────────────── */

function Used({ data: loaderData }: { data: LoaderData }) {
  const t = usePricingT();
  const f = useFormat();
  const result = loaderData.used!;
  const arrow = useArrow();
  const fetcher = useFetcher<typeof action>();
  const [editing, setEditing] = useState<UsedView | null>(null);
  const [price, setPrice] = useState("");
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<{ unit: UsedView; intent: "used-approve" | "used-reject" | "used-cancel" } | null>(null);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !("ok" in fetcher.data) || !fetcher.data.ok) return;
    const done = fetcher.data;
    setOpen(false);
    setEditing(null);
    setDecision(null);
    if (done.intent === "used-price") toast.success(done.result.status === "pending" ? t("special.usedSent") : t("special.usedSaved"));
    else toast.success(t(done.intent === "used-approve" ? "special.usedApproved" : done.intent === "used-reject" ? "special.usedRejected" : "special.usedCancelled"));
  }, [fetcher.state, fetcher.data, t]);
  // The server's own parser: Arabic-Indic digits work, and a fraction is refused instead of misread.
  const typed = typedIqd(price);
  const cost = editing?.acquisitionCostIqd ?? null;
  const belowCost = cost !== null && typed !== null && typed > 0 && typed < cost;
  /** A price change's impact: the price, its share of the new SKU's price, and the acquisition cost for those who see it. */
  const impactOf = (unit: UsedView, to: number | null): ImpactRow[] => [
    { label: t("impact.price"), value: `${iqdText(f, unit.priceIqd)} ${arrow} ${iqdText(f, to)}`, negative: to !== null && to < unit.priceIqd },
    { label: t("special.ofNewLabel"), value: pctText(f, to !== null && to > 0 && unit.newPriceIqd > 0 ? Math.round((to * 10_000) / unit.newPriceIqd) : null) },
    ...(unit.acquisitionCostIqd !== undefined && unit.acquisitionCostIqd !== null ? [{ label: t("special.acquisitionLabel"), value: iqdText(f, unit.acquisitionCostIqd), negative: to !== null && to < unit.acquisitionCostIqd }] : []),
  ];

  return (
    <section aria-labelledby="special-used" className="grid gap-3">
      <h2 id="special-used" className="adm-h2">
        {t("special.usedTitle")}
      </h2>
      <p className="max-w-[70ch] type-caption text-ink-2">{t("special.usedLead")}</p>
      {result.units.length === 0 ? (
        <EmptyState title={t("special.usedEmpty")} text={t("special.usedEmptyText")} />
      ) : (
        <ul role="list" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {result.units.map((unit) => (
            <li key={unit.id} className="adm-card">
              <div className="flex items-start justify-between gap-2">
                <span className="grid">
                  <span className="type-strong">{unit.name}</span>
                  <span className="type-caption text-ink-2">
                    <bdi dir="ltr">{unit.sku}</bdi> · {t("special.grade", { grade: unit.grade })} · {t(`usedStatus.${unit.status}`)}
                    {unit.isDemo ? ` · ${t("special.demo")}` : ""}
                  </span>
                </span>
                <Iqd value={unit.priceIqd} className="type-strong" />
              </div>
              <p className="type-caption text-ink-2">
                {t("special.ofNew", { share: pctText(f, unit.ofNewBps), price: iqdText(f, unit.newPriceIqd) })}
                {unit.acquisitionCostIqd !== undefined ? ` · ${t("special.acquisition", { cost: iqdText(f, unit.acquisitionCostIqd) })}` : ""}
              </p>
              {unit.margin ? unit.margin.state === "below_cost" || unit.margin.state === "no_cost" ? <MarginStatus state={unit.margin.state} bps={unit.margin.bps} /> : <p className="type-caption text-ink">{t("special.marginLine", { margin: pctText(f, unit.margin.bps) })}</p> : null}
              {unit.pending ? <UsedRequest unit={unit} canApprove={result.canApprove} canOverride={result.canOverride} onDecide={(intent) => setDecision({ unit, intent })} /> : null}
              {result.canEdit && unit.priceable && !unit.pending ? (
                editing?.id === unit.id ? (
                  <form
                    className="grid gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      setOpen(true);
                    }}
                  >
                    <TextField label={t("special.newPrice")} inputMode="numeric" ltr value={price} onChange={(event) => setPrice(event.currentTarget.value)} end={t("common.iqd")} required error={failed?.fields?.price} />
                    <div className="flex gap-2">
                      <Key type="submit" size="sm" variant="ink" disabled={typed === null || typed <= 0}>
                        {t("special.review")}
                      </Key>
                      <Key size="sm" variant="quiet" onClick={() => setEditing(null)}>
                        {t("common.cancel")}
                      </Key>
                    </div>
                  </form>
                ) : (
                  <div>
                    <Key
                      size="sm"
                      icon="pencil-simple"
                      onClick={() => {
                        setEditing(unit);
                        setPrice(String(unit.priceIqd));
                      }}
                    >
                      {t("special.changePrice")}
                    </Key>
                  </div>
                )
              ) : !unit.priceable ? (
                <p className="type-caption text-ink-2">{t("special.notPriceable")}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          title={t("special.usedConfirmTitle", { name: editing.name })}
          consequence={belowCost ? t("special.usedBelowCost") : t("special.usedConsequence")}
          confirmLabel={t("special.usedSave")}
          impact={impactOf(editing, typed !== null && typed > 0 ? typed : null)}
          reason={{ minLength: 3, label: t("common.reason") }}
          pending={fetcher.state !== "idle"}
          error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
          onConfirm={({ reason }) => fetcher.submit({ intent: "used-price", usedUnitId: editing.id, price, expectedPriceIqd: String(editing.priceIqd), reason }, { method: "post" })}
        />
      ) : null}
      {decision?.unit.pending ? (
        <ConfirmDialog
          open
          onClose={() => setDecision(null)}
          tone={decision.intent === "used-approve" ? "neutral" : "destructive"}
          title={t(decision.intent === "used-approve" ? "special.usedApproveTitle" : decision.intent === "used-reject" ? "special.usedRejectTitle" : "special.usedCancelTitle", { name: decision.unit.name })}
          consequence={t(decision.intent === "used-approve" ? "special.usedApproveConsequence" : decision.intent === "used-reject" ? "special.usedRejectConsequence" : "special.usedCancelConsequence")}
          confirmLabel={t(decision.intent === "used-approve" ? "changes.approve" : decision.intent === "used-reject" ? "changes.reject" : "changes.cancel")}
          impact={impactOf(decision.unit, decision.unit.pending.toIqd)}
          reason={decision.intent === "used-reject" ? { minLength: 3, label: t("changes.rejectReason"), hint: t("changes.rejectHint") } : { noteRequired: false, label: t("common.note") }}
          pending={fetcher.state !== "idle"}
          error={failed ? (failed.message ?? t("errors.generic")) : undefined}
          onConfirm={({ reason }) => fetcher.submit({ intent: decision.intent, approvalId: decision.unit.pending!.id, note: reason }, { method: "post" })}
        />
      ) : null}
    </section>
  );
}

/** A used-device price waiting for a second person: who asked, why, and what this employee may do with it. */
function UsedRequest({ unit, canApprove, canOverride, onDecide }: { unit: UsedView; canApprove: boolean; canOverride: boolean; onDecide: (intent: "used-approve" | "used-reject" | "used-cancel") => void }) {
  const t = usePricingT();
  const f = useFormat();
  const request = unit.pending!;
  const mayDecide = canApprove && !request.mine && (!request.needsOverride || canOverride);
  return (
    <div className="grid gap-1 rounded-sm bg-niche p-2" role="note">
      <span className="flex flex-wrap items-center gap-2">
        <Status tone="warn">{t("special.usedPendingTitle")}</Status>
        {request.reasons.map((reason) => (
          <Status key={reason} tone={reason === "below_cost" ? "bad" : "warn"}>
            {/* A used device's cost is what the store paid for it, not a landed cost. */}
            {reason === "below_cost" ? t("special.belowAcquisition") : t(`reason.${reason}`)}
          </Status>
        ))}
      </span>
      <p className="type-body text-ink">{t("sku.pendingText", { from: iqdText(f, request.fromIqd), to: iqdText(f, request.toIqd) })}</p>
      {request.reason ? <p className="type-caption text-ink">{request.reason}</p> : null}
      <ByLine name={request.requestedBy?.name} at={request.createdAt} />
      <div className="flex flex-wrap gap-2">
        {mayDecide ? (
          <>
            <Key size="sm" variant="ink" onClick={() => onDecide("used-approve")}>
              {t("changes.approve")}
            </Key>
            <Key size="sm" onClick={() => onDecide("used-reject")}>
              <span className="text-red-ink">{t("changes.reject")}</span>
            </Key>
          </>
        ) : null}
        {request.mine ? (
          <Key size="sm" onClick={() => onDecide("used-cancel")}>
            {t("changes.cancel")}
          </Key>
        ) : null}
      </div>
      {request.mine ? <p className="type-caption text-ink-2">{t("special.usedOwn")}</p> : null}
      {!request.mine && canApprove && request.needsOverride && !canOverride ? <p className="type-caption text-ink-2">{t("special.usedOverrideMissing")}</p> : null}
    </div>
  );
}
