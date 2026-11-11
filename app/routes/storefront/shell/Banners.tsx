/**
 * The shell's thin banners (Design System v2 §5.2, §5.11, §2.11):
 *
 *   <DemoStrip />       while STORE_MODE is "demo": the kit's amber strip (<DemoNote variant="strip">) above the phone
 *                       header — never inverted, never sticky, gone from 1024 (the nav row's demo chip takes over). The
 *                       whole strip is one link to the footer's full statement (#shell-demo).
 *   <ShellOffline />    the kit's offline banner pinned right under the sticky header: on task screens (checkout,
 *                       trade-in, repair, the assistant) it says the form is kept; elsewhere that the cart is.
 *   <PageProgress />    a 2px ink bar under the header once a navigation has waited 150ms (filters, search, trade-in
 *                       steps), so a slow network never looks like a dead tap.
 */
import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";

import { DemoNote } from "~/ui/DemoNote";
import { OfflineBanner } from "~/ui/OfflineBanner";
import { useShellT } from "./i18n";

/** Where the full demo statement lives: the footer's legal row (both footers render it in demo mode). */
export const DEMO_NOTE_ID = "shell-demo";

export function DemoStrip() {
  return <DemoNote variant="strip" to={`#${DEMO_NOTE_ID}`} className="shell-strip lg:hidden" />;
}

export function ShellOffline({ form }: { form: boolean }) {
  const t = useShellT();
  return (
    <div className="shell-offline">
      <OfflineBanner message={form ? t("offline.form") : "store"} offset="calc(var(--safe-top) + var(--shell-header-h))" />
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
