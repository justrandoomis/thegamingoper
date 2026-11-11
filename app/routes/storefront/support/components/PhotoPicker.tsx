/**
 * Private photos for a repair request or a message to staff: at most MAX_SUPPORT_PHOTOS JPEG / PNG / WebP pictures
 * of up to 8 MB each — the server's own limits (~/server/uploads.server, which also removes metadata such as the GPS
 * position and decides the type from the bytes).
 *
 * Without JavaScript the "choose" key is a <label> for a real file input, so the files are submitted by the form
 * itself. With JavaScript the chosen files are checked at once, previewed, and can be removed; the form's submit
 * handler sends `files` (the native inputs are emptied after each choice). Nothing is uploaded before the form is
 * sent: the photos travel with it, so a photo is never stored without its request.
 */
import { useEffect, useId, useMemo, useRef } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { MAX_SUPPORT_PHOTOS } from "~/server/services/support/types";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export type PhotoProblem = "upload_type" | "upload_too_large" | "too_big";

/** The files that may be added, and the first problem with the rest. */
export function acceptPhotos(current: readonly File[], incoming: readonly File[]): { files: File[]; problem: PhotoProblem | null } {
  const files = [...current];
  let problem: PhotoProblem | null = null;
  for (const file of incoming) {
    if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) problem ??= "upload_type";
    else if (file.size > PHOTO_MAX_BYTES) problem ??= "upload_too_large";
    else if (files.length >= MAX_SUPPORT_PHOTOS) problem ??= "too_big";
    else files.push(file);
  }
  return { files, problem };
}

type Props = {
  /** Field name of the native inputs (submitted as is without JavaScript). */
  name: string;
  files: readonly File[];
  onChange: (files: File[], problem: PhotoProblem | null) => void;
  label: string;
  hint: string;
  error?: string;
  disabled?: boolean;
};

export function PhotoPicker({ name, files, onChange, label, hint, error, disabled = false }: Props) {
  const t = useT("support");
  const id = useId();
  const chooseRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const previews = useMemo(() => files.map((file) => ({ file, url: typeof URL !== "undefined" && "createObjectURL" in URL ? URL.createObjectURL(file) : "" })), [files]);
  useEffect(() => () => previews.forEach((preview) => preview.url && URL.revokeObjectURL(preview.url)), [previews]);

  const full = files.length >= MAX_SUPPORT_PHOTOS;
  const take = (input: HTMLInputElement | null) => {
    if (!input?.files) return;
    const result = acceptPhotos(files, [...input.files]);
    input.value = "";
    onChange(result.files, result.problem);
  };
  const remove = (index: number) => onChange(files.filter((_, i) => i !== index), null);

  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const keyFocus = "peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-ink peer-focus-visible:outline-offset-[3px] peer-focus-visible:[outline-style:solid]";
  return (
    <fieldset className="field field--group" data-invalid={error ? "" : undefined} aria-describedby={cx(hintId, error && errorId)}>
      <legend className="field__label">
        {label} <span className="field__mark">{t("photos.count", { count: files.length })}</span>
      </legend>
      <p className="field__hint" id={hintId}>
        {hint}
      </p>
      {previews.length > 0 ? (
        <ul role="list" className="flex flex-wrap gap-3">
          {previews.map((preview, index) => (
            <li key={`${preview.file.name}:${index}`} className="relative">
              <span className="block size-24 overflow-hidden rounded-md border border-line bg-niche">
                {preview.url ? <img src={preview.url} alt={preview.file.name} width={96} height={96} className="size-full object-cover" /> : null}
              </span>
              <IconKey icon="x" size="sm" label={t("photos.remove", { name: preview.file.name })} onClick={() => remove(index)} className="absolute -top-2 -end-2" disabled={disabled} />
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative inline-flex">
          <input
            ref={chooseRef}
            id={`${id}-choose`}
            type="file"
            name={name}
            accept={PHOTO_TYPES.join(",")}
            multiple
            disabled={disabled || full}
            onChange={(event) => take(event.currentTarget)}
            className="peer sr-only"
          />
          <Key as="label" htmlFor={`${id}-choose`} size="sm" icon="image" disabled={disabled || full} className={keyFocus}>
            {t("photos.choose")}
          </Key>
        </span>
        <span className="relative hidden pointer-coarse:inline-flex">
          <input
            ref={cameraRef}
            id={`${id}-camera`}
            type="file"
            name={name}
            accept={PHOTO_TYPES.join(",")}
            capture="environment"
            disabled={disabled || full}
            onChange={(event) => take(event.currentTarget)}
            className="peer sr-only"
          />
          <Key as="label" htmlFor={`${id}-camera`} size="sm" icon="camera" disabled={disabled || full} className={keyFocus}>
            {t("photos.camera")}
          </Key>
        </span>
        {full ? <span className="type-caption text-ink-2">{t("photos.full")}</span> : null}
      </div>
      <p className="field__error" id={errorId} aria-live="polite">
        {error ? (
          <>
            <Icon name="warning-circle" size={16} />
            <span>{error}</span>
          </>
        ) : null}
      </p>
    </fieldset>
  );
}
