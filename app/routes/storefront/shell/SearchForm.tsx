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
 * the name (two lines at most, isolated), the kind label («جهاز PS5») — else the department — and the price; typed rows
 * with icons for a platform (its dot), a department, «كل شيء عن الجهاز» and the used list; «هل تقصد …؟» for a typo;
 * the last row «اعرض كل النتائج». With an empty field: the shopper's recent searches (kept on this device, only with
 * consent — catalog area's recent-searches) with «امسح». Keyboard: ↑ ↓ move (the active row has a --niche fill and an
 * ink start bar), Enter opens it (or searches), Escape closes the list.
 *
 * SUGGESTIONS CONTRACT (catalog area, CONTRACTS.md §2 `GET /api/search/suggest`):
 *   GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>
 *   200 { suggestions: { label, href, hint?, image?, priceIqd?, kindLabel? }[], total? }      href is locale-less
 *   `image` (an art key "<slug>--<n>"), `priceIqd` (integer IQD; left out while the product is sold out), `kindLabel`
 *   («جهاز PS5») and `total` (the result count for «اعرض كل النتائج (42)») are optional: rows show them when they come.
 *   The first 404 switches suggestions off for the rest of the visit (nothing is invented, nothing retried). Typing is
 *   debounced (160 ms) and a newer request aborts the older one.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { Form, useLocation, useNavigate, useSearchParams } from "react-router";

import { Art } from "~/art/Art";
import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useLocale, useLocalePath } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { useRecentSearches } from "~/routes/storefront/catalog/components/recent-searches";
import { cx } from "~/ui/cx";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { Sheet } from "~/ui/Sheet";
import { suggestionKind, type SuggestionKind } from "./chrome";
import { useShellT } from "./i18n";
import { usePlatformName } from "./MegaMenu";
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
    (item.priceIqd === undefined || (Number.isSafeInteger(item.priceIqd) && item.priceIqd >= 0))
  );
}

type SuggestResult = { items: SearchSuggestion[]; total: number | null };
const NONE: SuggestResult = { items: [], total: null };

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
        setResult({ items, total });
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

/** One option of the list, in the order the arrows walk them. */
type Option = { kind: "suggestion"; item: SearchSuggestion } | { kind: "all" } | { kind: "recent"; q: string };

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
};

export function SearchForm({ variant = "panel", query: initial, className, autoFocus = false, inputRef, onDone }: SearchFormProps) {
  const t = useShellT();
  const href = useLocalePath();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const recent = useRecentSearches();
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
  const { items, total } = useSuggestions(query, focused || variant === "sheet");
  const typing = query.trim().length >= MIN_CHARS;

  const options: Option[] = typing
    ? items.length > 0
      ? [...items.map((item) => ({ kind: "suggestion" as const, item })), { kind: "all" as const }]
      : []
    : recent.items.map((entry) => ({ kind: "recent" as const, q: entry.q }));
  // the sheet shows its list whenever there is one; the header and the panel while the field has focus
  const showList = options.length > 0 && (variant === "sheet" || (open && focused));

  // the field follows the URL (a new search, Back) unless the shopper is typing in it
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    if (!focused) setQuery(current);
  }
  useEffect(() => setActive(-1), [items, typing]);

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
      field.focus();
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
            setOpen(true);
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
      <div className="shell-suggest" hidden={!showList}>
        {showList ? (
          <p className="shell-suggest__head">
            <span>{typing ? t("search.head") : t("search.recent")}</span>
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
                  key={option.kind === "suggestion" ? `s:${option.item.href}:${index}` : option.kind === "recent" ? `r:${option.q}` : "all"}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={cx(option.kind === "all" ? "shell-suggest__all" : "shell-suggest__row", option.kind !== "all" && !isProductRow(option) && "shell-suggest__row--short")}
                  // keep focus in the field while choosing with a pointer
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <OptionBody option={option} total={total} />
                </li>
              ))
            : null}
        </ul>
      </div>
    </Form>
  );
}

function isProductRow(option: Option): boolean {
  return option.kind === "suggestion" && suggestionKind(option.item.href) === "product";
}

function OptionBody({ option, total }: { option: Option; total: number | null }) {
  const t = useShellT();
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
    // one second line (v2 §5.5): the kind («جهاز PS5») says more than the department; the department when it is missing
    const hint = item.kindLabel || item.hint;
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
                  {isPlatform(platform.accent) ? <PlatformLed /> : null}
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
