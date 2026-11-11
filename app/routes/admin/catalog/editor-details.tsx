import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/editor-details";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { categoryOptions, deviceModelOptions, getProductEditor, platformOptions, updateProductDetails } from "~/server/services/admin/catalog/product.server";
import { AGE_RATING_SUGGESTIONS, LICENSE_TYPE_LIST, MEDIA_FORMAT_LIST, PRODUCT_KIND_LIST, REGION_SUGGESTIONS, type Requirement } from "~/server/services/admin/catalog/rules";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { canSeeModule } from "../shell/access.server";
import { adminMeta } from "../shell/meta";
import { answered, catalogRequest, formObject, runIntent } from "./catalog.server";
import { SpecsEditor } from "./components/SpecsEditor";
import { FailureNotice, Iqd, L10nFields, isFailure, useAnswerToast, useCatalogT, useFieldError, useKindLabel } from "./components/ui";

/**
 * /admin/catalog/products/:id — the product's details: texts in Arabic (required), English and Sorani, its facts
 * (kind, category, platform, device, the store's warranty, age rating, region, licence, format), specs by spec key,
 * custom fields, and the readiness checklist (02.03). Saving needs catalog.product.update; the form carries the
 * version it was loaded with, so a second tab or a double submit cannot overwrite a newer save. Prices and stock are
 * shown read-only (modules 03 and 04).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.read");
  const [editor, categories, platforms, models] = await Promise.all([answered(getProductEditor(db, actor, params.id, locale, now)), categoryOptions(db, locale), platformOptions(db, locale), deviceModelOptions(db, locale)]);
  return { editor, categories, platforms, models, can: { update: can(actor, "catalog.product.update"), pricing: canSeeModule(actor, "pricing") } };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.update");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    save: async () => updateProductDetails(req.db, req.actor, { ...form, productId: params.id }, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

/** Where each requirement is fixed. */
function fixLink(productId: string, requirement: Requirement): string {
  const base = `/admin/catalog/products/${productId}`;
  switch (requirement) {
    case "variants":
    case "prices":
      return `${base}/variants`;
    case "images":
      return `${base}/media`;
    case "compatibility":
      return `${base}/compatibility`;
    case "bundle_components":
      return `${base}/bundle`;
    case "name_ar":
    case "description_ar":
      return "#texts";
    default:
      return "#facts";
  }
}

export default function ProductDetails({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const kindLabel = useKindLabel();
  const { editor, categories, platforms, models, can: allowed } = loaderData;
  const { product, completeness, customFields } = editor;
  const fetcher = useFetcher<typeof action>({ key: `catalog-details-${product.id}` });
  const answer = fetcher.data as unknown;
  const fieldError = useFieldError(answer);
  useAnswerToast(fetcher, t("common.saved"));
  const readOnly = !allowed.update || product.storedStatus === "archived";
  const busy = fetcher.state !== "idle";

  const [kind, setKind] = useState(product.kind);

  const missing = [...completeness.missing.map((key) => ({ key, label: t(`requirement.${key}`), href: fixLink(product.id, key) })), ...completeness.missingCustom.map((key) => ({ key: `custom:${key}`, label: t("requirement.custom", { name: customFields.find((field) => field.key === key)?.label ?? key }), href: "#custom" }))];

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        {product.storedStatus === "archived" ? <p className="adm-notice mb-4">{t("editor.archivedNote")}</p> : null}
        {product.storedStatus === "review" ? <p className="adm-notice mb-4">{t("editor.reviewNote")}</p> : null}
        {!allowed.update ? <p className="adm-notice mb-4">{t("editor.cannotEdit")}</p> : null}

        <fetcher.Form method="post" noValidate className="grid gap-8 pb-24" aria-busy={busy || undefined}>
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="version" value={product.version} />
          <fieldset disabled={readOnly} className="grid min-w-0 gap-8">
            <section className="adm-section mb-0" aria-labelledby="texts-title" id="texts">
              <div className="grid gap-1">
                <h2 id="texts-title" className="adm-h2">
                  {t("editor.texts")}
                </h2>
                <p className="type-caption text-ink-2">{t("editor.textsLead")}</p>
              </div>
              <L10nFields name="name" label={t("editor.name")} value={product.name} required maxLength={200} error={fieldError} />
              <L10nFields name="short" label={t("editor.short")} value={product.short} maxLength={300} error={fieldError} />
              <L10nFields name="description" label={t("editor.description")} value={product.description} multiline rows={5} maxLength={8000} error={fieldError} />
              <L10nFields name="searchKeywords" label={t("editor.keywords")} value={product.searchKeywords} maxLength={600} hint={t("editor.keywordsHint")} error={fieldError} />
            </section>

            <section className="adm-section mb-0" aria-labelledby="facts-title" id="facts">
              <h2 id="facts-title" className="adm-h2">
                {t("editor.facts")}
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <Select name="kind" label={t("editor.kind")} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} options={PRODUCT_KIND_LIST.map((value) => ({ value, label: kindLabel(value) }))} error={fieldError("kind")} />
                <TextField name="slug" label={t("editor.slug")} defaultValue={product.slug} ltr readOnly={product.slugLocked} hint={product.slugLocked ? t("editor.slugLocked") : t("newProduct.slugHint")} error={fieldError("slug")} />
                <TextField name="brand" label={t("editor.brand")} defaultValue={product.brand ?? ""} maxLength={80} error={fieldError("brand")} />
                <Select
                  name="categoryId"
                  label={t("editor.category")}
                  defaultValue={product.categoryId ?? ""}
                  required
                  options={[{ value: "", label: t("editor.categoryPick") }, ...categories.map((category) => ({ value: category.id, label: category.active ? category.label : `${category.label} (${t("categories.inactiveTag")})` }))]}
                  error={fieldError("categoryId")}
                />
                <Select name="platformId" label={t("editor.platform")} defaultValue={product.platformId ?? ""} options={[{ value: "", label: t("editor.platformNone") }, ...platforms.map((platform) => ({ value: platform.id, label: platform.name }))]} error={fieldError("platformId")} />
                <Select
                  name="deviceModelId"
                  label={t("editor.deviceModel")}
                  defaultValue={product.deviceModelId ?? ""}
                  options={[{ value: "", label: t("editor.deviceNone") }, ...models.map((model) => ({ value: model.id, label: `${platforms.find((platform) => platform.id === model.platformId)?.name ?? ""} › ${model.name}` }))]}
                  error={fieldError("deviceModelId")}
                />
                <TextField name="warrantyMonths" label={t("editor.warranty")} defaultValue={product.warrantyMonths ?? ""} inputMode="numeric" hint={t("editor.warrantyHint")} error={fieldError("warrantyMonths")} />
                <TextField name="ageRating" label={t("editor.ageRating")} defaultValue={product.ageRating ?? ""} list="catalog-age-ratings" maxLength={40} hint={t("editor.ageRatingHint")} ltr error={fieldError("ageRating")} />
                <TextField name="region" label={t("editor.region")} defaultValue={product.region ?? ""} list="catalog-regions" maxLength={40} hint={t("editor.regionHint")} ltr error={fieldError("region")} />
                <Select name="licenseType" label={t("editor.licenseType")} defaultValue={product.licenseType ?? ""} options={[{ value: "", label: t("editor.licenseNone") }, ...LICENSE_TYPE_LIST.map((value) => ({ value, label: t(`editor.license.${value}`) }))]} error={fieldError("licenseType")} />
                <Select name="mediaFormat" label={t("editor.mediaFormat")} defaultValue={product.mediaFormat ?? ""} options={[{ value: "", label: t("editor.mediaNone") }, ...MEDIA_FORMAT_LIST.map((value) => ({ value, label: t(`editor.media.${value}`) }))]} error={fieldError("mediaFormat")} />
              </div>
              <datalist id="catalog-age-ratings">
                {AGE_RATING_SUGGESTIONS.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <datalist id="catalog-regions">
                {REGION_SUGGESTIONS.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
            </section>

            <section className="adm-section mb-0" aria-labelledby="specs-title" id="specs">
              <div className="grid gap-1">
                <h2 id="specs-title" className="adm-h2">
                  {t("editor.specs")}
                </h2>
                <p className="type-caption text-ink-2">{t("editor.specsLead")}</p>
              </div>
              <SpecsEditor rows={product.specs} error={fieldError} resetKey={product.version} />
            </section>

            {customFields.length > 0 ? (
              <section className="adm-section mb-0" aria-labelledby="custom-title" id="custom">
                <div className="grid gap-1">
                  <h2 id="custom-title" className="adm-h2">
                    {t("editor.custom")}
                  </h2>
                  <p className="type-caption text-ink-2">{t("editor.customLead")}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {customFields.map((field) => {
                    const value = product.custom[field.key];
                    const name = `custom.${field.key}`;
                    if (field.type === "boolean") return <Checkbox key={field.key} name={name} label={field.label} defaultChecked={value === true} />;
                    if (field.type === "select")
                      return <Select key={field.key} name={name} label={field.label} required={field.required} defaultValue={typeof value === "string" ? value : ""} options={[{ value: "", label: "—" }, ...field.options]} error={fieldError(name)} />;
                    if (field.type === "l10n") return <L10nFields key={field.key} name={name} label={field.label} required={field.required} value={value && typeof value === "object" && !Array.isArray(value) ? value : null} error={fieldError} />;
                    return (
                      <TextField
                        key={field.key}
                        name={name}
                        label={field.label}
                        required={field.required}
                        type={field.type === "date" ? "date" : "text"}
                        inputMode={field.type === "number" ? "decimal" : undefined}
                        defaultValue={Array.isArray(value) ? value.join(", ") : value === undefined || value === null ? "" : String(value)}
                        error={fieldError(name)}
                      />
                    );
                  })}
                </div>
              </section>
            ) : null}

            <TextField name="reason" label={t("common.reasonOptional")} hint={t("common.reasonHint")} maxLength={500} error={fieldError("reason")} />
          </fieldset>

          {readOnly ? null : (
            <div className="sticky z-(--z-sticky) -mx-2 flex flex-wrap items-center gap-3 rounded-sm bg-paper px-2 py-3 shadow-[0_-1px_0_var(--line)]" style={{ insetBlockEnd: "var(--adm-bottom)" }}>
              <Key type="submit" variant="ink" icon="floppy-disk" loading={busy}>
                {t("common.save")}
              </Key>
              {isFailure(answer) ? (
                <div className="min-w-0 flex-1">
                  <FailureNotice result={answer} />
                  {answer.code === "product_changed" ? (
                    <Key size="sm" className="mt-2" onClick={() => window.location.reload()}>
                      {t("common.reload")}
                    </Key>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </fetcher.Form>
      </div>

      <aside className="grid content-start gap-4">
        <section className="adm-card" aria-labelledby="readiness-title" id="readiness">
          <h2 id="readiness-title" className="adm-h3">
            {t("editor.readiness")}
          </h2>
          {completeness.complete ? (
            <p className="flex items-center gap-2 type-body text-ok">
              <Icon name="check-circle" size={18} filled />
              {t("editor.complete")}
            </p>
          ) : (
            <>
              <p className="type-caption text-ink-2">{t("editor.incomplete")}</p>
              <ul className="grid gap-1.5">
                {missing.map((entry) => (
                  <li key={entry.key} className="flex items-start gap-2">
                    <Icon name="warning-circle" size={18} className="mt-0.5 text-warn" />
                    {entry.href.startsWith("#") ? (
                      <a href={entry.href} className="adm-link type-body">
                        {entry.label}
                      </a>
                    ) : (
                      <Link to={entry.href} className="adm-link type-body">
                        {entry.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          <ul className="grid gap-1 border-t border-line pt-2">
            {completeness.checklist
              .filter((entry) => entry.ok)
              .map((entry) => (
                <li key={entry.requirement} className="flex items-center gap-2 type-caption text-ink-2">
                  <Icon name="check" size={14} className="text-ok" />
                  {t(`requirement.${entry.requirement}`)}
                </li>
              ))}
          </ul>
        </section>

        <section className="adm-card" aria-labelledby="prices-title">
          <h2 id="prices-title" className="adm-h3">
            {t("editor.priceSummary")}
          </h2>
          <p className="type-caption text-ink-2">{t("editor.priceSummaryLead")}</p>
          {product.isDemo ? <p className="type-caption text-ink-2">{t("editor.demoNote")}</p> : null}
          <dl className="grid gap-2">
            {editor.variants.map((variant) => (
              <div key={variant.id} className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5 last:border-0">
                <dt className="min-w-0 type-caption">
                  <bdi dir="ltr" className="block truncate text-ink">
                    {variant.sku}
                  </bdi>
                  <span className="text-ink-2">{variant.isActive ? `${t("variants.colStock")}: ${f.number(variant.available)}` : t("variants.inactive")}</span>
                </dt>
                <dd className="type-label text-ink">
                  <Iqd amount={variant.priceIqd} />
                </dd>
              </div>
            ))}
          </dl>
          {allowed.pricing ? (
            <Link to="/admin/pricing" className="adm-link type-caption">
              {t("common.openPricing")}
            </Link>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
