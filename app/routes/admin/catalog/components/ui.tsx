/**
 * Small pieces the catalogue screens share: the module's strings, status words, the product thumbnail, prices that
 * never show a missing price as zero, localized text inputs (ar / en / ckb), field errors, the toast after a
 * fetcher answers, and Baghdad wall-clock times for datetime inputs.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { FetcherWithComponents } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import type { ImageRef } from "~/lib/dto";
import type { L10n } from "~/lib/locales";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ProductImage } from "~/ui/ProductCard";
import { Status, type StatusTone } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { cx } from "~/ui/cx";
import type { AdminStatus } from "~/server/services/admin/catalog/rules";

export const useCatalogT = () => useT("admin-catalog");

/** What a catalogue action answers (catalog.server.ts runIntent / failed). */
export type CatalogResult = { ok: true; intent: string; [key: string]: unknown } | { ok: false; intent?: string; code: string; message?: string; fields?: Record<string, string>; detail?: string };

export const isFailure = (value: unknown): value is Extract<CatalogResult, { ok: false }> => typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

/** Compatibility statuses as status tones (never colour alone: the words go with them). */
export const COMPAT_TONE: Record<"verified" | "partial" | "incompatible" | "unverified", StatusTone> = { verified: "ok", partial: "warn", incompatible: "bad", unverified: "neutral" };

/** Import job statuses as tones. */
export const JOB_TONE: Record<string, StatusTone> = { uploaded: "neutral", validated: "info", applied: "ok", failed: "warn", rolled_back: "neutral" };

export const STATUS_TONE: Record<AdminStatus, StatusTone> = { draft: "neutral", review: "warn", scheduled: "info", published: "ok", hidden: "warn", archived: "neutral" };

export function StatusBadge({ status, publishAt, live }: { status: AdminStatus; publishAt?: number | null; live?: boolean }) {
  const t = useCatalogT();
  const f = useFormat();
  return (
    <span className="inline-grid gap-0.5">
      <Status tone={STATUS_TONE[status]} className="whitespace-nowrap">{t(`status.${status}`)}</Status>
      {status === "scheduled" && publishAt ? <span className="type-caption text-ink-2 nums">{live ? t("status.due") : t("status.at", { time: f.dateTime(publishAt) })}</span> : null}
    </span>
  );
}

/** A small square picture of the product (catalogue photo or public upload); an empty niche when it has none. */
export function Thumb({ image, size = 48, className }: { image: ImageRef | null; size?: number; className?: string }) {
  return (
    <span className={cx("grid shrink-0 place-items-center overflow-hidden rounded-xs bg-niche", className)} style={{ inlineSize: size, blockSize: size }} aria-hidden={image ? undefined : true}>
      {image ? <ProductImage image={image} alt="" sizes={`${size}px`} shadow={false} className="h-full w-full object-contain" /> : <Icon name="image" size={Math.round(size / 2.4)} className="text-ink-3" />}
    </span>
  );
}

/**
 * A file field in the admin's language: the native picker's own words follow the browser, not the page, so the input
 * is visually hidden behind a labelled key (still a real input: it submits without JavaScript and takes focus).
 */
export function FileInput({ name, label, accept, hint, error, required }: { name: string; label: string; accept: string; hint?: string; error?: string; required?: boolean }) {
  const t = useCatalogT();
  const id = useId();
  const [file, setFile] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <span className="type-label text-ink" id={`${id}-label`}>
        {label}
        {required ? <span className="text-ink-2"> *</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={id}
          name={name}
          type="file"
          accept={accept}
          required={required}
          className="peer sr-only"
          aria-labelledby={`${id}-label`}
          aria-describedby={hint ? `${id}-hint` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setFile(event.currentTarget.files?.[0]?.name ?? null)}
        />
        <Key as="label" htmlFor={id} icon="paperclip" className="cursor-pointer peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-ink">
          {t("common.chooseFile")}
        </Key>
        <bdi className="min-w-0 truncate type-caption text-ink-2">{file ?? t("common.noFile")}</bdi>
      </div>
      {hint ? (
        <span id={`${id}-hint`} className="type-caption text-ink-2">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span role="alert" className="type-caption text-red-ink">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** An IQD amount with the figure first; null (no price yet) is a dash with its reason, never a zero. `plain`: the figure only (the column head names the currency). */
export function Iqd({ amount, missing, plain }: { amount: number | null | undefined; missing?: ReactNode; plain?: boolean }) {
  const f = useFormat();
  const t = useCatalogT();
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    return (
      <span className="type-caption text-ink-2" title={typeof missing === "string" ? missing : t("common.noPrice")}>
        <bdi>—</bdi> <span className="sr-only">{missing ?? t("common.noPrice")}</span>
      </span>
    );
  }
  return <bdi className="nums">{plain ? f.number(amount) : f.iqd(amount)}</bdi>;
}

export function PriceRange({ min, max }: { min: number | null; max: number | null }) {
  const f = useFormat();
  if (min === null || max === null) return <Iqd amount={null} />;
  if (min === max) return <bdi className="nums">{f.number(min)}</bdi>;
  return (
    <bdi className="nums">
      {f.number(min)}–{f.number(max)}
    </bdi>
  );
}

/** An error key ("barcode_taken"), as opposed to a sentence the server has already translated. */
const ERROR_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * The error sentence for a field from a failed answer. The server translates `fields` (catalog.server.ts `failed`), so
 * a sentence is shown as it is (looking it up as a key would only log "missing key"); only a key it could not
 * translate is looked up here.
 */
export function fieldErrorText(t: TFunction, result: unknown, name: string): string | undefined {
  if (!isFailure(result) || !result.fields) return undefined;
  const value = result.fields[name];
  if (!value) return undefined;
  if (!ERROR_KEY.test(value)) return value;
  const own = t(`errors.${value}`);
  return own === `errors.${value}` ? value : own;
}

/** fieldErrorText with the module's strings: `const fieldError = useFieldError(fetcher.data); fieldError("sku")`. */
export function useFieldError(result: unknown) {
  const t = useCatalogT();
  return (name: string): string | undefined => fieldErrorText(t, result, name);
}

type L10nFieldsProps = {
  /** Field name prefix: "name" → name.ar, name.en, name.ckb. */
  name: string;
  label: string;
  value: L10n | null | undefined;
  required?: boolean;
  multiline?: boolean;
  rows?: number;
  maxLength?: number;
  hint?: string;
  error?: (name: string) => string | undefined;
  disabled?: boolean;
};

/** One text in three languages: Arabic (required when `required`), English, Sorani. */
export function L10nFields({ name, label, value, required, multiline, rows = 4, maxLength, hint, error, disabled }: L10nFieldsProps) {
  const t = useCatalogT();
  const langs = [
    { code: "ar", dir: "rtl" as const, lang: "ar" },
    { code: "en", dir: "ltr" as const, lang: "en" },
    { code: "ckb", dir: "rtl" as const, lang: "ckb" },
  ];
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="type-label mb-1 text-ink">
        {label}
        {required ? <span className="text-ink-2"> *</span> : null}
      </legend>
      <div className={cx("grid gap-3", multiline ? "" : "md:grid-cols-3")}>
        {langs.map((entry) => {
          const field = `${name}.${entry.code}`;
          const common = {
            name: field,
            label: t(`common.${entry.code}`),
            defaultValue: value?.[entry.code as keyof L10n] ?? "",
            dir: entry.dir,
            lang: entry.lang,
            maxLength,
            error: error?.(field),
            required: required && entry.code === "ar",
            disabled,
          };
          return multiline ? <TextArea key={entry.code} {...common} rows={rows} /> : <TextField key={entry.code} {...common} />;
        })}
      </div>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </fieldset>
  );
}

/**
 * Toasts the answer of a fetcher once: the success text, or the failure's sentence. A product that changed under
 * the form ("product_changed") says how to recover.
 */
export function useAnswerToast(fetcher: Pick<FetcherWithComponents<unknown>, "state" | "data">, okText: string | ((data: Record<string, unknown>) => string)) {
  const t = useCatalogT();
  const seen = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || seen.current === fetcher.data) return;
    seen.current = fetcher.data;
    const answer = fetcher.data as CatalogResult;
    if (answer.ok) toast.success(typeof okText === "function" ? okText(answer as Record<string, unknown>) : okText);
    else toast.error(answer.message ?? t("errors.invalid"));
  }, [fetcher.state, fetcher.data, okText, t]);
}

/** The failure sentence of an answer, for a notice beside the form. */
export function FailureNotice({ result }: { result: unknown }) {
  const t = useCatalogT();
  if (!isFailure(result)) return null;
  const missing = result.detail ? result.detail.split(",").filter(Boolean) : [];
  return (
    <div className="adm-notice adm-notice--bad" role="alert">
      <Icon name="warning-circle" size={18} />
      <div className="grid gap-1">
        <p>{result.message ?? t(`errors.${result.code}`)}</p>
        {missing.length > 0 ? (
          <ul className="list-disc ps-5 type-caption">
            {missing.map((key) => (
              <li key={key}>{key.startsWith("custom:") ? t("requirement.custom", { name: key.slice(7) }) : t(`requirement.${key}`)}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A list's secondary filters: always open on wide screens and without JavaScript; on phones they fold into a
 * "Filters (n)" disclosure after the page has loaded (unless a filter is set), so the results come first.
 */
export function FilterFields({ children, active }: { children: ReactNode; active: number }) {
  const t = useCatalogT();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (active === 0 && window.matchMedia("(max-width: 47.99rem)").matches) setOpen(false);
  }, [active]);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group min-w-0">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 type-label text-ink md:hidden [&::-webkit-details-marker]:hidden">
        <Icon name="sliders-horizontal" size={18} />
        {t("list.filters", { count: active })}
        <Icon name="caret-down" size={16} className="text-ink-2 group-open:rotate-180" />
      </summary>
      <div className="grid gap-3 pt-2 sm:grid-cols-2 md:pt-0 lg:grid-cols-4">{children}</div>
    </details>
  );
}

/** "2026-11-12T10:30" in Baghdad time (UTC+3, no daylight saving) for a datetime-local input. */
export function epochToBaghdadInput(ms: number): string {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(0, 16);
}

/** A labelled read-only fact in a definition list. */
export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="type-caption text-ink-2">{label}</dt>
      <dd className="type-body text-ink">{children}</dd>
    </div>
  );
}

/** Product kind words. */
export function useKindLabel() {
  const t = useCatalogT();
  return (kind: string) => t(`kind.${kind}`);
}
