/**
 * The plain-text form in which a policy's blocks are edited (admin 22.02), and back. Pure and client-safe.
 *
 * Policies are stored as block arrays (never HTML or Markdown: ARCHITECTURE §6, rendered by <Blocks>); a shop owner
 * edits them as lines:
 *
 *   ## A heading                      → { type: "h2" }
 *   Any other line                    → { type: "p" } (one paragraph per line)
 *   - an item                         → consecutive lines → { type: "ul" }
 *   1. an item                        → consecutive lines → { type: "ol" }
 *   > Step title | what happens       → consecutive lines → { type: "steps" }
 *   [info] Title | text               → { type: "callout", tone: "info" }   ([warning] and [danger] too)
 *   | head | head |  then  | a | b |  → { type: "table" } (the first row is the head)
 *
 * Strings stay strings (no markup survives: the renderer only ever makes text nodes). Art blocks are not edited here
 * and are dropped. Every block is checked against the renderer's shapes; a line that fits nothing is a paragraph.
 */
export type PolicyBlock =
  | { type: "h2" | "p"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "steps"; items: { title: string; text?: string }[] }
  | { type: "callout"; tone: "info" | "warning" | "danger"; title?: string; text: string }
  | { type: "table"; head: string[]; rows: string[][] };

export const POLICY_TEXT_MAX = 20_000;
export const POLICY_BLOCKS_MAX = 200;
const LINE_MAX = 2_000;

const clean = (text: string) =>
  text
    // controls and the bidirectional overrides / isolates never belong in staff text (SECURITY §5 "free text")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069\u200b\u2060\ufeff]/g, "")
    .trim()
    .slice(0, LINE_MAX);

const split = (text: string): [string, string | undefined] => {
  const at = text.indexOf("|");
  if (at === -1) return [clean(text), undefined];
  const second = clean(text.slice(at + 1));
  return [clean(text.slice(0, at)), second || undefined];
};

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map(clean);

export function textToBlocks(text: string): PolicyBlock[] {
  const lines = text.slice(0, POLICY_TEXT_MAX).replace(/\r\n?/g, "\n").split("\n");
  const out: PolicyBlock[] = [];
  const last = () => out[out.length - 1];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") continue;
    let match: RegExpExecArray | null;
    if ((match = /^##\s+(.+)$/.exec(line))) {
      out.push({ type: "h2", text: clean(match[1]) });
    } else if ((match = /^[-•]\s+(.+)$/.exec(line))) {
      const item = clean(match[1]);
      const prev = last();
      if (prev && prev.type === "ul") prev.items.push(item);
      else out.push({ type: "ul", items: [item] });
    } else if ((match = /^[0-9٠-٩۰-۹]{1,3}[.)]\s+(.+)$/.exec(line))) {
      // Latin, Arabic-Indic and Persian digits (follow-up 2026-11-12: "۱. ..." typed on a Persian keyboard was a paragraph)
      const item = clean(match[1]);
      const prev = last();
      if (prev && prev.type === "ol") prev.items.push(item);
      else out.push({ type: "ol", items: [item] });
    } else if ((match = /^>\s+(.+)$/.exec(line))) {
      const [title, body] = split(match[1]);
      const step = body ? { title, text: body } : { title };
      const prev = last();
      if (prev && prev.type === "steps") prev.items.push(step);
      else out.push({ type: "steps", items: [step] });
    } else if ((match = /^\[(info|warning|danger)\]\s*(.+)$/i.exec(line))) {
      const [title, body] = split(match[2]);
      const tone = match[1].toLowerCase() as "info" | "warning" | "danger";
      out.push(body ? { type: "callout", tone, title, text: body } : { type: "callout", tone, text: title });
    } else if (/^\|.*\|$/.test(line)) {
      const row = cells(line);
      const prev = last();
      if (prev && prev.type === "table") prev.rows.push(row);
      else out.push({ type: "table", head: row, rows: [] });
    } else {
      out.push({ type: "p", text: clean(line) });
    }
    if (out.length >= POLICY_BLOCKS_MAX) break;
  }
  // a block without words is dropped; a table needs a head
  return out.filter((block) => {
    switch (block.type) {
      case "h2":
      case "p":
        return block.text !== "";
      case "ul":
      case "ol":
        return block.items.some((item) => item !== "");
      case "steps":
        return block.items.some((item) => item.title !== "");
      case "callout":
        return block.text !== "";
      case "table":
        return block.head.some((cell) => cell !== "");
      default:
        return false;
    }
  });
}

const tableLine = (row: readonly string[]) => `| ${row.map((cell) => String(cell).replace(/\|/g, "/")).join(" | ")} |`;

/** Blocks back to the editing text (unknown blocks and art are left out). */
export function blocksToText(blocks: readonly unknown[]): string {
  const out: string[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== "object") continue;
    const block = raw as Record<string, unknown>;
    const str = (value: unknown) => (typeof value === "string" ? value.replace(/\n/g, " ") : "");
    const list = (value: unknown) => (Array.isArray(value) ? value : []);
    switch (block.type) {
      case "h2":
        out.push("", `## ${str(block.text)}`);
        break;
      case "p":
        out.push(str(block.text));
        break;
      case "ul":
        for (const item of list(block.items)) out.push(`- ${str(item)}`);
        break;
      case "ol":
        list(block.items).forEach((item, index) => out.push(`${index + 1}. ${str(item)}`));
        break;
      case "steps":
        for (const item of list(block.items)) {
          const step = (item ?? {}) as Record<string, unknown>;
          out.push(`> ${str(step.title)}${step.text ? ` | ${str(step.text)}` : ""}`);
        }
        break;
      case "callout": {
        const tone = block.tone === "warning" || block.tone === "danger" ? block.tone : "info";
        out.push(`[${tone}] ${block.title ? `${str(block.title)} | ` : ""}${str(block.text)}`);
        break;
      }
      case "table":
        out.push(tableLine(list(block.head).map(str)));
        for (const row of list(block.rows)) out.push(tableLine(list(row).map(str)));
        break;
      default:
        break;
    }
  }
  return out.join("\n").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}
