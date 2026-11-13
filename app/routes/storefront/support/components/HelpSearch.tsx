/**
 * The help centre's problem search (client note 9: "the feature of search about problems is good to notice — add
 * improvement and more features"). One GET form (`?q=` and `?platform=`: it works without JavaScript), on the soft
 * raised card with the page's one red primary inside the field's end:
 *
 *   suggestions while typing   debounced (150 ms), computed in the page from the index the loader sent (no request per
 *                              key): a danger sign first and alone, an error code with the guides that name it (the
 *                              code's row is ready for Enter — "a code opens its guide") or an honest «no guide names it
 *                              yet», then guides and store policies, the typed words marked; the last row searches
 *   keyboard                   ↓ ↑ walk the rows (field → first … last → field), Enter opens the active row (or
 *                              searches), Escape closes the list; the rows keep the focus in the field
 *   device chips               «كل الأجهزة · Nintendo · PlayStation · Xbox · المحمولة» — native radios in the form:
 *                              they keep suggestions and results to one platform's guides (and the guides about every
 *                              device); with script a change re-runs a search already on screen
 *   common problems            chips that are links (`?q=<their words>`): each leads to the guides of one tag, and is
 *                              shown only while such a guide exists (./helpsearch COMMON_PROBLEMS)
 *
 * The results (HelpResults) are grouped — a danger stop, an error code, guides, store policies — with the searched words
 * marked, and a helpful end: «لم تجد ما تبحث عنه؟» (the assistant, a repair, a person) or, with nothing found, an empty
 * state whose key books a repair and whose link writes to a person. Only real content: guides and policies that exist.
 */
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Form, useLocation, useNavigate, useNavigation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { getMotionTier } from "~/motion";
import { isPolicySlug, POLICY_ICONS } from "~/routes/storefront/content/content-model";
import { COMMON_PROBLEMS, commonProblemsFor, suggestHelp, type HelpIndexEntry, type PolicyEntry } from "~/server/services/support/helpsearch";
import type { ArticleSummary, HelpSearch } from "~/server/services/support/types";
import { isolate } from "~/ui/BidiText";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Glass } from "~/ui/Glass";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform } from "~/ui/PlatformLed";
import { useKeepInView } from "~/ui/reveal";
import { TextLink } from "~/ui/TextLink";
import { GuideList, guideIcon, Highlighted, SafetyNote } from "./parts";

/** The hand-off (talk to a person) with the searched words carried into the conversation. */
export const staffHrefFor = (q: string) => `/support/assistant?${new URLSearchParams({ q, handoff: "1" }).toString()}#handoff`;
/** The assistant, asked about the searched words. */
export const assistantHrefFor = (q: string) => `/support/assistant?${new URLSearchParams({ q }).toString()}`;
/** The help centre's own address for a search (empty values left out). */
export function searchHref(q: string, platform: string | null | undefined): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (platform) params.set("platform", platform);
  const query = params.toString();
  return `/support${query ? `?${query}` : ""}`;
}

/** A left-to-right isolate inside a sentence (codes): U+2066 … U+2069. */
export const ltr = (text: string) => `${String.fromCharCode(0x2066)}${text}${String.fromCharCode(0x2069)}`;

/**
 * The navigation state of a search re-run by a device chip: the page leaves the focus on the chips (an arrow key walks
 * on to the next platform; the results' status line says what changed) instead of moving it to the results' heading as
 * a new search does. Review of round 1: the first arrow key threw the focus out of the radio group.
 */
export const KEEP_FOCUS = { keepFocus: true } as const;
/** Whether a navigation's state asks the page to leave the focus where it is (KEEP_FOCUS). */
export const keepsFocus = (state: unknown): boolean => typeof state === "object" && state !== null && (state as { keepFocus?: unknown }).keepFocus === true;
// The shopper's own words inside a sentence («نتائج «…»») go in a first-strong isolate (the kit's BidiText isolate):
// "CE-108255-1" keeps its order in an Arabic sentence, Arabic words keep theirs in an English one.

const DEBOUNCE_MS = 150;

export type HelpSearchFormProps = {
  /** The words of the search on screen (`?q=`), "" for none. */
  query: string;
  /** The platform the search is kept to (`?platform=`), or null. */
  platform: string | null;
  /** The platforms of the device directory, in menu order (the device chips). */
  platforms: ReadonlyArray<{ slug: string; name: string }>;
  index: readonly HelpIndexEntry[];
  policies: readonly PolicyEntry[];
  /** Every approved public guide (the suggestion rows' words). */
  guides: readonly ArticleSummary[];
  /** COMMON_PROBLEMS keys to offer (those with a guide). */
  common: readonly string[];
};

/** One row of the suggestion list, in the order the arrow keys walk them. */
type Option =
  | { kind: "danger"; href: string }
  | { kind: "code"; code: string; article: ArticleSummary; href: string }
  | { kind: "codeNone"; code: string; href: string }
  | { kind: "guide"; article: ArticleSummary; href: string }
  | { kind: "policy"; policy: PolicyEntry; href: string }
  | { kind: "all"; href: string };

type Group = { key: string; title: string | null; options: Array<{ option: Option; index: number }> };

export function HelpSearchForm({ query, platform: urlPlatform, platforms, index, policies, guides, common }: HelpSearchFormProps) {
  const t = useT("support");
  const ui = useT("ui");
  const navigate = useNavigate();
  const navigation = useNavigation();
  const location = useLocation();
  const href = useLocalePath();
  const uid = useId();
  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const input = useRef<HTMLInputElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  // phones: the first suggestions of a visit to the field bring the field to the top, so the list has the screen
  const lifted = useRef(false);
  const liftOnPhone = () => {
    if (lifted.current || typeof window === "undefined" || !window.matchMedia("(max-width: 47.99rem)").matches) return;
    lifted.current = true;
    box.current?.scrollIntoView({ block: "start", behavior: getMotionTier() === "reduced" ? "auto" : "smooth" });
  };

  const [text, setText] = useState(query);
  const [settled, setSettled] = useState(query);
  const [platform, setPlatform] = useState(urlPlatform ?? "");
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);

  // the field and the chips follow the address (a new search, Back) unless the shopper is typing in the field
  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    if (!focused) {
      setText(query);
      setSettled(query);
    }
  }
  const [lastPlatform, setLastPlatform] = useState(urlPlatform);
  if (urlPlatform !== lastPlatform) {
    setLastPlatform(urlPlatform);
    setPlatform(urlPlatform ?? "");
  }

  useEffect(() => {
    if (text === settled) return;
    const timer = setTimeout(() => setSettled(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, settled]);

  const bySlug = useMemo(() => new Map(guides.map((guide) => [guide.slug, guide])), [guides]);
  const policyBySlug = useMemo(() => new Map(policies.map((policy) => [policy.slug, policy])), [policies]);
  const suggestions = useMemo(() => suggestHelp(index, policies, settled, { platform: platform || null }), [index, policies, settled, platform]);

  const words = settled.trim();
  const groups: Group[] = [];
  const options: Option[] = [];
  const add = (group: Group, option: Option) => {
    group.options.push({ option, index: options.length });
    options.push(option);
  };
  if (suggestions) {
    if (suggestions.danger) {
      const group: Group = { key: "danger", title: null, options: [] };
      add(group, { kind: "danger", href: "/support/repair" });
      groups.push(group);
    } else if (suggestions.code) {
      const group: Group = { key: "code", title: t("help.search.codeTitle"), options: [] };
      const named = suggestions.codeGuides.map((slug) => bySlug.get(slug)).filter((guide): guide is ArticleSummary => guide !== undefined);
      if (named.length > 0) for (const article of named) add(group, { kind: "code", code: suggestions.code, article, href: `/support/article/${article.slug}` });
      else add(group, { kind: "codeNone", code: suggestions.code, href: staffHrefFor(words) });
      groups.push(group);
    } else {
      const found = suggestions.guides.map((slug) => bySlug.get(slug)).filter((guide): guide is ArticleSummary => guide !== undefined);
      if (found.length > 0) {
        const group: Group = { key: "guides", title: t("help.search.guidesTitle"), options: [] };
        for (const article of found) add(group, { kind: "guide", article, href: `/support/article/${article.slug}` });
        groups.push(group);
      }
      const matched = suggestions.policies.map((slug) => policyBySlug.get(slug)).filter((policy): policy is PolicyEntry => policy !== undefined);
      if (matched.length > 0) {
        const group: Group = { key: "policies", title: t("help.search.policiesTitle"), options: [] };
        for (const policy of matched) add(group, { kind: "policy", policy, href: `/policies/${policy.slug}` });
        groups.push(group);
      }
    }
    const all: Group = { key: "all", title: null, options: [] };
    add(all, { kind: "all", href: searchHref(words, platform) });
    groups.push(all);
  }
  const showList = open && focused && options.length > 0;
  // a code that a guide names: its row is the active one, so Enter opens the guide; anything else starts at the field
  const firstCodeGuide = suggestions?.code && suggestions.codeGuides.length > 0;
  useEffect(() => setActive(firstCodeGuide ? 0 : -1), [suggestions, firstCodeGuide]);

  const searching = navigation.state === "loading" && navigation.location?.pathname === location.pathname && new URLSearchParams(navigation.location.search).has("q");
  // Offline the suggestions still come (they are computed here, from the page's index), but a search or a guide needs
  // the store: the key goes flat with the reason under the field — the words typed stay — instead of a navigation that
  // fails and swaps the whole page for the offline panel (review of round 1; the composer's way, assistant.tsx).
  const online = useOnline();
  const offlineId = `${uid}-offline`;

  const leave = (to: string) => {
    setOpen(false);
    if (!online) return;
    void navigate(href(to), { preventScrollReset: to.startsWith("/support?") || to === "/support" });
  };
  const choose = (option: Option) => {
    if (option.kind === "all") {
      search(words);
      return;
    }
    if (!online) {
      // the reason is under the field; the focus stays in it
      setOpen(false);
      return;
    }
    input.current?.blur();
    leave(option.href);
  };
  const search = (q: string, chosenPlatform = platform, keepFocus = false) => {
    setOpen(false);
    if (!online) return;
    void navigate(href(searchHref(q, chosenPlatform)), { preventScrollReset: true, state: keepFocus ? KEEP_FOCUS : undefined });
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = text.trim();
    if (!q) {
      input.current?.focus();
      return;
    }
    if (showList && active >= 0 && options[active]) {
      choose(options[active]);
      return;
    }
    search(q);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (showList) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!showList) {
        if (event.key === "ArrowDown" && options.length > 0) {
          event.preventDefault();
          setOpen(true);
        }
        return;
      }
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      // -1 is the field itself: the highlight wraps field → first … last → field
      setActive((current) => {
        const next = current + step;
        if (next < -1) return options.length - 1;
        if (next >= options.length) return -1;
        return next;
      });
    } else if (event.key === "Enter" && showList && active >= 0 && options[active]) {
      event.preventDefault();
      choose(options[active]);
    }
  };

  const onPlatform = (value: string) => {
    setPlatform(value);
    // a search on screen follows the chip at once (the focus stays on the chips); before a search the chip keeps the
    // suggestions to that platform
    if (query) search(query, value, true);
  };

  const platformName = (slug: string, name: string) => (isPlatform(slug) ? ui(`platform.${slug}`) : name);
  // the chips' links carry the chosen platform: a problem is offered only while that platform's guides (or the guides
  // about every device) answer it — never a chip that leads to «لم نجد دليلاً»
  const answered = useMemo(() => commonProblemsFor(index, platform || null), [index, platform]);
  const offered = COMMON_PROBLEMS.filter((problem) => common.includes(problem.key) && answered.includes(problem.key));
  // the rails scroll sideways on phones: the chosen platform and the chosen problem stay in view (a chip half cut by the
  // card's edge, or out of sight after a reload with ?platform=handheld, said nothing about the choice)
  const platformRail = useRef<HTMLDivElement | null>(null);
  const commonRail = useRef<HTMLUListElement | null>(null);
  useKeepInView(platformRail, ".key:has(> .key__native:checked)", platform);
  useKeepInView(commonRail, "[aria-current]", `${query}|${platform}`);

  return (
    <Form method="get" action="." role="search" className="sup-search" onSubmit={onSubmit} preventScrollReset>
      <div ref={box} className="sup-search__box">
        <TextField
          ref={input}
          label={t("help.search.label")}
          name="q"
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={300}
          placeholder={t("help.search.placeholder")}
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setOpen(true);
            liftOnPhone();
          }}
          onFocus={() => {
            setFocused(true);
            setOpen(true);
          }}
          onBlur={() => {
            setFocused(false);
            lifted.current = false;
          }}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={!online ? offlineId : undefined}
          inputClassName="sup-search__input"
          end={
            <Key type="submit" variant="primary" size="sm" icon="magnifying-glass" loading={searching} disabled={!online} aria-describedby={!online ? offlineId : undefined}>
              {t("help.search.submit")}
            </Key>
          }
        />
        {!online ? (
          <p id={offlineId} className="sup-search__offline">
            <Icon name="wifi-slash" size={16} />
            <span>{t("help.search.offline")}</span>
          </p>
        ) : null}
        {/* the count of rows for screen readers (the rows themselves are read as the arrows reach them) */}
        <p id={statusId} role="status" className="sr-only">
          {showList ? t("help.search.suggestCount", { count: options.length - 1 }) : ""}
        </p>
        {showList ? (
          <Glass panel className="sup-suggest">
            <ul id={listId} role="listbox" aria-label={t("help.search.suggestions")} className="sup-suggest__list">
              {groups.map((group) =>
                group.title ? (
                  <li key={group.key} role="presentation" className="sup-suggest__group">
                    {/* the group's name (aria-labelledby); hidden from the tree itself — a listbox owns options and
                        groups only, never a paragraph */}
                    <p id={`${listId}-${group.key}`} className="sup-suggest__head" aria-hidden="true">
                      {group.title}
                    </p>
                    <ul role="group" aria-labelledby={`${listId}-${group.key}`}>
                      {group.options.map(({ option, index: at }) => (
                        <SuggestRow key={at} id={`${listId}-${at}`} option={option} query={words} active={at === active} onChoose={() => choose(option)} onHover={() => setActive(at)} />
                      ))}
                    </ul>
                  </li>
                ) : (
                  group.options.map(({ option, index: at }) => <SuggestRow key={at} id={`${listId}-${at}`} option={option} query={words} active={at === active} onChoose={() => choose(option)} onHover={() => setActive(at)} />)
                ),
              )}
            </ul>
          </Glass>
        ) : null}
      </div>

      {platforms.length > 1 ? (
        <fieldset className="sup-search__filter">
          <legend className="sup-search__legend">{t("help.search.filter")}</legend>
          <div ref={platformRail} className="chips chips--rail chips--bleed">
            <Chip input="radio" name="platform" value="" checked={platform === ""} onChange={() => onPlatform("")}>
              {t("help.search.filterAll")}
            </Chip>
            {platforms.map((entry) => (
              <Chip key={entry.slug} input="radio" name="platform" value={entry.slug} checked={platform === entry.slug} onChange={() => onPlatform(entry.slug)} platform={isPlatform(entry.slug) ? entry.slug : undefined}>
                {platformName(entry.slug, entry.name)}
              </Chip>
            ))}
          </div>
        </fieldset>
      ) : null}

      {offered.length > 0 ? (
        <nav aria-labelledby={`${uid}-common`} className="sup-search__common">
          <p id={`${uid}-common`} className="sup-search__legend">
            {t("help.common.title")}
          </p>
          <ul ref={commonRail} role="list" className="chips chips--rail chips--bleed">
            {offered.map((problem) => {
              const words = t(`help.common.items.${problem.key}`);
              return (
                <li key={problem.key}>
                  <Chip as={HrefLink} to={`?${new URLSearchParams({ q: words, ...(platform ? { platform } : {}) }).toString()}`} selected={query === words}>
                    {words}
                  </Chip>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </Form>
  );
}

/** One suggestion: an icon on a clay disc, the words (the typed ones marked), one meta line; never a second link. */
function SuggestRow({ id, option, query, active, onChoose, onHover }: { id: string; option: Option; query: string; active: boolean; onChoose: () => void; onHover: () => void }) {
  const t = useT("support");
  let icon: IconName = "book-open";
  let title: ReactNode = null;
  let meta: ReactNode = null;
  let tone: "danger" | "code" | undefined;
  switch (option.kind) {
    case "danger":
      icon = "warning";
      tone = "danger";
      title = t("help.search.dangerRow");
      meta = t("help.search.dangerRowText");
      break;
    case "code":
      icon = "warning-circle";
      tone = "code";
      title = t("help.search.codeRow", { code: ltr(option.code) });
      meta = <Highlighted text={t("help.search.codeRowGuide", { title: option.article.title })} />;
      break;
    case "codeNone":
      icon = "warning-circle";
      tone = "code";
      title = t("help.search.codeRow", { code: ltr(option.code) });
      meta = t("help.search.codeRowNone");
      break;
    case "guide":
      icon = guideIcon(option.article.kind);
      title = <Highlighted text={option.article.title} query={query} />;
      meta = (
        <>
          {t(`kind.${option.article.kind}`)}
          {option.article.device ? (
            <>
              {" · "}
              <Highlighted text={option.article.device.name} />
            </>
          ) : null}
        </>
      );
      break;
    case "policy":
      icon = isPolicySlug(option.policy.slug) ? POLICY_ICONS[option.policy.slug] : "file-text";
      title = <Highlighted text={option.policy.title} query={query} />;
      meta = <Highlighted text={option.policy.summary} query={query} />;
      break;
    case "all":
      return (
        <li id={id} role="option" aria-selected={active} className={cx("sup-suggest__all", active && "is-active")} onPointerDown={(event) => event.preventDefault()} onPointerMove={onHover} onClick={onChoose}>
          <Icon name="magnifying-glass" size={18} />
          <span className="min-w-0 flex-1">
            {t("help.search.allResults", { query: isolate(query) })}
          </span>
          <Icon name="arrow-right" size={18} />
        </li>
      );
  }
  return (
    <li id={id} role="option" aria-selected={active} data-tone={tone} className={cx("sup-suggest__row", active && "is-active")} onPointerDown={(event) => event.preventDefault()} onPointerMove={onHover} onClick={onChoose}>
      <span className={cx(tone ? "sup-tone-disc" : "clay-disc", "sup-suggest__icon")} data-tone={tone} aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="sup-suggest__text">
        <span className="sup-suggest__title">{title}</span>
        {meta ? <span className="sup-suggest__meta">{meta}</span> : null}
      </span>
      <Icon name="arrow-right" size={16} className="sup-suggest__go" />
    </li>
  );
}

// ───────────────────────────────────────────────────────────────── the results

export type HelpResultsProps = {
  search: HelpSearch;
  /** The store policies the words match (the loader: content.server listPolicies + ./helpsearch matchPolicies). */
  policies: readonly PolicyEntry[];
  /** The name of the platform the search was kept to, or null. */
  platformName: string | null;
  headingRef: RefObject<HTMLHeadingElement | null>;
  /**
   * Kept to one platform and nothing found there: how many guides the same words find on every device (the loader
   * searches again). Above 0, the empty state offers «ابحث في كل الأجهزة» — a filter never hides an answer silently.
   */
  elsewhere?: number;
};

export function HelpResults({ search, policies, platformName, headingRef, elsewhere = 0 }: HelpResultsProps) {
  const t = useT("support");
  const q = search.query;
  const staffHref = staffHrefFor(q);
  const guides = search.kind === "guides" ? search.articles : [];
  const shownPolicies = search.kind === "guides" ? policies : [];
  const found = guides.length + shownPolicies.length;
  const uid = useId();
  // One status line that stays on screen from search to search, so every outcome is said — also when the focus stays
  // on the device chips (a chip re-runs the search): the count (with the platform) shown under the heading when
  // something was found, read out only otherwise (the danger stop, the code and the empty state say it visibly).
  const counted = (
    <>
      {t("help.search.count", { count: guides.length })}
      {platformName ? <> · {t("help.search.inPlatform", { platform: platformName })}</> : null}
    </>
  );
  const status = search.kind === "danger" ? t("help.search.dangerTitle") : search.kind === "code" ? `${t("help.search.codeTitle")} ${ltr(search.code ?? "")}` : counted;
  return (
    <section aria-labelledby="search-results" className="sup-results">
      <div className="sup-results__head">
        <h2 id="search-results" ref={headingRef} tabIndex={-1} className="type-h2 text-ink">
          {t("help.search.results", { query: isolate(q) })}
        </h2>
        <TextLink as={LocaleLink} to="/support" arrow={false} icon="x">
          {t("help.search.clear")}
        </TextLink>
      </div>
      <p role="status" className={search.kind === "guides" && found > 0 ? "type-sm text-ink-2" : "sr-only"}>
        {status}
      </p>

      {search.kind === "danger" ? (
        <SafetyNote
          tone="danger"
          title={t("help.search.dangerTitle")}
          action={
            <div className="sup-actions-line">
              <Key as={LocaleLink} to="/support/repair" size="sm" icon="wrench">
                {t("assistant.done.repair")}
              </Key>
              <TextLink as={LocaleLink} to={staffHref}>
                {t("assistant.done.staff")}
              </TextLink>
            </div>
          }
        >
          {t("help.search.dangerText")}
        </SafetyNote>
      ) : search.kind === "code" ? (
        <CodeResult search={search} uid={uid} />
      ) : found > 0 ? (
        <>
          {/* each group's count beside its title when there are two groups (one group: the status line says it) */}
          {guides.length > 0 ? (
            <ResultGroup id={`${uid}-guides`} title={t("help.search.guidesTitle")} count={shownPolicies.length > 0 ? guides.length : undefined}>
              <GuideList articles={guides} headingLevel={4} highlight={q} className="sup-guides--cols" />
            </ResultGroup>
          ) : null}
          {shownPolicies.length > 0 ? (
            <ResultGroup id={`${uid}-policies`} title={t("help.search.policiesTitle")} count={guides.length > 0 ? shownPolicies.length : undefined}>
              <PolicyList policies={shownPolicies} highlight={q} />
            </ResultGroup>
          ) : null}
          <Note
            icon="lifebuoy"
            variant="flat"
            title={t("help.search.more")}
            action={
              <div className="sup-actions-line">
                <TextLink as={LocaleLink} to={assistantHrefFor(q)}>
                  {t("help.search.ask")}
                </TextLink>
                <TextLink as={LocaleLink} to="/support/repair">
                  {t("assistant.done.repair")}
                </TextLink>
                <TextLink as={LocaleLink} to={staffHref}>
                  {t("assistant.done.staff")}
                </TextLink>
              </div>
            }
          />
        </>
      ) : (
        <EmptyState
          layout="stack"
          panel
          headingLevel={3}
          icon="magnifying-glass"
          title={t("help.search.none", { query: isolate(q) })}
          text={t("help.search.noneText")}
          action={
            <Key as={LocaleLink} to="/support/repair" icon="wrench">
              {t("assistant.done.repair")}
            </Key>
          }
          recovery={
            <>
              {/* kept to one platform, and the same words find guides on other devices: say so, one tap away */}
              {search.platform && elsewhere > 0 ? (
                <TextLink as={LocaleLink} to={searchHref(q, null)} icon="magnifying-glass" arrow={false}>
                  {t("help.search.allDevices")}
                </TextLink>
              ) : null}
              <TextLink as={LocaleLink} to={staffHref}>
                {t("assistant.done.staff")}
              </TextLink>
            </>
          }
          className="sup-empty"
        />
      )}
    </section>
  );
}

function ResultGroup({ id, title, count, children }: { id: string; title: string; count?: number; children: ReactNode }) {
  const f = useFormat();
  return (
    <section aria-labelledby={id} className="sup-results__group">
      <h3 id={id} className="sup-results__title">
        {title}
        {count !== undefined ? <span className="sup-results__count nums">{f.number(count)}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** An error code: the guides that name it, or an honest «no guide names it yet» with the way to a person. */
function CodeResult({ search, uid }: { search: HelpSearch; uid: string }) {
  const t = useT("support");
  const code = search.code ?? "";
  const q = search.query;
  if (search.articles.length > 0) {
    return (
      <ResultGroup id={`${uid}-code`} title={t("help.search.codeTitle")} count={search.articles.length}>
        <p className="type-read text-ink-2">{t("help.search.codeFound", { code: ltr(code) })}</p>
        <GuideList articles={search.articles} headingLevel={4} highlight={code} />
      </ResultGroup>
    );
  }
  return (
    <Note
      tone="info"
      icon="warning-circle"
      variant="flat"
      title={
        <>
          {t("help.search.codeTitle")}{" "}
          <bdi dir="ltr" className="sup-code">
            {code}
          </bdi>
        </>
      }
      action={
        <div className="sup-actions-line">
          <Key as={LocaleLink} to={staffHrefFor(q)} size="sm" icon="chat-circle">
            {t("assistant.done.staff")}
          </Key>
          <TextLink as={LocaleLink} to={assistantHrefFor(q)}>
            {t("help.search.ask")}
          </TextLink>
        </div>
      }
    >
      {t("help.search.codeNone")}
    </Note>
  );
}

/** Store policies as rows: the policy's icon on a clay disc, its title and line (searched words marked). */
function PolicyList({ policies, highlight }: { policies: readonly PolicyEntry[]; highlight?: string }) {
  return (
    <ul role="list" className="sup-guides">
      {policies.map((policy) => (
        <li key={policy.slug} className="sup-guide">
          <LocaleLink to={`/policies/${policy.slug}`} className="sup-guide__link" data-press="soft">
            <span className="clay-disc sup-guide__icon" aria-hidden="true">
              <Icon name={isPolicySlug(policy.slug) ? POLICY_ICONS[policy.slug] : "file-text"} size={20} />
            </span>
            <span className="sup-guide__body">
              <h4 className="sup-guide__title">
                <Highlighted text={policy.title} query={highlight} />
              </h4>
              {policy.summary ? (
                <span className="sup-guide__summary">
                  <Highlighted text={policy.summary} query={highlight} />
                </span>
              ) : null}
            </span>
            <Icon name="arrow-right" size={20} className="sup-guide__go" />
          </LocaleLink>
        </li>
      ))}
    </ul>
  );
}
