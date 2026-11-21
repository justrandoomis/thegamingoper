/**
 * The chosen games (docs/switch-builder.md §6.4, data-tour="chosen"): from 1024 a list in the sticky aside; below it a
 * key in the task bar — «ألعابك (3)» — that opens the same list in a bottom sheet. Each row: the title (isolated), how
 * it is bought (TamTam's cartridge or digital), the space it takes, and a remove key («أزل …»).
 */
import { useFormat } from "~/i18n/react";
import type { GameFormat } from "~/lib/switch-builder/types";
import { BidiText } from "~/ui/BidiText";
import { IconKey } from "~/ui/IconKey";
import { Sheet } from "~/ui/Sheet";
import { gbText, useBuilderT } from "../lib/format";
import type { LibraryEntry } from "../lib/library";

export type ChosenItem = { entry: LibraryEntry; format: GameFormat; need: number | null };

export function ChosenList({ items, onRemove, onOpen }: { items: readonly ChosenItem[]; onRemove: (entry: LibraryEntry) => void; onOpen?: (entry: LibraryEntry) => void }) {
  const t = useBuilderT();
  const f = useFormat();
  if (items.length === 0) return <p className="sb-chosen__empty">{t("chosen.empty")}</p>;
  return (
    <ul className="sb-chosen">
      {items.map(({ entry, format, need }) => (
        <li key={entry.game.id} className="sb-chosen__row">
          <span className="sb-chosen__text">
            {onOpen ? (
              <button type="button" className="sb-chosen__title" onClick={() => onOpen(entry)}>
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
          <IconKey icon="x" size="sm" variant="plain" label={t("chosen.remove", { title: entry.game.title })} onClick={() => onRemove(entry)} />
        </li>
      ))}
    </ul>
  );
}

export function ChosenSheet({ open, onClose, items, usedBytes, onRemove }: { open: boolean; onClose: () => void; items: readonly ChosenItem[]; usedBytes: number; onRemove: (entry: LibraryEntry) => void }) {
  const t = useBuilderT();
  const f = useFormat();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("chosen.sheetTitle")}
      description={
        <span className="nums">
          {t("chosen.count", { count: items.length, n: f.number(items.length) })}
          {items.length > 0 ? ` · ${gbText(f, usedBytes)}` : ""}
        </span>
      }
      presentation="sheet"
    >
      <ChosenList items={items} onRemove={onRemove} />
    </Sheet>
  );
}
