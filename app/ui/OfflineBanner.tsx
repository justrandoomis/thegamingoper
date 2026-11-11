import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * OfflineBanner — the connection dropped (DESIGN.md §9.16): a flat ink banner pinned under the header,
 * "لا يوجد اتصال. سلتك محفوظة على هذا الجهاز." Not glass and not red. When the connection returns it says
 * "عاد الاتصال." for three seconds and goes. Announced politely (the live region is on the page from the start).
 *
 *   <OfflineBanner offset="calc(var(--safe-top) + 56px)" />           shell: right under a 56px sticky header
 *   <OfflineBanner message="generic" />                                 pages without a cart ("تحقّق من الشبكة…")
 *
 *   const online = useOnline();                                         keys that need the network go flat, with the reason
 *   <Key disabled={!online} aria-describedby="why">{t("upload")}</Key>{!online ? <span id="why">{t("needsNetwork")}</span> : null}
 *
 * SSR-safe: the server and the hydration render assume "online" (nothing shows), then the browser's own state takes
 * over. `navigator.onLine` only knows about the device's link, not about the internet behind it — a request that fails
 * still has to say so where it failed.
 */
export type OfflineBannerProps = {
  /** "store" (default): the cart is safe on this device · "generic": check the network · or your own words. */
  message?: "store" | "generic" | ReactNode;
  /** Sticky offset from the top of the viewport (the header's height). Default 0. */
  offset?: string;
  /** Sticks under the header while the page scrolls (default). False: stays in the flow (previews, inside a sheet). */
  pinned?: boolean;
  /** Previews and tests: show a state regardless of the real connection. */
  state?: "auto" | "online" | "offline" | "back";
  className?: string;
};

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** True while the browser believes it is online. Always true on the server and during hydration. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

export function OfflineBanner({ message = "store", offset = "0px", pinned = true, state = "auto", className }: OfflineBannerProps) {
  const t = useT("ui-overlays");
  const online = useOnline();
  const [back, setBack] = useState(false);
  const wasOnline = useRef(true);

  useEffect(() => {
    if (state !== "auto") return;
    if (online && !wasOnline.current) {
      setBack(true);
      const timer = setTimeout(() => setBack(false), 3000);
      wasOnline.current = online;
      return () => clearTimeout(timer);
    }
    if (!online) setBack(false);
    wasOnline.current = online;
  }, [online, state]);

  const shown = state === "auto" ? (online ? (back ? "back" : null) : "offline") : state === "online" ? null : state;
  const words =
    shown === "back" ? t("offline.back") : message === "store" ? t("offline.store") : message === "generic" ? t("offline.generic") : message;

  return (
    <div role="status" aria-live="polite" className={cx(pinned && "sticky z-(--z-sticky)", className)} style={pinned ? { insetBlockStart: offset } : undefined}>
      {shown ? (
        <p className="flex min-h-10 items-center gap-2 bg-sel px-(--gutter) py-2 type-label text-on-sel">
          <Icon name={shown === "back" ? "check-circle" : "wifi-slash"} size={18} />
          <span className="min-w-0 flex-1">{words}</span>
        </p>
      ) : null}
    </div>
  );
}
