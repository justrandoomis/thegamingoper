/**
 * Generated print — the 2D-canvas helpers behind the game covers (`_game-cover.mjs`) and the
 * wallet cards (`_gift-card.mjs`). A helper file: names starting with "_" never match a catalogue
 * key. Apart from `printed()`, which needs the kit, everything here works on a plain
 * CanvasRenderingContext2D, so a cover can also be drawn on an ordinary page for a quick look.
 *
 * Everything printed is generated: type set in a system typeface on flat geometric shapes.
 * Never draw a logo, a wordmark, a character, a rating mark or real cover artwork with it.
 */

/* ── texture ──────────────────────────────────────────────────────────────── */

/**
 * `kit.paint()` for print with type on it: the same texture, but the canvas is drawn by the CPU
 * (`willReadFrequently`). A canvas drawn by the GPU does not come out bit for bit the same on
 * every launch of the browser — the smoothing along the edge of a letter differs by one step
 * here and there — and that is enough to give the published files new hashed names on every
 * build. Drawn by the CPU, the same model gives the same bytes.
 */
export function paintSteady(kit, width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d', { willReadFrequently: true }), width, height);
  const { THREE } = kit;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/* ── material ─────────────────────────────────────────────────────────────── */

/**
 * The material of a printed sheet: house clay with the picture (a `kit.paint()` texture) as its
 * colour, minus the sheen. Clay blooms in the colour it is given; for a print that colour is
 * white, and a white bloom lays a grey veil over dark ink. The kit has no print material, so this
 * takes `kit.clay()` — rig wiring and all — and switches that one property off. The default
 * finish is the matt one ('soft'): a glossier sheet mirrors the studio and washes the colours out.
 */
export function printed(kit, texture, { finish = 'soft' } = {}) {
  const material = kit.clay('#ffffff', { map: texture, finish });
  material.sheen = 0;
  return material;
}

/* ── seeded random numbers ────────────────────────────────────────────────── */

/** A repeatable random source for a piece of text (a slug): `const rand = seeded('halo-infinite')`. */
export function seeded(text) {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = (Math.imul(h ^ (h >>> 16), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rand.between = (lo, hi) => lo + (hi - lo) * rand();
  rand.int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1)); // both ends included
  rand.pick = (list) => list[Math.floor(rand() * list.length)];
  rand.chance = (p) => rand() < p;
  rand.shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return rand;
}

/* ── colour ───────────────────────────────────────────────────────────────── */

const parse = (hex) => {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

/** `a` moved `amount` (0…1) of the way to `b`, as #rrggbb. */
export function mix(a, b, amount) {
  const p = parse(a), q = parse(b);
  return '#' + p.map((v, i) => Math.round(v + (q[i] - v) * amount).toString(16).padStart(2, '0')).join('');
}

/** `rgba()` string of a hex colour. */
export function alpha(hex, opacity) {
  const [r, g, b] = parse(hex);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * The tones a print is built from, all of one hue: the platform colour, two darker and two
 * lighter steps of it, and paper white.
 */
export function tones(color) {
  const night = '#06070b';
  return {
    ink: mix(color, night, 0.76), // the darkest: title fields
    shade: mix(color, night, 0.42),
    base: mix(color, night, 0), // the colour itself, written as #rrggbb
    lift: mix(color, '#ffffff', 0.3),
    pale: mix(color, '#ffffff', 0.72),
    paper: '#f8f5ef',
  };
}

/* ── type ─────────────────────────────────────────────────────────────────── */

/**
 * Strong condensed display faces, best first. Nothing is bundled: the first one this machine has
 * is used (Impact ships with Windows and macOS), and each is asked for in the weight it is strong in.
 */
const DISPLAY_FACES = [
  { family: 'Impact', weight: 400 },
  { family: 'Haettenschweiler', weight: 400 },
  { family: 'Bahnschrift', weight: 700, stretch: 'condensed' },
  { family: 'HelveticaNeue-CondensedBlack', weight: 400 },
  { family: 'Avenir Next Condensed', weight: 800 },
  { family: 'Arial Narrow', weight: 700 },
  { family: 'Roboto Condensed', weight: 700 },
  { family: 'DejaVu Sans Condensed', weight: 700 },
  { family: 'Liberation Sans Narrow', weight: 700 },
  { family: 'Arial Black', weight: 900 },
];

function installed(ctx, family) {
  const probe = 'HAMBURGEFONSTIV 0123456789 mmmlli';
  const width = (font) => { ctx.font = font; return ctx.measureText(probe).width; };
  return ['monospace', 'serif'].some((generic) => Math.abs(width(`72px "${family}", ${generic}`) - width(`72px ${generic}`)) > 0.5);
}

let displayFaceMemo = null;
/** The display typeface of this machine: `{ family, font(sizePx) }` — `font()` gives the CSS font string. */
export function displayFace(ctx) {
  if (displayFaceMemo) return displayFaceMemo;
  ctx.save();
  const found = DISPLAY_FACES.find((face) => installed(ctx, face.family)) ?? { family: 'sans-serif', weight: 900, generic: true };
  ctx.restore();
  const stack = found.generic ? 'sans-serif' : `"${found.family}", "Arial Black", sans-serif`;
  displayFaceMemo = {
    family: found.family,
    font: (size) => `${found.weight} ${found.stretch ? found.stretch + ' ' : ''}${size.toFixed(2)}px ${stack}`,
  };
  return displayFaceMemo;
}

const LINE_END_WEAK = /(^|\s)(A|AN|AND|AT|BY|FOR|IN|OF|ON|OR|THE|TO|&)$/i;

/**
 * Set `text` as large as it goes into a box: every way of breaking it into lines is tried and the
 * one that gives the biggest type wins (a little is paid for a line holding only a scrap such as
 * "2" or "OF", for a line that ends on "OF" or "THE", and for very uneven lines). Words are never
 * broken.
 *
 *   maxWidth, maxHeight  the box, in canvas pixels
 *   maxSize              upper limit for the type size
 *   upper                set in capitals (default)
 *   tracking             extra letter spacing, in em
 *   gap                  space between one baseline and the top of the next line, in em
 *
 * Returns { size, lines: [{ text, width, ascent }], width, height, descent, cap } in canvas
 * pixels. `ascent` is cap height, or more for a line with accents on its capitals; `height` runs
 * from the top of the first line to the last baseline, `descent` is what hangs below that.
 */
export function fitText(ctx, text, { face, maxWidth, maxHeight, maxSize = Infinity, upper = true, tracking = 0.012, gap = 0.2 }) {
  const words = (upper ? text.toUpperCase() : text).trim().split(/\s+/);
  const REF = 200;
  ctx.save();
  ctx.font = face.font(REF);
  ctx.letterSpacing = `${(tracking * REF).toFixed(2)}px`;
  ctx.textBaseline = 'alphabetic';
  const cap = ctx.measureText('H').actualBoundingBoxAscent / REF;
  const memo = new Map();
  const measure = (line) => {
    if (!memo.has(line)) {
      const m = ctx.measureText(line);
      memo.set(line, { text: line, width: m.width / REF - tracking, ascent: Math.max(cap, m.actualBoundingBoxAscent / REF), descent: Math.max(0, m.actualBoundingBoxDescent / REF) });
    }
    return memo.get(line);
  };
  // Every set of line breaks, as a bit mask over the gaps between words. (A text of more than 13
  // words would make that too many: its first words are then kept together on the first line.)
  const gaps = Math.min(words.length - 1, 12), head = words.slice(0, words.length - gaps).join(' '), tail = words.slice(words.length - gaps);
  let best = null;
  for (let breaks = 0; breaks < 1 << gaps; breaks++) {
    const lines = [];
    let line = head;
    for (let i = 0; i < gaps; i++) {
      if (breaks & (1 << i)) { lines.push(line); line = tail[i]; } else line += ' ' + tail[i];
    }
    lines.push(line);
    const set = lines.map(measure);
    const widest = Math.max(...set.map((l) => l.width)), narrowest = Math.min(...set.map((l) => l.width));
    const height = set.reduce((sum, l) => sum + l.ascent, 0) + gap * (set.length - 1);
    const size = Math.min(maxWidth / widest, maxHeight / height, maxSize);
    const scraps = lines.length > 1 ? lines.filter((l) => l.replace(/\s/g, '').length <= 2).length : 0;
    const dangling = lines.slice(0, -1).filter((l) => LINE_END_WEAK.test(l)).length; // "… OF" / "… THE" left hanging
    const score = size * (1 - 0.2 * scraps) * (1 - 0.07 * dangling) * (0.8 + 0.2 * (narrowest / widest));
    if (!best || score > best.score + 1e-9) best = { score, size, set, widest, height };
  }
  ctx.restore();
  const { size } = best;
  return {
    size, tracking, gap: gap * size, cap: cap * size,
    lines: best.set.map((l) => ({ text: l.text, width: l.width * size, ascent: l.ascent * size })),
    width: best.widest * size, height: best.height * size, descent: best.set.at(-1).descent * size,
  };
}

/** Draw what `fitText` returned with its top-left corner at (x, top). */
export function drawText(ctx, fit, face, x, top, color) {
  ctx.save();
  ctx.font = face.font(fit.size);
  ctx.letterSpacing = `${(fit.tracking * fit.size).toFixed(2)}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = color;
  let y = top;
  for (const line of fit.lines) {
    y += line.ascent;
    ctx.fillText(line.text, x, y);
    y += fit.gap;
  }
  ctx.restore();
}
