/**
 * Research text mixes scripts: "مجموعة Prism الشفافة (Flare Orange وEmerald Green)"، "اهتزاز Haptic · Adaptive
 * triggers"، "يد التحكم الأصلية لجهاز PS5." Left alone, the bidi algorithm joins neighbouring Latin words across a
 * "·" into one left-to-right run (so they read backwards in Arabic); isolating whole runs with their brackets and full
 * stops (as ~/ui/ProductCard's BidiText does for names) breaks bracket pairs and moves the full stop. So:
 *
 *   · every Latin/digit run is isolated left to right (DESIGN.md §13: Latin names inside Arabic go in <bdi>);
 *   · brackets, separators and a run's trailing punctuation stay outside, in the sentence's own direction, where the
 *     browser mirrors and places them correctly;
 *   · text without Arabic script is left as it is (an English page needs no isolation).
 */
import type { ReactNode } from "react";

const ARABIC_SCRIPT = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
/**
 * A Latin/digit run: letters, digits and joiners inside a name, number, size or range ("USB-C", "3.5", "Z-A", "8TB",
 * "2–4", "1920×1080"), a bracket glued to it ("BEE-001(-01)"), and spaces only before more Latin. A dash or bracket with
 * a space before it ("Nova 7 – Black", "متغير (VRR)") belongs to the sentence.
 */
const LATIN_RUN = /[\p{Script=Latin}\d](?:[\p{Script=Latin}\d'’&.:+\-–/|×]|\([\p{Script=Latin}\d'’&.:+\-–/|×]*\)|\s(?=[\p{Script=Latin}\d]))*/gu;
/** What a run may not end on: it belongs to the sentence ("PS5." → "PS5" + "."). */
const TRAILING = /[.'’:&+\-–/|]+$/u;

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
  return parts;
}

export function MixedText({ text }: { text: string }): ReactNode {
  const parts = splitMixed(text);
  if (parts.length === 1 && !parts[0].ltr) return text;
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
