import { useEffect, useState } from "react";
import { useFetcher } from "react-router";

import type { Route } from "./+types/editor-media";
import { Icon } from "~/art/Icon";
import { can } from "~/server/actor";
import { addCatalogPhoto, addUploadedImage, getGallery, moveMedia, removeMedia, updateMedia } from "~/server/services/admin/catalog/media.server";
import type { GalleryItem } from "~/server/services/admin/catalog/media.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { adminMeta } from "../shell/meta";
import { answered, blobStore, catalogRequest, enforceUploadLimit, formObject, runIntent } from "./catalog.server";
import { FailureNotice, FileInput, L10nFields, Thumb, isFailure, useAnswerToast, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/products/:id/media — the gallery (02.04, catalog.media.manage): uploads through the server core's
 * upload service (type by content, size, metadata removed) stored public for /media, official catalogue photos by
 * key, the order (the first picture is the main one), alt text in three languages, which variant a picture belongs
 * to, and removal with a reason. A live product keeps at least one picture. Video and crop/focal hints are not
 * possible yet (upload service: images only; media table: no columns) — said on the page.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  const gallery = await answered(getGallery(db, actor, params.id, locale));
  return { gallery, can: { manage: can(actor, "catalog.media.manage") } };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.media.manage");
  const raw = await request.formData();
  const form = formObject(raw);
  const base = { ...form, productId: params.id };
  return runIntent(req, form.intent, {
    upload: async () => {
      await enforceUploadLimit(req);
      return addUploadedImage(req.db, blobStore(), req.actor, base, raw.get("file"), req.now);
    },
    photo: async () => addCatalogPhoto(req.db, req.actor, base, req.now),
    update: async () => {
      await updateMedia(req.db, req.actor, base, req.now);
      return {};
    },
    move: async () => {
      await moveMedia(req.db, req.actor, base, req.now);
      return {};
    },
    remove: async () => removeMedia(req.db, blobStore(), req.actor, base, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

export default function ProductMedia({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const { gallery, can: allowed } = loaderData;
  const productItems = gallery.items.filter((item) => item.ownerType === "product");
  const variantItems = gallery.items.filter((item) => item.ownerType === "variant");
  const [removing, setRemoving] = useState<GalleryItem | null>(null);
  const remove = useFetcher<typeof action>({ key: `catalog-media-remove-${gallery.productId}` });
  useAnswerToast(remove, t("media.saved"));
  useEffect(() => {
    if (remove.state === "idle" && remove.data && !isFailure(remove.data)) setRemoving(null);
  }, [remove.state, remove.data]);

  return (
    <div className="grid gap-8">
      <section className="adm-section mb-0" aria-labelledby="media-title">
        <div className="grid gap-1">
          <h2 id="media-title" className="adm-h2">
            {t("media.title")}
          </h2>
          <p className="max-w-[70ch] type-caption text-ink-2">{t("media.lead")}</p>
        </div>
        {productItems.length === 0 ? (
          <EmptyState icon="image" title={t("media.empty")} />
        ) : (
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {productItems.map((item, index) => (
              <MediaCard key={item.id} item={item} index={index} last={index === productItems.length - 1} variants={gallery.variants} productId={gallery.productId} canManage={allowed.manage} onRemove={() => setRemoving(item)} />
            ))}
          </ol>
        )}
        <p className="adm-notice">
          <Icon name="info" size={18} />
          <span>{t("media.videoNote")}</span>
        </p>
      </section>

      {variantItems.length > 0 ? (
        <section className="adm-section mb-0" aria-labelledby="variant-media-title">
          <h2 id="variant-media-title" className="adm-h2">
            {t("media.variantImages")}
          </h2>
          <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {variantItems.map((item, index) => (
              <MediaCard key={item.id} item={item} index={index} last={index === variantItems.length - 1} variants={gallery.variants} productId={gallery.productId} canManage={allowed.manage} onRemove={() => setRemoving(item)} />
            ))}
          </ol>
        </section>
      ) : null}

      {allowed.manage ? <AddMedia productId={gallery.productId} variants={gallery.variants} suggested={gallery.suggestedKeys} /> : null}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="destructive"
        title={t("media.removeQ")}
        consequence={t("media.removeDo")}
        confirmLabel={t("media.remove")}
        cancelLabel={t("common.cancel")}
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={remove.state !== "idle"}
        error={isFailure(remove.data) ? <FailureNotice result={remove.data} /> : undefined}
        onConfirm={({ reason }) => removing && remove.submit({ intent: "remove", id: removing.id, reason }, { method: "post" })}
      >
        {removing ? (
          <div className="mt-3 flex items-center gap-3">
            <Thumb image={{ artKey: removing.artKey, mediaKey: removing.mediaKey, alt: removing.altText, isIllustration: removing.isIllustration }} size={64} />
            <span className="type-caption text-ink-2">{removing.altText || removing.artKey}</span>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

type CardProps = { item: GalleryItem; index: number; last: boolean; variants: { id: string; sku: string; title: string }[]; productId: string; canManage: boolean; onRemove: () => void };

function MediaCard({ item, index, last, variants, canManage, onRemove }: CardProps) {
  const t = useCatalogT();
  const move = useFetcher<typeof action>({ key: `catalog-media-move-${item.id}` });
  const update = useFetcher<typeof action>({ key: `catalog-media-update-${item.id}` });
  const fieldError = useFieldError(update.data);
  useAnswerToast(update, t("media.saved"));
  const busy = move.state !== "idle";
  const moveTo = (direction: "up" | "down" | "first") => move.submit({ intent: "move", id: item.id, direction }, { method: "post" });
  return (
    <li className="adm-card content-start" aria-busy={busy || undefined}>
      <div className="relative grid aspect-[4/3] place-items-center overflow-hidden rounded-xs bg-niche">
        {item.broken ? (
          <span className="grid place-items-center gap-1 text-red-ink">
            <Icon name="warning-circle" size={28} />
            <span className="type-caption">{t("media.broken")}</span>
          </span>
        ) : (
          <Thumb image={{ artKey: item.artKey, mediaKey: item.mediaKey, alt: item.altText, isIllustration: item.isIllustration, ...(item.width && item.height ? { width: item.width, height: item.height } : {}) }} size={176} />
        )}
        {index === 0 && item.ownerType === "product" ? <span className="absolute start-2 top-2 rounded-xs bg-paper px-2 py-0.5 type-caption font-semibold text-ink shadow-[0_0_0_1px_var(--line)]">{t("media.main")}</span> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 type-caption text-ink-2">
        <span>{item.artKey ? t("media.catalog") : t("media.uploaded")}</span>
        {item.variantSku ? <bdi dir="ltr">· {item.variantSku}</bdi> : null}
        {item.isIllustration ? <span>· {t("media.illustration")}</span> : null}
      </div>
      <p className="type-body text-ink">{item.altText || <span className="text-ink-2">{t("media.alt")}: —</span>}</p>
      {canManage ? (
        <>
          <div className="flex flex-wrap gap-1.5">
            {item.ownerType === "product" && index > 0 ? (
              <Key size="sm" icon="star" disabled={busy} onClick={() => moveTo("first")}>
                {t("media.first")}
              </Key>
            ) : null}
            <IconKey size="sm" icon="arrow-up" label={t("common.moveUp")} disabled={busy || index === 0} onClick={() => moveTo("up")} />
            <IconKey size="sm" icon="arrow-down" label={t("common.moveDown")} disabled={busy || last} onClick={() => moveTo("down")} />
            <IconKey size="sm" icon="trash" label={t("media.remove")} onClick={onRemove} />
          </div>
          <details className="group">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 type-label text-ink [&::-webkit-details-marker]:hidden">
              <Icon name="pencil-simple" size={16} />
              {t("common.edit")}
              <Icon name="caret-down" size={14} className="group-open:rotate-180" />
            </summary>
            <update.Form method="post" className="grid gap-3 pt-2">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="id" value={item.id} />
              <L10nFields name="alt" label={t("media.alt")} value={item.alt} maxLength={300} multiline rows={2} error={fieldError} />
              <Select name="variantId" label={t("media.owner")} defaultValue={item.variantId ?? ""} options={[{ value: "", label: t("media.ownerProduct") }, ...variants.map((variant) => ({ value: variant.id, label: `${variant.sku}${variant.title ? ` · ${variant.title}` : ""}` }))]} />
              <Checkbox name="isIllustration" label={t("media.illustration")} defaultChecked={item.isIllustration} />
              <div>
                <Key type="submit" size="sm" variant="ink" loading={update.state !== "idle"}>
                  {t("common.save")}
                </Key>
              </div>
              {isFailure(update.data) ? <FailureNotice result={update.data} /> : null}
            </update.Form>
          </details>
          {isFailure(move.data) ? <FailureNotice result={move.data} /> : null}
        </>
      ) : null}
    </li>
  );
}

function AddMedia({ productId, variants, suggested }: { productId: string; variants: { id: string; sku: string; title: string }[]; suggested: string[] }) {
  const t = useCatalogT();
  const upload = useFetcher<typeof action>({ key: `catalog-media-upload-${productId}` });
  const photo = useFetcher<typeof action>({ key: `catalog-media-photo-${productId}` });
  const uploadError = useFieldError(upload.data);
  const photoError = useFieldError(photo.data);
  useAnswerToast(upload, (data) => (data.replayed ? t("media.duplicate") : t("media.added")));
  useAnswerToast(photo, (data) => (data.replayed ? t("media.duplicate") : t("media.added")));
  // A new, empty upload form after each successful upload.
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (upload.state === "idle" && upload.data && !isFailure(upload.data)) setRound((value) => value + 1);
  }, [upload.state, upload.data]);
  const owners = [{ value: "", label: t("media.ownerProduct") }, ...variants.map((variant) => ({ value: variant.id, label: `${variant.sku}${variant.title ? ` · ${variant.title}` : ""}` }))];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="adm-card content-start" aria-labelledby="upload-title">
        <h2 id="upload-title" className="adm-h3">
          {t("media.upload")}
        </h2>
        <upload.Form method="post" encType="multipart/form-data" className="grid gap-3" key={round}>
          <input type="hidden" name="intent" value="upload" />
          <FileInput name="file" label={t("media.file")} accept="image/jpeg,image/png,image/webp" required hint={t("media.uploadHint")} error={uploadError("file")} />
          <L10nFields name="alt" label={t("media.alt")} value={null} maxLength={300} error={uploadError} />
          <Select name="variantId" label={t("media.owner")} defaultValue="" options={owners} />
          <Checkbox name="isIllustration" label={t("media.illustration")} />
          <div>
            <Key type="submit" variant="ink" icon="upload-simple" loading={upload.state !== "idle"}>
              {t("media.upload")}
            </Key>
          </div>
          {isFailure(upload.data) ? <FailureNotice result={upload.data} /> : null}
        </upload.Form>
      </section>

      <section className="adm-card content-start" aria-labelledby="photo-title">
        <h2 id="photo-title" className="adm-h3">
          {t("media.addPhoto")}
        </h2>
        {suggested.length > 0 ? (
          <div className="grid gap-2">
            <p className="type-caption text-ink-2">{t("media.suggested")}</p>
            <ul className="flex flex-wrap gap-2">
              {suggested.map((key) => (
                <li key={key}>
                  <photo.Form method="post">
                    <input type="hidden" name="intent" value="photo" />
                    <input type="hidden" name="artKey" value={key} />
                    <button type="submit" className="grid place-items-center rounded-xs border border-line bg-niche p-1 hit-44" aria-label={`${t("common.add")} ${key}`} disabled={photo.state !== "idle"}>
                      <Thumb image={{ artKey: key, mediaKey: null, alt: "", isIllustration: false }} size={64} />
                    </button>
                  </photo.Form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <photo.Form method="post" className="grid gap-3">
          <input type="hidden" name="intent" value="photo" />
          <TextField name="artKey" label={t("media.photoKey")} hint={t("media.photoKeyHint", { example: suggested[0] ?? "nintendo-switch-2--1" })} ltr required error={photoError("artKey")} />
          <L10nFields name="alt" label={t("media.alt")} value={null} maxLength={300} error={photoError} />
          <Select name="variantId" label={t("media.owner")} defaultValue="" options={owners} />
          <div>
            <Key type="submit" icon="plus" loading={photo.state !== "idle"}>
              {t("media.addPhoto")}
            </Key>
          </div>
          {isFailure(photo.data) ? <FailureNotice result={photo.data} /> : null}
        </photo.Form>
      </section>
    </div>
  );
}
