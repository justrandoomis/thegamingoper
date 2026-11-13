/**
 * The shell's thin banners (Design System v2 §5.2, §5.11, §2.11):
 *
 *   <DemoStrip />       while STORE_MODE is "demo": the kit's amber strip (<DemoNote variant="strip">) above the phone
 *                       header — never inverted, never sticky, gone from 1024 (the nav row's demo chip takes over). The
 *                       whole strip is one in-page link to the footer's full statement (#shell-demo), 44px tall.
 *   <ShellOffline />    the kit's offline banner, pinned right under the sticky header for the whole page (sticky in the
 *                       shell's column, so it never scrolls away while the shell counts it): on pages the shopper fills
 *                       in (checkout, task flows, /account — ./chrome shellChrome `offline`) «ما كتبته باقٍ في الصفحة»;
 *                       elsewhere «سلتك محفوظة على هذا الجهاز». Its measured height (0 while online; 40, or more when the
 *                       words wrap; also the three seconds of «عاد الاتصال») is `--shell-offline-h`, which shell.css adds
 *                       to `--shell-top` — so sticky page rows sit right under it and a focused control never hides there.
 *   <PageProgress />    a 2px ink bar under the header once a navigation has waited 150ms (filters, search, trade-in
 *                       steps), so a slow network never looks like a dead tap.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

import { DemoNote } from "~/ui/DemoNote";
import { OfflineBanner } from "~/ui/OfflineBanner";
import type { OfflineWords } from "./chrome";

/** Where the full demo statement lives: the footer's legal row (both footers render it in demo mode). */
export const DEMO_NOTE_ID = "shell-demo";

/**
 * A plain in-page link, as the skip link: the browser keeps the whole address — a guest's order link (`?t=`), a filter
 * — and only scrolls. The kit's strip link is a router link, and a router link to "#shell-demo" is resolved against
 * the PATH alone: on /order/<ref>?t=<token> a tap opened the order without its token («تعذّر فتح هذا الطلب»), and
 * focusing it prefetched that token-less page (a 404 in the console). The kit's strip (a <p> without `to`) is the face.
 */
export function DemoStrip() {
  return (
    <a href={`#${DEMO_NOTE_ID}`} className="shell-strip lg:hidden">
      <DemoNote variant="strip" />
    </a>
  );
}

export function ShellOffline({ words }: { words: OfflineWords }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) root.style.setProperty("--shell-offline-h", `${height}px`);
      else root.style.removeProperty("--shell-offline-h");
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--shell-offline-h");
    };
  }, []);
  return (
    <div ref={ref} className="shell-offline">
      <OfflineBanner message={words} pinned={false} />
    </div>
  );
}

const SHOW_AFTER_MS = 150;
const FADE_MS = 260;

export function PageProgress() {
  const navigation = useNavigation();
  const waiting = navigation.state === "loading";
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const shown = useRef(false);

  useEffect(() => {
    if (waiting) {
      const timer = setTimeout(() => {
        shown.current = true;
        setState("busy");
      }, SHOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (!shown.current) return;
    shown.current = false;
    setState("done");
    const timer = setTimeout(() => setState("idle"), FADE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  return (
    <div className="shell-progress" data-state={state === "idle" ? undefined : state} aria-hidden="true">
      <span />
    </div>
  );
}
