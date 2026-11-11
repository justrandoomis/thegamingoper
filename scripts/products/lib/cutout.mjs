/**
 * Background treatment for product photos: pure pixel work on 8-bit sRGB RGBA with straight alpha.
 * No I/O, no sharp — scripts/products/images.mjs decodes and encodes, this module decides.
 *
 *   treat({ data, width, height }, { kind, cutout, holes, pad, trim })
 *     → { data, width, height, transparent, background, dominant, method, reason, stats }
 *
 * Options (per image, from scripts/products/image-options.json; the defaults are the rules below):
 *   cutout false  never cut out: the photo stays opaque, trimmed on its own background
 *   holes  true   closed windows of pure background colour (the inside of a headband arch) are cut out
 *                 too, instead of keeping the photo opaque — only after looking at the result
 *   pad    0.06   padding around a trimmed object, as a share of its longer side
 *   trim   false  an opaque photo keeps its whole frame
 *   extend true   the object touches the frame of a plain canvas (a cover on a square canvas): the
 *                 canvas is extended on every side first, so the object can be cut out
 *   clean  true   a transparent source: faint parts more than 2 px outside the solid object (a baked
 *                 soft shadow, a glow) and small separate specks are dropped — the stage draws its own
 *                 shadow
 *
 * Rules:
 *   - A source with real transparency keeps it: trimmed to the object (alpha ≥ 50%) plus PAD, the
 *     faint parts (soft shadows) widening the picture evenly so the object stays centred.
 *   - "screenshot" is left as it is. "box-art" too, unless the cover sits on a plain light canvas
 *     (a pack shot): then the canvas is treated like any other plain background. A cover whose own
 *     border is a plain dark colour is never cropped.
 *   - Any other opaque photo on a plain light background (≥ 90% of the outer 2 px within ΔE 6 of
 *     one colour, L* ≥ 72) gets a careful cut-out. When any check fails it stays opaque, trimmed to
 *     its content plus PAD on its own background colour, and that colour is reported so the
 *     storefront can frame it on a matching surface. On a plain dark background: the same trim.
 *
 * The cut-out never guesses inside the object:
 *   1. Every pixel gets its colour distance to the background (CIE76 ΔE in Lab, ¼ ΔE steps). A
 *      bucket-queue flood from the image border computes, for every pixel, the lowest tolerance at
 *      which a 4-connected flood through near-background pixels reaches it (a minimax path).
 *   2. Tolerance: 1.5 ΔE above the border's own noise (its 99th percentile + 0.75, at least 1.25).
 *      Interior regions are never flooded; enclosed background-coloured areas stay opaque.
 *   3. Gap guard: light regions the flood reached only through gaps narrower than ~2r+1 px are put
 *      back (how white products leak through a highlight); thin slivers stay background.
 *   4. Shadows: soft contact shadows and floor reflections (neutral, darker, smooth, darkening
 *      inwards, below the object, < half its size) go with the background — the stage draws its own
 *      — and so do small floor pockets they close off.
 *   5. Edge: in a 2 px band, alpha and colour are unmixed against the local background and the
 *      best-fitting solid foreground colour nearby (no white halo); next to a removed shadow the band
 *      is 4 px deep (no light hairline at the contact line); where product and background are too
 *      close to unmix, the hard edge is feathered by one pixel.
 *
 * Checks (any failure keeps the photo opaque): foreground 2–98.5% of the photo; little restored by
 * the gap guard; nothing inside the object flooded above the noise floor (a near-white body behind a
 * gap in its outline); the object does not touch the frame; no more pieces than at the noise floor
 * and no faint separate piece (a reflection, a white part on white); no hole-like window of pure
 * background colour (inside a thin ring: strap loops, zip pulls — the cut-out would show it as a
 * white blob); at most 5% of the outline without an 8 ΔE edge against the background next to it.
 * Known limit: a body exactly the background's colour behind a wide gap in its outline cannot be
 * told from background by colour or by shape.
 */

export const PHOTO_KINDS = ['hero', 'angle', 'detail', 'in-box', 'box-art', 'screenshot'];
/** Kinds that are pictures in their own right: never cut out of their rectangle. */
const FLAT_KINDS = new Set(['box-art', 'screenshot']);
/** Padding around a trimmed object, as a share of its longer side, on every side. */
export const PAD = 0.06;
/** Bump when a change here changes the output: images.mjs folds it into every image's input hash. */
export const TREATMENT_VERSION = 8;

/* ── colour ────────────────────────────────────────────────────────────────── */

const LINEAR = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const EPS = 216 / 24389, KAPPA = 24389 / 27;
const labF = (t) => (t > EPS ? Math.cbrt(t) : (KAPPA * t + 16) / 116);
const linear = (v) => (Number.isInteger(v) ? LINEAR[v] : v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);

/** CIE Lab (D65) of an sRGB colour (channels 0–255, fractions allowed). */
export function lab(r, g, b) {
  const R = linear(r), G = linear(g), B = linear(b);
  const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const fy = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const fz = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function hex(rgb) {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/* ── entry point ───────────────────────────────────────────────────────────── */

/**
 * @param {{ data: Uint8Array, width: number, height: number }} image  RGBA, 8-bit sRGB, straight alpha
 * @param {{ kind?: string, cutout?: boolean, holes?: boolean, pad?: number, trim?: boolean, extend?: boolean, clean?: boolean }} [options]
 */
export function treat(image, { kind = 'hero', cutout: mayCut = true, holes = false, pad = PAD, trim = true, extend = false, clean = false } = {}) {
  let { width: w, height: h } = image;
  let n = w * h;
  const data = image.data;
  if (data.length !== n * 4) throw new Error(`expected ${n * 4} bytes of RGBA, got ${data.length}`);
  if (!PHOTO_KINDS.includes(kind)) throw new Error(`unknown image kind "${kind}"`);
  if (!(pad >= 0 && pad <= 0.4)) throw new Error(`pad ${pad} must be between 0 and 0.4`);

  let see = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) see++;
  if (see >= n * 0.002) {
    const out = Uint8Array.from(data);
    for (let i = 0; i < out.length; i += 4) if (out[i + 3] === 0) out[i] = out[i + 1] = out[i + 2] = 0;
    const stats = { seeThrough: round(see / n) };
    if (clean) stats.cleaned = round(cleanAlpha(out, w, h) / n);
    const trimmed = trimToAlpha(out, w, h, pad);
    return { ...trimmed, transparent: true, background: null, dominant: dominantColor(trimmed.data, null), method: 'alpha', reason: null, stats };
  }

  // Opaque (a handful of see-through pixels at most): drop the alpha channel's noise.
  let rgba = Uint8Array.from(data);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  let extended = 0;
  if (extend) {
    // The object touches the frame of its canvas: give it a margin of the canvas colour first.
    extended = Math.max(4, Math.round(0.02 * Math.max(w, h)));
    const fill = borderStats(rgba, w, h).rgb;
    rgba = crop(rgba, w, h, -extended, -extended, w + 2 * extended, h + 2 * extended, fill);
    w += 2 * extended; h += 2 * extended; n = w * h;
  }
  const border = borderStats(rgba, w, h);
  const plain = border.share >= 0.9;
  const light = border.lab[0] >= 72;
  const background = border.share >= 0.6 ? hex(border.rgb) : null;
  const stats = { borderShare: round(border.share), borderNoise: round(border.noise), backgroundL: round(border.lab[0]) };
  if (extended) stats.extended = extended;
  const untouched = (reason) => ({ data: rgba, width: w, height: h, transparent: false, background, dominant: dominantColor(rgba, null), method: 'untouched', reason, stats });

  const kept = (reason) => (trim ? opaqueTrim(rgba, w, h, border, background, stats, reason, pad) : { ...untouched(reason), method: 'opaque' });

  if (kind === 'screenshot') return untouched(null);
  if (!plain) return untouched(FLAT_KINDS.has(kind) ? null : `the background is not plain (${pct(border.share)} of the border matches its colour)`);
  // A cover with a plain dark border is a framed cover, not a cover on a canvas: never crop it.
  if (!light) return FLAT_KINDS.has(kind) ? untouched(null) : kept('the background is dark');
  if (!mayCut) return kept('kept opaque by its image option');

  const cut = cutout(rgba, w, h, border, holes);
  Object.assign(stats, cut.stats);
  if (!cut.ok) return kept(cut.reason);
  const trimmed = trimToAlpha(cut.data, w, h, pad);
  return { ...trimmed, transparent: true, background: null, dominant: dominantColor(trimmed.data, null), method: 'cutout', reason: null, stats };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const pct = (v) => `${Math.round(v * 100)}%`;

/* ── border ────────────────────────────────────────────────────────────────── */

/**
 * The background as the outermost two pixels of the frame see it (product shots are often cropped
 * tight): per-channel median, then the mean of the ring pixels within ΔE 6 of it. `share` is how much
 * of the ring that is, `noise` the 99th percentile of their distance to the mean (JPEG noise, a
 * faint vignette).
 */
function borderStats(data, w, h) {
  const band = Math.min(2, Math.floor(Math.min(w, h) / 2));
  const index = [];
  for (let y = 0; y < h; y++) {
    if (y < band || y >= h - band) for (let x = 0; x < w; x++) index.push(y * w + x);
    else {
      for (let x = 0; x < band; x++) index.push(y * w + x);
      for (let x = w - band; x < w; x++) index.push(y * w + x);
    }
  }
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (const p of index) for (let c = 0; c < 3; c++) hist[c][data[p * 4 + c]]++;
  const median = hist.map((hc) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hc[v]) * 2 >= index.length) return v;
    return 255;
  });
  const ref = lab(...median);
  const inliers = [];
  const sum = [0, 0, 0];
  for (const p of index) {
    const i = p * 4;
    const [L, A, B] = lab(data[i], data[i + 1], data[i + 2]);
    if (Math.hypot(L - ref[0], A - ref[1], B - ref[2]) <= 6) {
      inliers.push(p);
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
    }
  }
  const rgb = inliers.length ? sum.map((s) => s / inliers.length) : median;
  const mean = lab(...rgb);
  const distances = inliers.map((p) => {
    const [L, A, B] = lab(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    return Math.hypot(L - mean[0], A - mean[1], B - mean[2]);
  }).sort((a, b) => a - b);
  const noise = distances.length ? distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.99))] : Infinity;
  return { rgb: rgb.map((v) => Math.round(v)), lab: mean, share: inliers.length / index.length, noise, band };
}

/* ── distance map and flood ────────────────────────────────────────────────── */

/** Colour → quantised values, cached for the 16.7M colours (most photos repeat a few thousand). */
let lutQ = null, lutL = null, lutA = null, lutB = null;

/**
 * Per pixel, quantised: q = ΔE to the background × 4 (capped at 254), L = L* × 2.5, A / B = a* / b*
 * + 128. q is what the flood reads; L, A, B serve local comparisons (edges, shadows) at ~0.4–1 ΔE.
 */
function colourMaps(data, n, bgLab) {
  lutQ ??= new Uint8Array(1 << 24);
  lutL ??= new Uint8Array(1 << 24);
  lutA ??= new Uint8Array(1 << 24);
  lutB ??= new Uint8Array(1 << 24);
  lutQ.fill(0);
  const q = new Uint8Array(n), L = new Uint8Array(n), A = new Uint8Array(n), B = new Uint8Array(n);
  const [L0, A0, B0] = bgLab;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    let v = lutQ[key];
    if (v === 0) {
      const R = LINEAR[data[i]], G = LINEAR[data[i + 1]], Bl = LINEAR[data[i + 2]];
      const fx = labF((0.4124564 * R + 0.3575761 * G + 0.1804375 * Bl) / 0.95047);
      const fy = labF(0.2126729 * R + 0.7151522 * G + 0.072175 * Bl);
      const fz = labF((0.0193339 * R + 0.119192 * G + 0.9503041 * Bl) / 1.08883);
      const l = 116 * fy - 16, a = 500 * (fx - fy), b = 200 * (fy - fz);
      v = Math.min(254, Math.round(Math.hypot(l - L0, a - A0, b - B0) * 4)) + 1;
      lutQ[key] = v;
      lutL[key] = clamp255(l * 2.5);
      lutA[key] = clamp255(a + 128);
      lutB[key] = clamp255(b + 128);
    }
    q[p] = v - 1;
    L[p] = lutL[key]; A[p] = lutA[key]; B[p] = lutB[key];
  }
  return { q, L, A, B };
}

/** ΔE between two pixels from the quantised maps. */
function localDelta(maps, i, j) {
  return Math.hypot((maps.L[i] - maps.L[j]) / 2.5, maps.A[i] - maps.A[j], maps.B[i] - maps.B[j]);
}

/**
 * For every pixel, the smallest tolerance at which a 4-connected flood from the image border
 * through pixels with q ≤ tolerance reaches it: min over paths of the max q along the path.
 * Bucket queue, O(n). Pixels never reached below 255 stay 255.
 */
function floodLevels(q, w, h) {
  const n = w * h;
  const level = new Uint8Array(n).fill(255);
  const seen = new Uint8Array(n);
  const next = new Int32Array(n);
  const head = new Int32Array(256).fill(-1);
  const push = (p, lv) => { seen[p] = 1; level[p] = lv; next[p] = head[lv]; head[lv] = p; };
  for (let x = 0; x < w; x++) {
    if (!seen[x]) push(x, q[x]);
    const b = (h - 1) * w + x;
    if (!seen[b]) push(b, q[b]);
  }
  for (let y = 1; y < h - 1; y++) {
    const a = y * w, b = y * w + w - 1;
    if (!seen[a]) push(a, q[a]);
    if (!seen[b]) push(b, q[b]);
  }
  for (let lv = 0; lv < 255; lv++) {
    while (head[lv] !== -1) {
      const p = head[lv];
      head[lv] = next[p];
      const x = p % w;
      if (x > 0 && !seen[p - 1]) push(p - 1, q[p - 1] > lv ? q[p - 1] : lv);
      if (x < w - 1 && !seen[p + 1]) push(p + 1, q[p + 1] > lv ? q[p + 1] : lv);
      if (p >= w && !seen[p - w]) push(p - w, q[p - w] > lv ? q[p - w] : lv);
      if (p < n - w && !seen[p + w]) push(p + w, q[p + w] > lv ? q[p + w] : lv);
    }
  }
  return level;
}

/**
 * Chamfer (3-4) distance from every pixel to the nearest pixel whose mask value is `target`
 * (3 units per pixel), capped at 60000. Outside the image counts as neither.
 */
function chamfer(mask, w, h, target) {
  const n = w * h;
  const d = new Uint16Array(n);
  for (let p = 0; p < n; p++) d[p] = mask[p] === target ? 0 : 60000;
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) {
      let v = d[p];
      if (v === 0) continue;
      if (x > 0 && d[p - 1] + 3 < v) v = d[p - 1] + 3;
      if (y > 0) {
        if (d[p - w] + 3 < v) v = d[p - w] + 3;
        if (x > 0 && d[p - w - 1] + 4 < v) v = d[p - w - 1] + 4;
        if (x < w - 1 && d[p - w + 1] + 4 < v) v = d[p - w + 1] + 4;
      }
      d[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1, p = y * w + w - 1; x >= 0; x--, p--) {
      let v = d[p];
      if (v === 0) continue;
      if (x < w - 1 && d[p + 1] + 3 < v) v = d[p + 1] + 3;
      if (y < h - 1) {
        if (d[p + w] + 3 < v) v = d[p + w] + 3;
        if (x < w - 1 && d[p + w + 1] + 4 < v) v = d[p + w + 1] + 4;
        if (x > 0 && d[p + w - 1] + 4 < v) v = d[p + w - 1] + 4;
      }
      d[p] = v;
    }
  }
  return d;
}

/**
 * Connected components of the pixels where mask[p] === value. Returns per-component area, the
 * largest `score[p]` inside, and the label of every pixel (0 = not in the set).
 */
function components(mask, value, w, h, eight, score) {
  const n = w * h;
  const labels = new Int32Array(n);
  const queue = new Int32Array(n);
  const area = [0], best = [0];
  let count = 0;
  for (let s = 0; s < n; s++) {
    if (mask[s] !== value || labels[s]) continue;
    const id = ++count;
    let headQ = 0, tail = 0, a = 0, m = 0;
    labels[s] = id; queue[tail++] = s;
    while (headQ < tail) {
      const p = queue[headQ++];
      a++;
      if (score && score[p] > m) m = score[p];
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!eight && dx !== 0 && dy !== 0)) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (mask[k] === value && !labels[k]) { labels[k] = id; queue[tail++] = k; }
        }
      }
    }
    area.push(a); best.push(m);
  }
  return { labels, count, area, best };
}

/* ── the cut-out ───────────────────────────────────────────────────────────── */

function cutout(rgba, w, h, border, holes = false) {
  const n = w * h;
  const long = Math.max(w, h);
  const maps = colourMaps(rgba, n, border.lab);
  const { q } = maps;
  const level = floodLevels(q, w, h);

  // Tolerance: 1.5 ΔE above the border's own noise. Whether that was safe is what the checks decide.
  const qMin = Math.max(5, Math.min(28, Math.ceil((border.noise + 0.75) * 4)));
  const qt = qMin + 6;
  const atFloor = new Uint8Array(n);
  for (let p = 0; p < n; p++) atFloor[p] = level[p] <= qMin ? 1 : 0;
  const stats = { tolerance: qt / 4, floor: qMin / 4 };
  const fail = (reason) => ({ ok: false, reason, stats });

  const isBg = new Uint8Array(n);
  for (let p = 0; p < n; p++) isBg[p] = level[p] <= qt ? 1 : 0;

  // Light regions reached only through gaps narrower than ~2r: put back.
  const r = Math.max(2, Math.min(4, Math.round(long / 700)));
  const restored = restoreBehindGaps(isBg, chamfer(isBg, w, h, 0), w, h, r);
  stats.restored = round(restored / n);

  // Soft shadows and floor reflections go with the background (the stage draws its own). After the
  // gap guard, so that floor closed off under the object is judged as floor, not as a leak.
  const shadow = removeShadow(isBg, maps, w, h, border.lab);
  stats.shadow = round(shadow.area / n);
  if (shadow.rejected) stats.shadowKept = shadow.rejected;

  // Specks: tiny islands, and small faint ones, are background.
  const fg = components(isBg, 0, w, h, true, q);
  const tiny = Math.max(12, n * 0.00002), small = Math.max(24, n * 0.0001);
  for (let id = 1; id <= fg.count; id++) {
    if (fg.area[id] < tiny || (fg.area[id] < small && fg.best[id] < qt + 40)) fg.area[id] = -fg.area[id];
  }
  let fgArea = 0;
  for (let p = 0; p < n; p++) {
    const id = fg.labels[p];
    if (!id) continue;
    if (fg.area[id] < 0) isBg[p] = 1; else fgArea++;
  }
  stats.foreground = round(fgArea / n);
  if (restored > Math.max(0.004 * n, 0.02 * fgArea)) return fail('light parts of the object meet the background through thin gaps');
  if (fgArea < 0.02 * n || fgArea > 0.985 * n) return fail(`implausible foreground share ${pct(fgArea / n)}`);

  // Nothing inside the object may have gone with the background: pixels the flood took only above
  // the noise floor (a near-white body behind a gap in its outline) that have object on all four
  // sides in their row and column. Shadows and the anti-aliased rim lie outside, so they pass.
  const inside = insideLoss(isBg, level, qMin, w, h, shadow.mask);
  stats.insideLoss = round(inside / n);
  if (inside > Math.max(0.002 * n, 0.01 * fgArea)) return fail('light parts inside the object are almost the colour of the background');

  // The object must not be cropped by the frame.
  let touching = 0;
  for (let x = 0; x < w; x++) touching += (isBg[x] ? 0 : 1) + (isBg[(h - 1) * w + x] ? 0 : 1);
  for (let y = 1; y < h - 1; y++) touching += (isBg[y * w] ? 0 : 1) + (isBg[y * w + w - 1] ? 0 : 1);
  stats.touching = touching;
  if (touching > 0.002 * 2 * (w + h)) return fail('the object touches the edge of the photo');

  // The object must not fall apart compared with the noise floor (shadows removed from both),
  // and no piece may be a ghost: nothing in it clearly differs from the background.
  const pieces = pieceStats(isBg, q, qt, w, h, fgArea);
  const floorBg = new Uint8Array(n);
  let floorFg = 0;
  for (let p = 0; p < n; p++) { floorBg[p] = atFloor[p] || (shadow.mask && shadow.mask[p]) ? 1 : 0; if (!floorBg[p]) floorFg++; }
  const floorPieces = pieceStats(floorBg, q, qt, w, h, floorFg).count;
  stats.pieces = pieces.count;
  if (pieces.count > floorPieces) return fail(`the object splits into ${pieces.count} pieces (${floorPieces} at the noise floor)`);
  if (pieces.faint) return fail('a separate faint shape remains (a reflection, or a white part on white)');

  // Closed windows of pure background colour behind a thin wall (strap loops, zip pulls, a white box
  // face); "thin" is relative to the object: 3% of its longer side — a cord or a strap, not the
  // margin between a card's edge and its lettering. Any such window is a hole the cut-out would
  // show as a white blob, whatever the size of the object around it.
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let p = 0; p < n; p++) {
    if (isBg[p]) continue;
    const x = p % w, y = (p - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const wall = Math.max(4, Math.round(0.03 * Math.max(maxX - minX + 1, maxY - minY + 1)));
  const windows = closedWindows(isBg, q, qMin, w, h, wall, Math.max(0.0003 * n, 0.002 * fgArea, 24), fgArea);
  stats.windows = round(windows.total / n);
  if (holes) {
    // Opted in per image, after looking (the product has nothing of the background's colour): every
    // closed region of pure background colour is background seen through the object — the windows
    // above, and the small pockets the gap guard put back (behind a cable, inside a strap loop).
    const opened = openWindows(isBg, q, qt, w, h, closedWindows(isBg, q, qMin, w, h, wall, 24, fgArea, true));
    stats.holes = round(opened / n);
    fgArea -= opened;
    stats.foreground = round(fgArea / n);
    if (pieceStats(isBg, q, qt, w, h, fgArea).faint) return fail('a faint shape remains after opening the closed windows');
  } else if (windows.total > 0) return fail('the background colour shows inside closed shapes (loops, white faces)');

  // The outline must be a real edge against the background next to it, everywhere but a few spots.
  const weak = weakOutline(isBg, maps, w, h);
  stats.weakOutline = round(weak);
  if (weak > 0.05) return fail(`${pct(weak)} of the outline is too faint to cut safely`);

  const data = matte(rgba, w, h, isBg, border.rgb, shadow.mask);
  return { ok: true, data, stats };
}

/**
 * Soft shadows and floor reflections of a studio shot, grown from the background into pixels that
 * look like the background in shade: neutral (Δab ≤ 4 from it), darker than it but not below L* 30,
 * smooth (L* steps to every neighbour ≤ 4 per pixel at 2000 px, more in smaller photos) and getting
 * no lighter going inwards. The object's edge stops the growth.
 * The region is kept as background only when it lies below the object's middle, is smaller than
 * half the object and is light on average; otherwise nothing changes. A shadow under a white part
 * cannot be told from that part's shaded underside: there the cut runs through a smooth slope, which
 * the faint-outline check catches, and the photo stays opaque.
 */
function removeShadow(isBg, maps, w, h, bgLab) {
  const n = w * h;
  const { L, A, B } = maps;
  const Lbg = bgLab[0] * 2.5, Abg = bgLab[1] + 128, Bbg = bgLab[2] + 128;
  const shadow = new Uint8Array(n);
  const queue = new Int32Array(n);
  let tail = 0;
  const step = 2.5 * Math.max(4, Math.min(10, (4 * 2000) / Math.max(w, h)));
  const smooth = (k) => {
    const v = L[k], x = k % w;
    return !((x > 0 && Math.abs(v - L[k - 1]) > step) || (x < w - 1 && Math.abs(v - L[k + 1]) > step) ||
      (k >= w && Math.abs(v - L[k - w]) > step) || (k < n - w && Math.abs(v - L[k + w]) > step));
  };
  const grow = (k, from) => {
    if (isBg[k] || shadow[k]) return;
    const v = L[k];
    if (v > Lbg + 1 || v < 75 || v > L[from] + 4) return;
    const da = A[k] - Abg, db = B[k] - Bbg;
    if (da * da + db * db > 16 || !smooth(k)) return;
    shadow[k] = 1;
    queue[tail++] = k;
  };
  const neighbours = (p, visit) => {
    const x = p % w;
    if (x > 0) visit(p - 1, p);
    if (x < w - 1) visit(p + 1, p);
    if (p >= w) visit(p - w, p);
    if (p < n - w) visit(p + w, p);
  };
  for (let p = 0; p < n; p++) if (isBg[p]) neighbours(p, grow);
  for (let head = 0; head < tail; head++) neighbours(queue[head], grow);
  if (!tail) return { area: 0, mask: null };

  let objectArea = 0, objectY = 0, shadowY = 0, shadowL = 0;
  for (let p = 0; p < n; p++) {
    if (isBg[p]) continue;
    const y = (p - (p % w)) / w;
    if (shadow[p]) { shadowY += y; shadowL += L[p]; } else { objectArea++; objectY += y; }
  }
  objectY /= Math.max(1, objectArea);
  shadowY /= tail;
  shadowL /= tail * 2.5;
  if (tail > 0.5 * objectArea) return { area: 0, mask: null, rejected: 'larger than half the object' };
  if (shadowY < objectY) return { area: 0, mask: null, rejected: 'not below the object' };
  if (shadowL < bgLab[0] - 40) return { area: 0, mask: null, rejected: 'too dark for a shadow' };

  for (let p = 0; p < n; p++) if (shadow[p]) isBg[p] = 1;

  // Small pockets of floor closed off by the contact line or a reflection (between two feet, under a
  // curved grip): light, neutral, within 0.4% of the photo's size of the shadow, each at most 0.2% of
  // the photo.
  const floorLike = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    if (isBg[p] || L[p] < Lbg - 62) continue;
    const da = A[p] - Abg, db = B[p] - Bbg;
    if (da * da + db * db <= 16) floorLike[p] = 1;
  }
  const pockets = components(floorLike, 1, w, h, false, null);
  const toShadow = chamfer(shadow, w, h, 1);
  const reach = 3 * Math.max(3, Math.round(Math.max(w, h) * 0.004));
  const near = new Uint8Array(pockets.count + 1);
  for (let p = 0; p < n; p++) if (pockets.labels[p] && toShadow[p] <= reach) near[pockets.labels[p]] = 1;
  let area = tail;
  for (let p = 0; p < n; p++) {
    const id = pockets.labels[p];
    if (id && near[id] && pockets.area[id] <= 0.002 * n) { isBg[p] = 1; shadow[p] = 1; area++; }
  }
  return { area, mask: shadow };
}

/**
 * Background pixels reached from the border only through channels narrower than ~2r+1 px, in
 * regions wider than that, are flipped back to foreground. Thin gaps (between two parts) stay
 * background. Returns how many pixels were restored.
 */
function restoreBehindGaps(isBg, toFg, w, h, r) {
  const n = w * h;
  const R = 3 * r;
  const reach = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const seed = (p) => { if (isBg[p] && !reach[p] && toFg[p] >= R) { reach[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { seed(y * w); seed(y * w + w - 1); }
  while (head < tail) {
    const p = queue[head++], x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < n - w) seed(p + w);
  }
  // Grow the wide region back into its own rim, at most r + 2 px.
  let start = 0;
  for (let depth = 0; depth < r + 2; depth++) {
    const end = tail;
    for (let j = start; j < end; j++) {
      const p = queue[j], x = p % w;
      const visit = (k) => { if (isBg[k] && !reach[k]) { reach[k] = 2; queue[tail++] = k; } };
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < n - w) visit(p + w);
    }
    start = end;
  }
  // What is left: thin slivers stay background, wide pockets go back to the object.
  const left = new Uint8Array(n);
  for (let p = 0; p < n; p++) left[p] = isBg[p] && !reach[p] ? 1 : 0;
  const pockets = components(left, 1, w, h, false, toFg);
  let restored = 0;
  for (let p = 0; p < n; p++) {
    const id = pockets.labels[p];
    if (id && pockets.best[id] >= R) { isBg[p] = 0; restored++; }
  }
  return restored;
}

/**
 * Background pixels the flood took only above the noise floor (level > floor) that lie inside the
 * object: object pixels to their left and right in their row and above and below in their column.
 * Removed shadow pixels do not count (they were judged on their own).
 */
function insideLoss(isBg, level, floor, w, h, shadowMask) {
  const rowFirst = new Int32Array(h).fill(w), rowLast = new Int32Array(h).fill(-1);
  const colFirst = new Int32Array(w).fill(h), colLast = new Int32Array(w).fill(-1);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) {
      if (isBg[p]) continue;
      if (x < rowFirst[y]) rowFirst[y] = x;
      if (x > rowLast[y]) rowLast[y] = x;
      if (y < colFirst[x]) colFirst[x] = y;
      if (y > colLast[x]) colLast[x] = y;
    }
  }
  let count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) {
      if (!isBg[p] || level[p] <= floor || (shadowMask && shadowMask[p])) continue;
      if (x > rowFirst[y] && x < rowLast[y] && y > colFirst[x] && y < colLast[x]) count++;
    }
  }
  return count;
}

/**
 * Foreground pieces (8-connected) holding at least 0.3% of the foreground; `faint` when one of them
 * has nothing in it more than 10 ΔE from the background (a reflection, a white part on white).
 */
function pieceStats(isBg, q, qt, w, h, fgArea) {
  const fg = components(isBg, 0, w, h, true, q);
  let count = 0, faint = false;
  for (let id = 1; id <= fg.count; id++) {
    if (fg.area[id] < Math.max(64, 0.003 * fgArea)) continue;
    count++;
    if (fg.best[id] < qt + 40) faint = true;
  }
  return { count, faint };
}

/**
 * Area of closed windows inside the object that look like holes: they show the pure background
 * colour (q ≤ floor), are at least `minArea` px, and either at least 60% of their rim is within
 * `wall` px of the outside background — a window inside a thin ring (a strap loop, a zip pull) —
 * or they are large: 6% of the object or more (the inside of a headband arch closed off by a cable,
 * the gap between a headband and its suspension band). A printed white logo that large keeps the
 * photo opaque too: the two cannot be told apart, and opaque is the safe side.
 * A white panel near one edge of a box or a card (an age-rating box, lettering) is near the outside
 * on one side only, and white far inside the object (a logo on a screen) not at all; neither counts.
 * `all` (option holes): every region of pure background colour of at least `minArea` counts.
 */
function closedWindows(isBg, q, floor, w, h, wall, minArea, fgArea, all = false) {
  const n = w * h;
  const pure = new Uint8Array(n);
  for (let p = 0; p < n; p++) pure[p] = !isBg[p] && q[p] <= floor ? 1 : 0;
  const parts = components(pure, 1, w, h, false, null);
  const toOutside = chamfer(isBg, w, h, 1);
  const rim = new Float64Array(parts.count + 1), rimNear = new Float64Array(parts.count + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) {
      const id = parts.labels[p];
      if (!id) continue;
      const edge = x === 0 || x === w - 1 || y === 0 || y === h - 1 || parts.labels[p - 1] !== id || parts.labels[p + 1] !== id || parts.labels[p - w] !== id || parts.labels[p + w] !== id;
      if (!edge) continue;
      rim[id]++;
      if (toOutside[p] <= 3 * wall + 3) rimNear[id]++;
    }
  }
  let total = 0;
  const counted = new Uint8Array(parts.count + 1);
  for (let id = 1; id <= parts.count; id++) {
    if (parts.area[id] >= minArea && (all || rimNear[id] >= 0.6 * rim[id] || parts.area[id] >= 0.06 * fgArea)) { total += parts.area[id]; counted[id] = 1; }
  }
  return { total, labels: parts.labels, counted };
}

/**
 * Turns the counted windows into background, grown from their pure pixels through everything within
 * the cut-out's tolerance (their anti-aliased rim is then unmixed by the matte like any other edge).
 * Returns how many pixels were opened.
 */
function openWindows(isBg, q, qt, w, h, windows) {
  const n = w * h;
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let p = 0; p < n; p++) if (windows.counted[windows.labels[p]] && windows.labels[p]) { isBg[p] = 1; queue[tail++] = p; }
  while (head < tail) {
    const p = queue[head++], x = p % w;
    const visit = (k) => { if (!isBg[k] && q[k] <= qt) { isBg[k] = 1; queue[tail++] = k; } };
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < n - w) visit(p + w);
  }
  return tail;
}

/**
 * Share of the outline (foreground pixels next to the background) where nothing within 2 px
 * inwards differs by 8 ΔE or more from the background pixel right next to it — white, or the shade
 * of a removed shadow: a slope, not an edge. A cut through a smooth surface shows up here.
 */
function weakOutline(isBg, maps, w, h) {
  const STRONG = 8;
  let outline = 0, weak = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w; x < w; x++, p++) {
      if (isBg[p]) continue;
      const outside = x > 0 && isBg[p - 1] ? p - 1 : x < w - 1 && isBg[p + 1] ? p + 1 : y > 0 && isBg[p - w] ? p - w : y < h - 1 && isBg[p + w] ? p + w : -1;
      if (outside < 0) continue;
      outline++;
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (!isBg[k] && localDelta(maps, k, outside) >= STRONG) { edge = true; break; }
        }
      }
      if (!edge) weak++;
    }
  }
  return outline ? weak / outline : 0;
}

/**
 * Alpha and colour in a band around the cut: 2 px inside, 1 px outside. Each band pixel C is
 * explained as a mix of the local background B and the solid foreground colour F nearby that fits
 * best: alpha = projection of C − B on F − B, colour = B + (C − B) / alpha (the halo removed).
 * Where no solid foreground differs enough from B (white on white, hair-thin parts), the hard edge
 * is feathered by one pixel instead.
 * Next to a removed shadow the band reaches 4 px in and F comes from ≥ 5 px inside: the light
 * hairline a floor reflection leaves along the contact line is then explained as product over shade
 * and fades out, while light rims against the plain background (a console's rails) are kept.
 */
function matte(rgba, w, h, isBg, bgRGB, shadowMask) {
  const n = w * h;
  const toBg = chamfer(isBg, w, h, 1);
  const toFg = chamfer(isBg, w, h, 0);
  const toShadow = shadowMask ? chamfer(shadowMask, w, h, 1) : null;
  const out = new Uint8Array(n * 4);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (isBg[p]) continue;
    out[i] = rgba[i]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i + 2]; out[i + 3] = 255;
  }
  const feather = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const deep = toShadow !== null && toShadow[p] <= 15;
      if (isBg[p] ? toFg[p] > 3 : toBg[p] > (deep ? 12 : 6)) continue;
      const solid = deep ? 15 : 6;
      const i = p * 4;
      const Cr = rgba[i], Cg = rgba[i + 1], Cb = rgba[i + 2];

      let sr = 0, sg = 0, sb = 0, ns = 0;
      for (let dy = -3; dy <= 3; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -3; dx <= 3; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (isBg[k]) { sr += rgba[k * 4]; sg += rgba[k * 4 + 1]; sb += rgba[k * 4 + 2]; ns++; }
        }
      }
      const Br = ns >= 4 ? sr / ns : bgRGB[0], Bg = ns >= 4 ? sg / ns : bgRGB[1], Bb = ns >= 4 ? sb / ns : bgRGB[2];

      let best = Infinity, bestA = 0, bestF = -1;
      for (const R of deep ? [6, 9] : [3, 6]) {
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -R; dx <= R; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const k = yy * w + xx;
            if (isBg[k] || toBg[k] < solid) continue;
            const vr = rgba[k * 4] - Br, vg = rgba[k * 4 + 1] - Bg, vb = rgba[k * 4 + 2] - Bb;
            const vv = vr * vr + vg * vg + vb * vb;
            if (vv < 900) continue;
            let a = ((Cr - Br) * vr + (Cg - Bg) * vg + (Cb - Bb) * vb) / vv;
            a = a < 0 ? 0 : a > 1 ? 1 : a;
            const er = Cr - Br - a * vr, eg = Cg - Bg - a * vg, eb = Cb - Bb - a * vb;
            const residual = er * er + eg * eg + eb * eb + 2 * (dx * dx + dy * dy);
            if (residual < best) { best = residual; bestA = a; bestF = k; }
          }
        }
        if (bestF >= 0) break;
      }
      if (bestF < 0) { feather.push(p); continue; }
      if (best > 2000) continue; // not a mix of these two colours: keep the hard decision
      let a = bestA;
      if (a < 0.04) a = 0; else if (a > 0.97) a = 1;
      if (a === 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
      if (a >= 0.2) {
        out[i] = clamp255(Br + (Cr - Br) / a); out[i + 1] = clamp255(Bg + (Cg - Bg) / a); out[i + 2] = clamp255(Bb + (Cb - Bb) / a);
      } else {
        out[i] = rgba[bestF * 4]; out[i + 1] = rgba[bestF * 4 + 1]; out[i + 2] = rgba[bestF * 4 + 2];
      }
      out[i + 3] = Math.round(a * 255);
    }
  }
  for (const p of feather) {
    const x = p % w, y = (p - x) / w;
    let inside = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && !isBg[yy * w + xx]) inside++;
      }
    }
    const i = p * 4;
    const a = Math.round((inside / 9) * 255);
    if (a === 0) { out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0; continue; }
    out[i] = rgba[i]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i + 2]; out[i + 3] = a;
  }
  return out;
}

/**
 * Option `clean` on a transparent source: keeps the object — the largest opaque piece (alpha ≥ 250)
 * and every opaque piece of at least 2% of its size — with its anti-aliased rim (2 px), and drops
 * the rest: see-through parts further out (a baked soft shadow, a floor glow, however dense) and
 * small separate specks. Only for photos whose product has no see-through parts of its own.
 * Returns how many pixels were cleared.
 */
function cleanAlpha(rgba, w, h) {
  const n = w * h;
  const solid = new Uint8Array(n);
  for (let p = 0; p < n; p++) solid[p] = rgba[p * 4 + 3] >= 250 ? 1 : 0;
  const pieces = components(solid, 1, w, h, true, null);
  let largest = 0;
  for (let id = 1; id <= pieces.count; id++) largest = Math.max(largest, pieces.area[id]);
  const keep = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const id = pieces.labels[p];
    if (id && pieces.area[id] >= 0.02 * largest) keep[p] = 1;
  }
  const near = chamfer(keep, w, h, 1);
  let cleared = 0;
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    if (rgba[i + 3] === 0 || keep[p] || near[p] <= 6) continue;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0;
    cleared++;
  }
  return cleared;
}

/* ── framing ───────────────────────────────────────────────────────────────── */

function box(rgba, w, h, minAlpha) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0, i = y * w * 4 + 3; x < w; x++, i += 4) {
      if (rgba[i] < minAlpha) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * The object (alpha ≥ 50%) centred with `share` (PAD) of its longer side on every side; fainter
 * parts (a soft shadow) widen the picture evenly when they reach further than the padding.
 */
function trimToAlpha(rgba, w, h, share = PAD) {
  const o = box(rgba, w, h, 128), s = box(rgba, w, h, 10);
  if (!o || !s) throw new Error('the picture is empty');
  const ow = o.maxX - o.minX + 1, oh = o.maxY - o.minY + 1;
  const pad = Math.max(ow, oh) * share;
  const cx = (o.minX + o.maxX + 1) / 2, cy = (o.minY + o.maxY + 1) / 2;
  const halfW = Math.max(ow / 2 + pad, cx - s.minX, s.maxX + 1 - cx);
  const halfH = Math.max(oh / 2 + pad, cy - s.minY, s.maxY + 1 - cy);
  const width = Math.round(2 * halfW), height = Math.round(2 * halfH);
  const x0 = Math.round(cx - halfW), y0 = Math.round(cy - halfH);
  return { data: crop(rgba, w, h, x0, y0, width, height, null), width, height };
}

/** Copy a window of the image; outside the source it is `fill` (RGB, opaque) or transparent. */
function crop(rgba, w, h, x0, y0, width, height, fill) {
  const out = new Uint8Array(width * height * 4);
  if (fill) for (let i = 0; i < out.length; i += 4) { out[i] = fill[0]; out[i + 1] = fill[1]; out[i + 2] = fill[2]; out[i + 3] = 255; }
  const from = Math.max(x0, 0), to = Math.min(x0 + width, w);
  if (to <= from) return out;
  for (let y = 0; y < height; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= h) continue;
    out.set(rgba.subarray((sy * w + from) * 4, (sy * w + to) * 4), (y * width + (from - x0)) * 4);
  }
  return out;
}

/**
 * An opaque photo on a plain background, kept opaque: cropped to everything that differs from the
 * background (at the noise floor, so nothing of the object is lost) plus PAD, the new margin filled
 * with the background colour. Left as it is when the content reaches the frame.
 */
function opaqueTrim(rgba, w, h, border, background, stats, reason, share = PAD) {
  const n = w * h;
  const { q } = colourMaps(rgba, n, border.lab);
  const level = floodLevels(q, w, h);
  const qMin = Math.max(5, Math.min(28, Math.ceil((border.noise + 0.75) * 4)));
  const isBg = new Uint8Array(n);
  for (let p = 0; p < n; p++) isBg[p] = level[p] <= qMin ? 1 : 0;
  const fg = components(isBg, 0, w, h, true, null);
  const keep = Math.max(24, n * 0.0001);
  let minX = w, minY = h, maxX = -1, maxY = -1;
  const content = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    const id = fg.labels[p];
    if (!id || fg.area[id] < keep) continue;
    content[p] = 1;
    const x = p % w, y = (p - x) / w;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const result = (data, width, height) => ({ data, width, height, transparent: false, background, dominant: dominantColor(data, null, border.rgb), method: 'opaque', reason, stats });
  if (maxX < 0 || minX === 0 || minY === 0 || maxX === w - 1 || maxY === h - 1) return result(rgba, w, h);
  const ow = maxX - minX + 1, oh = maxY - minY + 1;
  const pad = Math.round(Math.max(ow, oh) * share);
  const width = ow + 2 * pad, height = oh + 2 * pad;
  return result(crop(rgba, w, h, minX - pad, minY - pad, width, height, border.rgb), width, height);
}

/** The steps, for tests and for debugging a decision on one photo. Not part of the pipeline's API. */
export const internals = { borderStats, colourMaps, floodLevels, removeShadow, restoreBehindGaps, insideLoss, closedWindows, weakOutline, chamfer, components };

/* ── colour summary ────────────────────────────────────────────────────────── */

/**
 * The most common solid colour (coarse 4-bit histogram, then the mean of that bin), as #rrggbb.
 * Pixels close to `ignore` (the background of an opaque photo) do not count.
 */
export function dominantColor(rgba, mask, ignore) {
  const bins = new Map();
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    if (rgba[i + 3] < 250 || (mask && !mask[p])) continue;
    if (ignore && Math.abs(rgba[i] - ignore[0]) + Math.abs(rgba[i + 1] - ignore[1]) + Math.abs(rgba[i + 2] - ignore[2]) < 24) continue;
    const bin = ((rgba[i] >> 4) << 8) | ((rgba[i + 1] >> 4) << 4) | (rgba[i + 2] >> 4);
    let b = bins.get(bin);
    if (!b) bins.set(bin, (b = [0, 0, 0, 0]));
    b[0]++; b[1] += rgba[i]; b[2] += rgba[i + 1]; b[3] += rgba[i + 2];
  }
  let best = null;
  for (const b of bins.values()) if (!best || b[0] > best[0]) best = b;
  if (!best) return ignore ? hex(ignore) : '#808080';
  return hex([best[1] / best[0], best[2] / best[0], best[3] / best[0]]);
}
