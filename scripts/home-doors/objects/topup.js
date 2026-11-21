// «بطاقات الشحن» — top-up / gift cards: two ID-1 cards (85.6 × 53.98 mm, r 3.18 mm) in glossy lamination.
// Front: a piano-black red-core gift card printed with the name (sized and centred on its ink), a brand-red sash and a
// red rim; its top edge curls back a little, so its gloss lays one narrow band of the key soft box along the top edge
// (the top ≈ 8 % of the face) and the name sits on black. Behind it, fanned to the right, the gift card's top edge
// resting against it: a pearl card with a steel foil edge, a gold EMV chip and a neutral silver hologram band. The chip
// stands clear of the front card.
import { THREE, M, at, group, roundedRect, extrude, titleMaterial, FONT } from "../kit.js";

export const meta = { turn: -0.3, tilt: 0.0, gap: 0.05, margin: [0.92, 0.86], centerY: 0.04 };

// ───────────────────────────── real proportions (1 mm = MM units)
const MM = 2.2 / 85.6;
const CW = 85.6 * MM;
const CH = 53.98 * MM;
const CR = 3.18 * MM;
const CT = 0.04; // card thickness (≈1.8× a real 0.76 mm card so the edge reads at icon size)
const BEV = 0.012; // the die-cut edge, softly rounded (the flat face starts BEV inside the outline)
const CHIP = { x: 12.3, y: 22.5 }; // the contact plate's centre from the card's left and top edges (mm)

// ───────────────────────────── canvas helpers
function cnv(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
/** A canvas texture laid over a w×h face centred on the origin (cap UVs are the face's own x/y). */
function faceTex(canvas, w, h, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 16;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1 / w, 1 / h);
  t.offset.set(0.5, 0.5);
  t.updateMatrix();
  return t;
}
function rrPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
/** A linear gradient across a W×H face canvas along `angle` (radians, card x/y), spanning the whole card. */
function cardGradient(g, W, H, stops, angle) {
  const px = W / CW;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const half = 0.5 * (Math.abs(CW * ca) + Math.abs(CH * sa));
  const lg = g.createLinearGradient(W / 2 - half * ca * px, H / 2 + half * sa * px, W / 2 + half * ca * px, H / 2 - half * sa * px);
  for (const [t, hex] of stops) lg.addColorStop(t, hex);
  return lg;
}
/** A well-mixed integer hash → [0, 1): dither without the lattice an LCG stream leaves when laid out row by row. */
function hash01(x, y, s = 0) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(s, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/**
 * The tracer copies every map into one 2048² RGBA8 texture array in LINEAR space (three-gpu-pathtracer's
 * RenderTarget2DArray), which leaves ≈ 13 levels between sRGB 24 and 70: a dark gradient bands, each channel stepping in
 * its own place (olive and red stripes across a black print). So a dark map is painted at 2048² (the copy is then 1:1)
 * and dithered here by ±1 linear level; the tracer's pixel filter averages the dither away.
 */
const TEX = 2048;
const SRGB2LIN = new Float32Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
const LIN2SRGB = new Uint8Array(16384).map((_, i) => {
  const l = i / 16383;
  return Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
});
function linearDither(canvas) {
  const g = canvas.getContext("2d");
  const img = g.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let y = 0; y < canvas.height; y++)
    for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      const n = (hash01(x, y, 5) - 0.5) * (2 / 255);
      for (let ch = 0; ch < 3; ch++) {
        const l = Math.min(1, Math.max(0, SRGB2LIN[d[i + ch]] + n));
        d[i + ch] = LIN2SRGB[Math.round(l * 16383)];
      }
    }
  g.putImageData(img, 0, 0);
}
/** Moves a canvas's content by (dx, dy) px, filling the uncovered strip with `fill`. */
function shiftCanvas(canvas, dx, dy, fill) {
  const tmp = cnv(canvas.width, canvas.height);
  tmp.getContext("2d").drawImage(canvas, 0, 0);
  const g = canvas.getContext("2d");
  g.fillStyle = fill;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(tmp, dx, dy);
}

// ───────────────────────────── float fields (blurs and normals stay smooth: no 8-bit terraces)
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / k;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / k;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
/** Three box passes ≈ a Gaussian of the given sigma (px). */
function gaussBlur(src, w, h, sigma) {
  const r = Math.max(1, Math.round(sigma - 0.5));
  return boxBlur(boxBlur(boxBlur(src, w, h, r), w, h, r), w, h, r);
}
/** Height field (row 0 = top) → tangent-space normal map canvas; `strength` scales the slopes. */
function normalCanvas(height, w, h, strength) {
  const c = cnv(w, h);
  const g = c.getContext("2d");
  const img = g.createImageData(w, h);
  const at2 = (x, y) => height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (at2(x + 1, y) - at2(x - 1, y)) * 0.5 * strength;
      const dy = (at2(x, y + 1) - at2(x, y - 1)) * 0.5 * strength;
      const nx = -dx, ny = dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((nz / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}

// ───────────────────────────── the gift card's lean and curl
/**
 * The gift card rests back against the card behind it, pivoting on its top edge. Its face is flat and its top edge curls
 * back by 7° over the top tenth, as a laminated card pressed at its top does. Chosen with scratch/refl2.mjs (a
 * mirror-reflection model of core.js's studio, its matte floor included, checked against the renders): the curl sweeps
 * the key soft box's lower edge across the top ≈ 8 % of the face only (sRGB ≈ 115 at the top, ≈ 30 at 90 % of the
 * height, black below) and everything from the name down mirrors the dark studio sky. A linear bow spreads the gloss
 * over the top third (2.6°: still ≈ 75 at 85 % of the height) or, stronger, tips the lower face's reflection below the
 * horizon, where it mirrors the floor as a grey band; a flat face without the curl keeps only a faint glow.
 * The curl lives in the shading normals of a face cap cut into horizontal strips (curlFace): the tilt depends on height
 * only, so the tracer's interpolation reproduces it within each strip — no 8-bit normal-map terraces, no dither grain —
 * and the clear coat follows it.
 */
const LEAN = -0.205;
const BOW = { lin: 0, curl: 7, from: 0.9, pow: 1.5 };
/** The face's slope (tan of its tilt towards +y) at height y on the card. */
function faceSlope(y) {
  const t = Math.max(0, (y / CH + 0.5 - BOW.from) / (1 - BOW.from));
  return Math.tan(THREE.MathUtils.degToRad(BOW.lin)) * (y / (CH / 2)) + Math.tan(THREE.MathUtils.degToRad(BOW.curl * t ** BOW.pow));
}
/**
 * Rebuilds the front cap (group 0) of a card body as horizontal strips whose shading normals follow faceSlope. The strips
 * run through every vertex of the cap's outline (and points on its edges), so the face stays watertight with the bevel.
 */
function curlFace(mesh) {
  const g = mesh.geometry;
  const front = g.groups.find((gr) => gr.materialIndex === 0);
  const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  const seen = new Map();
  for (let i = front.start; i < front.start + front.count; i++) seen.set(`${P.getX(i).toFixed(7)},${P.getY(i).toFixed(7)}`, [P.getX(i), P.getY(i)]);
  const zf = P.getZ(front.start);
  const ring = [...seen.values()].sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0])); // the outline is convex
  const yLo = Math.min(...ring.map((p) => p[1])), yHi = Math.max(...ring.map((p) => p[1]));
  const ys = ring.map((p) => p[1]);
  for (let y = yLo; y < yHi; y += 0.4 * MM) ys.push(y);
  for (let y = (BOW.from - 0.5) * CH; y < yHi; y += 0.12 * MM) ys.push(y);
  ys.sort((a, b) => a - b);
  const rows = [];
  for (const y of ys) if (!rows.length || y - rows[rows.length - 1] > 1e-6) rows.push(y);
  /** The outline's extent along the row at height y. */
  const span = (y) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.abs(a[1] - b[1]) < 1e-12) {
        if (Math.abs(y - a[1]) < 1e-9) (lo = Math.min(lo, a[0], b[0])), (hi = Math.max(hi, a[0], b[0]));
        continue;
      }
      const t = (y - a[1]) / (b[1] - a[1]);
      if (t < -1e-9 || t > 1 + 1e-9) continue;
      const x = a[0] + (b[0] - a[0]) * Math.min(1, Math.max(0, t));
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
    return [lo, hi];
  };
  const fp = [], fn = [], fu = [];
  const vert = (x, y) => {
    const s = faceSlope(y), l = Math.hypot(s, 1);
    fp.push(x, y, zf);
    fn.push(0, s / l, 1 / l);
    fu.push(x, y);
  };
  let prev = null;
  for (const y of rows) {
    const [l, r] = span(y);
    if (prev) {
      const [y0, l0, r0] = prev;
      vert(l0, y0), vert(r0, y0), vert(r, y);
      vert(l0, y0), vert(r, y), vert(l, y);
    }
    prev = [y, l, r];
  }
  const keep = g.groups.filter((gr) => gr !== front);
  const total = keep.reduce((s, gr) => s + gr.count, 0) + fp.length / 3;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const out = new THREE.BufferGeometry();
  let o = 0;
  for (const gr of keep) {
    pos.set(P.array.subarray(gr.start * 3, (gr.start + gr.count) * 3), o * 3);
    nor.set(N.array.subarray(gr.start * 3, (gr.start + gr.count) * 3), o * 3);
    uv.set(U.array.subarray(gr.start * 2, (gr.start + gr.count) * 2), o * 2);
    out.addGroup(o, gr.count, gr.materialIndex);
    o += gr.count;
  }
  pos.set(fp, o * 3);
  nor.set(fn, o * 3);
  uv.set(fu, o * 2);
  out.addGroup(o, fp.length / 3, 0);
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.dispose();
  mesh.geometry = out;
  return mesh;
}

// ───────────────────────────── the card body: a laminated slab; face on the front cap, a plain back, edge on the sides
function cardBody(faceMat, edgeMat, backMat, curveSegments = 72) {
  const m = extrude(roundedRect(CW, CH, CR), CT, BEV, [faceMat, edgeMat, backMat], { bevelSegments: 8, curveSegments });
  // ExtrudeGeometry puts both caps in group 0: the back lid (z−) first, then the front lid (z+). Give the back its own.
  const g = m.geometry;
  const caps = g.groups.find((gr) => gr.materialIndex === 0);
  const half = caps.count / 2;
  g.groups = g.groups.filter((gr) => gr !== caps);
  g.addGroup(caps.start, half, 2);
  g.addGroup(caps.start + half, half, 0);
  return m;
}
/** Paints a linear foil gradient (vertex colours, linear RGB) across a card mesh, angle in radians. */
function foilGradient(mesh, stops, angle) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 4);
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const half = 0.5 * (Math.abs(CW * ca) + Math.abs(CH * sa));
  const cs = stops.map(([t, hex]) => [t, new THREE.Color(hex)]);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp(0.5 + (0.5 * (pos.getX(i) * ca + pos.getY(i) * sa)) / half, 0, 1);
    let k = 0;
    while (k < cs.length - 2 && t > cs[k + 1][0]) k++;
    const [t0, c0] = cs[k], [t1, c1] = cs[k + 1];
    c.copy(c0).lerp(c1, THREE.MathUtils.smoothstep(t, t0, t1));
    col[i * 4] = c.r;
    col[i * 4 + 1] = c.g;
    col[i * 4 + 2] = c.b;
    col[i * 4 + 3] = 1;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 4));
  return mesh;
}
/** Hot-stamped foil on the die-cut edge: plain metal, no thin film (a rainbow edge read as a toy). */
function foilEdge(o = {}) {
  return new THREE.MeshPhysicalMaterial({ color: "#ffffff", vertexColors: true, metalness: 1, roughness: 0.22, ...o });
}

// ───────────────────────────── foils
const STEEL_FOIL = [[0, "#83868a"], [0.5, "#c4c6c9"], [1, "#eceded"]]; // brushed-steel / silver foil, neutral (gold is the chip's only)
const RED_INK = [[0, "#a10e17"], [0.5, "#d3121b"], [1, "#ec2830"]]; // the gift card's red core and rim: brand red, ±a shade

// ───────────────────────────── the gift card's face: the printed name (titleMaterial) + its artwork, painted into its maps
const ONYX = { color: "#0a0a0a", rough: 0.08 };
/** The ink box of the printed name on a title colour map (canvas px): the bright pixels. */
function inkBox(canvas) {
  const W = canvas.width, H = canvas.height;
  const d = canvas.getContext("2d").getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4] < 128) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  return { x0, y0, x1, y1 };
}
/**
 * Prints the gift card's artwork round the name, leaving the ink untouched: the name is first centred on its ink (kit
 * centres the advance width, and Arabic-script names carry dots and tails off-centre), then a neutral graphite sweep
 * from the key-light corner, a brand-red sash across the lower-right corner and a 1 mm red rim; spot varnish keeps the
 * red satin and the black high-gloss.
 */
function decorateOnyx(mat) {
  const src = mat.map.image;
  const W = src.width, H = src.height;
  const px = W / CW;
  const rc = mat.roughnessMap.image;
  const fr = Math.round(255 * ONYX.rough);
  // 0 — centre the ink optically
  let ink = inkBox(src);
  const dx = Math.round(W / 2 - (ink.x0 + ink.x1 + 1) / 2);
  const dy = Math.round(H / 2 - (ink.y0 + ink.y1 + 1) / 2);
  if (dx || dy) {
    shiftCanvas(src, dx, dy, ONYX.color);
    shiftCanvas(rc, dx, dy, `rgb(${fr},${fr},${fr})`);
    ink = { x0: ink.x0 + dx, x1: ink.x1 + dx, y0: ink.y0 + dy, y1: ink.y1 + dy };
  }
  // the colour map is rebuilt at the tracer's own 2048² (see linearDither), drawn with kit's W×H coordinates scaled in y
  const N = TEX, sy = N / H;
  const c = cnv(N, N);
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(src, 0, 0, N, N);
  // 1 — the graphite sweep from the key-light corner (the print, not a reflection), lightened in so the white ink stays
  // untouched. Exactly neutral: the tone curve's toe subtracts nearly all of a dark value, so even a 3-level tint
  // (≈ 15 % in linear) comes out as brown or navy. Kept low and in the corner, so the name sits on black.
  {
    const img = g.getImageData(0, 0, N, N);
    const d = img.data;
    const hi = [58, 58, 58], lo = [20, 20, 20];
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = (y * N + x) * 4;
        const u = (x + 0.5) / N, v = (y + 0.5) / N;
        const t = Math.min(1, (u * 0.74 + v * 0.66) * 1.1 + 0.12 * u * v);
        const e = (1 - t) ** 2.2;
        for (let ch = 0; ch < 3; ch++) {
          const val = Math.round(lo[ch] + (hi[ch] - lo[ch]) * e);
          if (val > d[i + ch]) d[i + ch] = val;
        }
      }
    g.putImageData(img, 0, 0);
  }
  g.setTransform(1, 0, 0, sy, 0, 0);
  const rg = rc.getContext("2d");
  // spot varnish: high gloss on the black panel and the name, satin on the red print (a gloss band over red reads pink)
  const cc = cnv(W, H);
  const ccg = cc.getContext("2d");
  ccg.fillStyle = "#fff";
  ccg.fillRect(0, 0, W, H);
  const SATIN = "rgb(56,56,56)";
  const RIM = 1.0 * MM;
  const inset = (BEV + RIM) * px;
  const innerR = Math.max(4, (CR - BEV - RIM) * px);
  // 2 — the red sash: a broad and a fine stripe across the lower-right corner, clear of the ink by ≥ 3 mm
  const ang = THREE.MathUtils.degToRad(38);
  const nx = Math.sin(ang), ny = Math.cos(ang); // the stripes' normal, pointing down-right (canvas y is down)
  const inkCorner = ink.x1 * nx + ink.y1 * ny; // the ink's lower-right extreme along the normal
  const d0 = Math.max(inkCorner + 3 * MM * px, (W * nx + H * ny) * 0.74);
  const stripe = (a, b) => {
    const ux = ny, uy = -nx, L = 3 * W;
    const p = (dd, t) => [dd * nx + t * ux, dd * ny + t * uy];
    const pts = [p(a, -L), p(a, L), p(b, L), p(b, -L)];
    const path = new Path2D();
    path.moveTo(...pts[0]);
    for (const q of pts.slice(1)) path.lineTo(...q);
    path.closePath();
    return path;
  };
  const wide = stripe(d0, d0 + 6.5 * MM * px);
  const fine = stripe(d0 + 8.6 * MM * px, d0 + 10.2 * MM * px);
  const inner = new Path2D();
  inner.roundRect(inset, inset, W - 2 * inset, H - 2 * inset, innerR);
  for (const path of [wide, fine]) {
    g.save();
    g.clip(inner);
    const red = g.createLinearGradient(0, H * 0.55, W, H);
    red.addColorStop(0, "#9e0c14");
    red.addColorStop(0.55, "#bf0f18");
    red.addColorStop(1, "#cc1a20");
    g.fillStyle = red;
    g.fill(path);
    g.restore();
    rg.save();
    rg.clip(inner);
    rg.fillStyle = "rgb(102,102,102)"; // satin red ink
    rg.fill(path);
    rg.restore();
    ccg.save();
    ccg.clip(inner);
    ccg.fillStyle = SATIN;
    ccg.fill(path);
    ccg.restore();
  }
  // 3 — the red rim, 1 mm, printed in the edge's red (ink, not metal: a metal rim mirrors the dark sky as maroon and the
  // key as pink; ink stays brand red all round)
  const band = new Path2D();
  band.rect(0, 0, W, H);
  band.roundRect(inset, inset, W - 2 * inset, H - 2 * inset, innerR);
  g.fillStyle = cardGradient(g, W, H, RED_INK, 0.6);
  g.fill(band, "evenodd");
  rg.fillStyle = "rgb(97,97,97)";
  rg.fill(band, "evenodd");
  ccg.fillStyle = SATIN;
  ccg.fill(band, "evenodd");
  g.setTransform(1, 0, 0, 1, 0, 0);
  linearDither(c);
  mat.map.image = c;
  mat.map.needsUpdate = true;
  mat.roughnessMap.needsUpdate = true;
  mat.clearcoatMap = faceTex(cc, CW, CH, false);
  // the gloss is the laminate's: the print's own sheen is kept low, so the red stays red under the reflected soft box
  mat.specularIntensity = 0.3;
  return mat;
}

// ───────────────────────────── printed faces: a print inside a foil-stamped frame that wraps onto the edge
/**
 * A card face: `print(g, W, H)` paints the design inside a foil frame `borderMM` wide (the frame continues the edge's
 * foil gradient). Returns the material (colour + roughness/metalness maps, gloss lamination on top).
 */
function printedFace({ print, stops, angle, borderMM = 0.45, printMetal = 0, printRough = 0.5, foilRough = 0.2, extra = {} }) {
  const W = 1536, H = Math.round((1536 * CH) / CW);
  const px = W / CW;
  const color = cnv(W, H);
  const g = color.getContext("2d");
  g.fillStyle = cardGradient(g, W, H, stops, angle);
  g.fillRect(0, 0, W, H);
  const inset = (BEV + borderMM * MM) * px;
  const r = Math.max(4, (CR - BEV - borderMM * MM) * px);
  g.save();
  rrPath(g, inset, inset, W - 2 * inset, H - 2 * inset, r);
  g.clip();
  print(g, W, H);
  g.restore();
  const orm = cnv(W, H);
  const og = orm.getContext("2d");
  og.fillStyle = `rgb(255,${Math.round(255 * foilRough)},255)`;
  og.fillRect(0, 0, W, H);
  og.fillStyle = `rgb(255,${Math.round(255 * printRough)},${Math.round(255 * printMetal)})`;
  rrPath(og, inset, inset, W - 2 * inset, H - 2 * inset, r);
  og.fill();
  const ormTex = faceTex(orm, CW, CH, false); // roughness in G, metalness in B
  return new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    map: faceTex(color, CW, CH),
    roughness: 1,
    roughnessMap: ormTex,
    metalness: 1,
    metalnessMap: ormTex,
    clearcoat: 1,
    clearcoatRoughness: 0.08, // real PVC lamination is not a perfect mirror (keeps the front card's red edge from ghosting)
    ...extra,
  });
}
/** Pearl: a soft cool-to-warm white and a faint, even guilloché (the lines never bunch). */
function pearlPrint(g, W, H) {
  const lg = g.createLinearGradient(0, 0, W, H);
  lg.addColorStop(0, "#f7f5f6");
  lg.addColorStop(0.5, "#e8e8eb");
  lg.addColorStop(1, "#d3d4da");
  g.fillStyle = lg;
  g.fillRect(0, 0, W, H);
  // a faint nacre: a warm blush drifting into a cool one (printed: a thin-film layer here only added path-trace grain)
  const nacre = g.createLinearGradient(0, H, W, 0);
  nacre.addColorStop(0, "rgba(255,222,232,0.22)");
  nacre.addColorStop(0.5, "rgba(236,236,246,0.12)");
  nacre.addColorStop(1, "rgba(226,230,255,0.22)");
  g.fillStyle = nacre;
  g.fillRect(0, 0, W, H);
  g.lineWidth = 1.4;
  for (let k = 0; k < 44; k++) {
    g.strokeStyle = `rgba(120,118,150,${0.08 + 0.03 * Math.sin(k * 0.45) ** 2})`;
    g.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const u = x / W;
      const y = H * (0.18 + 0.64 * (k / 44)) + H * 0.08 * Math.sin(u * Math.PI * 2.2 + k * 0.14) * Math.cos(u * Math.PI * 0.8 - k * 0.05);
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
}

/** Chamfer distance (px) from every pixel to the nearest gap (mask < 0.5) or to the canvas border. */
function distanceToGaps(mask, w, h) {
  const D = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) D[i] = mask[i] < 0.5 ? 0 : 1e9;
  const S2 = Math.SQRT2;
  const get = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : D[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (D[i] > 0) D[i] = Math.min(D[i], get(x - 1, y) + 1, get(x, y - 1) + 1, get(x - 1, y - 1) + S2, get(x + 1, y - 1) + S2);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (D[i] > 0) D[i] = Math.min(D[i], get(x + 1, y) + 1, get(x, y + 1) + 1, get(x + 1, y + 1) + S2, get(x - 1, y + 1) + S2);
    }
  return D;
}

// ───────────────────────────── the EMV contact plate: 12 × 10 mm, seven gold pads parted by etched gaps
let chipCache = null;
function chipMaterials() {
  if (chipCache) return chipCache;
  const PW = 12, PH = 10, S = 64; // px per mm
  const W = PW * S, H = PH * S;
  // pad mask: white = gold pad, black = etched gap
  const mask = cnv(W, H);
  const g = mask.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "#000";
  g.lineWidth = 0.35 * S;
  const cx = W / 2, cy = H / 2;
  const pw = 4.6 * S, ph = 6.2 * S;
  rrPath(g, cx - pw / 2, cy - ph / 2, pw, ph, 1.1 * S);
  g.stroke();
  g.beginPath();
  for (const s of [-1, 1]) {
    for (const dy of [-1.75, 1.75]) {
      g.moveTo(cx + (s * pw) / 2, cy + dy * S);
      g.lineTo(s < 0 ? -10 : W + 10, cy + dy * S);
    }
    g.moveTo(cx, cy + (s * ph) / 2);
    g.lineTo(cx, s < 0 ? -10 : H + 10);
  }
  g.stroke();
  const md = g.getImageData(0, 0, W, H).data;
  const raw = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) raw[i] = md[i * 4] / 255;
  const pad = gaussBlur(raw, W, H, 0.04 * S); // anti-aliased pads
  // each pad crowns gently from its etched edges (a dome over ≈ 1.6 mm, ≈ 7° at the edge), so the light breaks pad by pad
  const R = 1.6 * S;
  const dist = distanceToGaps(raw, W, H);
  // colour: rich gold on the pads (sRGB ≈ 0.98/0.80/0.42), etched epoxy in the gaps; roughness: polished pads, matte gaps
  const color = cnv(W, H);
  const cg = color.getContext("2d");
  const img = cg.createImageData(W, H);
  const orm = cnv(W, H);
  const og = orm.getContext("2d");
  const oimg = og.createImageData(W, H);
  const height = new Float32Array(W * H);
  const GOLD = [0.98, 0.8, 0.42], EPOXY = [0.2, 0.16, 0.1];
  for (let i = 0; i < W * H; i++) {
    const m = pad[i];
    for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = Math.round(255 * (m * GOLD[ch] + (1 - m) * EPOXY[ch]));
    img.data[i * 4 + 3] = 255;
    oimg.data[i * 4] = 255;
    oimg.data[i * 4 + 1] = Math.round(255 * (m * 0.14 + (1 - m) * 0.6)); // roughness
    oimg.data[i * 4 + 2] = Math.round(255 * m); // metalness
    oimg.data[i * 4 + 3] = 255;
    const t = Math.min(1, dist[i] / R);
    height[i] = m * 0.9 + 0.8 * t * (2 - t);
  }
  cg.putImageData(img, 0, 0);
  og.putImageData(oimg, 0, 0);
  // the pads stand a hair above the gaps, their etched edges rounded
  const nrm = normalCanvas(gaussBlur(height, W, H, 0.1 * S), W, H, 6);
  const w = PW * MM, h = PH * MM;
  const ormTex = faceTex(orm, w, h, false); // roughness in G, metalness in B
  const cap = new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    map: faceTex(color, w, h),
    roughness: 1,
    roughnessMap: ormTex,
    metalness: 1,
    metalnessMap: ormTex,
    normalMap: faceTex(nrm, w, h, false),
    normalScale: new THREE.Vector2(1, 1),
  });
  const side = M.gold({ color: "#e8c27a", roughness: 0.22 });
  chipCache = { cap, side, w, h };
  return chipCache;
}
const POCKET = new THREE.MeshPhysicalMaterial({ color: "#2a2418", roughness: 0.55 });
/** The contact plate in its milled pocket: a hairline (0.2 mm) of dark epoxy shows round the plate. */
function chip() {
  const { cap, side, w, h } = chipMaterials();
  const plate = extrude(roundedRect(w, h, 1.6 * MM), 0.004, 0.0012, [cap, side], { bevelSegments: 4, curveSegments: 24 });
  // the pocket's top sits 0.0002 above the card face (the plate's top is 0.0008 above it)
  const pocket = extrude(roundedRect(w + 0.4 * MM, h + 0.4 * MM, 1.8 * MM), 0.0024, 0.0004, POCKET, { bevelSegments: 2, curveSegments: 24 });
  return group(plate, at(pocket, 0, 0, 0.0002));
}

// ───────────────────────────── the hologram band: a faint silver diffraction foil
/**
 * Neutral satin silver; two or three broad, soft flashes run diagonally along it as plain brightenings of the foil
 * (no spectrum, no thin film: the set allows no colour tint here).
 * No fine lines: they alias to moiré at row size.
 */
function holoMaterial(w, h) {
  const W = 2048, H = Math.max(64, Math.round((2048 * h) / w));
  const col = cnv(W, H);
  const cg = col.getContext("2d");
  const ci = cg.createImageData(W, H);
  const th = cnv(W, H);
  const tg = th.getContext("2d");
  const ti = tg.createImageData(W, H);
  const silver = [0.86, 0.86, 0.86]; // hot-stamped aluminium foil
  const TAU = Math.PI * 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / W, v = y / H;
      const ph = u * 2.2 - v * 0.5 + 0.04 * Math.sin(TAU * (u * 1.3 + v * 0.7)) + 0.35;
      const k = Math.floor(ph), s = (ph - k - 0.06) / 0.58;
      const env = s > 0 && s < 1 ? Math.sin(Math.PI * s) ** 0.8 : 0;
      const strength = 0.75 + 0.25 * Math.cos(TAU * (k * 0.37 + 0.15));
      // the flash: a neutral brightening of the foil (no spectrum, no tint)
      const rb = [1, 1, 1];
      const mix = 0.5 * env * strength;
      // a soft sheen along the band (the foil's own embossing catching the light), ± 4 %
      const sheen = 1 + 0.04 * Math.sin(TAU * (u * 0.9 + 0.2));
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) ci.data[i + c] = Math.round(255 * Math.min(1, (silver[c] * (1 - mix) + rb[c] * mix) * sheen));
      ci.data[i + 3] = 255;
      const t = Math.round(255 * (0.5 + 0.4 * Math.sin(TAU * (u * 1.6 - v * 0.4))));
      ti.data[i] = ti.data[i + 1] = ti.data[i + 2] = t;
      ti.data[i + 3] = 255;
    }
  cg.putImageData(ci, 0, 0);
  tg.putImageData(ti, 0, 0);
  return new THREE.MeshPhysicalMaterial({
    color: "#ffffff",
    map: faceTex(col, w, h),
    metalness: 1,
    roughness: 0.1,
  });
}

// ───────────────────────────── the name's size
/**
 * Sizes the name by its INK (not its advance width), so every language keeps the same clearance from the rim. kit's
 * printedTitle walks font sizes down a ladder (1.3·fitH·H · 0.97ⁿ) until the line fits: pick fitW just above the
 * advance width at the target size and fitH so that a rung of the ladder lands exactly on it.
 */
function inkFit(text, lang, share, weight) {
  const W = 2048, H = Math.max(64, Math.round((2048 * CH) / CW));
  const mc = document.createElement("canvas").getContext("2d");
  mc.direction = lang === "en" ? "ltr" : "rtl";
  mc.font = `${weight} 1000px ${FONT}`;
  const m = mc.measureText(text);
  const inkW = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / 1000;
  const size = (share * W) / inkW;
  const inkH = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) / 1000;
  let n = 1;
  while (inkH * size > size / (1.3 * 0.97 ** n) - 2 && n < 60) n++;
  return { fitW: ((size * m.width) / 1000 / W) * 1.002, fitH: size / (1.3 * 0.97 ** n * H) };
}
/**
 * The name's ink width as a share of the card, and its weight. The Arabic-script names are limited by the card's width;
 * the Latin one is set smaller so its letters match the others' height across the row (the set's 9–12 % of the tile).
 */
const NAME = { ar: { share: 0.9, weight: 800 }, ckb: { share: 0.9, weight: 800 }, en: { share: 0.75, weight: 800 } };

// ───────────────────────────── the two cards
function onyxCard(text, lang) {
  const { share, weight } = NAME[lang] ?? NAME.ar;
  const base = M.gloss({ color: ONYX.color, roughness: ONYX.rough, clearcoat: 1, clearcoatRoughness: 0.05 });
  const face = decorateOnyx(titleMaterial(text, lang, CW, CH, base, { ...inkFit(text, lang, share, weight), weight, ink: "#f6f6f4", inkRoughness: 0.45, faceRoughness: ONYX.rough, relief: 0 }));
  // a red-core card: the die-cut edge shows the red PVC core under the gloss laminate (lit like the rim, never mirroring
  // the dark sky as a black slot or the key as salmon)
  const edge = new THREE.MeshPhysicalMaterial({ color: "#ffffff", vertexColors: true, roughness: 0.38, clearcoat: 0.8, clearcoatRoughness: 0.14 });
  const back = M.satin({ color: "#ececf0" }); // a white printed back (as gift cards have), so the chip behind mirrors light, not black
  return foilGradient(curlFace(cardBody(face, edge, back)), RED_INK, 0.6);
}
const chipAt = (o) => o.add(at(chip(), -CW / 2 + CHIP.x * MM, CH / 2 - CHIP.y * MM, CT / 2 - 0.0012));
function pearlCard() {
  const face = printedFace({ print: pearlPrint, stops: STEEL_FOIL, angle: 0.6, printMetal: 0, printRough: 0.42, foilRough: 0.18 });
  const body = foilGradient(cardBody(face, foilEdge(), M.white({ color: "#e4e4e8" })), STEEL_FOIL, 0.6);
  const o = group(body);
  chipAt(o);
  // the hologram band, hot-stamped across the lower part of the card (the top, once the card is turned over)
  const bw = CW - 2 * 4 * MM, bh = 6 * MM;
  const band = extrude(roundedRect(bw, bh, 0.6 * MM), 0.003, 0.0003, holoMaterial(bw, bh), { bevelSegments: 2, curveSegments: 12 });
  o.add(at(band, 0, -CH / 2 + 9 * MM, CT / 2 - 0.001));
  return o;
}

// ───────────────────────────── the pair: the pearl card turns by th about a pivot hidden below, fanning out to the right
// (chosen with scratch/lay3.mjs + hduo.mjs: the gift card as large as the frame allows — its name ≈ 62 % of the picture's
// width, centred at ≈ 56 % of its height — with the pearl card's chip whole and ≥ 20 px clear of it, the band ≈ 85 % seen).
// The gift card's top edge rests 0.3–2 mm in front of the pearl card (z, swing; scratch/h2/contact.mjs): the pearl's
// laminate mirrors the gift card's back and red edge, and the 2.4–5.4 mm gap before showed that mirror image as a second
// red outline above the top-right corner.
const BACK = { px: 0.1, py: -2.56, th: -0.15, y: 0.3, z: -0.065, swing: -0.03 };
/** Places a card that would stand at (BACK.px, y) turned by th about the pivot (BACK.px, BACK.py). */
function fanned(card, th, y, z) {
  const r = y - BACK.py;
  card.rotation.z += th;
  return at(card, BACK.px - r * Math.sin(th), BACK.py + r * Math.cos(th), z);
}

export function build({ text, lang }) {
  const o = new THREE.Group();
  // the gift card in front, leaning back against the pearl card (pivoting on its top edge)
  const lean = new THREE.Group();
  lean.add(at(onyxCard(text, lang), 0, -CH / 2, 0));
  lean.rotation.x = LEAN;
  o.add(at(lean, 0, CH / 2, 0));
  // behind it, the pearl card fans out to the right, turned over so its chip and band show; its free end swings forward
  const pearl = pearlCard();
  pearl.rotation.z = Math.PI;
  const swing = new THREE.Group();
  swing.add(pearl);
  swing.rotation.y = BACK.swing;
  o.add(fanned(swing, BACK.th, BACK.y, BACK.z));
  return o;
}
