import { useEffect, useState, type KeyboardEvent } from "react";
import { useFetcher } from "react-router";

import type { Route } from "./+types/editor-variants";
import { useFormat, useLocale } from "~/i18n/react";
import { can } from "~/server/actor";
import { getVariantsEditor, saveVariant, setVariantActive } from "~/server/services/admin/catalog/variants.server";
import type { VariantEditorRow } from "~/server/services/admin/catalog/variants.server";
import { VARIANT_CONDITIONS } from "~/server/services/admin/catalog/rules";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Sheet } from "~/ui/Sheet";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { answered, catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, Iqd, L10nFields, isFailure, useAnswerToast, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/products/:id/variants — the product's SKU variants (02.01): options (platform, colour, capacity,
 * edition, region, condition), the maker's model number, barcodes (a scanner types into the barcode field; Enter
 * moves on instead of saving), serial tracking, the default variant, and switching a variant off with a reason.
 * Prices are read-only (module 03); landed cost and margin appear only for employees holding cost.read / profit.read.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  const editor = await answered(getVariantsEditor(db, actor, params.id, locale));
  return { editor, can: { create: can(actor, "catalog.product.create"), update: can(actor, "catalog.product.update") } };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.read");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    save: async () => saveVariant(req.db, req.actor, { ...form, productId: params.id }, req.now),
    active: async () => setVariantActive(req.db, req.actor, { ...form, productId: params.id }, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

const AXES = ["platform", "color", "storage", "edition", "region"] as const;

export default function ProductVariants({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const { editor, can: allowed } = loaderData;
  const [editing, setEditing] = useState<VariantEditorRow | "new" | null>(null);
  const [switching, setSwitching] = useState<VariantEditorRow | null>(null);
  const toggle = useFetcher<typeof action>({ key: `catalog-variant-active-${editor.productId}` });
  useAnswerToast(toggle, t("variants.saved"));
  useEffect(() => {
    if (toggle.state === "idle" && toggle.data && !isFailure(toggle.data)) setSwitching(null);
  }, [toggle.state, toggle.data]);

  const optionsText = (row: VariantEditorRow) =>
    [...AXES.map((axis) => row.options[axis]).filter(Boolean), row.options.condition ? t(`variants.conditions.${row.options.condition}`) : null].filter(Boolean).join(" · ") || "—";

  const columns: DataColumn<VariantEditorRow>[] = [
    {
      key: "sku",
      header: t("variants.colSku"),
      cell: (row) => (
        <span className="grid gap-0.5 py-1.5">
          <bdi dir="ltr" className="font-semibold">
            {row.sku}
          </bdi>
          <span className="type-caption text-ink-2">{row.titleText || "—"}</span>
          <span className="flex flex-wrap gap-1">
            {row.isDefault ? <span className="rounded-xs border border-line px-1.5 type-caption">{t("variants.defaultTag")}</span> : null}
            {row.trackSerials ? <span className="rounded-xs border border-line px-1.5 type-caption">{t("variants.serialTag")}</span> : null}
          </span>
        </span>
      ),
    },
    { key: "options", header: t("variants.colOptions"), cell: (row) => <span className="type-caption">{optionsText(row)}</span> },
    {
      key: "codes",
      header: t("variants.colCodes"),
      cell: (row) => (
        <span className="grid gap-0.5 type-caption">
          <bdi dir="ltr">{row.options.model ?? "—"}</bdi>
          <bdi dir="ltr" className="text-ink-2">
            {[row.barcode, ...row.extraBarcodes].filter(Boolean).join(" · ") || "—"}
          </bdi>
        </span>
      ),
    },
    { key: "price", header: t("variants.colPrice"), numeric: true, cell: (row) => <Iqd amount={row.priceIqd} plain /> },
    { key: "stock", header: t("variants.colStock"), numeric: true, cell: (row) => <bdi className="nums">{f.number(row.available)}</bdi> },
    ...(editor.showCost
      ? [{ key: "cost", header: t("variants.colCost"), numeric: true, cell: (row: VariantEditorRow) => (row.landedCostIqd ? <bdi className="nums">{f.number(row.landedCostIqd)}</bdi> : <span>{t("variants.noCost")}</span>) }]
      : []),
    ...(editor.showMargin
      ? [{ key: "margin", header: t("variants.colMargin"), numeric: true, negative: (row: VariantEditorRow) => (row.marginBps ?? 0) < 0, cell: (row: VariantEditorRow) => (row.marginBps === null || row.marginBps === undefined ? <span>{t("variants.noCost")}</span> : <bdi className="nums">{f.percent(row.marginBps / 10_000)}</bdi>) }]
      : []),
    { key: "state", header: t("variants.colState"), cell: (row) => (row.isActive ? <Status tone="ok">{t("variants.active")}</Status> : <Status tone="neutral">{t("variants.inactive")}</Status>) },
    {
      key: "actions",
      header: <span className="sr-only">{t("common.edit")}</span>,
      cell: (row) =>
        allowed.update ? (
          <span className="flex gap-1.5">
            <Key size="sm" icon="pencil-simple" onClick={() => setEditing(row)}>
              {t("common.edit")}
            </Key>
            <Key size="sm" onClick={() => setSwitching(row)} className={row.isActive ? "[--on:var(--red-ink)]" : undefined}>
              {row.isActive ? t("variants.deactivate") : t("variants.activate")}
            </Key>
          </span>
        ) : null,
    },
  ];

  return (
    <section className="adm-section" aria-labelledby="variants-title">
      <div className="adm-section__head">
        <div className="grid gap-1">
          <h2 id="variants-title" className="adm-h2">
            {t("variants.title")}
          </h2>
          <p className="max-w-[70ch] type-caption text-ink-2">{t("variants.lead")}</p>
          {editor.showCost ? <p className="type-caption text-ink-2">{t("variants.costNote")}</p> : null}
        </div>
        {allowed.create ? (
          <Key icon="plus" variant="ink" onClick={() => setEditing("new")}>
            {t("variants.add")}
          </Key>
        ) : null}
      </div>

      {editor.rows.length === 0 ? (
        <EmptyState icon="barcode" title={t("variants.empty")} action={allowed.create ? <Key icon="plus" onClick={() => setEditing("new")}>{t("variants.add")}</Key> : undefined} />
      ) : (
        <>
          <div className="hidden md:block">
            <DataTable caption={t("variants.caption")} columns={columns} rows={editor.rows} rowKey={(row) => row.id} maxHeight={null} />
          </div>
          <ul role="list" className="grid gap-2 md:hidden">
            {editor.rows.map((row) => (
              <li key={row.id} className="adm-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="grid gap-0.5">
                    <bdi dir="ltr" className="type-strong">
                      {row.sku}
                    </bdi>
                    <span className="type-caption text-ink-2">{row.titleText || optionsText(row)}</span>
                  </div>
                  {row.isActive ? <Status tone="ok">{t("variants.active")}</Status> : <Status tone="neutral">{t("variants.inactive")}</Status>}
                </div>
                <dl className="grid grid-cols-2 gap-2 type-caption">
                  <div>
                    <dt className="text-ink-2">{t("variants.colPrice")}</dt>
                    <dd className="type-label">
                      <Iqd amount={row.priceIqd} plain />
                    </dd>
                  </div>
                  {editor.showCost ? (
                    <div>
                      <dt className="text-ink-2">{t("variants.colCost")}</dt>
                      <dd className="type-label nums">{row.landedCostIqd ? f.number(row.landedCostIqd) : t("variants.noCost")}</dd>
                    </div>
                  ) : null}
                  {editor.showMargin ? (
                    <div>
                      <dt className="text-ink-2">{t("variants.colMargin")}</dt>
                      <dd className={(row.marginBps ?? 0) < 0 ? "type-label nums text-red-ink" : "type-label nums"}>{row.marginBps === null || row.marginBps === undefined ? t("variants.noCost") : f.percent(row.marginBps / 10_000)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt className="text-ink-2">{t("variants.colStock")}</dt>
                    <dd className="type-label nums">{f.number(row.available)}</dd>
                  </div>
                </dl>
                {allowed.update ? (
                  <div className="flex gap-2">
                    <Key size="sm" icon="pencil-simple" onClick={() => setEditing(row)}>
                      {t("common.edit")}
                    </Key>
                    <Key size="sm" onClick={() => setSwitching(row)} className={row.isActive ? "[--on:var(--red-ink)]" : undefined}>
                      {row.isActive ? t("variants.deactivate") : t("variants.activate")}
                    </Key>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}

      <VariantSheet key={editing === "new" ? "new" : (editing?.id ?? "none")} productId={editor.productId} version={editor.version} live={editor.live} serialsByDefault={editor.kind === "console"} variant={editing} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={switching !== null}
        onClose={() => setSwitching(null)}
        tone={switching?.isActive ? "destructive" : "neutral"}
        title={switching ? t(switching.isActive ? "variants.deactivateQ" : "variants.activateQ", { sku: switching.sku }) : ""}
        consequence={switching ? t(switching.isActive ? "variants.deactivateDo" : "variants.activateDo") : ""}
        confirmLabel={switching?.isActive ? t("variants.deactivate") : t("variants.activate")}
        cancelLabel={t("common.cancel")}
        impact={
          switching
            ? [
                { label: t("impact.stock"), value: t("impact.stockSame", { count: f.number(switching.available) }) },
                { label: t("impact.prices"), value: t("impact.pricesSame") },
              ]
            : undefined
        }
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={toggle.state !== "idle"}
        error={isFailure(toggle.data) ? <FailureNotice result={toggle.data} /> : undefined}
        onConfirm={({ reason }) => {
          if (!switching) return;
          toggle.submit({ intent: "active", variantId: switching.id, version: String(editor.version), active: String(!switching.isActive), reason }, { method: "post" });
        }}
      />
    </section>
  );
}

/** Enter in the barcode field (what a keyboard-wedge scanner sends after the code) moves to the next field. */
function scannerEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  const form = event.currentTarget.form;
  if (!form) return;
  const fields = [...form.querySelectorAll<HTMLElement>("input:not([type=hidden]), textarea, select")];
  fields[fields.indexOf(event.currentTarget) + 1]?.focus();
}

function VariantSheet({
  productId,
  version,
  live,
  serialsByDefault,
  variant,
  onClose,
}: {
  productId: string;
  version: number;
  live: boolean;
  /** A new console variant is tracked by serial number unless staff say otherwise (as the first SKU of a new product is). */
  serialsByDefault: boolean;
  variant: VariantEditorRow | "new" | null;
  onClose: () => void;
}) {
  const t = useCatalogT();
  const locale = useLocale();
  const fetcher = useFetcher<typeof action>({ key: `catalog-variant-${productId}` });
  const answer = fetcher.data as unknown;
  const fieldError = useFieldError(answer);
  useAnswerToast(fetcher, t("variants.saved"));
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !isFailure(fetcher.data)) onClose();
  }, [fetcher.state, fetcher.data, onClose]);
  const row = variant === "new" ? null : variant;
  const formId = `variant-form-${row?.id ?? "new"}`;
  return (
    <Sheet
      open={variant !== null}
      onClose={onClose}
      presentation="side"
      title={row ? t("variants.edit") : t("variants.add")}
      description={row ? <bdi dir="ltr">{row.sku}</bdi> : t("newProduct.skuHint")}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"}>
            {t("common.cancel")}
          </Key>
          <Key type="submit" form={formId} variant="ink" icon="floppy-disk" loading={fetcher.state !== "idle"}>
            {t("common.saveShort")}
          </Key>
        </>
      }
    >
      <fetcher.Form id={formId} method="post" noValidate className="grid gap-4" lang={locale}>
        <input type="hidden" name="intent" value="save" />
        <input type="hidden" name="version" value={version} />
        {row ? <input type="hidden" name="variantId" value={row.id} /> : null}
        {!row && live ? <p className="adm-notice">{t("variants.liveNew")}</p> : null}
        <TextField name="sku" label={t("variants.sku")} required defaultValue={row?.sku ?? ""} ltr autoCapitalize="characters" maxLength={64} error={fieldError("sku")} />
        <TextField name="barcode" label={t("variants.barcode")} hint={t("variants.barcodeHint")} defaultValue={row?.barcode ?? ""} ltr inputMode="numeric" autoComplete="off" onKeyDown={scannerEnter} error={fieldError("barcode")} />
        <TextField name="extraBarcodes" label={t("variants.extraBarcodes")} hint={t("variants.extraHint")} defaultValue={row?.extraBarcodes.join(", ") ?? ""} ltr autoComplete="off" onKeyDown={scannerEnter} error={fieldError("extraBarcodes")} />
        <L10nFields name="title" label={t("variants.titleField")} value={row?.title ?? null} maxLength={200} error={fieldError} />
        <div className="grid gap-3 sm:grid-cols-2">
          {AXES.map((axis) => (
            <TextField key={axis} name={`options.${axis}`} label={t(`variants.${axis}`)} defaultValue={row?.options[axis] ?? ""} maxLength={80} error={fieldError(`options.${axis}`)} />
          ))}
          <Select name="options.condition" label={t("variants.condition")} defaultValue={row?.options.condition ?? ""} options={[{ value: "", label: t("variants.conditionNone") }, ...VARIANT_CONDITIONS.map((value) => ({ value, label: t(`variants.conditions.${value}`) }))]} />
          <TextField name="options.model" label={t("variants.model")} defaultValue={row?.options.model ?? ""} ltr maxLength={80} error={fieldError("options.model")} />
          <TextField name="sort" label={t("variants.sort")} defaultValue={row?.sort ?? ""} inputMode="numeric" error={fieldError("sort")} />
        </div>
        <TextArea name="otherOptions" label={t("variants.otherOptions")} hint={t("variants.otherHint")} defaultValue={row?.otherOptions ?? ""} rows={3} dir="ltr" error={fieldError("otherOptions")} />
        <Checkbox name="trackSerials" label={t("variants.trackSerials")} hint={t("variants.trackSerialsHint")} defaultChecked={row?.trackSerials ?? serialsByDefault} />
        {/* A new variant of a live product starts switched off, and a switched-off variant is never the default. */}
        {row || !live ? <Checkbox name="isDefault" label={t("variants.isDefault")} defaultChecked={row?.isDefault ?? false} /> : null}
        <TextField name="reason" label={t("common.reasonOptional")} maxLength={500} />
        {isFailure(answer) ? <FailureNotice result={answer} /> : null}
      </fetcher.Form>
    </Sheet>
  );
}
