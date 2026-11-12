#!/usr/bin/env node
/**
 * Design lint — the checkable rules of docs/DESIGN.md §6.6 (Design System v2; also §5.5, §13) over app/**.
 *
 *   node scripts/lint-design.mjs                 report everything; exit 1 if a design-system file breaks any rule, or
 *                                                any storefront file breaks a v2 rule
 *   node scripts/lint-design.mjs --strict        exit 1 if ANY file breaks ANY rule (CI)
 *   node scripts/lint-design.mjs --json          machine-readable findings
 *   node scripts/lint-design.mjs app/routes/x    only these files / folders
 *
 * Design-system files: app/app.css, app/styles/**, app/ui/** (the kit), the /design-system route and its folder —
 * every rule fails the run there. Since stage 4 of the v2 migration (docs/DESIGN.md §6.7) the rules v2 added or
 * changed (marked "v2" below: red, gel, plat, legacy-token, type, radius, shadow, blend, primary-count, deprecated)
 * also fail it in every other file outside the admin: the page areas, the shell, the motion engine, shared code. The
 * remaining 1.0 rules in those files are reported under "other owners" and fail only with --strict.
 * The admin (app/routes/admin/**, app/styles/admin.css, any rule under [data-density="admin"]) keeps the Lens & Clay
 * 1.0 materials: it is exempt from the v2 material rules, and its findings fail only with --strict.
 *
 * Rules
 *   raw-colour          hex / rgb() / hsl() / oklch() … literals outside app/styles/tokens.css
 *   physical            left/right properties, physical margin/padding/border/radius, text-align:left|right, float,
 *                       physical Tailwind utilities (ml- pr- left- text-left rounded-l- border-r …), physical keys in
 *                       inline styles
 *   backdrop-filter     anywhere but app/styles/materials.css — use <Glass>
 *   glass-mask          mask / clip-path on a rule that has backdrop-filter
 *   glass-in-list       a live <Glass> inside a .map() callback (lists never carry live glass)
 *   filter              CSS filter (images included: no drop-shadow on products), SVG <filter>/<fe…>, Tailwind
 *                       filter utilities
 *   animated-property   transition/animation of anything but transform, translate, scale, rotate and opacity
 *   letter-spacing      any non-zero letter-spacing, Tailwind tracking-*, letterSpacing
 *   v2 red              --red / --red-hover / --hero (and 1.0 --red-face) outside the primary key, the card add button,
 *                       the bead, the fly-to-cart bead, the logo, the hero and wallet bands and the current step;
 *                       red surfaces via utilities
 *   v2 gel              --gel-* outside the dark cabinet light layers (.band__light, .ptile__light); assigning
 *                       `--gel: var(--gel-x)` to a subtree is fine
 *   img-size            <img> without width and height
 *   view-transition     view-transition-name set statically outside app/motion
 *   i18n-keys           a "ui" / "ui-*" namespace whose ar / en / ckb keys differ
 *   v2 legacy-token     a Lens & Clay 1.0 material token (--clay-*, --red-face …, --sel-*, --well, --well-shadow,
 *                       --glass-bg/-static/-rim, --on-glass-2, --e-1…--e-5, --shade …) or its utility (bg-well,
 *                       shadow-e1…e5, bg-sel, text-on-sel, text-on-glass-2) outside the admin
 *   v2 type             a non-integer font size; Kufam (--font-display / --font-head) under 15px. (v2.1 brought Plex
 *                       500 back: weight 500 and `font-medium` are allowed again.)
 *   v2 radius           a border-radius that is not a --r-* token (the checkbox's 6px is --r-check)
 *   v2 shadow           a box-shadow written with lengths instead of an elevation token (the vocabulary is
 *                       --clay-cap/--clay-cast, --e-bar, --e-float, --e-overlay, --e-art, --rim)
 *   v2 blend            mix-blend-mode outside the opaque-photo rule of app/styles/materials.css (a selector on
 *                       [data-opaque]: box art and screenshots, also data-transparent="false", never blend)
 *   v2 plat             a platform surface (--plat*) outside the platform tile (.ptile) and the showcase band (.band)
 *   v2 primary-count    more than one primary key (<Key variant="primary"|"commit"> or a raw .key--primary/.key--red)
 *                       in one route module — one red primary per view; card add buttons are neutral
 *   v2 deprecated       the 1.0 kit names stage 4 retires outside the admin: Socket, PlatformBank, StageTag,
 *                       PlatformGlyph, KeyBank (Segmented replaces it), variant="commit" | "ink" | "quiet",
 *                       <Glass variant="static">
 *
 * Escape hatch (always give the reason): a comment `lint-design: allow <rule>[, <rule>] — why` disables those rules
 * on its own line and the next one; within the first three lines of a file it applies to the whole file.
 * Static analysis only: the runtime rule "at most two live glass panes per viewport" is a dev warning in <Glass>.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const STRICT = args.includes("--strict");
const JSON_OUT = args.includes("--json");
const targets = args.filter((a) => !a.startsWith("--"));

const OWNED = [/^app\/app\.css$/, /^app\/styles\//, /^app\/ui\//, /^app\/routes\/storefront\/content\/design-system(\.tsx|\/)/];
const isOwned = (rel) => OWNED.some((re) => re.test(rel));
/** The admin keeps the 1.0 materials (DESIGN.md §10). */
const isAdmin = (rel) => rel.startsWith("app/routes/admin/") || rel === "app/styles/admin.css";
/** The rules Design System v2 added or changed (DESIGN.md §6.7). Since stage 4 they fail the run in every file outside
 *  the admin, not only in the design-system files. */
const V2_RULES = new Set(["red", "gel", "plat", "legacy-token", "type", "radius", "shadow", "blend", "primary-count", "deprecated"]);

/* ───────────────────────────── files ───────────────────────────── */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(css|tsx?|mts|mjs)$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}
const roots = targets.length ? targets.map((t) => path.resolve(ROOT, t)) : [path.join(ROOT, "app")];
const files = roots.flatMap((r) => (statSync(r).isDirectory() ? walk(r) : [r]));
const rel = (file) => path.relative(ROOT, file).split(path.sep).join("/");

/* ───────────────────────────── findings ───────────────────────────── */
const findings = [];
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
function makeReporter(file, raw) {
  const r = rel(file);
  const lines = raw.split("\n");
  const fileWide = new Set();
  const lineAllow = new Map(); // line number → Set(rule)
  lines.forEach((text, i) => {
    const m = /lint-design:\s*allow\s+([\w-]+(?:\s*,\s*[\w-]+)*)/.exec(text);
    if (!m) return;
    const rules = m[1].split(",").map((s) => s.trim());
    if (i < 3) rules.forEach((rule) => fileWide.add(rule));
    for (const n of [i + 1, i + 2]) {
      const set = lineAllow.get(n) ?? new Set();
      rules.forEach((rule) => set.add(rule));
      lineAllow.set(n, set);
    }
  });
  return (rule, line, message) => {
    if (fileWide.has(rule) || lineAllow.get(line)?.has(rule)) return;
    const owned = isOwned(r);
    findings.push({ file: r, line, rule, message, owned, v2: !owned && !isAdmin(r) && V2_RULES.has(rule) });
  };
}

/* ───────────────────────────── shared vocabularies ───────────────────────────── */
const LEGACY_TOKEN = /var\(--(clay-face|clay-wall|clay-lip|clay-belly|red-face|red-wall|red-lip|red-belly|sel-face|sel-wall|on-sel|sel-in|ink-lip|ink-belly|well|well-shadow|glass-bg|glass-static|glass-rim|on-glass-2|e-[1-5]|e-4-up|shade|lumen|halo|pool|spot)\)/;
const LEGACY_UTILITY = /^(bg-well|shadow-e[1-5]|shadow-e4-up|shadow-well|shadow-wall|bg-sel|text-on-sel|text-on-glass-2)$/;
const RED_TOKEN = /var\(--(red|red-hover|hero|red-face)\)/;
/** Where brand red may paint (DESIGN.md §6.6): primary key, card add button, bead, fly bead, logo, hero and wallet
 *  bands, the current step's disc; the admin's 1.0 commit key and bead. */
const RED_PLACES = /(\.key--primary|\.key--red|\.cadd|\.socket|\.bead|\.fly|\.logo|\[data-logo|\.text-logo|\.band--hero|\.band--wallet|\.step\b|\.carousel__dot|\.clay--red|\[data-density="admin"\])/;
/** v2.1: the platform light is also read by a tile's floor glow (.ptile) and the ambient light (.glow, .glow-layer). */
const GEL_PLACES = /(\.band__light|\.ptile|\.glow|\[data-gel|\[data-density="admin"\])/;
const PLAT_PLACES = /(\.ptile|\.band\b|\.band--|\[data-gel)/;

/* ───────────────────────────── CSS ───────────────────────────── */
function blankComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}
/** Calls onDecl(prop, value, index, selectors[]) for every declaration; selectors = enclosing style-rule preludes. */
function walkCss(text, onDecl, onBlock) {
  const stack = [];
  let start = 0;
  let depth = 0; // parentheses
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    if (ch === "{") {
      const prelude = text.slice(start, i).trim();
      stack.push({ prelude, index: start + (text.slice(start, i).length - text.slice(start, i).trimStart().length), decls: [] });
      start = i + 1;
    } else if (ch === ";" || ch === "}") {
      const chunk = text.slice(start, i);
      const trimmed = chunk.trim();
      if (trimmed && stack.length && !trimmed.startsWith("@")) {
        const colon = trimmed.indexOf(":");
        if (colon > 0) {
          const index = start + (chunk.length - chunk.trimStart().length);
          const decl = { prop: trimmed.slice(0, colon).trim().toLowerCase(), value: trimmed.slice(colon + 1).trim(), index };
          stack[stack.length - 1].decls.push(decl);
          onDecl(decl.prop, decl.value, index, stack.map((s) => s.prelude).filter((p) => !p.startsWith("@")));
        }
      }
      if (ch === "}") {
        const block = stack.pop();
        if (block) onBlock?.(block, stack.map((s) => s.prelude));
      }
      start = i + 1;
    }
  }
}
/** The value with every var(…) (nested included) removed: what is left is literal. */
function withoutVars(value) {
  let out = value;
  for (let guard = 0; guard < 8 && /var\(/.test(out); guard++) out = out.replace(/var\([^()]*\)/g, "");
  return out;
}

const COLOUR_FN = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[-+.\d]/i;
const HEX = /(^|[^\w&-])#[0-9a-f]{3,8}\b/i;
const FORBIDDEN_MOTION = /^(all|box-shadow|filter|backdrop-filter|-webkit-backdrop-filter|background|background-color|background-position|background-size|color|border|border-color|outline|outline-color|fill|stroke|width|height|inline-size|block-size|min-width|min-height|max-width|max-height|top|left|right|bottom|inset|inset-[a-z-]+|margin|margin-[a-z-]+|padding|padding-[a-z-]+|font-size|line-height|letter-spacing|border-radius|--[\w-]+)$/;
const MOTION_OK = /^(transform|translate|scale|rotate|opacity|offset-[a-z-]+|visibility|display|content-visibility|overlay|none)$/;
const TIME = /^-?[\d.]+m?s$/;

function lintCss(file, raw) {
  const r = rel(file);
  const report = makeReporter(file, raw);
  const text = blankComments(raw);
  const isTokens = r === "app/styles/tokens.css";
  const isTheme = r === "app/styles/theme.css";
  const isMaterials = r === "app/styles/materials.css";
  const inMotion = r.startsWith("app/motion/");
  const adminFile = isAdmin(r);

  walkCss(
    text,
    (prop, value, index, selectors) => {
      const line = lineOf(text, index);
      const sel = selectors.join(" ");
      const adminRule = adminFile || /\[data-density="admin"\]/.test(sel);
      // raw colours (custom-property definitions included) — tokens.css is the only place a literal may be written
      if (!isTokens && (HEX.test(value) || COLOUR_FN.test(value))) report("raw-colour", line, `${prop}: ${value.slice(0, 60)} — use a token`);
      // physical properties
      if (/^(left|right|margin-left|margin-right|padding-left|padding-right|border-left(-[a-z]+)?|border-right(-[a-z]+)?|border-(top|bottom)-(left|right)-radius|scroll-(margin|padding)-(left|right)|float|clear)$/.test(prop)) {
        if (!(prop === "float" || prop === "clear") || /\b(left|right)\b/.test(value)) report("physical", line, `${prop} — use the logical property (inset-inline-*, margin-inline-*, …)`);
      }
      if (prop === "text-align" && /\b(left|right)\b/.test(value)) report("physical", line, `text-align: ${value} — use start / end`);
      if ((prop === "margin" || prop === "padding" || prop === "inset") && value.split(/\s+/).length === 4) {
        const [, b, , d] = value.split(/\s+/);
        if (b !== d) report("physical", line, `${prop}: ${value} — a 4-value shorthand sets left/right; use ${prop}-block / ${prop}-inline`);
      }
      // backdrop-filter only in the glass rule
      if (/^(-webkit-)?backdrop-filter$/.test(prop) && value !== "none" && !isMaterials) report("backdrop-filter", line, "backdrop-filter outside materials.css — use <Glass>");
      // CSS filter (images included: no drop-shadow, no brightness on products)
      if (prop === "filter" && value !== "none" && !inMotion) report("filter", line, `filter: ${value.slice(0, 40)} — no CSS filter in component styles or on images`);
      // letter-spacing
      if (prop === "letter-spacing" && !/^(0|0px|0em|normal)$/.test(value)) report("letter-spacing", line, `letter-spacing: ${value}`);
      // motion: transform and opacity only
      if (prop === "transition-property") {
        for (const p of value.split(",").map((s) => s.trim())) if (!MOTION_OK.test(p)) report("animated-property", line, `transition of ${p}`);
      }
      if (prop === "transition") {
        for (const part of value.split(/,(?![^(]*\))/)) {
          const first = part.trim().split(/\s+/)[0];
          if (!first || TIME.test(first) || /^(ease|linear|cubic-bezier|steps|var\()/.test(first)) {
            if (part.trim() !== "none") report("animated-property", line, `transition without a property animates everything: "${part.trim()}"`);
          } else if (!MOTION_OK.test(first) && FORBIDDEN_MOTION.test(first)) report("animated-property", line, `transition of ${first}`);
        }
      }
      // view-transition-name set statically
      if (prop === "view-transition-name" && value !== "none" && !inMotion) report("view-transition", line, "view-transition-name in a stylesheet — set it at tap time (<SharedElement>)");
      // brand red: only where DESIGN.md §6.6 lets it paint
      if (RED_TOKEN.test(value) && !isTokens && !RED_PLACES.test(sel) && !(isTheme && prop === "--color-logo")) {
        report("red", line, `${prop} uses brand red in "${sel.slice(0, 60)}" — red is the primary key, the bead, the logo and the hero / wallet bands only`);
      }
      // platform light: only the dark cabinets' light layers read it
      if (/--gel-[a-z]+|var\(--gel\b/.test(value) && !isTokens) {
        const assignment = prop === "--gel";
        if (!assignment && !GEL_PLACES.test(sel)) report("gel", line, `platform light in "${sel.slice(0, 60)}" — --gel-* is read only by the cabinet light layers (.band__light, .ptile__light)`);
      }
      // ── v2 rules ──
      // the 1.0 material tokens belong to the admin
      if (LEGACY_TOKEN.test(value) && !isTokens && !isTheme && !adminRule) {
        report("legacy-token", line, `${prop} reads a Lens & Clay 1.0 token (${LEGACY_TOKEN.exec(value)[0]}) — admin only; use the v2 tokens (DESIGN.md §5)`);
      }
      if (!adminRule && !isTokens) {
        // type: sizes are integers (v2.1 brought Plex 500 back, so weight 500 is allowed again); Kufam (the display
        // face) never under its 15px floor
        if ((prop === "font" || prop === "font-size") && /(^|[\s/(])\d+\.\d+px/.test(withoutVars(value))) report("type", line, `${prop}: ${value.slice(0, 40)} — integer font sizes only (DESIGN.md §5.5)`);
        if (prop === "font" && /var\(--font-(display|head)\)/.test(value)) {
          const size = /(?:^|\s)(\d+)px\s*\//.exec(withoutVars(value));
          if (size && Number(size[1]) < 15) report("type", line, `${prop}: ${value.slice(0, 40)} — Kufam is never under 15px (DESIGN.md §5.5)`);
        }
        // radius: tokens only
        if (/^border(-[a-z]+)*-radius$/.test(prop) && /\d*\.?\d+(px|%|em|rem)\b/.test(withoutVars(value).replace(/\b0(px|%|em|rem)?\b/g, ""))) report("radius", line, `${prop}: ${value} — radius only through the --r-* tokens`);
        // shadow: the elevation vocabulary
        if ((prop === "box-shadow" || /^--[\w-]*(shadow|cast)$/.test(prop)) && /\d*\.?\d+px/.test(withoutVars(value))) report("shadow", line, `${prop}: ${value.slice(0, 50)} — use an elevation token (--clay-cap, --clay-cast, --e-bar, --e-float, --e-overlay, --e-art, --rim)`);
        // blend: only the interim opaque-photo rule (materials.css, keyed on [data-opaque]: box art and screenshots are
        // data-transparent="false" too, and must never blend)
        if (prop === "mix-blend-mode" && value !== "normal" && !(isMaterials && /\[data-opaque\]/.test(sel))) report("blend", line, `mix-blend-mode in "${sel.slice(0, 60)}" — only the opaque-photo rule ([data-opaque], materials.css) may blend`);
        // platform surfaces: tiles and bands only
        if (/var\(--plat(-[a-z]+)*\)/.test(value) && prop !== "--plat" && prop !== "--plat-deep" && !PLAT_PLACES.test(sel)) report("plat", line, `${prop} paints a platform surface in "${sel.slice(0, 60)}" — platform colour is a surface only on .ptile and .band; elsewhere an 8px dot (--dot)`);
      }
    },
    (block) => {
      // keyframes: only transform / opacity
      if (/^@keyframes/.test(block.prelude)) return;
      const has = (re) => block.decls.some((d) => re.test(d.prop) && d.value !== "none");
      if (has(/^(-webkit-)?backdrop-filter$/) && has(/^(-webkit-)?(mask|mask-image|clip-path)$/)) {
        report("glass-mask", lineOf(text, block.index), `mask / clip-path on a rule with backdrop-filter: ${block.prelude.slice(0, 60)}`);
      }
    },
  );
  // keyframe bodies
  const kf = /@keyframes\s+([\w-]+)\s*\{/g;
  let m;
  while ((m = kf.exec(text))) {
    let depth = 1;
    let i = kf.lastIndex;
    const startBody = i;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    const body = text.slice(startBody, i - 1);
    for (const d of body.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)) {
      const prop = d[1];
      if (!MOTION_OK.test(prop) && !/^animation-timing-function$/.test(prop)) report("animated-property", lineOf(text, startBody + d.index), `@keyframes ${m[1]} animates ${prop}`);
    }
  }
}

/* ───────────────────────────── TS / TSX ───────────────────────────── */
/** Blanks comments, keeps strings; returns { code, strings: [{ value, index }] }. Heuristic regex-literal detection. */
function scanTs(raw) {
  const out = raw.split("");
  const strings = [];
  let i = 0;
  let lastSignificant = "";
  const regexStarts = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "", "\n", "+", "-", "*", "%", "<", ">", "~", "^", "return", "typeof", "case"]);
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === "/" && next === "/") {
      while (i < raw.length && raw[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) {
        if (raw[i] !== "\n") out[i] = " ";
        i++;
      }
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      let j = i + 1;
      while (j < raw.length && raw[j] !== ch) {
        if (raw[j] === "\\") j++;
        else if (ch !== "`" && raw[j] === "\n") break;
        j++;
      }
      strings.push({ value: raw.slice(start + 1, j), index: start + 1, quote: ch });
      i = j + 1;
      lastSignificant = "x";
      continue;
    }
    if (ch === "/" && regexStarts.has(lastSignificant)) {
      // regex literal
      let j = i + 1;
      let inClass = false;
      while (j < raw.length && raw[j] !== "\n") {
        if (raw[j] === "\\") j += 2;
        else if (raw[j] === "[") (inClass = true), j++;
        else if (raw[j] === "]") (inClass = false), j++;
        else if (raw[j] === "/" && !inClass) break;
        else j++;
      }
      i = j + 1;
      lastSignificant = "x";
      continue;
    }
    if (!/\s/.test(ch)) {
      if (/[\w$]/.test(ch)) {
        let j = i;
        while (j < raw.length && /[\w$]/.test(raw[j])) j++;
        lastSignificant = raw.slice(i, j);
        lastSignificant = ["return", "typeof", "case"].includes(lastSignificant) ? lastSignificant : "x";
        i = j;
        continue;
      }
      lastSignificant = ch === ")" || ch === "]" ? "x" : ch;
    }
    i++;
  }
  return { code: out.join(""), strings };
}

const TW_PHYSICAL = /^-?(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr|scroll-pl|scroll-pr|inset-l|inset-r)(-|$)|^(text-left|text-right|float-left|float-right|clear-left|clear-right|space-x-reverse)$/;
const TW_FILTER = /^-?(blur|drop-shadow|brightness|contrast|grayscale|invert|saturate|sepia|hue-rotate|filter)(-|$)/;
const TW_BACKDROP = /^backdrop-/;
const TW_TRANSITION = /^transition(-all|-colors|-shadow)?$/;

function classTokens(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^!/, "").split(":").pop() ?? "");
}

function lintTs(file, raw) {
  const r = rel(file);
  const report = makeReporter(file, raw);
  const { code, strings } = scanTs(raw);
  const inMotion = r.startsWith("app/motion/");
  const adminFile = isAdmin(r);
  const isTsx = r.endsWith(".tsx");

  // class strings: className="…", className={"…"}, className={`…`}, and string arguments of cx(…)
  const classSpans = [];
  for (const s of strings) {
    const before = code.slice(Math.max(0, s.index - 40), s.index - 1);
    if (/className\s*=\s*\{?\s*$/.test(before) || /\bcx\([^)]*$/.test(code.slice(Math.max(0, s.index - 200), s.index - 1))) classSpans.push(s);
  }
  for (const s of classSpans) {
    const line = lineOf(raw, s.index);
    for (const token of classTokens(s.value)) {
      if (TW_PHYSICAL.test(token)) report("physical", line, `utility "${token}" — use the logical one (ms- me- ps- pe- start- end- text-start rounded-s- …)`);
      if (TW_FILTER.test(token)) report("filter", line, `utility "${token}" — no CSS filter`);
      if (TW_BACKDROP.test(token)) report("backdrop-filter", line, `utility "${token}" — use <Glass>`);
      if (TW_TRANSITION.test(token)) report("animated-property", line, `utility "${token}" animates colour/shadow — use transition-transform or transition-opacity`);
      if (/^tracking-/.test(token)) report("letter-spacing", line, `utility "${token}"`);
      if (/^(bg|border|ring|outline|fill|stroke|from|to|via|shadow|divide)-logo\b/.test(token)) report("red", line, `utility "${token}" — brand red is never a surface`);
      if (/-\[(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|lab|lch|hwb)\()/i.test(token)) report("raw-colour", line, `arbitrary colour "${token}" — use a token`);
      if (!adminFile) {
        if (LEGACY_UTILITY.test(token)) report("legacy-token", line, `utility "${token}" is a Lens & Clay 1.0 material — admin only (v2: bg-niche-2, border border-line, bg-ink text-paper, shadow-overlay …)`);
        if (/^text-\[\d+\.\d+px\]$/.test(token)) report("type", line, `utility "${token}" — integer font sizes only, from the type roles`);
        if (/^rounded(-[a-z]+)?-\[/.test(token)) report("radius", line, `utility "${token}" — radius only through the --r-* tokens (rounded-sm, -lg, -xl, -full …)`);
        if (/^shadow-\[/.test(token)) report("shadow", line, `utility "${token}" — use an elevation token (shadow-bar, -float, -overlay, -art)`);
        if (/^mix-blend-/.test(token)) report("blend", line, `utility "${token}" — only the opaque-photo rule may blend`);
      }
    }
  }

  // colours in strings: style objects, SVG paint attributes, CSS inside strings
  for (const s of strings) {
    const ctx = code.slice(Math.max(0, s.index - 30), s.index - 1);
    const paintCtx = /(fill|stroke|stop-?[cC]olor|flood-?[cC]olor|lighting-?[cC]olor|color|background(Color)?|border(Color)?|outline(Color)?|caretColor|accentColor)\s*[=:]\s*\{?\s*$/.test(ctx);
    const val = s.value;
    if ((paintCtx && /^\s*(#[0-9a-f]{3,8}|(rgba?|hsla?|oklch|oklab|hwb|lab|lch)\(\s*[-.\d])/i.test(val)) || /(fill|stroke|stop-color|flood-color|color|background)\s*[=:]\s*\\?["']?\s*#[0-9a-f]{3,8}\b/i.test(val) || /(fill|stroke|stop-color|color|background)\s*[=:]\s*\\?["']?\s*(rgba?|hsla?)\(\s*\d/i.test(val)) {
      report("raw-colour", lineOf(raw, s.index), `colour literal "${val.slice(0, 50)}" — use a token`);
    }
    if (RED_TOKEN.test(val)) report("red", lineOf(raw, s.index), "brand red referenced from code — use <Key variant=\"primary\">, the bead, the logo or a showcase band");
    if (/rgb\(var\(--gel/.test(val)) report("gel", lineOf(raw, s.index), "platform light painted from code — only the cabinet light layers read --gel");
    if (!adminFile && LEGACY_TOKEN.test(val)) report("legacy-token", lineOf(raw, s.index), `${LEGACY_TOKEN.exec(val)[0]} is a Lens & Clay 1.0 token — admin only`);
  }

  // inline styles and DOM style writes
  for (const m of code.matchAll(/style\s*=\s*\{\{([\s\S]*?)\}\}/g)) {
    const body = m[1];
    const base = m.index + m[0].indexOf(body);
    for (const k of body.matchAll(/(?:^|[\s,{])(left|right|marginLeft|marginRight|paddingLeft|paddingRight|borderLeft\w*|borderRight\w*)\s*:/g)) {
      report("physical", lineOf(raw, base + k.index), `inline style "${k[1]}" — use the logical property`);
    }
    if (/\btextAlign\s*:\s*["'](left|right)["']/.test(body)) report("physical", lineOf(raw, base), "textAlign left/right — use start/end");
    if (/\bletterSpacing\s*:/.test(body)) report("letter-spacing", lineOf(raw, base), "letterSpacing in an inline style");
    if (/\b(WebkitBackdropFilter|backdropFilter)\s*:/.test(body)) report("backdrop-filter", lineOf(raw, base), "backdropFilter in an inline style — use <Glass>");
    if (/(^|[\s,{])filter\s*:/.test(body)) report("filter", lineOf(raw, base), "filter in an inline style");
    if (/\bviewTransitionName\s*:/.test(body) && !inMotion) report("view-transition", lineOf(raw, base), "viewTransitionName set statically — use <SharedElement>");
    if (/\bmixBlendMode\s*:/.test(body) && !adminFile) report("blend", lineOf(raw, base), "mixBlendMode in an inline style — only the opaque-photo rule may blend");
  }
  for (const m of code.matchAll(/\.style\.(left|right|marginLeft|marginRight|paddingLeft|paddingRight)\s*=/g)) {
    report("physical", lineOf(raw, m.index), `element.style.${m[1]} — logical properties only (the flying bead's pixel start is the one documented exception)`);
  }
  for (const m of code.matchAll(/\.style\.(?:setProperty\(\s*["'](?:left|right)["']|letterSpacing\s*=)/g)) report("physical", lineOf(raw, m.index), "physical style write");

  if (isTsx) {
    // SVG filters in markup
    for (const m of code.matchAll(/<(filter|fe[A-Z]\w*)\b/g)) report("filter", lineOf(raw, m.index), `<${m[1]}> in shipped markup`);
    // <img> needs width and height
    for (const m of code.matchAll(/<img\b([^>]*?)\/?>/g)) {
      const attrs = m[1];
      if (/\{\s*\.\.\./.test(attrs)) continue;
      if (!/\bwidth\s*=/.test(attrs) || !/\bheight\s*=/.test(attrs)) report("img-size", lineOf(raw, m.index), "<img> without width and height — reserve its space (or use <Art>)");
    }
    // live glass inside a list
    for (const m of code.matchAll(/\.map\(\s*\(?[^)]*\)?\s*=>/g)) {
      const window = code.slice(m.index, m.index + 600);
      const g = /<Glass\b([^>]*)>/.exec(window);
      if (g && !/variant\s*=\s*["'](static|solid)["']/.test(g[1])) report("glass-in-list", lineOf(raw, m.index + g.index), "live <Glass> inside a list — lists never carry live glass");
    }
    // the 1.0 kit names stage 4 retires (the kit may keep an alias for the admin; nothing outside it uses one)
    if (!adminFile && !r.startsWith("app/ui/")) {
      for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']~\/ui\/(Socket|PlatformBank|Stage|PlatformLed|KeyBank)["']/g)) {
        for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0])) {
          if (["Socket", "PlatformBank", "StageTag", "PlatformGlyph"].includes(name)) report("deprecated", lineOf(raw, m.index), `${name} is a retired 1.0 kit name (DESIGN.md §9 "Deprecated")`);
          if (name === "KeyBank") report("deprecated", lineOf(raw, m.index), "KeyBank is retired from the storefront — use <Segmented> (DESIGN.md §9)");
        }
      }
      for (const m of code.matchAll(/<(Key|IconKey)\b[^>]*\bvariant\s*=\s*["'](commit|ink|quiet)["']/g)) {
        report("deprecated", lineOf(raw, m.index), `<${m[1]} variant="${m[2]}"> — the v2 names are primary / secondary / ghost`);
      }
      for (const m of code.matchAll(/<Glass\b[^>]*\bvariant\s*=\s*["']static["']/g)) report("deprecated", lineOf(raw, m.index), `<Glass variant="static"> is retired — panels are opaque; glass is for thin fixed bars`);
    }
  }

  // one red primary per view (route modules); card add buttons are neutral
  if (r.startsWith("app/routes/") && isTsx && !adminFile) {
    const primaries = [...code.matchAll(/<Key\b[^>]*\bvariant\s*=\s*["'](commit|primary)["']/g)].map((m) => m.index);
    for (const s of classSpans) if (classTokens(s.value).some((t) => t === "key--red" || t === "key--primary")) primaries.push(s.index);
    if (primaries.length > 1) {
      primaries.sort((a, b) => a - b);
      report("primary-count", lineOf(raw, primaries[1]), `${primaries.length} primary keys in one route module — a view has exactly one red primary`);
    }
  }
}

/* ───────────────────────────── i18n parity for ui namespaces ───────────────────────────── */
function lintUiMessages(file, raw) {
  const report = makeReporter(file, raw);
  let ts;
  try {
    ts = createRequire(path.join(ROOT, "package.json"))("typescript");
  } catch {
    return;
  }
  const js = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const sandbox = { module: { exports: {} }, exports: {}, require: () => ({ defineMessages: (m) => m }) };
  sandbox.exports = sandbox.module.exports;
  try {
    vm.runInNewContext(js, sandbox, { timeout: 1000 });
  } catch (error) {
    report("i18n-keys", 1, `could not evaluate the namespace: ${error.message}`);
    return;
  }
  const messages = sandbox.module.exports.default ?? sandbox.exports.default;
  if (!messages) return;
  const keys = (tree, prefix = "") =>
    Object.entries(tree).flatMap(([k, v]) => (v && typeof v === "object" && !("other" in v) ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const sets = Object.fromEntries(["ar", "en", "ckb"].map((l) => [l, new Set(keys(messages[l] ?? {}))]));
  for (const l of ["en", "ckb"]) {
    for (const k of sets.ar) if (!sets[l].has(k)) report("i18n-keys", 1, `"${k}" exists in ar but not in ${l}`);
    for (const k of sets[l]) if (!sets.ar.has(k)) report("i18n-keys", 1, `"${k}" exists in ${l} but not in ar`);
  }
}

/* ───────────────────────────── run ───────────────────────────── */
for (const file of files) {
  const raw = readFileSync(file, "utf8");
  const r = rel(file);
  if (r.endsWith(".css")) lintCss(file, raw);
  else lintTs(file, raw);
  if (/^app\/i18n\/messages\/ui(-[\w-]+)?\.ts$/.test(r)) lintUiMessages(file, raw);
}

const own = findings.filter((f) => f.owned);
const v2 = findings.filter((f) => f.v2);
const others = findings.filter((f) => !f.owned && !f.v2);
if (JSON_OUT) {
  console.log(JSON.stringify({ files: files.length, findings }, null, 2));
} else {
  const print = (list) => {
    for (const f of list) console.log(`  ${f.file}:${f.line}  ${f.rule}  ${f.message}`);
  };
  console.log(`lint-design: ${files.length} files`);
  console.log(`design-system files (styles, kit, /design-system): ${own.length} finding(s)`);
  print(own);
  console.log(`v2 rules in the other storefront files (pages, shell, motion, shared code): ${v2.length} finding(s)`);
  print(v2);
  console.log(`other owners (the admin; the 1.0 rules elsewhere): ${others.length} finding(s)${STRICT ? "" : " (reported only; --strict makes them fail)"}`);
  print(others);
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  if (findings.length) console.log(`by rule: ${Object.entries(byRule).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}
process.exit(own.length > 0 || v2.length > 0 || (STRICT && findings.length > 0) ? 1 : 0);
