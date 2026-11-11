import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/list";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { getPriceList, removeListItem, savePriceList, setListItem, type ListItemView } from "~/server/services/admin/pricing/lists.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { baghdadInput, ListForm, LIST_STATE_TONE, type ListFormValues } from "./list-form";
import { failure, formObject, requirePricing } from "./route.server";
import { failureOf, Iqd, iqdText, MarginStatus, PageHead, Pct, pricingMeta, RowLink, typedIqd, usePricingT } from "./shared";

type DialogState = { kind: "save" } | { kind: "item-set" } | { kind: "item-remove"; item: ListItemView };

const READERS = ["pricing.price_list.manage", "pricing.price.update", "pricing.price.approve", "pricing.discount.override", "pricing.simulation.run"] as const;

/** /admin/pricing/lists/:listId — one price list: its scope and window, and its prices per SKU and quantity (03.04). */
export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db, READERS);
  try {
    return await getPriceList(db, actor, params.listId, ctx.locale, ctx.now);
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "save" && intent !== "item-set" && intent !== "item-remove") throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, "pricing.price_list.manage");
  const fields = { ...formObject(form), listId: params.listId };
  try {
    if (intent === "save") return { ok: true as const, intent, result: await savePriceList(db, actor, { ...fields, id: params.listId }, ctx.locale, ctx.now) };
    if (intent === "item-set") return { ok: true as const, intent, result: await setListItem(db, actor, fields, ctx.now) };
    await removeListItem(db, actor, fields, ctx.now);
    return { ok: true as const, intent, result: null };
  } catch (error) {
    return failure(error, ctx.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "lists.metaTitle", { code: args.loaderData?.list.code ?? "" });

export default function PriceListPage({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const { list, items, options, access, canManage } = loaderData;
  const fetcher = useFetcher<typeof action>();
  const failed = failureOf(fetcher.data);
  const [values, setValues] = useState<ListFormValues>(() => ({
    id: list.id,
    code: list.code,
    nameAr: list.nameL10n.ar,
    nameEn: list.nameL10n.en ?? "",
    channel: list.channel ?? "",
    branchId: list.branchId ?? "",
    segmentId: list.segmentId ?? "",
    priority: String(list.priority),
    startsOn: baghdadInput(list.startsAt),
    endsOn: baghdadInput(list.endsAt),
    isActive: list.isActive,
    expectedUpdatedAt: String(list.updatedAt),
  }));
  const [editing, setEditing] = useState(false);
  const [sku, setSku] = useState("");
  const [minQty, setMinQty] = useState("1");
  const [price, setPrice] = useState("");
  const [compareAt, setCompareAt] = useState("");
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const priceRef = useRef<HTMLInputElement | null>(null);
  const skuRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !("ok" in fetcher.data) || !fetcher.data.ok) return;
    setDialog(null);
    if (fetcher.data.intent === "save") {
      setEditing(false);
      toast.success(t("lists.saved"));
    } else if (fetcher.data.intent === "item-set") {
      setSku("");
      setPrice("");
      setCompareAt("");
      setMinQty("1");
      toast.success(t("lists.itemSaved"));
      skuRef.current?.focus();
    } else toast.success(t("lists.itemRemoved"));
  }, [fetcher.state, fetcher.data, t]);

  const columns: DataColumn<ListItemView>[] = [
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
    { key: "qty", header: t("lists.minQty"), numeric: true, cell: (row) => f.number(row.minQty) },
    { key: "base", header: t("lists.basePrice"), numeric: true, cell: (row) => <Iqd value={row.basePriceIqd} /> },
    {
      key: "price",
      header: t("lists.listPrice"),
      numeric: true,
      cell: (row) => (
        <span className="grid justify-items-end">
          <Iqd value={row.priceIqd} />
          {row.compareAtIqd !== null ? <Iqd value={row.compareAtIqd} strike className="type-caption" /> : null}
        </span>
      ),
    },
    { key: "diff", header: t("lists.diff"), numeric: true, cell: (row) => <Pct bps={row.diffBps} signed />, negative: (row) => (row.diffBps ?? 0) < 0 },
  ];
  if (access.cost) columns.push({ key: "landed", header: t("col.landedIqd"), numeric: true, cell: (row) => <Iqd value={row.cost?.landedIqd ?? null} /> });
  if (access.profit) columns.push({ key: "margin", header: t("col.margin"), cell: (row) => (row.margin ? <MarginStatus state={row.margin.state} bps={row.margin.bps} /> : null) });
  if (canManage)
    columns.push({
      key: "remove",
      header: t("col.action"),
      cell: (row) => (
        <Key size="sm" onClick={() => setDialog({ kind: "item-remove", item: row })}>
          <span className="text-red-ink">{t("lists.remove")}</span>
        </Key>
      ),
    });

  // The server's own parser: Arabic-Indic digits and separators work ("٧٣٥٬٠٠٠"); a fraction is refused, not misread.
  const typedPrice = typedIqd(price) ?? Number.NaN;

  return (
    <>
      <PageHead
        eyebrow={<RowLink to="/admin/pricing/lists">{t("lists.back")}</RowLink>}
        title={
          <>
            <bdi dir="ltr">{list.code}</bdi> · {list.name}
          </>
        }
        lead={t("lists.scopeLine", { channel: list.scopeLabels.channel ?? t("lists.any"), branch: list.scopeLabels.branch ?? t("lists.any"), segment: list.scopeLabels.segment ?? t("lists.any"), priority: list.priority })}
        actions={
          <>
            <Status tone={LIST_STATE_TONE[list.state]}>{t(`lists.state.${list.state}`)}</Status>
            {canManage && !editing ? (
              <Key size="sm" icon="pencil-simple" onClick={() => setEditing(true)}>
                {t("lists.edit")}
              </Key>
            ) : null}
          </>
        }
      />
      <p className="mb-4 max-w-[70ch] rounded-sm bg-niche p-3 type-body text-ink" role="note">
        {t("lists.notApplied")}
      </p>

      {editing ? (
        <section className="adm-card mb-6" aria-labelledby="list-edit">
          <h2 id="list-edit" className="adm-h2">
            {t("lists.edit")}
          </h2>
          <ListForm values={values} onChange={setValues} options={options} errors={failed?.intent === "save" ? failed.fields : undefined} onSubmit={() => setDialog({ kind: "save" })} onCancel={() => setEditing(false)} submitLabel={t("lists.save")} />
        </section>
      ) : null}

      {canManage ? (
        <section className="adm-card mb-6" aria-labelledby="list-add">
          <h2 id="list-add" className="adm-h2">
            {t("lists.addTitle")}
          </h2>
          <p className="type-caption text-ink-2">{t("lists.addLead")}</p>
          <form
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              setDialog({ kind: "item-set" });
            }}
          >
            <TextField
              ref={skuRef}
              label={t("lists.skuOrBarcode")}
              ltr
              value={sku}
              onChange={(event) => setSku(event.currentTarget.value)}
              onKeyDown={(event) => {
                // A barcode scanner types the code and presses Enter: move on to the price instead of submitting.
                if (event.key === "Enter" && !price) {
                  event.preventDefault();
                  priceRef.current?.focus();
                }
              }}
              required
              hint={t("lists.scanHint")}
              error={failed?.intent === "item-set" ? failed.fields?.sku : undefined}
            />
            <TextField label={t("lists.minQty")} inputMode="numeric" ltr value={minQty} onChange={(event) => setMinQty(event.currentTarget.value)} error={failed?.intent === "item-set" ? failed.fields?.minQty : undefined} />
            <TextField ref={priceRef} label={t("lists.listPrice")} inputMode="numeric" ltr value={price} onChange={(event) => setPrice(event.currentTarget.value)} end={t("common.iqd")} required error={failed?.intent === "item-set" ? failed.fields?.price : undefined} />
            <TextField label={t("lists.compareAt")} inputMode="numeric" ltr value={compareAt} onChange={(event) => setCompareAt(event.currentTarget.value)} end={t("common.iqd")} optional hint={t("lists.compareAtHint")} error={failed?.intent === "item-set" ? failed.fields?.compareAt : undefined} />
            <div className="flex items-end">
              <Key type="submit" variant="ink" icon="plus" disabled={!sku.trim() || !(typedPrice > 0)}>
                {t("lists.add")}
              </Key>
            </div>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="list-items" className="grid gap-3">
        <h2 id="list-items" className="adm-h2">
          {t("lists.itemsTitle", { count: items.length })}
        </h2>
        {items.length === 0 ? <EmptyState title={t("lists.itemsEmpty")} text={t("lists.itemsEmptyText")} /> : <DataTable caption={t("lists.itemsTitle", { count: items.length })} columns={columns} rows={items} rowKey={(row) => `${row.variantId}:${row.minQty}`} />}
      </section>

      {dialog ? (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          tone={dialog.kind === "item-remove" ? "destructive" : "neutral"}
          title={dialog.kind === "save" ? t("lists.saveTitle", { code: list.code }) : dialog.kind === "item-set" ? t("lists.addConfirmTitle", { sku: sku.trim() }) : t("lists.removeTitle", { sku: dialog.item.sku })}
          consequence={dialog.kind === "save" ? t("lists.saveConsequence") : dialog.kind === "item-set" ? t("lists.addConsequence") : t("lists.removeConsequence")}
          confirmLabel={dialog.kind === "save" ? t("lists.save") : dialog.kind === "item-set" ? t("lists.add") : t("lists.remove")}
          impact={
            dialog.kind === "item-set"
              ? [
                  { label: t("lists.listPrice"), value: iqdText(f, typedPrice > 0 ? typedPrice : null) },
                  { label: t("lists.minQty"), value: minQty || "1" },
                ]
              : dialog.kind === "item-remove"
                ? [{ label: t("lists.listPrice"), value: iqdText(f, dialog.item.priceIqd) }]
                : undefined
          }
          reason={{ minLength: 3, label: t("common.reason"), hint: dialog.kind === "item-set" ? t("lists.overrideHint") : undefined }}
          pending={fetcher.state !== "idle"}
          error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
          onConfirm={({ reason }) => {
            if (dialog.kind === "save") fetcher.submit({ intent: "save", ...values, isActive: values.isActive ? "1" : "", reason }, { method: "post" });
            else if (dialog.kind === "item-set") fetcher.submit({ intent: "item-set", sku, minQty, price, compareAt, reason }, { method: "post" });
            else fetcher.submit({ intent: "item-remove", variantId: dialog.item.variantId, minQty: String(dialog.item.minQty), reason }, { method: "post" });
          }}
        />
      ) : null}
    </>
  );
}
