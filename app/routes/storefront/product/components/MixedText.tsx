/**
 * Research text mixes scripts: "مجموعة Prism الشفافة (Flare Orange وEmerald Green)"، "اهتزاز Haptic · Adaptive
 * triggers"، "يد التحكم الأصلية لجهاز PS5." Left alone, the bidi algorithm joins neighbouring Latin words across a
 * "·" into one left-to-right run (so they read backwards in Arabic); isolating whole runs with their brackets and full
 * stops (as ~/ui/ProductCard's BidiText does for names) breaks bracket pairs and moves the full stop. So:
 *
 *   · every Latin/digit run is isolated left to right (DESIGN.md §13: Latin names inside Arabic go in <bdi>);
 *   · a number with comma thousands is ONE run ("25,000 د.ع" reads 25,000 — never "000,25"; design v2 spec §6.7);
 *   · a Latin name goes on across a spaced joiner — " / ", " + ", " – ", " - ", " & ", " | ", " × " — as the browser
 *     itself reads it: "Windows 11 Z1 Extreme 32GB / 1TB", "256GB + Pokémon Legends: Z-A", "Nintendo Switch – OLED
 *     Model" are ONE run (two isolates around the joiner would swap in Arabic: «1TB / … 32GB»). Not after a bare
 *     number ("39 × 191 × 141 ملم" keeps the sentence's order), and not onto a number that counts the Arabic after it
 *     ("+ 3 مانگ": three months);
 *   · brackets, separators and a run's trailing punctuation stay outside, in the sentence's own direction, where the
 *     browser mirrors and places them correctly;
 *   · text without Arabic script is left as it is (an English page needs no isolation).
 *
 * <MixedText> also keeps protected tokens on one line («Switch 2», «Z-A»: ../text keepTokens, design v2 §4.18).
 */
import type { ReactNode } from "react";

import { keepTokens } from "../text";

/** Hebrew, Arabic (with Kurdish and Persian letters), Syriac, Thaana, N'Ko, … and the Arabic presentation forms. */
const ARABIC_SCRIPT = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/u;
/**
 * A Latin/digit run: letters, digits and joiners inside a name, number, size or range ("USB-C", "3.5", "Z-A", "8TB",
 * "2–4", "1920×1080"; U+2011, the non-breaking hyphen of keepTokens, too), the thousands comma of a number ("25,000", "1,234,567": a
 * comma between a digit and exactly three digits), a bracket glued to it ("BEE-001(-01)"), and spaces (no-break ones
 * too) only before more Latin. A dash or bracket with a space before it ("متغير (VRR)") and a list comma ("PS4, PS5")
 * belong to the sentence; a spaced joiner between two names is joined afterwards (JOINER).
 */
const LATIN_RUN =
  /[\p{Script=Latin}\d](?:[\p{Script=Latin}\d'\u2019&.:+\-\u2010\u2011\u2013/|\u00d7]|(?<=\d),(?=\d{3}(?!\d))|\([\p{Script=Latin}\d'\u2019&.:+\-\u2010\u2011\u2013/|\u00d7]*\)|\s(?=[\p{Script=Latin}\d]))*/gu;
/** What a run may not end on: it belongs to the sentence ("PS5." → "PS5" + "."). */
const TRAILING = /[.'\u2019:&+\-\u2010\u2011\u2013/|]+$/u;
/** A joiner with a space (or a no-break space) on each side, between two runs: " / ", " + ", " – ", " & ", " × ". */
const JOINER = /^[ \u00a0][/+\u2013\-&|\u00d7][ \u00a0]$/u;
const LATIN_LETTER = /\p{Script=Latin}/u;
/** A bare number: digits and their separators, no letter ("3", "141", "2–4", "1,500"). */
const BARE_NUMBER = /^[\d.,\u066b\u066c\-\u2013\u2011]+$/u;
/** Plain text that goes on with Arabic or Sorani words (spaces first): "مانگ Nintendo…". */
const ARABIC_NEXT = /^\s*[\u0600-\u06ff]/u;

/** Splits text into plain parts and left-to-right runs (pure; exported for tests). */
export function splitMixed(text: string): { text: string; ltr: boolean }[] {
  if (!ARABIC_SCRIPT.test(text)) return [{ text, ltr: false }];
  const parts: { text: string; ltr: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(LATIN_RUN)) {
    const start = match.index ?? 0;
    const run = match[0].replace(TRAILING, "");
    if (run.length === 0) continue;
    if (start > last) parts.push({ text: text.slice(last, start), ltr: false });
    parts.push({ text: run, ltr: true });
    last = start + run.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), ltr: false });
  // one name across a spaced joiner: the run before it has a Latin letter (a bare number that follows Arabic keeps the
  // sentence's order), and the run after it is not a number counting the Arabic words that follow it
  for (let i = 0; i + 2 < parts.length; ) {
    const [left, joiner, right] = [parts[i], parts[i + 1], parts[i + 2]];
    const counts = BARE_NUMBER.test(right.text) && ARABIC_NEXT.test(parts[i + 3]?.text ?? "");
    if (left.ltr && !joiner.ltr && right.ltr && JOINER.test(joiner.text) && LATIN_LETTER.test(left.text) && !counts) {
      parts.splice(i, 3, { text: left.text + joiner.text + right.text, ltr: true });
      continue; // the longer run may go on across the next joiner
    }
    i++;
  }
  return parts;
}

export function MixedText({ text }: { text: string }): ReactNode {
  const kept = keepTokens(text);
  const parts = splitMixed(kept);
  if (parts.length === 1 && !parts[0].ltr) return kept;
  return parts.map((part, index) =>
    part.ltr ? (
      <bdi key={index} dir="ltr">
        {part.text}
      </bdi>
    ) : (
      part.text
    ),
  );
}
