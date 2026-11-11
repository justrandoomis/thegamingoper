/**
 * Desktop platform navigation (≥1200, docs/DESIGN.md §8.8): each platform is a text link with its LED (to the
 * platform hub) plus a caret key that opens its mega menu — one live glass sheet dropping from the header with
 * plain text-link columns (about the device · accessories · games · consoles and used) and the platform's lit stage.
 *
 * Opening: the caret (click, Enter, Space; ArrowDown on the platform link) opens it and moves focus inside, where
 * Tab stays until Escape (back to the caret) or a choice; a mouse resting on a platform for 120 ms opens it without
 * taking focus, and leaving the link and the sheet for 200 ms closes it. A press outside, Escape, and every
 * navigation close it. The open platform's name is underlined (§8.8). Disclosure-navigation semantics:
 * `aria-expanded` + `aria-controls` on the caret, the sheet is a labelled region of links.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { materialize } from "~/motion";
import { focusablesIn } from "~/ui/Dialog";
import { Glass } from "~/ui/Glass";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { Render, Stage } from "~/ui/Stage";
import { TextLink } from "~/ui/TextLink";
import { useShellT } from "./i18n";
import type { NavLink, NavPlatform } from "./types";

const OPEN_DELAY = 120;
const CLOSE_DELAY = 200;

/** The name shoppers see for a platform: the design system's name for the four known ones (Latin brand names stay
 *  Latin, DESIGN.md §11), the catalogue's name otherwise. */
export function usePlatformName(): (platform: Pick<NavPlatform, "slug" | "name">) => string {
  const ui = useT("ui");
  return useCallback((platform) => (isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name), [ui]);
}

type OpenState = { slug: string; via: "pointer" | "keyboard" } | null;

export function PlatformNav({ platforms, children }: { platforms: NavPlatform[]; children?: ReactNode }) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const location = useLocation();
  const [open, setOpen] = useState<OpenState>(null);
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({});
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const navRef = useRef<HTMLElement>(null);
  const sheetId = useId();

  const clearTimers = () => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
  };
  const openRef = useRef<OpenState>(null);
  openRef.current = open;
  const close = useCallback((returnFocus = false) => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
    const current = openRef.current;
    setOpen(null);
    if (current && returnFocus) toggles.current.get(current.slug)?.focus();
  }, []);

  // every navigation closes it
  useEffect(() => close(), [location.key, close]);
  useEffect(() => clearTimers, []);

  // a press outside the platform links and the sheet closes it; so does Escape, wherever focus is (a menu opened by
  // the mouse never took focus)
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (navRef.current?.contains(target) || document.getElementById(sheetId)?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) close(openRef.current?.via === "keyboard");
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close, sheetId]);

  const hoverIn = (slug: string) => {
    clearTimeout(timers.current.close);
    if (open?.via === "keyboard") return;
    if (open?.slug === slug) return;
    clearTimeout(timers.current.open);
    timers.current.open = setTimeout(() => setOpen({ slug, via: "pointer" }), open ? 0 : OPEN_DELAY);
  };
  const hoverOut = () => {
    clearTimeout(timers.current.open);
    if (open?.via === "keyboard") return;
    timers.current.close = setTimeout(() => setOpen(null), CLOSE_DELAY);
  };

  const current = open ? platforms.find((platform) => platform.slug === open.slug) : undefined;

  return (
    <>
      <nav ref={navRef} className="shell-nav" aria-label={t("nav.main")}>
        {platforms.map((platform) => {
          const name = nameOf(platform);
          const isOpen = open?.slug === platform.slug;
          return (
            <span
              key={platform.slug}
              className="shell-nav__item"
              data-gel={isPlatform(platform.accent) ? platform.accent : undefined}
              data-open={isOpen ? "" : undefined}
              onPointerEnter={(event) => event.pointerType === "mouse" && hoverIn(platform.slug)}
              onPointerLeave={(event) => event.pointerType === "mouse" && hoverOut()}
            >
              <LocaleLink
                to={platform.href}
                className="shell-nav__link"
                onKeyDown={(event) => {
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  setOpen({ slug: platform.slug, via: "keyboard" });
                }}
              >
                {isPlatform(platform.accent) ? <PlatformLed solid /> : null}
                <span className="shell-nav__text">{name}</span>
              </LocaleLink>
              <button
                ref={(element) => {
                  if (element) toggles.current.set(platform.slug, element);
                  else toggles.current.delete(platform.slug);
                }}
                type="button"
                className="shell-nav__toggle"
                aria-expanded={isOpen}
                aria-controls={isOpen ? sheetId : undefined}
                aria-label={t("nav.menuFor", { name })}
                onClick={() => (isOpen && open?.via === "keyboard" ? close() : setOpen({ slug: platform.slug, via: "keyboard" }))}
              >
                <Icon name="caret-down" size={14} />
              </button>
            </span>
          );
        })}
        {children}
      </nav>
      {current ? (
        <MegaSheet
          key={current.slug}
          id={sheetId}
          platform={current}
          name={nameOf(current)}
          takeFocus={open?.via === "keyboard"}
          onPointerEnter={() => clearTimeout(timers.current.close)}
          onPointerLeave={hoverOut}
          onClose={close}
        />
      ) : null}
    </>
  );
}

type MegaSheetProps = {
  id: string;
  platform: NavPlatform;
  name: string;
  takeFocus: boolean;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: (returnFocus?: boolean) => void;
};

function MegaSheet({ id, platform, name, takeFocus, onPointerEnter, onPointerLeave, onClose }: MegaSheetProps) {
  const t = useShellT();
  const sheet = useRef<HTMLDivElement>(null);
  const gel = isPlatform(platform.accent) ? platform.accent : null;

  useLayoutEffect(() => {
    const element = sheet.current;
    if (!element) return;
    // drops in 8px with opacity (§7.2 menus); leaving is instant — the next platform's sheet replaces it in place
    void materialize(element);
    if (takeFocus) focusablesIn(element)[0]?.focus();
  }, [takeFocus]);

  const consoles: NavLink[] = [...platform.consoles];
  if (platform.allConsoles) consoles.push({ label: t("nav.allConsoles"), href: platform.allConsoles.href });
  if (platform.used) consoles.push({ label: t("nav.usedOf", { name }), href: platform.used.href });
  const columns: { title: string; links: NavLink[] }[] = [
    { title: t("nav.devices"), links: platform.devices },
    { title: t("nav.accessories"), links: platform.accessories },
    { title: t("nav.games"), links: platform.games },
    { title: t("nav.consoles"), links: consoles },
  ].filter((column) => column.links.length > 0);

  return (
    <Glass
      ref={sheet}
      id={id}
      role="region"
      aria-label={t("nav.menuFor", { name })}
      className="shell-mega"
      onPointerEnter={(event) => event.pointerType === "mouse" && onPointerEnter()}
      onPointerLeave={(event) => event.pointerType === "mouse" && onPointerLeave()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose(true);
          return;
        }
        if (event.key !== "Tab" || !sheet.current) return;
        // focus stays inside while the sheet is open (§8.8)
        const items = focusablesIn(sheet.current);
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="page shell-mega__grid">
        {columns.length > 0 ? (
          columns.map((column) => <MegaColumn key={column.title} title={column.title} links={column.links} />)
        ) : (
          <p className="type-body col-span-4 text-ink-2">{t("nav.empty")}</p>
        )}
        {columns.length > 0 && columns.length < 4 ? <div style={{ gridColumn: `span ${4 - columns.length}` }} aria-hidden="true" /> : null}
        <div className="shell-mega__side">
          {platform.artKey ? (
            <Stage size="compact" gel={gel}>
              <Render name={platform.artKey} alt="" sizes="260px" />
            </Stage>
          ) : null}
          <TextLink as={LocaleLink} to={platform.href}>
            {t("nav.all", { name })}
            <span className="text-ink-2"> · {t("nav.count", { count: platform.productCount })}</span>
          </TextLink>
        </div>
      </div>
    </Glass>
  );
}

function MegaColumn({ title, links }: { title: string; links: NavLink[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="shell-mega__title">
        {title}
      </h2>
      <ul>
        {links.map((link) => (
          <li key={link.href}>
            <MegaLink link={link} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function MegaLink({ link }: { link: NavLink }): ReactNode {
  return (
    <LocaleLink to={link.href} className="shell-mega__link">
      <span className="shell-mega__text">{link.label}</span>
    </LocaleLink>
  );
}
