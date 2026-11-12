/**
 * Small client-safe helpers of the device hub (no server imports: the hub's components and the tests use them).
 */
import type { IconName } from "~/art/Icon";
import type { Formatters } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import type { CompatibilityStatus, ProductCardData, Shelf, StockState } from "~/lib/dto";
import { LOCALES } from "~/lib/locales";
import type { CompatGroup, DeviceHub } from "~/server/services/devices.server";
import { splitBidi } from "~/ui/BidiText";
import { isPlatform, type Platform } from "~/ui/PlatformLed";

/** Research dates are calendar days ("2025-06-05"), months ("2025-06") or years ("2017"). */
export type ResearchDate = { kind: "day" | "month" | "year"; text: string; year: string };

/**
 * Gregorian month names in Sorani (CLDR "ckb"). The browsers' and workerd's ICU builds carry no Sorani calendar data,
 * so Intl falls back to English month names on a Kurdish page; these are used instead. Native review pending.
 */
const CKB_MONTHS = ["کانوونی دووەم", "شوبات", "ئازار", "نیسان", "ئایار", "حوزەیران", "تەمووز", "ئاب", "ئەیلوول", "تشرینی یەکەم", "تشرینی دووەم", "کانوونی یەکەم"] as const;

/** A research date in the page's language and numerals (Baghdad calendar). Null when it is not one of the three shapes. */
export function researchDate(value: string | null | undefined, f: Formatters): ResearchDate | null {
  if (!value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const tag = `${LOCALES[f.locale].bcp47}-u-nu-${f.numbering}`;
  if (f.locale === "ckb") {
    const parts = day ?? /^(\d{4})-(\d{2})$/.exec(value);
    const month = parts ? CKB_MONTHS[Number(parts[2]) - 1] : undefined;
    if (parts && month) {
      const year = f.number(Number(parts[1]), { useGrouping: false });
      return day ? { kind: "day", text: `${f.number(Number(day[3]))}ی ${month} ${year}`, year } : { kind: "month", text: `${month} ${year}`, year };
    }
  }
  if (day) {
    // noon UTC is the same calendar day in Baghdad (UTC+3)
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12);
    return { kind: "day", text: f.date(ms, "long"), year: f.number(Number(day[1]), { useGrouping: false }) };
  }
  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) {
    const ms = Date.UTC(Number(month[1]), Number(month[2]) - 1, 15, 12);
    return { kind: "month", text: new Intl.DateTimeFormat(tag, { month: "long", year: "numeric", timeZone: "Asia/Baghdad" }).format(ms), year: f.number(Number(month[1]), { useGrouping: false }) };
  }
  const year = /^(\d{4})$/.exec(value);
  if (year) {
    const text = f.number(Number(year[1]), { useGrouping: false });
    return { kind: "year", text, year: text };
  }
  return null;
}

/** One fact of the hub's head: its icon, its words, and the shorter words a phone shows instead (the release year). */
export type HeadFact = { icon: IconName; text: string; phone?: string };

/**
 * The facts row of the hub's head, in the spec's order (v2 §6.6: the release date, the generation, the games and the
 * accessories the store has for it — verified records only; a zero or an unknown fact is not said). The row is ONE
 * line (devices.css: the facts that fit, the rest clipped and still read by screen readers); on a phone the release
 * date says its year only («صدر عام 2025»), so two facts share the line there. `n` formats a count. Pure.
 */
export function headFacts(
  facts: { released: ResearchDate | null; generation: string | null; games: number; accessories: number },
  t: TFunction,
  n: (value: number) => string,
): HeadFact[] {
  const out: HeadFact[] = [];
  const { released, generation, games, accessories } = facts;
  if (released) {
    const year = t("hero.releasedYear", { year: released.year });
    out.push(released.kind === "year" ? { icon: "calendar-blank", text: year } : { icon: "calendar-blank", text: t("hero.released", { date: released.text }), phone: year });
  }
  if (generation) out.push({ icon: "stack", text: t("hero.generation", { generation: isolateName(generation) }) });
  if (games > 0) out.push({ icon: "game-controller", text: t("hero.games", { count: games, n: n(games) }) });
  if (accessories > 0) out.push({ icon: "plug", text: t("hero.accessories", { count: accessories, n: n(accessories) }) });
  return out;
}

/** The platform of a platform accent token ("nintendo", …) — its band surface and dot; null for anything else. */
export function gelOf(accent: string | null | undefined): Platform | null {
  return isPlatform(accent) ? accent : null;
}

/**
 * A name inside Arabic or Sorani text, as the kit's <BidiText> draws it but as a string (for message parameters and
 * labels): every Latin run is a left-to-right isolate (U+2066 … U+2069) and the rest keeps the sentence's direction,
 * so «PlayStation 5 (الطراز الأصلي 2020)» reads name first, qualifier second (one isolate around the whole name made
 * the qualifier lead in Arabic). A Latin-only name is one isolate.
 */
export function isolateName(text: string): string {
  return splitBidi(text)
    .map((part) => (part.ltr ? `\u2066${part.text}\u2069` : part.text))
    .join("");
}

/**
 * A device name whose short last word never wraps alone (v2 §4.18: "Switch 2", "PS5 Pro", "Go 2" never break): the
 * space before a final token of 1–3 characters becomes a no-break space. "PlayStation 5 Slim" keeps its spaces.
 */
export function keepTogether(name: string): string {
  return name.replace(/ (?=\S{1,3}$)/, "\u00a0");
}

/** A device name to put inside a sentence: its Latin runs isolated, its short last word kept with the one before («Switch 2»). */
export const deviceIn = (name: string) => isolateName(keepTogether(name));

/** Section ids of the hub, in page order (the anchors of the sticky section chips). */
export const HUB_SECTIONS = ["versions", "compare", "specs", "accessories", "games", "help", "faq", "used"] as const;
export type HubSectionId = (typeof HUB_SECTIONS)[number];

type SectionFacts = Pick<DeviceHub, "editions" | "versions" | "notes" | "comparison" | "specs" | "accessories" | "games" | "faq" | "used">;

/** What the hub lists as the device's accessories: compatible ones only (v2 §6.6 "compatible accessories (verified only)"). */
const COMPATIBLE: ReadonlySet<CompatibilityStatus> = new Set<CompatibilityStatus>(["verified", "partial"]);

/**
 * The accessory groups the hub shows: verified, and works-with-a-condition (a verified record, its condition under each
 * card). Accessories nobody has checked, and those recorded as not working, stay on their own product pages, where
 * the compatibility list names every device — the hub's accessories are what a shopper can buy for this device. Games
 * keep every recorded state (a disc that does not fit a digital console is worth knowing here). Pure.
 */
export function accessoryGroups(groups: readonly CompatGroup[]): CompatGroup[] {
  return groups.filter((group) => COMPATIBLE.has(group.status));
}

/**
 * The sections this hub draws, in page order — the chips offer only these (v2 §6.6: "a section with none is hidden").
 * The same rules as the section components, which hide themselves. Help is always there (assistant, repair). Pure.
 */
export function hubSections(hub: SectionFacts): HubSectionId[] {
  const has = (groups: readonly CompatGroup[]) => groups.some((group) => group.items.length > 0);
  const out: HubSectionId[] = [];
  if (hub.editions.length > 0 || hub.versions.length > 0 || hub.notes.length > 0) out.push("versions");
  if (hub.comparison) out.push("compare");
  if (hub.specs.length > 0) out.push("specs");
  if (has(accessoryGroups(hub.accessories))) out.push("accessories");
  if (has(hub.games)) out.push("games");
  out.push("help");
  if (hub.faq.length > 0) out.push("faq");
  if (hub.used.length > 0) out.push("used");
  return out;
}

/** One version of an edition as the product read layer answers it (only what the "from" price needs). */
export type VersionOffer = { variantId: string; priceIqd: number; orderable: boolean };

const BUYABLE: ReadonlySet<StockState> = new Set<StockState>(["in_stock", "low_stock"]);

/**
 * «من 756,500 د.ع» — the cheapest version OF THIS DEVICE a shopper can order now (v2 §6.6). `versionIds` are the hub's
 * versions (DeviceHub.versions): the variants that ARE this model — one product can cover two models (the 2020 PS5
 * and its Digital Edition), and the other model's version must not set this one's price. An edition with one version
 * is its card (its price IS that version's); an edition with several needs every version's price and state (`offers`,
 * by product slug — an edition whose versions are missing there does not count, so the figure is never a guess).
 * Null when nothing of this device can be ordered now. Integer dinars in, integer dinars out. Pure.
 */
export function cheapestOrderable(
  editions: readonly Pick<ProductCardData, "slug" | "variantId" | "hasVariants" | "priceIqd" | "stock">[],
  offers: ReadonlyMap<string, readonly VersionOffer[]>,
  versionIds: ReadonlySet<string>,
): number | null {
  let best: number | null = null;
  const consider = (variantId: string, amount: number) => {
    if (!versionIds.has(variantId)) return;
    if (Number.isSafeInteger(amount) && amount > 0 && (best === null || amount < best)) best = amount;
  };
  for (const edition of editions) {
    if (!edition.hasVariants) {
      if (BUYABLE.has(edition.stock)) consider(edition.variantId, edition.priceIqd);
      continue;
    }
    for (const offer of offers.get(edition.slug) ?? []) if (offer.orderable) consider(offer.variantId, offer.priceIqd);
  }
  return best;
}

/** What the loader streams for the head's price: the cheapest orderable version (null: none), or that the read failed. */
export type FromOutcome = { amount: number | null } | { failed: true };

/** The head's price line: «من …», the state in words when nothing of this device can be ordered now, or nothing. */
export type HeadPrice = { kind: "from"; amount: number } | { kind: "soon" } | { kind: "out" } | { kind: "unknown" };

/**
 * The price line of the hub's head from the streamed outcome. A failed read says nothing (never a guess). No orderable
 * version means nothing of THIS device can be ordered now — even when a card shows its product as in stock (the 2020
 * PS5 and its Digital Edition share one product; the disc version in stock does not make the digital one orderable):
 * «قريباً · الطلب يفتح عند وصوله» when an edition is coming, else «نفد حالياً». Pure.
 */
export function headPrice(outcome: FromOutcome, editions: readonly Pick<ProductCardData, "stock">[]): HeadPrice {
  if ("failed" in outcome) return { kind: "unknown" };
  if (outcome.amount !== null) return { kind: "from", amount: outcome.amount };
  return editions.some((edition) => edition.stock === "preorder") ? { kind: "soon" } : { kind: "out" };
}

/**
 * The section being read, for the sticky chips: the last section whose top has passed the reading line (`line`, px
 * from the top of the viewport); none above the first section (the head is not a section); the last one once the
 * page cannot scroll further (a short last section never reaches the line). `tops` in page order. Pure.
 */
export function currentSection(tops: readonly { id: string; top: number }[], line: number, atEnd: boolean): string | null {
  if (tops.length === 0) return null;
  if (atEnd && (tops[0]?.top ?? Infinity) <= line) return tops[tops.length - 1]?.id ?? null;
  let current: string | null = null;
  for (const section of tops) if (section.top <= line) current = section.id;
  return current;
}

/**
 * The card grids shown in full («اعرض كل الإكسسوارات»), kept in the URL (`?all=<grid>`, repeatable) so the choice works
 * before JavaScript (a link), and survives Back and a reload. Pure.
 */
export const ALL_PARAM = "all";

export function expandedGrids(search: string): Set<string> {
  return new Set(new URLSearchParams(search).getAll(ALL_PARAM));
}

/** The search string with `grid` shown in full, or folded back; every other parameter kept ("" when none is left). Pure. */
export function toggleGrid(search: string, grid: string): string {
  const params = new URLSearchParams(search);
  const open = params.getAll(ALL_PARAM);
  params.delete(ALL_PARAM);
  for (const value of open.includes(grid) ? open.filter((entry) => entry !== grid) : [...open, grid]) params.append(ALL_PARAM, value);
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** True when two search strings differ only in the shown-in-full grids (the page has every card already). Pure. */
export function onlyGridsChanged(current: URLSearchParams, next: URLSearchParams): boolean {
  const rest = (params: URLSearchParams) => {
    const copy = new URLSearchParams(params);
    copy.delete(ALL_PARAM);
    copy.sort();
    return copy.toString();
  };
  return rest(current) === rest(next) && current.getAll(ALL_PARAM).join("|") !== next.getAll(ALL_PARAM).join("|");
}

/** The shelves a page can draw: the kit's shelf needs three cards (ShelfRail `minItems`). Pure. */
export function drawableShelves<T>(shelves: readonly Shelf<T>[]): Shelf<T>[] {
  return shelves.filter((shelf) => shelf.items.length >= 3);
}
