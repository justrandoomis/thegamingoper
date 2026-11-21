// «سماعات الرأس» — a premium over-ear gaming headset, seen from the front and a little above.
// Anatomy (modelled as worn by someone facing us: x to the right as we see it, y up, z towards the camera; 1 unit ≈ 8 cm):
//   headband   a padded protein-leather band: padded rolls and red top-stitching along both edges, seam welts, and on
//              its broad, flattened crown a recessed satin panel with the name, piped in brand red; black end sleeves
//   sliders    brushed steel bars from the sleeves down to the forks
//   forks      aluminium yokes over the top of each cup, on pivot hubs with screws
//   cups       oval satin-gunmetal shells (parting line), spun-aluminium outer plates with a diamond-cut chamfer and a
//              red ring; protein-leather cushions, gathered at the back and pleated at the opening, over a mesh baffle
//   mic        a flexible gooseneck boom from the near cup (the wearer's left), swept in towards the mouth, foam
//              windscreen, red mute ring
// The whole headset leans its crown towards the camera (PITCH) so the broad top of the band faces the viewer. The name
// panel is laid onto the band through the studio camera's own view (core.js's camera and fit, replicated below), so its
// letters stand upright in the picture although the band is tipped, turned and curved.
import { THREE, M, rng, titleMaterial } from "../kit.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const meta = { turn: -0.22, tilt: 0.1, gap: 0.04, margin: [0.9, 0.67], centerY: 0.21 };
const PITCH = 0.66;
// each cup swivels on its slider axis: the far cup shows its cushion, the mic cup turns its outer plate to the camera
const SWIVEL = { "-1": -0.22, "1": -0.5 };
const CUP_SCALE = 1.0;
const CUP_Y = 0.08; // the cups ride this much higher on their sliders (keeps the picture compact, the steel still shows)
const DEBUG = false; // true: logs the parts' pixel boxes (shows as "browser errors" in render.mjs)

// ───────────────────────────── maths
const TAU = Math.PI * 2;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const spow = (v, p) => Math.sign(v) * Math.abs(v) ** p;
const gauss = (x, s) => Math.exp(-((x / s) ** 2));
const P = (o) => new THREE.MeshPhysicalMaterial(o);

/** n points evenly spaced round a closed CCW curve f(t), t ∈ [0,1): [{x, y, nx, ny}] with outward normals. */
function loop(f, n, dense = 4096) {
  const pts = [];
  for (let i = 0; i < dense; i++) pts.push(f(i / dense));
  return resample(pts, n);
}
function resample(pts, n) {
  const dense = pts.length;
  const cum = [0];
  for (let i = 1; i <= dense; i++) {
    const a = pts[i - 1], b = pts[i % dense];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[dense];
  const out = [];
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = (i / n) * L;
    while (cum[k + 1] < s) k++;
    const a = pts[k], b = pts[(k + 1) % dense];
    const t = (s - cum[k]) / (cum[k + 1] - cum[k] || 1);
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out.map((p, i) => {
    const a = out[(i - 1 + n) % n], b = out[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    return { x: p[0], y: p[1], nx: dy / l, ny: -dx / l, L };
  });
}
/** A superellipse |x/a|^n + |y/b|^n = 1. */
const se = (a, b, n) => (t) => [a * spow(Math.cos(t * TAU), 2 / n), b * spow(Math.sin(t * TAU), 2 / n)];
/** A rounded rectangle w×h, corner r, as a closed CCW curve. */
function rrectLoop(w, h, r, n) {
  const s = new THREE.Shape();
  const x = w / 2, y = h / 2;
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r);
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y);
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r);
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  const pts = s.getSpacedPoints(4096).slice(0, -1).map((p) => [p.x, p.y]);
  return resample(pts, n);
}

/**
 * A smooth mesh from a grid of points rows[j][i] = [x, y, z]; i runs round (closed when wrapI), j along (closed when
 * wrapJ). Seams are duplicated for clean UVs, their normals welded; poles (collapsed rows) get one shared normal.
 * Winding is made outward automatically. Tangents follow +i (or a custom tangent(j, i, normal) → [x, y, z, w]).
 */
function gridMesh(rows, mat, { wrapI = true, wrapJ = false, uv = null, tangent = null } = {}) {
  const m = rows.length, n = rows[0].length;
  const ci = wrapI ? n + 1 : n, cj = wrapJ ? m + 1 : m;
  const count = ci * cj;
  const pos = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  let cx = 0, cy = 0, cz = 0;
  for (let j = 0; j < cj; j++)
    for (let i = 0; i < ci; i++) {
      const k = j * ci + i, p = rows[j % m][i % n];
      pos[k * 3] = p[0];
      pos[k * 3 + 1] = p[1];
      pos[k * 3 + 2] = p[2];
      cx += p[0];
      cy += p[1];
      cz += p[2];
      const q = uv ? uv(j, i) : [i / (ci - 1), j / (cj - 1)];
      uvs[k * 2] = q[0];
      uvs[k * 2 + 1] = q[1];
    }
  cx /= count;
  cy /= count;
  cz /= count;
  const quads = [];
  for (let j = 0; j < cj - 1; j++)
    for (let i = 0; i < ci - 1; i++) {
      const a = j * ci + i;
      quads.push([a, a + 1, a + ci + 1, a + ci]);
    }
  const V = (k) => [pos[k * 3] - cx, pos[k * 3 + 1] - cy, pos[k * 3 + 2] - cz];
  const det = (a, b, c) => {
    const A = V(a), B = V(b), C = V(c);
    return A[0] * (B[1] * C[2] - B[2] * C[1]) - A[1] * (B[0] * C[2] - B[2] * C[0]) + A[2] * (B[0] * C[1] - B[1] * C[0]);
  };
  let vol = 0;
  for (const [a, b, c, d] of quads) vol += det(a, b, d) + det(b, c, d);
  const idx = [];
  for (const [a, b, c, d] of quads) vol < 0 ? idx.push(a, d, b, b, d, c) : idx.push(a, b, d, b, c, d);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nor = g.attributes.normal.array;
  const weld = (list) => {
    let x = 0, y = 0, z = 0;
    for (const k of list) {
      x += nor[k * 3];
      y += nor[k * 3 + 1];
      z += nor[k * 3 + 2];
    }
    const l = Math.hypot(x, y, z) || 1;
    for (const k of list) {
      nor[k * 3] = x / l;
      nor[k * 3 + 1] = y / l;
      nor[k * 3 + 2] = z / l;
    }
  };
  if (wrapI) for (let j = 0; j < cj; j++) weld([j * ci, j * ci + n]);
  if (wrapJ) for (let i = 0; i < ci; i++) weld([i, m * ci + i]);
  if (wrapI && wrapJ) weld([0, n, m * ci, m * ci + n]);
  for (let j = 0; j < cj; j++) {
    const r = rows[j % m];
    let pole = true;
    for (let i = 1; i < n && pole; i++) if (Math.abs(r[i][0] - r[0][0]) + Math.abs(r[i][1] - r[0][1]) + Math.abs(r[i][2] - r[0][2]) > 1e-7) pole = false;
    if (pole) weld(Array.from({ length: ci }, (_, i) => j * ci + i));
  }
  // tangents (never parallel to the normal: the tracer would make NaNs)
  const tan = new Float32Array(count * 4);
  const at = (j, i) => rows[((j % m) + m) % m][((i % n) + n) % n];
  for (let j = 0; j < cj; j++)
    for (let i = 0; i < ci; i++) {
      const k = j * ci + i;
      const N = [nor[k * 3], nor[k * 3 + 1], nor[k * 3 + 2]];
      let t, w = 1;
      if (tangent) {
        const r = tangent(j % m, i % n, N);
        t = [r[0], r[1], r[2]];
        w = r[3];
      } else {
        const diff = (jj) => {
          const a = wrapI ? at(jj, i - 1) : rows[jj][Math.max(0, (i % n) - 1)];
          const b = wrapI ? at(jj, i + 1) : rows[jj][Math.min(n - 1, (i % n) + 1)];
          return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        };
        const jr = j % m;
        t = diff(jr);
        if (Math.hypot(...t) < 1e-9) t = diff(Math.min(m - 1, jr + 1));
        if (Math.hypot(...t) < 1e-9) t = diff(Math.max(0, jr - 1));
      }
      let d = t[0] * N[0] + t[1] * N[1] + t[2] * N[2];
      t = [t[0] - N[0] * d, t[1] - N[1] * d, t[2] - N[2] * d];
      let l = Math.hypot(...t);
      if (l < 1e-6) {
        // fall back to any direction perpendicular to the normal
        const ref = Math.abs(N[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        d = ref[0] * N[0] + ref[1] * N[1] + ref[2] * N[2];
        t = [ref[0] - N[0] * d, ref[1] - N[1] * d, ref[2] - N[2] * d];
        l = Math.hypot(...t);
      }
      tan[k * 4] = t[0] / l;
      tan[k * 4 + 1] = t[1] / l;
      tan[k * 4 + 2] = t[2] / l;
      tan[k * 4 + 3] = w;
    }
  g.setAttribute("tangent", new THREE.BufferAttribute(tan, 4));
  return new THREE.Mesh(g, mat);
}

/** Rings of a puck: outline points scaled by s, pushed out by d along the outline normal, at height z. */
function puckRows(O, prof) {
  return prof.map(([s, d, z]) => O.map((p) => [p.x * s + p.nx * d, p.y * s + p.ny * d, z]));
}
/** A rounded-edge plate profile for puckRows: flat cap (scaled to a pole), quarter-round bevel, side, bottom. */
function plateProfile(d, bevel, { K = 10, B = 6, bottom = true } = {}) {
  const prof = [];
  for (let k = 0; k <= K; k++) prof.push([k / K, -bevel * (k / K), d / 2]);
  for (let k = 1; k <= B; k++) {
    const a = (k / B) * (Math.PI / 2);
    prof.push([1, -bevel * (1 - Math.sin(a)), d / 2 - bevel * (1 - Math.cos(a))]);
  }
  for (let k = 0; k <= B; k++) {
    const a = (k / B) * (Math.PI / 2);
    prof.push([1, -bevel * (1 - Math.cos(a)), -d / 2 + bevel * (1 - Math.sin(a))]);
  }
  if (bottom) for (let k = K - 1; k >= 0; k--) prof.push([k / K, -bevel * (k / K), -d / 2]);
  return prof;
}

// ───────────────────────────── procedural normal maps (tileable)
function normalCanvas(height, size, strength) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const h = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * 0.5 * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * 0.5 * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (-dx / l * 0.5 + 0.5) * 255;
      img.data[i + 1] = (dy / l * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / l * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}
function normalTexture(canvas, wrap = THREE.RepeatWrapping) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap;
  t.anisotropy = 8;
  return t;
}
/** Tileable cellular noise: f(d1, d2) per pixel, d1/d2 the distances to the nearest two cell points. */
function cellular(size, cells, seed, f) {
  const r = rng(seed);
  const pts = new Float32Array(cells * cells * 2).map(() => 0.08 + r() * 0.84);
  const h = new Float32Array(size * size);
  const cs = size / cells;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const gx = x / cs, gy = y / cs, ci = Math.floor(gx), cj = Math.floor(gy);
      let d1 = 1e9, d2 = 1e9;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di, jj = cj + dj;
          const k = (((jj % cells) + cells) % cells) * cells + (((ii % cells) + cells) % cells);
          const d = (ii + pts[k * 2] - gx) ** 2 + (jj + pts[k * 2 + 1] - gy) ** 2;
          if (d < d1) {
            d2 = d1;
            d1 = d;
          } else if (d < d2) d2 = d;
        }
      h[y * size + x] = f(Math.sqrt(d1), Math.sqrt(d2));
    }
  return h;
}
const maps = {};
/** Pebbled protein-leather grain: creases between soft pebbles. */
function leatherMap() {
  if (!maps.leather) maps.leather = normalTexture(normalCanvas(cellular(512, 44, 17, (d1, d2) => 1 - Math.exp(-(d2 - d1) * 5)), 512, 2.6));
  return maps.leather;
}
/** Open-cell foam: many small round pores. */
function foamMap() {
  if (!maps.foam) maps.foam = normalTexture(normalCanvas(cellular(512, 96, 41, (d1) => Math.min(1, d1 * 1.6) ** 0.7), 512, 1.6));
  return maps.foam;
}
function noise1(seed) {
  const r = rng(seed);
  const table = new Float32Array(8192).map(() => r());
  return (t) => {
    const i = Math.floor(t), f = t - i;
    const a = table[i & 8191], b = table[(i + 1) & 8191];
    return a + (b - a) * f * f * (3 - 2 * f);
  };
}
/** Spun (concentric) brushing for the cup plates, centred in the texture. */
function spunMap() {
  if (maps.spun) return maps.spun;
  const size = 1024, n1 = noise1(23), n2 = noise1(29);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5, dy = y - size / 2 + 0.5;
      const rr = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
      h[y * size + x] = n1(rr * 1.9 + n2(th * 30 + 50) * 0.8) * 0.7 + n2(rr * 6.3 + 900) * 0.3;
    }
  maps.spun = normalTexture(normalCanvas(h, size, 1.1), THREE.ClampToEdgeWrapping);
  return maps.spun;
}
/** Straight brushing (lines along v). */
function brushMap() {
  if (maps.brush) return maps.brush;
  const size = 512, n1 = noise1(31), n2 = noise1(37);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) h[y * size + x] = n1(x * 1.3 + n2(y * 0.01) * 3) * 0.7 + n2(x * 4.1 + 300) * 0.3;
  maps.brush = normalTexture(normalCanvas(h, size, 1.0));
  return maps.brush;
}

// ───────────────────────────── materials
function materials() {
  const leather = leatherMap();
  return {
    leather: P({ color: "#29282b", roughness: 0.56, sheen: 0.2, sheenRoughness: 0.7, sheenColor: new THREE.Color("#5c5b60"), normalMap: leather, normalScale: new THREE.Vector2(0.14, 0.14) }),
    cushion: P({ color: "#262528", roughness: 0.5, sheen: 0.32, sheenRoughness: 0.5, sheenColor: new THREE.Color("#5a595e"), normalMap: leather, normalScale: new THREE.Vector2(0.16, 0.16) }),
    shell: P({ color: "#2b2d33", metalness: 0.7, roughness: 0.4, clearcoat: 0.2, clearcoatRoughness: 0.3 }),
    sleeve: M.satin({ color: "#16161a", roughness: 0.42, clearcoat: 0.15, clearcoatRoughness: 0.4 }),
    plate: P({ color: "#9ea3ab", metalness: 1, roughness: 0.22, normalMap: spunMap(), normalScale: new THREE.Vector2(0.9, 0.9) }),
    chamfer: M.steel({ color: "#eceef2", roughness: 0.12 }),
    red: M.red({ roughness: 0.3 }),
    thread: P({ color: "#d01820", roughness: 0.6, sheen: 0.5, sheenRoughness: 0.6, sheenColor: new THREE.Color("#ff7070") }),
    steel: P({ color: "#d9dde3", metalness: 1, roughness: 0.2, normalMap: brushMap(), normalScale: new THREE.Vector2(0.35, 0.35) }),
    alu: P({ color: "#a9aeb6", metalness: 1, roughness: 0.36 }),
    screw: M.steel({ color: "#c9ccd2", roughness: 0.25 }),
    gooseneck: P({ color: "#454850", metalness: 0.85, roughness: 0.36 }),
    foam: P({ color: "#17171a", roughness: 1, sheen: 0.5, sheenRoughness: 0.9, sheenColor: new THREE.Color("#2b2c31"), normalMap: foamMap(), normalScale: new THREE.Vector2(0.6, 0.6) }),
    fabric: M.fabric({ color: "#34353c", sheenColor: new THREE.Color("#868a98") }),
    led: M.glow("#d3121b", 1.6),
    // a deep soft-touch black: it faces the overhead soft box, so a low specular level keeps it near black
    panel: P({ color: "#08080a", roughness: 0.5, specularIntensity: 0.45 }),
    etch: P({ color: "#2a2c31", metalness: 1, roughness: 0.55 }),
  };
}

// ───────────────────────────── the headband path (a planar curve in z = 0, arc length s, s = 0 at the crown)
const BAND = { A: 1.24, B: 0.56, yc: 1.06, n: 3.7 };
function bandPath() {
  const pts = [];
  const N = 4000;
  for (let i = 0; i <= N; i++) {
    const t = Math.PI * (1 - i / N);
    pts.push([BAND.A * spow(Math.cos(t), 2 / BAND.n), BAND.yc + BAND.B * Math.abs(Math.sin(t)) ** (2 / BAND.n)]);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[cum.length - 1];
  const at = (s) => {
    const target = clamp(s + L / 2, 0, L);
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < target) lo = mid;
      else hi = mid;
    }
    const t = (target - cum[lo]) / (cum[hi] - cum[lo] || 1);
    const a = pts[Math.max(0, lo - 3)], b = pts[Math.min(pts.length - 1, hi + 3)];
    let tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    return { x: lerp(pts[lo][0], pts[hi][0], t), y: lerp(pts[lo][1], pts[hi][1], t), tx, ty, nx: -ty, ny: tx };
  };
  return { L, at };
}

// the name panel (length, width, depth, bevel, corner radius) and the radius of its red piping bead; `shift` moves it
// along the band towards the near (right) end, in the panel's own screen-linear units: the turned band shows more of
// its near half, so the panel sits balanced on the leather the camera sees
const PLATE = { L: 2.3, W: 0.46, D: 0.024, B: 0.011, R: 0.11, trim: 0.012, shift: 0.08 };
// the pad's cross-section at arc length s: half-width (along z) and the outer/inner faces (along the band normal);
// full size over the crown (where the name panel sits), tapering on the shoulders into the end sleeves
const PAD = { hw: 0.33, ho: 0.098, hi: -0.088, taper0: (PLATE.L / 2 + PLATE.trim) * 1.1 + 0.04 };
function padShape(s, L) {
  const t = sstep(PAD.taper0, L / 2 - 0.12, Math.abs(s));
  return { hw: lerp(PAD.hw, 0.15, t), ho: lerp(PAD.ho, 0.05, t), hi: lerp(PAD.hi, -0.046, t) };
}
const STITCH_IN = 0.026; // the stitch rows run this far in from the pad's edges
/** Relief of the pad's top across its width (z ≥ 0): a padded roll inside each stitch row, the stitch channel, the
 * welt where the top panel is sewn to the side wall. */
function padRelief(z, hw) {
  return 0.011 * gauss(z - (hw - 0.05), 0.017) - 0.0032 * gauss(z - (hw - STITCH_IN), 0.007) - 0.0035 * gauss(z - (hw - 0.01), 0.005);
}
/** Profile point (z, h) of the pad at angle φ (0 = front edge, π/2 = top, π = back edge). */
function padPoint(phi, sh) {
  const c = Math.cos(phi), s = Math.sin(phi);
  const top = s >= 0;
  const cz = spow(c, top ? 0.5 : 2 / 3);
  const ch = spow(s, top ? 0.4 : 2 / 3);
  const mid = (sh.ho + sh.hi) / 2, half = (sh.ho - sh.hi) / 2;
  let h = mid + half * ch;
  if (top) h += padRelief(Math.abs(cz) * sh.hw, sh.hw) * ch;
  return [sh.hw * cz, h];
}
/** The pad's top surface at (s, z), without the relief (the panel and its piping are seated on this). */
function padBase(sh, z) {
  const u = clamp(Math.abs(z) / sh.hw, 0, 1);
  return (sh.ho + sh.hi) / 2 + ((sh.ho - sh.hi) / 2) * (1 - u ** 4) ** 0.2;
}
/** The pad's top surface including the relief. */
function padTop(sh, z) {
  const u = clamp(Math.abs(z) / sh.hw, 0, 1);
  return padPoint(Math.acos(u * u), sh)[1];
}

function headband(mat) {
  const path = bandPath();
  const L = path.L;
  const g = new THREE.Group();
  // the pad
  const NP = 144, rowsN = 320;
  const s0 = -L / 2, s1 = L / 2;
  const rows = [];
  for (let j = 0; j <= rowsN; j++) {
    const s = lerp(s0, s1, j / rowsN);
    const f = path.at(s);
    const shape = padShape(s, L);
    const row = [];
    for (let i = 0; i < NP; i++) {
      const [z, h] = padPoint((i / NP) * TAU, shape);
      row.push([f.x + f.nx * h, f.y + f.ny * h, z]);
    }
    rows.push(row);
  }
  g.add(gridMesh(rows, mat.leather, { wrapI: true, uv: (j, i) => [(i / NP) * 1.6 / 0.22, lerp(s0, s1, j / rowsN) / 0.22] }));

  // top-stitching: a row of red stitches along both edges of the top panel, pulled into the channel
  const stitch = new THREE.CapsuleGeometry(0.0052, 0.021, 3, 8);
  const geos = [];
  const m4 = new THREE.Matrix4();
  for (let s = -L / 2 + 0.17; s <= L / 2 - 0.17; s += 0.04) {
    const f = path.at(s);
    const shape = padShape(s, L);
    for (const side of [-1, 1]) {
      const z = side * (shape.hw - STITCH_IN);
      const h = padTop(shape, z) + 0.0014;
      const T = new THREE.Vector3(f.tx, f.ty, 0), N = new THREE.Vector3(f.nx, f.ny, 0);
      m4.makeBasis(new THREE.Vector3().crossVectors(T, N), T, N.multiplyScalar(0.55)); // flat thread, lying along the band
      m4.setPosition(f.x + f.nx * h, f.y + f.ny * h, z);
      geos.push(stitch.clone().applyMatrix4(m4));
    }
  }
  g.add(new THREE.Mesh(mergeGeometries(geos), mat.thread));
  return { group: g, path, L };
}

// ───────────────────────────── the studio's view of the object: core.js's camera, holder rotation and fit, replicated
function viewOf(posed) {
  const cam = new THREE.PerspectiveCamera(16, 4 / 3, 0.1, 100);
  const el = THREE.MathUtils.degToRad(12);
  const dist = 1 / Math.tan(THREE.MathUtils.degToRad(8));
  cam.position.set(0, dist * Math.sin(el), dist * Math.cos(el));
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).normalize();
  const holder = new THREE.Group();
  holder.rotation.set(meta.tilt, meta.turn, 0);
  holder.add(posed);
  const v = new THREE.Vector3();
  const boundsOf = (root) => {
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3();
    root.traverse((c) => {
      if (!c.isMesh) return;
      const pos = c.geometry.attributes.position;
      const step = Math.max(1, Math.floor(pos.count / 6000));
      for (let i = 0; i < pos.count; i += step) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld).project(cam));
    });
    return box;
  };
  const [mx, my] = meta.margin;
  for (let pass = 0; pass < 5; pass++) {
    const b = boundsOf(holder);
    holder.scale.multiplyScalar(Math.min(mx / ((b.max.x - b.min.x) / 2), my / ((b.max.y - b.min.y) / 2)));
    const b2 = boundsOf(holder);
    holder.position.x += (-(b2.max.x + b2.min.x) / 2) * (4 / 3);
    holder.position.addScaledVector(up, meta.centerY - (b2.max.y + b2.min.y) / 2);
  }
  holder.updateMatrixWorld(true);
  return {
    boundsOf,
    /** object-local → clip space, as a flat matrix (column-major elements) */
    clip: (obj) => new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, new THREE.Matrix4().multiplyMatrices(cam.matrixWorldInverse, obj.matrixWorld)).elements,
    release: () => holder.remove(posed),
  };
}
/** Pixel box (1200×900 frame) of an NDC box. */
const pxBox = (b) => [Math.round(((b.min.x + 1) / 2) * 1200), Math.round(((1 - b.max.y) / 2) * 900), Math.round(((b.max.x + 1) / 2) * 1200), Math.round(((1 - b.min.y) / 2) * 900)];

/**
 * The name panel and its red piping, seated in the crown of the band. The panel is drawn in its own (x, y) plane and
 * laid onto the band so that x runs evenly across the picture and every vertical line of the print stays vertical on
 * screen; y runs across the band (towards the back of the head = up in the picture).
 */
function namePlate(mat, text, lang, band, clip) {
  const { path, L } = band;
  const E = clip;
  const ndcX = (p) => (E[0] * p[0] + E[4] * p[1] + E[8] * p[2] + E[12]) / (E[3] * p[0] + E[7] * p[1] + E[11] * p[2] + E[15]);
  const surf = (s, z, dh) => {
    const f = path.at(s);
    const h = padBase(padShape(s, L), z) + dh;
    return [f.x + f.nx * h, f.y + f.ny * h, z];
  };
  const X0 = ndcX(surf(0, 0, 0));
  const kappa = (ndcX(surf(0.02, 0, 0)) - ndcX(surf(-0.02, 0, 0))) / 0.04;
  let clamped = 0;
  const solve = (x, y, dh) => {
    const z = -y, target = X0 + kappa * (x + PLATE.shift);
    let lo = -L / 2 + 0.05, hi = L / 2 - 0.05;
    for (let k = 0; k < 34; k++) {
      const s = (lo + hi) / 2;
      if (ndcX(surf(s, z, dh)) < target) lo = s;
      else hi = s;
    }
    const s = (lo + hi) / 2;
    if (Math.abs(s) > L / 2 - 0.06) clamped++;
    return s;
  };
  const conform = (rows0, h0, log) =>
    rows0.map((row) =>
      row.map(([x, y, zl]) => {
        const s = solve(x, y, h0 + zl);
        if (log) log.push(s);
        return surf(s, -y, h0 + zl);
      }),
    );
  const g = new THREE.Group();
  const { L: PL, W: PW, D: PD, B: PB, R } = PLATE;
  // piping: a lacquered red bead round the panel, standing a hair above the panel's face
  const TO = rrectLoop(PL + 2 * PLATE.trim, PW + 2 * PLATE.trim, R + PLATE.trim, 300);
  const bead = [];
  for (let j = 0; j < 20; j++) {
    const phi = (j / 20) * TAU;
    bead.push([PLATE.trim * spow(Math.cos(phi), 0.8), -0.0025 + 0.008 * spow(Math.sin(phi), 0.8)]);
  }
  const sTrim = [];
  const trimRows = conform(bead.map(([r, z]) => TO.map((p) => [p.x + p.nx * r, p.y + p.ny * r, z])), 0, sTrim);
  const clampedTrim = clamped;
  g.add(gridMesh(trimRows, mat.red, { wrapI: true, wrapJ: true }));
  // the panel
  const O = rrectLoop(PL, PW, R, 300);
  const local = puckRows(O, plateProfile(PD, PB, { K: 14, B: 6 }));
  const rowsW = conform(local, -0.009);
  const clampedPanel = clamped - clampedTrim;
  // a flat print (the set's: low relief, white on near-black) with room round it. The Arabic-script names are
  // width-limited and stay under 8% of the frame's height, so they take the heavy 900; the Latin name comes out taller
  // and keeps the set's 800, with a little less of the panel's height so it does not touch the piping
  const fit = lang === "en" ? { fitW: 0.9, fitH: 0.78, weight: 800 } : { fitW: 0.93, fitH: 0.86, weight: 900 };
  const face = titleMaterial(text, lang, PL - 2 * PB, PW - 2 * PB, mat.panel, { ...fit, relief: 0.2, inkRoughness: 0.5, faceRoughness: 0.55 });
  g.add(
    gridMesh(rowsW, face, {
      wrapI: true,
      uv: (j, i) => {
        const p = local[j % local.length][i % O.length];
        return [p[0], p[1]];
      },
      tangent: (j, i) => {
        // +u runs along the band (the solved arc length moves with x)
        const a = rowsW[j][(i + 1) % O.length], b = rowsW[j][(i - 1 + O.length) % O.length];
        const pa = local[j][(i + 1) % O.length], pb = local[j][(i - 1 + O.length) % O.length];
        const du = pa[0] - pb[0];
        const f = path.at(solve(local[j][i][0], local[j][i][1], 0));
        if (Math.abs(du) < 1e-6) return [f.tx, f.ty, 0, 1];
        const t = [(a[0] - b[0]) / du, (a[1] - b[1]) / du, (a[2] - b[2]) / du];
        // keep only the along-band part when the ring runs mostly across (the panel's ends)
        return Math.abs(pa[1] - pb[1]) > Math.abs(du) ? [f.tx, f.ty, 0, 1] : [t[0], t[1], t[2], 1];
      },
    }),
  );
  // the band positions the piping reaches (the pad must stay full size under them); vertices the camera-linear
  // layout could not place on the band (beyond its silhouette) are counted
  const sEnd = [Math.min(...sTrim), Math.max(...sTrim)];
  if (DEBUG) console.error(`DBG plate clamped trim ${clampedTrim} panel ${clampedPanel} sEnd ${sEnd.map((v) => v.toFixed(3)).join("/")}`);
  return { group: g, kappa, X0, sEnd };
}

/** A sweep of a closed 2D profile [(r, z)] round a closed outline (cushions, rings). */
function ringSweep(O, profile, mat, { uvScale = 0.25, perturb = null } = {}) {
  const rows = profile.map(([r, z], j) =>
    O.map((p, i) => {
      let rr = r, zz = z;
      if (perturb) [rr, zz] = perturb(r, z, i / O.length, j / profile.length);
      return [p.x + p.nx * rr, p.y + p.ny * rr, zz];
    }),
  );
  const Lo = O[0].L;
  let Lp = 0;
  for (let j = 0; j < profile.length; j++) {
    const a = profile[j], b = profile[(j + 1) % profile.length];
    Lp += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return gridMesh(rows, mat, { wrapI: true, wrapJ: true, uv: (j, i) => [((i / O.length) * Lo) / uvScale, ((j / profile.length) * Lp) / uvScale] });
}

// ───────────────────────────── an ear cup in its own frame: z = the cup axis (0 = the face of the cushion, + outwards),
// x = front/back (symmetric; −x is the front of the near cup), y = up.
const CUP = { a: 0.44, b: 0.52, n: 2.5, z0: 0.245, z1: 0.54, forkZ: 0.4 };
const MIC_SOCKET = [-0.445, -0.08, 0.42];
function cup(mat, { mic = false } = {}) {
  const g = new THREE.Group();

  // cushion: a pillowy ring with gathered wrinkles on its walls (strongest towards the back) and fine pleats where
  // the leather tucks into the opening
  const CO = loop(se(0.35, 0.43, 2.4), 360);
  const w = 0.125, zc = 0.136, hz = 0.136;
  const cprof = [];
  const NPh = 52;
  for (let j = 0; j < NPh; j++) {
    const phi = (j / NPh) * TAU;
    const c = Math.cos(phi), s = Math.sin(phi);
    cprof.push([w * spow(c, 2 / 2.7), zc + hz * spow(s, s > 0 ? 2 / 4.5 : 2 / 2.2)]);
  }
  const R = rng(5);
  const waves = Array.from({ length: 9 }, () => ({ k: 7 + Math.floor(R() * 34), ph: R() * TAU, a: 0.3 + R() * 0.7 }));
  const wrinkle = (u) => {
    let v = 0;
    for (const wv of waves) v += wv.a * Math.sin(wv.k * u * TAU + wv.ph);
    return v / 3;
  };
  const pleats = Array.from({ length: 4 }, () => ({ k: 40 + Math.floor(R() * 30), ph: R() * TAU, a: 0.5 + R() * 0.5 }));
  const pleat = (u) => {
    let v = 0;
    for (const p of pleats) v += p.a * Math.sin(p.k * u * TAU + p.ph);
    return v / 1.6;
  };
  g.add(
    ringSweep(CO, cprof, mat.cushion, {
      uvScale: 0.22,
      perturb: (r, z, u) => {
        const side = clamp(Math.abs(r) / w, 0, 1) ** 4;
        const back = sstep(0.06, 0.25, z);
        const k = wrinkle(u) * side * back;
        let rr = r + Math.sign(r) * 0.008 * k;
        const zz = z - 0.003 * Math.abs(k);
        if (r < 0) rr -= 0.0042 * pleat(u) * (1 - sstep(0.02, 0.1, z)) * clamp(-r / w, 0, 1) ** 2;
        return [rr, zz];
      },
    }),
  );
  // the mesh baffle inside the ring
  const BO = loop(se(0.245, 0.325, 2.4), 160);
  const brows = puckRows(BO, plateProfile(0.012, 0.004, { K: 6, B: 2 }));
  const baffle = gridMesh(brows, mat.fabric, {
    wrapI: true,
    uv: (j, i) => [brows[j % brows.length][i % BO.length][0] * 4, brows[j % brows.length][i % BO.length][1] * 4],
  });
  baffle.position.z = 0.17;
  g.add(baffle);

  // shell: flat back hidden in the cushion, a bulging wall with a parting line, a soft shoulder, a domed face
  const SO = loop(se(CUP.a, CUP.b, CUP.n), 180);
  const sp = [];
  for (const s of [0, 0.5, 0.9]) sp.push([s, -0.02 * s, CUP.z0]);
  for (let k = 0; k <= 4; k++) {
    const a = (k / 4) * (Math.PI / 2);
    sp.push([1, -0.02 * (1 - Math.sin(a)), CUP.z0 + 0.02 * (1 - Math.cos(a))]);
  }
  const wall = (z) => 0.012 * Math.sin(Math.PI * clamp((z - 0.265) / (0.45 - 0.265), 0, 1)) - 0.005 * Math.exp(-(((z - 0.36) / 0.0035) ** 2));
  for (const z of [0.29, 0.32, 0.345, 0.353, 0.357, 0.36, 0.363, 0.367, 0.375, 0.4, 0.43, 0.45]) sp.push([1, wall(z), z]);
  for (let k = 1; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2);
    sp.push([1, -0.075 * (1 - Math.cos(a)), 0.45 + 0.085 * Math.sin(a)]);
  }
  for (const s of [0.94, 0.85, 0.7, 0.5, 0.3, 0.12, 0]) sp.push([s, -0.075 * s, CUP.z1 - 0.005 + 0.007 * (1 - s * s)]);
  g.add(gridMesh(puckRows(SO, sp), mat.shell, { wrapI: true, uv: (j, i) => [(i / SO.length) * 8, j * 0.08] }));

  // red ring and the brushed plate with its diamond-cut chamfer
  const RO = loop(se(0.338, 0.413, CUP.n), 200);
  const ringProf = [];
  for (let j = 0; j < 24; j++) {
    const phi = (j / 24) * TAU;
    ringProf.push([0.014 * spow(Math.cos(phi), 2 / 3), CUP.z1 + 0.003 + 0.008 * spow(Math.sin(phi), 2 / 3)]);
  }
  g.add(ringSweep(RO, ringProf, mat.red));
  const pa = 0.318, pb = 0.392;
  const PO = loop(se(pa, pb, CUP.n), 200);
  const zf = CUP.z1 + 0.032, ch = 0.013;
  const capRows = [];
  for (let k = 0; k <= 10; k++) capRows.push(PO.map((p) => [(p.x - p.nx * ch) * (k / 10), (p.y - p.ny * ch) * (k / 10), zf]));
  const capUV = (j, i) => {
    const p = capRows[j][i % PO.length];
    return [p[0] / (2 * pa) + 0.5, p[1] / (2 * pb) + 0.5];
  };
  g.add(gridMesh(capRows, mat.plate, { wrapI: true, uv: capUV }));
  const chamRows = [
    PO.map((p) => [p.x - p.nx * ch, p.y - p.ny * ch, zf]),
    PO.map((p) => [p.x - p.nx * ch * 0.08, p.y - p.ny * ch * 0.08, zf - ch * 0.92]),
    PO.map((p) => [p.x, p.y, zf - ch - 0.002]),
    PO.map((p) => [p.x, p.y, CUP.z1 - 0.01]),
  ];
  g.add(gridMesh(chamRows, mat.chamfer, { wrapI: true }));

  // fork over the top of the cup, pivot hubs with screws, the block the slider plugs into
  const fa = 0.508, fb = 0.588;
  const fork = [];
  const NF = 120;
  for (let j = 0; j <= NF; j++) {
    const t = (j / NF) * 0.5; // 0 → 0.5 of the superellipse: back pivot → over the top → front pivot
    const [x, y] = se(fa, fb, CUP.n)(t);
    const [x2, y2] = se(fa, fb, CUP.n)(Math.min(0.5, t + 0.002));
    const [x1, y1] = se(fa, fb, CUP.n)(Math.max(0, t - 0.002));
    const tx = x2 - x1, ty = y2 - y1;
    const l = Math.hypot(tx, ty) || 1;
    const nx = ty / l, ny = -tx / l;
    const row = [];
    for (let i = 0; i < 28; i++) {
      const phi = (i / 28) * TAU;
      const r = 0.026 * spow(Math.cos(phi), 2 / 4), z = 0.05 * spow(Math.sin(phi), 2 / 4);
      row.push([x + nx * r, y + ny * r, CUP.forkZ + z]);
    }
    fork.push(row);
  }
  g.add(gridMesh(fork, mat.alu, { wrapI: true }));
  for (const sx of [-1, 1]) {
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.11, 48), mat.alu);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(sx * 0.49, 0, CUP.forkZ);
    g.add(hub);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.032, 0.012, 40), mat.screw);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(sx * 0.551, 0, CUP.forkZ);
    g.add(cap);
    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.002, 6), M.satin());
    socket.rotation.z = Math.PI / 2;
    socket.position.set(sx * 0.5575, 0, CUP.forkZ);
    g.add(socket);
  }
  const block = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.115, 0.08, 6, 0.028), mat.alu);
  block.position.set(0, fb + 0.055, CUP.forkZ);
  g.add(block);

  if (mic) {
    // the boom's swivel socket on the front edge of the shell
    const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.052, 0.08, 40), mat.sleeve);
    socket.rotation.z = Math.PI / 2;
    socket.position.set(...MIC_SOCKET);
    g.add(socket);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.006, 12, 48), mat.alu);
    ring.rotation.y = Math.PI / 2;
    ring.position.set(MIC_SOCKET[0] - 0.036, MIC_SOCKET[1], MIC_SOCKET[2]);
    g.add(ring);
  }
  return g;
}

/** The boom: a ribbed gooseneck through rig-frame points, a collar, the red mute ring and the foam windscreen. */
function micBoom(mat, points) {
  const g = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.5);
  const segs = 320, rad = 18;
  const frames = curve.computeFrenetFrames(segs, false);
  const len = curve.getLength();
  const rows = [];
  for (let j = 0; j <= segs; j++) {
    const t = j / segs;
    const p = curve.getPointAt(t);
    const N = frames.normals[j], B = frames.binormals[j];
    const sl = t * len;
    const rib = 0.5 + 0.5 * Math.cos((sl / 0.021) * TAU);
    const r0 = 0.019 + 0.0026 * rib ** 3 + 0.004 * (1 - sstep(0, 0.06, sl)); // a little thicker where it leaves the socket
    const row = [];
    for (let i = 0; i < rad; i++) {
      const a = (i / rad) * TAU;
      row.push([p.x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * r0, p.y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * r0, p.z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * r0]);
    }
    rows.push(row);
  }
  g.add(gridMesh(rows, mat.gooseneck, { wrapI: true }));
  const end = curve.getPointAt(1), dir = curve.getTangentAt(1);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  const put = (geo, m, d) => {
    const o = new THREE.Mesh(geo, m);
    o.quaternion.copy(q);
    o.position.copy(end).addScaledVector(dir, d);
    g.add(o);
  };
  put(new THREE.CylinderGeometry(0.028, 0.024, 0.032, 40), mat.sleeve, 0.004);
  put(new THREE.CylinderGeometry(0.03, 0.03, 0.01, 40), mat.led, 0.024);
  const foamGeo = new THREE.CapsuleGeometry(0.064, 0.055, 16, 56);
  const uv = foamGeo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * 2, uv.getY(k) * 1.2);
  put(foamGeo, mat.foam, 0.029 + 0.0915);
  return g;
}

// ───────────────────────────── slider bar and end sleeve (world frame, at x = ±BAND.A)
function slider(mat, y0, y1) {
  const g = new THREE.Group();
  const O = rrectLoop(0.034, 0.12, 0.013, 64);
  const rows = [];
  for (const y of [y0, y1]) rows.push(O.map((p) => [p.x, y, -p.y]));
  g.add(gridMesh(rows, mat.steel, { wrapI: true, uv: (j, i) => [(i / 64) * 0.3 * 4, j * 1.5] }));
  // size ticks etched into both faces (lines only)
  const geos = [];
  for (let k = 0; k < 6; k++)
    for (const sx of [-1, 1]) {
      const y = y1 - 0.13 + k * 0.026;
      const w = k % 2 ? 0.045 : 0.075;
      geos.push(new THREE.BoxGeometry(0.003, 0.0045, w).translate(sx * 0.0163, y, 0.014));
    }
  g.add(new THREE.Mesh(mergeGeometries(geos), mat.etch));
  return g;
}
function sleeve(mat) {
  const O = loop(se(0.074, 0.17, 3.2), 140);
  const H = 0.17, rb = 0.02, rt = 0.024;
  const taper = (z) => -0.012 * (1 - z / H);
  const groove = (z) => -0.003 * Math.exp(-(((z - 0.06) / 0.0035) ** 2));
  const prof = [];
  for (let k = 0; k <= 4; k++) prof.push([k / 4, (-rb + taper(0)) * (k / 4), 0]);
  for (let k = 1; k <= 5; k++) {
    const a = (k / 5) * (Math.PI / 2);
    const z = rb * (1 - Math.cos(a));
    prof.push([1, -rb * (1 - Math.sin(a)) + taper(z), z]);
  }
  for (const z of [0.035, 0.05, 0.055, 0.058, 0.06, 0.062, 0.065, 0.07, 0.1, 0.13]) prof.push([1, taper(z) + groove(z), z]);
  for (let k = 0; k <= 5; k++) {
    const a = (k / 5) * (Math.PI / 2);
    const z = H - rt + rt * Math.sin(a);
    prof.push([1, -rt * (1 - Math.cos(a)) + taper(z), z]);
  }
  for (let k = 3; k >= 0; k--) prof.push([k / 4, -rt * (k / 4), H]);
  const m = gridMesh(puckRows(O, prof), mat.sleeve, { wrapI: true });
  m.rotation.x = -Math.PI / 2; // local z → world y, local y → world −z
  return m;
}

// ───────────────────────────── assembly
export function build({ text, lang }) {
  const mat = materials();
  const rig = new THREE.Group();

  const band = headband(mat);
  rig.add(band.group);

  const CUP_X = BAND.A; // the swivel axis (fork, slider) of each cup
  let micCup = null;
  for (const side of [-1, 1]) {
    const c = cup(mat, { mic: side > 0 });
    c.scale.setScalar(CUP_SCALE);
    c.position.z = -CUP.forkZ * CUP_SCALE;
    const pivot = new THREE.Group();
    pivot.add(c);
    pivot.position.set(side * CUP_X, CUP_Y, 0);
    pivot.rotation.y = side * (Math.PI / 2) + SWIVEL[side];
    rig.add(pivot);
    if (side > 0) micCup = { pivot, c };
    // slider from the fork block up into the sleeve, the sleeve over the band's end
    rig.add(slider(mat, 0.64 + CUP_Y, BAND.yc + 0.02).translateX(side * CUP_X));
    const sl = sleeve(mat);
    sl.position.set(side * CUP_X, BAND.yc - 0.035, 0);
    rig.add(sl);
  }

  // the boom leaves its socket along the cup's front edge, then sweeps in towards the mouth (rig frame)
  micCup.pivot.updateMatrix();
  micCup.c.updateMatrix();
  const toRig = new THREE.Matrix4().multiplyMatrices(micCup.pivot.matrix, micCup.c.matrix);
  const s0 = new THREE.Vector3(MIC_SOCKET[0] - 0.04, MIC_SOCKET[1], MIC_SOCKET[2]).applyMatrix4(toRig);
  const d0 = new THREE.Vector3(-1, 0, 0).transformDirection(toRig);
  // (rig frame: the cups' pivots are at y = 0; forward (+z) costs height in the picture once the headset is pitched)
  const boomPts = [
    s0,
    s0.clone().addScaledVector(d0, 0.045).add(new THREE.Vector3(0, -0.012, 0)),
    new THREE.Vector3(lerp(s0.x, 0.3, 0.2), CUP_Y - 0.128, 0.476),
    new THREE.Vector3(lerp(s0.x, 0.3, 0.45), CUP_Y - 0.135, 0.456),
    new THREE.Vector3(lerp(s0.x, 0.3, 0.72), CUP_Y - 0.11, 0.42),
    new THREE.Vector3(0.3, CUP_Y - 0.062, 0.37),
  ];
  rig.add(micBoom(mat, boomPts));

  rig.position.y = -0.55;
  const posed = new THREE.Group();
  posed.add(rig);
  posed.rotation.x = PITCH;

  // the name panel goes on last, laid out through the studio camera's view of everything else
  const view = viewOf(posed);
  const plate = namePlate(mat, text, lang, band, view.clip(band.group));
  band.group.add(plate.group);
  if (DEBUG) {
    const all = view.boundsOf(posed);
    const parts = { all: posed, band: band.group, plate: plate.group, micCup: micCup.pivot, farCup: rig.children.find((c) => c.isGroup && c !== micCup.pivot && c.children[0]?.isGroup && c.position.x < 0), boom: rig.children[rig.children.length - 1] };
    const out = {};
    for (const [k, o] of Object.entries(parts)) if (o) out[k] = pxBox(view.boundsOf(o));
    console.error("DBG " + lang + " " + JSON.stringify(out) + " taper0 " + PAD.taper0.toFixed(3) + " L/2 " + (band.L / 2).toFixed(3) + " ndc " + JSON.stringify([all.min.x, all.min.y, all.max.x, all.max.y].map((v) => +v.toFixed(3))));
  }
  view.release();
  return bakeForStudio(posed);
}

/**
 * core.js sets the floor under the lowest corner of each mesh's own bounding box. For the tipped, swivelled round cups
 * those corners hang far below the real surface, which floated the headset high above its shadow. So every transform
 * (the holder's turn and tilt included) is baked into the vertices, and the returned group carries the inverse turn
 * and tilt: the picture is identical, but every mesh's box is aligned with the world and exact.
 */
function bakeForStudio(posed) {
  const qh = new THREE.Quaternion().setFromEuler(new THREE.Euler(meta.tilt, meta.turn, 0, "XYZ"));
  const Rh = new THREE.Matrix4().makeRotationFromQuaternion(qh);
  posed.updateMatrixWorld(true);
  const meshes = [];
  posed.traverse((o) => {
    if (o.isMesh) meshes.push(o);
  });
  const out = new THREE.Group();
  for (const m of meshes) {
    const g = m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(Rh, m.matrixWorld));
    g.computeBoundingBox();
    out.add(new THREE.Mesh(g, m.material));
  }
  out.quaternion.copy(qh).invert();
  return out;
}
