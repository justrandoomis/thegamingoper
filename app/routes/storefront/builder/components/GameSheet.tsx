/**
 * The game's details sheet (docs/switch-builder.md §6.6). STUB written by the lead; the sheet-and-tour owner replaces
 * the body and keeps the props.
 */
import type { CatalogOption, GameDetails, GameFormat, LibraryExtras, LibraryGame } from "~/lib/switch-builder/types";

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

export function GameSheet(_props: GameSheetProps) {
  return null;
}
