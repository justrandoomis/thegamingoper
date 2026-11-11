import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { dematerialize, materialize } from "~/motion";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { inheritSurface, OverlayHostContext, useOverlayRoot, usePresence, watchCloseRequests } from "./Dialog";
import { IconKey } from "./IconKey";

/**
 * Menu — a list of actions anchored to the key that opened it. Design System v2 §4.17: an OPAQUE paper popover
 * (--r-lg, the overlay shadow), 44px rows; it drops from its trigger with 8px of travel and opacity (`settle`, 220ms
 * in and 140ms out). The highlighted row has a --niche fill and an ink bar on its inline-start edge.
 *
 *   <Menu label={t("orderActions")} items={[
 *     { id: "edit", label: t("edit"), icon: "pencil-simple", onSelect: edit },
 *     { id: "open", kind: "link", label: t("openOrder"), icon: "arrow-square-out", href: `/admin/orders/${id}` },
 *     { id: "s1", kind: "separator" },
 *     { id: "archived", kind: "checkbox", label: t("showArchived"), checked, onCheckedChange: setChecked },
 *     { id: "delete", label: t("deleteOrder"), icon: "trash", tone: "danger", onSelect: () => setConfirm(true) },
 *   ]} />
 *
 *   A trigger of your own — spread the props on a key (or any button):
 *   <Menu label={t("sortBy")} trigger={(props) => <Key {...props} iconEnd="caret-down">{t("sortBy")}</Key>} items={…} />
 *
 * Behaviour (WAI-ARIA menu button): the trigger says `aria-haspopup="menu"` and `aria-expanded`. A pointer opens it
 * with focus on the menu, Enter / Space / ↓ open it on the first row, ↑ on the last. ↑ ↓ Home End move between
 * rows (focus follows the pointer too), typing jumps to the next row starting with those letters, Enter / Space
 * activate, Escape closes and returns focus to the trigger, Tab closes and moves on from the trigger, a press
 * outside closes it. Choosing an action closes it, returns focus to the trigger, then runs `onSelect` — so a dialog
 * it opens returns focus to the trigger as well. Checkbox rows stay open. Disabled rows stay focusable (so they are
 * found and read) but do nothing.
 *
 * Placement: below the trigger, its inline-start edge on the trigger's (`align="end"`: the inline-end edges); above
 * when there is more room there; kept 8px inside the viewport; it follows the trigger when the page scrolls.
 * Inside a sheet or dialog it renders into that layer.
 * Reduced motion: opacity only. Client only: nothing renders on the server.
 */

type ItemCommon = {
  id: string;
  /** What the row does, as a verb ("عدّل الطلب"). Also what typeahead matches. */
  label: string;
  disabled?: boolean;
};

export type MenuActionItem = ItemCommon & {
  kind?: "action";
  icon?: IconName;
  /** Short text at the inline end: a count or a keyboard shortcut. */
  hint?: string;
  /** "danger": a destructive action — red-ink words (DESIGN.md §9.15). It should open a ConfirmDialog. */
  tone?: "danger";
  onSelect: () => void;
};
export type MenuLinkItem = ItemCommon & { kind: "link"; icon?: IconName; hint?: string; href: string; external?: boolean };
export type MenuCheckboxItem = ItemCommon & { kind: "checkbox"; checked: boolean; onCheckedChange: (checked: boolean) => void };
export type MenuRadioItem = ItemCommon & { kind: "radio"; checked: boolean; onSelect: () => void };
export type MenuSeparator = { kind: "separator"; id: string };
export type MenuItem = MenuActionItem | MenuLinkItem | MenuCheckboxItem | MenuRadioItem | MenuSeparator;

/** Spread these on the element that opens the menu. */
export type MenuTriggerProps = {
  ref: (element: HTMLElement | null) => void;
  id: string;
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string | undefined;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
};

export type MenuProps = {
  /** Names the menu, and the default "⋯" trigger ("إجراءات الطلب"). */
  label: string;
  items: readonly MenuItem[];
  /** Your own trigger. Default: a round "⋯" key labelled `label`. */
  trigger?: (props: MenuTriggerProps) => ReactNode;
  /** "start" (default): the menu's inline-start edge meets the trigger's; "end": the inline-end edges. */
  align?: "start" | "end";
  /** A caption over the rows ("رتّب حسب"). */
  title?: ReactNode;
  /** Control the open state (optional). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/* ───────────────────────────── pure parts (tests/ui-overlays.test.ts) ───────────────────────────── */

export type MenuBox = { top: number; bottom: number; left: number; right: number };
export type MenuPlacement = { inlineStart: number; blockStart: number; maxHeight: number; above: boolean };

/**
 * Where a menu of `size` goes next to `anchor` inside `viewport` (all in CSS pixels, viewport coordinates).
 * Returns logical insets for a `position: fixed` element: `inlineStart` is measured from the left edge in LTR and
 * from the right edge in RTL.
 */
export function placeMenu(
  anchor: MenuBox,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { rtl: boolean; align: "start" | "end"; gap?: number; margin?: number },
): MenuPlacement {
  const gap = options.gap ?? 6;
  const margin = options.margin ?? 8;
  const roomBelow = viewport.height - margin - (anchor.bottom + gap);
  const roomAbove = anchor.top - gap - margin;
  const above = size.height > roomBelow && roomAbove > roomBelow;
  const maxHeight = Math.max(0, Math.floor(above ? roomAbove : roomBelow));
  const height = Math.min(size.height, maxHeight);
  const blockStart = above ? anchor.top - gap - height : anchor.bottom + gap;
  // The menu's left edge meets the trigger's left edge for start-aligned LTR and end-aligned RTL menus.
  const leftAligned = options.rtl ? options.align === "end" : options.align === "start";
  let x = leftAligned ? anchor.left : anchor.right - size.width;
  x = Math.min(Math.max(x, margin), Math.max(margin, viewport.width - margin - size.width));
  const inlineStart = options.rtl ? viewport.width - (x + size.width) : x;
  return { inlineStart: Math.round(inlineStart), blockStart: Math.round(blockStart), maxHeight, above };
}

/**
 * Typeahead: the index of the next row whose label starts with `query` (case-insensitive), or -1. Typing one letter
 * repeatedly cycles through the rows that start with it; a longer word may stay on the current row while it still
 * matches. `null` labels (separators) are skipped.
 */
export function typeaheadIndex(labels: readonly (string | null)[], current: number, query: string): number {
  const q = query.toLocaleLowerCase();
  if (q.trim() === "" || labels.length === 0) return -1;
  const chars = [...q];
  const single = chars.every((char) => char === chars[0]);
  const needle = single ? chars[0] : q;
  const start = single ? current + 1 : Math.max(current, 0);
  for (let i = 0; i < labels.length; i++) {
    const index = (((start + i) % labels.length) + labels.length) % labels.length;
    const label = labels[index];
    if (label !== null && label.trim().toLocaleLowerCase().startsWith(needle)) return index;
  }
  return -1;
}

/* ───────────────────────────── the component ───────────────────────────── */

type Entry = "first" | "last" | "menu";

export function Menu({ label, items, trigger, align = "start", title, open: openProp, onOpenChange, className }: MenuProps) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const triggerRef = useRef<HTMLElement | null>(null);
  const triggerId = useId();
  const menuId = useId();
  const [entry, setEntry] = useState<Entry>("menu");
  const [present, exited] = usePresence(open);

  const setOpen = (next: boolean) => {
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };
  const show = (how: Entry) => {
    setEntry(how);
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const triggerProps: MenuTriggerProps = {
    ref: (element) => {
      triggerRef.current = element;
    },
    id: triggerId,
    "aria-haspopup": "menu",
    "aria-expanded": open,
    "aria-controls": present ? menuId : undefined,
    onClick: (event) => {
      if (open) close(false);
      // A keyboard click (Enter / Space) has no pointer: open on the first row; a pointer opens on the menu itself.
      else show(event.detail === 0 ? "first" : "menu");
    },
    onKeyDown: (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      show(event.key === "ArrowDown" ? "first" : "last");
    },
  };

  return (
    <>
      {trigger ? trigger(triggerProps) : <IconKey icon="dots-three" label={label} {...triggerProps} />}
      {present ? (
        <MenuLayer
          id={menuId}
          triggerId={triggerId}
          items={items}
          align={align}
          title={title}
          className={className}
          anchor={triggerRef}
          entry={entry}
          leaving={!open}
          onExited={exited}
          onClose={close}
        />
      ) : null}
    </>
  );
}

type LayerProps = {
  id: string;
  triggerId: string;
  items: readonly MenuItem[];
  align: "start" | "end";
  title?: ReactNode;
  className?: string;
  anchor: RefObject<HTMLElement | null>;
  entry: Entry;
  leaving: boolean;
  onExited: () => void;
  onClose: (returnFocus: boolean) => void;
};

/** Inside a sheet or dialog: render into that layer; elsewhere into a root of its own at the end of <body>. */
function MenuLayer(props: LayerProps) {
  const host = useContext(OverlayHostContext);
  const root = useOverlayRoot(false, host === null);
  const target = host ?? root;
  return target ? <MenuPanel {...props} target={target} solid={host !== null} /> : null;
}

const ROW =
  "relative flex min-h-11 w-full cursor-pointer select-none items-center gap-3 rounded-sm px-3 py-1.5 text-start type-label text-ink outline-none admin:pointer-fine:min-h-9 " +
  // the highlighted row: a niche fill and an ink bar on its inline-start edge (DESIGN.md §10, command palette)
  "before:pointer-events-none before:absolute before:inset-y-2 before:start-0 before:w-[3px] before:rounded-full before:bg-ink before:opacity-0 focus:bg-niche focus:before:opacity-100 " +
  "aria-disabled:cursor-default aria-disabled:text-ink-3";

function MenuPanel({ target, solid, id, triggerId, items, align, title, className, anchor, entry, leaving, onExited, onClose }: LayerProps & { target: HTMLElement; solid: boolean }) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const typed = useRef({ text: "", at: -Infinity });
  const latest = useRef({ onClose, onExited, entry });
  useLayoutEffect(() => {
    latest.current = { onClose, onExited, entry };
  });

  // Placement: now (before the first paint), and again whenever the page scrolls or the window resizes.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    inheritSurface(anchor.current, element); // the admin's density (and a theme island) of the trigger
    let frame = 0;
    const measure = () => {
      frame = 0;
      const trigger = anchor.current;
      if (!trigger?.isConnected) return;
      const rtl = getComputedStyle(trigger).direction === "rtl";
      const viewport = { width: document.documentElement.clientWidth, height: window.innerHeight };
      setPlace(placeMenu(trigger.getBoundingClientRect(), { width: element.offsetWidth, height: element.scrollHeight }, viewport, { rtl, align }));
    };
    measure();
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
    };
  }, [anchor, align]);

  // In: focus (first row, last row or the menu itself), then drop from the trigger. Out: rise back, then unmount.
  const placed = place !== null;
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !placed) return;
    if (!leaving) {
      if (!element.contains(document.activeElement)) {
        const rows = rowsOf(element);
        const how = latest.current.entry;
        const first = how === "first" ? rows[0] : how === "last" ? rows[rows.length - 1] : null;
        (first ?? element).focus({ preventScroll: true });
      }
      void materialize(element, { from: anchor.current });
      return;
    }
    let cancelled = false;
    void dematerialize(element).then(() => {
      if (!cancelled) latest.current.onExited();
    });
    return () => {
      cancelled = true;
    };
  }, [placed, leaving, anchor]);

  // A press anywhere else closes it (focus goes where the press puts it); so does Android's back gesture.
  useEffect(() => {
    if (leaving) return;
    const onPointerDown = (event: PointerEvent) => {
      const node = event.target instanceof Node ? event.target : null;
      if (!node || panel.current?.contains(node) || anchor.current?.contains(node)) return;
      latest.current.onClose(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    const unwatch = watchCloseRequests(() => latest.current.onClose(true));
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      unwatch();
    };
  }, [leaving, anchor]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const element = panel.current;
    if (!element || leaving) return;
    const rows = rowsOf(element);
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const go = (next: number) => {
      event.preventDefault();
      rows[(next + rows.length) % rows.length]?.focus();
    };
    switch (event.key) {
      case "ArrowDown":
        return go(index + 1);
      case "ArrowUp":
        return go(index === -1 ? rows.length - 1 : index - 1);
      case "Home":
      case "PageUp":
        return go(0);
      case "End":
      case "PageDown":
        return go(rows.length - 1);
      case "Escape":
        event.preventDefault(); // a sheet or dialog underneath must not close too
        latest.current.onClose(true);
        return;
      case "Tab":
        // Focus goes back to the trigger now; the browser's own Tab then moves on from there.
        latest.current.onClose(true);
        return;
      case " ":
        if (event.target instanceof HTMLAnchorElement) {
          event.preventDefault();
          event.target.click();
        }
        return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const recent = event.timeStamp - typed.current.at < 500;
      const text = recent ? typed.current.text + event.key : event.key;
      typed.current = { text, at: event.timeStamp };
      const match = typeaheadIndex(
        rows.map((row) => row.dataset.menuLabel ?? null),
        index,
        text,
      );
      if (match >= 0) {
        event.preventDefault();
        rows[match].focus();
      }
    }
  };

  // Focus moved somewhere else entirely (a screen reader's cursor, a click into an iframe): close quietly.
  const onBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (!next || leaving) return;
    if (panel.current?.contains(next) || anchor.current?.contains(next)) return;
    latest.current.onClose(false);
  };

  const slot = items.some((item) => item.kind === "checkbox" || item.kind === "radio" || ((item.kind === undefined || item.kind === "action" || item.kind === "link") && item.icon));

  return createPortal(
    <div
      ref={panel}
      data-solid={solid ? "" : undefined}
      id={id}
      role="menu"
      aria-labelledby={triggerId}
      tabIndex={-1}
      inert={leaving || undefined}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      className={cx(
        // above fixed chrome (header, tab bar); inside a sheet or dialog it sits in that layer's stacking context
        "menu fixed z-[calc(var(--z-nav)+1)] flex min-w-[min(13.5rem,calc(100vw-16px))] max-w-[min(20rem,calc(100vw-16px))] flex-col overflow-y-auto overscroll-contain text-ink outline-none",
        className,
      )}
      style={
        place
          ? { insetInlineStart: place.inlineStart, insetBlockStart: place.blockStart, maxBlockSize: place.maxHeight }
          : { insetInlineStart: 0, insetBlockStart: 0, visibility: "hidden" }
      }
    >
      {title ? (
        <p className="px-3 pb-1 pt-1.5 type-caption text-ink-2" aria-hidden="true">
          {title}
        </p>
      ) : null}
      {items.map((item) =>
        item.kind === "separator" ? (
          <div key={item.id} role="separator" className="mx-2 my-1 h-px shrink-0 bg-line" />
        ) : (
          <MenuRow key={item.id} item={item} slot={slot} onClose={onClose} />
        ),
      )}
    </div>,
    target,
  );
}

function rowsOf(element: HTMLElement): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>("[data-menu-row]")];
}

function MenuRow({ item, slot, onClose }: { item: Exclude<MenuItem, MenuSeparator>; slot: boolean; onClose: (returnFocus: boolean) => void }) {
  const checkable = item.kind === "checkbox" || item.kind === "radio";
  const danger = (item.kind === undefined || item.kind === "action") && item.tone === "danger";
  const icon = item.kind === undefined || item.kind === "action" || item.kind === "link" ? item.icon : undefined;
  const hint = item.kind === undefined || item.kind === "action" || item.kind === "link" ? item.hint : undefined;
  const mark = checkable ? (item.checked ? <Icon name="check" size={18} /> : null) : icon ? <Icon name={icon} size={18} /> : null;

  const common = {
    "data-menu-row": "",
    "data-menu-label": item.label,
    tabIndex: -1,
    "aria-disabled": item.disabled || undefined,
    // focus follows the pointer, so the keyboard and the mouse always agree on the highlighted row
    onPointerMove: (event: ReactMouseEvent<HTMLElement>) => {
      if (document.activeElement !== event.currentTarget) event.currentTarget.focus({ preventScroll: true });
    },
    className: cx(ROW, danger && "text-danger"),
  };
  const content = (
    <>
      {slot ? (
        <span className="grid size-5 shrink-0 place-items-center" aria-hidden="true">
          {mark}
        </span>
      ) : null}
      <span className="min-w-0 flex-1">
        <BidiLabel>{item.label}</BidiLabel>
      </span>
      {hint ? (
        <span className="shrink-0 type-caption text-ink-2 nums" aria-hidden="true">
          <BidiLabel>{hint}</BidiLabel>
        </span>
      ) : null}
    </>
  );

  if (item.kind === "link") {
    return (
      <LocaleLink
        {...common}
        role="menuitem"
        to={item.href}
        target={item.external ? "_blank" : undefined}
        rel={item.external ? "noopener noreferrer" : undefined}
        onClick={(event) => {
          if (item.disabled) {
            event.preventDefault();
            return;
          }
          onClose(true);
        }}
      >
        {content}
      </LocaleLink>
    );
  }
  if (item.kind === "checkbox") {
    return (
      <button {...common} type="button" role="menuitemcheckbox" aria-checked={item.checked} onClick={() => !item.disabled && item.onCheckedChange(!item.checked)}>
        {content}
      </button>
    );
  }
  return (
    <button
      {...common}
      type="button"
      role={item.kind === "radio" ? "menuitemradio" : "menuitem"}
      aria-checked={item.kind === "radio" ? item.checked : undefined}
      onClick={() => {
        if (item.disabled) return;
        onClose(true);
        item.onSelect();
      }}
    >
      {content}
    </button>
  );
}
