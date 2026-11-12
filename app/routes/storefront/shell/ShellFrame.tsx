/**
 * The storefront shell around every customer page (Design System v2 §5). Rendered by the storefront layout around
 * <PageTransition><Outlet/></PageTransition>, and by its ErrorBoundary around the error panel — so a missing page still
 * has its header, tab bar and footer.
 *
 *   STORE      skip link → demo strip (demo mode, below 1024; it scrolls away) → sticky header (56; from 1024 the
 *              utility strip + 64 + 44, the strip scrolling away) → [mega-menu host] → offline banner → <main id="main">
 *              → footer → floating tab bar (below 1024; it gives way to a page's own <TaskBar>) → categories sheet →
 *              search sheet → toasts. The header shows the search field or only the round search key by path
 *              (./chrome searchMode, v2.1 §2.7); both open the same search.
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
import { backFallback, focusNudge, searchMode, shellChrome, type FocusEdges } from "./chrome";
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
  /** Words the search fields start with (the header's and the phone sheet's): a missing product's slug words. */
  searchQuery?: string;
  children: ReactNode;
};

type RootShellData = { storeMode?: "demo" | "live" };

export function ShellFrame({ shell, messages, errored = false, searchQuery, children }: ShellFrameProps) {
  return (
    <ShellMessages messages={messages}>
      <Frame shell={shell} errored={errored} searchQuery={searchQuery}>
        {children}
      </Frame>
    </ShellMessages>
  );
}

function Frame({ shell, errored, searchQuery, children }: { shell: ShellData | null; errored: boolean; searchQuery?: string; children: ReactNode }) {
  const t = useShellT();
  const root = useRouteLoaderData("root") as RootShellData | undefined;
  const demo = root?.storeMode !== "live";
  const matches = useMatches();
  const location = useLocation();
  const path = splitLocale(location.pathname).path;
  const { chrome, tabBar, task, back, offline } = shellChrome(matches, { errored, path });
  const online = useOnline();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [megaHost, setMegaHost] = useState<HTMLDivElement | null>(null);

  // a navigation (a link in a sheet, Back) closes the sheets
  useEffect(() => {
    setSheetOpen(false);
    setSearchOpen(false);
  }, [location.pathname]);

  useFocusClearOfBars();

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
            <Header
              shell={shell}
              demo={demo}
              task={task ? { back: back ?? backFallback(path) } : null}
              onSearch={() => setSearchOpen(true)}
              searchQuery={searchQuery}
              // the field on pages for finding products, the round key elsewhere (v2.1 §2.7) — decided here, by path
              search={searchMode(path, { errored })}
            />
          </MegaHostContext>
          <div ref={setMegaHost} className="contents" />
        </>
      )}
      <ShellOffline words={offline} />
      <main id="main" tabIndex={-1} className="shell-main">
        {children}
      </main>
      {chrome === "store" ? <Footer shell={shell} demo={demo} /> : <TaskFooter shell={shell} demo={demo} />}
      {tabBar ? <TabBar sheetOpen={sheetOpen} onCategories={() => setSheetOpen(true)} /> : null}
      {tabBar ? <CategoriesSheet open={sheetOpen} onClose={() => setSheetOpen(false)} shell={shell} /> : null}
      {chrome !== "checkout" ? <SearchSheet open={searchOpen} onClose={() => setSearchOpen(false)} platforms={shell?.nav.platforms ?? []} query={searchQuery} /> : null}
      <Toaster offset="var(--shell-toast-top)" />
    </div>
  );
}

/** What sticks at the top (the header or the checkout bar, the offline banner under it) and what is fixed at the bottom. */
const TOP_BARS = ".shell-header, .shell-cobar, .shell-offline";
const BOTTOM_BARS = ".shell-tabbar, .shell-taskbar";
/** Focus inside these is not the page's: they do not scroll with it (the bars themselves, sheets, dialogs, menus). */
const NOT_THE_PAGE = `${TOP_BARS}, ${BOTTOM_BARS}, dialog, [role="dialog"], [popover], .shell-mega`;

/** The room between the bars right now, in viewport pixels (a bar that is not drawn does not count). */
function focusEdges(): FocusEdges {
  let top = 0;
  for (const bar of document.querySelectorAll(TOP_BARS)) {
    const box = bar.getBoundingClientRect();
    if (box.height > 0 && box.bottom > 0 && box.top < window.innerHeight / 2) top = Math.max(top, box.bottom);
  }
  let bottom = window.innerHeight;
  for (const bar of document.querySelectorAll(BOTTOM_BARS)) {
    const box = bar.getBoundingClientRect();
    if (box.height > 0 && box.top < window.innerHeight && box.top > window.innerHeight / 2) bottom = Math.min(bottom, box.top);
  }
  return { top, bottom };
}

/**
 * Focus is never left under a bar (WCAG 2.4.11, v2 §10). The global `scroll-padding-block` (from --shell-top and
 * --shell-bottom) covers a control the browser scrolls to, but a browser does not scroll a control that is already
 * PARTLY in view: Tab from «العنوان بالتفصيل» left «ملاحظات للمندوب» with its lower 29px — the focus ring included —
 * under the checkout task bar. After the browser's own scrolling (next frame), a control of the page that still
 * reaches under a bar is moved clear of it by the overlap + 12px (./chrome focusNudge). Keyboard focus only
 * (`:focus-visible` — a text field counts however it was focused): a button pressed with the mouse never makes the
 * page jump.
 */
function useFocusClearOfBars() {
  useEffect(() => {
    let frame = 0;
    const onFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest("#main, footer") || target.closest(NOT_THE_PAGE)) return;
      // controls only: a programmatic focus target (`tabindex="-1"`: <main> after a navigation, a heading) never moves
      // the page — scroll restoration and the reading position stay where they are
      if (target.tabIndex < 0) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (document.activeElement !== target || !target.matches(":focus-visible")) return;
        const nudge = focusNudge(target.getBoundingClientRect(), focusEdges());
        if (nudge !== 0) window.scrollBy({ top: nudge, behavior: "instant" });
      });
    };
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("focusin", onFocus);
      cancelAnimationFrame(frame);
    };
  }, []);
}
