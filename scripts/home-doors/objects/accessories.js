// «الإكسسوارات» — console accessories: a hard-shell EVA carrying case for a handheld console, standing on its long
// edge. Two moulded shells covered in graphite twill: the lid is pillow-domed, its panel under a smooth satin coat that
// lays a soft, top-lit reflection across the dome, with the name printed in white inside a moulded groove; the
// round-overs carry a soft velvet sheen, full where they face up and half where they face the sides or the floor. A
// brand-red zip runs round a gusset between the shells: dark bound edges stitched to the shells, red tape, and taller,
// deeper-red moulded teeth. A crowned satin-nickel slider at the top-right corner carries a red woven strap folded round
// its lug's pin, ending in a moulded rubber tab on the lid's corner. A padded strap handle (webbing sewn flat to the back
// shell's top under box-X stitches, a soft arch, a rolled PU grip stitched front and back) sits on top. A braided
// USB-C to USB-C cable, two turns held by a hook-and-loop tie, leans against the lid; both ends leave the coil on the
// table in a loose V, each with its aluminium plug.
import { THREE, M, titleMaterial, microNormal, at, rot } from "../kit.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const meta = { turn: -0.27, tilt: 0.04, gap: 0.05, margin: [0.92, 0.86], centerY: 0.05 };

// ───────────────────────────── dimensions (the case is 2.4 wide; a real one is about 27 × 12.5 × 5 cm)
const A = 1.2; // half width at the side walls
const B = 0.56; // half height
const R = 0.34; // corner radius of the outline
const AI = A - R; // the inner rectangle every outline is offset from
const BI = B - R;
const ZF = 0.226; // the lid's crown (before the dome)
const ZW = 0.112; // where the lid's round-over meets the straight side wall
const ZS = 0.078; // the seam: each shell ends here, the zip gusset lies between ±ZS
const RR = 0.008; // the shell's rolled edge at the seam
const DSPLIT = 0.24; // the printed lid face ends here; the round-over continues in plain fabric
const GROOVE = { d: 0.205, depth: 0.0042, w: 0.0065 }; // a moulded line framing the lid's panel
const SX = 72, SY = 18, SK = 28; // outline sampling: long edges, short edges, each corner
const DOME = { h: 0.06, ax: 1.1, ay: 0.46 }; // the lid's pillow dome (≈ 6.7 mm): flat under the name, rolling off near the groove
const TEXT_Y = 0.06; // the name sits a little above the middle of the lid
const NAME = { w: 1.94, h: 0.4 }; // the box the name may fill (world units)
const FABRIC = "#404042"; // graphite fabric (lands on an even step, (13, 13, 14), of the tracer's 8-bit linear textures)
// the moulded panel inside the groove (a separate darker panel read as a tablet screen in a bezel, so it differs only in gloss)
const PANEL = { d: GROOVE.d - 0.0015, spec: 0.85 };
// the lid face is seen square-on, where velvet sheen adds fireflies but little look: the velvet lives on the round-overs
const FACE_SHEEN = 0;
// the face is a satin-coated fabric (its pillow catches the key light's soft reflection); the round-overs stay velvet-rough
const ROUGH = { face: 0.62, rim: 0.8, ink: 0.42 };
// a smooth satin coat over the lid's panel: it follows the dome's own normals (not the twill), so it lays a broad, soft
// reflection of the studio across the upper dome; it fades out just past the groove, where the velvet round-over begins
const COAT = { k: 0.3, rough: 0.35 };
// the velvet: softer than before, and weaker where the moulding faces the sides or the floor (k by the outline's normal)
const SHEEN = { k: 0.6, rough: 0.4, color: "#767b84" };
const sheenK = (ny) => 0.5 + 0.35 * Math.max(0, ny);
const FLOOR = -B;

const TAU = Math.PI * 2;
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const P = (o) => new THREE.MeshPhysicalMaterial(o);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const angDiff = (a, b) => ((((a - b + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const hexBytes = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** Offset of (x, y) from the inner rectangle (0 inside it). */
const offsetD = (x, y) => Math.hypot(Math.max(Math.abs(x) - AI, 0), Math.max(Math.abs(y) - BI, 0));
/** A ribbon's end rounding: 1 along the middle, falling to ~0 within `len` of either end (a superellipse). */
const endCap = (t, L, len, p = 4) => {
  const u = Math.max(0, len - t * L, len - (1 - t) * L) / len;
  return Math.max(0.04, (1 - Math.min(1, u) ** p) ** (1 / p));
};

// ───────────────────────────── the lid's pillow dome
function dome(x, y) {
  const q = Math.min(1, Math.hypot(x / DOME.ax, y / DOME.ay));
  return DOME.h * (1 - q ** 4) ** 1.5 * (1 - sstep(DSPLIT - 0.07, DSPLIT, offsetD(x, y)));
}
function domeGrad(x, y) {
  const e = 1e-4;
  return [(dome(x + e, y) - dome(x - e, y)) / (2 * e), (dome(x, y + e) - dome(x, y - e)) / (2 * e)];
}
/** Tilts a surface normal of the undomed lid to the domed lid's normal at (x, y). */
function domeNormal(n, x, y) {
  if (n.z < 0.05) return n;
  const [gx, gy] = domeGrad(x, y);
  return V3(n.x / n.z - gx, n.y / n.z - gy, 1).normalize();
}
function applyDome(geo) {
  const p = geo.attributes.position, nr = geo.attributes.normal;
  const n = V3();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    const g = dome(x, y);
    if (g <= 0) continue;
    p.setZ(i, p.getZ(i) + g);
    n.fromBufferAttribute(nr, i);
    const m = domeNormal(n, x, y);
    nr.setXYZ(i, m.x, m.y, m.z);
  }
  p.needsUpdate = nr.needsUpdate = true;
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// ───────────────────────────── procedural micro-surfaces (canvas normal maps)
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
/** Height samples → tangent-space normal map canvas (OpenGL convention, +y = +v), as kit.js does it. */
function normalCanvas(height, w, h, strength, wrap = true) {
  const c = makeCanvas(w, h);
  const g = c.getContext("2d");
  const img = g.createImageData(w, h);
  const at = (x, y) => (wrap ? height[((y + h) % h) * w + ((x + w) % w)] : height[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = -(at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
      const ny = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * w + x) * 4;
      img.data[i] = (nx / l / 2 + 0.5) * 255;
      img.data[i + 1] = (ny / l / 2 + 0.5) * 255;
      img.data[i + 2] = (1 / l / 2 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return c;
}
function canvasTex(canvas, colorSpace, rx = 1, ry = 1) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.repeat.set(rx, ry);
  t.updateMatrix();
  return t;
}
/** Plain weave, height at (x, y) in thread cells: the threads cross over and under each other cell by cell. */
function weave(x, y) {
  const i = Math.floor(x), j = Math.floor(y);
  const sx = Math.sin(Math.PI * (x - i)), sy = Math.sin(Math.PI * (y - j));
  return ((i + j) & 1) === 0 ? 0.3 + 0.7 * sy * Math.sqrt(sx) : 0.3 + 0.7 * sx * Math.sqrt(sy);
}
/** A 2/2 twill (the case's technical fabric): the floats step over by one thread each row, so the weave runs diagonally. */
function twill(x, y) {
  const i = Math.floor(x), j = Math.floor(y);
  const sx = Math.sin(Math.PI * (x - i)), sy = Math.sin(Math.PI * (y - j));
  return ((i + j) & 3) < 2 ? 0.3 + 0.7 * sy * Math.sqrt(sx) : 0.3 + 0.7 * sx * Math.sqrt(sy);
}
const TWILL_Q = 0.0075; // the case fabric's thread spacing (≈ 0.85 mm)
const WEAVE_Q = 0.0056; // thread spacing of the finer weaves (≈ 0.6 mm)
const WEAVE_K = 0.075; // relief of the weave (normal tilt per unit of height per cell)
const memo = new Map();
const once = (key, make) => (memo.has(key) ? memo.get(key) : memo.set(key, make()).get(key));
/** The weave as a tileable normal map, for surfaces whose UVs are in world units. */
function weaveNormal(q = WEAVE_Q) {
  return once("weave" + q, () => {
    const S = 128, cells = 4;
    const hgt = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) hgt[y * S + x] = weave(((x + 0.5) / S) * cells, (1 - (y + 0.5) / S) * cells);
    return canvasTex(normalCanvas(hgt, S, S, WEAVE_K * (S / cells)), THREE.NoColorSpace, 1 / (cells * q), 1 / (cells * q));
  });
}
/** The case fabric's twill as a tileable normal map (UVs in world units). */
function twillNormal(q = TWILL_Q) {
  return once("twill" + q, () => {
    const S = 128, cells = 4;
    const hgt = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) hgt[y * S + x] = twill(((x + 0.5) / S) * cells, (1 - (y + 0.5) / S) * cells);
    return canvasTex(normalCanvas(hgt, S, S, WEAVE_K * (S / cells)), THREE.NoColorSpace, 1 / (cells * q), 1 / (cells * q));
  });
}
/** Webbing: firm ribs running along the strap, a fine weave across them. UVs in world units (u along the strap). */
function webbingNormal(ribW = 0.011) {
  return once("webbing" + ribW, () => {
    const S = 128, ribs = 4;
    const hgt = new Float32Array(S * S);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S, v = 1 - (y + 0.5) / S;
        const rib = Math.abs(Math.sin(Math.PI * v * ribs)) ** 0.7;
        hgt[y * S + x] = 0.8 * rib + 0.25 * weave(u * 8, v * 8);
      }
    return canvasTex(normalCanvas(hgt, S, S, 0.07 * (S / ribs)), THREE.NoColorSpace, 1 / (ribs * ribW), 1 / (ribs * ribW));
  });
}
/**
 * A braided cable sleeve: two families of carriers wound in opposite helices, over-and-under (a diamond braid), each
 * family its own shade so the crossings form the braid's herringbone. The tile covers the whole circumference (v) and
 * one braid repeat along the cable (u). Returns colour, roughness and normal maps.
 */
function braidMaps(colA, colB, carriers = 8) {
  return once("braid" + colA + colB, () => {
    const S = 256;
    const hgt = new Float32Array(S * S);
    const col = makeCanvas(S, S), cg = col.getContext("2d"), ci = cg.createImageData(S, S);
    const rough = makeCanvas(S, S), rg = rough.getContext("2d"), ri = rg.createImageData(S, S);
    const ca = new THREE.Color(colA), cb = new THREE.Color(colB); // linear
    const toS = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055) * 255;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const a = (x + 0.5) / S, b = 1 - (y + 0.5) / S;
        const p1 = (a + b) * carriers, p2 = (a - b + 1) * carriers;
        const i1 = Math.floor(p1), i2 = Math.floor(p2), f1 = p1 - i1, f2 = p2 - i2;
        const top1 = ((i1 + i2) & 1) === 0;
        const fAcross = top1 ? f1 : f2, fAlong = top1 ? f2 : f1;
        const yarn = 0.85 + 0.15 * Math.cos(TAU * 3 * fAcross); // three yarns per carrier
        const h = Math.sin(Math.PI * fAcross) ** 0.5 * Math.sin(Math.PI * fAlong) ** 0.25 * yarn;
        hgt[y * S + x] = h;
        const c = top1 ? ca : cb;
        const shade = 0.6 + 0.4 * h;
        const i = (y * S + x) * 4;
        // sRGB bytes for the colour map (the texture is tagged sRGB)
        ci.data[i] = toS(c.r * shade);
        ci.data[i + 1] = toS(c.g * shade);
        ci.data[i + 2] = toS(c.b * shade);
        ci.data[i + 3] = 255;
        const r = Math.round(255 * (0.86 - 0.2 * h));
        ri.data[i] = ri.data[i + 1] = ri.data[i + 2] = r;
        ri.data[i + 3] = 255;
      }
    cg.putImageData(ci, 0, 0);
    rg.putImageData(ri, 0, 0);
    return {
      map: canvasTex(col, THREE.SRGBColorSpace),
      roughnessMap: canvasTex(rough, THREE.NoColorSpace),
      normalMap: canvasTex(normalCanvas(hgt, S, S, 0.22 * (S / carriers)), THREE.NoColorSpace),
    };
  });
}

// ───────────────────────────── materials
/** Graphite EVA fabric: a velvet sheen that glows silver where the moulding turns away. */
const caseFabric = () =>
  M.fabric({ color: FABRIC, roughness: 0.8, specularIntensity: 0.75, sheen: SHEEN.k, sheenRoughness: SHEEN.rough, sheenColor: new THREE.Color(SHEEN.color), normalMap: twillNormal(), normalScale: new THREE.Vector2(0.55, 0.55) });

/** A small separable blur ([1 4 6 4 1] / 16, twice) of a W×H field. */
function blur5(src, W, H) {
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  let a = src, b = new Float32Array(W * H);
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++) s += k[t + 2] * a[y * W + clamp(x + t, 0, W - 1)];
        b[y * W + x] = s;
      }
    const c = new Float32Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0;
        for (let t = -2; t <= 2; t++) s += k[t + 2] * b[clamp(y + t, 0, H - 1) * W + x];
        c[y * W + x] = s;
      }
    a = c;
  }
  return a;
}
/**
 * The lid face: satin-coated graphite twill inside the moulded groove, easing to the round-over's velvet-rough finish by
 * the face's edge, with the name printed on it in white. The print is crisp: its hair of relief stays on the letters, and
 * the twill carries on faintly through the ink.
 */
function lidMaterial(text, lang, fabric) {
  const fw = 2 * (AI + DSPLIT) + 0.02;
  const fh = 2 * (BI + DSPLIT + Math.abs(TEXT_Y)) + 0.02;
  const m = titleMaterial(text, lang, fw, fh, fabric, { fitW: NAME.w / fw, fitH: NAME.h / fh, ink: "#ffffff", inkRoughness: ROUGH.ink, relief: 0 });
  const C = m.map.image, W = C.width, H = C.height;
  const cd = C.getContext("2d").getImageData(0, 0, W, H).data; // the fabric colour with the white ink on it (kit.js)
  const faceSum = hexBytes(FABRIC).reduce((a, b) => a + b, 0);
  const ink = new Float32Array(W * H), panel = new Float32Array(W * H), hgt = new Float32Array(W * H), rimK = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const wy = TEXT_Y + (0.5 - (y + 0.5) / H) * fh;
    for (let x = 0; x < W; x++) {
      const wx = ((x + 0.5) / W - 0.5) * fw;
      const i = y * W + x, j = i * 4;
      const d = offsetD(wx, wy);
      ink[i] = clamp((cd[j] + cd[j + 1] + cd[j + 2] - faceSum) / (765 - faceSum), 0, 1);
      panel[i] = 1 - sstep(PANEL.d - 0.0016, PANEL.d + 0.0016, d);
      rimK[i] = sstep(PANEL.d - 0.004, DSPLIT, d);
      hgt[i] = twill(wx / TWILL_Q, wy / TWILL_Q);
    }
  }
  // roughness (green): satin on the face, easing to the round-over's velvet by the face's edge; the ink its own
  const RC = m.roughnessMap.image, rgc = RC.getContext("2d"), rimg = rgc.getImageData(0, 0, W, H);
  // specular intensity (alpha): the moulded panel a touch less glossy than the rolled band outside the groove
  const specC = makeCanvas(W, H), spg = specC.getContext("2d"), spi = spg.createImageData(W, H);
  // the satin coat (red): full over the panel and the print, fading out with the velvet past the groove
  const coatC = makeCanvas(W, H), ccg = coatC.getContext("2d"), cci = ccg.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    const k = ink[i];
    const r = Math.round(255 * ((ROUGH.face + (ROUGH.rim - ROUGH.face) * rimK[i]) * (1 - k) + ROUGH.ink * k));
    rimg.data[i * 4] = rimg.data[i * 4 + 1] = rimg.data[i * 4 + 2] = r;
    rimg.data[i * 4 + 3] = 255;
    spi.data[i * 4] = spi.data[i * 4 + 1] = spi.data[i * 4 + 2] = 255;
    spi.data[i * 4 + 3] = Math.round(255 * ((1 + (PANEL.spec - 1) * panel[i]) * (1 - k) + k));
    const c = Math.round(255 * (1 - rimK[i]));
    cci.data[i * 4] = cci.data[i * 4 + 1] = cci.data[i * 4 + 2] = c;
    cci.data[i * 4 + 3] = 255;
  }
  rgc.putImageData(rimg, 0, 0);
  m.roughnessMap.needsUpdate = true;
  spg.putImageData(spi, 0, 0);
  ccg.putImageData(cci, 0, 0);

  // normals: the twill (clear on the panel, as soft as the rim's outside the groove, filled by the ink) plus the
  // print's hair of thickness, kept on the letters (the ink dilated by 2 texels)
  const rel = blur5(ink, W, H);
  const near = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (ink[y * W + x] < 0.03) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) near[clamp(y + dy, 0, H - 1) * W + clamp(x + dx, 0, W - 1)] = 1;
    }
  const sx = 0.55 * WEAVE_K * (TWILL_Q / (fw / W)), sy = 0.55 * WEAVE_K * (TWILL_Q / (fh / H));
  const RELIEF = 1.1;
  const nC = makeCanvas(W, H), ng = nC.getContext("2d"), ni = ng.createImageData(W, H);
  const at = (f, x, y) => f[clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const kk = (0.55 + 0.45 * panel[i]) * (1 - 0.75 * ink[i]);
      let nx = -(at(hgt, x + 1, y) - at(hgt, x - 1, y)) * 0.5 * sx * kk;
      let ny = (at(hgt, x, y + 1) - at(hgt, x, y - 1)) * 0.5 * sy * kk;
      if (near[i]) {
        nx += -(at(rel, x + 1, y) - at(rel, x - 1, y)) * 0.5 * RELIEF;
        ny += (at(rel, x, y + 1) - at(rel, x, y - 1)) * 0.5 * RELIEF;
      }
      const l = Math.hypot(nx, ny, 1);
      ni.data[i * 4] = (nx / l / 2 + 0.5) * 255;
      ni.data[i * 4 + 1] = (ny / l / 2 + 0.5) * 255;
      ni.data[i * 4 + 2] = (1 / l / 2 + 0.5) * 255;
      ni.data[i * 4 + 3] = 255;
    }
  ng.putImageData(ni, 0, 0);

  const mk = (canvas) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = 16;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.copy(m.map.repeat);
    return t;
  };
  m.normalMap = mk(nC);
  m.normalScale = new THREE.Vector2(1, 1);
  m.specularIntensityMap = mk(specC);
  m.clearcoat = COAT.k;
  m.clearcoatRoughness = COAT.rough;
  m.clearcoatNormalMap = null;
  m.clearcoatMap = mk(coatC);
  for (const t of [m.map, m.roughnessMap, m.normalMap, m.specularIntensityMap, m.clearcoatMap]) {
    t.offset.set(0.5, 0.5 - TEXT_Y / fh);
    t.updateMatrix();
  }
  m.sheen = FACE_SHEEN;
  return m;
}
/** Cumulative arc length round the outline offset by R (the rim sweeps' u, the same on every ring) and the normals there. */
function outlineArc(base) {
  const N = base.length, s = [0];
  for (let i = 1; i <= N; i++) {
    const a = base[i - 1], b = base[i % N];
    s.push(s[i - 1] + Math.hypot(b.x + R * b.nx - a.x - R * a.nx, b.y + R * b.ny - a.y - R * a.ny));
  }
  return s;
}
/**
 * The round-overs' sheen (a sheenColorMap): across the outline (u = arc length at offset R) it is full where the moulding
 * faces up and half where it faces the sides or the floor; down the profile (v, front rim only) it rises from the face's
 * level at the face's edge to full within 6 mm.
 */
function rimSheenMap(base, ramp) {
  const s = outlineArc(base), N = base.length, LR = s[N];
  const Wc = 1024, Hc = ramp ? 128 : 4, span = 0.25;
  const ks = new Float32Array(Wc);
  let i = 0;
  for (let x = 0; x < Wc; x++) {
    const u = ((x + 0.5) / Wc) * LR;
    while (i < N - 1 && s[i + 1] < u) i++;
    const t = clamp((u - s[i]) / (s[i + 1] - s[i]), 0, 1);
    const a = base[i], b = base[(i + 1) % N];
    ks[x] = sheenK(a.ny + (b.ny - a.ny) * t);
  }
  const c = makeCanvas(Wc, Hc), g = c.getContext("2d"), img = g.createImageData(Wc, Hc);
  for (let y = 0; y < Hc; y++) {
    const v = (1 - (y + 0.5) / Hc) * span;
    const r = ramp ? FACE_SHEEN + (1 - FACE_SHEEN) * sstep(0, 0.055, v) : 1;
    for (let x = 0; x < Wc; x++) {
      const k = Math.round(255 * r * ks[x]);
      img.data.set([k, k, k, 255], (y * Wc + x) * 4);
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1 / LR, 1 / span);
  t.updateMatrix();
  return t;
}

// ───────────────────────────── geometry: sweeps round a rounded rectangle
/**
 * The inner rectangle's boundary (±ax, ±by) with outward normals, CCW from the bottom of the right edge. Offsetting
 * every point by d along its normal gives the rounded rectangle of corner radius d (so all outlines are concentric).
 */
function outline(ax, by, sx, sy, k) {
  const pts = [];
  const edge = (x0, y0, x1, y1, nx, ny, n) => {
    for (let i = 0; i < n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n, nx, ny });
  };
  const arc = (cx, cy, a0, n) => {
    for (let j = 0; j < n; j++) {
      const a = a0 + (Math.PI / 2) * (j / n);
      pts.push({ x: cx, y: cy, nx: Math.cos(a), ny: Math.sin(a) });
    }
  };
  edge(ax, -by, ax, by, 1, 0, sy);
  arc(ax, by, 0, k);
  edge(ax, by, -ax, by, 0, 1, sx);
  arc(-ax, by, Math.PI / 2, k);
  edge(-ax, by, -ax, -by, -1, 0, sy);
  arc(-ax, -by, Math.PI, k);
  edge(-ax, -by, ax, -by, 0, -1, sx);
  arc(ax, -by, 1.5 * Math.PI, k);
  return pts;
}
/** Adds a triangle wound to agree with its vertex normals (the path tracer culls back faces); skips degenerate ones. */
function pushTri(idx, pos, nor, a, b, c) {
  const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
  const e1x = pos[b * 3] - ax, e1y = pos[b * 3 + 1] - ay, e1z = pos[b * 3 + 2] - az;
  const e2x = pos[c * 3] - ax, e2y = pos[c * 3 + 1] - ay, e2z = pos[c * 3 + 2] - az;
  const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
  if (cx * cx + cy * cy + cz * cz < 1e-24) return;
  const nx = nor[a * 3] + nor[b * 3] + nor[c * 3], ny = nor[a * 3 + 1] + nor[b * 3 + 1] + nor[c * 3 + 1], nz = nor[a * 3 + 2] + nor[b * 3 + 2] + nor[c * 3 + 2];
  if (cx * nx + cy * ny + cz * nz < 0) idx.push(a, c, b);
  else idx.push(a, b, c);
}
function makeGeo(pos, nor, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos instanceof Float32Array ? pos : new Float32Array(pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(nor instanceof Float32Array ? nor : new Float32Array(nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv instanceof Float32Array ? uv : new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}
/**
 * Sweeps a profile [{d, z, n: [nd, nz]}] round an outline: each profile point becomes a ring (the outline offset by d,
 * at depth z). Normals are analytic (the profile normal turned to the outline's normal), so separate sweeps sharing a
 * profile point meet without a crease. uv "planar" = (x, y); "strip" = (arc length round, length along the profile);
 * "stripR" = the same, but the arc length is measured at offset R on every ring (so u marks the same place round the case).
 */
function sweep(base, prof, uvMode = "strip") {
  const N = base.length, Pn = prof.length, C = N + 1;
  const pos = new Float32Array(Pn * C * 3), nor = new Float32Array(Pn * C * 3), uv = new Float32Array(Pn * C * 2);
  const sR = uvMode === "stripR" ? outlineArc(base) : null;
  let v = 0;
  for (let k = 0; k < Pn; k++) {
    const { d, z, n } = prof[k];
    if (k > 0) v += Math.hypot(d - prof[k - 1].d, z - prof[k - 1].z);
    let s = 0, px = 0, py = 0;
    for (let i = 0; i < C; i++) {
      const b = base[i % N];
      const x = b.x + d * b.nx, y = b.y + d * b.ny;
      if (i > 0) s += Math.hypot(x - px, y - py);
      px = x;
      py = y;
      const o = k * C + i;
      pos[o * 3] = x;
      pos[o * 3 + 1] = y;
      pos[o * 3 + 2] = z;
      const nx = n[0] * b.nx, ny = n[0] * b.ny, nz = n[1], l = Math.hypot(nx, ny, nz) || 1;
      nor[o * 3] = nx / l;
      nor[o * 3 + 1] = ny / l;
      nor[o * 3 + 2] = nz / l;
      uv[o * 2] = uvMode === "planar" ? x : sR ? sR[i] : s;
      uv[o * 2 + 1] = uvMode === "planar" ? y : v;
    }
  }
  const idx = [];
  for (let k = 0; k < Pn - 1; k++)
    for (let i = 0; i < N; i++) {
      const a = k * C + i, b = a + 1, c = a + C + 1, d = a + C;
      pushTri(idx, pos, nor, a, b, c);
      pushTri(idx, pos, nor, a, c, d);
    }
  return makeGeo(pos, nor, uv, idx);
}
/** The flat middle of a face: a grid on the inner rectangle whose border meets the sweep's innermost ring exactly. */
function capGrid(ax, by, sx, sy, z, facing) {
  const C = sx + 1;
  const pos = [], nor = [], uv = [], idx = [];
  for (let j = 0; j <= sy; j++)
    for (let i = 0; i <= sx; i++) {
      const x = -ax + (2 * ax * i) / sx, y = -by + (2 * by * j) / sy;
      pos.push(x, y, z);
      nor.push(0, 0, facing);
      uv.push(x, y);
    }
  const pa = new Float32Array(pos), na = new Float32Array(nor);
  for (let j = 0; j < sy; j++)
    for (let i = 0; i < sx; i++) {
      const a = j * C + i, b = a + 1, c = a + C + 1, d = a + C;
      pushTri(idx, pa, na, a, b, c);
      pushTri(idx, pa, na, a, c, d);
    }
  return makeGeo(pa, na, new Float32Array(uv), idx);
}

// ───────────────────────────── the shell profile: a superellipse round-over (moulded EVA), a wall, a rolled seam
const lidD = (phi) => R * Math.sqrt(Math.sin(phi));
const lidZ = (phi) => ZW + (ZF - ZW) * Math.sqrt(Math.cos(phi));
const grooveAt = (d) => GROOVE.depth * Math.exp(-(((d - GROOVE.d) / GROOVE.w) ** 2));
function lidPoint(phi, groove) {
  const d = lidD(phi);
  return { d, z: lidZ(phi) - (groove ? grooveAt(d) : 0) };
}
function lidSample(phi, groove) {
  const p = lidPoint(phi, groove);
  if (phi <= 1e-7) return { ...p, n: [0, 1] };
  const e = 1e-5;
  const a = lidPoint(Math.max(1e-9, phi - e), groove), b = lidPoint(Math.min(Math.PI / 2, phi + e), groove);
  return { ...p, n: [-(b.z - a.z), b.d - a.d] };
}
const phiAt = (d) => Math.asin(Math.min(1, (d / R) ** 2));
/** The printed face: from the middle out to DSPLIT, dense round the groove. */
function faceProfile(groove) {
  const ds = new Set();
  for (let d = 0; d < DSPLIT; d += 0.012) ds.add(+d.toFixed(5));
  if (groove) for (let d = GROOVE.d - 0.022; d <= GROOVE.d + 0.022; d += 0.0016) ds.add(+d.toFixed(5));
  ds.add(DSPLIT);
  return [...ds].sort((a, b) => a - b).map((d) => lidSample(phiAt(d), groove));
}
/** The round-over, the side wall and the rolled edge down to the seam. */
function rimProfile() {
  const out = [];
  const p0 = phiAt(DSPLIT);
  const n = 30;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(lidSample(p0 + (Math.PI / 2 - p0) * (1 - (1 - t) ** 2), false));
  }
  out.push({ d: R, z: (ZW + ZS + RR) / 2, n: [1, 0] });
  out.push({ d: R, z: ZS + RR, n: [1, 0] });
  for (let i = 1; i <= 6; i++) {
    const a = -(Math.PI / 2) * (i / 6);
    out.push({ d: R - RR + RR * Math.cos(a), z: ZS + RR + RR * Math.sin(a), n: [Math.cos(a), Math.sin(a)] });
  }
  out.push({ d: R - 0.05, z: ZS, n: [0, -1] });
  return out;
}
const mirror = (prof) => prof.map((p) => ({ d: p.d, z: -p.z, n: [p.n[0], -p.n[1]] })).reverse();
/** A round bead (the bound edge) swept round the outline. */
function beadProfile(dc, zc, r, n = 18) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    out.push({ d: dc + r * Math.cos(a), z: zc + r * Math.sin(a), n: [Math.cos(a), Math.sin(a)] });
  }
  return out;
}

// ───────────────────────────── repeated small parts along the outline: zip teeth, stitches
/**
 * Copies of a rounded box spaced `pitch` apart round the outline offset by dT; size = [out of the wall, along, across
 * (z)]. Each copy sits at z = zc, alternately offset ±zOff (zip teeth interlocking from both tapes).
 */
function along(base, dT, pitch, size, zOff, zc = 0) {
  const N = base.length;
  const ring = [], cum = [0];
  for (let i = 0; i <= N; i++) {
    const b = base[i % N];
    ring.push({ x: b.x + dT * b.nx, y: b.y + dT * b.ny, nx: b.nx, ny: b.ny });
    if (i > 0) cum.push(cum[i - 1] + Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y));
  }
  const L = cum[N];
  const count = Math.round(L / pitch);
  const step = L / count;
  const proto = new RoundedBoxGeometry(size[0], size[1], size[2], 1, Math.min(...size) * 0.36);
  const geos = [];
  const m = new THREE.Matrix4();
  let i = 0;
  for (let k = 0; k < count; k++) {
    const s = (k + 0.5) * step;
    while (cum[i + 1] < s) i++;
    const t = (s - cum[i]) / (cum[i + 1] - cum[i]);
    const x = ring[i].x + (ring[i + 1].x - ring[i].x) * t, y = ring[i].y + (ring[i + 1].y - ring[i].y) * t;
    const nn = V3(ring[i].nx + (ring[i + 1].nx - ring[i].nx) * t, ring[i].ny + (ring[i + 1].ny - ring[i].ny) * t, 0).normalize();
    const tg = V3(-nn.y, nn.x, 0);
    m.makeBasis(nn, tg, V3(0, 0, 1)).setPosition(x, y, zc + (k % 2 ? zOff : -zOff));
    geos.push(proto.clone().applyMatrix4(m));
  }
  return mergeGeometries(geos);
}

// ───────────────────────────── swept sections along a path (handle, straps, tie)
/**
 * Sweeps a superellipse section along a smooth path whose section keeps the binormal `bz` (paths lying in a plane
 * normal to `bz`). sec(t) → { th, w }: thickness across the path, width along bz. UV: (arc length, round the section).
 */
function ribbon(points, sec, { seg = 120, radial = 28, m = 4, bz = V3(0, 0, 1), closed = false, surface = null } = {}) {
  const curve = new THREE.CatmullRomCurve3(points, closed, "centripetal");
  const L = curve.getLength();
  const C = radial + 1;
  const pos = [], nor = [], uv = [];
  const ex = 2 / m;
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const tc = closed && i === seg ? 0 : t; // a closed path ends where it began
    const p = curve.getPointAt(tc), T = curve.getTangentAt(tc);
    let No, Bn;
    if (surface) {
      // a strap lying on a surface: thickness along the surface normal, width across the path
      Bn = V3().crossVectors(T, surface(p, T)).normalize();
      No = V3().crossVectors(Bn, T).normalize();
    } else {
      No = V3().crossVectors(bz, T).normalize();
      Bn = V3().crossVectors(T, No).normalize();
    }
    const { th, w } = sec(t, L);
    let sv = 0, prev = null;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU, c = Math.cos(a), s = Math.sin(a);
      const qx = Math.sign(c) * Math.abs(c) ** ex, qy = Math.sign(s) * Math.abs(s) ** ex;
      const q = p.clone().addScaledVector(No, (th / 2) * qx).addScaledVector(Bn, (w / 2) * qy);
      const gx = (Math.sign(c) * Math.abs(c) ** (2 - ex)) / Math.max(th / 2, 1e-6), gy = (Math.sign(s) * Math.abs(s) ** (2 - ex)) / Math.max(w / 2, 1e-6);
      const n = No.clone().multiplyScalar(gx).addScaledVector(Bn, gy).normalize();
      if (prev) sv += q.distanceTo(prev);
      prev = q;
      pos.push(q.x, q.y, q.z);
      nor.push(n.x, n.y, n.z);
      uv.push(t * L, sv);
    }
  }
  const pa = new Float32Array(pos), na = new Float32Array(nor);
  const idx = [];
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * C + j, b = a + 1, c = a + C + 1, d = a + C;
      pushTri(idx, pa, na, a, b, c);
      pushTri(idx, pa, na, a, c, d);
    }
  return makeGeo(pa, na, new Float32Array(uv), idx);
}
/** A straight thread between two points (a thin rounded rod). */
function thread(a, b, r) {
  const d = V3().subVectors(b, a);
  const g = new THREE.CapsuleGeometry(r, Math.max(1e-4, d.length() - 2 * r), 4, 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.clone().normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

// ───────────────────────────── small parts
/** A polygon with rounded corners (radius r) as a THREE.Shape. */
function roundedPoly(points, r) {
  const s = new THREE.Shape();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i], a = points[(i + n - 1) % n], b = points[(i + 1) % n];
    const da = new THREE.Vector2(a[0] - p[0], a[1] - p[1]).normalize(), db = new THREE.Vector2(b[0] - p[0], b[1] - p[1]).normalize();
    const p1 = [p[0] + da.x * r, p[1] + da.y * r], p2 = [p[0] + db.x * r, p[1] + db.y * r];
    if (i === 0) s.moveTo(p1[0], p1[1]);
    else s.lineTo(p1[0], p1[1]);
    s.quadraticCurveTo(p[0], p[1], p2[0], p2[1]);
  }
  s.closePath();
  return s;
}
/** Extrudes a shape (drawn in the y-z plane as (z, y)) outwards along +x, from x = 0 to x = depth. */
function extrudeX(shape, depth, bevel, mat, curveSegments = 24) {
  const b = Math.min(bevel, depth / 2 - 1e-4);
  const g = new THREE.ExtrudeGeometry(shape, { depth: depth - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments: 5, curveSegments });
  g.translate(0, 0, b);
  g.rotateY(Math.PI / 2); // shape x → -z, extrusion z → +x
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function rrect(w, h, r) {
  r = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4);
  const s = new THREE.Shape(), x = w / 2, y = h / 2;
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.absarc(x - r, -y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x, y - r);
  s.absarc(x - r, y - r, r, 0, Math.PI / 2, false);
  s.lineTo(-x + r, y);
  s.absarc(-x + r, y - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + r);
  s.absarc(-x + r, -y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/** The front lid's surface over (x, y): depth, normal and offset d from the inner rectangle (d ≥ R: the side wall). */
function lidSurface(x, y) {
  const dx = Math.max(Math.abs(x) - AI, 0), dy = Math.max(Math.abs(y) - BI, 0);
  const d = Math.hypot(dx, dy);
  const nx = d > 1e-9 ? (Math.sign(x) * dx) / d : 0, ny = d > 1e-9 ? (Math.sign(y) * dy) / d : 0;
  if (d >= R - 1e-4) return { z: ZW, n: V3(nx, ny, 0), d };
  const s = lidSample(phiAt(d), true);
  const n = V3(s.n[0] * nx, s.n[0] * ny, s.n[1]).normalize();
  return { z: s.z + dome(x, y), n: domeNormal(n, x, y), d };
}

const NICKEL = () => P({ color: "#d6d9de", metalness: 1, roughness: 0.32 }); // satin nickel: a broad, soft sheen of the soft boxes
/**
 * The zip slider on the top-right corner of the seam (one crowned, tapered satin-nickel body straddling the chain, its
 * bridge and pin towards the rear end), turned towards the camera; and its pull: a red woven strap looped through the
 * bridge, rising in a short loop above it, then running forward over the bound edge and the lid's rounded edge, ending in a
 * moulded red rubber tab that lies on the lid's corner, facing the camera.
 */
const PULL_A = 0.9; // where the slider sits on the corner arc (radians from +x)
const SLIDER = { scale: 1.2, turn: -0.5, bridgeY: -0.03 };
function zipPull() {
  const g = new THREE.Group();
  const metal = NICKEL();
  const rubber = M.red({ roughness: 0.5, clearcoat: 0.2, clearcoatRoughness: 0.5 });
  const a = PULL_A, n0 = V3(Math.cos(a), Math.sin(a), 0), tg = V3(-Math.sin(a), Math.cos(a), 0);
  // the slider: local X out of the zip, Y along it, Z across (towards the camera); turned to show its crowned top
  const sq = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(n0, tg, V3(0, 0, 1)));
  sq.multiply(new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), SLIDER.turn));
  const s = new THREE.Group();
  s.quaternion.copy(sq);
  s.position.copy(V3(AI + (R - 0.002) * n0.x, BI + (R - 0.002) * n0.y, 0.004));
  s.scale.setScalar(SLIDER.scale);
  const local = (x, y, z) => V3(x, y, z).multiplyScalar(SLIDER.scale).applyQuaternion(sq).add(s.position);
  // a wedge (narrow where the joined chain leaves, wide at the shoulder where the two tapes enter), its top crowned
  s.add(extrudeX(roundedPoly([[-0.024, -0.072], [0.024, -0.072], [0.045, 0.07], [-0.045, 0.07]], 0.02), 0.03, 0.014, metal));
  // the lug: two posts rising from the top plate either side of the strap, the pin across them
  const BY = SLIDER.bridgeY;
  for (const sy of [-1, 1]) {
    const post = new THREE.Mesh(new RoundedBoxGeometry(0.02, 0.011, 0.024, 3, 0.0045), metal);
    post.position.set(0.036, BY + sy * 0.0205, 0);
    s.add(post);
  }
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.0062, 0.052, 24), metal); // along the zip (local Y)
  pin.position.set(0.044, BY, 0);
  s.add(pin);
  g.add(s);

  // the strap runs on the ray through the bridge (the slider's rear end sits a little round the corner)
  const pinW = local(0.044, BY, 0);
  const a2 = Math.atan2(pinW.y - BI, pinW.x - AI);
  const n = V3(Math.cos(a2), Math.sin(a2), 0);
  const onRay = (d, z) => V3(AI + d * n.x, BI + d * n.y, z);
  // the strap: round the pin, then forward over the bound edge, the wall and the round-over, then down the lid
  const ht = 0.0042; // half its thickness
  const pts = [];
  const pr = 0.0062 + (ht + 0.0004) / SLIDER.scale;
  // a full turn round the pin in the slider's X-Z plane: from in front of it, under it (through the lug), up behind it,
  // over the top and forward, so the strap's folded end is tucked under the layer that leaves
  for (const b of [2.25, 2.9, 3.55, 4.2, 4.85, 5.5, 6.15, 6.8, 7.4, 7.65]) pts.push(local(0.044 + pr * Math.cos(b), BY, pr * Math.sin(b)));
  for (const [d, z] of [[R + 0.03, 0.062], [R + 0.006 + ht + 0.0012, ZS - 0.001], [R + ht + 0.0006, ZS + 0.024], [R + ht + 0.0006, ZW - 0.004]]) pts.push(onRay(d, z));
  const dTurn = 0.315; // the strap starts to swing down while still on the round-over
  const p0 = phiAt(dTurn);
  for (let i = 1; i <= 10; i++) {
    const phi = Math.PI / 2 - (Math.PI / 2 - p0) * (i / 10);
    const q = lidSample(phi, true);
    const l = Math.hypot(q.n[0], q.n[1]);
    pts.push(onRay(q.d + (ht + 0.0006) * (q.n[0] / l), q.z + (ht + 0.0006) * (q.n[1] / l)));
  }
  // from there it bends gently from running inwards to hanging straight down, lying on the lid
  const face = (x, y) => {
    const sfc = lidSurface(x, y);
    return V3(x, y, sfc.z).addScaledVector(sfc.n, ht + 0.0007);
  };
  const h0 = a2 + Math.PI, h1 = 1.5 * Math.PI;
  let fx = AI + dTurn * n.x, fy = BI + dTurn * n.y;
  const bendSteps = 10;
  for (let i = 1; i <= bendSteps; i++) {
    const h = h0 + (h1 - h0) * sstep(0, 1, i / bendSteps);
    fx += Math.cos(h) * 0.0088;
    fy += Math.sin(h) * 0.0088;
    pts.push(face(fx, fy));
  }
  const tip = face(fx, fy - 0.012);
  pts.push(tip);
  // on the lid the strap lies on its surface; off it (round the pin, in the air, down the wall) its width stays along the zip
  const zipT = V3(-Math.sin(a2), Math.cos(a2), 0);
  const normalAt = (p, T) => {
    const sfc = lidSurface(p.x, p.y);
    return sfc.d >= R - 1e-3 ? V3().crossVectors(zipT, T).normalize() : sfc.n;
  };
  const strapMat = M.fabric({ color: "#b3121a", roughness: 0.85, sheen: 0.5, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ff6a6a"), normalMap: webbingNormal(0.006), normalScale: new THREE.Vector2(0.5, 0.5) });
  g.add(new THREE.Mesh(ribbon(pts, () => ({ th: 2 * ht, w: 0.03 }), { seg: 120, radial: 24, m: 6, surface: normalAt }), strapMat));

  // the moulded rubber tab and its metal clamp, lying on the lid
  const tabL = 0.105, tabT = 0.017;
  const top = tip.y + 0.014, bottom = top - tabL;
  const zTop = lidSurface(tip.x, top).z, zBot = lidSurface(tip.x, bottom).z;
  const tab = new THREE.Group();
  const tg2 = new THREE.ExtrudeGeometry(rrect(0.052, tabL, 0.026), { depth: tabT - 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelOffset: -0.006, bevelSegments: 6, curveSegments: 32 });
  tg2.translate(0, 0, -(tabT - 0.012) / 2);
  tg2.computeVertexNormals();
  tab.add(new THREE.Mesh(tg2, rubber));
  // a raised moulded rim inset on its face
  const ell = [];
  for (let i = 0; i < 64; i++) ell.push(V3(0.0135 * Math.cos((i / 64) * TAU), -0.009 + 0.029 * Math.sin((i / 64) * TAU), tabT / 2 - 0.0012));
  tab.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(ell, true), 128, 0.0026, 12, true), rubber));
  const clamp3 = new THREE.Mesh(new RoundedBoxGeometry(0.042, 0.022, 0.024, 4, 0.008), metal);
  clamp3.position.set(0, tabL / 2 - 0.006, 0.002);
  tab.add(clamp3);
  tab.position.set(tip.x, (top + bottom) / 2, (zTop + zBot) / 2 + tabT / 2 + 0.0008);
  tab.rotation.x = Math.atan2(zTop - zBot, tabL);
  g.add(tab);
  return g;
}

/**
 * The carry handle: a padded strap handle. A woven webbing strap is sewn flat to the back shell's top at both ends (box-X
 * stitches), rises through soft knees into a rounded arch (about 21 mm of clearance), and carries a rolled, padded PU grip
 * over its top: an oval tube, stitched along its front and back, its ends turned in round the strap.
 */
const HANDLE = { hx: 0.34, hh: 0.19, rb: 0.055, fl: 0.085, th: 0.016, w: 0.1, HZ: -0.135, lean: 0.06, E: 0.9, gripHalf: 0.23, sth: 0.065, sw: 0.12 };
function handle() {
  const g = new THREE.Group();
  const { hx, hh, rb, fl, th, w, HZ, lean, E, gripHalf, sth, sw } = HANDLE;
  const y0 = B + th / 2 + 0.0004;
  const local = [];
  for (let i = 0; i <= 8; i++) local.push(V3(hx + rb + fl * (1 - i / 8), y0, 0));
  for (let i = 1; i <= 10; i++) {
    const a = -Math.PI / 2 - (Math.PI / 2) * (i / 10);
    local.push(V3(hx + rb + rb * Math.cos(a), y0 + rb + rb * Math.sin(a), 0));
  }
  for (let i = 1; i < 64; i++) {
    const t = Math.PI * (i / 64), c = Math.cos(t), s = Math.sin(t);
    local.push(V3(hx * Math.sign(c) * Math.abs(c) ** E, y0 + rb + (hh - rb) * Math.abs(s) ** E, 0));
  }
  for (let i = 0; i <= 10; i++) {
    const a = -(Math.PI / 2) * (i / 10);
    local.push(V3(-hx - rb + rb * Math.cos(a), y0 + rb + rb * Math.sin(a), 0));
  }
  for (let i = 1; i <= 8; i++) local.push(V3(-hx - rb - fl * (i / 8), y0, 0));
  // lean the loop back a hair about its feet
  const tilt = (p) => V3(p.x, y0 + (p.y - y0) * Math.cos(lean), HZ - (p.y - y0) * Math.sin(lean));
  const pts = local.map(tilt);
  const bz = V3(0, Math.sin(lean), Math.cos(lean));
  // charcoal webbing and PU with a little of the case's velvet, so the arch keeps an outline on the dark floor
  const webbing = P({ color: "#414249", roughness: 0.75, sheen: 0.4, sheenRoughness: 0.6, sheenColor: new THREE.Color("#7a7f88"), normalMap: webbingNormal(), normalScale: new THREE.Vector2(0.45, 0.45) });
  g.add(new THREE.Mesh(ribbon(pts, (t, L) => ({ th: th * endCap(t, L, 0.012, 6), w: w * endCap(t, L, 0.02, 3) }), { seg: 260, radial: 32, m: 8, bz }), webbing));

  // the rolled PU grip over the arch's top
  const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const Lw = curve.getLength(), half = gripHalf / Lw;
  const gp = [];
  for (let i = 0; i <= 64; i++) gp.push(curve.getPointAt(0.5 - half + (2 * half * i) / 64));
  const pu = P({ color: "#3c3d43", roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.38, normalMap: microNormal("grain", 3), normalScale: new THREE.Vector2(0.1, 0.1) });
  const M2 = 2.6; // the grip's section: a soft oval (superellipse exponent)
  const gripSec = (t, L) => ({ th: sth * endCap(t, L, 0.032, 2.2), w: sw * endCap(t, L, 0.032, 2.2) });
  g.add(new THREE.Mesh(ribbon(gp, gripSec, { seg: 140, radial: 56, m: M2, bz }), pu));
  // stitch rows along the grip's front and back faces, a third of the way in from its top and bottom
  const sc = new THREE.CatmullRomCurve3(gp, false, "centripetal");
  const Ls = sc.getLength();
  const stitch = new RoundedBoxGeometry(0.011, 0.0026, 0.0034, 1, 0.0011);
  const sg = [];
  const mtx = new THREE.Matrix4();
  for (let s = 0.034; s <= Ls - 0.034; s += 0.0155) {
    const t = s / Ls, p = sc.getPointAt(t), T = sc.getTangentAt(t);
    const No = V3().crossVectors(bz, T).normalize(), Bn = V3().crossVectors(T, No).normalize();
    const { th: a, w: b } = gripSec(t, Ls);
    for (const fb of [-1, 1])
      for (const ud of [-1, 1]) {
        const u = 0.5 * ud, v = (1 - Math.abs(u) ** M2) ** (1 / M2); // a point on the oval section
        const q = p.clone().addScaledVector(No, (a / 2) * u).addScaledVector(Bn, fb * (b / 2) * v);
        // the section's normal there (the gradient of the superellipse)
        const nrm = No.clone().multiplyScalar((Math.sign(u) * Math.abs(u) ** (M2 - 1)) / (a / 2)).addScaledVector(Bn, (fb * v ** (M2 - 1)) / (b / 2)).normalize();
        q.addScaledVector(nrm, 0.0005);
        mtx.makeBasis(T, nrm, V3().crossVectors(T, nrm).normalize()).setPosition(q);
        sg.push(stitch.clone().applyMatrix4(mtx));
      }
  }
  const threadMat = P({ color: "#64666e", roughness: 0.7 });
  g.add(new THREE.Mesh(mergeGeometries(sg), threadMat));

  // box-X stitches holding each flat end to the shell
  const ys = y0 + th / 2 + 0.0002, r = 0.0013;
  const box = [];
  for (const sgn of [-1, 1]) {
    const x0 = sgn * (hx + rb + 0.016), x1 = sgn * (hx + rb + fl - 0.018), z0 = HZ - w / 2 + 0.014, z1 = HZ + w / 2 - 0.014;
    const c = [V3(x0, ys, z0), V3(x1, ys, z0), V3(x1, ys, z1), V3(x0, ys, z1)];
    for (let k = 0; k < 4; k++) box.push(thread(c[k], c[(k + 1) % 4], r));
    box.push(thread(c[0], c[2], r), thread(c[1], c[3], r));
  }
  g.add(new THREE.Mesh(mergeGeometries(box), threadMat));
  return g;
}

// ───────────────────────────── the cable: a braided coil leaning on the lid, its plug on the table
const COIL = {
  x: -0.9, r: 0.18, rc: 0.019, lean: 0.13, tie: 2.2, spread: 0.09, turns: 2,
  tail1: { psi: 0.55, len: 0.22 }, // the front end: out to the right, turning towards the camera
  tail2: { psi: 1.7, len: 0.12, straight: 0.35 }, // the back end: a little left along the table, then out towards the camera
};
function cable() {
  const g = new THREE.Group();
  const { r: RC, rc } = COIL;
  // two full turns from the back loop's bottom to the front loop's bottom: both ends leave the coil on the table
  const start = 1.5 * Math.PI, end = start + COIL.turns * TAU, total = end - start;
  const loopPoint = (th) => {
    const t = th - start, q = t / total, L = t / TAU; // q: 0 → 1 along the coil, L: loops wound so far
    const k = 1 - Math.exp(-((angDiff(th, COIL.tie) / 0.55) ** 2)); // the tie gathers the loops together
    // hand-wound: every loop a little bigger or smaller, a little oval, its centre drifting
    const r = RC * (1 + k * (0.06 * Math.sin(2.3 * L + 0.4) + 0.022 * Math.sin(2 * th + 1.7 * L)));
    const cx = k * 0.02 * Math.sin(1.9 * L + 0.8), cy = k * 0.016 * Math.sin(1.4 * L + 2.0);
    return V3(cx + r * Math.cos(th), cy + r * Math.sin(th), -COIL.spread / 2 + COIL.spread * q);
  };
  const local = [];
  for (let th = start; th < end; th += 0.1) local.push(loopPoint(th));
  local.push(loopPoint(end));
  // lean it back and place it: the lowest point on the table, the top resting on the (domed) lid
  const lean = new THREE.Matrix4().makeRotationX(-COIL.lean);
  const placed = local.map((p) => p.clone().applyMatrix4(lean));
  const minY = Math.min(...placed.map((p) => p.y));
  const sy = FLOOR + rc + 0.0006 - minY;
  let sz = -Infinity;
  for (const p of placed) {
    const x = p.x + COIL.x, y = p.y + sy;
    if (offsetD(x, y) >= R - 0.02) continue;
    sz = Math.max(sz, lidSurface(x, y).z + rc + 0.0012 - p.z);
  }
  if (!Number.isFinite(sz)) sz = ZF + rc + 0.0012 - Math.min(...placed.map((p) => p.z));
  const shift = V3(COIL.x, sy, sz);
  const toWorld = (p) => p.clone().applyMatrix4(lean).add(shift);
  const world = local.map(toWorld);
  // the tail: off the front loop's bottom, down onto the table, curving towards the camera
  const E = world[world.length - 1];
  const { psi, len } = COIL.tail1, steps = 10;
  let px = E.x, pz = E.z;
  for (let i = 1; i <= steps; i++) {
    const s = i / steps, h = psi * sstep(0, 1, s);
    px += (Math.cos(h) * len) / steps;
    pz += (Math.sin(h) * len) / steps;
    const y = FLOOR + rc + (E.y - FLOOR - rc) * (1 - sstep(0, 0.4, s)) + (PLUG_Y - FLOOR - rc - 0.0004) * sstep(0.5, 1, s);
    world.push(V3(px, y, pz));
  }
  // the other end: off the back loop's bottom it runs left along the table, then swings out under the front loops towards
  // the camera, so the two plugs lie in a loose V in front of the coil
  const S = world[0];
  const { psi: psi2, len: len2, straight } = COIL.tail2, steps2 = 14;
  const head = [];
  let qx = S.x, qz = S.z;
  for (let i = 1; i <= steps2; i++) {
    const s = i / steps2, h = psi2 * sstep(straight, 1, s);
    qx -= (Math.cos(h) * len2) / steps2;
    qz += (Math.sin(h) * len2) / steps2;
    const y = FLOOR + rc + (S.y - FLOOR - rc) * (1 - sstep(0, 0.3, s)) + (PLUG_Y - FLOOR - rc - 0.0004) * sstep(0.6, 1, s);
    head.push(V3(qx, y, qz));
  }
  world.unshift(...head.reverse());
  const curve = new THREE.CatmullRomCurve3(world, false, "centripetal");
  const L = curve.getLength();
  const maps = braidMaps("#c2c5cb", "#a3a7ae");
  const braidLen = 0.07;
  const braid = P({
    color: "#ffffff",
    map: maps.map.clone(),
    roughness: 1,
    roughnessMap: maps.roughnessMap.clone(),
    normalMap: maps.normalMap.clone(),
    normalScale: new THREE.Vector2(0.8, 0.8),
  });
  for (const t of [braid.map, braid.roughnessMap, braid.normalMap]) {
    t.repeat.set(L / braidLen, 1);
    t.needsUpdate = true;
    t.updateMatrix();
  }
  g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.round(L / 0.0045), rc, 16, false), braid));

  // the hook-and-loop tie round the bundle at the tie angle, its free end lifting off the outer face
  const th = COIL.tie;
  const er = V3(Math.cos(th), Math.sin(th), 0), ez = V3(0, 0, 1), et = V3(-Math.sin(th), Math.cos(th), 0);
  const passes = [0, 1, 2, 3].map((k) => th + k * TAU).filter((a) => a >= start && a <= end).map((a) => loopPoint(a).z);
  const ac = (Math.min(...passes) + Math.max(...passes)) / 2;
  const hr = rc + 0.004, ha = (Math.max(...passes) - Math.min(...passes)) / 2 + rc + 0.004, cr = 0.014;
  const loop = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (Math.PI / 2) * (i / 6);
      loop.push([cx + cr * Math.cos(a), cy + cr * Math.sin(a)]);
    }
  };
  corner(hr - cr, ha - cr, 0);
  corner(-hr + cr, ha - cr, Math.PI / 2);
  corner(-hr + cr, -ha + cr, Math.PI);
  corner(hr - cr, -ha + cr, 1.5 * Math.PI);
  const onTie = ([u, w]) => toWorld(er.clone().multiplyScalar(RC + u).addScaledVector(ez, ac + w));
  const rotOnly = new THREE.Matrix4().extractRotation(lean);
  const tbz = et.clone().applyMatrix4(rotOnly).normalize();
  const tieMat = M.fabric({ color: "#b8121b", roughness: 0.9, sheen: 0.25, sheenRoughness: 0.65, sheenColor: new THREE.Color("#ff6a6a"), normalMap: weaveNormal(0.004), normalScale: new THREE.Vector2(0.35, 0.35) });
  g.add(new THREE.Mesh(ribbon(loop.map(onTie), () => ({ th: 0.0075, w: 0.042 }), { seg: 90, radial: 24, m: 6, bz: tbz, closed: true }), tieMat));
  // the free end: it lies on the outer face, runs past the front corner and curls up and away from the bundle
  const lift = hr + 0.0075 + 0.0005;
  const tail = [[lift - 0.007, ha - 0.05], [lift - 0.001, ha - 0.032], [lift, ha - 0.014], [lift + 0.004, ha + 0.003], [lift + 0.016, ha + 0.017], [lift + 0.034, ha + 0.025], [lift + 0.05, ha + 0.027]].map(onTie);
  g.add(new THREE.Mesh(ribbon(tail, (t, Lt) => ({ th: 0.0075, w: 0.042 * (t > 0.5 ? endCap(t, Lt, 0.016, 3) : 1) }), { seg: 40, radial: 24, m: 6, bz: tbz }), tieMat));

  // a USB-C plug at each end (the cable runs USB-C to USB-C), lying flat on the table
  const end3 = world[world.length - 1], end0 = world[0];
  g.add(at(rot(usbPlug(rc), 0, -psi, 0), end3.x, PLUG_Y, end3.z));
  g.add(at(rot(usbPlug(rc), 0, psi2 - Math.PI, 0), end0.x, PLUG_Y, end0.z));
  return g;
}
const PLUG_Y = FLOOR + 0.0278; // the housing lies flat on the table
/** A USB-C plug, true to scale (a 12 × 6.5 × 18 mm housing, the 8.3 × 2.4 mm plug), pointing along +x from the cable's end. */
function usbPlug(rc) {
  const plug = new THREE.Group();
  const boot = new THREE.LatheGeometry([[rc + 0.0015, -0.008], [rc + 0.002, 0.006], [0.0218, 0.02], [0.0236, 0.036], [0.0246, 0.05], [0.0246, 0.056]].map(([r, h]) => new THREE.Vector2(r, h)), 48);
  boot.rotateZ(-Math.PI / 2);
  plug.add(new THREE.Mesh(boot, M.rubber({ color: "#151518", roughness: 0.6 })));
  const ring = new THREE.LatheGeometry([[0.0246, 0.049], [0.0254, 0.051], [0.0254, 0.057], [0.0246, 0.059]].map(([r, h]) => new THREE.Vector2(r, h)), 48);
  ring.rotateZ(-Math.PI / 2);
  plug.add(new THREE.Mesh(ring, M.red({ roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.4 })));
  const alu = P({ color: "#c4c8cf", metalness: 1, roughness: 0.3 });
  const housing = extrudeX(rrect(0.1, 0.055, 0.026), 0.16, 0.01, alu, 32);
  housing.position.x = 0.057;
  plug.add(housing);
  const shell = extrudeX(rrect(0.0745, 0.0215, 0.0107), 0.062, 0.003, M.chrome({ roughness: 0.2 }), 24);
  shell.position.x = 0.213;
  plug.add(shell);
  const insul = extrudeX(rrect(0.064, 0.0125, 0.006), 0.008, 0.002, M.gloss({ color: "#060607", roughness: 0.3 }), 24);
  insul.position.x = 0.2685;
  plug.add(insul);
  return plug;
}

// ───────────────────────────── the object
export function build({ text, lang }) {
  const o = new THREE.Group();
  const base = outline(AI, BI, SX, SY, SK);
  const fabric = caseFabric();
  // the round-overs meet the rim lights at grazing angles: a softer weave there keeps the sheen from sparkling
  const rimFabric = fabric.clone();
  rimFabric.normalScale = new THREE.Vector2(0.15, 0.15);
  rimFabric.sheenRoughness = 0.5; // a broader velvet lobe: less grain where the sheen meets the rim lights at grazing angles
  rimFabric.sheenColorMap = rimSheenMap(base, false);
  const rimFront = rimFabric.clone();
  rimFront.sheenColorMap = rimSheenMap(base, true);

  // front shell: the printed, domed lid face + the plain round-over, wall and rolled seam edge
  const faceGeo = applyDome(mergeGeometries([sweep(base, faceProfile(true), "planar"), capGrid(AI, BI, SX, SY, ZF, 1)]));
  o.add(new THREE.Mesh(faceGeo, lidMaterial(text, lang, fabric)));
  const rim = rimProfile();
  o.add(new THREE.Mesh(sweep(base, rim, "stripR"), rimFront));
  // back shell (same moulding, plain)
  const backFace = mergeGeometries([sweep(base, mirror(faceProfile(false)), "planar"), capGrid(AI, BI, SX, SY, -ZF, -1)]);
  o.add(new THREE.Mesh(backFace, fabric));
  o.add(new THREE.Mesh(sweep(base, mirror(rim), "stripR"), rimFabric));

  // the seam: bound edges, the red zip tape and its chunky moulded teeth
  const binding = P({ color: "#151519", roughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.45 });
  for (const s of [1, -1]) o.add(new THREE.Mesh(sweep(base, beadProfile(R - 0.005, s * (ZS - 0.001), 0.0072), "strip"), binding));
  const tape = M.fabric({ color: "#c8121c", roughness: 0.8, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ff6a6e"), normalMap: weaveNormal(0.0032), normalScale: new THREE.Vector2(0.35, 0.35) });
  o.add(new THREE.Mesh(sweep(base, [{ d: R - 0.0012, z: ZS, n: [1, 0] }, { d: R - 0.0012, z: -ZS, n: [1, 0] }], "strip"), tape));
  // the moulded teeth: a step deeper and more saturated than the tape, tall enough to shade it, no extra coat (no glints)
  o.add(new THREE.Mesh(along(base, R - 0.0085, 0.016, [0.026, 0.0115, 0.044], 0.0065), P({ color: "#a10e16", roughness: 0.45 })));
  // lock-stitch rows holding each shell's fabric to its binding (tone on tone)
  const stitchMat = P({ color: "#45464d", roughness: 0.7 });
  for (const s of [1, -1]) o.add(new THREE.Mesh(along(base, R + 0.0006, 0.034, [0.0034, 0.024, 0.0062], 0, s * (ZS + RR + 0.009)), stitchMat));

  // the slider and its pull at the top-right corner, the handle on top
  o.add(zipPull());
  o.add(handle());

  // the cable
  o.add(cable());
  return o;
}
