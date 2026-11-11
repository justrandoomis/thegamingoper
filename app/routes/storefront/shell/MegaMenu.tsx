/**
 * The desktop nav row's platforms and their mega menus (Design System v2 §5.3, §5.4).
 *
 * Each platform is ONE 44px menu button (8px dot + name + caret; no separate caret key) with a 3px underline in the
 * platform's dot colour on hover, open and current. Its mega menu is an OPAQUE paper panel under the header, across
 * the page with its content in the 1280 wrap: a first row «كل منتجات PlayStation · 42» (to the platform hub); four
 * columns — الأجهزة (device models), الألعاب (the platform's own games, then all of them, multi-platform ones
 * included — the cross-platform category leaves navigation), الإكسسوارات, البطاقات والخدمات (cards, used units) — of
 * at most five short names; and a featured tile at the inline end (a 1:1 well with the product photo and its name).
 * The page behind gets the light menu scrim.
 *
 * The panel and its scrim are rendered through a portal into the host <ShellFrame> places right after the header —
 * a sibling of the header, never inside the element that carries the view-transition name during page transitions.
 *
 * Opening: a click (the panel drops 8px in 220ms; focus stays on the button), Enter / Space / ↓ (focus moves to the
 * first link), or 140ms of mouse hover intent (focus never moves); leaving the button and the panel for 200ms closes a
 * menu the mouse opened. Escape and the scrim close it, and focus returns to the button when it was in the menu. Tab
 * from the last link continues with the next item of the nav row (as if the panel sat right after its button);
 * Shift+Tab from the first link goes back to the button. Every navigation closes it; it leaves in 140ms.
 * Disclosure-navigation semantics: `aria-expanded` + `aria-controls` on the button, the panel is a labelled region.
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";

import { Art } from "~/art/Art";
import { Icon } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { dematerialize, materialize } from "~/motion";
import { focusablesIn } from "~/ui/Dialog";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { TextLink } from "~/ui/TextLink";
import { megaFeature, megaPlan } from "./chrome";
import { useShellT } from "./i18n";
import type { NavLink, NavPlatform } from "./types";

const OPEN_DELAY = 140;
const CLOSE_DELAY = 200;

/** Where the mega menu renders: an element <ShellFrame> places right after the header (null on the server). */
export const MegaHostContext = createContext<HTMLElement | null>(null);

/** The name shoppers see for a platform: the design system's name for the four known ones (Latin brand names stay
 *  Latin), the catalogue's name otherwise. */
export function usePlatformName(): (platform: Pick<NavPlatform, "slug" | "name">) => string {
  const ui = useT("ui");
  return useCallback((platform) => (isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name), [ui]);
}

/** How the open menu was opened: mouse hover intent (closes when the mouse leaves), a click (stays), the keyboard
 *  (focus moved into it). */
type OpenState = { slug: string; via: "hover" | "click" | "keyboard" } | null;

export type PlatformNavProps = {
  platforms: NavPlatform[];
  /** The platform whose hub is on screen (its button carries the underline and `aria-current`). */
  current?: string | null;
  /** The rest of the nav row (separator, text links), after the platforms. */
  children?: ReactNode;
};

export function PlatformNav({ platforms, current = null, children }: PlatformNavProps) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const location = useLocation();
  const host = useContext(MegaHostContext);
  const [open, setOpen] = useState<OpenState>(null);
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({});
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const navRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const openRef = useRef<OpenState>(null);
  openRef.current = open;

  // what the panel shows: it stays on screen while it leaves
  const [shown, setShown] = useState<string | null>(null);
  if (open && open.slug !== shown) setShown(open.slug);

  const clearTimers = () => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
  };
  const close = useCallback((returnFocus = false) => {
    clearTimeout(timers.current.open);
    clearTimeout(timers.current.close);
    const was = openRef.current;
    setOpen(null);
    if (was && returnFocus) buttons.current.get(was.slug)?.focus();
  }, []);

  // every navigation closes it
  useEffect(() => close(), [location.key, close]);
  useEffect(() => clearTimers, []);

  // Escape closes it wherever focus is (a menu the mouse opened never took focus); focus goes back to its button when
  // it was in the menu. A press, or focus moving, outside the buttons and the panel closes it too.
  useEffect(() => {
    if (!open) return;
    const inside = (node: Node | null) => !!node && (!!navRef.current?.contains(node) || !!panelRef.current?.contains(node));
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      close(openRef.current?.via === "keyboard" || (!!focused && !!panelRef.current?.contains(focused)));
    };
    const onFocus = (event: FocusEvent) => {
      if (!inside(event.target as Node)) close();
    };
    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  const hoverIn = (slug: string) => {
    clearTimeout(timers.current.close);
    const now = openRef.current;
    // a menu opened by a click or the keyboard is not taken away by the mouse passing over another platform
    if ((now && now.via !== "hover") || now?.slug === slug) return;
    clearTimeout(timers.current.open);
    timers.current.open = setTimeout(() => setOpen({ slug, via: "hover" }), now ? 0 : OPEN_DELAY);
  };
  const hoverOut = () => {
    clearTimeout(timers.current.open);
    if (openRef.current?.via !== "hover") return;
    timers.current.close = setTimeout(() => setOpen(null), CLOSE_DELAY);
  };

  // arrive: drop 8px from the button (220ms), the scrim fades in; leave: rise back (140ms), then unmount
  const arrived = useRef(false);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const scrim = panel.previousElementSibling as HTMLElement | null;
    if (open) {
      if (!arrived.current) {
        arrived.current = true;
        void materialize(panel, { from: buttons.current.get(open.slug) ?? null });
        scrim?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      }
      if (open.via === "keyboard" && !panel.contains(document.activeElement)) focusablesIn(panel)[0]?.focus();
      return;
    }
    if (!shown) return;
    let cancelled = false;
    scrim?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-in", fill: "forwards" });
    void dematerialize(panel).then(() => {
      if (cancelled) return;
      arrived.current = false;
      setShown(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, shown]);

  /** Tab out of the panel continues with the nav row after the open button; Shift+Tab out goes back to the button. */
  const onPanelKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current || !openRef.current) return;
    const items = focusablesIn(panelRef.current);
    if (items.length === 0) return;
    const button = buttons.current.get(openRef.current.slug);
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      button?.focus();
    } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
      event.preventDefault();
      const row = navRef.current ? focusablesIn(navRef.current) : [];
      const next = button ? row[row.indexOf(button) + 1] : undefined;
      close();
      (next ?? button)?.focus();
    }
  };

  const shownPlatform = shown ? platforms.find((platform) => platform.slug === shown) : undefined;

  return (
    <>
      <nav ref={navRef} className="shell-nav" aria-label={t("nav.main")}>
        {platforms.map((platform) => {
          const name = nameOf(platform);
          const isOpen = open?.slug === platform.slug;
          return (
            <button
              key={platform.slug}
              ref={(element) => {
                if (element) buttons.current.set(platform.slug, element);
                else buttons.current.delete(platform.slug);
              }}
              type="button"
              className="shell-navitem"
              data-gel={isPlatform(platform.accent) ? platform.accent : undefined}
              data-press="soft"
              aria-expanded={isOpen}
              aria-controls={isOpen ? panelId : undefined}
              aria-current={current === platform.slug ? "true" : undefined}
              onPointerEnter={(event) => event.pointerType === "mouse" && hoverIn(platform.slug)}
              onPointerLeave={(event) => event.pointerType === "mouse" && hoverOut()}
              onClick={(event) => {
                clearTimers();
                // a keyboard click (Enter / Space) has no pointer: it opens on the first link
                const via = event.detail === 0 ? "keyboard" : "click";
                if (!isOpen) setOpen({ slug: platform.slug, via });
                // the mouse opened it by hovering and now clicks: keep it open (pinned) rather than closing under the cursor
                else if (via === "click" && open?.via === "hover") setOpen({ slug: platform.slug, via: "click" });
                else close();
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (isOpen && panelRef.current) focusablesIn(panelRef.current)[0]?.focus();
                  else setOpen({ slug: platform.slug, via: "keyboard" });
                } else if (event.key === "Tab" && !event.shiftKey && isOpen && panelRef.current) {
                  // the panel sits after the header in the document: Tab from its open button goes into it
                  const first = focusablesIn(panelRef.current)[0];
                  if (first) {
                    event.preventDefault();
                    first.focus();
                  }
                }
              }}
            >
              {isPlatform(platform.accent) ? <PlatformLed /> : null}
              <span>{name}</span>
              <Icon name="caret-down" size={16} className="shell-navitem__caret" />
            </button>
          );
        })}
        {children}
      </nav>
      {host && shownPlatform
        ? createPortal(
            <>
              <div className="shell-scrim" aria-hidden="true" onClick={() => close()} />
              <div
                ref={panelRef}
                id={panelId}
                role="region"
                aria-label={t("nav.menuFor", { name: nameOf(shownPlatform) })}
                className="shell-mega"
                data-gel={isPlatform(shownPlatform.accent) ? shownPlatform.accent : undefined}
                inert={!open || undefined}
                onPointerEnter={(event) => event.pointerType === "mouse" && clearTimeout(timers.current.close)}
                onPointerLeave={(event) => event.pointerType === "mouse" && hoverOut()}
                onKeyDown={onPanelKey}
              >
                <MegaContent platform={shownPlatform} name={nameOf(shownPlatform)} />
              </div>
            </>,
            host,
          )
        : null}
    </>
  );
}

type Column = { id: string; title: string; links: NavLink[]; all: NavLink | null; dot?: boolean };

function MegaContent({ platform, name }: { platform: NavPlatform; name: string }) {
  const t = useShellT();
  const plan = megaPlan(platform);
  const feature = megaFeature(platform);
  const columns: Column[] = [
    { id: "devices", title: t("nav.devices"), links: plan.devices, all: plan.allDevices ? { label: t("nav.allDevices", { name }), href: plan.allDevices } : null, dot: true },
    { id: "games", title: t("nav.gamesColumn"), links: plan.games, all: plan.allGames ? { label: t("nav.allGames", { name }), href: plan.allGames } : null },
    { id: "accessories", title: t("nav.accessoriesColumn"), links: plan.accessories, all: null },
    { id: "cards", title: t("nav.cards"), links: plan.used ? [...plan.cards, { label: t("nav.usedOf", { name }), href: plan.used }] : plan.cards, all: null },
  ].filter((column) => column.links.length > 0 || column.all !== null);

  return (
    <div className="page shell-mega__inner">
      <div className="shell-mega__top">
        <TextLink as={LocaleLink} to={platform.href}>
          {t("nav.all", { name })}
          <span className="text-ink-2"> · {t("nav.count", { count: platform.productCount })}</span>
        </TextLink>
      </div>
      <div className="shell-mega__grid">
        {columns.length === 0 ? <p className="shell-mega__empty">{t("nav.empty")}</p> : null}
        {columns.map((column) => (
          <MegaColumn key={column.id} column={column} />
        ))}
        {columns.length > 0 && columns.length < 4 ? <div style={{ gridColumn: `span ${4 - columns.length}` }} aria-hidden="true" /> : null}
        {feature ? (
          <LocaleLink to={feature.href} className="shell-mega__feature">
            <span className="shell-mega__well">
              {feature.artKey ? <Art name={feature.artKey} alt="" sizes="132px" /> : <Icon name="game-controller" size={32} />}
            </span>
            <span className="shell-mega__name">
              <span className="shell-mega__text">{feature.label}</span>
            </span>
          </LocaleLink>
        ) : null}
      </div>
    </div>
  );
}

function MegaColumn({ column }: { column: Column }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="shell-mega__col">
      <h2 id={headingId} className="shell-mega__title">
        {column.dot ? <PlatformLed /> : null}
        {column.title}
      </h2>
      <ul>
        {column.links.map((link) => (
          <li key={link.href}>
            <LocaleLink to={link.href} className="shell-mega__link">
              <span className="shell-mega__line">
                <span className="shell-mega__text">{link.label}</span>
              </span>
            </LocaleLink>
          </li>
        ))}
        {column.all ? (
          <li>
            <LocaleLink to={column.all.href} className="shell-mega__link shell-mega__link--all">
              <span className="shell-mega__line">
                <span className="shell-mega__text">{column.all.label}</span>
              </span>
            </LocaleLink>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
