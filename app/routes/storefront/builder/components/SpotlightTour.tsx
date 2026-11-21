/**
 * A spotlight guide over a rendered page (docs/switch-builder.md §6.7): the page dims, the part being explained stays
 * lit and ringed, and an opaque note beside it says what the part means. The builder drives it through
 * ./BuilderTour (useBuilderTour); this component only shows one guide.
 *
 *   <SpotlightTour steps={[{ target: "meter", title, text }, …]} index={i} labels={…} leaving={!open}
 *                  onNext={…} onBack={…} onSkip={…} onFinish={…} onMissing={(target) => …} onExited={…} />
 *
 * How it is drawn (DESIGN.md: no box-shadow spread, no animated clip-path, only transform and opacity move):
 *   · the dim is one --scrim layer with a `clip-path: path(evenodd, …)` cut-out — the viewport minus a rounded hole
 *     around the part (8px of air), measured with getBoundingClientRect (physical px, so it is right in RTL too);
 *   · a 2px --focus ring sits just outside the hole; the scrim and the ring are one layer, and between two parts the
 *     old layer fades out while the new one fades in (two layers take turns) — the clip itself never animates;
 *   · the shell's bars (the sticky header, the offline banner, the task or tab bar) stay under the dim: the hole never
 *     reaches over a bar unless the part sits in that bar (the task bar's «تابع»), so a bar's keys are never lit at full
 *     strength beside a part they do not belong to;
 *   · the note is an opaque --paper card with the counter «2 من 5», «تخطَّ» first, the title, the text, a screen-reader
 *     line naming the lit part, and «السابق» / «التالي» («أنهِ الدليل» on the last part). It is placed beside the hole
 *     with the menus' own placement (~/ui/Menu placeMenu); when neither side has room it docks at the screen edge away
 *     from the part and the hole is trimmed so the two never overlap. The first note is there from the first frame
 *     (only the dim fades in); later notes arrive with the menus' 8px drop (materialize);
 *   · a part taller than the room the docked note leaves (a long list on a phone) keeps one end in view — its start, or
 *     its end when the step says so (`keep: "end"`: the review's lines end on the total their note talks about) — and
 *     the hole stops in the gap between two of its rows (a list's options, the review's lines), never across one.
 * Each part is brought into view first (scrollIntoView works under the modal layer's scroll lock; the page's
 * scroll-padding keeps it clear of the sticky header and the task bar), and everything is measured again on resize,
 * on scroll, when the part or the note changes size and when the fonts arrive. When the guide closes the page goes back
 * to the scroll position it had. A part that left the page is reported (`onMissing`) so the guide skips it.
 *
 * Behaviour comes from the kit's modal layer (~/ui/Dialog useOverlayRoot + useModalLayer): the page behind is inert and
 * does not scroll, the focus moves to the note (a labelled dialog) and is trapped, Escape and Android's back skip, and
 * the focus goes back to what opened it (the «?» key). The note stays the same element from part to part: the focus
 * stays on the key that was pressed (one Enter per part; when «السابق» disappears on the first part the focus goes to
 * «التالي»), and the new part is said by a polite status line inside the note. ← / → move through the parts in the
 * reading direction (announced as the keys' aria-keyshortcuts). Tapping the dim does nothing. Reduced motion: fades
 * only (fadeElement / materialize turn into 120ms cross-fades).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { materialize } from "~/motion";
import { fadeElement, useModalLayer, useOverlayRoot } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { placeMenu } from "~/ui/Menu";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import "../builder-sheet.css";

export type SpotlightStep = {
  /** The `data-tour` value of the part to light. */
  target: string;
  title: string;
  text: string;
  /** Which end of the part stays in view when it is taller than the room the note leaves (default: its start). */
  keep?: "start" | "end";
};

export type SpotlightLabels = {
  next: string;
  back: string;
  skip: string;
  finish: string;
  /** «2 من 5». */
  count: (n: number, total: number) => string;
  /** The screen-reader line that names the lit part: «الجزء المُضاء من الصفحة: …». */
  highlighted: (name: string) => string;
};

export type SpotlightTourProps = {
  steps: readonly SpotlightStep[];
  index: number;
  labels: SpotlightLabels;
  /** The guide was closed: it fades out, then calls `onExited`. */
  leaving: boolean;
  onNext: () => void;
  onBack: () => void;
  /** «تخطَّ», Escape, Android's back. */
  onSkip: () => void;
  /** The last part's «أنهِ الدليل». */
  onFinish: () => void;
  /** The part on screen is not on the page (any more). */
  onMissing: (target: string) => void;
  onExited: () => void;
};

/* ───────────────────────────── geometry (pure) ───────────────────────────── */

export type Box = { left: number; top: number; right: number; bottom: number };
/** A stretch of the block axis (the room between the bars, the room beside the note). */
export type Band = { top: number; bottom: number };

/** Air between the part and the edge of the hole. */
export const HOLE_PADDING = 8;
/** The hole never touches the screen's edge or a bar. */
const HOLE_EDGE = 4;
/** The smallest hole worth drawing. */
const MIN_HOLE = 24;
/** The ring's width, drawn just outside the hole. */
const RING = 2;
const NOTE_GAP = 12;
const NOTE_MARGIN = 16;

/** The air around a part: 8px, less around a small inline part (a figure in a line) so the ring keeps off its neighbours. */
export function holePadding(part: Box): number {
  const side = Math.min(part.right - part.left, part.bottom - part.top);
  return Math.max(4, Math.min(HOLE_PADDING, Math.round(side / 4)));
}

/** The hole around a part's box, with air, kept inside the viewport. Pure. */
export function holeAround(part: Box, view: { width: number; height: number }, padding = holePadding(part)): Box {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
  const left = clamp(part.left - padding, HOLE_EDGE, view.width - HOLE_EDGE);
  const top = clamp(part.top - padding, HOLE_EDGE, view.height - HOLE_EDGE);
  const right = clamp(part.right + padding, left, view.width - HOLE_EDGE);
  const bottom = clamp(part.bottom + padding, top, view.height - HOLE_EDGE);
  return { left, top, right, bottom };
}

/**
 * One row of a part, top to bottom, to cut the hole between rows: its extent on the block axis and the rows inside it
 * (none: it is one piece — a card, a line of the review, children side by side).
 */
export type RowBox = { top: number; bottom: number; rows: () => readonly RowBox[] };

/** A clean cut: `kept` = the edge of the content that stays lit, `cut` = the edge of the first content left out. */
export type CutAt = { kept: number; cut: number };

/**
 * Where to cut a part at `y` without slicing a row: the rows that end before `y` stay (`keep: "start"`), or those that
 * start after it (`keep: "end"`); a row across `y` is looked into (a list inside a section), and left out whole when
 * it is one piece. Null when nothing whole is left on the kept side at this level (the caller cuts beside this row).
 * Pure: the rows are read through `rows()` only where the cut needs them.
 */
export function cleanCut(node: RowBox, y: number, keep: "start" | "end", depth = 0): CutAt | null {
  if (depth > 8) return null;
  const rows = node.rows();
  if (rows.length === 0) return null;
  const across = rows.find((row) => row.top < y && row.bottom > y);
  if (across) {
    const inner = cleanCut(across, y, keep, depth + 1);
    if (inner) return inner;
  }
  if (keep === "start") {
    const line = across ? across.top : y;
    const kept = rows.filter((row) => row.bottom <= line);
    if (kept.length === 0) return null;
    const keptEdge = Math.max(...kept.map((row) => row.bottom));
    const rest = rows.filter((row) => row.bottom > line);
    const cutEdge = rest.length > 0 ? Math.min(...rest.map((row) => row.top)) : node.bottom;
    return { kept: keptEdge, cut: Math.max(cutEdge, keptEdge) };
  }
  const line = across ? across.bottom : y;
  const kept = rows.filter((row) => row.top >= line);
  if (kept.length === 0) return null;
  const keptEdge = Math.min(...kept.map((row) => row.top));
  const rest = rows.filter((row) => row.top < line);
  const cutEdge = rest.length > 0 ? Math.max(...rest.map((row) => row.bottom)) : node.top;
  return { kept: keptEdge, cut: Math.min(cutEdge, keptEdge) };
}

/**
 * The hole kept inside `room` on the block axis. Where it would reach past the room (under a bar, under the docked
 * note), it stops in the gap between two rows of the part — half the gap of air, at most `padding` — so the ring never
 * runs across a card or a line; without rows, or when no whole row fits, it stops at the room's edge. Pure.
 */
export function holeInRoom(hole: Box, room: Band, padding: number, rows: RowBox | null): Box {
  const air = (at: CutAt) => Math.min(padding, Math.abs(at.cut - at.kept) / 2);
  let { top, bottom } = hole;
  if (bottom > room.bottom) {
    const at = rows ? cleanCut(rows, room.bottom, "start") : null;
    bottom = at && at.kept - top >= MIN_HOLE ? Math.min(room.bottom, at.kept + air(at)) : room.bottom;
  }
  if (top < room.top) {
    const at = rows ? cleanCut(rows, room.top, "end") : null;
    top = at && bottom - at.kept >= MIN_HOLE ? Math.max(room.top, at.kept - air(at)) : room.top;
  }
  if (bottom - top < MIN_HOLE) {
    // a room too small for a hole worth the name: the smallest one, as far inside the room as it goes
    bottom = Math.max(bottom, Math.min(room.bottom, top + MIN_HOLE));
    top = Math.min(top, bottom - MIN_HOLE);
  }
  return { ...hole, top, bottom };
}

const n = (value: number) => String(Math.round(value * 10) / 10);

/** The evenodd path of the dim: the whole viewport, minus a rounded rectangle. Pure. */
export function spotlightClip(view: { width: number; height: number }, hole: Box, radius: number): string {
  const r = Math.max(0, Math.min(radius, (hole.right - hole.left) / 2, (hole.bottom - hole.top) / 2));
  const { left: x0, top: y0, right: x1, bottom: y1 } = hole;
  const outer = `M0 0H${n(view.width)}V${n(view.height)}H0Z`;
  const inner =
    `M${n(x0 + r)} ${n(y0)}H${n(x1 - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x1)} ${n(y0 + r)}V${n(y1 - r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x1 - r)} ${n(y1)}H${n(x0 + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x0)} ${n(y1 - r)}V${n(y0 + r)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(x0 + r)} ${n(y0)}Z`;
  return `path(evenodd, "${outer} ${inner}")`;
}

/** Cut a name at a word to about `max` characters, with «…» at its end. Pure. */
export function clipName(text: string, max = 100): string {
  const words = text.replace(/\s+/g, " ").trim();
  if (words.length <= max) return words;
  const cut = words.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s،,:;·]+$/u, "")}…`;
}

/* ───────────────────────────── the page's parts ───────────────────────────── */

/** The first part with this `data-tour` value that is on screen (a part may exist twice: the task bar and the aside). */
export function visibleTarget(target: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const element of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(target)}"]`)) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden") return element;
  }
  return null;
}

/** The shell's bars, as its focus rule names them (shell/ShellFrame): what sticks at the top, what is fixed at the bottom. */
const TOP_BARS = ".shell-header, .shell-cobar, .shell-offline";
const BOTTOM_BARS = ".shell-tabbar, .shell-taskbar";

/**
 * The stretch of the screen no bar covers, in the host's coordinates: under the sticky bars at the top, above the
 * fixed ones at the bottom. A bar that holds the part itself is not in its way; a bar that is not drawn does not count.
 */
function openBand(element: HTMLElement, view: DOMRect): Band {
  let top = 0;
  let bottom = view.height;
  for (const bar of document.querySelectorAll<HTMLElement>(TOP_BARS)) {
    if (bar.contains(element)) continue;
    const box = bar.getBoundingClientRect();
    if (box.height > 0 && box.bottom > view.top && box.top < view.top + view.height / 2) top = Math.max(top, box.bottom - view.top);
  }
  for (const bar of document.querySelectorAll<HTMLElement>(BOTTOM_BARS)) {
    if (bar.contains(element)) continue;
    const box = bar.getBoundingClientRect();
    if (box.height > 0 && box.top < view.top + view.height && box.top > view.top + view.height / 2) bottom = Math.min(bottom, box.top - view.top);
  }
  return { top, bottom: Math.max(bottom, top) };
}

/** Elements that are one piece to the eye: an item, a choice, a line of text, a control. A cut never goes inside them. */
const ONE_PIECE =
  "li, label, tr, p, h1, h2, h3, h4, h5, h6, legend, figure, button, a, img, svg, [role='listitem'], [role='option'], [role='radio'], [role='checkbox'], [role='switch'], [role='button']";

/** A computed colour with no alpha: `transparent`, `rgba(0, 0, 0, 0)`, `oklch(0 0 0 / 0)`. */
const clear = (color: string) => color === "" || color === "transparent" || /(?:,|\/)\s*0(?:\.0+)?\s*\)$/.test(color);

/** One piece: a kind of element that is (ONE_PIECE), or a box the eye sees as one — a ground, a border, a shadow. */
function onePiece(element: Element): boolean {
  if (element.matches(ONE_PIECE)) return true;
  const style = getComputedStyle(element);
  const painted = !clear(style.backgroundColor) || style.backgroundImage !== "none";
  const framed = Number.parseFloat(style.borderTopWidth) > 0 || Number.parseFloat(style.borderBottomWidth) > 0 || style.boxShadow !== "none";
  return painted || framed;
}

/** An element as a row: its own box, and its rows read only when a cut looks inside it (none when it is one piece). */
function rowOf(element: Element, offset: number, box: DOMRect): RowBox {
  return { top: box.top - offset, bottom: box.bottom - offset, rows: () => (onePiece(element) ? [] : rowsOf(element, offset)) };
}

/** The part as the root of its rows: always looked into, whatever box it draws (the review's lines are a card). */
function partRows(element: Element, offset: number, box: DOMRect): RowBox {
  return { top: box.top - offset, bottom: box.bottom - offset, rows: () => rowsOf(element, offset) };
}

/** An element's laid-out children, top to bottom; children side by side (overlapping on the block axis) are one row. */
function rowsOf(element: Element, offset: number): RowBox[] {
  const boxes: Array<{ element: Element; box: DOMRect }> = [];
  for (const child of element.children) {
    const box = child.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const position = getComputedStyle(child).position;
    if (position === "absolute" || position === "fixed") continue;
    boxes.push({ element: child, box });
  }
  boxes.sort((a, b) => a.box.top - b.box.top);
  const rows: Array<{ members: typeof boxes; top: number; bottom: number }> = [];
  for (const entry of boxes) {
    const last = rows.at(-1);
    if (last && entry.box.top < last.bottom - 1) {
      last.members.push(entry);
      last.bottom = Math.max(last.bottom, entry.box.bottom);
    } else {
      rows.push({ members: [entry], top: entry.box.top, bottom: entry.box.bottom });
    }
  }
  return rows.map((row) =>
    row.members.length === 1 ? rowOf(row.members[0].element, offset, row.members[0].box) : { top: row.top - offset, bottom: row.bottom - offset, rows: () => [] },
  );
}

/** The words assistive technology reads in a node: aria-hidden, hidden and undisplayed parts left out. */
function spokenText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof Element)) return "";
  if (node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden") || getComputedStyle(node).display === "none") return "";
  const label = node.getAttribute("aria-label");
  if (label && label.trim() !== "") return ` ${label} `;
  let text = "";
  for (const child of node.childNodes) text += spokenText(child);
  return ` ${text} `;
}

/** aria-label, else the words of what aria-labelledby points at. */
function labelOf(element: Element): string {
  const label = element.getAttribute("aria-label");
  if (label && label.trim() !== "") return label;
  const ids = element.getAttribute("aria-labelledby");
  if (!ids) return "";
  return ids
    .split(/\s+/)
    .map((id) => {
      const source = document.getElementById(id);
      return source ? spokenText(source) : "";
    })
    .join(" ")
    .trim();
}

/** Where a part's name may come from, in order: its heading, a labelled landmark or meter inside it, its field. */
const HEADINGS = "h1, h2, h3, h4, h5, h6, legend, [role='heading']";
const NAMED = "[role='meter'], [role='progressbar'], nav, [role='navigation'], [role='group'], [role='radiogroup'], section, [role='region']";
const FIELDS = "input:not([type='hidden']), select, textarea";

/**
 * What a screen reader would call the part (the note's «الجزء المُضاء من الصفحة: …» line): its own label; else its
 * heading; else a labelled landmark or meter inside it; else its field's label; else its words — never what is hidden
 * from assistive technology (the meter's figure is said once, not its sr-only copy and its drawn one), cut at a word.
 */
function nameOf(element: HTMLElement): string {
  // hidden from assistive technology on the way up to the part (whatever the page around it does)
  const hidden = (node: Element) => {
    for (let at: Element | null = node; at && at !== element.parentElement; at = at.parentElement) {
      if (at.getAttribute("aria-hidden") === "true" || at.hasAttribute("hidden")) return true;
    }
    return false;
  };
  const own = labelOf(element);
  if (own) return clipName(own);
  const heading = [...element.querySelectorAll(HEADINGS)].find((node) => !hidden(node));
  const headingText = heading ? spokenText(heading).trim() : "";
  if (headingText) return clipName(headingText);
  const named = [...element.querySelectorAll(NAMED)].find((node) => !hidden(node) && labelOf(node) !== "");
  if (named) return clipName(labelOf(named));
  const field = [...element.querySelectorAll<HTMLInputElement>(FIELDS)].find((node) => !hidden(node));
  const fieldText = field ? (field.labels?.[0] ? spokenText(field.labels[0]) : labelOf(field)).trim() : "";
  if (fieldText) return clipName(fieldText);
  return clipName(spokenText(element));
}

/** The hole's corner: the part's own corner plus the air, at most half the hole. */
function holeRadius(element: HTMLElement, hole: Box, padding: number): number {
  const style = getComputedStyle(element);
  const own = Number.parseFloat(style.borderStartStartRadius || style.borderTopLeftRadius || "0");
  const radius = (Number.isFinite(own) && own > 0 ? own : 12) + padding;
  return Math.min(radius, (hole.right - hole.left) / 2, (hole.bottom - hole.top) / 2);
}

/* ───────────────────────────── the overlay ───────────────────────────── */

/** What a drawing found: whether the note had to dock at an edge, and whether the part is taller than its room. */
type Drawn = { docked: boolean; tall: boolean };

export function SpotlightTour({ steps, index, labels, leaving, onNext, onBack, onSkip, onFinish, onMissing, onExited }: SpotlightTourProps) {
  const root = useOverlayRoot();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const note = useRef<HTMLDivElement | null>(null);
  const mainKey = useRef<HTMLButtonElement | null>(null);
  const layerA = useRef<HTMLDivElement | null>(null);
  const layerB = useRef<HTMLDivElement | null>(null);
  /** The layer that shows the current part (they take turns). */
  const front = useRef<0 | 1>(0);
  const shown = useRef(false);
  /** Where the page was scrolled when the guide came (it goes back there). */
  const scrollAt = useRef<{ x: number; y: number } | null>(null);
  const [litName, setLitName] = useState("");
  /** The polite status line inside the note: says each part after the first (the focus stays on the pressed key). */
  const [said, setSaid] = useState("");
  const titleId = useId();
  const textId = useId();
  const litId = useId();
  const step = steps[index] ?? null;
  const last = index >= steps.length - 1;

  const latest = useRef({ step, onMissing, onExited });
  useLayoutEffect(() => {
    latest.current = { step, onMissing, onExited };
  });

  useModalLayer({ root, host, active: !leaving, onEscape: onSkip, initialFocus: () => note.current });

  /** Draws the current part on layer `which`; null when the part is not on screen. */
  const draw = (which: 0 | 1): Drawn | null => {
    const current = latest.current.step;
    const layer = (which === 0 ? layerA : layerB).current;
    const card = note.current;
    if (!host || !layer || !card || !current) return null;
    const element = visibleTarget(current.target);
    if (!element) return null;
    const view = host.getBoundingClientRect();
    const size = { width: view.width, height: view.height };
    const rtl = getComputedStyle(host).direction === "rtl";
    const rect = element.getBoundingClientRect();
    const part = { left: rect.left - view.left, top: rect.top - view.top, right: rect.right - view.left, bottom: rect.bottom - view.top };
    const padding = holePadding(part);
    // the room between the bars that do not hold the part (they stay under the dim)
    const band = openBand(element, view);
    const room: Band = { top: band.top + HOLE_EDGE, bottom: band.bottom - HOLE_EDGE };
    const rows = partRows(element, view.top, rect);
    let hole = holeInRoom(holeAround(part, size, padding), room, padding, rows);

    // the note: beside the hole when one side has room for it, else docked at a screen edge
    const noteSize = { width: card.offsetWidth, height: card.offsetHeight };
    const place = placeMenu(hole, noteSize, size, { rtl, align: "start", gap: NOTE_GAP, margin: NOTE_MARGIN });
    let tall = false;
    if (place.maxHeight >= noteSize.height) {
      card.removeAttribute("data-dock");
      card.style.insetInlineStart = `${place.inlineStart}px`;
      card.style.insetBlockStart = `${place.blockStart}px`;
    } else {
      // A part taller than the room a docked note leaves (on either edge) keeps the end its guide asks for in view: its
      // start with the note at the bottom, or its end with the note at the top. Any other part: the note docks at the
      // edge away from it.
      const need = part.bottom - part.top + 2 * padding;
      const underTopNote = room.bottom - Math.max(room.top, NOTE_MARGIN + noteSize.height + NOTE_GAP);
      const overBottomNote = Math.min(room.bottom, size.height - NOTE_MARGIN - noteSize.height - NOTE_GAP) - room.top;
      tall = need > Math.max(underTopNote, overBottomNote);
      const dock = tall ? (current.keep === "end" ? "start" : "end") : (hole.top + hole.bottom) / 2 < size.height / 2 ? "end" : "start";
      card.setAttribute("data-dock", dock);
      card.style.removeProperty("inset-inline-start");
      card.style.removeProperty("inset-block-start");
      const box = card.getBoundingClientRect();
      // the hole stops short of the note, in a gap between two rows of the part where it can
      const beside: Band =
        dock === "end" ? { top: room.top, bottom: Math.min(room.bottom, box.top - view.top - NOTE_GAP) } : { top: Math.max(room.top, box.bottom - view.top + NOTE_GAP), bottom: room.bottom };
      hole = holeInRoom(holeAround(part, size, padding), beside, padding, rows);
    }

    const radius = holeRadius(element, hole, padding);
    const scrim = layer.querySelector<HTMLElement>(".sbt-scrim");
    const ring = layer.querySelector<HTMLElement>(".sbt-ring");
    if (scrim) scrim.style.clipPath = spotlightClip(size, hole, radius);
    if (ring) {
      ring.style.insetInlineStart = `${(rtl ? size.width - hole.right : hole.left) - RING}px`;
      ring.style.insetBlockStart = `${hole.top - RING}px`;
      ring.style.inlineSize = `${hole.right - hole.left + 2 * RING}px`;
      ring.style.blockSize = `${hole.bottom - hole.top + 2 * RING}px`;
      ring.style.setProperty("--sbt-radius", `${radius + RING}px`);
    }
    return { docked: card.hasAttribute("data-dock"), tall };
  };

  // A new part: bring it into view, draw it on the other layer, cross-fade, move the note, say it.
  useLayoutEffect(() => {
    if (!host || leaving || !step) return;
    const element = visibleTarget(step.target);
    if (!element) {
      onMissing(step.target);
      return;
    }
    if (scrollAt.current === null) scrollAt.current = { x: window.scrollX, y: window.scrollY };
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const previous = front.current;
    const next: 0 | 1 = shown.current ? (previous === 0 ? 1 : 0) : 0;
    front.current = next;
    const drawn = draw(next);
    // docked: the part is tall or at an edge — give it the rest of the screen and draw again: its start under the
    // header (the note at the bottom), or, for a tall part that keeps its end, its end above the bottom bar
    if (drawn?.docked) {
      element.scrollIntoView({ block: drawn.tall && step.keep === "end" ? "end" : "start", inline: "nearest", behavior: "instant" });
      draw(next);
    }
    const incoming = next === 0 ? layerA.current : layerB.current;
    const outgoing = next === 0 ? layerB.current : layerA.current;
    if (incoming) void fadeElement(incoming, 1);
    if (shown.current && outgoing) void fadeElement(outgoing, 0);
    const name = nameOf(element);
    const card = note.current;
    if (card) {
      if (shown.current) {
        // the next notes drop in like a menu; the focus stays on the key that was pressed — only when that key has
        // gone («السابق» on the first part) or the focus is not in the note does it go to «التالي»
        const box = element.getBoundingClientRect();
        void materialize(card, { from: { x: box.left + box.width / 2, y: box.top + box.height / 2 } });
        if (!card.contains(document.activeElement)) mainKey.current?.focus({ preventScroll: true });
        // the focus did not move, so nothing else would say the new part: the note's status line does
        setSaid(`${labels.count(index + 1, steps.length)}. ${step.title}. ${step.text} ${name ? labels.highlighted(name) : ""}`.trim());
      } else {
        // the first note is there from the first frame («تخطَّ» with it), and read as the dialog it is
        card.focus({ preventScroll: true });
      }
    }
    shown.current = true;
    setLitName(name);
    // one run per part shown — never on a mere re-render of the page (that would pull the focus back to the note)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draw reads the latest props
  }, [host, index, step?.target, leaving]);

  // Keep the cut-out on its part: resize, scroll (rails, the sheet under it), the part or the note changing size, fonts.
  useEffect(() => {
    if (!host || leaving) return;
    let frame = 0;
    const redraw = () => {
      frame = 0;
      if (draw(front.current)) return;
      const current = latest.current.step;
      if (current && !visibleTarget(current.target)) latest.current.onMissing(current.target);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(redraw);
    };
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    const element = step ? visibleTarget(step.target) : null;
    if (element) observer?.observe(element);
    if (note.current) observer?.observe(note.current);
    void document.fonts?.ready.then(schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, { capture: true });
      observer?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-armed for each part
  }, [host, index, step?.target, leaving]);

  // Leaving: the page goes back to where it was, the whole guide fades, then it unmounts.
  const wasLeaving = useRef(false);
  useLayoutEffect(() => {
    if (!leaving) {
      if (wasLeaving.current && host) void fadeElement(host, 1); // opened again while it was leaving
      wasLeaving.current = false;
      return;
    }
    wasLeaving.current = true;
    const at = scrollAt.current;
    if (at) window.scrollTo({ left: at.x, top: at.y, behavior: "instant" });
    scrollAt.current = null;
    if (!host) {
      latest.current.onExited();
      return;
    }
    let cancelled = false;
    void fadeElement(host, 0).then(() => {
      if (!cancelled) latest.current.onExited();
    });
    return () => {
      cancelled = true;
    };
  }, [leaving, host]);

  if (!root || !step) return null;

  // ← / → in the reading direction: forward is → in English, ← in Arabic and Sorani
  const rtl = root.closest("[dir]")?.getAttribute("dir") === "rtl";
  const forwardKey = rtl ? "ArrowLeft" : "ArrowRight";
  const backwardKey = rtl ? "ArrowRight" : "ArrowLeft";
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const forward = (event.key === "ArrowRight") !== (getComputedStyle(event.currentTarget).direction === "rtl");
    event.preventDefault();
    if (forward) {
      if (last) onFinish();
      else onNext();
    } else if (index > 0) {
      onBack();
    }
  };

  return createPortal(
    <div ref={setHost} className="sbt" inert={leaving || undefined}>
      <div ref={layerA} className="sbt-layer" aria-hidden="true">
        <div className="sbt-scrim" />
        <div className="sbt-ring" />
      </div>
      <div ref={layerB} className="sbt-layer" aria-hidden="true">
        <div className="sbt-scrim" />
        <div className="sbt-ring" />
      </div>
      {/* one note for every part (no remount): the focus stays where the shopper pressed */}
      <div
        ref={note}
        className="sbt-note"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${textId} ${litId}`}
        tabIndex={-1}
        data-layer-panel=""
        onKeyDown={onKeyDown}
      >
        <div className="sbt-note__head">
          <p className="sbt-note__count nums">{labels.count(index + 1, steps.length)}</p>
          {/* «تخطَّ» is the first stop of the note, there from the first frame */}
          <Key variant="ghost" size="sm" onClick={onSkip} className="sbt-note__skip">
            {labels.skip}
          </Key>
        </div>
        <h2 id={titleId} className="sbt-note__title">
          {step.title}
        </h2>
        <p id={textId} className="sbt-note__text">
          {step.text}
        </p>
        <VisuallyHidden id={litId}>{litName ? labels.highlighted(litName) : ""}</VisuallyHidden>
        <VisuallyHidden role="status">{said}</VisuallyHidden>
        <div className="sbt-note__keys">
          {index > 0 ? (
            <Key variant="ghost" size="sm" icon="arrow-left" onClick={onBack} aria-keyshortcuts={backwardKey}>
              {labels.back}
            </Key>
          ) : null}
          <Key ref={mainKey} size="sm" iconEnd={last ? undefined : "arrow-right"} onClick={last ? onFinish : onNext} aria-keyshortcuts={forwardKey}>
            {last ? labels.finish : labels.next}
          </Key>
        </div>
      </div>
    </div>,
    root,
  );
}
