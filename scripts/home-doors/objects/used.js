// «المستعمل» — a pre-owned, inspected hybrid handheld: a glass-fronted tablet with two detachable side controllers.
// The name is lit screen content (white on near-black under the glass); a brand-red "inspected" seal sits on a corner.
// Units ≈ 100 mm: tablet 170 × 102 × 14 mm, controllers 36 mm wide, a 16:9 display under one sheet of glass.
import { THREE, M, at, group, extrude, slab, roundedRect, disc, lathe, rbox, microNormal, titleSlab } from "../kit.js";

export const meta = { turn: -0.3, tilt: 0, gap: 0.045, margin: [0.92, 0.86], centerY: 0.06 };

// look-dev knobs: the cover glass (roughness, index of aluminosilicate cover glass, a faint cool tint and the strength of
// its anti-reflective coating: 0.5 ≈ 2 % reflectance head-on, against 4.3 % for bare glass)
const TUNE = { glassR: 0.06, glassIor: 1.52, coat: "#dde3f0", ar: 0.5 };
// The display field, as pre-tone-mapping radiance. core.js tone-maps with NeutralToneMapping, whose toe subtracts
// (x − 6.25x²) from every channel (x = the darkest channel): any dim tinted colour comes out crushed and saturated.
// So the field is nearly neutral and kept above ~0.02, where it reads as a cool blue-black, not navy.
const FIELD = {
  edge: [0.026, 0.0278, 0.0345], // → about sRGB (12,16,28) at the display's edges
  centre: [0.0305, 0.0332, 0.0435], // → about sRGB (15,21,35) behind the name
  glare: [0.644, 0.708, 0.855], // #d2dbee: the key soft box, as a band of glare across the top-left of the glass
  glarePeak: 0.04,
  glareHalf: 0.07, // × SH, half-width at half maximum
  // The upright glass mirrors the lit table in front of it, over the whole screen (the camera looks down 12°, so the
  // mirrored rays reach the table a few units out). Read back from a diagnostic render (DIAG) for bare glass at this
  // pose (turn -0.3, tilt 0): almost even across, a little darker towards the bottom, where the table lies in the
  // object's shade: R(v) = top − drop · v^2.3 (v = 0 at the display's top edge). The coating keeps TUNE.ar of it,
  // and the field gives that much back, so the screen shows the designed blue-black and not a grey sheen.
  refl: { top: [0.0242, 0.0262, 0.0299], drop: [0.0033, 0.0036, 0.0042] },
};

const PI = Math.PI;
// look-dev switch: 1 = flat, known emissions (display 0.1, print 0.2, above the tone map's toe, no name, no seal) to
// read the glass reflection back from a render (FIELD.refl): R = (linear(out) + 0.04) / 0.9 − emission
const DIAG = 0;
const P = (o) => new THREE.MeshPhysicalMaterial(o);
const V2 = (x, y) => new THREE.Vector2(x, y);

// ───────────────────────────── dimensions
const TW = 1.7, TH = 1.02, TD = 0.14; // tablet
const ZG = TD / 2; // the glass front plane
const ZS = ZG - 0.015; // the shell's front face (the glass stands 1.5 mm proud of it)
// cover glass: 1.2 mm inside the shell's lip, a 2 mm rounded 2.5D edge; 4.5 mm deep so the whole bevel is real (kit caps a
// bevel at half the depth) — the depth below the 1.5 mm that stands proud hides inside the shell
const GW = TW - 0.024, GH = TH - 0.024, GR = 0.03, GD = 0.045, GB = 0.02;
const SW = 1.55, SH = 0.872; // the display (16:9)
const CW = 0.36, CD = 0.132; // side controllers
const GAP = 0.007; // the rail gap between tablet and controller
const ZC = ZG - 0.006; // the controllers' face plane
const CR = 0.27, CRI = 0.042; // controller outer / inner corner radii (inner > body bevel, so the bevel never folds)
const CB = 0.034; // controller body bevel: a 3.4 mm roll-off that carries the studio's highlights round the face

// ───────────────────────────── geometry helpers
/**
 * Angle-weighted smooth normals that keep creases sharper than `deg` (fine position hashing, unlike toCreasedNormals).
 * Flat caps facing ±z keep their exact normal: the extrude bevel is tangent to them, and averaging would tilt the
 * cap's rim vertices and smear that tilt across its long triangles.
 */
function creased(geo, deg = 38) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position.array;
  const faces = p.length / 9;
  const fn = new Float32Array(faces * 3);
  const fa = new Float32Array(faces * 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const corner = (o, u, v) => {
    e1.subVectors(u, o).normalize();
    e2.subVectors(v, o).normalize();
    return Math.acos(Math.max(-1, Math.min(1, e1.dot(e2))));
  };
  for (let f = 0; f < faces; f++) {
    a.fromArray(p, f * 9);
    b.fromArray(p, f * 9 + 3);
    c.fromArray(p, f * 9 + 6);
    n.crossVectors(e1.subVectors(c, b), e2.subVectors(a, b));
    const len = n.length();
    if (len > 0) n.divideScalar(len);
    fn.set([n.x, n.y, n.z], f * 3);
    fa[f * 3] = corner(a, b, c);
    fa[f * 3 + 1] = corner(b, c, a);
    fa[f * 3 + 2] = corner(c, a, b);
  }
  const buckets = new Map();
  const key = (i) => `${Math.round(p[i * 3] * 2e5)},${Math.round(p[i * 3 + 1] * 2e5)},${Math.round(p[i * 3 + 2] * 2e5)}`;
  const keys = new Array(faces * 3);
  for (let i = 0; i < faces * 3; i++) {
    const k = (keys[i] = key(i));
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  }
  const cos = Math.cos((deg * PI) / 180);
  const out = new Float32Array(faces * 9);
  for (let i = 0; i < faces * 3; i++) {
    const f = (i / 3) | 0;
    if (Math.abs(fn[f * 3 + 2]) > 0.9995) {
      out[i * 3] = 0;
      out[i * 3 + 1] = 0;
      out[i * 3 + 2] = Math.sign(fn[f * 3 + 2]);
      continue;
    }
    let sx = 0, sy = 0, sz = 0;
    for (const j of buckets.get(keys[i])) {
      const g2 = (j / 3) | 0;
      const d = fn[f * 3] * fn[g2 * 3] + fn[f * 3 + 1] * fn[g2 * 3 + 1] + fn[f * 3 + 2] * fn[g2 * 3 + 2];
      if (d < cos) continue;
      const w = fa[j];
      sx += fn[g2 * 3] * w;
      sy += fn[g2 * 3 + 1] * w;
      sz += fn[g2 * 3 + 2] * w;
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    out[i * 3] = sx / l;
    out[i * 3 + 1] = sy / l;
    out[i * 3 + 2] = sz / l;
  }
  g.setAttribute("normal", new THREE.BufferAttribute(out, 3));
  return g;
}
const soft = (m, deg) => ((m.geometry = creased(m.geometry, deg)), m);
/** An extrude (kit) with smooth bevels. */
const sx = (shape, depth, bevel, mat, opts) => soft(extrude(shape, depth, bevel, mat, { bevelSegments: 8, ...opts }));
const sslab = (w, h, d, r, mat, bevel, segs = 8) => soft(slab(w, h, d, r, mat, bevel, { bevelSegments: segs }));

function arc(cx, cy, r, a0, a1, n) {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}
/** Rounds the corners of a polyline (open: ends kept; closed: wraps) with radius r, n segments per fillet. */
function fillet(pts, r, n = 6, closed = false) {
  const out = [];
  const N = pts.length;
  for (let i = 0; i < N; i++) {
    const isEnd = !closed && (i === 0 || i === N - 1);
    const rad = Array.isArray(r) ? r[i] : r;
    if (isEnd || !rad) {
      out.push(pts[i]);
      continue;
    }
    const [px, py] = pts[(i - 1 + N) % N], [cx, cy] = pts[i], [nx, ny] = pts[(i + 1) % N];
    let ux = px - cx, uy = py - cy;
    const lu = Math.hypot(ux, uy);
    let vx = nx - cx, vy = ny - cy;
    const lv = Math.hypot(vx, vy);
    ux /= lu; uy /= lu; vx /= lv; vy /= lv;
    const th = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
    if (th > PI - 0.02) {
      out.push(pts[i]);
      continue;
    }
    const t = Math.min(rad / Math.tan(th / 2), lu * 0.5, lv * 0.5);
    const rr = t * Math.tan(th / 2);
    let bx = ux + vx, by = uy + vy;
    const lb = Math.hypot(bx, by);
    bx /= lb; by /= lb;
    const d = rr / Math.sin(th / 2);
    const ox = cx + bx * d, oy = cy + by * d;
    const a0 = Math.atan2(cy + uy * t - oy, cx + ux * t - ox);
    let da = Math.atan2(cy + vy * t - oy, cx + vx * t - ox) - a0;
    while (da > PI) da -= 2 * PI;
    while (da < -PI) da += 2 * PI;
    for (let k = 0; k <= n; k++) out.push([ox + rr * Math.cos(a0 + (da * k) / n), oy + rr * Math.sin(a0 + (da * k) / n)]);
  }
  return out;
}
const shapeOf = (pts, s = 1) => new THREE.Shape(pts.map(([x, y]) => V2(s * x, y)));
/** A turned part, its axis towards the camera: profile [[r, z]…] from the axis at the back round to the axis at the front. */
function turned(profile, mat, segments = 72) {
  return lathe(profile, mat, { segments, facing: "z" });
}
/** A canvas texture whose u/v cover the face [-w/2, w/2] × [-h/2, h/2] (extrude caps carry their own x/y as UVs). */
function faceTexture(canvas, w, h, colorSpace = THREE.NoColorSpace) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = colorSpace;
  t.anisotropy = 8;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.set(1 / w, 1 / h);
  t.offset.set(0.5, 0.5);
  t.updateMatrix();
  return t;
}

// ───────────────────────────── materials
const MAT = {
  // the frame: dark anodised metal, satin, so its rounded edges carry the studio's lights round the glass
  shell: () => P({ color: "#2b2e34", metalness: 0.75, roughness: 0.3 }),
  // the black print under the cover glass; the glass reflection is the base specular lobe itself (sampled on half the
  // paths, so far less grain than a clearcoat lobe, which the tracer picks on only ~4% of them)
  bezel: () => P({ color: "#030304", roughness: TUNE.glassR, ior: TUNE.glassIor, specularColor: new THREE.Color(TUNE.coat), specularIntensity: TUNE.ar }),
  glassEdge: () => P({ color: "#08090b", roughness: 0.03, ior: 1.7 }),
  // moulded satin plastic: its grain is far below a pixel here, so the finish is carried by roughness alone — low
  // enough that the rounded ends and the bevel roll the soft boxes round the shell
  ctrl: () => P({ color: "#666a72", roughness: 0.24 }),
  button: () => P({ color: "#16171a", roughness: 0.24 }),
  shoulder: () => P({ color: "#26282d", roughness: 0.34 }),
  accent: () => M.red({ roughness: 0.26, clearcoat: 0 }),
  hole: () => P({ color: "#050506", roughness: 0.75 }),
  keys: () => P({ color: "#2a2b30", roughness: 0.34 }),
  boot: () => P({ color: "#131417", roughness: 0.62 }),
  stick: () => M.rubber({ color: "#4d5057", roughness: 0.52, normalMap: microNormal("rubber", 10), normalScale: V2(0.15, 0.15) }),
  stickRim: () => P({ color: "#34363c", roughness: 0.28, normalMap: microNormal("rubber", 10), normalScale: V2(0.25, 0.25) }),
};

// ───────────────────────────── the display field: a cool blue-black backlit wallpaper with a soft lift behind the
// name, and a band of glare across the top-left (the flat glass cannot mirror a soft box within the allowed tilt, so
// the glass carries it). 8-bit textures are stored linear: each field is kept at full range in its texture and
// scaled down by the emissive intensity, so the darks do not band.
/**
 * The glare band at (x, y) on the glass (centred, y up): a soft band whose centre line runs from the display's top
 * edge at 45 % of its width to its left edge at 70 % of its height. The display and the black print round it carry
 * the same band, so it runs on across the bezel to the glass edge, as a reflection on the glass would.
 */
function glare(x, y) {
  const ax = -SW / 2 + 0.45 * SW, ay = SH / 2;
  const bx = -SW / 2, by = SH / 2 - 0.7 * SH;
  let nx = ay - by, ny = bx - ax; // a normal of A→B…
  const l = Math.hypot(nx, ny);
  nx /= l;
  ny /= l;
  if (-ax * nx - ay * ny < 0) (nx = -nx), (ny = -ny); // …pointing into the display
  const d = (x - ax) * nx + (y - ay) * ny;
  return FIELD.glarePeak * Math.exp(-Math.LN2 * (d / (FIELD.glareHalf * SH)) ** 2);
}
/** A linear float RGB field (w×h texels) → an 8-bit canvas at full range, its texture and the intensity that restores it. */
function fieldTexture(f, W, H, fw, fh) {
  let peak = 0;
  for (const v of f) peak = Math.max(peak, v);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const img = g.createImageData(W, H);
  for (let i = 0; i < W * H; i++) {
    for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = Math.round((255 * f[i * 3 + ch]) / peak);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { map: faceTexture(c, fw, fh), intensity: peak };
}
/** The black print's share of the glare (the glass face, GW × GH). */
function bezelGlare() {
  const W = 768, H = Math.round((768 * GH) / GW);
  if (DIAG) return fieldTexture(new Float32Array(W * H * 3).fill(0.2), W, H, GW, GH);
  const f = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const gl = glare(((x + 0.5) / W - 0.5) * GW, (0.5 - (y + 0.5) / H) * GH);
      for (let ch = 0; ch < 3; ch++) f[(y * W + x) * 3 + ch] = gl * FIELD.glare[ch];
    }
  return fieldTexture(f, W, H, GW, GH);
}
function displayField() {
  const W = 1024, H = 576;
  if (DIAG) return fieldTexture(new Float32Array(W * H * 3).fill(0.1), W, H, SW, SH);
  const { top, drop } = FIELD.refl;
  const f = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const U = (x + 0.5) / W, V = (y + 0.5) / H; // 0…1 from the top-left corner
      const u = U - 0.5, v = V - 0.46;
      const k = Math.exp(-2.2 * ((u / 0.52) ** 2 + (v / 0.62) ** 2));
      const gl = glare(u * SW, (0.5 - V) * SH);
      const vr = V ** 2.3;
      for (let ch = 0; ch < 3; ch++) {
        const val = FIELD.edge[ch] + (FIELD.centre[ch] - FIELD.edge[ch]) * k + gl * FIELD.glare[ch] - TUNE.ar * (top[ch] - drop[ch] * vr);
        f[(y * W + x) * 3 + ch] = Math.max(0, val);
      }
    }
  return fieldTexture(f, W, H, SW, SH);
}
/**
 * The backlit field's mask: clear where the name's ink is, so the lit letters underneath show through. It is the
 * printed title's own colour texture (white ink on black), inverted — no text is drawn here.
 */
function inkHoles(titleMap) {
  const src = titleMap.image;
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.globalCompositeOperation = "difference";
  g.drawImage(src, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 16;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.repeat.copy(titleMap.repeat);
  t.offset.copy(titleMap.offset);
  t.updateMatrix();
  return t;
}

// ───────────────────────────── the inspected seal: a brand-red rosette with a white tick under a clear resin dome
const SEAL_LOBES = 20;
const sealR = (R, a) => R * (0.955 + 0.045 * Math.cos(SEAL_LOBES * a));
function sealTexture(R) {
  const size = 1024;
  const cx = size / 2;
  const k = size / 2 / R; // px per unit
  const rosette = (g, rad) => {
    g.beginPath();
    for (let i = 0; i <= 720; i++) {
      const a = (i / 720) * PI * 2;
      const rr = rad * (0.955 + 0.045 * Math.cos(SEAL_LOBES * a));
      const x = cx + rr * Math.cos(a), y = cx - rr * Math.sin(a);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
  };
  const tick = (g, w) => {
    g.lineWidth = w;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(cx - 0.38 * R * k, cx + 0.02 * R * k);
    g.lineTo(cx - 0.11 * R * k, cx + 0.29 * R * k);
    g.lineTo(cx + 0.4 * R * k, cx - 0.28 * R * k);
    g.stroke();
  };
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#f4f4f2"; // the die-cut white margin
  g.fillRect(0, 0, size, size);
  rosette(g, R * k * 0.955);
  const grad = g.createRadialGradient(cx - 0.25 * R * k, cx - 0.3 * R * k, 0, cx, cx, R * k);
  grad.addColorStop(0, "#e2262f"); // TamTam red #d3121b, lit from the key side
  grad.addColorStop(1, "#ad0d15");
  g.fillStyle = grad;
  g.fill();
  // fine guilloché rings in the outer band
  g.strokeStyle = "rgba(255,255,255,0.12)";
  g.lineWidth = 2;
  for (let r = 0.845; r < 0.93; r += 0.022) {
    g.beginPath();
    g.arc(cx, cx, r * R * k, 0, PI * 2);
    g.stroke();
  }
  // a thin white ring well outside the tick, and a bold tick that still reads at the home row's 1× size
  g.strokeStyle = "#ffffff";
  g.lineWidth = 0.028 * R * k;
  g.beginPath();
  g.arc(cx, cx, 0.8 * R * k, 0, PI * 2);
  g.stroke();
  g.strokeStyle = "rgba(70,0,6,0.35)";
  g.save();
  g.translate(0.015 * R * k, 0.025 * R * k);
  tick(g, 0.26 * R * k);
  g.restore();
  g.strokeStyle = "#ffffff";
  tick(g, 0.24 * R * k);
  return faceTexture(c, 2 * R, 2 * R, THREE.SRGBColorSpace);
}
/**
 * The seal: a thin die-cut rosette sticker (0.15 mm, its lobed edge eased down) with a clear resin lens domed over its
 * middle — a round crown and a meniscus that rolls down to the lens edge, so the key light draws one clean arc on it.
 * One mesh, planar UVs for the print.
 */
function sealDome(R, Hd = 0.012, w = 0.022) {
  const segs = 480, inRings = 34, outRings = 8;
  const Rd = 0.84 * R; // the lens covers the tick and the white ring
  const h0 = 0.0015;
  const lens = (r) => (r >= Rd ? 0 : Hd * (1 - (1 - Math.min(1, (Rd - r) / w)) ** 2.4) * (1 - 0.45 * (r / Rd) ** 2));
  const sticker = (r, a) => h0 * Math.min(1, Math.max(0, (sealR(R, a) - r) / 0.004));
  const height = (r, a) => sticker(r, a) + lens(r);
  const pos = [0, 0, height(0, 0)], uv = [0, 0], idx = [];
  const rings = inRings + outRings;
  for (let i = 1; i <= rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * PI * 2;
      // round rings over the lens (crowding at its edge, where it bends), then rings easing out to the lobed edge
      const rr = i <= inRings ? Rd * (1 - (1 - i / inRings) ** 1.9) : Rd + (sealR(R, a) - Rd) * (1 - (1 - (i - inRings) / outRings) ** 1.6);
      const x = rr * Math.cos(a), y = rr * Math.sin(a);
      pos.push(x, y, height(rr, a));
      uv.push(x, y);
    }
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + j, 1 + ((j + 1) % segs));
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * segs, a1 = 1 + i * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      idx.push(a0 + j, a1 + j, a1 + j1, a0 + j, a1 + j1, a0 + j1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = P({ map: sealTexture(R), roughness: 0.06 });
  return new THREE.Mesh(geo, mat);
}

// ───────────────────────────── controller parts
function stick() {
  const opening = disc(0.089, 0.004, MAT.hole());
  const boot = turned([[0, -0.004], [0.079, -0.004], ...arc(0, 0, 1, 0, PI / 2, 16).map(([c, s]) => [0.079 * c, 0.026 * s])], MAT.boot());
  const stem = at(disc(0.021, 0.034, MAT.boot()), 0, 0, 0.034); // ends under the cap (its dish dips to 6.3 mm)
  // the cap: a flared skirt and a rolled rim (a satin ring), round a soft-touch dish ~2 mm deep that the key light shades
  const rimZ = 0.0835, dishR = 0.058, sag = 0.021;
  const Rs = (dishR * dishR + sag * sag) / (2 * sag);
  const skirt = turned(
    fillet(
      [[0, 0.05], [0.05, 0.05], [0.0645, 0.0565], [0.0682, 0.0655], [0.0692, 0.0785], [0.0668, 0.0858], [0.0612, 0.0874], [dishR, rimZ]],
      [0, 0, 0.003, 0.004, 0.004, 0.0035, 0.0025, 0],
      6,
    ),
    MAT.stickRim(),
    96,
  );
  const dishPts = [];
  for (let i = 0; i <= 20; i++) {
    const r = dishR * (1 - i / 20);
    dishPts.push([r, rimZ - sag + Rs - Math.sqrt(Rs * Rs - r * r)]);
  }
  const dish = turned(dishPts, MAT.stick(), 96);
  return group(opening, boot, stem, skirt, dish);
}
function faceButton(r = 0.034, mat = MAT.button()) {
  const gap = disc(r + 0.0065, 0.003, MAT.hole());
  const cap = turned(fillet([[0, -0.004], [r, -0.004], [r, 0.011], [r * 0.72, 0.0165], [0, 0.0175]], [0, 0, 0.004, 0.012, 0], 6), mat, 72);
  return group(gap, cap);
}
function crossShape(a, L, ro, ri) {
  const h = a / 2;
  const pts = [[h, -L], [h, -h], [L, -h], [L, h], [h, h], [h, L], [-h, L], [-h, h], [-L, h], [-L, -h], [-h, -h], [-h, -L]];
  const radii = pts.map(([x, y]) => (Math.abs(x) === L || Math.abs(y) === L ? ro : ri));
  return shapeOf(fillet(pts, radii, 6, true));
}
/** A tangent-space normal map of a shallow round dimple (concave dish of radius rd) in the middle of a w×w face. */
function dimpleNormal(w, rd, depth) {
  const N = 256;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d");
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const px = ((x + 0.5) / N - 0.5) * w, py = (0.5 - (y + 0.5) / N) * w;
      const r = Math.hypot(px, py);
      // z = -depth (1 - r²/rd²) inside, eased at the rim so the edge is soft
      let dzdr = 0;
      if (r < rd) dzdr = ((2 * depth * r) / (rd * rd)) * Math.min(1, (rd - r) / (0.25 * rd) + 0.15);
      const nx = r > 0 ? (-dzdr * px) / r : 0, ny = r > 0 ? (-dzdr * py) / r : 0;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * N + x) * 4;
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return faceTexture(c, w, w);
}
function dpad() {
  const L = 0.116;
  const gap = sx(crossShape(0.084, 0.123, 0.018, 0.01), 0.003, 0, MAT.hole());
  const top = MAT.button();
  top.normalMap = dimpleNormal(2 * L, 0.024, 0.0022);
  top.normalScale = V2(1, 1);
  const pad = sx(crossShape(0.07, L, 0.014, 0.008), 0.03, 0.009, [top, MAT.button()]);
  return group(gap, at(pad, 0, 0, 0.009));
}
function roundedKey(w, h, r, gapW = 0.006) {
  const box = (ww, hh, rr) => shapeOf(fillet([[-ww / 2, -hh / 2], [ww / 2, -hh / 2], [ww / 2, hh / 2], [-ww / 2, hh / 2]], rr, 8, true));
  const gap = sx(box(w + 2 * gapW, h + 2 * gapW, r + gapW), 0.003, 0, MAT.hole());
  const b = sx(box(w, h, r), 0.016, 0.005, MAT.button());
  return group(gap, at(b, 0, 0, 0.004));
}
const smallPill = (w, h) => roundedKey(w, h, h / 2 - 0.0005);
function homeButton() {
  const b = faceButton(0.03);
  const ring = at(new THREE.Mesh(new THREE.TorusGeometry(0.0425, 0.0045, 20, 120), MAT.accent()), 0, 0, 0.0012);
  return group(b, ring);
}

/** The outline of a side controller (right side; mirrored by shapeOf's s), grown by e. */
function ctrlPts(e = 0) {
  const xi = TW / 2 + GAP, xo = xi + CW, h = TH / 2;
  return [
    ...arc(xi + CRI, -h + CRI, CRI + e, PI, 1.5 * PI, 10),
    ...arc(xo - CR, -h + CR, CR + e, 1.5 * PI, 2 * PI, 56),
    ...arc(xo - CR, h - CR, CR + e, 0, 0.5 * PI, 56),
    ...arc(xi + CRI, h - CRI, CRI + e, 0.5 * PI, PI, 10),
  ];
}
/**
 * A band hugging the top-outer corner (shoulder button / trigger): from the inner offset d0 (buried in the body) to an
 * outer offset d1 above the body's outline; both ends rise out of the body over `ramp` (absolute length) with a
 * quarter-round profile, so they read as the rounded ends of a separate part.
 */
function bandShape(s, d0, d1, xStart, aEnd, ramp = 0.03) {
  const xi = TW / 2 + GAP, xo = xi + CW, h = TH / 2;
  const cx = xo - CR, cy = h - CR;
  const path = [];
  for (let i = 0; i <= 10; i++) path.push([xi + xStart + ((cx - xi - xStart) * i) / 10, h, 0, 1]);
  for (let i = 1; i <= 72; i++) {
    const a = PI / 2 + ((aEnd - PI / 2) * i) / 72;
    path.push([cx + CR * Math.cos(a), cy + CR * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  const L = [0];
  for (let i = 1; i < path.length; i++) L.push(L[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = L[L.length - 1];
  const rise = (t) => {
    const u = Math.min(1, Math.max(0, t / ramp));
    return Math.sqrt(1 - (1 - u) * (1 - u));
  };
  const outer = [], inner = [];
  path.forEach(([x, y, nx, ny], i) => {
    const k = rise(L[i]) * rise(total - L[i]);
    const dOut = -0.006 + (d1 + 0.006) * k;
    outer.push([x + nx * dOut, y + ny * dOut]);
    inner.push([x + nx * d0, y + ny * d0]);
  });
  return shapeOf([...outer, ...inner.reverse()], s);
}

function controller(s) {
  const o = new THREE.Group();
  const xi = TW / 2 + GAP;
  const X = (x) => s * (xi + x); // x measured from the inner edge, outwards
  const body = sx(shapeOf(ctrlPts(0), s), CD, CB, MAT.ctrl(), { bevelSegments: 12 });
  o.add(at(body, 0, 0, ZC - CD / 2));
  // the shell seam (front and back halves meet a little behind the middle)
  const seamShape = shapeOf(ctrlPts(0.0007), s);
  seamShape.holes.push(new THREE.Path(ctrlPts(-0.004).map(([x, y]) => V2(s * x, y))));
  o.add(at(sx(seamShape, 0.004, 0, MAT.hole()), 0, 0, ZC - CD / 2 - 0.012));
  // shoulder button (red, in front), its parting shadow, and the trigger behind it
  const zL = ZC - 0.021 - 0.023;
  o.add(at(sx(bandShape(s, -0.03, 0.027, 0.05, 0.6, 0.032), 0.046, 0.009, MAT.accent(), { bevelSegments: 8 }), 0, 0, zL));
  o.add(at(sx(bandShape(s, -0.03, 0.031, 0.045, 0.57, 0.034), 0.046, 0.008, MAT.hole()), 0, 0, zL - 0.006));
  o.add(at(sx(bandShape(s, -0.03, 0.04, 0.075, 0.5, 0.04), 0.042, 0.01, MAT.shoulder(), { bevelSegments: 8 }), 0, 0, ZC - 0.1));
  // the face: sticks, buttons
  const z = ZC;
  const cxm = 0.172; // the face's centre line
  if (s < 0) {
    o.add(at(stick(), X(cxm), 0.215, z));
    o.add(at(dpad(), X(cxm), -0.115, z));
    o.add(at(smallPill(0.056, 0.02), X(0.085), 0.43, z));
    o.add(at(roundedKey(0.046, 0.046, 0.011), X(0.2), -0.34, z));
  } else {
    for (const [dx, dy] of [[0, 0.083], [0, -0.083], [0.083, 0], [-0.083, 0]]) o.add(at(faceButton(), X(cxm) + dx, 0.215 + dy, z));
    o.add(at(stick(), X(cxm), -0.115, z));
    o.add(at(smallPill(0.056, 0.02), X(0.085), 0.43, z));
    o.add(at(homeButton(), X(0.15), -0.34, z));
  }
  // the rail in the gap
  o.add(at(new THREE.Mesh(new THREE.BoxGeometry(GAP + 0.004, TH - 0.08, CD - 0.03), MAT.hole()), s * (TW / 2 + GAP / 2), 0, ZC - CD / 2));
  return o;
}

// ───────────────────────────── the tablet
function tablet(text, lang) {
  const o = new THREE.Group();
  // the shell: back and sides, its front a 1.2 mm lip round the glass
  o.add(at(sslab(TW, TH, ZS + TD / 2, 0.04, MAT.shell(), 0.0115, 10), 0, 0, (ZS - TD / 2) / 2));
  // the cover glass: one sheet, printed black round the display, its 2.5D edge rounded so it catches the lights
  const print = MAT.bezel();
  const band = bezelGlare();
  Object.assign(print, { emissive: new THREE.Color("#ffffff"), emissiveMap: band.map, emissiveIntensity: band.intensity });
  const glass = sx(roundedRect(GW, GH, GR), GD, GB, [print, MAT.glassEdge()], { bevelSegments: 16 });
  o.add(at(glass, 0, 0, ZG - GD / 2));
  // the display, two glossy layers that stand in for the glass over it: on top the dark backlit field with the
  // name's letters cut out of it, and just under it the name itself as lit pixels. Most camera paths hit the top
  // layer directly (every skipped surface costs the tracer a bounce of depth, and so reflection quality); their
  // 0.00037-unit gap stays wider than the ~0.0002 units the tracer steps past a skipped surface.
  // the name's size, matched across the row: the main line of letters (Latin x-height, Arabic body) at about 8–12 % of
  // the tile height. All three names are bound by width, so fitW sets the size: «المستعمل» and «بەکارهاتوو» fill
  // 90 % of the display (≈ 8 %); the short "Used" is held to 44.5 % so its full height (cap U to the d's ascender)
  // measures ≈ 11.6 % of the frame (it was 17 % at 67 %), in line with Headsets / Accessories.
  const fit = lang === "en" ? { fitW: 0.445, fitH: 0.56 } : lang === "ckb" ? { fitW: 0.9, fitH: 0.5 } : { fitW: 0.9, fitH: 0.54 };
  const base = P({ color: "#000000", roughness: TUNE.glassR, ior: TUNE.glassIor, specularColor: new THREE.Color(TUNE.coat), specularIntensity: TUNE.ar });
  const screen = titleSlab(text, lang, SW, SH, 0.0001, 0.012, base, { relief: 0, weight: 800, faceRoughness: TUNE.glassR, inkRoughness: TUNE.glassR, ...fit }, 0);
  const cap = screen.material[0];
  cap.color = new THREE.Color("#000000"); // the lit pixels emit; no paint to light
  cap.emissive = new THREE.Color("#ffffff");
  cap.emissiveMap = cap.map;
  cap.emissiveIntensity = 1.4;
  o.add(at(screen, 0, 0, ZG + 0.00015 - 0.00005));
  const field = displayField();
  const glowMat = P({ color: "#040508", roughness: TUNE.glassR, ior: TUNE.glassIor, specularColor: new THREE.Color(TUNE.coat), specularIntensity: TUNE.ar, emissive: new THREE.Color("#ffffff"), emissiveMap: field.map, emissiveIntensity: field.intensity });
  if (!DIAG) glowMat.alphaMap = inkHoles(cap.map);
  glowMat.alphaTest = 0.5; // the 50 % coverage contour of the letters
  o.add(at(slab(SW, SH, 0.00008, 0.012, glowMat, 0), 0, 0, ZG + 0.0006 - 0.00004));
  // the top edge: power and volume keys, the vent, the card-slot flap, the audio jack
  const yTop = TH / 2;
  const zTop = -0.006;
  const key = (x, len) => at(sslab(len, 0.02, 0.014, 0.0095, MAT.keys(), 0.004), x, yTop + 0.002, zTop + 0.004);
  for (const [x, len] of [[-0.6, 0.075], [-0.48, 0.055], [-0.405, 0.055]]) {
    const k = key(x, len);
    k.rotation.x = -PI / 2;
    o.add(k);
  }
  const vent = sslab(0.46, 0.026, 0.002, 0.012, MAT.hole(), 0);
  vent.rotation.x = -PI / 2;
  o.add(at(vent, 0.12, yTop + 0.0004, zTop));
  for (let i = 0; i < 26; i++) {
    const slat = rbox(0.0065, 0.004, 0.025, 0.0015, MAT.shell(), 2);
    o.add(at(slat, 0.12 - 0.215 + (i * 0.43) / 25, yTop + 0.0008, zTop));
  }
  const flap = sslab(0.2, 0.03, 0.003, 0.012, MAT.hole(), 0);
  flap.rotation.x = -PI / 2;
  o.add(at(flap, 0.56, yTop + 0.0008, zTop));
  const lid = sslab(0.192, 0.024, 0.004, 0.009, MAT.shell(), 0.0015);
  lid.rotation.x = -PI / 2;
  o.add(at(lid, 0.56, yTop + 0.0012, zTop));
  const jack = disc(0.011, 0.004, MAT.hole());
  jack.rotation.x = 0; // its axis upright: a round hole in the top edge
  o.add(at(jack, 0.74, yTop - 0.0012, zTop));
  // the inspected seal on the top-right corner of the cover glass, part on the black print, part over the display;
  // pushed as far into the corner as the flat glass allows (its lobes stop 0.1 mm short of the 2.5D edge)
  const R = 0.1;
  if (!DIAG) o.add(at(sealDome(R), GW / 2 - GB - R - 0.001, GH / 2 - GB - R - 0.001, ZG + 0.00065));
  return o;
}

export function build({ text, lang }) {
  return group(tablet(text, lang), controller(-1), controller(1));
}
