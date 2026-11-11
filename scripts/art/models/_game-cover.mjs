/**
 * The printed front of a game case — a helper for `game-[slug].mjs` (files starting with "_"
 * never match a catalogue key).
 *
 * A cover is generated, never real artwork: a plain band in the platform colour on top, an
 * abstract geometric pattern in tones of that colour, and the game's title set large in a
 * condensed display face on a dark field at the foot (the pattern runs on underneath it, dimmed).
 * The pattern and all its choices are drawn from the slug, so a game always gets the same cover.
 * No characters, no rating marks, no logos, no wordmarks.
 *
 *   paintCover(ctx, width, height, { title, slug, color, band })
 */
import { alpha, displayFace, drawText, fitText, seeded, tones } from './_print.mjs';

/** Canvas pixels per millimetre of cover: sharp at the 1440 px picture, small enough for any GPU. */
export const PX_PER_MM = 12;

const TAU = Math.PI * 2;

/**
 * A repeating run of tones in which neighbours always differ: the three middle tones in a
 * shuffled order, with `accents` of them swapped for an accent (a light or a dark one, unless
 * `pool` says which).
 */
function run(t, rand, accents = 1, pool = [t.pale, t.ink, t.paper]) {
  const middle = rand.shuffle([t.shade, t.base, t.lift]);
  const out = [0, 1, 2, 3, 4, 5].map((i) => middle[i % 3]);
  const extra = rand.shuffle(pool);
  const slots = rand.shuffle([0, 2, 4]); // never next to each other, also not across the wrap
  for (let k = 0; k < Math.min(accents, extra.length); k++) out[slots[k]] = extra[k];
  return out;
}

/* ── patterns ─────────────────────────────────────────────────────────────────
 * Each fills the area { x, y, w, h } (the cover below the band); the part from y to y + artH is
 * what shows at full strength, so a pattern places its centre of interest there.
 */

function rings(ctx, a, t, rand) {
  const cx = a.x + a.w * rand.pick([0, 0.22, 0.5, 0.78, 1]);
  const cy = a.y + a.artH * rand.pick([0.12, 0.5, 0.92]);
  const step = a.w * rand.between(0.07, 0.115);
  const seq = run(t, rand, rand.int(1, 2));
  const far = Math.max(...[[a.x, a.y], [a.x + a.w, a.y], [a.x, a.y + a.h], [a.x + a.w, a.y + a.h]].map(([x, y]) => Math.hypot(x - cx, y - cy)));
  for (let k = Math.ceil(far / step); k >= 1; k--) {
    ctx.fillStyle = seq[k % seq.length];
    ctx.beginPath();
    ctx.arc(cx, cy, k * step, 0, TAU);
    ctx.fill();
  }
}

function diamonds(ctx, a, t, rand) {
  const cx = a.x + a.w * rand.pick([0.2, 0.5, 0.8]);
  const cy = a.y + a.artH * rand.pick([0.3, 0.5, 0.75]);
  const step = a.w * rand.between(0.085, 0.13);
  const seq = run(t, rand, rand.int(1, 2));
  const squash = rand.pick([1, 1, 1.35]); // taller than wide now and then
  for (let k = Math.ceil((a.w + a.h) / step); k >= 1; k--) {
    const r = k * step;
    ctx.fillStyle = seq[k % seq.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * squash);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r * squash);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
  }
}

function stripes(ctx, a, t, rand) {
  const angle = (rand.pick([-58, -45, -32, 32, 45, 58]) * Math.PI) / 180;
  const unit = a.w * 0.05;
  const seq = run(t, rand, 1);
  const reach = Math.hypot(a.w, a.h);
  ctx.save();
  ctx.translate(a.x + a.w / 2, a.y + a.artH / 2);
  ctx.rotate(angle);
  for (let x = -reach, k = 0; x < reach; k++) {
    const width = unit * rand.pick([1, 1, 2, 2, 3, 4]);
    ctx.fillStyle = seq[k % seq.length];
    ctx.fillRect(x, -reach, width + 1, 2 * reach);
    x += width;
  }
  ctx.restore();
}

function tiles(ctx, a, t, rand) {
  const columns = rand.pick([3, 4]);
  const s = a.w / columns, rows = Math.ceil(a.h / s);
  const grounds = rand.shuffle([t.shade, t.base]);
  const shapes = [t.lift, t.lift, t.base, t.shade, t.pale, t.ink];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = a.x + c * s, y = a.y + r * s, ground = grounds[(r + c) % 2];
      let tone = rand.pick(shapes);
      if (tone === ground) tone = t.lift;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, s + 0.5, s + 0.5);
      ctx.clip();
      ctx.fillStyle = ground;
      ctx.fillRect(x, y, s + 1, s + 1);
      ctx.fillStyle = tone;
      ctx.beginPath();
      const kind = rand();
      if (kind < 0.6) { // a quarter disc in one corner
        const [px, py, from] = rand.pick([[0, 0, 0], [1, 0, 0.25], [1, 1, 0.5], [0, 1, 0.75]]);
        ctx.moveTo(x + px * s, y + py * s);
        ctx.arc(x + px * s, y + py * s, s, from * TAU, (from + 0.25) * TAU);
      } else if (kind < 0.85) { // half a disc on one side
        const [px, py, from] = rand.pick([[0.5, 0, 0], [1, 0.5, 0.25], [0.5, 1, 0.5], [0, 0.5, 0.75]]);
        ctx.arc(x + px * s, y + py * s, s / 2, from * TAU, (from + 0.5) * TAU);
      } else { // a dot
        ctx.arc(x + s / 2, y + s / 2, s * 0.3, 0, TAU);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }
}

function triangles(ctx, a, t, rand) {
  const columns = rand.pick([3, 4, 5]);
  const s = a.w / columns, rows = Math.ceil(a.h / s);
  const pool = [t.shade, t.base, t.lift, t.shade, t.base, t.lift, t.ink, t.pale];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = a.x + c * s, y = a.y + r * s;
      const first = rand.pick(pool);
      let second = rand.pick(pool);
      if (second === first) second = first === t.base ? t.shade : t.base;
      ctx.fillStyle = first;
      ctx.fillRect(x, y, s + 1, s + 1);
      ctx.fillStyle = second;
      ctx.beginPath();
      if (rand.chance(0.5)) { ctx.moveTo(x, y); ctx.lineTo(x + s + 1, y); ctx.lineTo(x, y + s + 1); } else { ctx.moveTo(x + s + 1, y); ctx.lineTo(x + s + 1, y + s + 1); ctx.lineTo(x, y + s + 1); }
      ctx.closePath();
      ctx.fill();
    }
  }
}

function dots(ctx, a, t, rand) {
  const columns = rand.pick([5, 6, 7]);
  const s = a.w / columns, rows = Math.ceil(a.h / (s * 0.866)) + 1;
  const [dx, dy] = rand.pick([[0.86, 0.5], [-0.86, 0.5], [0.3, 0.95], [0.7, -0.7]]);
  const ground = rand.pick([t.shade, t.base]);
  const dot = ground === t.base ? rand.pick([t.pale, t.ink, t.paper]) : rand.pick([t.lift, t.pale]);
  ctx.fillStyle = ground;
  ctx.fillRect(a.x, a.y, a.w, a.h);
  ctx.fillStyle = dot;
  for (let r = -1; r < rows; r++) {
    for (let c = -1; c <= columns; c++) {
      const x = a.x + (c + 0.5 + (r % 2 ? 0.5 : 0)) * s, y = a.y + (r + 0.5) * s * 0.866;
      const along = ((x - a.x) / a.w - 0.5) * dx + ((y - a.y) / a.artH - 0.5) * dy + 0.5;
      const grow = Math.min(1, Math.max(0, along));
      ctx.beginPath();
      ctx.arc(x, y, s * (0.09 + 0.38 * grow), 0, TAU);
      ctx.fill();
    }
  }
}

function chevrons(ctx, a, t, rand) {
  const peaks = rand.pick([1, 2, 3]);
  const half = a.w / (2 * peaks);
  const rise = half * rand.between(0.55, 0.95) * rand.pick([-1, 1]);
  const band = a.w * rand.between(0.075, 0.11);
  const seq = run(t, rand, 1);
  const edge = (y, back) => {
    for (let i = 0; i <= 2 * peaks; i++) {
      const k = back ? 2 * peaks - i : i;
      ctx.lineTo(a.x + k * half, y + (k % 2 ? rise : 0));
    }
  };
  let k = 0;
  for (let y = a.y - Math.abs(rise) - band; y < a.y + a.h + Math.abs(rise); y += band, k++) {
    ctx.fillStyle = seq[k % seq.length];
    ctx.beginPath();
    edge(y, false);
    edge(y + band + 1, true);
    ctx.closePath();
    ctx.fill();
  }
}

/** Blades of uneven width fanning out of a point beyond one corner of the cover. */
function fan(ctx, a, t, rand) {
  const corner = rand.int(0, 3); // 0 top left, then clockwise
  const cx = corner === 0 || corner === 3 ? a.x - a.w * 0.14 : a.x + a.w * 1.14;
  const cy = corner < 2 ? a.y - a.artH * 0.12 : a.y + a.artH * 1.1;
  const from = [0, 0.25, 0.5, 0.75][corner] * TAU - 0.2, sweep = TAU / 4 + 0.4;
  const widths = Array.from({ length: rand.int(8, 12) }, () => rand.pick([1, 1, 1.6, 2.4]));
  const total = widths.reduce((sum, v) => sum + v, 0);
  const seq = run(t, rand, 1, [t.ink]); // tone on tone: white blades among red ones would read as a flag
  const reach = 2.5 * Math.hypot(a.w, a.h);
  let angle = from;
  widths.forEach((v, k) => {
    const next = angle + (sweep * v) / total;
    ctx.fillStyle = seq[k % seq.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, reach, angle, next + 0.003);
    ctx.closePath();
    ctx.fill();
    angle = next;
  });
}

function waves(ctx, a, t, rand) {
  const band = a.w * rand.between(0.085, 0.125);
  const swell = band * rand.between(0.45, 1);
  const length = a.w / rand.pick([1, 1.5, 2]);
  const drift = rand.between(0.2, 0.9) * rand.pick([-1, 1]);
  const seq = run(t, rand, 1);
  let k = 0;
  for (let y = a.y - swell; y < a.y + a.h + swell; y += band, k++) {
    ctx.fillStyle = seq[k % seq.length];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y + a.h + 1);
    for (let i = 0; i <= 64; i++) {
      const x = a.x + (a.w * i) / 64;
      ctx.lineTo(x, y + swell * Math.sin(((x - a.x) / length) * TAU + k * drift));
    }
    ctx.lineTo(a.x + a.w, a.y + a.h + 1);
    ctx.closePath();
    ctx.fill();
  }
}

function blocks(ctx, a, t, rand) {
  const pool = [t.shade, t.base, t.lift, t.base, t.shade, t.lift, t.pale];
  const least = a.w * 0.2, gutter = a.w * 0.012;
  ctx.fillStyle = t.ink;
  ctx.fillRect(a.x, a.y, a.w, a.h);
  const split = (x, y, w, h, depth) => {
    const wide = w > 2 * least, tall = h > 2 * least;
    if (depth === 0 || (!wide && !tall)) {
      const tone = rand.pick(pool);
      ctx.fillStyle = tone;
      ctx.fillRect(x + gutter / 2, y + gutter / 2, w - gutter, h - gutter);
      if (rand.chance(0.3) && Math.min(w, h) > least) { // a disc sitting in the block
        ctx.fillStyle = tone === t.pale ? t.base : rand.pick([t.pale, t.ink]);
        ctx.beginPath();
        ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.27, 0, TAU);
        ctx.fill();
      }
      return;
    }
    if (wide && (!tall || w * rand.between(0.75, 1.25) > h)) {
      const cut = w * rand.pick([1 / 3, 0.5, 2 / 3]);
      split(x, y, cut, h, depth - 1);
      split(x + cut, y, w - cut, h, depth - 1);
    } else {
      const cut = h * rand.pick([1 / 3, 0.5, 2 / 3]);
      split(x, y, w, cut, depth - 1);
      split(x, y + cut, w, h - cut, depth - 1);
    }
  };
  split(a.x - gutter / 2, a.y - gutter / 2, a.w + gutter, a.h + gutter, 4);
}

const PATTERNS = { rings, diamonds, stripes, tiles, triangles, dots, chevrons, fan, waves, blocks };
export const PATTERN_NAMES = Object.keys(PATTERNS);

/**
 * Paint a cover on a 2D canvas of `width` × `height` pixels.
 *   title   the game's name; set in capitals
 *   slug    seeds the pattern
 *   color   the platform colour (#rrggbb)
 *   band    height of the plain top band as a share of the cover height
 * Returns what was chosen ({ pattern, lines, size }) for logs and tests.
 */
export function paintCover(ctx, width, height, { title, slug, color, band = 0.09 }) {
  const t = tones(color);
  const rand = seeded(`tamtam cover:${slug}`);
  const bandHeight = Math.round(height * band);
  const side = width * 0.07, above = width * 0.085, below = width * 0.08; // margins of the title field
  const leastArt = (height - bandHeight) * 0.3; // the pattern always keeps this much

  // the title, as large as the field allows
  const face = displayFace(ctx);
  const fit = fitText(ctx, title, {
    face,
    maxWidth: width - 2 * side,
    maxHeight: height - bandHeight - leastArt - above - below,
    maxSize: width * 0.31,
  });
  const fieldTop = Math.round(height - (fit.height + above + below));

  // the pattern, under everything below the band
  const pattern = rand.pick(PATTERN_NAMES);
  const area = { x: 0, y: bandHeight, w: width, h: height - bandHeight, artH: fieldTop - bandHeight };
  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.fillStyle = t.shade;
  ctx.fillRect(area.x, area.y, area.w, area.h);
  PATTERNS[pattern](ctx, area, t, rand);
  ctx.restore();

  // the title field: the pattern dimmed almost to the darkest tone
  ctx.fillStyle = alpha(t.ink, 0.9);
  ctx.fillRect(0, fieldTop, width, height - fieldTop);
  ctx.fillStyle = t.lift;
  ctx.fillRect(side, fieldTop + above * 0.42, width * 0.13, Math.max(2, width * 0.012)); // a short rule above the title
  drawText(ctx, fit, face, side, fieldTop + above, '#ffffff');

  // the plain band
  ctx.fillStyle = t.base;
  ctx.fillRect(0, 0, width, bandHeight);
  ctx.fillStyle = alpha(t.ink, 0.55);
  ctx.fillRect(0, bandHeight, width, Math.max(1, Math.round(height * 0.0022)));

  return { pattern, lines: fit.lines.map((line) => line.text), size: fit.size, face: face.family };
}
