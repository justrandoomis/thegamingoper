/**
 * The admin shell around every admin page (DESIGN.md §10) — rendered by app/routes/admin/_layout.tsx around the
 * page, and by its ErrorBoundary around the 403/404/500 panel, so an error keeps the navigation.
 *
 *   skip link → rail (≥ 1200) → [tool bar → <main id="main">] → tab bar (< 768) → sections sheet → command palette
 *   → toasts → <OpsReporter/> (module 23: this window's script errors and slow loads, POSTed to /admin/ops/report —
 *   every signed-in employee may; one reporter per window, so the operations module's own copy stays silent)
 *
 * `data-density="admin"` puts every key, field, table and overlay below it in admin density (app/styles/admin.css).
 * No page transitions and no ambient motion: the admin is for work (no heavy animation near tables); key presses keep
 * their feedback (<MotionRoot/>).
 *
 * PAGES: render your content without your own <main> (the shell's is the landmark and the skip link's target), start
 * with your <h1>, and use `adminMeta()` from ./meta for the title. Admin links are plain react-router <Link>s with
 * /admin paths — never LocaleLink (the admin's language is a cookie, not a URL prefix). A sticky bar at the bottom of a
 * page sits at `inset-block-end: var(--adm-bottom)` (the phone tab bar).
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

import type { MessageTree } from "~/i18n/translate";
import { MotionRoot } from "~/motion";
import { Sheet } from "~/ui/Sheet";
import { Toaster } from "~/ui/Toast";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { BLUEPRINT_STATUS } from "../blueprint-status";
import { OpsReporter } from "../ops/components/Reporter";
import { useShellActions } from "./actions";
import { AdminMessages, useAdminT } from "./i18n";
import { NavList, Rail, TabBar } from "./Nav";
import { Palette } from "./Palette";
import type { AdminShellData } from "./shell.server";
import { TopBar } from "./TopBar";

import "./admin-shell.css";

export type AdminShellProps = {
  /** null when the layout's own loader failed: the frame then has no navigation. */
  data: AdminShellData | null;
  messages: MessageTree | undefined;
  children: ReactNode;
};

export function AdminShell({ data, messages, children }: AdminShellProps) {
  return (
    <AdminMessages messages={messages}>
      <Frame data={data}>{children}</Frame>
    </AdminMessages>
  );
}

function Frame({ data, children }: { data: AdminShellData | null; children: ReactNode }) {
  const t = useAdminT();
  const location = useLocation();
  const { setRail } = useShellActions();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [rail, setRailState] = useState<"expanded" | "collapsed">(data?.rail ?? "expanded");

  // A navigation closes the sections sheet and the palette.
  useEffect(() => {
    setSectionsOpen(false);
    setPaletteOpen(false);
  }, [location.pathname]);

  // Ctrl/⌘ K anywhere opens (or closes) the palette — by key position too, so it works with an Arabic layout.
  useEffect(() => {
    if (!data) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "k" && event.code !== "KeyK") return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [data]);

  const toggleRail = useCallback(() => {
    const next = rail === "collapsed" ? "expanded" : "collapsed";
    setRailState(next);
    setRail(next);
  }, [rail, setRail]);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  return (
    <div className="adm" data-density="admin" data-rail={rail} data-nav={data ? undefined : "none"}>
      <MotionRoot />
      <VisuallyHidden as="a" href="#main" focusable className="adm-skip">
        {t("skip")}
      </VisuallyHidden>
      {data ? <Rail modules={data.modules} waiting={data.waiting} collapsed={rail === "collapsed"} onToggle={toggleRail} /> : null}
      <div className="adm-col">
        <TopBar data={data} onSearch={openPalette} onSections={() => setSectionsOpen(true)} sectionsOpen={sectionsOpen} />
        <main id="main" tabIndex={-1} className="adm-main">
          {children}
        </main>
      </div>
      {data ? (
        <>
          <TabBar modules={data.modules} waiting={data.waiting} onSearch={openPalette} onSections={() => setSectionsOpen(true)} sectionsOpen={sectionsOpen} />
          <Sheet open={sectionsOpen} onClose={() => setSectionsOpen(false)} title={t("nav.title")} presentation="side" sideFrom={768} flush>
            <div className="py-2">
              <NavList modules={data.modules} waiting={data.waiting} onNavigate={() => setSectionsOpen(false)} />
            </div>
          </Sheet>
          <Palette open={paletteOpen} onClose={closePalette} data={data} statuses={BLUEPRINT_STATUS} rail={rail} onToggleRail={toggleRail} />
          {/* only with a signed-in employee: the report endpoint needs one (the password-set page has no shell data) */}
          <OpsReporter />
        </>
      ) : null}
      <Toaster offset="calc(var(--safe-top) + var(--adm-top-h) + var(--s-2))" />
    </div>
  );
}
