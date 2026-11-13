/**
 * Search (Design System v2 §5.5): a GET form to /search (works without script; with script React Router navigates)
 * with an opaque suggestions panel, in three places:
 *
 *   <SearchForm variant="header" />   the desktop header's 44px pill (from 1024): 320 wide, 560 from 1280 with the "/"
 *                                     shortcut chip ("/" anywhere outside a field focuses it); suggestions 420 wide under it.
 *                                     It is also the 404's one search field (./ShellError focuses it on desktop).
 *   <SearchSheet open onClose />      phones and tablets: the header's pill opens this full-screen sheet with the field at
 *                                     the top (focused) and the suggestions as a full-width list; the platforms under it
 *   <SearchForm variant="panel" />    a page's own field (the catalog's /search start page)
 *
 * `query`: the words the field starts with off the search page (a missing product's slug words on its 404); on /search
 * the field follows `?q=`.
 *
 * Suggestions — rows by what they point at (the href says it): products with a 44px thumbnail on the product ground,
 * the name (two lines at most, isolated), ONE meta line under it — the qualifier the Latin title leaves out («نسخة
 * الأقراص»), then the kind label («جهاز PS5»), else the department (./chrome suggestionMeta) — and the price; typed rows
 * with icons for a platform (its dot), a department, «كل شيء عن الجهاز» and the used list; «هل تقصد …؟» for a typo;
 * the last row «اعرض كل النتائج». Words the store has nothing for (the endpoint answers `total: 0`): one row «لا
 * اقتراحات لـ «…»» · «ابحث في كل المتجر», which searches anyway — the list never just stays shut. In demo mode a list
 * with prices says «الأسعار تجريبية» on its head (the phone sheet covers the demo strip). With an empty field: the
 * shopper's recent searches (kept on this device, only with consent — catalog area's recent-searches) with «امسح»
 * (`openOnFocus={false}`: only once the shopper types or presses ↓ — a field focused for them, as on the 404).
 * Keyboard: ↑ ↓ move (the active row has a --niche fill and an ink start bar), Enter opens it (or searches), Escape
 * closes the list. The form is a search landmark named «ابحث في المتجر» (`aria-label` names a page's own field).
 *
 * SUGGESTIONS CONTRACT (catalog area, CONTRACTS.md §2 `GET /api/search/suggest`):
 *   GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>
 *   200 { suggestions: { label, href, hint?, image?, priceIqd?, kindLabel?, qualifier? }[], total? }   href locale-less
 *   `image` (an art key "<slug>--<n>"), `priceIqd` (integer IQD; left out while the product is sold out), `kindLabel`
 *   («جهاز PS5»), `qualifier` («نسخة الأقراص» — the catalogue's words the Latin title leaves out; printed on the meta
 *   line, never inside the name) and `total` (the result count for «اعرض كل النتائج (42)») are optional: rows show them
 *   when they come.
 *   The first 404 switches suggestions off for the rest of the visit (nothing is invented, nothing retried). Typing is
 *   debounced (160 ms) and a newer request aborts the older one.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Form, useLocation, useNavigate, useRouteLoaderData, useSearchParams } from "react-router";

import { Art } from "~/art/Art";
import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useLocale, useLocalePath } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { useRecentSearches } from "~/routes/storefront/catalog/components/recent-searches";
import { cx } from "~/ui/cx";
import { DemoNote } from "~/ui/DemoNote";
import { Glass } from "~/ui/Glass";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { Sheet } from "~/ui/Sheet";
import { suggestionKind, suggestionMeta, suggestionState, type SuggestionKind } from "./chrome";
import { useShellT } from "./i18n";
import { DeviceGlyph, usePlatformName } from "./MegaMenu";
import type { NavPlatform } from "./types";

export type SearchSuggestion = {
  label: string;
  href: string;
  hint?: string;
  /** Optional: an art key ("<slug>--<n>") for the product's thumbnail. */
  image?: string;
  /** Optional: the product's price, integer IQD. */
  priceIqd?: number;
  /** Optional: the product's kind («جهاز PS5»), shown in place of the department hint. */
  kindLabel?: string;
  /** Optional: the words the product's Latin title leaves out («نسخة الأقراص»), first on the meta line. */
  qualifier?: string;
};

const SUGGEST_URL = "/api/search/suggest";
const MIN_CHARS = 2;
const DEBOUNCE_MS = 160;
const MAX_ROWS = 8;
/** Set when the endpoint answered 404 (not built yet): suggestions stay off until the next page load. */
let suggestUnavailable = false;

function isSuggestion(value: unknown): value is SearchSuggestion {
  const item = value as SearchSuggestion | null;
  return (
    !!item &&
    typeof item.label === "string" &&
    item.label.length > 0 &&
    typeof item.href === "string" &&
    /^\/(?!\/)/.test(item.href) &&
    (item.hint === undefined || typeof item.hint === "string") &&
    (item.image === undefined || typeof item.image === "string") &&
    (item.kindLabel === undefined || typeof item.kindLabel === "string") &&
    (item.qualifier === undefined || typeof item.qualifier === "string") &&
    (item.priceIqd === undefined || (Number.isSafeInteger(item.priceIqd) && item.priceIqd >= 0))
  );
}

/** The endpoint's answer, and the words (trimmed) it answers — null until one came for them. */
type SuggestResult = { items: SearchSuggestion[]; total: number | null; q: string | null };
const NONE: SuggestResult = { items: [], total: null, q: null };

function useSuggestions(query: string, enabled: boolean): SuggestResult {
  const locale = useLocale();
  const [result, setResult] = useState<SuggestResult>(NONE);
  useEffect(() => {
    const q = query.trim();
    if (!enabled || suggestUnavailable || q.length < MIN_CHARS) {
      setResult(NONE);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${SUGGEST_URL}?${new URLSearchParams({ q, locale })}`, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (response.status === 404) {
          suggestUnavailable = true;
          setResult(NONE);
          return;
        }
        if (!response.ok) return setResult(NONE);
        const body = (await response.json()) as { suggestions?: unknown; total?: unknown };
        const items = Array.isArray(body.suggestions) ? body.suggestions.filter(isSuggestion).slice(0, MAX_ROWS) : [];
        const total = typeof body.total === "number" && Number.isSafeInteger(body.total) && body.total >= 0 ? body.total : null;
        setResult({ items, total, q });
      } catch {
        if (!controller.signal.aborted) setResult(NONE);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, locale]);
  return result;
}

/** One option of the list, in the order the arrows walk them. `none`: nothing for these words — it searches anyway. */
type Option = { kind: "suggestion"; item: SearchSuggestion } | { kind: "all" } | { kind: "none" } | { kind: "recent"; q: string };

/** First-strong isolate and its end around the shopper's words inside a sentence («لا اقتراحات لـ «fridge»»). */
const FSI = "⁨";
const PDI = "⁩";

type RootStoreData = { storeMode?: "demo" | "live" };

const KIND_ICON: Record<Exclude<SuggestionKind, "product" | "platform">, IconName> = {
  category: "squares-four",
  device: "game-controller",
  used: "recycle",
  correction: "magnifying-glass",
  other: "link",
};

export type SearchFormProps = {
  /** header: the desktop pill (hidden below 1024) · sheet: inside the phone search sheet · panel: a page's field. */
  variant?: "header" | "sheet" | "panel";
  /** The words the field starts with off the search page (on /search it follows `?q=`). */
  query?: string;
  className?: string;
  /** Focus the field when it mounts. */
  autoFocus?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  /** A search or a suggestion is leaving for its page (the sheet closes). */
  onDone?: () => void;
  /**
   * Whether focusing the empty field opens the recent searches (default true). false for a field focused FOR the
   * shopper (the 404's): the list then waits for typing or ↓, and never opens over the page's keys by itself.
   */
  openOnFocus?: boolean;
  /**
   * The search landmark's name. Default «ابحث في المتجر» for the header's field and the sheet's; a page's own field
   * (`panel`) has none unless given — on /search the header's field is there too, and two landmarks with one name are
   * one too many.
   */
  "aria-label"?: string;
};

export function SearchForm({ variant = "panel", query: initial, className, autoFocus = false, inputRef, onDone, openOnFocus = true, "aria-label": label }: SearchFormProps) {
  const t = useShellT();
  const href = useLocalePath();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const recent = useRecentSearches();
  const root = useRouteLoaderData("root") as RootStoreData | undefined;
  const demo = root?.storeMode !== "live";
  const onSearchPage = splitLocale(location.pathname).path === "/search";
  const current = onSearchPage ? (params.get("q") ?? "") : (initial ?? "");

  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState(current);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // the sheet keeps its list while the keyboard is down (a scroll blurs the field); elsewhere only while focused
  const answer = useSuggestions(query, focused || variant === "sheet");
  const { items, total } = answer;
  const typing = query.trim().length >= MIN_CHARS;
  const state = typing ? suggestionState({ q: answer.q, rows: items.length, total }, query) : "wait";

  const options: Option[] = typing
    ? state === "rows"
      ? [...items.map((item) => ({ kind: "suggestion" as const, item })), { kind: "all" as const }]
      : state === "count"
        ? [{ kind: "all" as const }]
        : state === "none"
          ? [{ kind: "none" as const }]
          : []
    : recent.items.map((entry) => ({ kind: "recent" as const, q: entry.q }));
  // the sheet shows its list whenever there is one; the header and the panel while the field has focus
  const showList = options.length > 0 && (variant === "sheet" || (open && focused));
  // demo mode: the prices in the list are the demo catalogue's — said on the list's head (the phone sheet covers the
  // demo strip; the store's demo marking is a strip, a chip and the footer, never every price)
  const demoPrices = demo && state === "rows" && items.some((item) => item.priceIqd !== undefined && suggestionKind(item.href) === "product");

  // the field follows the URL (a new search, Back) unless the shopper is typing in it
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    if (!focused) setQuery(current);
  }
  useEffect(() => setActive(-1), [items, typing]);

  // the header's field keeps the page still when it takes focus (holdScroll)
  useEffect(() => {
    if (variant === "header") trackScroll();
  }, [variant]);

  // "/" anywhere outside a field focuses the desktop header's field
  useEffect(() => {
    if (variant !== "header") return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const field = input.current;
      if (!field || field.offsetParent === null) return;
      event.preventDefault();
      // the field is in the sticky header, always in view: the page stays where it is
      field.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [variant]);

  const leave = (to: string) => {
    setOpen(false);
    input.current?.blur();
    onDone?.();
    void navigate(href(to));
  };
  const searchFor = (q: string) => leave(`/search?${new URLSearchParams({ q })}`);
  const choose = (option: Option) => {
    if (option.kind === "suggestion") leave(option.item.href);
    else if (option.kind === "recent") searchFor(option.q);
    // «اعرض كل النتائج» and «لا اقتراحات … ابحث في كل المتجر»: the search page for the words
    else searchFor(query.trim());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (showList && variant !== "sheet") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (!showList) {
      if (event.key === "ArrowDown" && options.length > 0) setOpen(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // -1 is the field itself: the highlight wraps field → first … last → field
      setActive((index) => {
        const next = index + step;
        if (next < -1) return options.length - 1;
        if (next >= options.length) return -1;
        return next;
      });
    } else if (event.key === "Enter" && active >= 0 && options[active]) {
      event.preventDefault();
      choose(options[active]);
    }
  };

  const setInput = (element: HTMLInputElement | null) => {
    input.current = element;
    if (typeof inputRef === "function") inputRef(element);
    else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = element;
  };

  return (
    <Form
      method="get"
      action={href("/search")}
      role="search"
      aria-label={label ?? (variant === "panel" ? undefined : t("search.label"))}
      className={cx("shell-search", className)}
      data-variant={variant}
      onSubmit={() => {
        setOpen(false);
        onDone?.();
      }}
    >
      <label htmlFor={id} className="sr-only">
        {t("search.label")}
      </label>
      <div className="shell-search__field">
        <button type="submit" className="shell-search__submit" aria-label={t("search.submit")}>
          <Icon name="magnifying-glass" size={20} />
        </button>
        <input
          ref={setInput}
          id={id}
          type="search"
          name="q"
          className="shell-search__input"
          placeholder={t("search.placeholder")}
          autoComplete="off"
          enterKeyHint="search"
          maxLength={120}
          autoFocus={autoFocus}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(openOnFocus);
            if (variant === "header") holdScroll();
          }}
          onBlur={() => setFocused(false)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
        />
        {variant === "header" ? (
          <kbd className="kbd shell-search__kbd" title={t("search.shortcut")} aria-hidden="true">
            /
          </kbd>
        ) : null}
      </div>
      <SuggestPanel glass={variant === "header"} hidden={!showList}>
        {/* the head: «اقتراحات» (and «الأسعار تجريبية» in demo mode) or the recent searches with «امسح»; none over the
            one row that says nothing matched */}
        {showList && state !== "none" ? (
          <p className="shell-suggest__head">
            <span>{typing ? t("search.head") : t("search.recent")}</span>
            {demoPrices ? <DemoNote variant="tag">{t("search.demoPrices")}</DemoNote> : null}
            {!typing ? (
              <button
                type="button"
                className="shell-suggest__clear"
                aria-label={t("search.clearLabel")}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  recent.clear();
                  input.current?.focus();
                }}
              >
                {t("search.clear")}
              </button>
            ) : null}
          </p>
        ) : null}
        <ul id={listId} role="listbox" aria-label={t("search.suggestions")} className="shell-suggest__list">
          {showList
            ? options.map((option, index) => (
                <li
                  key={option.kind === "suggestion" ? `s:${option.item.href}:${index}` : option.kind === "recent" ? `r:${option.q}` : option.kind}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={cx(option.kind === "all" ? "shell-suggest__all" : "shell-suggest__row", option.kind !== "all" && !isProductRow(option) && "shell-suggest__row--short")}
                  // keep focus in the field while choosing with a pointer
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <OptionBody option={option} total={total} query={query} />
                </li>
              ))
            : null}
        </ul>
      </SuggestPanel>
    </Form>
  );
}

/**
 * The header's field sits in the sticky header, in view whatever the scroll, so focusing it never moves the page. Its
 * scroll box is kept clear by shell.css (scroll-margin), but a text field's focus ALSO reveals its caret, and that
 * reveal counts the root's scroll padding and not the field's margin: Shift+Tab from the content reaching the field
 * scrolled the page ~470px up (QA 2026-11-13) — before the focus event even fires. So the page's position as of its
 * last scroll event is kept (`settledY`), and on focus the page goes back there, before the next paint: it never shows.
 */
let settledY = 0;
let trackingScroll = false;
function trackScroll() {
  if (trackingScroll) return;
  trackingScroll = true;
  settledY = window.scrollY;
  window.addEventListener("scroll", () => (settledY = window.scrollY), { passive: true });
}
function holdScroll() {
  if (!trackingScroll) return;
  const y = settledY;
  // only ever undoes that reveal: an UPWARD jump (a field in the top band is revealed by scrolling up)
  const back = () => {
    if (y - window.scrollY >= 1) window.scrollTo({ top: y, behavior: "instant" });
  };
  back();
  // a reveal that comes after the focus event: undone in the same frame
  requestAnimationFrame(back);
}

/**
 * The suggestions' panel: frosted glass under the header's field (v2.1 G3 — the header's frost and this one are the two
 * live panes of a desktop viewport); opaque paper under a page's own field (a phone's tab bar and header are already
 * glass); a plain list inside the search sheet.
 */
function SuggestPanel({ glass, hidden, children }: { glass: boolean; hidden: boolean; children: ReactNode }) {
  return glass ? (
    <Glass className="shell-suggest glass--panel" hidden={hidden}>
      {children}
    </Glass>
  ) : (
    <div className="shell-suggest" hidden={hidden}>
      {children}
    </div>
  );
}

function isProductRow(option: Option): boolean {
  return option.kind === "suggestion" && suggestionKind(option.item.href) === "product";
}

function OptionBody({ option, total, query }: { option: Option; total: number | null; query: string }) {
  const t = useShellT();
  if (option.kind === "none") {
    // nothing for these words: say so, and search the whole store anyway (Enter, a tap)
    return (
      <>
        <Icon name="magnifying-glass" size={20} className="text-ink-2" />
        <span className="shell-suggest__text">
          <span className="shell-suggest__name">
            <span className="shell-suggest__label">{t("search.none", { q: `${FSI}${query.trim()}${PDI}` })}</span>
          </span>
          <span className="shell-suggest__hint">{t("search.noneHint")}</span>
        </span>
        <Icon name="arrow-right" size={16} className="shell-suggest__end" />
      </>
    );
  }
  if (option.kind === "all") {
    return (
      <>
        <span>{total !== null ? `${t("search.all")} (${total})` : t("search.all")}</span>
        <Icon name="arrow-right" size={16} />
      </>
    );
  }
  if (option.kind === "recent") {
    return (
      <>
        <Icon name="clock" size={20} className="text-ink-2" />
        <span className="shell-suggest__text">
          <span className="shell-suggest__name">
            <span className="shell-suggest__label">{option.q}</span>
          </span>
        </span>
        <Icon name="arrow-u-up-left" size={16} className="shell-suggest__end" />
      </>
    );
  }
  const { item } = option;
  const kind = suggestionKind(item.href);
  if (kind === "product") {
    // one meta line (v2 §5.5): the qualifier, then the kind («جهاز PS5», which says more than the department; the
    // department when it is missing) — never inside the Latin name
    const hint = suggestionMeta(item);
    return (
      <>
        <span className="shell-suggest__thumb" aria-hidden="true">
          {item.image ? <Art name={item.image} alt="" sizes="44px" /> : <Icon name="package" size={20} />}
        </span>
        <span className="shell-suggest__text">
          <span className="shell-suggest__name">
            <span className="shell-suggest__label">{item.label}</span>
          </span>
          {hint ? <span className="shell-suggest__hint">{hint}</span> : null}
        </span>
        {item.priceIqd !== undefined ? <Price amountIqd={item.priceIqd} size="sm" approx="off" as="span" /> : <span />}
      </>
    );
  }
  const platformSlug = kind === "platform" ? item.href.slice("/platform/".length).split(/[/?#]/)[0] : "";
  return (
    <>
      {kind === "platform" ? (
        <span className="grid place-items-center" data-gel={isPlatform(platformSlug) ? platformSlug : undefined} aria-hidden="true">
          <PlatformLed />
        </span>
      ) : (
        <Icon name={KIND_ICON[kind]} size={20} className="text-ink-2" />
      )}
      <span className="shell-suggest__text">
        <span className="shell-suggest__name">
          <span className="shell-suggest__label">{kind === "correction" ? t("search.didYouMean", { q: item.label }) : item.label}</span>
        </span>
        {kind !== "correction" ? <span className="shell-suggest__hint">{item.hint ?? t(`search.kind.${kind}`)}</span> : null}
      </span>
      <Icon name="arrow-right" size={16} className="shell-suggest__end" />
    </>
  );
}

export type SearchSheetProps = {
  open: boolean;
  onClose: () => void;
  platforms: NavPlatform[];
  /** The words the field starts with (a missing product's slug words on its 404). */
  query?: string;
};

/** Phones and tablets: the full-screen search sheet (the field at the top, focused; the platforms under it). */
export function SearchSheet({ open, onClose, platforms, query }: SearchSheetProps) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <Sheet open={open} onClose={onClose} title={t("search.label")} initialFocus={() => input.current} className="max-md:h-dvh! max-md:max-h-dvh!">
      <SearchForm variant="sheet" query={query} inputRef={input} onDone={onClose} />
      {platforms.length > 0 ? (
        <nav aria-labelledby="shell-search-browse" className="shell-search-sheet__browse">
          <h2 id="shell-search-browse" className="shell-csheet__head">
            {t("search.browse")}
          </h2>
          <ul className="shell-csheet__rows">
            {platforms.map((platform) => (
              <li key={platform.slug} data-gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                <LocaleLink to={platform.href} className="shell-row" onClick={onClose}>
                  {isPlatform(platform.accent) ? (
                    // the platform's device glyph in its colour light, as in the desktop nav row
                    <span className="shell-navitem__glyph" aria-hidden="true">
                      <DeviceGlyph platform={platform.accent} size={18} />
                    </span>
                  ) : null}
                  <span className="shell-row__text">{nameOf(platform)}</span>
                  <Icon name="caret-right" size={16} className="shell-row__end" />
                </LocaleLink>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </Sheet>
  );
}
