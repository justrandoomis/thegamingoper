import { useRef, useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/new-product";
import { Icon } from "~/art/Icon";
import { categoryOptions, createProduct, platformOptions } from "~/server/services/admin/catalog/product.server";
import { PRODUCT_KIND_LIST } from "~/server/services/admin/catalog/rules";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { adminMeta } from "../shell/meta";
import { catalogRequest, failed, formObject } from "./catalog.server";
import { FailureNotice, L10nFields, useCatalogT, useFieldError, useKindLabel } from "./components/ui";

/**
 * /admin/catalog/new — a new product starts as a draft (catalog.product.create): kind, name in three languages
 * (Arabic required), page address, category, platform, brand and optionally the SKU of its first variant (without a
 * price: Pricing sets it). A double submit finds the draft it already made instead of making a second one.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, locale } = await catalogRequest(context, "catalog.product.create");
  const [categories, platforms] = await Promise.all([categoryOptions(db, locale), platformOptions(db, locale)]);
  return { categories, platforms };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.create");
  const form = formObject(await request.formData());
  try {
    const { productId } = await createProduct(req.db, req.actor, form, req.now, { demo: req.ctx.storeMode === "demo" });
    return redirect(`/admin/catalog/products/${productId}`);
  } catch (error) {
    return failed(error, req.locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

/** "PlayStation 5 Slim (1TB)" → "playstation-5-slim-1tb". */
const slugify = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export default function NewProduct({ loaderData, actionData }: Route.ComponentProps) {
  const t = useCatalogT();
  const kindLabel = useKindLabel();
  const navigation = useNavigation();
  const fieldError = useFieldError(actionData);
  const { categories, platforms } = loaderData;
  const slugRef = useRef<HTMLInputElement>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const busy = navigation.state === "submitting";

  return (
    <div className="adm-narrow">
      <header className="adm-page-head">
        <Link to="/admin/catalog" className="adm-link inline-flex w-fit items-center gap-1 type-caption">
          <Icon name="arrow-left" size={16} />
          {t("editor.backToList")}
        </Link>
        <h1 className="adm-title">{t("newProduct.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{t("newProduct.lead")}</p>
      </header>
      <Form method="post" noValidate className="grid gap-5">
        <Select name="kind" label={t("editor.kind")} required defaultValue="accessory" options={PRODUCT_KIND_LIST.map((value) => ({ value, label: kindLabel(value) }))} error={fieldError("kind")} />
        <div
          onInput={(event) => {
            const target = event.target as HTMLInputElement;
            if (target.name === "name.en" && !slugTouched && slugRef.current) slugRef.current.value = slugify(target.value);
          }}
        >
          <L10nFields name="name" label={t("editor.name")} value={null} required maxLength={200} error={fieldError} />
        </div>
        <TextField ref={slugRef} name="slug" label={t("editor.slug")} hint={t("newProduct.slugHint")} required ltr maxLength={80} onInput={() => setSlugTouched(true)} error={fieldError("slug")} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Select name="categoryId" label={t("editor.category")} required defaultValue="" options={[{ value: "", label: t("editor.categoryPick") }, ...categories.map((category) => ({ value: category.id, label: category.label }))]} error={fieldError("categoryId")} />
          <Select name="platformId" label={t("editor.platform")} defaultValue="" options={[{ value: "", label: t("editor.platformNone") }, ...platforms.map((platform) => ({ value: platform.id, label: platform.name }))]} error={fieldError("platformId")} />
          <TextField name="brand" label={t("editor.brand")} maxLength={80} error={fieldError("brand")} />
          <TextField name="sku" label={t("newProduct.sku")} hint={t("newProduct.skuHint")} ltr maxLength={64} autoCapitalize="characters" error={fieldError("sku")} />
        </div>
        {actionData && !actionData.fields ? <FailureNotice result={actionData} /> : null}
        <div className="flex gap-2">
          <Key type="submit" variant="ink" icon="plus" loading={busy}>
            {t("newProduct.create")}
          </Key>
          <Key as={Link} to="/admin/catalog">
            {t("common.cancel")}
          </Key>
        </div>
      </Form>
    </div>
  );
}
