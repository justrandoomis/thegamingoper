import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { Niche } from "./Niche";
import { Render } from "./Stage";

/**
 * Blocks — renders structured content (knowledge articles, policies, device guides). Staff-authored content is
 * stored as arrays of blocks, never HTML or Markdown (ARCHITECTURE §6), and this renderer only ever puts their
 * strings into text nodes — no dangerouslySetInnerHTML, no links or markup inside a string — so the content is
 * safe by construction.
 *
 *   <Blocks blocks={article.body} />                 an article under the page's <h1>: its "h2" blocks are <h2>
 *   <Blocks blocks={parseBlocks(row.body?.[locale] ?? row.body.ar)} headingLevel={3} />   nested under an h2
 *
 * The shapes match the demo seed (app/server/db/seed/demo/blocks.ts) one to one:
 *
 *   { type: "h2",      text }
 *   { type: "p",       text }
 *   { type: "ul" | "ol", items: string[] }
 *   { type: "steps",   items: { title, text? }[] }                          numbered how-to steps
 *   { type: "callout", tone: "info" | "warning" | "danger", title?, text }   safety and scope notes
 *   { type: "table",   head: string[], rows: string[][] }
 *   { type: "art",     name, alt }                                          an <Art> key (product photo or render)
 *
 * Callouts are flat panels, never dismissible (DESIGN.md §9.22): info = an info icon in --info; warning = a warning
 * icon and --warn heading; danger = a warning icon and --red-ink heading (danger is words, an icon and red ink —
 * never brand red). The tone is named for screen readers too, so it never rests on colour alone.
 */
export type CalloutTone = "info" | "warning" | "danger";

export type Block =
  | { type: "h2"; text: string }
  | { type: "p"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "steps"; items: Array<{ title: string; text?: string }> }
  | { type: "callout"; tone: CalloutTone; title?: string; text: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "art"; name: string; alt: string };

const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const isTextList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
const TONES: readonly CalloutTone[] = ["info", "warning", "danger"];

/** One block from untrusted data (a database JSON column), or null when it does not have a known, complete shape. */
export function toBlock(value: unknown): Block | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case "h2":
    case "p":
      return isText(raw.text) ? { type: raw.type, text: raw.text } : null;
    case "ul":
    case "ol":
      return isTextList(raw.items) ? { type: raw.type, items: [...raw.items] } : null;
    case "steps": {
      if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
      const items: Array<{ title: string; text?: string }> = [];
      for (const item of raw.items) {
        if (typeof item !== "object" || item === null) return null;
        const { title, text } = item as Record<string, unknown>;
        if (!isText(title) || (text !== undefined && typeof text !== "string")) return null;
        items.push(isText(text) ? { title, text } : { title });
      }
      return { type: "steps", items };
    }
    case "callout": {
      if (!TONES.includes(raw.tone as CalloutTone) || !isText(raw.text)) return null;
      if (raw.title !== undefined && typeof raw.title !== "string") return null;
      const tone = raw.tone as CalloutTone;
      return isText(raw.title) ? { type: "callout", tone, title: raw.title, text: raw.text } : { type: "callout", tone, text: raw.text };
    }
    case "table": {
      if (!isTextList(raw.head) || !Array.isArray(raw.rows) || !raw.rows.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) return null;
      return { type: "table", head: [...raw.head], rows: (raw.rows as string[][]).map((row) => [...row]) };
    }
    case "art":
      return isText(raw.name) && typeof raw.alt === "string" ? { type: "art", name: raw.name, alt: raw.alt } : null;
    default:
      return null;
  }
}

/** Every well-formed block of an untrusted array, in order (malformed or unknown blocks are dropped). */
export function parseBlocks(value: unknown): Block[] {
  if (!Array.isArray(value)) return [];
  const out: Block[] = [];
  for (const item of value) {
    const block = toBlock(item);
    if (block) out.push(block);
  }
  return out;
}

export type BlocksProps = {
  /** Typed blocks, or straight from the database (each one is checked; bad ones are skipped). */
  blocks: readonly Block[] | readonly unknown[];
  /** Level of the "h2" blocks. Default 2 (the article's title is the page's h1). */
  headingLevel?: 2 | 3 | 4;
  /** `sizes` for art blocks. */
  artSizes?: string;
  className?: string;
};

export function Blocks({ blocks, headingLevel = 2, artSizes = "(min-width: 768px) 640px, 92vw", className }: BlocksProps) {
  const list = parseBlocks(blocks);
  if (list.length === 0) return null;
  return (
    <div className={cx("grid min-w-0 gap-4 type-body text-ink", className)}>
      {list.map((block, index) => (
        <BlockView key={index} block={block} headingLevel={headingLevel} artSizes={artSizes} />
      ))}
    </div>
  );
}

function BlockView({ block, headingLevel, artSizes }: { block: Block; headingLevel: 2 | 3 | 4; artSizes: string }): ReactNode {
  switch (block.type) {
    case "h2": {
      const Heading = `h${headingLevel}` as const;
      return <Heading className="mt-2 type-section text-ink">{block.text}</Heading>;
    }
    case "p":
      return <p>{block.text}</p>;
    case "ul":
      return (
        <ul className="grid list-disc gap-1.5 ps-5 marker:text-ink-2">
          {block.items.map((item, index) => (
            <li key={index} className="ps-1">
              {item}
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="grid list-decimal gap-1.5 ps-5 marker:text-ink-2 marker:nums">
          {block.items.map((item, index) => (
            <li key={index} className="ps-1">
              {item}
            </li>
          ))}
        </ol>
      );
    case "steps":
      return <Steps items={block.items} />;
    case "callout":
      return <Callout tone={block.tone} title={block.title} text={block.text} />;
    case "table":
      return <BlockTable head={block.head} rows={block.rows} />;
    case "art":
      return (
        <figure className="m-0">
          <Niche ratio="16/9" tagZone={false} className="max-h-[360px] w-full">
            <Render name={block.name} alt={block.alt} sizes={artSizes} />
          </Niche>
        </figure>
      );
  }
}

/** Numbered steps: an ink numeral in a ring, the step's title in strong type and its explanation under it. */
function Steps({ items }: { items: Array<{ title: string; text?: string }> }) {
  return (
    <ol className="grid gap-3">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span className="grid size-7 shrink-0 place-items-center rounded-full border-[1.5px] border-ink type-xs-strong text-ink nums" aria-hidden="true">
            {index + 1}
          </span>
          <div className="grid min-w-0 gap-0.5 pt-0.5">
            <p className="type-strong text-ink">{item.title}</p>
            {item.text ? <p className="text-ink-2">{item.text}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

const CALLOUT: Record<CalloutTone, { icon: IconName; tone: string; className?: string }> = {
  info: { icon: "info", tone: "text-info" },
  warning: { icon: "warning", tone: "text-warn", className: "callout--warn" },
  danger: { icon: "warning", tone: "text-danger", className: "callout--danger" },
};

/**
 * A callout (v2 §4.1): a paper panel with a 3px inline-start bar in the tone colour; the icon is named (role="img")
 * with the tone's word, so the tone is never colour alone.
 */
function Callout({ tone, title, text }: { tone: CalloutTone; title?: string; text: string }) {
  const t = useT("ui-overlays");
  const look = CALLOUT[tone];
  return (
    <aside className={cx("callout", look.className)}>
      <Icon name={look.icon} size={20} title={t(`blocks.${tone}`)} className="mt-0.5" />
      <div className="grid min-w-0 gap-1">
        {title ? <p className={cx("callout__title", look.tone)}>{title}</p> : null}
        <p className="text-ink">{text}</p>
      </div>
    </aside>
  );
}

function BlockTable({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="scroll-thin overflow-x-auto rounded-sm border border-line">
      <table className="table">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {head.map((_, column) => (
                <td key={column} className="py-2">
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
