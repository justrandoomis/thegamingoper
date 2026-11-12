import { isValidElement, type ReactNode } from "react";

import { cx } from "./cx";

/**
 * Mixed scripts — Arabic or Sorani text with Latin names and numbers in it — in the order a reader of the page
 * expects (docs/DESIGN.md §5.5, §13: "Latin product names and all numbers inside Arabic or Sorani are wrapped in
 * <bdi>"; nothing forces `direction` on a name or a title).
 *
 *   <BidiText text={card.name} />                    a name or a sentence (string in, inline nodes out)
 *   <BidiLabel className="key__label">{label}</BidiLabel>   a label inside a key, chip, crumb, menu row or toast
 *   splitBidi(text)                                  the parts, for tests and for code that builds its own nodes
 *
 * Text without Arabic script is ONE left-to-right isolate ("PlayStation 5 Pro", "AI+", "25,000"), so trailing
 * signs stay where they were typed even on an Arabic page. Inside Arabic text every Latin NAME and every number is
 * one left-to-right isolate, cut where a reader expects the unit to end:
 *
 *   · a name goes on across spaces, glued joiners (Z-A, USB-C, Marvel's, X|S, 1920×1080, 3.5, 25,000) and spaced
 *     ones (" – ", " + ", " / ", " & ", ": "): "Pokémon Legends: Z-A – Nintendo Switch 2 Edition", "32GB / 1TB";
 *   · a bracket belongs to a name only with its partner and only around Latin ("Legion Go (2023)", "BEE-001(-01)");
 *     "PlayStation 5 Slim (نسخة الأقراص) – 1TB" keeps its brackets in the sentence, where the browser mirrors them;
 *   · list and sentence punctuation stays outside — " · ", ", ", " — " (name — option), "، ", a final full stop;
 *   · a number that follows Arabic belongs to that sentence and stands alone ("حزمة 2026: Switch 2" — the 2026 is
 *     the bundle's), as does a number between a joiner and Arabic ("+ 3 مانگ").
 *
 * Isolating a run makes it neutral to the sentence around it: the sentence keeps the page's direction, Latin reads
 * left to right inside each isolate, and brackets left outside pair up and mirror as the bidi algorithm intends.
 */

/** Hebrew, Arabic (with Kurdish and Persian letters), Syriac, Thaana, N'Ko, … and the Arabic presentation forms. */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/u;
const WORDISH = /[\p{L}\p{M}\p{Nd}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

/** Joins two word characters with nothing around it: Z-A, USB-C, Marvel's, X|S, 1920×1080, 3.5, 16:9, R&D, a@b. */
const GLUE = new Set(["'", "’", "&", ".", ":", "+", "-", "‐", "‑", "–", "/", "|", "×", "_", "@"]);
/** Stays with the word it follows: AI+, C#, 20%, 4°, Switch™. */
const TRAIL = new Set(["+", "#", "%", "°", "™", "®", "©", "*", "²", "³", "′", "″"]);
/** Starts a run when a word follows at once: #1, $10, @tamtam (and +964 before a digit). */
const LEAD = new Set(["#", "$", "€", "£", "@"]);
/** With spaces on both sides, still inside one Latin name. */
const JOINER = new Set(["–", "-", "+", "/", "&", "|", "×"]);
const OPEN = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
]);
const CLOSE = new Set([")", "]", "}"]);

export type BidiPart = { text: string; ltr: boolean };

const isRtl = (c: string | undefined) => c !== undefined && RTL.test(c);
const isWord = (c: string | undefined) => c !== undefined && WORDISH.test(c) && !RTL.test(c);
const isDigit = (c: string | undefined) => c !== undefined && DIGIT.test(c) && !RTL.test(c);
/** Spaces inside one line (a line break always ends a run). */
const isSpace = (c: string | undefined) => c !== undefined && c !== "\n" && c !== "\r" && c !== " " && c !== " " && /\s/u.test(c);

/** True when the text has Arabic-script (or any right-to-left) characters. */
export function hasRtl(text: string): boolean {
  return RTL.test(text);
}

/**
 * A clamped name (card titles, cart lines, release items) without Arabic script on a right-to-left page is laid out
 * left to right — so its ellipsis cuts its logical end («Pokémon Legends: Z-A – Nintendo…», never «…art World») — and
 * aligned to the page's start edge (`text-align: end` of a left-to-right line is the right edge). Spread the result on
 * the name's element. Pure.
 */
export function latinName(name: string, page: "ltr" | "rtl"): { dir?: "ltr"; className?: string } {
  return page === "rtl" && /\p{L}/u.test(name) && !hasRtl(name) ? { dir: "ltr", className: "text-end" } : {};
}

/** First-strong isolate (U+2068) and its end (U+2069). */
export const FSI = "⁨";
export const PDI = "⁩";

/**
 * A run isolated inside a plain string (a translated sentence): it takes the direction of its own first strong letter,
 * so an amount keeps its figure first in every language — «التوصيل 5,000 د.ع» reads the figure, then «د.ع» (a
 * left-to-right isolate, U+2066, would put «د.ع» first in Arabic). Names: «{name} في السلة».
 */
export function isolate(text: string): string {
  return FSI + text + PDI;
}

/**
 * A standalone signed number with its separators and an optional per-cent sign — "−2", "+3,000", "12.5%", "300" —
 * never the digits of a name ("PS5", "Switch 2" keep theirs).
 */
const NUMBER_RUN = /(?<![\p{L}\p{M}\p{Nd}])[+\-−]?\p{Nd}[\p{Nd},.٫٬]*%?(?![\p{L}\p{M}\p{Nd}])/gu;

/**
 * A value cut into its standalone signed numbers (left-to-right parts) and what lies between them (plain parts, in
 * the page's direction). Joining the parts gives the text back. Pure.
 */
export function splitNumbers(text: string): BidiPart[] {
  const parts: BidiPart[] = [];
  let last = 0;
  for (const match of text.matchAll(NUMBER_RUN)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), ltr: false });
    parts.push({ text: match[0], ltr: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), ltr: false });
  return parts;
}

function canStart(chars: string[], i: number): boolean {
  const c = chars[i];
  if (isWord(c)) return true;
  if (c === "+") return isDigit(chars[i + 1]);
  return c !== undefined && LEAD.has(c) && isWord(chars[i + 1]);
}

/** A bracket opening at `k` that closes on the same line around Latin only: the index after it, or -1. */
function groupEnd(chars: string[], k: number): number {
  const close = OPEN.get(chars[k]);
  if (!close) return -1;
  let word = false;
  for (let j = k + 1; j < chars.length; j++) {
    const c = chars[j];
    if (c === close) return word ? j + 1 : -1;
    if (isRtl(c) || OPEN.has(c) || CLOSE.has(c) || c === "\n") return -1;
    if (isWord(c)) word = true;
  }
  return -1;
}

/** Everything glued to the run so far (no spaces): words, glue between words, glued bracket groups, trailing signs. */
function tail(chars: string[], from: number): number {
  let k = from;
  while (k < chars.length) {
    const c = chars[k];
    const prev = chars[k - 1];
    const next = chars[k + 1];
    if (isWord(c)) {
      k++;
      continue;
    }
    const solidBefore = isWord(prev) || CLOSE.has(prev ?? "");
    if (GLUE.has(c) && solidBefore) {
      if (isWord(next)) {
        k++;
        continue;
      }
      const group = groupEnd(chars, k + 1); // (L)/(R)
      if (group > 0) {
        k = group;
        continue;
      }
    }
    if (c === "," && isDigit(prev) && isDigit(next)) {
      k++; // 25,000
      continue;
    }
    if (OPEN.has(c) && solidBefore) {
      const end = groupEnd(chars, k);
      if (end > 0) {
        k = end;
        continue;
      }
    }
    if (TRAIL.has(c) && (solidBefore || TRAIL.has(prev ?? ""))) {
      k++;
      continue;
    }
    break;
  }
  return k;
}

/** One token from a run start: an optional lead sign, then everything glued to it. */
function token(chars: string[], i: number): number {
  return tail(chars, isWord(chars[i]) ? i : i + 1);
}

/** Digits (with their separators, a range or a sign) and no letter: "2026", "25,000", "2023–2025", "20%". */
function isNumber(chars: string[], from: number, to: number): boolean {
  let digit = false;
  for (let j = from; j < to; j++) {
    if (LETTER.test(chars[j])) return false;
    if (isDigit(chars[j])) digit = true;
  }
  return digit;
}

/** The nearest letter before `i` is Arabic: a number there belongs to the Arabic sentence ("حزمة 2026", "لـ3"). */
function followsRtl(chars: string[], i: number): boolean {
  for (let j = i - 1; j >= 0; j--) {
    if (LETTER.test(chars[j])) return isRtl(chars[j]);
  }
  return false;
}

/** The next thing after `i` (past spaces) is an Arabic letter: "+ 3 مانگ" — the 3 counts the months. */
function precedesRtl(chars: string[], i: number): boolean {
  let j = i;
  while (isSpace(chars[j])) j++;
  return isRtl(chars[j]) && LETTER.test(chars[j]);
}

/** Past spaces, then one sign, then at least one space, then a token: where that token starts, or -1. */
function afterJoiner(chars: string[], s: number): number {
  let t = s + 1;
  const first = t;
  while (isSpace(chars[t])) t++;
  return t > first && canStart(chars, t) ? t : -1;
}

/** A whole left-to-right run starting at `i`: a Latin name across its spaces and joiners, or a number. */
function scanRun(chars: string[], i: number): number {
  let k = token(chars, i);
  if (isNumber(chars, i, k) && followsRtl(chars, i)) return k;
  for (;;) {
    let s = k;
    while (isSpace(chars[s])) s++;
    const spaced = s > k;
    // a name goes on across spaces: "Mario Kart World", "PlayStation 5", "007 First Light"
    if (spaced && canStart(chars, s)) {
      k = token(chars, s);
      continue;
    }
    // a bracket around Latin after a space: "Legion Go (2023)", "Joy-Con 2 (L)/(R)"
    if (spaced && OPEN.has(chars[s] ?? "")) {
      const end = groupEnd(chars, s);
      if (end > 0) {
        k = tail(chars, end);
        continue;
      }
    }
    // "Call of Duty: Modern Warfare 4"; spaced joiners: "Z-A – Nintendo Switch 2 Edition", "32GB / 1TB", "Switch 2 + Mario Kart World"
    if (chars[s] === ":" || (spaced && JOINER.has(chars[s] ?? ""))) {
      const t = afterJoiner(chars, s);
      if (t > 0) {
        const end = token(chars, t);
        if (!(isNumber(chars, t, end) && precedesRtl(chars, end))) {
          k = end;
          continue;
        }
      }
    }
    return k;
  }
}

/**
 * The text cut into plain parts (they follow the page's direction) and left-to-right runs (isolate each one).
 * Text without right-to-left script is one left-to-right part; "" is no part. Joining the parts gives the text back.
 */
export function splitBidi(text: string): BidiPart[] {
  if (!text) return [];
  if (!RTL.test(text)) return [{ text, ltr: true }];
  const chars = Array.from(text);
  const parts: BidiPart[] = [];
  let plain = 0;
  let i = 0;
  while (i < chars.length) {
    if (!canStart(chars, i)) {
      i++;
      continue;
    }
    const end = scanRun(chars, i);
    const run = chars.slice(i, end).join("");
    const last = parts.at(-1);
    if (i > plain) parts.push({ text: chars.slice(plain, i).join(""), ltr: false });
    else if (last?.ltr) last.text += run; // two runs that touch ("PS5$10") are one
    if (i > plain || !last?.ltr) parts.push({ text: run, ltr: true });
    plain = i = end;
  }
  if (plain < chars.length) parts.push({ text: chars.slice(plain).join(""), ltr: false });
  return parts;
}

/**
 * A product name or a sentence as the shopper should read it: a Latin-only text is one isolated left-to-right run;
 * inside Arabic or Kurdish text each Latin name and number is isolated with <bdi dir="ltr"> and the rest keeps the
 * page's direction.
 */
export function BidiText({ text }: { text: string }) {
  return (
    <>
      {splitBidi(text).map((part, index) =>
        part.ltr ? (
          <bdi key={index} dir="ltr">
            {part.text}
          </bdi>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/**
 * A value — an impact row, a table cell, a summary figure ("−2 قطعة", "−445,000 د.ع", "300 ← 450", "+3,000"): each
 * standalone signed number is one left-to-right run (its sign stays on its digits) and the rest keeps the page's
 * direction, so on an Arabic page "300 ← 450" reads from the right — 300, then the arrow on to 450. (A bare <bdi> lays
 * a value of numbers only out left to right, its digits having no direction of their own, and the arrow points back
 * at the old value.) Latin text without Arabic script stays one left-to-right isolate, like <BidiLabel>.
 */
export function BidiValue({ text, className }: { text: string; className?: string }) {
  if (/\p{L}/u.test(text) && !hasRtl(text)) {
    return (
      <bdi dir="ltr" className={className}>
        {text}
      </bdi>
    );
  }
  return (
    <span className={cx("bidi", className)}>
      {splitNumbers(text).map((part, index) =>
        part.ltr ? (
          <bdi key={index} dir="ltr">
            {part.text}
          </bdi>
        ) : hasRtl(part.text) ? (
          <BidiText key={index} text={part.text} />
        ) : (
          part.text
        ),
      )}
    </span>
  );
}

/**
 * The text a label shows, for choosing its direction and for accessible names ("أزل {label}"). Reads strings,
 * numbers, arrays, elements' children and a <BidiText text>.
 */
export function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode; text?: unknown };
    if (node.type === BidiText && typeof props.text === "string") return props.text;
    return textOf(props.children);
  }
  return "";
}

/**
 * A label isolated from what is around it, in the direction its words need — the kit's keys, chips, banks,
 * breadcrumbs, menu rows, steps and toasts use it (a plain <bdi> guesses the direction from the first letter, so
 * "PlayStation 5 Slim (نسخة الأقراص)" on an Arabic page came out left to right, the Arabic first).
 *
 *   · text and no Arabic-script letter in it → <bdi dir="ltr">: "PS5", "1 TB", "A+", "AI+" keep their order and signs;
 *   · Arabic script in it → an isolate in the page's own direction (`.bidi`), and a string label gets <BidiText>;
 *   · no text to read (a component that takes its words as props, an icon) → the page's direction too.
 */
export function BidiLabel({ children, className }: { children: ReactNode; className?: string }) {
  const text = textOf(children);
  if (text.trim() !== "" && !hasRtl(text)) {
    return (
      <bdi dir="ltr" className={className}>
        {children}
      </bdi>
    );
  }
  return <span className={cx("bidi", className)}>{typeof children === "string" ? <BidiText text={children} /> : children}</span>;
}
