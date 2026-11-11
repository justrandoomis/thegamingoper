/**
 * The header search: a GET form to /search (works without script; with script React Router navigates), with a
 * suggestions slot under the field.
 *
 * SUGGESTIONS CONTRACT (the slot's source; owner: catalog area, CONTRACTS.md §3 `GET /api/search/suggest`):
 *   GET /api/search/suggest?q=<text>&locale=<ar|en|ckb>
 *   200 application/json { suggestions: { label: string; href: string; hint?: string }[] }   href is locale-less
 * Until that endpoint exists the field is a plain search box: the first 404 switches suggestions off for the rest
 * of the visit, so nothing is invented and nothing is retried. The list is an ARIA combobox listbox (arrows move,
 * Enter opens the highlighted suggestion or searches, Escape closes); typing is debounced (160 ms) and a newer
 * request aborts the older one.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Form, useLocation, useNavigate, useSearchParams } from "react-router";

import { Icon } from "~/art/Icon";
import { useLocale, useLocalePath } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { useShellT } from "./i18n";

export type SearchSuggestion = { label: string; href: string; hint?: string };

const SUGGEST_URL = "/api/search/suggest";
const MIN_CHARS = 2;
const DEBOUNCE_MS = 160;
/** Set when the endpoint answered 404 (not built yet): suggestions stay off until the next page load. */
let suggestUnavailable = false;

function isSuggestion(value: unknown): value is SearchSuggestion {
  const item = value as SearchSuggestion | null;
  return !!item && typeof item.label === "string" && item.label.length > 0 && typeof item.href === "string" && item.href.startsWith("/") && (item.hint === undefined || typeof item.hint === "string");
}

function useSuggestions(query: string, enabled: boolean): SearchSuggestion[] {
  const locale = useLocale();
  const [items, setItems] = useState<SearchSuggestion[]>([]);
  useEffect(() => {
    const q = query.trim();
    if (!enabled || suggestUnavailable || q.length < MIN_CHARS) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`${SUGGEST_URL}?${new URLSearchParams({ q, locale })}`, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (response.status === 404) {
          suggestUnavailable = true;
          setItems([]);
          return;
        }
        if (!response.ok) return setItems([]);
        const body = (await response.json()) as { suggestions?: unknown };
        setItems(Array.isArray(body.suggestions) ? body.suggestions.filter(isSuggestion).slice(0, 8) : []);
      } catch {
        if (!controller.signal.aborted) setItems([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, enabled, locale]);
  return items;
}

export type SearchFormProps = {
  className?: string;
  /** Focus the field on mount (the 404 panel). */
  autoFocus?: boolean;
};

export function SearchForm({ className, autoFocus = false }: SearchFormProps) {
  const t = useShellT();
  const href = useLocalePath();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const onSearchPage = splitLocale(location.pathname).path === "/search";
  const current = onSearchPage ? (params.get("q") ?? "") : "";

  const id = useId();
  const listId = `${id}-list`;
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(current);
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const suggestions = useSuggestions(query, focused);
  const showList = open && focused && suggestions.length > 0;

  // the field follows the URL (a new search, Back) unless the shopper is typing in it
  const [lastCurrent, setLastCurrent] = useState(current);
  if (current !== lastCurrent) {
    setLastCurrent(current);
    if (!focused) setQuery(current);
  }
  useEffect(() => setActive(-1), [suggestions]);

  const go = (suggestion: SearchSuggestion) => {
    setOpen(false);
    input.current?.blur();
    void navigate(href(suggestion.href));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (showList) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (!showList) {
      if (event.key === "ArrowDown" && suggestions.length > 0) setOpen(true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // -1 is the field itself: the highlight wraps field → first … last → field
      setActive((index) => {
        const next = index + step;
        if (next < -1) return suggestions.length - 1;
        if (next >= suggestions.length) return -1;
        return next;
      });
    } else if (event.key === "Enter" && active >= 0 && suggestions[active]) {
      event.preventDefault();
      go(suggestions[active]);
    }
  };

  return (
    <Form method="get" action={href("/search")} role="search" className={cx("shell-search", className)} onSubmit={() => setOpen(false)}>
      <label htmlFor={id} className="sr-only">
        {t("search.label")}
      </label>
      <input
        ref={input}
        id={id}
        type="search"
        name="q"
        className="field__input shell-search__input"
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
      <button type="submit" className="shell-search__submit" aria-label={t("search.submit")}>
        <Icon name="magnifying-glass" size={20} />
      </button>
      <ul id={listId} role="listbox" aria-label={t("search.suggestions")} className="shell-search__list" hidden={!showList}>
        {showList
          ? suggestions.map((suggestion, index) => (
              <li
                key={`${suggestion.href}-${index}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className="shell-search__option"
                // keep focus in the field while choosing with a pointer
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => go(suggestion)}
              >
                <span>{suggestion.label}</span>
                {suggestion.hint ? <span className="shell-search__hint">{suggestion.hint}</span> : null}
              </li>
            ))
          : null}
      </ul>
    </Form>
  );
}
