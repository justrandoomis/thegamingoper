import { useSyncExternalStore, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { Key } from "./Key";
import { HrefLink } from "./Pagination";

/**
 * ErrorState — a part of the page (or the page) failed to load. Design System v2 §4.23: the same anatomy as the empty
 * state, with an alert icon in a --niche disc; the reserved space stays; a retry button; the error reference in
 * caption, left-to-right. It never animates and never pretends to load. (A failed ACTION is not this: roll the change
 * back and put a sentence beside the control.)
 *
 *   <ErrorState onRetry={() => revalidator.revalidate()} retrying={revalidator.state === "loading"} />
 *   <ErrorState layout="stack" title={t("pageFailed")} retryHref="?retry=1" code={requestId} />
 *   <ErrorState offline … />     a failed fetch while offline: «لا يوجد اتصال بالإنترنت. أعد المحاولة عند عودة
 *                                الاتصال.» — never "500", never "an error on our side" (also chosen by itself when the
 *                                browser says it is offline)
 *   <ErrorState alert … />       a failure that happens while the shopper is looking (announced at once)
 *
 * Defaults (ui-overlays:error.*): «تعذّر تحميل هذا الجزء.» / «تحقّق من الاتصال، ثم أعد المحاولة.» Say more when you
 * know more. `code` shows a reference support can look up («رمز الخطأ: 7K4M…»), left-to-right.
 */
/** Left-to-right isolate (U+2066) and its end (U+2069): the code reads left to right inside Arabic text. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

export type ErrorStateProps = {
  title?: ReactNode;
  text?: ReactNode;
  /** Try again (the button says «أعد المحاولة»). */
  onRetry?: () => void;
  /** …or a link that reloads the data. */
  retryHref?: string;
  /** The retry is in flight: the button spins and keeps its place. */
  retrying?: boolean;
  retryLabel?: string;
  /** An error reference for support. */
  code?: string;
  /** Keep the space the content would have taken ("220px"). */
  minHeight?: string;
  /** Announce it immediately (role="alert") — for failures after the page was already shown. */
  alert?: boolean;
  /** The failure was a lost connection (default: what the browser says). */
  offline?: boolean;
  /** row (default — a part of a page) · stack (the page itself; the retry is its primary). */
  layout?: "row" | "stack";
  className?: string;
};

const subscribe = (notify: () => void) => {
  window.addEventListener("online", notify);
  window.addEventListener("offline", notify);
  return () => {
    window.removeEventListener("online", notify);
    window.removeEventListener("offline", notify);
  };
};

/** The browser reports no connection (false on the server and during hydration). */
function useOffline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine === false,
    () => false,
  );
}

export function ErrorState({ title, text, onRetry, retryHref, retrying = false, retryLabel, code, minHeight, alert = false, offline, layout = "row", className }: ErrorStateProps) {
  const t = useT("ui-overlays");
  const ui = useT("ui");
  const browserOffline = useOffline();
  const lost = offline ?? browserOffline;
  const label = retryLabel ?? ui("retry");
  const heading = title ?? (lost ? t("error.offlineTitle") : t("error.title"));
  const sentence = lost ? t("error.offlineText") : (text ?? t("error.text"));
  const stack = layout === "stack";
  const retry = retryHref ? (
    <Key as={HrefLink} to={retryHref} variant={stack ? "primary" : "secondary"} size={stack ? "md" : "sm"} icon="arrows-clockwise" loading={retrying} className="shrink-0">
      {label}
    </Key>
  ) : onRetry ? (
    <Key variant={stack ? "primary" : "secondary"} size={stack ? "md" : "sm"} icon="arrows-clockwise" loading={retrying} onClick={onRetry} className="shrink-0">
      {label}
    </Key>
  ) : null;
  const reference = code ? <p className={stack ? "empty__ref" : "type-caption text-ink-2"}>{t("error.code", { code: `${LRI}${code}${PDI}` })}</p> : null;

  if (stack) {
    return (
      <div role={alert ? "alert" : undefined} className={cx("empty empty--error", className)} style={minHeight ? { minBlockSize: minHeight } : undefined} data-offline={lost ? "" : undefined}>
        <span className="empty__art" aria-hidden="true">
          <Icon name={lost ? "wifi-slash" : "warning-circle"} size={24} />
        </span>
        <h2 className="empty__title">{heading}</h2>
        <p className="empty__text">{sentence}</p>
        {retry ? <div className="empty__actions">{retry}</div> : null}
        {reference}
      </div>
    );
  }

  return (
    <div role={alert ? "alert" : undefined} className={cx("panel flex flex-wrap items-center gap-3 p-4", className)} style={minHeight ? { minBlockSize: minHeight } : undefined} data-offline={lost ? "" : undefined}>
      <span className="grid size-[52px] shrink-0 place-items-center rounded-full bg-niche" aria-hidden="true">
        <Icon name={lost ? "wifi-slash" : "warning-circle"} size={24} className="text-ink" />
      </span>
      <div className="grid min-w-[min(100%,12rem)] flex-1 gap-0.5">
        <p className="type-sub text-ink">{heading}</p>
        <p className="type-caption text-ink-2">{sentence}</p>
        {reference}
      </div>
      {retry}
    </div>
  );
}
