/**
 * The chosen games (docs/switch-builder.md §6.4, data-tour="chosen"): from 1024 a list in the sticky aside; below it a
 * key in the task bar — «ألعابك (3)» — that opens the same list in a sheet (a bottom sheet on phones, a side panel from
 * 768, like the filters and the details sheets). Each row: the title (isolated; in the aside it opens the details
 * sheet), how it is bought (TamTam's cartridge or digital), the space it takes, and a remove key («أزل …») drawn as a
 * bin — never the × of the sheet's close key, in the same column (QA 2026-11-21).
 *
 * A removal keeps the keyboard where it was (WCAG 2.4.3): the next row's remove key takes focus, else the row before,
 * else the list itself, which then says «لم تختر ألعاباً بعد» — never <body>, outside an open sheet.
 *
 * A restored plan knows its games before the list file has named them: until then the list says it is loading
 * («نحمّل ألعابك…»), or — when the list did not load — that the names come with it; never «لم تختر ألعاباً بعد».
 */
import { useLayoutEffect, useRef } from "react";

import { useFormat } from "~/i18n/react";
import type { GameFormat } from "~/lib/switch-builder/types";
import { BidiText } from "~/ui/BidiText";
import { IconKey } from "~/ui/IconKey";
import { Sheet } from "~/ui/Sheet";
import { gbText, useBuilderT } from "../lib/format";
import type { LibraryEntry } from "../lib/library";

export type ChosenItem = { entry: LibraryEntry; format: GameFormat; need: number | null };

/** The plan has games the list has not named yet: it is loading, or it did not load. */
export type ChosenPending = "loading" | "unnamed" | null;

export type ChosenListProps = {
  items: readonly ChosenItem[];
  /** Set while the plan's games cannot be named yet. */
  pending?: ChosenPending;
  onRemove: (entry: LibraryEntry) => void;
  onOpen?: (entry: LibraryEntry) => void;
};

/** The remove keys of a list, in order (the focus goes to one of them after a removal). */
const REMOVE_KEY = "[data-chosen-remove]";

export function ChosenList({ items, pending = null, onRemove, onOpen }: ChosenListProps) {
  const t = useBuilderT();
  const f = useFormat();
  const box = useRef<HTMLDivElement>(null);
  // the row index a removal came from, while focus was in this list; the next render hands focus on
  const removedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = removedAt.current;
    if (index === null) return;
    removedAt.current = null;
    const keys = box.current ? [...box.current.querySelectorAll<HTMLElement>(REMOVE_KEY)] : [];
    const target = keys.length > 0 ? keys[Math.min(index, keys.length - 1)] : box.current;
    target?.focus({ preventScroll: true });
  });
  const remove = (entry: LibraryEntry, index: number) => {
    if (typeof document !== "undefined" && box.current?.contains(document.activeElement)) removedAt.current = index;
    onRemove(entry);
  };

  let body;
  if (pending) body = <p className="sb-chosen__empty">{t(pending === "loading" ? "chosen.loading" : "chosen.unnamed")}</p>;
  else if (items.length === 0) body = <p className="sb-chosen__empty">{t("chosen.empty")}</p>;
  else {
    body = (
      <ul className="sb-chosen">
        {items.map(({ entry, format, need }, index) => (
          <li key={entry.game.id} className="sb-chosen__row">
            <span className="sb-chosen__text">
              {onOpen ? (
                <button type="button" className="sb-chosen__title" aria-haspopup="dialog" onClick={() => onOpen(entry)}>
                  <BidiText text={entry.game.title} />
                </button>
              ) : (
                <span className="sb-chosen__title">
                  <BidiText text={entry.game.title} />
                </span>
              )}
              <span className="sb-chosen__meta nums">
                {t(format === "cartridge" ? "chosen.cartridge" : "chosen.digital")}
                {need !== null ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    {gbText(f, need)}
                  </>
                ) : null}
              </span>
            </span>
            <IconKey icon="trash" size="sm" variant="plain" label={t("chosen.remove", { title: entry.game.title })} onClick={() => remove(entry, index)} data-chosen-remove="" />
          </li>
        ))}
      </ul>
    );
  }
  // the list's own box takes focus (programmatically) when its last game was removed: it then says it is empty
  return (
    <div ref={box} tabIndex={-1} className="sb-chosen-box">
      {body}
    </div>
  );
}

export type ChosenSheetProps = {
  open: boolean;
  onClose: () => void;
  items: readonly ChosenItem[];
  /** How many games the plan holds (known before the list names them). */
  count: number;
  /** What they use, when their sizes are known (null while loading). */
  usedBytes: number | null;
  pending?: ChosenPending;
  onRemove: (entry: LibraryEntry) => void;
};

export function ChosenSheet({ open, onClose, items, count, usedBytes, pending = null, onRemove }: ChosenSheetProps) {
  const t = useBuilderT();
  const f = useFormat();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("chosen.sheetTitle")}
      description={
        <span className="nums">
          {t("chosen.count", { count, n: f.number(count) })}
          {count > 0 && usedBytes !== null ? ` · ${gbText(f, usedBytes)}` : ""}
        </span>
      }
      presentation="side"
      sideFrom={768}
    >
      <ChosenList items={items} pending={pending} onRemove={onRemove} />
    </Sheet>
  );
}
