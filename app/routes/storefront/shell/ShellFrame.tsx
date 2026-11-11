/**
 * The storefront shell around every customer page (docs/DESIGN.md §9.2, §9.3, §8.8, §8.11). Rendered by the
 * storefront layout around <PageTransition><Outlet/></PageTransition>, and by its ErrorBoundary around the 404/500
 * panel — so a missing page still has the header, the tab bar and the footer.
 *
 *   skip link → demo ribbon (demo mode) → utility strip (≥1200) → sticky header (+ mega menus) → offline banner
 *   → <main id="main"> → footer → tab bar (< 1200, unless the page has its own task bar) → categories sheet → toasts
 *
 * PAGES: render your content without your own <main> (the shell's is the one landmark; it is the skip link's
 * target) and start it with your <h1>. Pages with a bottom buy/checkout bar: see ./TabBar (handle + <TaskBar>);
 * below 1200px their header turns into the task header after scroll (back · the <h1> · cart, ./Header).
 * Fixed chrome is marked `data-motion-persist` (header, nav) so page transitions leave it in place; <MotionRoot/>
 * (press feedback, tiers) is mounted here once.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useMatches, useRouteLoaderData } from "react-router";

import type { MessageTree } from "~/i18n/translate";
import { splitLocale } from "~/lib/locales";
import { MotionRoot } from "~/motion";
import { OfflineBanner } from "~/ui/OfflineBanner";
import { Toaster } from "~/ui/Toast";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { DemoRibbon } from "./Banners";
import { CategoriesSheet } from "./CategoriesSheet";
import { backFallback, shellChrome } from "./chrome";
import { Footer } from "./Footer";
import { Header, UtilityBar } from "./Header";
import { ShellMessages, useShellT } from "./i18n";
import { TabBar } from "./TabBar";
import type { ShellData } from "./types";

import "./shell.css";

export type ShellFrameProps = {
  /** null when the layout's own loader failed (unknown language prefix, database down): menus are empty then. */
  shell: ShellData | null;
  messages: MessageTree | undefined;
  /** The layout's ErrorBoundary is rendering: the pages' handles (tabBar: false) no longer apply. */
  errored?: boolean;
  children: ReactNode;
};

type RootShellData = { storeMode?: "demo" | "live" };

export function ShellFrame({ shell, messages, errored = false, children }: ShellFrameProps) {
  return (
    <ShellMessages messages={messages}>
      <Frame shell={shell} errored={errored}>
        {children}
      </Frame>
    </ShellMessages>
  );
}

function Frame({ shell, errored, children }: { shell: ShellData | null; errored: boolean; children: ReactNode }) {
  const t = useShellT();
  const root = useRouteLoaderData("root") as RootShellData | undefined;
  const demo = root?.storeMode !== "live";
  const matches = useMatches();
  const location = useLocation();
  const { tabBar, back } = shellChrome(matches, { errored });
  const [sheetOpen, setSheetOpen] = useState(false);

  // a navigation (a link in the sheet, Back) closes the categories sheet
  useEffect(() => setSheetOpen(false), [location.pathname]);

  return (
    <div className="shell" data-tabbar={tabBar ? "on" : "off"}>
      <MotionRoot />
      <VisuallyHidden as="a" href="#main" focusable className="shell-skip">
        {t("skip")}
      </VisuallyHidden>
      {demo ? <DemoRibbon /> : null}
      <UtilityBar shell={shell} />
      <Header shell={shell} task={tabBar ? null : { back: back ?? backFallback(splitLocale(location.pathname).path) }} />
      <OfflineBanner offset="calc(var(--safe-top) + var(--shell-header-h))" />
      <main id="main" tabIndex={-1} className="shell-main">
        {children}
      </main>
      <Footer shell={shell} demo={demo} />
      {tabBar ? <TabBar sheetOpen={sheetOpen} onCategories={() => setSheetOpen(true)} /> : null}
      <CategoriesSheet open={sheetOpen} onClose={() => setSheetOpen(false)} shell={shell} />
      <Toaster offset="var(--shell-toast-top, calc(var(--safe-top) + var(--shell-header-h) + var(--s-2)))" />
    </div>
  );
}
