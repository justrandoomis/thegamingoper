import { useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/device-editor";
import { Icon } from "~/art/Icon";
import { useLocale } from "~/i18n/react";
import { pick } from "~/lib/locales";
import { can } from "~/server/actor";
import { getDeviceModel, getDeviceTaxonomy, saveDeviceModel } from "~/server/services/admin/catalog/taxonomy.server";
import { DEVICE_KIND_LIST, DEVICE_MODEL_STATUS_LIST } from "~/server/services/admin/catalog/rules";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { adminMeta } from "../shell/meta";
import { catalogRequest, failed, formObject } from "./catalog.server";
import { SpecsEditor } from "./components/SpecsEditor";
import { FailureNotice, L10nFields, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/devices/:id — one device model ("new" adds one): platform and generation (of the same platform),
 * names, summary, release date, device-page status, kind and its spec sheet by spec key — what the device pages and
 * the comparison (02.10) read. Saving needs catalog.platform.manage.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, params.id === "new" ? "catalog.platform.manage" : "catalog.product.read");
  const graph = await getDeviceTaxonomy(db, actor, locale);
  const model = params.id === "new" ? null : await getDeviceModel(db, actor, params.id);
  if (params.id !== "new" && !model) throw data({ error: "not_found" }, { status: 404 });
  return {
    model: model ? { id: model.id, platformId: model.platformId, generationId: model.generationId, slug: model.slug, name: model.name, summary: model.summary, releasedOn: model.releasedOn, status: model.status, deviceKind: model.deviceKind, sort: model.sort, specRows: model.specRows, updatedAt: model.updatedAt } : null,
    platforms: graph.platforms.map((platform) => ({ id: platform.id, label: platform.label })),
    generations: graph.generations.map((generation) => ({ id: generation.id, platformId: generation.platformId, label: generation.label })),
    canManage: can(actor, "catalog.platform.manage"),
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.platform.manage");
  const form = formObject(await request.formData());
  try {
    const { id } = await saveDeviceModel(req.db, req.actor, { ...form, id: params.id === "new" ? undefined : params.id }, req.now);
    return params.id === "new" ? redirect(`/admin/catalog/devices/${id}`) : { ok: true as const, intent: "save", id };
  } catch (error) {
    return failed(error, req.locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("devices.title"));

const DEVICE_KIND_KEY = (kind: string) => (kind === "other" ? "other_kind" : kind);

export default function DeviceEditor({ loaderData, actionData }: Route.ComponentProps) {
  const t = useCatalogT();
  const locale = useLocale();
  const navigation = useNavigation();
  const fieldError = useFieldError(actionData);
  const { model, platforms, generations, canManage } = loaderData;
  const [platformId, setPlatformId] = useState(model?.platformId ?? platforms[0]?.id ?? "");
  const busy = navigation.state === "submitting";
  return (
    <div className="adm-narrow">
      <header className="adm-page-head">
        <Link to="/admin/catalog/devices" className="adm-link inline-flex w-fit items-center gap-1 type-caption">
          <Icon name="arrow-left" size={16} />
          {t("devices.title")}
        </Link>
        <h1 className="adm-title">{model ? pick(model.name, locale) : t("devices.addModel")}</h1>
        {model ? (
          <p className="flex flex-wrap gap-3 type-caption text-ink-2">
            <bdi dir="ltr">{model.slug}</bdi>
            <Link to={`/admin/catalog/compare?m=${model.slug}`} className="adm-link">
              {t("devices.compare")}
            </Link>
            <Link to={`/admin/catalog/compatibility?target=device_model:${model.id}`} className="adm-link">
              {t("compat.allTitle")}
            </Link>
          </p>
        ) : null}
        {!canManage ? <p className="adm-notice">{t("devices.cannotManage")}</p> : null}
      </header>
      <Form method="post" noValidate className="grid gap-6">
        <fieldset disabled={!canManage} className="grid min-w-0 gap-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select name="platformId" label={t("devices.platform")} required value={platformId} onChange={(event) => setPlatformId(event.target.value)} options={platforms.map((platform) => ({ value: platform.id, label: platform.label }))} error={fieldError("platformId")} />
            <Select
              name="generationId"
              label={t("devices.generation")}
              defaultValue={model?.generationId ?? ""}
              options={[{ value: "", label: t("devices.generationNone") }, ...generations.filter((generation) => generation.platformId === platformId).map((generation) => ({ value: generation.id, label: generation.label }))]}
              error={fieldError("generationId")}
            />
          </div>
          <L10nFields name="name" label={t("devices.name")} value={model?.name ?? null} required maxLength={120} error={fieldError} />
          <TextField name="slug" label={t("devices.slug")} defaultValue={model?.slug ?? ""} required ltr maxLength={80} error={fieldError("slug")} />
          <L10nFields name="summary" label={t("devices.summary")} value={model?.summary ?? null} maxLength={400} error={fieldError} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="releasedOn" label={t("devices.releasedOn")} hint={t("devices.releasedHint")} defaultValue={model?.releasedOn ?? ""} ltr error={fieldError("releasedOn")} />
            <TextField name="sort" label={t("devices.sort")} defaultValue={model?.sort ?? ""} inputMode="numeric" error={fieldError("sort")} />
            <Select name="status" label={t("devices.modelStatus")} defaultValue={model?.status ?? "draft"} options={DEVICE_MODEL_STATUS_LIST.map((status) => ({ value: status, label: t(`devices.modelStatuses.${status}`) }))} />
            <Select name="deviceKind" label={t("devices.deviceKind")} defaultValue={model?.deviceKind ?? "console"} options={DEVICE_KIND_LIST.map((kind) => ({ value: kind, label: t(`devices.deviceKinds.${DEVICE_KIND_KEY(kind)}`) }))} />
          </div>
          <section className="grid gap-3" aria-labelledby="device-specs">
            <div className="grid gap-1">
              <h2 id="device-specs" className="adm-h2">
                {t("editor.specs")}
              </h2>
              <p className="type-caption text-ink-2">{t("editor.specsLead")}</p>
            </div>
            <SpecsEditor rows={model?.specRows ?? []} error={fieldError} resetKey={model?.updatedAt} />
          </section>
          <TextField name="reason" label={t("common.reasonOptional")} maxLength={500} />
        </fieldset>
        {actionData && !actionData.ok && !actionData.fields ? <FailureNotice result={actionData} /> : null}
        {actionData?.ok ? <p className="adm-notice adm-notice--ok">{t("devices.saved")}</p> : null}
        {canManage ? (
          <div className="sticky z-(--z-sticky) flex items-center gap-3 rounded-sm bg-paper px-3 py-2 shadow-[0_-1px_0_var(--line)]" style={{ insetBlockEnd: "var(--adm-bottom)" }}>
            <Key type="submit" variant="ink" icon="floppy-disk" loading={busy}>
              {t("common.save")}
            </Key>
          </div>
        ) : null}
      </Form>
    </div>
  );
}
