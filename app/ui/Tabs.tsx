import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";

import { useFormat } from "~/i18n/react";
import { getMotionTier, springTiming, travel } from "~/motion";
import { cx } from "./cx";
import { useSlidingIndicator } from "./indicator";
import { HrefLink } from "./Pagination";
import { revealFocusedItem, useKeepInView } from "./reveal";
import { useControllable } from "./roving";

/**
 * Tabs — sibling views of one thing (a device hub's guides / accessories / repairs; an order's lines / payments /
 * history). Flat, like the tab bar: the label turns ink and heavier and an ink marker sits on the bottom edge; never
 * red, never clay (tabs navigate, they do not commit). v2.1: ONE underline slides from the old tab to the new one
 * (translate only, ./indicator); before it is measured each tab draws its own. Two kinds:
 *
 *   Link tabs — each tab is a page or a query (the URL holds the state; Back works):
 *   <Tabs aria-label={t("hub")} value={tab} items={[
 *     { value: "guides", label: t("guides"), href: "?tab=guides" },
 *     { value: "parts", label: t("parts"), count: 12, href: "?tab=parts" },
 *   ]} />
 *   → <nav> of links, the current one `aria-current="page"`. Give the route a handle
 *     `{ nav: "push", order: ({ search }) => … }` for the sideways push between them (docs/MOTION.md).
 *
 *   Panel tabs — the content is already on the page:
 *   <Tabs aria-label={t("details")} defaultValue="specs" items={[
 *     { value: "specs", label: t("specs"), content: <SpecList … /> },
 *     { value: "box", label: t("inTheBox"), content: <BoxList … /> },
 *   ]} />
 *   → WAI-ARIA tabs: one tab stop, ← → follow the reading direction, Home / End, selection follows focus
 *     (`activation="manual"`: Enter / Space choose). The new panel slides 24px in from the side it comes from
 *     (next = from the inline end, DESIGN.md §7.2 "sideways push") — reduced motion: a 120ms fade.
 *
 * Long rows scroll sideways, and the current tab is kept in view — on the first paint (a link tab opened from far down
 * the row) and whenever the choice or the focus moves. Labels keep their width when they turn bold, so nothing shifts.
 *
 * v2.1 fix round (client note 9: the before's section tabs read larger and firmer): labels are 15px Plex 500, the chosen
 * one 600, on a 44px row with the before's 3px underline; `size="lg"` — a page's own section tabs (the support pages) —
 * 16px on a 48px row. The admin keeps its dense 12px rows (tokens.css, [data-density="admin"]).
 *
 *   <Tabs size="lg" section aria-label=… value="help" items=[…] />   a guide inside «مركز المساعدة»: aria-current="true"
 */
export type TabItem = {
  value: string;
  label: ReactNode;
  /** A count after the label (tabular), e.g. orders waiting. */
  count?: number;
  disabled?: boolean;
  /** Link tabs: a locale-less path or a query on this page ("?tab=parts"). */
  href?: string;
  /** Panel tabs: what the tab shows. */
  content?: ReactNode;
};

export type TabsProps = {
  items: readonly TabItem[];
  /** The selected tab (link tabs: the current page's). */
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Panel tabs: "auto" (default) selects on focus; "manual" waits for Enter / Space. */
  activation?: "auto" | "manual";
  /** Panel tabs: keep every panel mounted (hidden) instead of only the selected one. */
  keepMounted?: boolean;
  /** "md" (default): 15px labels on a 44px row. "lg": a page's own section tabs — 16px on a 48px row. */
  size?: "md" | "lg";
  /** Link tabs: the page belongs to the chosen tab's part of the site but is not the tab's own page (a guide inside
   *  «مركز المساعدة»): the chosen tab says aria-current="true" instead of "page". */
  section?: boolean;
  className?: string;
  listClassName?: string;
  panelClassName?: string;
};

const LIST = "group/tabs relative flex min-w-0 gap-1 not-admin:max-md:gap-0 overflow-x-auto border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const TAB =
  "group relative inline-flex min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap px-3 not-admin:px-2.5 text-ink-2 outline-offset-[-3px] hover:text-ink " +
  "data-[selected]:text-ink aria-disabled:cursor-default aria-disabled:text-ink-3 " +
  // the marker (v2 §4.6; v2.1: the before's 3px): an ink underline on the bottom edge, faded in (opacity only)
  "after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-(--tab-ind) after:rounded-full after:bg-ink after:opacity-0 after:transition-opacity after:duration-(--t-micro) data-[selected]:after:opacity-100 " +
  // v2.1: once the list's sliding underline is measured, the tab's own marker steps aside
  "group-data-[ind]/tabs:after:hidden";
/** The label's role and the row's height per size (tokens.css --type-tab-label*: the admin keeps its dense rows). */
const TAB_SIZE = { md: "min-h-11 [font:var(--type-tab-label)]", lg: "min-h-12 [font:var(--type-tab-label-lg)]" } as const;
/** The sliding underline sits inside the tab's padding (10px in the storefront, 12 in the admin), like its own marker. */
const IND = { selector: "[data-selected]", attribute: "data-ind", x: "--ind-x", w: "--ind-w", inset: 10 } as const;

export function Tabs({
  items,
  value,
  defaultValue,
  onChange,
  activation = "auto",
  keepMounted = false,
  size = "md",
  section = false,
  className,
  listClassName,
  panelClassName,
  ...aria
}: TabsProps) {
  const tab = cx(TAB, TAB_SIZE[size]);
  const firstEnabled = items.find((item) => !item.disabled)?.value ?? "";
  const [current, setCurrent] = useControllable<string>(value, defaultValue ?? firstEnabled, onChange);
  const linkTabs = items.length > 0 && items.every((item) => typeof item.href === "string");
  const linkList = useRef<HTMLUListElement | null>(null);
  useCurrentInView(linkList, linkTabs ? current : null);
  useSlidingIndicator(linkList, linkTabs ? current : null, IND);

  if (linkTabs) {
    return (
      <nav aria-label={aria["aria-label"]} aria-labelledby={aria["aria-labelledby"]} className={cx("min-w-0", className)}>
        <ul ref={linkList} role="list" className={cx(LIST, listClassName)} onFocus={revealFocused}>
          <li className="tabs__ind" aria-hidden="true" />
          {items.map((item) => {
            const selected = item.value === current;
            return (
              <li key={item.value} className="flex">
                <HrefLink
                  to={item.href as string}
                  className={tab}
                  data-selected={selected ? "" : undefined}
                  aria-current={selected ? (section ? "true" : "page") : undefined}
                  aria-disabled={item.disabled || undefined}
                  onClick={(event) => {
                    if (item.disabled) event.preventDefault();
                  }}
                >
                  <TabLabel item={item} />
                </HrefLink>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }
  return (
    <PanelTabs
      items={items}
      current={current}
      choose={setCurrent}
      activation={activation}
      keepMounted={keepMounted}
      tabClassName={tab}
      className={className}
      listClassName={listClassName}
      panelClassName={panelClassName}
      aria={aria}
    />
  );
}

function PanelTabs({
  items,
  current,
  choose,
  activation,
  keepMounted,
  tabClassName,
  className,
  listClassName,
  panelClassName,
  aria,
}: {
  items: readonly TabItem[];
  current: string;
  choose: (value: string) => void;
  activation: "auto" | "manual";
  keepMounted: boolean;
  tabClassName: string;
  className?: string;
  listClassName?: string;
  panelClassName?: string;
  aria: { "aria-label"?: string; "aria-labelledby"?: string };
}) {
  const id = useId();
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const list = useRef<HTMLDivElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const selected = items.findIndex((item) => item.value === current);
  useCurrentInView(list, current);
  useSlidingIndicator(list, current, IND);
  const firstEnabled = items.findIndex((item) => !item.disabled);
  // Roving tab stop: the focused tab while focus is in the list, else the selected one.
  const [focused, setFocused] = useState<number | null>(null);
  const stop = focused ?? (selected >= 0 && !items[selected].disabled ? selected : firstEnabled);

  const step = (from: number, delta: 1 | -1) => {
    for (let i = 1; i <= items.length; i++) {
      const next = (((from + delta * i) % items.length) + items.length) % items.length;
      if (!items[next].disabled) return next;
    }
    return from;
  };
  const focusTab = (index: number) => {
    setFocused(index);
    tabs.current[index]?.focus();
    if (activation === "auto" && items[index].value !== current) choose(items[index].value);
  };
  const onKeyDown = (index: number) => (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    let next: number | null = null;
    if (event.key === "ArrowRight") next = step(index, rtl ? -1 : 1);
    else if (event.key === "ArrowLeft") next = step(index, rtl ? 1 : -1);
    else if (event.key === "Home") next = firstEnabled;
    else if (event.key === "End") next = step(0, -1);
    if (next === null || next < 0) return;
    event.preventDefault();
    focusTab(next);
  };

  // Sideways push: the new panel comes in from the side of the tab that was chosen.
  const previous = useRef(selected);
  useLayoutEffect(() => {
    const from = previous.current;
    previous.current = selected;
    const element = panel.current;
    if (!element || from === selected || from < 0 || selected < 0) return;
    if (getMotionTier() === "reduced") {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: "linear" });
      return;
    }
    const rtl = getComputedStyle(element).direction === "rtl";
    const x = (selected > from ? 1 : -1) * (rtl ? -1 : 1) * travel.push;
    element.animate([{ opacity: 0, translate: `${x}px 0` }, { opacity: 1, translate: "0 0" }], springTiming("settle"));
  }, [selected]);

  return (
    <div className={cx("grid min-w-0 gap-4", className)}>
      <div
        ref={list}
        role="tablist"
        aria-label={aria["aria-label"]}
        aria-labelledby={aria["aria-labelledby"]}
        className={cx(LIST, listClassName)}
        onFocus={revealFocused}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(null);
        }}
      >
        <span className="tabs__ind" aria-hidden="true" />
        {items.map((item, index) => {
          const isSelected = index === selected;
          return (
            <button
              key={item.value}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${index}`}
              aria-selected={isSelected}
              aria-controls={isSelected || keepMounted ? `${id}-panel-${index}` : undefined}
              aria-disabled={item.disabled || undefined}
              tabIndex={index === stop ? 0 : -1}
              data-selected={isSelected ? "" : undefined}
              className={tabClassName}
              onKeyDown={onKeyDown(index)}
              onFocus={() => setFocused(index)}
              onClick={() => {
                if (item.disabled) return;
                setFocused(index);
                if (!isSelected) choose(item.value);
              }}
            >
              <TabLabel item={item} />
            </button>
          );
        })}
      </div>
      {items.map((item, index) => {
        const isSelected = index === selected;
        if (!isSelected && !keepMounted) return null;
        return (
          <div
            key={item.value}
            ref={isSelected ? panel : undefined}
            role="tabpanel"
            id={`${id}-panel-${index}`}
            aria-labelledby={`${id}-tab-${index}`}
            tabIndex={0}
            hidden={!isSelected}
            className={cx("min-w-0 rounded-sm outline-offset-2", panelClassName)}
          >
            {item.content}
          </div>
        );
      })}
    </div>
  );
}

/** Keep the current tab ([data-selected]) fully inside the row that scrolls sideways (./reveal useKeepInView). */
function useCurrentInView(row: RefObject<HTMLElement | null>, current: string | null) {
  useKeepInView(row, "[data-selected]", current);
}

/** A tab that takes the keyboard focus (Tab, the arrow keys) scrolls fully into the row — the row only, never the page. */
const revealFocused = revealFocusedItem;

/** The label twice in one grid cell: the bold copy (invisible) reserves the width, so turning bold moves nothing. */
function TabLabel({ item }: { item: TabItem }) {
  const f = useFormat();
  return (
    <>
      <span className="grid">
        <span className="invisible col-start-1 row-start-1 font-semibold" aria-hidden="true">
          {item.label}
        </span>
        <span className="col-start-1 row-start-1 group-data-[selected]:font-semibold">{item.label}</span>
      </span>
      {typeof item.count === "number" ? (
        <span className="rounded-full bg-niche px-1.5 type-caption text-ink-2 nums">
          <bdi>{f.number(item.count)}</bdi>
        </span>
      ) : null}
    </>
  );
}
