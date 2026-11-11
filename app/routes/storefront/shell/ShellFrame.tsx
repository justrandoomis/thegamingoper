/**
 * The storefront shell around every customer page (Design System v2 §5). Rendered by the storefront layout around
 * <PageTransition><Outlet/></PageTransition>, and by its ErrorBoundary around the error panel — so a missing page still
 * has its header, tab bar and footer.
 *
 *   STORE      skip link → demo strip (demo mode, below 1024; it scrolls away) → sticky header (56; 64 + 44 from
 *              1024) → [mega-menu host] → offline banner → <main id="main"> → footer → floating tab bar (below 1024;
 *              it gives way to a page's own <TaskBar>) → categories sheet → search sheet → toasts
 *   TASK       the same header, no tab bar (the page's <TaskBar>), the one-line footer — handle `chrome: "task"`
 *   CHECKOUT   ONE bar (56 / 64: back · mascot · step rail · demo tag · help), no strip, no search, no menus, no tab
 *              bar, the one-line footer — handle `chrome: "checkout"` (and `/checkout` by default)
 *
 * The chrome's heights are published on :root as --shell-top / --shell-bottom (shell.css), which base.css turns into
 * the global scroll padding: a focused control is never under a bar (WCAG 2.4.11).
 *
 * PAGES: render your content without your own <main> (the shell's is the one landmark; it is the skip link's target)
 * and start it with your <h1>. Pages with a bottom buy / task bar: see ./TabBar (handle + <TaskBar>); below 1024px
 * their header turns into the task header after scroll (back · the <h1> · cart, ./Header). Fixed chrome is marked
 * `data-motion-persist` (header, nav, bar) so page transitions leave it in place; <MotionRoot/> (press feedback,
 * tiers) is mounted here once.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useMatches, useRouteLoaderData } from "react-router";

import type { MessageTree } from "~/i18n/translate";
import { splitLocale } from "~/lib/locales";
import { MotionRoot } from "~/motion";
import { useOnline } from "~/ui/OfflineBanner";
import { Toaster } from "~/ui/Toast";
import { DemoStrip, ShellOffline } from "./Banners";
import { CategoriesSheet } from "./CategoriesSheet";
import { backFallback, shellChrome } from "./chrome";
import { Footer, TaskFooter } from "./Footer";
import { CheckoutBar, Header } from "./Header";
import { ShellMessages, useShellT } from "./i18n";
import { MegaHostContext } from "./MegaMenu";
import { SearchSheet } from "./SearchForm";
import { TabBar } from "./TabBar";
import type { ShellData } from "./types";

import "./shell.css";

export type ShellFrameProps = {
  /** null when the layout's own loader failed (unknown language prefix, database down): menus are empty then. */
  shell: ShellData | null;
  messages: MessageTree | undefined;
  /** The layout's ErrorBoundary is rendering: the pages' handles (tabBar: false, chrome) no longer apply. */
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
  const path = splitLocale(location.pathname).path;
  const { chrome, tabBar, task, back } = shellChrome(matches, { errored, path });
  const online = useOnline();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [megaHost, setMegaHost] = useState<HTMLDivElement | null>(null);

  // a navigation (a link in a sheet, Back) closes the sheets
  useEffect(() => {
    setSheetOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  return (
    <div className="shell" data-chrome={chrome} data-offline={online ? undefined : ""}>
      <MotionRoot />
      <a href="#main" className="shell-skip">
        {t("skip")}
      </a>
      {chrome === "checkout" ? (
        <CheckoutBar demo={demo} />
      ) : (
        <>
          {demo ? <DemoStrip /> : null}
          <MegaHostContext value={megaHost}>
            <Header shell={shell} demo={demo} task={task ? { back: back ?? backFallback(path) } : null} onSearch={() => setSearchOpen(true)} />
          </MegaHostContext>
          <div ref={setMegaHost} className="contents" />
        </>
      )}
      <ShellOffline form={chrome !== "store"} />
      <main id="main" tabIndex={-1} className="shell-main">
        {children}
      </main>
      {chrome === "store" ? <Footer shell={shell} demo={demo} /> : <TaskFooter shell={shell} demo={demo} />}
      {tabBar ? <TabBar sheetOpen={sheetOpen} onCategories={() => setSheetOpen(true)} /> : null}
      {tabBar ? <CategoriesSheet open={sheetOpen} onClose={() => setSheetOpen(false)} shell={shell} /> : null}
      {chrome !== "checkout" ? <SearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} platforms={shell?.nav.platforms ?? []} /> : null}
      <Toaster offset="var(--shell-toast-top)" />
    </div>
  );
}
