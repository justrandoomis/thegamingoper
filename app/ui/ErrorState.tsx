import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { Key } from "./Key";
import { HrefLink } from "./Pagination";

/**
 * ErrorState — a part of the page failed to load (DESIGN.md §9.16): the reserved space stays, and a flat panel says
 * what failed and offers a retry key. It never keeps animating and never pretends to load. (A failed ACTION is not
 * this: roll the change back and put a sentence beside the control.)
 *
 *   <ErrorState onRetry={() => revalidator.revalidate()} retrying={revalidator.state === "loading"} />
 *   <ErrorState title={t("recsFailed")} retryHref="?retry=1" code={requestId} minHeight="220px" />
 *   <ErrorState alert … />      for a failure that happens while the shopper is looking (announced at once)
 *
 * Defaults (ui-overlays:error.*): "تعذّر تحميل هذا الجزء." / "تحقّق من الاتصال، ثم أعد المحاولة." Say more when you
 * know more. `code` shows a reference support can look up ("رمز الخطأ: 7K4M…"), left-to-right.
 */
/** Left-to-right isolate (U+2066) and its end (U+2069): the code reads left to right inside Arabic text. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

export type ErrorStateProps = {
  title?: ReactNode;
  text?: ReactNode;
  /** Try again (the key says "أعد المحاولة"). */
  onRetry?: () => void;
  /** …or a link that reloads the data. */
  retryHref?: string;
  /** The retry is in flight: the key spins and keeps its place. */
  retrying?: boolean;
  retryLabel?: string;
  /** An error reference for support. */
  code?: string;
  /** Keep the space the content would have taken ("220px"). */
  minHeight?: string;
  /** Announce it immediately (role="alert") — for failures after the page was already shown. */
  alert?: boolean;
  className?: string;
};

export function ErrorState({ title, text, onRetry, retryHref, retrying = false, retryLabel, code, minHeight, alert = false, className }: ErrorStateProps) {
  const t = useT("ui-overlays");
  const ui = useT("ui");
  const label = retryLabel ?? ui("retry");
  return (
    <div role={alert ? "alert" : undefined} className={cx("panel flex flex-wrap items-center gap-3 p-4", className)} style={minHeight ? { minBlockSize: minHeight } : undefined}>
      <span className="grid size-[52px] shrink-0 place-items-center rounded-full bg-well" aria-hidden="true">
        <Icon name="warning-circle" size={24} className="text-red-ink" />
      </span>
      <div className="grid min-w-[min(100%,12rem)] flex-1 gap-0.5">
        <p className="type-sub text-ink">{title ?? t("error.title")}</p>
        <p className="type-caption text-ink-2">{text ?? t("error.text")}</p>
        {code ? <p className="type-caption text-ink-2">{t("error.code", { code: `${LRI}${code}${PDI}` })}</p> : null}
      </div>
      {retryHref ? (
        <Key as={HrefLink} to={retryHref} size="sm" icon="arrows-clockwise" loading={retrying} className="shrink-0">
          {label}
        </Key>
      ) : onRetry ? (
        <Key size="sm" icon="arrows-clockwise" loading={retrying} onClick={onRetry} className="shrink-0">
          {label}
        </Key>
      ) : null}
    </div>
  );
}
