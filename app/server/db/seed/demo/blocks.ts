/**
 * Content blocks as the demo seed stores them (ARCHITECTURE §6: structured content is a localized
 * array of blocks, never HTML or Markdown).
 *
 * The database only fixes the `type` discriminator; `<Blocks>` owns the rest. Until that renderer
 * exists, these are the shapes the seeded articles use — every value is plain text:
 *
 *   { type: "h2",      text }
 *   { type: "p",       text }
 *   { type: "ul",      items: string[] }
 *   { type: "ol",      items: string[] }
 *   { type: "steps",   items: [{ title, text? }] }                         numbered how-to steps
 *   { type: "callout", tone: "info" | "warning" | "danger", title?, text } safety and scope notes
 *   { type: "table",   head: string[], rows: string[][] }
 *   { type: "art",     name, alt }                                         `name` = art key for <Art>
 *
 * Articles are authored once with all three languages side by side (TBlock) and split into one
 * array per language for storage, so the three versions cannot drift in structure.
 */
import type { LocalizedBlocks, StoredBlock } from "../../schema";
import { SEED_LOCALES, type SeedLocale, type T3 } from "./text";

export type CalloutTone = "info" | "warning" | "danger";

export type SeedBlock =
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "steps"; items: Array<{ title: string; text?: string }> }
  | { type: "callout"; tone: CalloutTone; title?: string; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "art"; name: string; alt: string };

/** A block written in the three languages at once. */
export type TBlock =
  | { type: "h2"; text: T3 }
  | { type: "p"; text: T3 }
  | { type: "ul" | "ol"; items: T3[] }
  | { type: "steps"; items: Array<{ title: T3; text?: T3 }> }
  | { type: "callout"; tone: CalloutTone; title?: T3; text: T3 }
  | { type: "table"; head: T3[]; rows: T3[][] }
  | { type: "art"; name: string; alt: T3 };

export const h2 = (text: T3): TBlock => ({ type: "h2", text });
export const p = (text: T3): TBlock => ({ type: "p", text });
export const ul = (...items: T3[]): TBlock => ({ type: "ul", items });
export const ol = (...items: T3[]): TBlock => ({ type: "ol", items });
export const steps = (...items: Array<{ title: T3; text?: T3 }>): TBlock => ({ type: "steps", items });
export const step = (title: T3, text?: T3): { title: T3; text?: T3 } => (text ? { title, text } : { title });
export const callout = (tone: CalloutTone, text: T3, title?: T3): TBlock => (title ? { type: "callout", tone, title, text } : { type: "callout", tone, text });
export const art = (name: string, alt: T3): TBlock => ({ type: "art", name, alt });

function localizeBlock(block: TBlock, locale: SeedLocale): SeedBlock {
  switch (block.type) {
    case "h2":
    case "p":
      return { type: block.type, text: block.text[locale] };
    case "ul":
    case "ol":
      return { type: block.type, items: block.items.map((item) => item[locale]) };
    case "steps":
      return { type: "steps", items: block.items.map((item) => (item.text ? { title: item.title[locale], text: item.text[locale] } : { title: item.title[locale] })) };
    case "callout":
      return block.title
        ? { type: "callout", tone: block.tone, title: block.title[locale], text: block.text[locale] }
        : { type: "callout", tone: block.tone, text: block.text[locale] };
    case "table":
      return { type: "table", head: block.head.map((cell) => cell[locale]), rows: block.rows.map((row) => row.map((cell) => cell[locale])) };
    case "art":
      return { type: "art", name: block.name, alt: block.alt[locale] };
  }
}

/** One block array per language, same structure in each. */
export function localizeBlocks(blocks: readonly TBlock[]): LocalizedBlocks {
  const forLocale = (locale: SeedLocale): StoredBlock[] => blocks.map((block) => localizeBlock(block, locale));
  const [ar, en, ckb] = SEED_LOCALES.map(forLocale);
  return { ar, en, ckb };
}
