/**
 * The game's details sheet (docs/switch-builder.md §6.6) — opened by the card's info key and by press-and-hold.
 *
 *   <GameSheet open={sheetId !== null} onClose={close} game={game} extras={extras[game.id]} details={details}
 *              cartridge={catalog.cartridges[game.id] ?? null} selected={chosen ?? null}
 *              remainingBytes={leftWithoutThisGame} onSelect={(format) => choose(game.id, format)}
 *              onRemove={() => remove(game.id)} onRetryDetails={reloadChunk} />
 *
 * The kit's <Sheet presentation="side" sideFrom={768}>: a bottom sheet on phones (drag the header strip down to close),
 * a 420px side panel from 768 (the QuickPreview precedent; a details view is never a desktop Dialog). Focus, Escape,
 * Android's back, the inert page and the return of focus come from the shared modal layer. A navigation (Back, a step
 * change) closes it. While it leaves, it keeps showing the game it was opened for.
 *
 * What it shows, top to bottom (every part only when its data exists — nothing is invented):
 *   · the picture TamTam uploaded (/media/<key>), else the cartridge's catalogue photo; nothing otherwise;
 *   · year · publisher · developer (two of each at most — Wikidata lists regional distributors too —, all of them on
 *     screen: no line limit cuts a name off unseen, and a wrapped line never starts with the «·»), then the genre and
 *     play-mode words (`switch-builder` genre.<key> / mode.<key>);
 *   · the space: does it fit (both figures, with two decimals when one would look equal: storage.ts digitsToTell), the
 *     digital size (base + latest update), the cartridge's space on the console (or "counted at full size until we
 *     measure it"), when it was measured, why it is bigger than the download, and that saves stay in system memory;
 *   · how it is bought — TamTam cartridge or eShop digital copy — when TamTam sells the cartridge, each with its space
 *     and price; the eShop price is labelled as the US eShop's with its date. A chosen game can always move to a
 *     format that needs no more space than the one it has (even when the plan is over-full: it only helps);
 *   · a Metacritic score ONLY when TamTam entered a licensed one (with its source, review count and date, never stars
 *     or verdict colours), with a plain link to the game's Metacritic page;
 *   · the description: TamTam's own in the page's language, else the Wikipedia lead in the page's language, else the
 *     English one (marked lang="en", said so ABOVE it) — a Wikipedia text always carries its attribution line (article
 *     link + CC BY-SA 4.0 link), and is shown only with a real article link (https://<lang>.wikipedia.org/wiki/…: the
 *     licence needs the link, and nothing else may pass for it); while the details chunk loads, the space is reserved;
 *     a failure offers a retry;
 *   · the trailer (click to load, ./TrailerEmbed) and plain links out: the US eShop page, Metacritic, Wikipedia;
 *   · the pinned foot: «اختر هذه اللعبة» (the one primary; the grid's own verb — a game is chosen for the plan, never
 *     "put on" the console, contract §1) or «أزلها من ألعابك», with the reason in words when it cannot be chosen (it
 *     does not fit, or it has no size yet): the key then stays focusable (aria-disabled, like the grid's cards), so Tab
 *     reaches it and its reason. The change is announced inside the sheet (the page is inert) once the plan has taken
 *     it — a refused choice is never announced as done.
 */
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import type { Locale } from "~/lib/locales";
import { formatMoney } from "~/lib/money";
import { cartridgeUsesFullSize, digitsToTell, fits, spaceNeeded, toGiB } from "~/lib/switch-builder/storage";
import type { CatalogOption, GameDetails, GameFormat, LibraryExtras, LibraryGame, WikipediaExtract } from "~/lib/switch-builder/types";
import { BidiText, isolate } from "~/ui/BidiText";
import { ErrorState } from "~/ui/ErrorState";
import { FieldGroup, OptionCard } from "~/ui/Field";
import { Key, type KeyVariant } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { fillNodes, SafePrice } from "~/ui/PriceTag";
import { ProductImage } from "~/ui/ProductCard";
import { Sheet } from "~/ui/Sheet";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { TrailerEmbed, YOUTUBE_VIDEO_ID } from "./TrailerEmbed";
import "../builder-sheet.css";

export interface GameSheetProps {
  open: boolean;
  onClose: () => void;
  game: LibraryGame | null;
  extras?: LibraryExtras;
  /** "loading" while the page fetches the details chunk; null when the game has none; "error" when loading failed. */
  details: GameDetails | null | "loading" | "error";
  /** TamTam's cartridge of this game, when it sells one. */
  cartridge?: CatalogOption | null;
  /** How this game is chosen now, or null when it is not chosen. */
  selected: { format: GameFormat } | null;
  /** Bytes left in the plan, counting this game as NOT chosen (so the sheet can say whether it fits). */
  remainingBytes: number;
  /** Choose the game in this format (or switch its format). */
  onSelect: (format: GameFormat) => void;
  onRemove: () => void;
  /** Try loading the details again after an error. */
  onRetryDetails?: () => void;
}

/* ───────────────────────────── the model (pure) ───────────────────────────── */

type SheetLocale = "ar" | "en" | "ckb";

/** Does the game fit the plan, in the format the sheet shows? */
export type GameFit =
  /** Chosen already; `left` = what stays free with it (null when its size is unknown, negative when the plan is over). */
  | { kind: "chosen"; need: number | null; left: number | null }
  | { kind: "fits"; need: number; left: number }
  /** Both figures, with `digits` decimals so they never look equal when they are not. */
  | { kind: "full"; need: number; left: number; digits: 1 | 2 }
  /** No TamTam size yet: it cannot join the space bar. */
  | { kind: "unsized" };

/** Which description the sheet shows. */
export type GameAbout =
  | { kind: "tamtam"; text: string; lang: SheetLocale }
  | { kind: "wikipedia"; extract: WikipediaExtract; lang: SheetLocale }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "none" };

export type FormatOption = {
  format: GameFormat;
  /** Space it needs on the console (null = not measured). */
  need: number | null;
  /**
   * It may be picked now: not chosen yet (the foot says whether it fits); or chosen, and it fits in this format or needs
   * no more than the chosen format (a smaller format only frees space, even in a plan that is over-full).
   */
  selectable: boolean;
  /** The cartridge is counted at the digital size until TamTam measures it. */
  fullSize: boolean;
};

export interface GameSheetModel {
  /** The format the sheet shows (the chosen one, else the shopper's pick in the sheet, else the default). */
  format: GameFormat;
  /** Cartridge and digital, when TamTam sells the cartridge (or it is chosen as one); null = digital only. */
  options: FormatOption[] | null;
  fit: GameFit;
  about: GameAbout;
  developers: string[];
  eshopUrl: string;
  metacriticUrl: string | null;
  wikipediaUrl: string | null;
}

export type GameSheetInput = Pick<GameSheetProps, "extras" | "details" | "cartridge" | "selected" | "remainingBytes"> & {
  game: LibraryGame;
  locale: Locale;
  /** The format the shopper picked in the sheet before choosing the game. */
  format?: GameFormat;
};

export const WIKIPEDIA_LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/";

/**
 * Is this a link to an article of that language's Wikipedia — https, `<lang>.wikipedia.org`, a `/wiki/…` page, no
 * credentials or port? The details chunk is a static file built from a snapshot; whatever it holds, the sheet links only
 * to a real article under the label "Wikipedia" (and drops an extract without one: CC BY-SA needs the link). Pure.
 */
export function isWikipediaArticle(url: string | undefined, lang: SheetLocale): boolean {
  if (typeof url !== "string" || url === "") return false;
  let address: URL;
  try {
    address = new URL(url);
  } catch {
    return false;
  }
  return (
    address.protocol === "https:" &&
    address.hostname === `${lang}.wikipedia.org` &&
    address.port === "" &&
    address.username === "" &&
    address.password === "" &&
    address.pathname.startsWith("/wiki/") &&
    address.pathname.length > "/wiki/".length
  );
}

/** A game TamTam sells as an orderable cartridge starts as a cartridge, every other one as a digital copy. Pure. */
export function defaultFormat(cartridge: CatalogOption | null | undefined, selected: { format: GameFormat } | null): GameFormat {
  if (selected) return selected.format;
  return cartridge?.orderable ? "cartridge" : "digital";
}

/** Fit of one need against the space left without this game. Pure. */
export function fitFor(need: number | null, remainingBytes: number, chosen: boolean): GameFit {
  if (chosen) return { kind: "chosen", need, left: need === null ? null : remainingBytes - need };
  if (need === null) return { kind: "unsized" };
  if (fits(need, remainingBytes)) return { kind: "fits", need, left: remainingBytes - need };
  const left = Math.max(0, remainingBytes);
  return { kind: "full", need, left, digits: digitsToTell(need, left) };
}

const textOf = (value: string | undefined): string | null => {
  const text = value?.trim();
  return text ? text : null;
};

/**
 * The description to show: TamTam's own in the page's language; else Wikipedia's lead in the page's language; else
 * TamTam's English text; else Wikipedia's English lead. While the details chunk loads (and the page language has no
 * TamTam text) the sheet waits; after a failure it falls back to TamTam's English text or offers a retry. Pure.
 */
export function aboutFor(extras: LibraryExtras | undefined, details: GameSheetProps["details"], locale: Locale): GameAbout {
  const own = (lang: SheetLocale) => textOf(extras?.description?.[lang]);
  const wiki = (lang: SheetLocale): WikipediaExtract | null => {
    if (!details || typeof details !== "object") return null;
    const extract = details.wikipedia?.[lang];
    return extract && textOf(extract.text) && isWikipediaArticle(extract.url, lang) ? extract : null;
  };
  const mine = own(locale);
  if (mine) return { kind: "tamtam", text: mine, lang: locale };
  if (details === "loading") return { kind: "loading" };
  const local = wiki(locale);
  if (local) return { kind: "wikipedia", extract: local, lang: locale };
  if (locale !== "en") {
    const english = own("en");
    if (english) return { kind: "tamtam", text: english, lang: "en" };
    const wikiEnglish = wiki("en");
    if (wikiEnglish) return { kind: "wikipedia", extract: wikiEnglish, lang: "en" };
  }
  return details === "error" ? { kind: "error" } : { kind: "none" };
}

/** Everything the sheet decides, from its props. Pure. */
export function gameSheetModel(input: GameSheetInput): GameSheetModel {
  const { game, extras, details, cartridge, selected, remainingBytes, locale } = input;
  const format = selected?.format ?? input.format ?? defaultFormat(cartridge, null);
  const need = spaceNeeded(extras, format);
  const withChoice = Boolean(cartridge) || selected?.format === "cartridge";
  // what the chosen format takes now: moving to a format that needs no more never makes the plan worse
  const chosenNeed = selected ? spaceNeeded(extras, selected.format) : null;
  const options: FormatOption[] | null = withChoice
    ? (["cartridge", "digital"] as const).map((option) => {
        const optionNeed = spaceNeeded(extras, option);
        const smaller = optionNeed !== null && chosenNeed !== null && optionNeed <= chosenNeed;
        return {
          format: option,
          need: optionNeed,
          selectable: !selected || option === selected.format || smaller || fits(optionNeed, remainingBytes),
          fullSize: option === "cartridge" && cartridgeUsesFullSize(extras),
        };
      })
    : null;
  const wikipedia = details && typeof details === "object" ? details.wikipedia : undefined;
  const articleIn = (lang: SheetLocale): string | null => {
    const url = wikipedia?.[lang]?.url;
    return url !== undefined && isWikipediaArticle(url, lang) ? url : null;
  };
  const article = articleIn(locale as SheetLocale) ?? articleIn("en");
  return {
    format,
    options,
    fit: fitFor(need, remainingBytes, selected !== null),
    about: aboutFor(extras, details, locale),
    developers: details && typeof details === "object" ? details.developers : [],
    eshopUrl: `https://www.nintendo.com/us/store/products/${encodeURIComponent(game.id)}/`,
    metacriticUrl: game.metacriticSlug ? `https://www.metacritic.com/game/${encodeURIComponent(game.metacriticSlug)}/` : null,
    wikipediaUrl: article,
  };
}

/** "2026-11-21" → the epoch ms of that day (noon UTC, the same calendar day in Baghdad); null when it is no date. */
export function isoDay(value: string | undefined): number | null {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return Number.isNaN(ms) ? null : ms;
}

/** The title in the page's script under the Latin one (ar: the Arabic label; ckb: the Sorani, else the Arabic one). */
export function localTitle(game: LibraryGame, locale: Locale): { text: string; lang: string } | null {
  const pick = locale === "ar" ? (game.titleAr ? { text: game.titleAr, lang: "ar" } : null) : locale === "ckb" ? (game.titleCkb ? { text: game.titleCkb, lang: "ckb" } : game.titleAr ? { text: game.titleAr, lang: "ar" } : null) : null;
  return pick && pick.text.trim() !== "" && pick.text.trim() !== game.title.trim() ? pick : null;
}

/* ───────────────────────────── the sheet ───────────────────────────── */

export function GameSheet(props: GameSheetProps) {
  const { open, onClose, game, selected, onSelect, onRemove } = props;
  const locale = useLocale();
  const t = useT("switch-builder-sheet");
  // while it leaves (the page may clear `game` together with `open`) it keeps showing the game it was opened for
  const [lastGame, setLastGame] = useState<LibraryGame | null>(game);
  if (game && game !== lastGame) setLastGame(game);
  const shown = game ?? lastGame;
  const [picked, setPicked] = useState<{ id: string; format: GameFormat } | null>(null);
  const [said, setSaid] = useState("");

  // a navigation (Back, a step change) leaves the sheet behind
  const location = useLocation();
  const openedAt = useRef(location.key);
  useEffect(() => {
    if (open && location.key !== openedAt.current) onClose();
    openedAt.current = location.key;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to a navigation only
  }, [location.key]);

  // a new opening starts without the last announcement
  useEffect(() => {
    if (open) setSaid("");
  }, [open, shown?.id]);

  // The change is said once the plan has really changed (the `selected` prop answers the key) — never on the press
  // itself: the page may refuse an add (its game limit) and explains that with its own words.
  const inPlan = selected !== null;
  const before = useRef<{ id: string; inPlan: boolean } | null>(null);
  useEffect(() => {
    if (!open || !shown) {
      before.current = null;
      return;
    }
    const previous = before.current;
    before.current = { id: shown.id, inPlan };
    if (previous?.id === shown.id && previous.inPlan !== inPlan) setSaid(t(inPlan ? "foot.added" : "foot.removed", { title: isolate(shown.title) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the plan's answer for the game on screen only
  }, [open, shown?.id, inPlan]);

  if (!shown) return null;
  const model = gameSheetModel({ ...props, game: shown, locale, format: picked?.id === shown.id ? picked.format : undefined });
  const view: GameSheetView = {
    game: shown,
    extras: props.extras,
    details: props.details,
    cartridge: props.cartridge,
    selected,
    remainingBytes: props.remainingBytes,
    model,
    onRetryDetails: props.onRetryDetails,
    onFormat: (format) => {
      if (!selected) setPicked({ id: shown.id, format });
      else if (format !== selected.format) onSelect(format);
    },
  };
  const subtitle = localTitle(shown, locale);

  return (
    <Sheet
      open={open && game !== null}
      onClose={onClose}
      title={<BidiText text={shown.title} />}
      description={subtitle ? <span lang={subtitle.lang}>{subtitle.text}</span> : undefined}
      presentation="side"
      sideFrom={768}
      footer={<GameSheetFoot view={view} said={said} onAdd={() => onSelect(model.format)} onRemove={onRemove} />}
    >
      <GameSheetBody view={view} />
    </Sheet>
  );
}

/** What the body and the foot render from (exported for the server-render tests: the kit Sheet is client only). */
export interface GameSheetView {
  game: LibraryGame;
  extras?: LibraryExtras;
  details: GameSheetProps["details"];
  cartridge?: CatalogOption | null;
  selected: { format: GameFormat } | null;
  remainingBytes: number;
  model: GameSheetModel;
  onFormat: (format: GameFormat) => void;
  onRetryDetails?: () => void;
}

/** «16.5 GB» as the console shows it, in the shopper's numerals, isolated inside a sentence. */
function useGb(): (bytes: number, digits?: 1 | 2) => string {
  const f = useFormat();
  return (bytes, digits = 1) => isolate(`${f.number(toGiB(bytes, digits), { minimumFractionDigits: digits, maximumFractionDigits: digits })} GB`);
}

/** A day as the page writes dates (Iraq time, day first). */
function useDay(): (iso: string | undefined) => string | null {
  const f = useFormat();
  return (iso) => {
    const ms = isoDay(iso);
    return ms === null ? null : f.date(ms, "medium");
  };
}

/** A genre or play-mode word from the page's own namespace; nothing when the key is not there. */
function useLabel(): (key: string) => string | null {
  const sb = useT("switch-builder");
  return (key) => {
    const text = sb(key);
    return text === key ? null : text;
  };
}

export function GameSheetBody({ view }: { view: GameSheetView }) {
  return (
    <div className="sbs">
      <Picture view={view} />
      <Identity view={view} />
      <Space view={view} />
      <Buying view={view} />
      <Score view={view} />
      <About view={view} />
      <Trailer view={view} />
      <Links view={view} />
    </div>
  );
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId();
  return (
    <section className={className ? `sbs-section ${className}` : "sbs-section"} aria-labelledby={id}>
      <h3 id={id} className="sbs-section__title">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Picture({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const { game, extras, cartridge } = view;
  const alt = t("sheet.picture", { title: game.title });
  if (extras?.imageKey) {
    return (
      <div className="sbs-media">
        <ProductImage
          image={{ artKey: null, mediaKey: extras.imageKey, alt, isIllustration: false, width: extras.imageWidth, height: extras.imageHeight }}
          sizes="(min-width: 768px) 388px, 92vw"
        />
      </div>
    );
  }
  if (cartridge?.art) {
    return (
      <Niche kind="box" ratio="16/9" className="sbs-media">
        <ProductImage image={{ artKey: cartridge.art, mediaKey: null, alt, isIllustration: false }} sizes="(min-width: 768px) 388px, 92vw" />
      </Niche>
    );
  }
  return null;
}

/** Publishers, and developers, named in the sheet's meta line. */
const MAX_NAMES = 2;

const NBSP = " ";

/**
 * «2021 · Nintendo · The Pokémon Company · Bandai Namco Studios», every fact it is given on screen (no line limit: a
 * name is never cut off unseen). Each fact is one piece with its « ·» (an inline box: a name moves to the next line
 * whole, and wraps inside only when it alone is wider than the line), so a wrapped line never starts with the separator
 * — in Arabic and Sorani neither (the dot would stand at the right edge of the next line). Each name is its own isolate.
 */
function MetaLine({ facts }: { facts: readonly string[] }) {
  return (
    <p className="sbs-meta">
      {facts.map((fact, index) => (
        <Fragment key={index}>
          {index > 0 ? " " : null}
          <span className="sbs-meta__fact">
            <bdi>{fact}</bdi>
            {index < facts.length - 1 ? `${NBSP}·` : null}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

function Identity({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const f = useFormat();
  const label = useLabel();
  const { game, model } = view;
  // Wikidata lists regional distributors as publishers too («Softclub», «1C Company»): two of each is the useful part
  const people = [...new Set([...game.publishers.slice(0, MAX_NAMES), ...model.developers.slice(0, MAX_NAMES)].map((name) => name.trim()).filter(Boolean))];
  const facts = [game.year ? f.number(game.year, { useGrouping: false }) : null, ...people].filter((fact): fact is string => typeof fact === "string" && fact !== "");
  const tags = [...game.genres.filter((genre) => genre !== "other").map((genre) => label(`genre.${genre}`)), ...game.modes.map((mode) => label(`mode.${mode}`))].filter(
    (tag): tag is string => tag !== null,
  );
  if (facts.length === 0 && tags.length === 0) return null;
  return (
    <div className="sbs-identity">
      {facts.length > 0 ? <MetaLine facts={facts} /> : null}
      {tags.length > 0 ? (
        <ul className="sbs-tags" aria-label={t("sheet.tags")}>
          {tags.map((tag) => (
            <li key={tag} className="sbs-tag">
              {tag}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const FIT_LOOK: Record<GameFit["kind"], { tone: "ok" | "warn" | "danger"; icon: IconName }> = {
  chosen: { tone: "ok", icon: "check-circle" },
  fits: { tone: "ok", icon: "check-circle" },
  full: { tone: "danger", icon: "warning-circle" },
  unsized: { tone: "warn", icon: "info" },
};

/** The fit in words — the same sentence the foot's key is described by. */
export function useFitText(): (fit: GameFit) => string {
  const t = useT("switch-builder-sheet");
  const gb = useGb();
  return (fit) => {
    switch (fit.kind) {
      case "chosen":
        if (fit.need === null) return t("fit.chosen", { need: t("size.missing") });
        return fit.left !== null && fit.left >= 0 ? t("fit.chosenLeft", { need: gb(fit.need), left: gb(fit.left) }) : t("fit.chosen", { need: gb(fit.need) });
      case "fits":
        return t("fit.fits", { left: gb(fit.left) });
      case "full":
        return t("fit.full", { need: gb(fit.need, fit.digits), left: gb(fit.left, fit.digits) });
      case "unsized":
        return t("fit.unsized");
    }
  };
}

function FitLine({ fit, id }: { fit: GameFit; id?: string }) {
  const text = useFitText();
  const look = FIT_LOOK[fit.kind];
  return (
    <p id={id} className="sbs-fit" data-tone={look.tone}>
      <Icon name={look.icon} size={20} />
      <span>{text(fit)}</span>
    </p>
  );
}

function Space({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const gb = useGb();
  const day = useDay();
  const { extras, model } = view;
  const digital = spaceNeeded(extras, "digital");
  const cartridgeNeed = spaceNeeded(extras, "cartridge");
  const showCartridge = model.options !== null;
  const sized = digital !== null || (showCartridge && cartridgeNeed !== null);
  const measured = day(extras?.sizeAsOf);
  // whether it fits is said once, in the pinned foot beside the key it describes (the QuickPreview review: twice is noise)
  return (
    <Section title={t("size.title")}>
      <dl className="sbs-sizes">
        <div className="sbs-sizes__row">
          <dt>
            <span className="sbs-sizes__name">{t("size.digital")}</span>
            <span className="sbs-sizes__hint">{t("size.digitalHint")}</span>
          </dt>
          <dd className="nums">{digital !== null ? gb(digital) : t("size.missing")}</dd>
        </div>
        {showCartridge ? (
          <div className="sbs-sizes__row">
            <dt>
              <span className="sbs-sizes__name">{t("size.cartridge")}</span>
              <span className="sbs-sizes__hint">{cartridgeUsesFullSize(extras) ? t("size.cartridgeFull") : t("size.cartridgeHint")}</span>
            </dt>
            <dd className="nums">{cartridgeNeed !== null ? gb(cartridgeNeed) : t("size.missing")}</dd>
          </div>
        ) : null}
      </dl>
      {sized ? (
        <ul className="sbs-why">
          <li>{t("size.why")}</li>
          <li>{t("size.saves")}</li>
          {measured ? <li>{t("size.asOf", { date: isolate(measured) })}</li> : null}
        </ul>
      ) : (
        <p className="sbs-note">{t("size.unsized")}</p>
      )}
    </Section>
  );
}

/** «$59.99» — a US eShop price (not money TamTam takes: never through <Price>). */
function useUsd(): (cents: number) => string {
  const f = useFormat();
  return (cents) => isolate(formatMoney(cents, "USD", f.locale, f.numbering));
}

function Buying({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const gb = useGb();
  const usd = useUsd();
  const day = useDay();
  const { game, extras, cartridge, model, remainingBytes, selected } = view;
  const cents = extras?.priceUsdCents && extras.priceUsdCents > 0 ? extras.priceUsdCents : null;
  const date = day(extras?.priceAsOf);
  const priceLine = cents === null ? t("price.eshopMissing") : date ? t("price.eshop", { price: usd(cents), date: isolate(date) }) : t("price.eshopUndated", { price: usd(cents) });

  const hint = (option: FormatOption): string => {
    if (option.need === null) return t("format.noSize");
    if (selected && !option.selectable) {
      const left = Math.max(0, remainingBytes);
      const digits = digitsToTell(option.need, left);
      return t("format.noRoom", { need: gb(option.need, digits), left: gb(left, digits) });
    }
    if (option.format === "digital") return t("format.takes", { size: gb(option.need) });
    return option.fullSize ? t("format.cartridgeFull", { size: gb(option.need) }) : t("format.cartridgeTakes", { size: gb(option.need) });
  };
  const end = (option: FormatOption): ReactNode => {
    if (option.format === "digital") return cents === null ? null : <span className="sbs-usd nums">{usd(cents)}</span>;
    if (!cartridge) return null;
    if (!cartridge.orderable) return <span className="sbs-reason">{cartridge.reason === "unavailable" ? t("format.unavailable") : t("format.outOfStock")}</span>;
    return <SafePrice amountIqd={cartridge.priceIqd} size="sm" as="span" approx="off" />;
  };

  return (
    <div className="sbs-buying">
      {model.options ? (
        <FieldGroup legend={t("format.legend")}>
          {model.options.map((option) => (
            <OptionCard
              key={option.format}
              name={`sbs-format-${game.id}`}
              value={option.format}
              checked={model.format === option.format}
              disabled={!option.selectable}
              onChange={() => view.onFormat(option.format)}
              label={option.format === "cartridge" ? t("format.cartridge") : t("format.digital")}
              hint={hint(option)}
              end={end(option)}
            />
          ))}
        </FieldGroup>
      ) : null}
      <p className="sbs-note">{priceLine}</p>
    </div>
  );
}

function Score({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const f = useFormat();
  const day = useDay();
  const licensed = view.extras?.metacritic;
  if (!licensed || !Number.isFinite(licensed.score)) return null;
  const date = day(licensed.asOf);
  return (
    <Section title={t("score.title")}>
      <p className="sbs-score">
        <span className="sbs-score__value nums">{t("score.line", { score: f.number(licensed.score) })}</span>
        {licensed.reviews > 0 ? <span className="nums">{t("score.reviews", { count: licensed.reviews, n: f.number(licensed.reviews) })}</span> : null}
        {date ? <span className="nums">{t("score.asOf", { date: isolate(date) })}</span> : null}
      </p>
      {view.model.metacriticUrl ? (
        <TextLink href={view.model.metacriticUrl} external>
          {t("score.link")}
        </TextLink>
      ) : null}
    </Section>
  );
}

function About({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const locale = useLocale();
  const about = view.model.about;
  if (about.kind === "none") return null;
  return (
    <Section title={t("about.title")}>
      {about.kind === "loading" ? (
        <div aria-busy="true">
          <p className="sbs-note" role="status">
            {t("sheet.loading")}
          </p>
          {/* the space the description will take — reserved, empty, never a grey skeleton */}
          <div className="sbs-reserve" aria-hidden="true" />
        </div>
      ) : about.kind === "error" ? (
        <ErrorState alert title={t("sheet.detailsError")} text={t("sheet.detailsErrorText")} onRetry={view.onRetryDetails} />
      ) : (
        <>
          {/* the reader learns why the text is in English before meeting it */}
          {about.lang !== locale ? <p className="sbs-note">{t("about.english")}</p> : null}
          <p className="sbs-read" lang={about.lang} dir={about.lang === "en" && locale !== "en" ? "ltr" : undefined}>
            {about.kind === "tamtam" ? about.text : about.extract.text}
          </p>
          {about.kind === "wikipedia" ? (
            <p className="sbs-attribution">
              {fillNodes(t("about.wikipedia"), {
                article: (
                  <TextLink href={about.extract.url} external inline>
                    <bdi lang={about.lang}>{about.extract.title}</bdi>
                  </TextLink>
                ),
                licence: (
                  // the licence's name is one piece: never «CC» on one line and «BY-SA 4.0 ↗» on the next
                  <TextLink href={WIKIPEDIA_LICENCE_URL} external inline className="sbs-nowrap">
                    <bdi dir="ltr">CC BY-SA 4.0</bdi>
                  </TextLink>
                ),
              })}
            </p>
          ) : null}
        </>
      )}
    </Section>
  );
}

function Trailer({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const id = view.extras?.trailerYouTubeId?.trim();
  if (!id || !YOUTUBE_VIDEO_ID.test(id)) return null;
  return (
    <Section title={t("trailer.title")}>
      <TrailerEmbed key={id} videoId={id} title={view.game.title} />
    </Section>
  );
}

function Links({ view }: { view: GameSheetView }) {
  const t = useT("switch-builder-sheet");
  const { model } = view;
  return (
    <Section title={t("links.title")}>
      <ul className="sbs-links">
        <li>
          <TextLink href={model.eshopUrl} external>
            {t("links.eshop")}
          </TextLink>
        </li>
        {model.metacriticUrl ? (
          <li>
            <TextLink href={model.metacriticUrl} external>
              {t("links.metacritic")}
            </TextLink>
          </li>
        ) : null}
        {model.wikipediaUrl ? (
          <li>
            <TextLink href={model.wikipediaUrl} external>
              {t("links.wikipedia")}
            </TextLink>
          </li>
        ) : null}
      </ul>
    </Section>
  );
}

/**
 * The pinned foot: the fit in words at the start, the one key at the end — «اختر هذه اللعبة» (the sheet's one primary),
 * flat with its reason when the game does not fit or has no size; «أزلها من ألعابك» once chosen (the same button, so
 * the focus stays on it). A key that cannot act is `aria-disabled`, not `disabled`: it stays in the Tab order with the
 * fit line as its description (the grid's cards do the same), and a press does nothing. `said` is announced from
 * inside the sheet (the page behind is inert).
 */
export function GameSheetFoot({ view, said = "", onAdd, onRemove }: { view: GameSheetView; said?: string; onAdd: () => void; onRemove: () => void }) {
  const t = useT("switch-builder-sheet");
  const reasonId = useId();
  const fit = view.model.fit;
  const chosen = fit.kind === "chosen";
  const blocked = !chosen && fit.kind !== "fits";
  const variant: KeyVariant = chosen ? "secondary" : "primary";
  return (
    <div className="sbs-foot">
      <FitLine fit={fit} id={reasonId} />
      <Key
        variant={variant}
        icon={chosen ? "minus" : "plus"}
        aria-disabled={blocked || undefined}
        aria-describedby={reasonId}
        onClick={blocked ? undefined : chosen ? onRemove : onAdd}
        className="sbs-foot__key"
      >
        {chosen ? t("foot.remove") : t("foot.add")}
      </Key>
      <VisuallyHidden role="status">{said}</VisuallyHidden>
    </div>
  );
}
