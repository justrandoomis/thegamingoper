/**
 * One game of the library (docs/switch-builder.md §6.4): a soft card with the game's picture (TamTam's own upload at
 * /media/<key>, the cartridge's catalogue photo, or a typographic tile drawn from tokens — never a picture from
 * Nintendo), its title (Latin, isolated) with the page-language title when Wikidata has one, the year, the space it
 * needs («16.5 GB», or «لم يُضف الحجم بعد»), the eShop price when TamTam has one and «شريط من طمطم» when TamTam sells
 * the cartridge.
 *
 * The title is a toggle `<button aria-pressed>` whose hit area stretches over the whole card: a tap chooses the game, a
 * second tap removes it. A game that does not fit (or has no size yet) is `aria-disabled` and says so in words; a tap
 * then explains (the page's toast: both figures and «بطاقة أكبر»). Press-and-hold opens the details sheet
 * (useLongPress, which swallows the click after it); the info key — a SIBLING of the toggle, never inside it — opens it
 * for keyboards and screen readers. Chosen: an ink ring and a check on the picture, and «مختارة» in words.
 */
import { useId, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import type { GameFormat } from "~/lib/switch-builder/types";
import { mediaUrl } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { FactLine } from "~/ui/FactLine";
import { IconKey } from "~/ui/IconKey";
import { BidiText } from "~/ui/BidiText";
import { Niche } from "~/ui/Niche";
import { Render } from "~/ui/Stage";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { gbText, shortfallText, useBuilderT, usdText } from "../lib/format";
import { needOf, type LibraryEntry } from "../lib/library";
import { useLongPress } from "../lib/use-long-press";

/** Words left out of a title's initials (the typographic tile): «The Legend of Zelda» → "LZ". */
const SMALL_WORDS = new Set(["the", "a", "an", "of", "and", "to", "in", "on", "for", "at", "by", "with"]);

/** Two letters for the typographic tile, from the title's first two significant words. Pure. */
export function initialsOf(title: string): string {
  const words = title
    .split(/[\s:–—\-_/]+/u)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const significant = words.filter((word) => !SMALL_WORDS.has(word.toLowerCase()));
  const pick = (significant.length > 0 ? significant : words).slice(0, 2);
  return pick.map((word) => [...word][0]?.toUpperCase() ?? "").join("") || "?";
}

/** The page-language title when Wikidata has one that differs from the Latin title (shown as the meta line). */
export function localTitle(entry: LibraryEntry, locale: string): string | null {
  const local = locale === "ar" ? entry.game.titleAr : locale === "ckb" ? entry.game.titleCkb : undefined;
  return local && local.trim() !== "" && local !== entry.game.title ? local : null;
}

export function GameArt({ entry, chosen, out = false }: { entry: LibraryEntry; chosen: boolean; out?: boolean }) {
  const image = entry.extras?.imageKey;
  let picture: ReactNode = null;
  if (image) {
    picture = (
      <img
        src={mediaUrl(image)}
        width={entry.extras?.imageWidth ?? 600}
        height={entry.extras?.imageHeight ?? 800}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="sb-cover"
      />
    );
  } else if (entry.cartridge?.art) {
    picture = <Render name={entry.cartridge.art} alt="" sizes="72px" />;
  }
  return (
    <span className="sb-game__art" aria-hidden="true">
      {picture ? (
        <Niche as="span" kind="box" ratio="3/4" size="sm" state={out ? "out" : undefined} className="sb-game__well">
          {picture}
        </Niche>
      ) : (
        // no picture: a typographic tile in the well's place — the title's initials on the quiet ground
        <span className="sb-tile" data-state={out ? "out" : undefined}>
          <span className="sb-tile__mark" dir="ltr">
            {initialsOf(entry.game.title)}
          </span>
        </span>
      )}
      {chosen ? (
        <span className="sb-game__check">
          <Icon name="check" size={16} />
        </span>
      ) : null}
    </span>
  );
}

export type GameCardProps = {
  entry: LibraryEntry;
  /** How the game is chosen, or null. */
  chosen: GameFormat | null;
  /** Bytes left in the plan (the card says whether it fits and by how much it does not). */
  remainingBytes: number;
  /** The first card carries the guide's targets (game-card, game-size, game-info). */
  first?: boolean;
  onToggle: (entry: LibraryEntry) => void;
  onOpen: (entry: LibraryEntry) => void;
};

export function GameCard({ entry, chosen, remainingBytes, first = false, onToggle, onOpen }: GameCardProps) {
  const t = useBuilderT();
  const f = useFormat();
  const locale = useLocale();
  const id = useId();
  const hold = useLongPress({ onLongPress: () => onOpen(entry) });
  const format = chosen ?? entry.format;
  const need = needOf(entry, format);
  const missing = chosen || need === null || need <= remainingBytes ? null : need - remainingBytes;
  const blocked = !chosen && (need === null || missing !== null);
  const price = entry.extras?.priceUsdCents;
  const local = localTitle(entry, locale);
  const facts = [local, typeof entry.game.year === "number" ? String(entry.game.year) : null].filter((fact): fact is string => Boolean(fact));
  const tour = (name: string) => (first ? { "data-tour": name } : {});
  return (
    <li className="sb-game surface lift" data-card="" data-flip={entry.game.id} data-chosen={chosen ? "" : undefined} data-state={blocked ? "out" : undefined} {...tour("game-card")}>
      <GameArt entry={entry} chosen={Boolean(chosen)} out={missing !== null} />
      <div className="sb-game__body">
        <h3 className="sb-game__title">
          <button
            type="button"
            className="sb-game__toggle"
            aria-pressed={Boolean(chosen)}
            aria-disabled={blocked || undefined}
            aria-describedby={`${id}-facts`}
            data-press="soft"
            data-fx="none"
            onClick={() => onToggle(entry)}
            {...hold}
          >
            <span className="sb-game__name">
              <BidiText text={entry.game.title} />
            </span>
          </button>
        </h3>
        {facts.length > 0 ? <FactLine facts={facts} className="sb-game__meta" /> : null}
        <p className="sb-game__facts" id={`${id}-facts`}>
          <span className={cx("sb-game__size", need === null && "sb-game__size--none")} {...tour("game-size")}>
            {need === null ? t("card.noSize") : <span className="nums">{gbText(f, need)}</span>}
          </span>
          {typeof price === "number" && price > 0 ? <span className="sb-game__price nums">{t("card.eshop", { price: usdText(f, price) })}</span> : null}
          {entry.cartridge ? <span className="sb-game__tag">{t("card.cartridge")}</span> : null}
          {missing !== null ? <span className="sb-game__why nums">{t("card.noRoom", { missing: shortfallText(f, missing) })}</span> : null}
          {chosen ? <VisuallyHidden>{t(`card.chosenAs.${chosen}`)}</VisuallyHidden> : null}
        </p>
      </div>
      <IconKey icon="info" label={t("card.info", { title: entry.game.title })} size="sm" variant="plain" className="sb-game__info" onClick={() => onOpen(entry)} {...tour("game-info")} />
    </li>
  );
}
