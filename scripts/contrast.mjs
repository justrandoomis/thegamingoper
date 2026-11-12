#!/usr/bin/env node
/**
 * Token contrast — docs/DESIGN.md §5.4. Reads app/styles/tokens.css (the light block, the dark block and the core
 * :root blocks), resolves var() references per theme, composites translucent colours over their real backdrop and
 * checks every text and boundary pair of the system with the WCAG 2.x formula.
 *
 *   node scripts/contrast.mjs            print every pair; exit 1 if a required pair fails
 *   node scripts/contrast.mjs --json     machine-readable rows
 *
 * Needs: 4.5 for text, 3 for boundaries, states, focus rings and large display text. Two rows are DEMONSTRATIONS:
 * they must fail, because the rule they justify exists for that reason (no sheen behind tile text; dark dots use the
 * dark values) — if one of them ever passes, the rule may be revisited and the script says so.
 * Adapted from the design spec's contrast.mjs (…/scratchpad/ux/spec-work/contrast.mjs), which checked fixed values.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JSON_OUT = process.argv.includes("--json");
const css = readFileSync(path.join(ROOT, "app/styles/tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/* ── the top-level blocks of tokens.css (media queries and nested rules are skipped) ── */
function topBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) {
        selector = text.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        blocks.push({ selector: selector.replace(/\s+/g, " "), body: text.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return blocks;
}
function declarations(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const blocks = topBlocks(css);
const core = Object.assign({}, ...blocks.filter((b) => b.selector === ":root").map((b) => declarations(b.body)));
const lightBlock = blocks.find((b) => /^:root, \[data-theme="light"\]$/.test(b.selector));
const darkBlock = blocks.find((b) => b.selector === '[data-theme="dark"]');
if (!lightBlock || !darkBlock) {
  console.error("contrast: could not find the light and dark theme blocks in app/styles/tokens.css");
  process.exit(2);
}
const THEMES = {
  light: { ...core, ...declarations(lightBlock.body) },
  dark: { ...core, ...declarations(lightBlock.body), ...declarations(darkBlock.body) },
};

/* ── colours ── */
function resolve(theme, value, seen = new Set()) {
  return value.replace(/var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)/g, (_, name, fallback) => {
    if (seen.has(name)) throw new Error(`cycle at ${name}`);
    const raw = THEMES[theme][name];
    if (raw === undefined) {
      if (fallback !== undefined) return resolve(theme, fallback, seen);
      throw new Error(`${name} is not defined in the ${theme} theme`);
    }
    return resolve(theme, raw, new Set([...seen, name]));
  });
}
/** "#abc" | "#aabbcc" | "rgb(r g b)" | "rgb(r g b / a)" | "transparent" → { rgb: [r,g,b], a } */
function parse(colour) {
  const c = colour.trim().toLowerCase();
  if (c === "transparent") return { rgb: [0, 0, 0], a: 0 };
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join("") : m[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(c);
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [m[1], m[2], m[3]].map(Number), a };
  }
  throw new Error(`not a colour: ${colour}`);
}
/** A token name ("--ink"), a literal ("#ffffff") or an object { over: fg, on: bg } composited first. */
function colour(theme, spec, backdrop) {
  if (typeof spec === "object") return composite(colour(theme, spec.over, null), colour(theme, spec.on, backdrop));
  const c = parse(spec.startsWith("--") ? resolve(theme, `var(${spec})`) : spec);
  if (c.a >= 1 || !backdrop) return c;
  return composite(c, backdrop);
}
function composite(fg, bg) {
  if (fg.a >= 1) return fg;
  const base = bg.a >= 1 ? bg : composite(bg, { rgb: [255, 255, 255], a: 1 });
  return { rgb: fg.rgb.map((v, i) => Math.round(v * fg.a + base.rgb[i] * (1 - fg.a))), a: 1 };
}
const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const luminance = ({ rgb }) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hex = ({ rgb }) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

/* ── the pairs (DESIGN.md §5.4) ── need: 4.5 text · 3 boundary / state / focus / large · 0 informational ── */
const TEXT = 4.5;
const UI = 3;
const INFO = 0;
const white = "#ffffff";
const black = "#000000";
const glassOverBlack = { over: "--glass", on: black };
const glassOverWhite = { over: "--glass", on: white };
const PLATFORMS = ["nintendo", "playstation", "xbox", "handheld"];
const pairs = [
  // ── light: text ──
  ...["--ground", "--paper", "--niche"].map((bg) => ["light", "--ink", bg, TEXT]),
  ...["--ground", "--paper", "--niche", "--niche-2"].map((bg) => ["light", "--ink-2", bg, TEXT]),
  ...["--ground", "--paper", "--niche"].map((bg) => ["light", "--red-ink", bg, TEXT, "sale price, the total"]),
  ["light", "--red-ink", "--red-tint", TEXT, "active tab, sale badge"],
  ...["--ground", "--paper", "--danger-tint"].map((bg) => ["light", "--danger", bg, TEXT, "field errors, error summary"]),
  ...["--ground", "--paper", "--niche", "--ok-tint"].map((bg) => ["light", "--ok", bg, TEXT, "in stock, verified"]),
  ...["--ground", "--paper", "--warn-tint"].map((bg) => ["light", "--warn", bg, TEXT, "«بقي 2», «قبل أن تطلب»"]),
  ...["--paper", "--info-tint"].map((bg) => ["light", "--info", bg, TEXT]),
  ["light", "--ink", "--ok-tint", TEXT, "guest strip"],
  ["light", "--demo-ink", "--demo-bg", TEXT, "the demo marking"],
  ["light", "--demo-ink", "--ground", TEXT, "the demo line on the floor"],
  ["light", "--on-red", "--red", TEXT, "primary key label"],
  ["light", "--on-red", "--red-hover", TEXT, "primary key label, hover"],
  ["light", "--on-color", "--hero", TEXT, "hero copy and the wallet card on crimson"],
  ["light", "--on-showcase", "--hero-face", TEXT, "showcase text on the hero band"],
  ["light", "--on-band-label", "--on-band-face", TEXT, "the white key on crimson"],
  ["light", "--paper", "--ink", TEXT, "a selected chip or segment"],
  ...PLATFORMS.map((p) => ["light", "--on-color", `--plat-${p}`, TEXT, `tile text on ${p} (flat)`]),
  ["light", "--on-band", "--band", TEXT, "release band, toast title"],
  ["light", "--on-band-2", "--band", TEXT, "release band, toast line"],
  ["light", "--on-band-2", "--toast", TEXT, "toast line"],
  ["light", "--ink", glassOverBlack, TEXT, "ink on 82% header glass over black (worst case)"],
  ["light", "--ink-2", glassOverBlack, TEXT, "ink-2 on 82% header glass over black (worst case)"],
  ["light", "--ink-2", { over: "--glass", on: "--red" }, TEXT, "ink-2 on 82% glass over the red primary"],
  ["light", "--ink-2", { over: "--on-image", on: "--niche" }, TEXT, "«صورة توضيحية» on a photo"],
  ["light", "--ink", { over: "--on-image", on: "--niche" }, TEXT, "the gallery counter on the stage"],
  // ── light: boundaries, states, focus ──
  ["light", "--line-strong", "--paper", UI, "fields, secondary buttons, checkbox, switch off"],
  ["light", "--line-strong", "--ground", UI],
  ["light", "--red", "--ground", UI, "primary key face on the floor"],
  ["light", "--ink", "--paper", UI, "selected chip boundary"],
  ["light", "--focus", "--ground", UI, "focus ring"],
  ["light", "--focus-on-color", "--hero", UI, "white focus ring on crimson"],
  ...PLATFORMS.map((p) => ["light", `--dot-${p}`, "--paper", UI, `${p} dot`]),
  ["light", "--on-band-ok", "--toast", UI, "the toast's success check"],
  // ── light: informational ──
  ["light", "--on-color", "--hero-light", INFO, "white on the hero light core (text is never placed here)"],
  ["light", "--line-2", "--paper", INFO, "chip border (decorative)"],
  ["light", "--hero", "--plat-nintendo", INFO, "hero base vs the Nintendo tile (separation)"],
  // ── light: demonstrations (must fail) ──
  ["light", "--on-color", { over: "rgb(255 255 255 / 0.08)", on: "--plat-playstation" }, TEXT, "white on PlayStation + an 8% sheen: why no sheen sits behind tile text", "demo"],

  // ── dark: text ──
  ...["--ground", "--paper", "--niche", "--cab", "--band"].map((bg) => ["dark", "--ink", bg, TEXT]),
  ...["--ground", "--paper", "--niche", "--cab"].map((bg) => ["dark", "--ink-2", bg, TEXT]),
  ...["--ground", "--paper", "--red-tint"].map((bg) => ["dark", "--red-ink", bg, TEXT]),
  ...["--ground", "--paper"].map((bg) => ["dark", "--danger", bg, TEXT]),
  ...["--ground", "--paper"].map((bg) => ["dark", "--ok", bg, TEXT]),
  ...["--ground", "--paper", "--warn-tint"].map((bg) => ["dark", "--warn", bg, TEXT]),
  ...["--ground", "--info-tint"].map((bg) => ["dark", "--info", bg, TEXT]),
  ["dark", "--demo-ink", "--demo-bg", TEXT],
  ["dark", "--on-red", "--red", TEXT, "primary key label"],
  ["dark", "--on-red", "--red-hover", TEXT, "primary key label, hover"],
  ["dark", "--on-showcase", "--hero-face", TEXT, "showcase text in the hero cabinet"],
  ["dark", "--on-showcase-2", "--cab", TEXT, "secondary showcase text in a cabinet"],
  ["dark", "--on-band-label", "--on-band-face", TEXT, "the on-band key renders as the red primary"],
  ["dark", "--paper", "--ink", TEXT, "a selected chip or segment"],
  ["dark", "--on-band", "--toast", TEXT, "toast title"],
  ["dark", "--on-band-2", "--toast", TEXT, "toast line"],
  ["dark", "--on-band-2", "--band", TEXT, "release band line"],
  ["dark", "--ink", glassOverWhite, TEXT, "ink on 82% dark glass over white (worst case)"],
  ["dark", "--ink-2", glassOverWhite, TEXT, "ink-2 on 82% dark glass over white (worst case)"],
  ["dark", "--ink", { over: "--on-image", on: "#4c4f56" }, TEXT, "the gallery counter over the lit spot"],
  // ── dark: boundaries, states, focus ──
  ...["--paper", "--ground"].map((bg) => ["dark", "--line-strong", bg, UI]),
  ...["--ground", "--cab"].map((bg) => ["dark", "--red", bg, UI, "primary key face"]),
  ...["--ground", "--cab"].map((bg) => ["dark", "--focus", bg, UI, "focus ring"]),
  ...PLATFORMS.map((p) => ["dark", `--dot-${p}`, "--ground", UI, `${p} dot (dark value)`]),
  ["dark", "--on-band-ok", "--toast", UI, "the toast's success check"],
  // ── dark: informational ──
  ["dark", "#1a1a1a", "#4c4f56", INFO, "black hardware on the lit spot centre (separation)"],
  ["dark", "#1a1a1a", "--niche", INFO, "black hardware on a flat well (why the lit spot)"],
  ["dark", "--cab", "--ground", INFO, "cabinet vs floor (separation)"],
  // ── dark: demonstrations (must fail) ──
  ["dark", "#5b3fd9", "--ground", UI, "the light handheld dot on the dark floor: why dots switch to dark values", "demo"],

  // ── v2.1 "Clay & Glass" (DESIGN.md §15): every face a label sits on ──
  // the glossy red primary: the label sits from the 24% stop down; the lighter top fifth carries no text
  ...["light", "dark"].flatMap((theme) => [
    [theme, "--on-red", "--red-gloss-mid", TEXT, "glossy primary: the label on the brand-red stop"],
    [theme, "--on-red", "--red-gloss-low", TEXT, "glossy primary: the label on the bottom stop"],
    [theme, "--on-red", "--red-gloss-mid-hover", TEXT, "glossy primary under the pointer"],
    [theme, "--on-red", "--red-gloss-low-hover", TEXT, "glossy primary under the pointer, bottom"],
    [theme, "--on-red", "--red-gloss-top", INFO, "the top fifth (no text there)"],
    // clay keys and chips: ink on every stop of the face, counts in ink-2
    ...["--clay-hi", "--clay-mid", "--clay-lo"].map((bg) => [theme, "--ink", bg, TEXT, "a clay key's label"]),
    [theme, "--ink-2", "--clay-lo", TEXT, "a chip's count on the clay face"],
    [theme, "--danger", "--clay-lo", TEXT, "the danger key's label"],
    [theme, "--red-ink", "--clay-lo", UI, "the red line icon on a clay tile"],
    // the quantity tray and the warm well
    [theme, "--ink", "--tray", TEXT, "the stepper's count in the tray"],
    [theme, "--ink-2", "--well-bottom", TEXT, "ink-2 on the well's darker end"],
    // platform tiles are vivid in BOTH themes: white words on the flat colour and the deep corner
    ...PLATFORMS.flatMap((p) => [
      [theme, "--on-color", `--plat-${p}-deep`, TEXT, `tile words on ${p}'s deep corner`],
      [theme, "--on-color", `--plat-${p}-hi`, INFO, `${p}'s light corner (the hardware sits there, never the words)`],
    ]),
  ]),
  ...PLATFORMS.map((p) => ["dark", "--on-color", `--plat-${p}`, TEXT, `tile words on ${p} (flat) — dark, v2.1: tiles stay vivid`]),
  // frosted panels (menus, sheets): the worst backdrop
  ["light", "--ink", { over: "--glass-panel", on: black }, TEXT, "ink on a light glass panel over black (worst case)"],
  ["light", "--ink-2", { over: "--glass-panel", on: black }, TEXT, "ink-2 on a light glass panel over black (worst case)"],
  ["dark", "--ink", { over: "--glass-panel", on: white }, TEXT, "ink on a dark glass panel over white (worst case)"],
  ["dark", "--ink-2", { over: "--glass-panel", on: white }, TEXT, "ink-2 on a dark glass panel over white (worst case)"],
  // dark cards are faux glass: the white veil (--card-veil top, --card-veil-low bottom) on a SEE-THROUGH tint
  // (--card-tint) over the floor — and over the floor's ambient light at its strongest (--floor-glow-1 / -2)
  ["dark", "--ink", { over: "--card-veil", on: { over: "--card-tint", on: "--ground" } }, TEXT, "ink on the faux-glass card (top) over the floor"],
  ["dark", "--ink-2", { over: "--card-veil", on: { over: "--card-tint", on: "--ground" } }, TEXT, "ink-2 on the faux-glass card (top) over the floor"],
  ["dark", "--ink-2", { over: "--card-veil", on: { over: "--card-tint", on: { over: "--floor-glow-1", on: "--ground" } } }, TEXT, "ink-2 on the card over the floor's crimson light"],
  ["dark", "--ink-2", { over: "--card-veil-low", on: { over: "--card-tint", on: { over: "--floor-glow-2", on: "--ground" } } }, TEXT, "ink-2 on the card's foot over the floor's violet light"],
  ["dark", "--red-ink", { over: "--card-veil", on: { over: "--card-tint", on: { over: "--floor-glow-1", on: "--ground" } } }, TEXT, "a sale price on the card over the crimson light"],
  ["dark", "--ink-2", { over: "--floor-glow-1", on: "--ground" }, TEXT, "ink-2 straight on the floor's crimson light"],
  ["dark", "--ink-2", { over: "--floor-glow-2", on: "--ground" }, TEXT, "ink-2 straight on the floor's violet light"],
  ["dark", "--ink", { over: "--glass", on: { over: "--floor-glow-1", on: "--ground" } }, TEXT, "the header glass over the crimson light"],
  ["dark", "--ink", { over: "rgb(255 255 255 / 0.1)", on: "--ground" }, TEXT, "ink on a real glass card over the floor"],
  ["dark", "--ink-2", { over: "rgb(255 255 255 / 0.1)", on: "--ground" }, TEXT, "ink-2 on a real glass card over the floor"],
  // the hero and the wallet are deep crimson glass in dark; the on-band key stays white clay
  ["dark", "--on-showcase-2", "--hero-face", TEXT, "secondary text on the deep crimson hero"],
  ["dark", "--on-band-label", "--on-band-face", TEXT, "the white key on deep crimson"],
];

const rows = pairs.map(([theme, fg, bg, need, note = "", kind = "pair"]) => {
  const backdrop = colour(theme, "--ground", null);
  const b = colour(theme, bg, backdrop);
  const f = colour(theme, fg, b);
  const r = ratio(f, b);
  const name = (spec) => (typeof spec === "object" ? `${name(spec.over)} over ${name(spec.on)}` : spec);
  const pass = r >= need;
  const status = kind === "demo" ? (pass ? "DEMO PASSES — revisit the rule" : "demonstration (fails, as documented)") : need === 0 ? "info" : pass ? "pass" : "FAIL";
  return { theme, fg: name(fg), bg: name(bg), fgHex: hex(f), bgHex: hex(b), ratio: Number(r.toFixed(2)), need, status, note, kind };
});

const failures = rows.filter((r) => r.status === "FAIL" || r.status.startsWith("DEMO PASSES"));
if (JSON_OUT) {
  console.log(JSON.stringify({ rows, failures: failures.length }, null, 2));
} else {
  const w = Math.max(...rows.map((r) => `${r.fg} on ${r.bg}`.length));
  for (const r of rows) {
    const pair = `${r.fg} on ${r.bg}`;
    console.log(`${r.theme.padEnd(5)}  ${pair.padEnd(w)}  ${String(r.ratio.toFixed(2)).padStart(6)}  ${r.need ? `need ${String(r.need).padEnd(3)}` : "        "}  ${r.status.padEnd(8)}  ${r.note}`);
  }
  const counted = rows.filter((r) => r.kind === "pair" && r.need > 0);
  console.log(`\n${rows.length} rows: ${counted.length} required pairs, ${counted.filter((r) => r.status === "pass").length} pass; ${rows.filter((r) => r.kind === "demo").length} demonstrations; ${rows.filter((r) => r.status === "info").length} informational. ${failures.length ? `${failures.length} FAIL` : "All required pairs pass."}`);
}
process.exit(failures.length ? 1 : 0);
