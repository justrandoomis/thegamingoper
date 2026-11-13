import { useEffect, useState } from "react";
import { Form, Link, useFetcher } from "react-router";

import type { Route } from "./+types/device-list";
import { useFormat } from "~/i18n/react";
import { getDeviceTaxonomy, saveGeneration, savePlatform } from "~/server/services/admin/catalog/taxonomy.server";
import { PLATFORM_ACCENTS } from "~/server/services/admin/catalog/rules";
import type { DeviceTaxonomy } from "~/server/services/admin/catalog/taxonomy.server";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { PlatformLabel, isPlatform } from "~/ui/PlatformLed";
import { Sheet } from "~/ui/Sheet";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, L10nFields, isFailure, useAnswerToast, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/devices — the device knowledge graph: platforms, their generations and device models (managed with
 * catalog.platform.manage; everyone with catalog.product.read reads it). Models are edited on their own page (spec
 * sheet by spec key). Ticking 2–4 models and "Compare" opens the spec comparison (02.10). Nothing is deleted that
 * products or rules point to: platforms are switched off, models archived.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  return { graph: await getDeviceTaxonomy(db, actor, locale) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.platform.manage");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    platform: async () => savePlatform(req.db, req.actor, form, req.now),
    generation: async () => saveGeneration(req.db, req.actor, form, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("devices.title"));

type Platform = DeviceTaxonomy["platforms"][number];
type Generation = DeviceTaxonomy["generations"][number];
type Editing = { kind: "platform"; row: Platform | null } | { kind: "generation"; row: Generation | null; platformId: string } | null;

const DEVICE_KIND_KEY = (kind: string) => (kind === "other" ? "other_kind" : kind);

export default function Devices({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const { graph } = loaderData;
  const [editing, setEditing] = useState<Editing>(null);

  return (
    <>
      <header className="adm-page-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title">{t("devices.title")}</h1>
          <span className="flex flex-wrap gap-2">
            <Key as={Link} to="/admin/catalog/compare" icon="scales">
              {t("compare.title")}
            </Key>
            {graph.canManage ? (
              <>
                <Key icon="plus" onClick={() => setEditing({ kind: "platform", row: null })}>
                  {t("devices.addPlatform")}
                </Key>
                <Key as={Link} to="/admin/catalog/devices/new" variant="ink" icon="plus">
                  {t("devices.addModel")}
                </Key>
              </>
            ) : null}
          </span>
        </div>
        <p className="max-w-[70ch] type-body text-ink-2">{t("devices.lead")}</p>
        {!graph.canManage ? <p className="adm-notice">{t("devices.cannotManage")}</p> : null}
      </header>

      <Form method="get" action="/admin/catalog/compare" className="grid gap-6">
        {graph.platforms.map((platform) => {
          const generations = graph.generations.filter((generation) => generation.platformId === platform.id);
          const loose = graph.models.filter((model) => model.platformId === platform.id && !model.generationId);
          return (
            <section key={platform.id} className="adm-section mb-0" aria-labelledby={`platform-${platform.id}`}>
              <div className="adm-section__head">
                <h2 id={`platform-${platform.id}`} className="adm-h2 flex flex-wrap items-center gap-2">
                  {isPlatform(platform.accent) ? <PlatformLabel platform={platform.accent} label={platform.label} /> : <span>{platform.label}</span>}
                  <bdi dir="ltr" className="type-caption text-ink-2">
                    {platform.slug}
                  </bdi>
                  {!platform.isActive ? <Status tone="neutral">{t("devices.inactive")}</Status> : null}
                  <span className="type-caption text-ink-2">{t("devices.productsCount", { count: f.number(platform.products) })}</span>
                </h2>
                {graph.canManage ? (
                  <span className="flex gap-1.5">
                    <Key size="sm" icon="plus" onClick={() => setEditing({ kind: "generation", row: null, platformId: platform.id })}>
                      {t("devices.addGeneration")}
                    </Key>
                    <IconKey size="sm" icon="pencil-simple" label={`${t("common.edit")} ${platform.label}`} onClick={() => setEditing({ kind: "platform", row: platform })} />
                  </span>
                ) : null}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {generations.map((generation) => (
                  <article key={generation.id} className="adm-card content-start" aria-labelledby={`generation-${generation.id}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 id={`generation-${generation.id}`} className="adm-h3">
                        {generation.label} <bdi dir="ltr" className="type-caption text-ink-2">{generation.slug}</bdi>
                      </h3>
                      {graph.canManage ? <IconKey size="sm" icon="pencil-simple" label={`${t("common.edit")} ${generation.label}`} onClick={() => setEditing({ kind: "generation", row: generation, platformId: platform.id })} /> : null}
                    </div>
                    <ModelList models={graph.models.filter((model) => model.generationId === generation.id)} />
                  </article>
                ))}
                {loose.length > 0 ? (
                  <article className="adm-card content-start">
                    <h3 className="adm-h3">{t("devices.generationNone")}</h3>
                    <ModelList models={loose} />
                  </article>
                ) : null}
              </div>
            </section>
          );
        })}
        <div className="sticky z-(--z-sticky) flex items-center gap-3 rounded-sm bg-paper px-3 py-2 shadow-[0_-1px_0_var(--line)]" style={{ insetBlockEnd: "var(--adm-bottom)" }} data-adm-sticky-end>
          <Key type="submit" variant="ink" icon="scales">
            {t("devices.compare")}
          </Key>
          <span className="type-caption text-ink-2">{t("compare.pickHint")}</span>
        </div>
      </Form>

      <PlatformSheet key={editing ? `${editing.kind}-${editing.row?.id ?? "new"}` : "none"} editing={editing} platforms={graph.platforms} onClose={() => setEditing(null)} />
    </>
  );
}

function ModelList({ models }: { models: DeviceTaxonomy["models"] }) {
  const t = useCatalogT();
  return (
    <ul className="grid gap-1">
      {models.map((model) => (
        <li key={model.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1 last:border-0">
          <Checkbox name="m" value={model.slug} label={model.label} className="min-w-0" />
          <span className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
            <span>{t(`devices.deviceKinds.${DEVICE_KIND_KEY(model.deviceKind)}`)}</span>
            <span>{t("devices.specs", { count: model.specCount })}</span>
            <span>{t("devices.rules", { count: model.rules })}</span>
            {model.status !== "published" ? <Status tone="neutral">{t(`devices.modelStatuses.${model.status}`)}</Status> : null}
            <Link to={`/admin/catalog/devices/${model.id}`} className="adm-link">
              {t("common.open")}
            </Link>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PlatformSheet({ editing, platforms, onClose }: { editing: Editing; platforms: DeviceTaxonomy["platforms"]; onClose: () => void }) {
  const t = useCatalogT();
  const fetcher = useFetcher<typeof action>({ key: "catalog-platform-save" });
  const fieldError = useFieldError(fetcher.data);
  useAnswerToast(fetcher, t("devices.saved"));
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !isFailure(fetcher.data)) onClose();
  }, [fetcher.state, fetcher.data, onClose]);
  if (!editing) return <Sheet open={false} onClose={onClose} title="">{null}</Sheet>;
  const formId = `device-form-${editing.kind}`;
  const isPlatformForm = editing.kind === "platform";
  const row = editing.row;
  return (
    <Sheet
      open
      onClose={onClose}
      presentation="side"
      title={isPlatformForm ? (row ? row.label : t("devices.addPlatform")) : row ? row.label : t("devices.addGeneration")}
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
      <fetcher.Form id={formId} method="post" noValidate className="grid gap-4">
        <input type="hidden" name="intent" value={editing.kind} />
        {row ? <input type="hidden" name="id" value={row.id} /> : null}
        <L10nFields name="name" label={t("devices.name")} value={row?.name ?? null} required maxLength={120} error={fieldError} />
        <TextField name="slug" label={t("devices.slug")} defaultValue={row?.slug ?? ""} required ltr maxLength={80} error={fieldError("slug")} />
        {isPlatformForm ? (
          <>
            <Select name="accent" label={t("devices.accent")} defaultValue={(row as Platform | null)?.accent ?? "brand"} options={PLATFORM_ACCENTS.map((accent) => ({ value: accent, label: t(`devices.accents.${accent}`) }))} />
            <Checkbox name="isActive" label={t("devices.active")} defaultChecked={(row as Platform | null)?.isActive ?? true} />
          </>
        ) : (
          <Select name="platformId" label={t("devices.platform")} defaultValue={editing.kind === "generation" ? editing.platformId : ""} options={platforms.map((platform) => ({ value: platform.id, label: platform.label }))} error={fieldError("platformId")} />
        )}
        <TextField name="sort" label={t("devices.sort")} defaultValue={row?.sort ?? ""} inputMode="numeric" error={fieldError("sort")} />
        <TextField name="reason" label={t("common.reasonOptional")} maxLength={500} />
        {isFailure(fetcher.data) && !fetcher.data.fields ? <FailureNotice result={fetcher.data} /> : null}
      </fetcher.Form>
    </Sheet>
  );
}
