// «الصيانة» — a technician's steel toolbox, path traced.
// Body: gunmetal powder coat on folded sheet steel (tight corners, a folded foot flange, pressed end panels).
// Lid: a hemmed skirt, a hip chamfer and a flat deck with two rubber-lined tool wells (rolled lips), each holding a
// charcoal foam insert.
// Two red draw latches (pressed levers bowed out below and curving back above so their upper half catches the key
// light, side flanges, a pressed rib, a hinge barrel, a wire loop rolled into a knuckle, a riveted keeper) and a red
// grip on a steel bail in riveted U-brackets.
// The name is printed on a glossy black badge under an epoxy dome (its edges roll off and catch the key light) in a
// riveted satin-steel bezel; the badge leaves a wide band of grey paint round it, so the front reads as a toolbox, not
// a sign.
// Rising from the wells, one tool each: a screwdriver (fluted red handle, satin ferrule, ground flat blade) and a
// polished-chrome I-beam combination wrench whose crowned jaw sweeps the studio's dark sky and key light.
import { THREE, M, at, group, extrude, slab, rbox, lathe, microNormal, titleMaterial } from "../kit.js";

export const meta = { turn: -0.3, tilt: 0.03, gap: 0.05, margin: [0.92, 0.86], centerY: 0.04 };

// ───────────────────────────── dimensions (1 unit ≈ 20 cm)
const W = 2.6; // box width (x)
const D = 0.94; // box depth (z)
const R = 0.024; // vertical corner radius of the folded box
const BODY = 0.84; // body height
const LID = 0.2; // lid height
const SEAM = 0.004; // gap between body and lid
const LAP = 0.006; // the lid's skirt stands out from the body by this much
const TOP = BODY + SEAM + LID; // top deck height
const TRAY = { x: 0.78, w: 0.58, d: 0.55, r: 0.05, depth: 0.185 };
const FRONT = D / 2;
// the badge: a wide band of grey paint round it; centred a little above the body's middle (its optical centre, level
// with the latches' levers)
const PLATE = { w: 1.5, h: 0.46, rim: 0.028, cy: 0.46, dome: 0.016 };
const FOAM = 0.06; // the foam insert's top, below the well's lip (0: no insert)
const LATCH_X = 1.14;
const TOOL = 0.95; // the tools' scale
// the screwdriver's foot in the left well; its lean and backward tilt make it lean out about as far as the wrench does
// in the picture (the turn shows a backward tilt as a lean to the right)
const SCREW = { x: -0.84, z: 0.0, lean: 0.22, back: -0.08 };
// the name's fit on the plate, per language. Arabic and English at the row's common size (their main line of letters
// about 12% of the tile's height), with black space round them; Sorani is long, so it is limited by the badge's width
// (a heavier weight: at that width a lighter one is no taller).
// (printedTitle starts at 1.3·fitH·h and steps the size down by 3% until the advance fits fitW: so fitH also picks the
// size ladder. On the 2048×620 face: ar 416 px, en 468, ckb 260 — each just under its width limit.)
const FIT = { ar: { fitW: 0.8, fitH: 0.566 }, en: { fitW: 0.8, fitH: 0.678 }, ckb: { fitW: 0.66, fitH: 0.669, weight: 900 } };
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ───────────────────────────── materials
/** Powder coat: a mostly dielectric paint with some metallic flake, a satin clear coat with a fine orange peel. */
const powder = () =>
  new THREE.MeshPhysicalMaterial({
    color: "#5a5f68",
    metalness: 0.28,
    roughness: 0.5,
    clearcoat: 0.5,
    clearcoatRoughness: 0.24,
    clearcoatNormalMap: microNormal("rubber", 2),
    clearcoatNormalScale: new THREE.Vector2(0.12, 0.12),
  });
// (glossy paints carry their gloss in the base specular lobe: the tracer samples a clear coat in only ~4% of bounces,
// which leaves its reflections of the key light grainy even at 640 samples)
const redCoat = () => M.red({ roughness: 0.18, clearcoat: 0 });
/** Custom lofts are traced from both sides (their winding does not matter). */
const two = (m) => ((m.side = THREE.DoubleSide), m);

// ───────────────────────────── helpers
/** A rounded rectangle centred on (cx, cy). */
function rr(cx, cy, w, h, r, Kind = THREE.Path) {
  r = Math.max(0.0005, Math.min(r, w / 2 - 0.0005, h / 2 - 0.0005));
  const s = new Kind();
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  s.moveTo(x0 + r, y0);
  s.lineTo(x1 - r, y0);
  s.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x1, y1 - r);
  s.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
  s.lineTo(x0 + r, y1);
  s.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x0, y0 + r);
  s.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}
const clamp01 = (t) => Math.min(1, Math.max(0, t));
/** A revolved surface round +y with `lobes` flutes: profile [[r, y]…] bottom to top; env(y) ∈ [0,1] scales the flutes. */
function fluted(profile, mat, { lobes = 6, depth = 0.1, seg = 144, env = () => 1 } = {}) {
  const pos = [];
  const uv = [];
  const idx = [];
  const rows = profile.length;
  for (let i = 0; i < rows; i++) {
    const [r, y] = profile[i];
    const e = env(y);
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const g = 0.5 + 0.5 * Math.cos(th * lobes); // 1 on a lobe, 0 in a groove
      const rr_ = r * (1 - depth * e * Math.pow(1 - g, 1.6));
      pos.push(rr_ * Math.sin(th), y, rr_ * Math.cos(th));
      uv.push(j / seg, i / (rows - 1));
    }
  }
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1, c = a + seg + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // weld the seam's normals
  const n = geo.attributes.normal;
  for (let i = 0; i < rows; i++) {
    const a = i * (seg + 1), b = a + seg;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l);
    n.setXYZ(b, x / l, y / l, z / l);
  }
  return new THREE.Mesh(geo, mat);
}
/** Densifies a profile [[r, y]…] by linear interpolation so the flutes bend smoothly. */
function densify(profile, n = 6) {
  const out = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0] = profile[i], [r1, y1] = profile[i + 1];
    for (let k = 0; k < n; k++) out.push([r0 + ((r1 - r0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  out.push(profile[profile.length - 1]);
  return out;
}
/** A tube along straight runs with rounded corners: pts [[x,y,z]…], corner radii rcs (one per inner point). */
function bentRod(pts, rcs, radius, mat) {
  const path = new THREE.CurvePath();
  const V = pts.map((p) => new THREE.Vector3(...p));
  let start = V[0].clone();
  for (let i = 1; i < V.length - 1; i++) {
    const rc = Array.isArray(rcs) ? rcs[i - 1] : rcs;
    const a = V[i - 1], b = V[i], c = V[i + 1];
    const inDir = b.clone().sub(a).normalize();
    const outDir = c.clone().sub(b).normalize();
    const p0 = b.clone().addScaledVector(inDir, -rc);
    const p1 = b.clone().addScaledVector(outDir, rc);
    path.add(new THREE.LineCurve3(start, p0));
    path.add(new THREE.QuadraticBezierCurve3(p0, b.clone(), p1));
    start = p1;
  }
  path.add(new THREE.LineCurve3(start, V[V.length - 1].clone()));
  const g = group(new THREE.Mesh(new THREE.TubeGeometry(path, 160, radius, 20, false), mat));
  for (const e of [V[0], V[V.length - 1]]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 12), mat);
    cap.position.copy(e);
    g.add(cap);
  }
  return g;
}
function rivet(r, mat) {
  // a domed head, axis to the camera
  return lathe([[0, 0.0], [r, 0.0], [r * 0.98, r * 0.18], [r * 0.8, r * 0.42], [r * 0.45, r * 0.56], [0, r * 0.6]], mat, { segments: 40, facing: "z" });
}
/**
 * Lofts closed cross-sections: rows [{ c, x, z, a, b, p }] — a superellipse |u/a|^p + |v/b|^p = 1 in the row's
 * x/z frame (unit vectors, default world x and z) centred on c; seg points per ring; both ends capped flat.
 */
function sectionLoft(rows, mat, seg = 48) {
  const pos = [];
  const idx = [];
  const X = V3(1, 0, 0), Z = V3(0, 0, 1);
  const ring = (row) => {
    const s = pos.length / 3;
    const ax = row.x ?? X, az = row.z ?? Z, e = 2 / (row.p ?? 2);
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      const u = row.a * Math.sign(c) * Math.abs(c) ** e;
      const v = row.b * Math.sign(sn) * Math.abs(sn) ** e;
      pos.push(row.c.x + ax.x * u + az.x * v, row.c.y + ax.y * u + az.y * v, row.c.z + ax.z * u + az.z * v);
    }
    return s;
  };
  const starts = rows.map(ring);
  for (let k = 0; k < rows.length - 1; k++) {
    const a = starts[k], b = starts[k + 1];
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      idx.push(a + j, a + j1, b + j1, a + j, b + j1, b + j);
    }
  }
  for (const [k, dir] of [[0, -1], [rows.length - 1, 1]]) {
    const s = ring(rows[k]);
    const ci = pos.length / 3;
    pos.push(rows[k].c.x, rows[k].c.y, rows[k].c.z);
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      if (dir > 0) idx.push(ci, s + j, s + j1);
      else idx.push(ci, s + j1, s + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
// ───────────────────────────── sheet-metal lofts: a rounded-rectangle outline swept along a filleted profile
/** Rounds the inner corners of a 2D polyline [[a, b]…] with radius rs (one per inner vertex), k steps each. */
function filletLine(pts, rs, k = 7) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const r = Array.isArray(rs) ? rs[i - 1] : rs;
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
    const r1 = Math.min(r, l1 / 2), r2 = Math.min(r, l2 / 2);
    const p0 = [bx - ((bx - ax) / l1) * r1, by - ((by - ay) / l1) * r1];
    const p1 = [bx + ((cx - bx) / l2) * r2, by + ((cy - by) / l2) * r2];
    for (let j = 0; j <= k; j++) {
      const t = j / k;
      out.push([(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * bx + t * t * p1[0], (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * by + t * t * p1[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
/** A rounded rectangle w×d (corner r ≥ rmin) round (cx, cy), n+1 points per corner, counter-clockwise. */
function rrRing(cx, cy, w, d, r, n, rmin = 0.012) {
  const hw = w / 2, hd = d / 2;
  r = Math.max(rmin, Math.min(r, hw - 0.001, hd - 0.001));
  const pts = [];
  for (const [ox, oy, a0] of [[hw - r, -hd + r, -Math.PI / 2], [hw - r, hd - r, 0], [-hw + r, hd - r, Math.PI / 2], [-hw + r, -hd + r, Math.PI]])
    for (let i = 0; i <= n; i++) {
      const a = a0 + (Math.PI / 2) * (i / n);
      pts.push(new THREE.Vector2(cx + ox + r * Math.cos(a), cy + oy + r * Math.sin(a)));
    }
  return pts;
}
/** Collects lofted surfaces and caps into one indexed geometry (top-view x/y map to world x/-z). */
class Loft {
  constructor() {
    this.pos = [];
    this.idx = [];
  }
  ring(pts, y) {
    const s = this.pos.length / 3;
    for (const p of pts) this.pos.push(p.x, y, -p.y);
    return s;
  }
  /** Sweeps the outline (cx, cy, w, d, r) along profile [[offset, y]…]; returns the rings' outlines. */
  sweep({ cx = 0, cy = 0, w, d, r, n = 10 }, profile) {
    const rings = profile.map(([o, y]) => {
      const pts = rrRing(cx, cy, w + 2 * o, d + 2 * o, r + o, n);
      return { pts, y, start: this.ring(pts, y) };
    });
    const m = rings[0].pts.length;
    for (let k = 0; k < rings.length - 1; k++) {
      const a = rings[k].start, b = rings[k + 1].start;
      for (let i = 0; i < m; i++) {
        const i1 = (i + 1) % m;
        this.idx.push(a + i, a + i1, b + i1, a + i, b + i1, b + i);
      }
    }
    return rings;
  }
  /** A flat cap at height y, facing up (dir 1) or down (-1), with holes. */
  cap(contour, holes, y, dir) {
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    const s = this.ring([contour, ...holes].flat(), y);
    const P = (i) => new THREE.Vector3(this.pos[(s + i) * 3], this.pos[(s + i) * 3 + 1], this.pos[(s + i) * 3 + 2]);
    for (const [a, b, c] of tris) {
      const n = new THREE.Vector3().crossVectors(P(b).sub(P(a)), P(c).sub(P(a)));
      if (n.y * dir >= 0) this.idx.push(s + a, s + b, s + c);
      else this.idx.push(s + a, s + c, s + b);
    }
  }
  mesh(mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    // planar UVs (x, z, sheared by y so walls get them too) — for the clear coat's orange peel
    const uv = [];
    for (let i = 0; i < this.pos.length; i += 3) uv.push(this.pos[i] + this.pos[i + 1] * 0.7, this.pos[i + 2] + this.pos[i + 1] * 0.7);
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }
}

// ───────────────────────────── the box
const LIDP = { skirt: 0.118, chamfer: 0.072, rise: 0.082 }; // the lid's vertical skirt, the hip chamfer's inset and rise
function box() {
  const o = new THREE.Group();
  const coat = powder();
  const outline = { w: W, d: D, r: R, n: 10 };
  // body: one folded shell, tight vertical corners, small radii at the folds
  const body = new Loft();
  // (a small folded flange round the foot, a tight fold at the top under the lid)
  const bp = filletLine([[-0.014, 0], [0.006, 0], [0.006, 0.022], [0, 0.03], [0, BODY], [-0.012, BODY]], [0.005, 0.006, 0.006, 0.007]);
  const br = body.sweep(outline, bp);
  body.cap(br[0].pts, [], 0, -1);
  body.cap(br[br.length - 1].pts, [], BODY, 1);
  o.add(body.mesh(coat));
  // lid: a hemmed skirt standing a hair proud of the body, a hip chamfer, then the top deck with two tool wells
  const y0 = BODY + SEAM;
  const lid = new Loft();
  const liner = new Loft();
  const deckIn = LAP - LIDP.chamfer - 0.05;
  // (the skirt's bottom edge is rolled outwards into a hem bead)
  const lp = filletLine(
    [
      [LAP - 0.012, y0],
      [LAP + 0.008, y0],
      [LAP + 0.008, y0 + 0.016],
      [LAP, y0 + 0.026],
      [LAP, y0 + LIDP.skirt],
      [LAP - LIDP.chamfer, y0 + LIDP.skirt + LIDP.rise],
      [deckIn, y0 + LIDP.skirt + LIDP.rise],
    ],
    [0.006, 0.007, 0.006, 0.014, 0.012],
  );
  const lr = lid.sweep(outline, lp);
  lid.cap(lr[0].pts, [], y0, -1);
  const holes = [];
  for (const sx of [-1, 1]) {
    // the well: a raised rolled lip (powder coat), then a deep drawn wall and floor under a black rubber liner
    const tp = filletLine(
      [[0.034, TOP], [0.016, TOP + 0.009], [0.0, TOP + 0.004], [0.0, TOP - 0.03], [-0.006, TOP - TRAY.depth], [-0.09, TOP - TRAY.depth]],
      [0.012, 0.01, 0.012, 0.004, 0.022],
    );
    const cut = tp.findIndex(([, y]) => y < TOP - 0.016);
    const spec = { cx: sx * TRAY.x, cy: 0, w: TRAY.w, d: TRAY.d, r: TRAY.r, n: 10 };
    const tr = lid.sweep(spec, tp.slice(0, cut + 1));
    holes.push(tr[0].pts);
    const wr = liner.sweep(spec, tp.slice(cut));
    liner.cap(wr[wr.length - 1].pts, [], TOP - TRAY.depth, 1);
  }
  lid.cap(lr[lr.length - 1].pts, holes, TOP, 1);
  o.add(lid.mesh(coat));
  o.add(liner.mesh(M.rubber({ color: "#1a1b20", roughness: 0.78 })));
  if (FOAM) {
    // a charcoal foam insert in each well (its top a little below the lip, its edge softly rounded): it is what holds
    // the tools upright
    const foam = new Loft();
    for (const sx of [-1, 1]) {
      const ft = TOP - FOAM;
      const fp = filletLine([[-0.004, TOP - TRAY.depth + 0.002], [-0.004, ft], [-0.03, ft]], [0.008]);
      const spec = { cx: sx * TRAY.x, cy: 0, w: TRAY.w, d: TRAY.d, r: TRAY.r, n: 10 };
      const fr = foam.sweep(spec, fp);
      foam.cap(fr[fr.length - 1].pts, [], ft, 1);
    }
    o.add(foam.mesh(M.rubber({ color: "#222328", roughness: 0.96, normalMap: microNormal("rubber", 5), normalScale: new THREE.Vector2(0.6, 0.6) })));
  }
  // rubber feet
  const foot = lathe([[0, 0], [0.05, 0], [0.058, 0.006], [0.06, 0.028], [0.055, 0.034], [0, 0.034]], M.rubber(), { segments: 40 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) o.add(at(foot.clone(), sx * (W / 2 - 0.17), -0.032, sz * (D / 2 - 0.13)));
  // pressed stiffening panels on the end walls
  for (const sx of [-1, 1]) {
    const p = slab(D - 0.26, BODY - 0.26, 0.02, 0.05, coat, 0.008, { curveSegments: 12, bevelSegments: 5 });
    p.rotation.y = (sx * Math.PI) / 2;
    o.add(at(p, sx * (W / 2 - 0.004), BODY / 2, 0));
  }
  return o;
}

// ───────────────────────────── the name badge: a printed face under an epoxy dome, in a riveted satin bezel
function namePlate(text, lang) {
  const o = new THREE.Group();
  const { w: pw, h: ph, rim, cy, dome } = PLATE;
  const bezel = rr(0, 0, pw + 2 * rim, ph + 2 * rim, 0.1, THREE.Shape);
  bezel.holes.push(rr(0, 0, pw - 0.02, ph - 0.02, 0.07));
  o.add(at(extrude(bezel, 0.03, 0.01, M.steel({ color: "#a9afb7", roughness: 0.32 }), { curveSegments: 16, bevelSegments: 6 }), 0, cy, FRONT + 0.012));
  // four domed rivets on the rim's corners
  const k = 0.1 - rim / 2;
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      const rx = sx * (pw / 2 + rim - 0.1 + k * Math.SQRT1_2);
      const ry = cy + sy * (ph / 2 + rim - 0.1 + k * Math.SQRT1_2);
      o.add(at(rivet(0.0105, M.steel({ roughness: 0.3 })), rx, ry, FRONT + 0.0262));
    }
  // a dark backing, then the printed face under a clear epoxy dome: flat in the middle, rolling off at the edges, so
  // the edges catch the key light along the top and the floor's glow along the bottom (a flat face facing the camera
  // only mirrors the even floor). Its square edges hide inside the bezel.
  o.add(at(slab(pw - 0.004, ph - 0.004, 0.01, 0.07, M.satin({ color: "#0c0d10", roughness: 0.6 }), 0.003), 0, cy, FRONT + 0.006));
  const band = 0.032;
  const roll = (t) => 1 - (1 - clamp01(t / band)) ** 3;
  const face = domedGrid(pw - 0.01, ph - 0.01, band, (x, y, hw, hh) => dome * roll(hw - Math.abs(x)) * roll(hh - Math.abs(y)) + 0.004 * (1 - (y / hh) ** 2));
  // (a neutral near-black: the tracer stores textures as linear 8-bit, so a tinted near-black shifts hue)
  // (the epoxy's gloss is carried by the base specular lobe, not a clear coat: the tracer samples a clear coat in only
  // ~4% of its bounces, which left the thin key-light line along the rolled edge grainy even at 640 samples)
  const base = M.satin({ color: "#161616", roughness: 0.06, specularIntensity: 1, clearcoat: 0 });
  const mat = titleMaterial(text, lang, pw, ph, base, { ...(FIT[lang] ?? FIT.ar), relief: 0.2, inkRoughness: 0.45 });
  o.add(at(new THREE.Mesh(face, mat), 0, cy, FRONT + 0.013));
  return o;
}
/**
 * A w×h grid (denser across the edge bands), lifted by zf(x, y, w/2, h/2); its uv is its own x/y (as titleMaterial
 * expects), facing +z.
 */
function domedGrid(w, h, band, zf) {
  const axis = (L, nb, nm) => {
    const a = [];
    for (let i = 0; i <= nb; i++) a.push(-L / 2 + band * (1 - Math.cos((Math.PI / 2) * (i / nb))));
    for (let i = 1; i < nm; i++) a.push(-L / 2 + band + ((L - 2 * band) * i) / nm);
    for (let i = nb; i >= 0; i--) a.push(L / 2 - band * (1 - Math.cos((Math.PI / 2) * (i / nb))));
    return a;
  };
  const xs = axis(w, 14, 40), ys = axis(h, 14, 16);
  const pos = [], uv = [], idx = [];
  for (const y of ys)
    for (const x of xs) {
      pos.push(x, y, zf(x, y, w / 2, h / 2));
      uv.push(x, y);
    }
  const nx = xs.length;
  for (let j = 0; j < ys.length - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ───────────────────────────── a draw latch (closed): a pressed lever hinged on the body, a wire loop over the keeper
function latch({ A = 0.016, C = 0.026, t0 = 0.1, lipB = 0.006, lipT = 0.9, zoff = 0.03 } = {}) {
  const o = new THREE.Group();
  const steel = M.steel({ roughness: 0.28 });
  const red = two(redCoat());
  const z = FRONT;
  const y0 = BODY - 0.31; // the lever's hinge
  const LW = 0.12, LH = 0.28; // lever width and height
  // the base plate, riveted to the body, its two ears carrying the hinge pin
  o.add(at(rbox(0.15, 0.07, 0.007, 0.003, steel), 0, y0 - 0.014, z + 0.0035));
  for (const s of [-1, 1]) {
    o.add(at(rivet(0.0095, steel), s * 0.054, y0 - 0.03, z + 0.0065));
    o.add(at(rbox(0.008, 0.042, 0.036, 0.0035, steel), s * (LW / 2 + 0.007), y0, z + 0.018));
  }
  // the lever's rolled foot round the pin
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, LW - 0.004, 28), red);
  barrel.rotation.z = Math.PI / 2;
  o.add(at(barrel, 0, y0, z + 0.018));
  // the lever: a pressed plate, bowed out over its lower half and curving back towards the box over its upper half (a
  // hair of outward flick at the very end), with side flanges folded back and a pressed rib. In this studio a front
  // face only mirrors the even floor; tilted 15–30° upwards it reaches the key light, so the upper half carries the
  // gloss and the lower half falls darker.
  const yc = y0 + 0.01 + LH / 2; // the lever's centre
  const zf = z + zoff; // its face plate's mid-plane at the foot
  const lift = (y) => {
    const t = (y - yc) / (LH / 2);
    const lip = clamp01((t - lipT) / (1 - lipT));
    return A * (1 - t * t) - C * Math.max(0, t - t0) ** 2 + lipB * lip * lip;
  };
  const rowsOf = (n, ya, yb, fn) => Array.from({ length: n + 1 }, (_, i) => fn(ya + ((yb - ya) * i) / n));
  // (a rounder section: the long edges roll back into the flanges as thin highlight lines)
  o.add(sectionLoft(rowsOf(40, y0 + 0.004, y0 + 0.01 + LH, (y) => ({ c: V3(0, y, zf + lift(y)), a: LW / 2, b: 0.006, p: 4 })), red, 72));
  for (const s of [-1, 1])
    o.add(sectionLoft(rowsOf(30, y0 + 0.016, y0 + LH - 0.02, (y) => ({ c: V3(s * (LW / 2 - 0.006), y, zf + lift(y) - 0.012), a: 0.0045, b: 0.012, p: 5 })), red, 32));
  // (the rib swells out of the plate and sinks back into it at its ends, as a pressing does)
  const ribEnv = (y) => {
    const u = (y - (y0 + 0.05)) / 0.15;
    const s = (e) => e * e * (3 - 2 * e);
    return s(clamp01(u / 0.2)) * s(clamp01((1 - u) / 0.2));
  };
  o.add(sectionLoft(rowsOf(30, y0 + 0.05, y0 + 0.2, (y) => ({ c: V3(0, y, zf + lift(y) + 0.003), a: 0.017 * (0.55 + 0.45 * ribEnv(y)), b: 0.0035 + 0.0055 * ribEnv(y), p: 2.6 })), red, 40));
  // the knuckle rolled across the lever, the wire loop's ends turned into it
  const yk = y0 + 0.235;
  const zk = zf + lift(yk) + 0.012;
  const knuckle = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, LW - 0.008, 28), red);
  knuckle.rotation.z = Math.PI / 2;
  o.add(at(knuckle, 0, yk, zk));
  const yTop = BODY + SEAM + 0.085; // the loop's bar, under the keeper's hook
  const xl = LW / 2 + 0.01;
  o.add(bentRod([[-0.045, yk, zk], [-xl, yk, zk], [-xl, yTop, z + 0.034], [xl, yTop, z + 0.034], [xl, yk, zk], [0.045, yk, zk]], [0.008, 0.015, 0.015, 0.008], 0.0065, steel));
  // the keeper on the lid: a riveted plate with a hook lip the loop sits under
  o.add(at(rbox(0.16, 0.052, 0.008, 0.003, steel), 0, yTop - 0.014, z + LAP + 0.004));
  o.add(at(rbox(0.16, 0.015, 0.05, 0.006, steel), 0, yTop + 0.016, z + LAP + 0.025));
  for (const s of [-1, 1]) o.add(at(rivet(0.0085, steel), s * 0.058, yTop - 0.022, z + LAP + 0.0075));
  return o;
}

// ───────────────────────────── the carry handle: steel bail in two pivot brackets, a red moulded grip
function handle() {
  const o = new THREE.Group();
  const steel = M.steel({ roughness: 0.26 });
  const hx = 0.32, gy = TOP + 0.24;
  for (const s of [-1, 1]) {
    // a folded U bracket: a riveted foot and two cheeks the bail pivots in
    o.add(at(rbox(0.1, 0.012, 0.13, 0.005, steel), s * hx, TOP + 0.006, 0));
    for (const c of [-1, 1]) o.add(at(rbox(0.012, 0.07, 0.07, 0.005, steel), s * hx + c * 0.032, TOP + 0.04, 0));
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.088, 20), steel);
    pin.rotation.z = Math.PI / 2;
    o.add(at(pin, s * hx, TOP + 0.05, 0));
    for (const c of [-1, 1]) {
      const rv = rivet(0.01, steel);
      rv.rotation.x = -Math.PI / 2;
      o.add(at(rv, s * hx, TOP + 0.012, c * 0.045));
    }
  }
  o.add(bentRod([[-hx + 0.03, TOP + 0.05, 0], [-hx, TOP + 0.05, 0], [-hx, gy, 0], [hx, gy, 0], [hx, TOP + 0.05, 0], [hx - 0.03, TOP + 0.05, 0]], [0.015, 0.07, 0.07, 0.015], 0.015, steel));
  // the grip: a moulded barrel with a flared collar and two ring grooves at each end
  const half = [[0.0, 0.25], [0.032, 0.248], [0.047, 0.238], [0.054, 0.222], [0.055, 0.205], [0.05, 0.198], [0.05, 0.19], [0.055, 0.183], [0.055, 0.172], [0.05, 0.165], [0.05, 0.157], [0.055, 0.15], [0.057, 0.1], [0.059, 0.0]];
  const prof = [...half.map(([r, y]) => [r, -y]), ...half.slice(0, -1).reverse().map(([r, y]) => [r, y])];
  const grip = lathe(prof, M.red({ roughness: 0.36, clearcoat: 0 }), { segments: 72 });
  grip.rotation.z = Math.PI / 2;
  o.add(at(grip, 0, gy, 0));
  return o;
}

// ───────────────────────────── tools (each built along +y from its foot at the origin)
function screwdriver() {
  const o = new THREE.Group();
  const L = 0.36; // handle length
  const prof = densify([[0, 0], [0.036, 0.0], [0.056, 0.007], [0.069, 0.024], [0.073, 0.06], [0.074, 0.15], [0.073, 0.24], [0.067, 0.29], [0.056, 0.322], [0.042, 0.345], [0.033, 0.36]], 5);
  const env = (y) => clamp01((y - 0.03) / 0.05) * clamp01((0.31 - y) / 0.05);
  o.add(fluted(prof, M.red({ roughness: 0.1, clearcoat: 0 }), { lobes: 6, depth: 0.15, env }));
  // the ferrule: satin steel, its top a convex shoulder running into the shaft (an open chrome lip mirrored the dark
  // backdrop as a black crescent)
  o.add(at(lathe([[0.025, 0], [0.0285, 0.002], [0.03, 0.006], [0.03, 0.028], [0.0294, 0.0318], [0.0278, 0.0346], [0.0255, 0.0368], [0.0232, 0.0386], [0.0212, 0.04]], M.steel({ roughness: 0.3 }), { segments: 64 }), 0, L - 0.01, 0));
  // a polished shaft, then the blade: the round bar ground to a wedge (a hair wider at the tip, its end eased)
  const S = 0.2, r0 = 0.021;
  const shaft = new THREE.CylinderGeometry(r0, r0, S + 0.004, 40, 1);
  shaft.translate(0, (S + 0.004) / 2, 0);
  o.add(at(new THREE.Mesh(shaft, M.steel({ color: "#cfd3d9", roughness: 0.2 })), 0, L + 0.02, 0));
  const BL = 0.095, yb = L + 0.02 + S;
  const rows = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    rows.push({ c: V3(0, yb + t * BL, 0), a: r0 * (1 + 0.16 * t ** 1.6), b: r0 * (1 - 0.8 * t ** 1.25), p: 2 + 3 * t });
  }
  const e = rows[rows.length - 1];
  rows.push({ c: V3(0, yb + BL + 0.0018, 0), a: e.a * 0.96, b: e.b * 0.8, p: e.p });
  rows.push({ c: V3(0, yb + BL + 0.0028, 0), a: e.a * 0.84, b: e.b * 0.4, p: e.p });
  o.add(sectionLoft(rows, two(M.steel({ color: "#c3c8cf", roughness: 0.32 })), 64));
  return o;
}
/** Rounds the sharp corners (turning more than minAng) of a closed 2D polygon with radius r. */
function roundSharp(pts, r, minAng = 0.6, k = 4) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const d1 = b.clone().sub(a), d2 = c.clone().sub(b);
    const l1 = d1.length(), l2 = d2.length();
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const ang = Math.acos(Math.max(-1, Math.min(1, d1.dot(d2) / (l1 * l2))));
    if (ang < minAng) {
      out.push(b);
      continue;
    }
    const p0 = b.clone().addScaledVector(d1, -Math.min(r, l1 / 2) / l1);
    const p1 = b.clone().addScaledVector(d2, Math.min(r, l2 / 2) / l2);
    for (let j = 0; j <= k; j++) {
      const t = j / k;
      out.push(new THREE.Vector2((1 - t) ** 2 * p0.x + 2 * (1 - t) * t * b.x + t * t * p1.x, (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * b.y + t * t * p1.y));
    }
  }
  return out;
}
/** A combination wrench outline: open end (head centre at the origin, jaw along +y tilted by `ang`), shank down to -len. */
function wrenchOutline({ Rh = 0.128, s = 0.13, ang = 0.26, neck = 0.108, foot = 0.086, len = 0.66, cut = 0.024 } = {}) {
  const u = new THREE.Vector2(Math.sin(ang), Math.cos(ang)); // the jaw's opening direction
  const v = new THREE.Vector2(Math.cos(ang), -Math.sin(ang)); // across the jaw
  const a = Math.sqrt(Rh * Rh - (s / 2) ** 2);
  const e = a - cut; // the jaws end square here (along u)
  const o = Math.sqrt(Rh * Rh - e * e);
  const P = (al, ac) => u.clone().multiplyScalar(al).addScaledVector(v, ac);
  const BR = P(e, o), AR = P(e, s / 2), BL = P(e, -o), AL = P(e, -s / 2);
  const pts = [];
  const circ = (th) => new THREE.Vector2(Rh * Math.cos(th), Rh * Math.sin(th));
  const along = (th0, th1, n) => {
    for (let i = 0; i <= n; i++) pts.push(circ(th0 + ((th1 - th0) * i) / n));
  };
  const thBR = Math.atan2(BR.y, BR.x);
  let thBL = Math.atan2(BL.y, BL.x);
  if (thBL > 0) thBL -= Math.PI * 2;
  const thNeckR = -Math.PI / 2 + Math.asin(neck / 2 / Rh);
  const thNeckL = -Math.PI / 2 - Math.asin(neck / 2 / Rh);
  along(thBR, thNeckR + 0.42, 40);
  const qRc = new THREE.Vector2(neck / 2, -Math.sqrt(Rh * Rh - (neck / 2) ** 2));
  pts.push(...new THREE.QuadraticBezierCurve(circ(thNeckR + 0.42), qRc, new THREE.Vector2(neck / 2 - 0.004, qRc.y - 0.07)).getPoints(16).slice(1));
  pts.push(new THREE.Vector2(foot / 2, -len));
  for (let i = 1; i < 16; i++) {
    const t = -Math.PI * (i / 16);
    pts.push(new THREE.Vector2((foot / 2) * Math.cos(t), -len + (foot / 2) * Math.sin(t)));
  }
  pts.push(new THREE.Vector2(-foot / 2, -len));
  pts.push(...new THREE.QuadraticBezierCurve(new THREE.Vector2(-neck / 2 + 0.004, qRc.y - 0.07), new THREE.Vector2(-neck / 2, qRc.y), circ(thNeckL - 0.42)).getPoints(16).slice(1));
  along(thNeckL - 0.42, thBL, 40);
  // the left jaw's square end, the throat (down the flat, round the bottom, up the other flat), the right jaw's end
  pts.push(AL);
  const T0 = v.clone().multiplyScalar(-s / 2);
  const a0 = Math.atan2(T0.y, T0.x);
  for (let i = 0; i <= 24; i++) {
    const t = a0 + (Math.PI * i) / 24;
    pts.push(new THREE.Vector2((s / 2) * Math.cos(t), (s / 2) * Math.sin(t)));
  }
  pts.push(AR);
  return { pts: roundSharp(pts, 0.006), neck, foot, len, qy: qRc.y - 0.07 };
}
function wrench({ crown = 1.2, crownU = -0.05, crownPhi = 0.8 } = {}) {
  const W0 = wrenchOutline();
  const { neck, foot, len, qy } = W0;
  // the shank's half width at y (it tapers from the neck to the foot)
  const hw = (y) => neck / 2 - 0.004 + ((y - qy) / (-len - qy)) * (foot / 2 - (neck / 2 - 0.004));
  // the I-beam: the outline at full thickness with a slot down the shank, a thinner panel in the slot
  const slot = (inset) => {
    const yt = qy - 0.05, yb = -len + 0.05, pts = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const y = yt + ((yb - yt) * i) / n;
      pts.push(new THREE.Vector2(hw(y) - inset, y));
    }
    const rB = hw(yb) - inset;
    for (let i = 1; i < 12; i++) {
      const t = -Math.PI * (i / 12);
      pts.push(new THREE.Vector2(rB * Math.cos(t), yb + rB * Math.sin(t)));
    }
    for (let i = n; i >= 0; i--) {
      const y = yt + ((yb - yt) * i) / n;
      pts.push(new THREE.Vector2(-(hw(y) - inset), y));
    }
    const rT = hw(yt) - inset;
    for (let i = 1; i < 12; i++) {
      const t = Math.PI + Math.PI * (i / 12);
      pts.push(new THREE.Vector2(rT * Math.cos(t), yt - rT * Math.sin(t)));
    }
    return pts;
  };
  const outer = new THREE.Shape(W0.pts);
  outer.holes.push(new THREE.Path(slot(0.028)));
  // polished chrome flats (a darker base colour, so they sit below the rims) and broad rolled edges that catch the key
  // and fill lights; a satin-ground panel in the I-beam's recess
  const polished = [M.chrome({ color: "#c4c9cf", roughness: 0.06 }), M.chrome({ color: "#e2e5e9", roughness: 0.09 })];
  const frame = extrude(outer, 0.046, 0.011, polished, { bevelSegments: 8, curveSegments: 24 });
  const panel = extrude(new THREE.Shape(slot(0.025)), 0.034, 0.004, [M.steel({ color: "#d4d8de", roughness: 0.28 }), M.steel({ roughness: 0.28 })], { bevelSegments: 3, curveSegments: 24 });
  if (crown) {
    // a crown over the head's upper-left: the jaw leans back, sweeping its reflection from the floor through the dark
    // sky into the key light (a flat face only mirrors the even floor). Displaced along z by k·max(0, u − u0)², u the
    // distance along (−sin φ, cos φ); the normals follow the deformation exactly (n' = J⁻ᵀ n), so the big cap
    // triangles still shade smoothly.
    const sx = -Math.sin(crownPhi), sy = Math.cos(crownPhi);
    for (const m of [frame, panel]) {
      const p = m.geometry.attributes.position;
      const n = m.geometry.attributes.normal;
      for (let i = 0; i < p.count; i++) {
        const du = p.getX(i) * sx + p.getY(i) * sy - crownU;
        if (du <= 0) continue;
        p.setZ(i, p.getZ(i) - crown * du * du);
        const gp = 2 * crown * du; // d(displacement)/du
        const nx = n.getX(i) + gp * sx * n.getZ(i), ny = n.getY(i) + gp * sy * n.getZ(i), nz = n.getZ(i);
        const l = Math.hypot(nx, ny, nz) || 1;
        n.setXYZ(i, nx / l, ny / l, nz / l);
      }
    }
  }
  const g = group(frame, panel);
  g.position.y = len;
  return group(g);
}
/** Stands a tool (built along +y) in a well: spin about its own axis, then lean back (x) and sideways (z). */
function stand(tool, x, y, z, { spin = 0, lean = 0, back = 0 } = {}) {
  const inner = group(tool);
  inner.rotation.y = spin;
  const outer = group(inner);
  outer.rotation.set(back, 0, lean, "ZXY");
  outer.position.set(x, y, z);
  return outer;
}

export function build({ text, lang }) {
  const o = new THREE.Group();
  o.add(box());
  o.add(namePlate(text, lang));
  for (const s of [-1, 1]) o.add(at(latch(), s * LATCH_X, 0, 0));
  o.add(handle());
  const floor = TOP - TRAY.depth;
  // two clean shapes, one in each well, leaning out from the handle
  const size = (t) => (t.scale.setScalar(TOOL), t);
  // (the screwdriver stands in the foam insert, its foot a little above the well's floor)
  o.add(stand(size(screwdriver()), SCREW.x, floor + 0.08, SCREW.z, { lean: SCREW.lean, back: SCREW.back, spin: 1.2 }));
  o.add(stand(size(wrench()), 0.8, floor, -0.06, { lean: -0.2, back: -0.06, spin: 0.3 }));
  return o;
}
