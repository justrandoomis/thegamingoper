import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * OfflineBanner — the connection dropped. Design System v2 §4.23: a 40px banner pinned under the header on the
 * --warn-tint ground with --warn 14/600 words and an INLINE wifi-slash icon in --warn (the sprite may not be cached
 * offline) — never red. It can never be confused with the demo strip: the demo strip is a centred 28px line of 13px
 * words on its own amber; this banner is 40px, starts at the reading edge and carries a 3px --warn bar on that edge
 * (and a hairline under it). The graphite version it had for a while brought back the black full-width ribbon §11.7
 * removed, and in the dark theme it hardly stood off the page (QA 2026-11-12). Contextual words: store pages «لا يوجد اتصال. سلتك محفوظة على هذا
 * الجهاز.», forms «لا يوجد اتصال. ما كتبته باقٍ في الصفحة؛ أرسله عند عودة الاتصال.». When the connection returns it says
 * «عاد الاتصال.» for three seconds and goes. Announced politely (the live region is on the page from the start).
 *
 *   <OfflineBanner offset="var(--shell-top)" />                         shell: right under the sticky header
 *   <OfflineBanner message="form" />                                    pages with a form
 *
 *   const online = useOnline();                                         keys that need the network go flat, with the reason
 *   <Key disabled={!online} aria-describedby="why">{t("upload")}</Key>{!online ? <span id="why">{t("needsNetwork")}</span> : null}
 *
 * SSR-safe: the server and the hydration render assume "online" (nothing shows), then the browser's own state takes
 * over. `navigator.onLine` only knows about the device's link, not about the internet behind it — a request that fails
 * still has to say so where it failed.
 */
export type OfflineBannerProps = {
  /** "store" (default): the cart is safe on this device · "form": what you typed stays · "generic" · or your own words. */
  message?: "store" | "form" | "generic" | ReactNode;
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
    shown === "back"
      ? t("offline.back")
      : message === "store"
        ? t("offline.store")
        : message === "form"
          ? t("offline.form")
          : message === "generic"
            ? t("offline.generic")
            : message;

  return (
    <div role="status" aria-live="polite" className={cx(pinned && "sticky z-(--z-sticky)", className)} style={pinned ? { insetBlockStart: offset } : undefined}>
      {shown ? (
        <p className={cx("offline", shown === "back" && "offline--back")} data-offline={shown}>
          {shown === "back" ? <CheckGlyph /> : <WifiSlashGlyph />}
          <span className="min-w-0 flex-1">{words}</span>
        </p>
      ) : null}
    </div>
  );
}

/* Inline glyphs (Phosphor regular, MIT): the sprite may not be in the cache while offline (v2 §4.23). */
function WifiSlashGlyph() {
  return (
    <svg viewBox="0 0 256 256" width={20} height={20} fill="currentColor" aria-hidden="true" focusable="false" className="shrink-0">
      <path d="M213.92,210.62a8,8,0,1,1-11.84,10.76l-52-57.15a60,60,0,0,0-57.41,7.24,8,8,0,1,1-9.42-12.93A75.43,75.43,0,0,1,128,144c1.28,0,2.55,0,3.82.1L104.9,114.49A108,108,0,0,0,61,135.31,8,8,0,0,1,49.73,134,8,8,0,0,1,51,122.77a124.27,124.27,0,0,1,41.71-21.66L69.37,75.4a155.43,155.43,0,0,0-40.29,24A8,8,0,0,1,18.92,87,171.87,171.87,0,0,1,58,62.86L42.08,45.38A8,8,0,1,1,53.92,34.62ZM128,192a12,12,0,1,0,12,12A12,12,0,0,0,128,192ZM237.08,87A172.3,172.3,0,0,0,106,49.4a8,8,0,1,0,2,15.87A158.33,158.33,0,0,1,128,64a156.25,156.25,0,0,1,98.92,35.37A8,8,0,0,0,237.08,87ZM195,135.31a8,8,0,0,0,11.24-1.3,8,8,0,0,0-1.3-11.24,124.25,124.25,0,0,0-51.73-24.2A8,8,0,1,0,150,114.24,108.12,108.12,0,0,1,195,135.31Z" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg viewBox="0 0 256 256" width={20} height={20} fill="currentColor" aria-hidden="true" focusable="false" className="shrink-0">
      <path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z" />
    </svg>
  );
}
