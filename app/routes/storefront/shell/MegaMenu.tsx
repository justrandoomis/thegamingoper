/**
 * The desktop nav row's platforms and their mega menus (Design v2.1 note 6 — v2's arrangement, improved; v2 §5.3, §5.4).
 *
 * NAV ROW. Each platform is ONE 44px menu button: its device glyph in a small circle of the platform's colour light,
 * the name and the chevron. One indicator in the platform's colour (ink for the plain links) SLIDES under the item the
 * pointer or the keyboard focus is on, and rests under the open menu's platform or the current page's item
 * (transform only; instant under reduced motion). Without script each item draws its own underline instead.
 *
 * MEGA MENU. A frosted glass panel under the header, across the page with its content in the 1280 wrap, a line of the
 * platform's colour on its top edge. A head row: the platform (glyph, name, how many products) and «كل منتجات …» as a
 * clay key. Then four columns — الأجهزة (device models by their SHORT names, «PS5 Digital (2020)», the full name in the
 * tooltip, each with the model's photo when the read layer sends one — no stand-in glyph), الألعاب (the
 * platform's own games, then all of them, multi-platform ones included), الإكسسوارات, البطاقات والخدمات (cards, used
 * units) — each headed by its kind icon, at most five links with the read layer's counts; a hovered row is
 * highlighted. And a featured card at the inline end (the read layer's `featured`): the photo on a lit well, the name,
 * its qualifier on its own meta line («نسخة الأقراص»), the price with «سعر تجريبي» on a demo row, «نفد حالياً» /
 * «قريباً» when it cannot be bought today, and a clay key «عرض المنتج» (the whole card is one link).
 *
 * The panel and its scrim are rendered through a portal into the host <ShellFrame> places right after the header —
 * a sibling of the header, never inside the element that carries the view-transition name during page transitions.
 * They start at the header's bottom edge wherever it is (the utility strip scrolls away): measured while the menu is
 * on screen, published as `--shell-mega-top`.
 *
 * Motion: the panel drops 8px with a fade (materialize, 220ms) and its columns follow 40ms apart (CSS); switching
 * platform while open staggers the new columns in; leaving rises back in 140ms. Reduced motion: opacity only, no
 * stagger.
 *
 * Opening: a click (focus stays on the button), Enter / Space / ↓ (focus moves to the first link), or 140ms of mouse
 * hover intent (focus never moves); leaving the button and the panel for 200ms closes a menu the mouse opened. Escape
 * and the scrim close it, and focus returns to the button when it was in the menu. Tab from the last link continues
 * with the next item of the nav row (as if the panel sat right after its button); Shift+Tab from the first link goes
 * back to the button. Every navigation closes it. Disclosure-navigation semantics: `aria-expanded` + `aria-controls` on
 * the button, the panel is a labelled region.
 */
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";

import { productPhotos } from "~/art";
import { Art } from "~/art/Art";
import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useDir, useFormat, useT } from "~/i18n/react";
import { dematerialize, materialize } from "~/motion";
import { BidiText, latinName } from "~/ui/BidiText";
import { mediaUrl } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { focusablesIn } from "~/ui/Dialog";
import { Glass } from "~/ui/Glass";
import { Key } from "~/ui/Key";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import { SafePrice } from "~/ui/PriceTag";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { megaFeature, megaPlan, megaWords, type MegaFeature, type MegaLink } from "./chrome";
import { useShellT } from "./i18n";
import type { NavPlatform } from "./types";

const OPEN_DELAY = 140;
const CLOSE_DELAY = 200;
/** Where the nav row (and so the mega menu) exists: shell.css draws it from 64rem. */
const DESKTOP = "(min-width: 64rem)";
/** The indicator stops short of an item's edges by its padding (the words' width). */
const INK_INSET = 10;

/** Where the mega menu renders: an element <ShellFrame> places right after the header (null on the server). */
export const MegaHostContext = createContext<HTMLElement | null>(null);

/** The name shoppers see for a platform: the design system's name for the four known ones (Latin brand names stay
 *  Latin), the catalogue's name otherwise. */
export function usePlatformName(): (platform: Pick<NavPlatform, "slug" | "name">) => string {
  const ui = useT("ui");
  return useCallback((platform) => (isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name), [ui]);
}

/**
 * A platform's device silhouette (never a logo — spec §13): the kit's `device-*` glyph (~/art/Icon, v2.1 G4 — the
 * before's pictograms at 2px), decorative.
 */
export function DeviceGlyph({ platform, size = 20, className }: { platform: Platform; size?: number; className?: string }) {
  return <Icon name={`device-${platform}`} size={size} className={className} />;
}

/** How the open menu was opened: mouse hover intent (closes when the mouse leaves), a click (stays), the keyboard
 *  (focus moved into it). */
type OpenState = { slug: string; via: "hover" | "click" | "keyboard" } | null;

export type PlatformNavProps = {
  platforms: NavPlatform[];
  /** The platform whose hub is on screen (its button carries the indicator and `aria-current`). */
  current?: string | null;
  /** STORE_MODE is "demo". Kept for callers; the featured card marks a demo row's price in either mode. */
  demo?: boolean;
  /** The rest of the nav row (separator, text links), after the platforms. */
  children?: ReactNode;
};

/**
 * The sliding indicator: one element under the nav row's items, moved with transform only (translate to the item's
 * inline start, scale to its width) and coloured by the item's platform. `move(null)` hides it.
 */
function useNavInk(nav: React.RefObject<HTMLElement | null>, ink: React.RefObject<HTMLSpanElement | null>) {
  return useCallback(
    (item: HTMLElement | null) => {
      const bar = ink.current;
      if (!bar || !nav.current) return;
      if (!item || item.offsetWidth === 0) {
        delete bar.dataset.on;
        return;
      }
      const width = Math.max(8, item.offsetWidth - 2 * INK_INSET);
      const x = item.offsetLeft + INK_INSET - bar.offsetLeft;
      const gel = item.dataset.gel;
      if (gel) bar.dataset.gel = gel;
      else delete bar.dataset.gel;
      const place = () => {
        bar.style.translate = `${x}px 0`;
        bar.style.scale = `${width} 1`;
      };
      if (bar.dataset.on === undefined) {
        // appearing: placed where it is needed first (no slide from a stale place), then faded in
        place();
        void bar.getBoundingClientRect();
        bar.dataset.on = "";
      } else {
        place();
      }
    },
    [nav, ink],
  );
}

export function PlatformNav({ platforms, current = null, children }: PlatformNavProps) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const location = useLocation();
  const host = useContext(MegaHostContext);
  const [open, setOpen] = useState<OpenState>(null);
  const timers = useRef<{ open?: ReturnType<typeof setTimeout>; close?: ReturnType<typeof setTimeout> }>({});
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const navRef = useRef<HTMLElement>(null);
  const inkRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const openRef = useRef<OpenState>(null);
  openRef.current = open;
  /** The row's item under the mouse right now (null once the mouse has left the row). */
  const hovered = useRef<HTMLElement | null>(null);
  const moveInk = useNavInk(navRef, inkRef);

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

  /**
   * Where the indicator rests: under the item the mouse is on, else the open menu's platform, else the current page's
   * item, else nowhere. The hovered item comes first: a menu that closes 200ms after the mouse moved from its platform
   * to «المستعمل» left the mouse there — the ink jumped back to the page's platform under it (QA 2026-11-13).
   */
  const restInk = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const openButton = openRef.current ? (buttons.current.get(openRef.current.slug) ?? null) : null;
    const pointed = hovered.current && nav.contains(hovered.current) ? hovered.current : null;
    moveInk(pointed ?? openButton ?? nav.querySelector<HTMLElement>(".shell-navitem[aria-current]"));
  }, [moveInk]);

  // the indicator takes over from the per-item underlines once the page is live; it rests again after every
  // navigation, when a menu opens or closes and when the row's width changes (fonts, language, window)
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    nav.dataset.ink = "";
    restInk();
    const observer = new ResizeObserver(() => restInk());
    observer.observe(nav);
    return () => observer.disconnect();
  }, [restInk, location.pathname]);
  useLayoutEffect(() => restInk(), [open, restInk]);

  // Escape closes it wherever focus is (a menu the mouse opened never took focus); focus goes back to its button when
  // it was in the menu. A press, or focus moving, outside the buttons and the panel closes it too. So does the window
  // leaving the desktop range (a tablet turned upright, a zoom): below 1024 the nav row is gone, and the panel stayed
  // on screen over the phone layout with no button to close it.
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
    const desktop = window.matchMedia(DESKTOP);
    const onWidth = () => {
      if (!desktop.matches) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("pointerdown", onPointer);
    desktop.addEventListener("change", onWidth);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("pointerdown", onPointer);
      desktop.removeEventListener("change", onWidth);
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

  // the panel and its scrim start at the header's bottom edge, wherever the header is right now (the utility strip
  // scrolls away): measured while the menu is on screen, at most once a frame
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const header = navRef.current?.closest("header");
    if (!shown || !panel || !header) return;
    const scrim = panel.previousElementSibling as HTMLElement | null;
    let frame = 0;
    const place = () => {
      frame = 0;
      const top = `${Math.max(0, Math.round(header.getBoundingClientRect().bottom))}px`;
      panel.style.setProperty("--shell-mega-top", top);
      scrim?.style.setProperty("--shell-mega-top", top);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [shown]);

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

  // the indicator follows the pointer and the keyboard focus over the row's items, and rests when they leave
  const itemOf = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>(".shell-navitem") : null);
  const shownPlatform = shown ? platforms.find((platform) => platform.slug === shown) : undefined;

  return (
    <>
      <nav
        ref={navRef}
        className="shell-nav"
        aria-label={t("nav.main")}
        onPointerOver={(event) => {
          if (event.pointerType !== "mouse") return;
          hovered.current = itemOf(event.target);
          moveInk(hovered.current);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse") return;
          hovered.current = null;
          restInk();
        }}
        onFocus={(event) => {
          const item = itemOf(event.target);
          if (item?.matches(":focus-visible")) moveInk(item);
        }}
        onBlur={(event) => {
          if (!navRef.current?.contains(event.relatedTarget as Node | null)) restInk();
        }}
      >
        {platforms.map((platform) => {
          const name = nameOf(platform);
          const isOpen = open?.slug === platform.slug;
          const accent = isPlatform(platform.accent) ? platform.accent : null;
          return (
            <button
              key={platform.slug}
              ref={(element) => {
                if (element) buttons.current.set(platform.slug, element);
                else buttons.current.delete(platform.slug);
              }}
              type="button"
              className="shell-navitem shell-navitem--plat"
              data-gel={accent ?? undefined}
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
              {accent ? (
                <span className="shell-navitem__glyph" aria-hidden="true">
                  <DeviceGlyph platform={accent} size={18} />
                </span>
              ) : null}
              <span>{name}</span>
              <Icon name="caret-down" size={16} className="shell-navitem__caret" />
            </button>
          );
        })}
        {children}
        <span ref={inkRef} className="shell-nav__ink" aria-hidden="true" />
      </nav>
      {host && shownPlatform
        ? createPortal(
            <>
              <div className="shell-scrim" aria-hidden="true" onClick={() => close()} />
              <Glass
                ref={panelRef}
                id={panelId}
                role="region"
                aria-label={t("nav.menuFor", { name: nameOf(shownPlatform) })}
                className="shell-mega glass--panel"
                data-gel={isPlatform(shownPlatform.accent) ? shownPlatform.accent : undefined}
                inert={!open || undefined}
                onPointerEnter={(event: React.PointerEvent<HTMLDivElement>) => event.pointerType === "mouse" && clearTimeout(timers.current.close)}
                onPointerLeave={(event: React.PointerEvent<HTMLDivElement>) => event.pointerType === "mouse" && hoverOut()}
                onKeyDown={onPanelKey}
              >
                <MegaContent key={shownPlatform.slug} platform={shownPlatform} name={nameOf(shownPlatform)} />
              </Glass>
            </>,
            host,
          )
        : null}
    </>
  );
}

type ColumnId = "devices" | "games" | "accessories" | "cards";
type Column = { id: ColumnId; title: string; links: MegaLink[]; all: { label: string; href: string } | null };

/** The kind icon heading each column (the devices column takes the platform's own device glyph). */
const COLUMN_ICON: Record<ColumnId, IconName> = { devices: "kind-console", games: "kind-game", accessories: "kind-controller", cards: "kind-topup" };

/** A product's first catalogue photo ("<slug>--<n>"), or null: the featured card never draws the glyph while one exists. */
const firstPhoto = (slug: string): string | null => productPhotos(slug)[0]?.key ?? null;

/** Each column (and the featured card) arrives 40ms after the one before it (CSS reads --i). */
const order = (index: number) => ({ "--i": index }) as CSSProperties;

function MegaContent({ platform, name }: { platform: NavPlatform; name: string }) {
  const t = useShellT();
  const plan = megaPlan(platform);
  const feature = megaFeature(platform, firstPhoto);
  const words = megaWords(t, platform.slug, name);
  const accent = isPlatform(platform.accent) ? platform.accent : null;
  const columns: Column[] = (
    [
      { id: "devices", title: t("nav.devices"), links: plan.devices, all: plan.allDevices ? { label: words.allDevices, href: plan.allDevices } : null },
      { id: "games", title: t("nav.gamesColumn"), links: plan.games, all: plan.allGames ? { label: t("nav.allGames", { name }), href: plan.allGames } : null },
      { id: "accessories", title: t("nav.accessoriesColumn"), links: plan.accessories, all: null },
      { id: "cards", title: t("nav.cards"), links: plan.used ? [...plan.cards, { label: words.usedOf, href: plan.used.href, count: plan.used.count }] : plan.cards, all: null },
    ] satisfies Column[]
  ).filter((column) => column.links.length > 0 || column.all !== null);

  return (
    <div className="page shell-mega__inner">
      <div className="shell-mega__top">
        <p className="shell-mega__head">
          {accent ? (
            <span className="clay-disc shell-mega__badge" aria-hidden="true">
              <DeviceGlyph platform={accent} size={22} />
            </span>
          ) : null}
          <span className="shell-mega__platform">{name}</span>
          <span className="shell-mega__total">{t("nav.count", { count: platform.productCount })}</span>
        </p>
        {/* the full 44px key (the small one was 40) */}
        <Key as={LocaleLink} to={platform.href} iconEnd="arrow-right" className="shell-mega__all">
          {t("nav.all", { name })}
        </Key>
      </div>
      <div className="shell-mega__grid">
        {columns.length === 0 ? <p className="shell-mega__empty">{t("nav.empty")}</p> : null}
        {columns.map((column, index) => (
          <MegaColumn key={column.id} column={column} accent={accent} style={order(index)} />
        ))}
        {columns.length > 0 && columns.length < 4 ? <div style={{ gridColumn: `span ${4 - columns.length}` }} aria-hidden="true" /> : null}
        {feature ? <MegaFeatureCard feature={feature} style={order(columns.length)} /> : null}
      </div>
    </div>
  );
}

function MegaColumn({ column, accent, style }: { column: Column; accent: Platform | null; style: CSSProperties }) {
  const headingId = useId();
  const devices = column.id === "devices";
  return (
    <section aria-labelledby={headingId} className="shell-mega__col" style={style}>
      <h2 id={headingId} className="shell-mega__title">
        <span className="clay-disc shell-mega__kind" aria-hidden="true">
          {devices && accent ? <DeviceGlyph platform={accent} size={18} /> : <Icon name={COLUMN_ICON[column.id]} size={18} />}
        </span>
        {column.title}
      </h2>
      <ul className="shell-mega__list">
        {column.links.map((link) => (
          <li key={link.href}>
            <LocaleLink to={link.href} className={cx("shell-mega__link", link.art && "shell-mega__link--thumb")} title={link.full}>
              {link.art ? (
                // the device model's photo, only when the read layer sends one (`artKey`): the same glyph on every row
                // said nothing and pushed the short names («PS5 Digital (2020)») onto a second line
                <span className="shell-mega__thumb" aria-hidden="true">
                  <Art name={link.art} alt="" sizes="32px" />
                </span>
              ) : null}
              <span className="shell-mega__line">
                <span className="shell-mega__text">{link.label}</span>
                {link.qualifier ? <span className="shell-mega__meta">{link.qualifier}</span> : null}
              </span>
              {link.count !== null ? <MegaCount count={link.count} /> : null}
            </LocaleLink>
          </li>
        ))}
        {column.all ? (
          <li>
            <LocaleLink to={column.all.href} className="shell-mega__link shell-mega__link--all">
              <span className="shell-mega__line">
                <span className="shell-mega__text">{column.all.label}</span>
              </span>
              <Icon name="arrow-right" size={16} className="shell-mega__arrow" />
            </LocaleLink>
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/** A link's count: the figure in --ink-2 on screen; «، 38 منتجاً» for assistive technology (the figure alone says little). */
function MegaCount({ count }: { count: number }) {
  const t = useShellT();
  const f = useFormat();
  return (
    <span className="shell-mega__count">
      <span aria-hidden="true">{f.number(count)}</span>
      <VisuallyHidden>{` · ${t("nav.count", { count })}`}</VisuallyHidden>
    </span>
  );
}

/**
 * The featured product (§5.4, v2.1 note 6): a glass card — the photo on a lit well, the name, the qualifier on its own
 * meta line, the price (muted, with «نفد حالياً», when it is sold out; «قريباً» when it is not out yet) with
 * «سعر تجريبي» on a demo row, and a clay key «عرض المنتج». The whole card is one link; the key is its visual end.
 */
function MegaFeatureCard({ feature, style }: { feature: MegaFeature; style: CSSProperties }) {
  const t = useShellT();
  const card = useT("ui-card");
  const out = feature.stock === "out_of_stock";
  const soon = feature.stock === "preorder";
  // as a product card writes a name: a Latin name on an Arabic page is a left-to-right line at the page's start edge;
  // a name with Arabic in it keeps the page's direction, its Latin parts isolated
  const title = latinName(feature.label, useDir());
  return (
    <LocaleLink to={feature.href} className="surface lift shell-mega__feature" data-state={out ? "out" : soon ? "soon" : undefined} data-press="soft" style={style}>
      <span className="shell-mega__well">
        {/* the platform's colour light behind the product (the panel's data-gel) */}
        <span className="glow-layer" aria-hidden="true" />
        {feature.artKey ? (
          <Art name={feature.artKey} alt="" sizes="176px" />
        ) : feature.mediaKey ? (
          // an uploaded photo: contained in the square well (its own size is unknown here)
          <img src={mediaUrl(feature.mediaKey)} alt="" width={176} height={176} loading="lazy" decoding="async" />
        ) : (
          <Icon name="kind-console" size={32} />
        )}
      </span>
      <span className="shell-mega__name">
        <span dir={title.dir} className={cx("shell-mega__fname", title.className)}>
          <BidiText text={feature.label} />
        </span>
        {feature.qualifier ? <span className="shell-mega__meta">{feature.qualifier}</span> : null}
        {feature.priceIqd !== null ? (
          <span className="shell-mega__price">
            <SafePrice amountIqd={feature.priceIqd} size="md" as="span" approx="off" tone={out ? "muted" : undefined} />
            {feature.isDemo ? <DemoNote variant="tag" what="price" /> : null}
          </span>
        ) : null}
        {out || soon ? <span className="shell-mega__status">{card(out ? "outNow" : "soon")}</span> : null}
      </span>
      <span className="key key--secondary key--sm shell-mega__go" aria-hidden="true">
        <span className="key__cap">
          <span className="key__label">{t("nav.view")}</span>
          <Icon name="arrow-right" size={16} />
        </span>
      </span>
    </LocaleLink>
  );
}
