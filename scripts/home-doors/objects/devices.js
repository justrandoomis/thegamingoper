// «أجهزة الألعاب» — a current-generation home console lying flat, in an open-shell design: a black core running the
// full length between two moulded white covers. Both covers bend away from the core towards their tips (the upper one
// more — the lower one only a little, so the console still rests close to the table), and in the wedges they open a
// comb of dark fins stands over a black backing: the front reads as a black waist flaring into vents at the four
// corners. The upper cover follows the core's rake (a small overhang, no awning); its top is crowned and falls off a
// little towards the back. The core's glossy front leans back (a parallelogram in profile) so it mirrors the dark band
// of the studio rather than the lit table; it carries the name above the I/O line — disc slot, power button with a red
// standby ring, two USB-C ports — on a lip that curls forward into the key light's soft edge, and its top edge rolls
// back into the light: the gloss reads at the edges while the letters keep a deep black ground. Light lines in the
// TamTam red run along the upper cover's front edge and the core's foot (framing the name, matching the standby ring);
// louvred vents on the core's ends, rubber feet under the lower cover's tips.
// Set harmony (with the seven other doors): tilt 0.14 shows more of the crowned top and gap 0.04 floats it like the
// rest; the core is a little taller than a slim console's (0.72) so the first tile of the row is not its smallest;
// the name has an absolute height (NAME_H), keeping its main line in the set's 9–12% band in every language.
import { THREE, M, at, group, roundedRect, rbox, lathe, torus, titleMaterial } from "../kit.js";

export const meta = { turn: -0.3, tilt: 0.14, gap: 0.04, margin: [0.92, 0.86], centerY: 0.03 };

// the light lines: TamTam red, the set's accent (a blue upper line was tried: two accents, and too close to one console)
// (emissive 2: the tone mapper keeps it a deep, luminous red — at 3 it already bleaches towards coral)
const LIGHT = { lower: ["#d3121b", 2], upper: ["#d3121b", 2] };
// the name's largest ink height (world units), whatever the fascia's height: Arabic's main line at ~11% of the tile (the set's 9–12% band)
const NAME_H = 0.33;

const clamp01 = (t) => Math.min(1, Math.max(0, t));
const smooth01 = (t) => {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
};
const ease = (u, p) => 1 - Math.pow(1 - clamp01(u), p);

// ───────────────────────────── proportions (1 unit ≈ 14 cm — a real console's 39 × 11.5 × 26 cm, near enough)
const CX = 1.35; // core half-width: the core runs nearly the covers' full length
const CY = 0.36; // core half-height (0.325 was a slim console's: the icon sat small in its tile)
const CD = 1.5; // core depth
const ZF = CD / 2; // the core's front, at its foot
const BR = 0.09; // the core's corner radius (front view)
const G = 0.016; // the joint between the core and a cover
const Y0 = CY + G; // a cover's inner face
// The core leans back so its gloss mirrors the dark band of the studio between the front light and the key: the
// reflection leaves at 2·(RAKE − tilt) − 12° (the camera's elevation), which should sit near 10°.
const RAKE = THREE.MathUtils.degToRad(11.6) + meta.tilt;
const TR = Math.tan(RAKE);
const S = 2 * CY * TR; // how far the core's top is set back from its foot
const CA = CX + 0.06; // cover half-width: the covers' tips reach a little past the core's ends
const FO = 0.08; // the lower cover's overhang in front of the core's foot
const FOU = 0.09; // the upper cover's overhang in front of the core's top edge (it follows the rake: no awning)
const CR = 0.24; // cover corner radius (plan)
const CT = 0.03; // cover thickness at the edge: thin moulded sheets
const COVERZ = {
  upper: { front: ZF - S + FOU, back: -ZF - S - 0.03 },
  lower: { front: ZF + FO, back: -ZF - 0.03 },
};
// the open shell: both covers bend away from the core towards their tips (flat over the middle, flaring at the ends).
// The lower flare stays small: the camera sees under the lower cover's front edge, and every bit it lifts off the
// table shows as a strip of fully shadowed floor.
const LIFT = { upper: 0.13, lower: 0.04 };
const LP = 2.2;
const flare = (x) => Math.pow(Math.min(1, Math.abs(x) / CA), LP);
const SWEEP = 0.06; // the covers' tips reach forward, cradling the core
const TAPER = 0.35; // the covers thin out towards their tips
const taper = (x) => 1 - TAPER * smooth01((Math.abs(x) - 1.0) / (CA - 1.0));

// ───────────────────────────── geometry helpers
/** Smooth vertex normals that keep creases sharper than `creaseDeg` (angle-weighted, fine position welding). */
function creaseNormals(geo, creaseDeg = 35) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position.array;
  const nv = pos.length / 3;
  const nf = nv / 3;
  const fn = new Float32Array(nf * 3);
  const w = new Float32Array(nv);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  const corner = (p, q, r) => {
    e1.subVectors(q, p);
    e2.subVectors(r, p);
    const l = e1.length() * e2.length();
    return l > 0 ? Math.acos(Math.min(1, Math.max(-1, e1.dot(e2) / l))) : 0;
  };
  for (let f = 0; f < nf; f++) {
    a.fromArray(pos, f * 9);
    b.fromArray(pos, f * 9 + 3);
    c.fromArray(pos, f * 9 + 6);
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    const len = n.length();
    if (len < 1e-14) continue;
    n.divideScalar(len);
    fn[f * 3] = n.x;
    fn[f * 3 + 1] = n.y;
    fn[f * 3 + 2] = n.z;
    w[f * 3] = corner(a, b, c);
    w[f * 3 + 1] = corner(b, c, a);
    w[f * 3 + 2] = corner(c, a, b);
  }
  const buckets = new Map();
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(pos[i * 3] * 1e5)},${Math.round(pos[i * 3 + 1] * 1e5)},${Math.round(pos[i * 3 + 2] * 1e5)}`;
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(i);
  }
  const out = new Float32Array(nv * 3);
  const cosT = Math.cos((creaseDeg * Math.PI) / 180);
  for (const list of buckets.values()) {
    for (const i of list) {
      const fi = (i / 3) | 0;
      let sx = 0, sy = 0, sz = 0;
      for (const j of list) {
        const fj = (j / 3) | 0;
        const d = fn[fi * 3] * fn[fj * 3] + fn[fi * 3 + 1] * fn[fj * 3 + 1] + fn[fi * 3 + 2] * fn[fj * 3 + 2];
        if (d < cosT) continue;
        sx += fn[fj * 3] * w[j];
        sy += fn[fj * 3 + 1] * w[j];
        sz += fn[fj * 3 + 2] * w[j];
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      out[i * 3] = sx / l;
      out[i * 3 + 1] = sy / l;
      out[i * 3 + 2] = sz / l;
    }
  }
  g.setAttribute("normal", new THREE.BufferAttribute(out, 3));
  return g;
}

/** Extrudes a shape along z (centred), rounded bevel, smooth normals. mat may be [cap, side]. */
function extrudeSmooth(shape, depth, bevel, mat, { bevelSegments = 10, curveSegments = 24, crease = 35 } = {}) {
  const b = Math.max(0, Math.min(bevel, depth / 2 - 0.0005));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.0001, depth - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments, curveSegments, steps: 1 });
  geo.translate(0, 0, -(depth - 2 * b) / 2);
  return new THREE.Mesh(creaseNormals(geo, crease), mat);
}
const smoothSlab = (w, h, d, r, mat, bevel, o) => extrudeSmooth(roundedRect(w, h, r), d, bevel, mat, o);

/** Points round a rounded rectangle (half sizes A×B, corner R) — always the same count, in the same order. */
function ringPoints(A, B, R, n) {
  R = Math.max(0, Math.min(R, A, B));
  const hx = A - R, hz = B - R;
  const out = [];
  const side = (x0, z0, x1, z1, count) => {
    for (let i = 0; i < count; i++) out.push([x0 + ((x1 - x0) * i) / count, z0 + ((z1 - z0) * i) / count]);
  };
  const arc = (cx, cz, a0, count) => {
    for (let i = 0; i < count; i++) {
      const t = a0 + (Math.PI / 2) * (i / count);
      out.push([cx + R * Math.cos(t), cz + R * Math.sin(t)]);
    }
  };
  side(A, -hz, A, hz, n.short);
  arc(hx, hz, 0, n.arc);
  side(hx, B, -hx, B, n.long);
  arc(-hx, hz, Math.PI / 2, n.arc);
  side(-A, hz, -A, -hz, n.short);
  arc(-hx, -hz, Math.PI, n.arc);
  side(-hx, -B, hx, -B, n.long);
  arc(hx, -hz, (3 * Math.PI) / 2, n.arc);
  return out;
}

/**
 * Sweeps a cross-section round a rounded-rectangle plan: `prof` is a list of {d, h, tag} — d the inward offset from the
 * plan outline, h the height across the plan — and `place(u, v, h, tag)` maps a point to [x, y, z]. Quads take the
 * tag of their rings (mixed pairs go to `edgeTag`); `tags` lists the material order. Returns an indexed geometry with
 * one group per tag, wound outwards, with smooth normals and uv = the plan coordinates.
 */
function sweepRings(A, B, R, n, prof, place, tags, edgeTag) {
  const pos = [];
  const uv = [];
  let N = 0;
  for (const p of prof) {
    const ring = ringPoints(A - p.d, B - p.d, R - p.d, n);
    N = ring.length;
    for (const [u, v] of ring) {
      pos.push(...place(u, v, p.h, p.tag));
      uv.push(u, v);
    }
  }
  const lists = tags.map(() => []);
  for (let p = 0; p < prof.length - 1; p++) {
    const tag = prof[p].tag === prof[p + 1].tag ? prof[p].tag : edgeTag;
    const list = lists[tags.indexOf(tag)];
    for (let j = 0; j < N; j++) {
      const a = p * N + j, b = p * N + ((j + 1) % N), c = (p + 1) * N + ((j + 1) % N), d = (p + 1) * N + j;
      list.push(a, b, c, a, c, d);
    }
  }
  const all = lists.flat();
  let vol = 0;
  for (let i = 0; i < all.length; i += 3) {
    const [a, b, c] = [all[i] * 3, all[i + 1] * 3, all[i + 2] * 3];
    vol += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  if (vol < 0) for (const list of lists) for (let i = 0; i < list.length; i += 3) [list[i + 1], list[i + 2]] = [list[i + 2], list[i + 1]];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(lists.flat());
  let start = 0;
  lists.forEach((list, i) => {
    g.addGroup(start, list.length, i);
    start += list.length;
  });
  g.computeVertexNormals();
  return g;
}

/**
 * The cross-section of a moulded shell: its top surface y = f(d) and bottom surface y = g(d) (d = the inward offset
 * from the plan outline) meet an upright band at the outline through two arrises, circles of radius rT and rB tangent
 * to the band and to each surface. Returns rings {d, h, tag} from the top centre line round the edge to the bottom one.
 */
function shellProfile(f, g, rT, rB, dMax) {
  const slope = (fn, d) => {
    const d0 = Math.max(0, d - 1e-4);
    return (fn(d + 1e-4) - fn(d0)) / (d + 1e-4 - d0);
  };
  let dT = rT, dB = rB;
  for (let i = 0; i < 8; i++) {
    const s = slope(f, dT);
    dT = rT * (1 - s / Math.hypot(1, s));
    const q = -slope(g, dB);
    dB = rB * (1 - q / Math.hypot(1, q));
  }
  const sT = slope(f, dT), qB = -slope(g, dB);
  const ycT = f(dT) - rT / Math.hypot(1, sT); // the arrises' centres: (rT, ycT) and (rB, ycB)
  const ycB = g(dB) + rB / Math.hypot(1, qB);
  const prof = [];
  const ds = [];
  for (let d = dT; d < dMax - 1e-4; d += Math.min(0.07, 0.003 + 0.09 * (d - dT))) ds.push(d);
  ds.push(dMax);
  for (let i = ds.length - 1; i >= 0; i--) prof.push({ d: ds[i], h: f(ds[i]), tag: "top" });
  const a0 = Math.PI / 2 + Math.atan(sT);
  for (let i = 1; i <= 14; i++) {
    const a = a0 + ((Math.PI - a0) * i) / 14;
    prof.push({ d: rT + rT * Math.cos(a), h: ycT + rT * Math.sin(a), tag: "edge" });
  }
  const a1 = Math.atan2(-1, -qB) + 2 * Math.PI;
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + ((a1 - Math.PI) * i) / 10;
    prof.push({ d: rB + rB * Math.cos(a), h: ycB + rB * Math.sin(a), tag: "edge" });
  }
  const db = [];
  for (let d = dB + 0.003, st = 0.004; d < dMax - 1e-4; d += st, st = Math.min(0.08, st * 1.35)) db.push(d);
  db.push(dMax);
  for (const d of db) prof.push({ d, h: g(d), tag: "bottom" });
  return prof;
}

/**
 * A cover: a moulded sheet whose plan is a rounded rectangle with its tips swept forward, bending away from the core
 * towards its tips. The two covers mirror each other: the OUTER face (the upper cover's top, the lower cover's
 * underside) is crowned and rolls into a rounded arris; the INNER face meets the edge through a small undercut on the
 * upper cover (it falls into shade and carries the light line) and a soft nose on the lower one (seen from above).
 * Both thin towards their tips, squeezing towards the inner face. Groups: top, edge, bottom.
 */
const COVER = {
  upper: { h: CT / 2, roll: 0.032, rollD: 0.14, crown: 0.05, crownD: 0.9, under: 0.012, underD: 0.026, rT: 0.008, rB: 0.003 },
  lower: { h: CT / 2, roll: 0.03, rollD: 0.16, nose: 0.012, noseD: 0.12, rT: 0.012, rB: 0.008 },
};
function coverGeometry(upper) {
  const c = upper ? COVER.upper : COVER.lower;
  const { front, back } = upper ? COVERZ.upper : COVERZ.lower;
  const B = (front - back) / 2, zc = (front + back) / 2;
  const h = c.h;
  const f = upper ? (d) => h + c.roll * ease(d / c.rollD, 2) + c.crown * ease(d / c.crownD, 2) : (d) => h - c.nose * (1 - ease(d / c.noseD, 2));
  const g = upper ? (d) => -h + c.under * (1 - clamp01(d / c.underD)) ** 2 : (d) => -h - c.roll * ease(d / c.rollD, 2);
  const prof = shellProfile(f, g, c.rT, c.rB, B);
  const L = upper ? LIFT.upper : LIFT.lower;
  const place = (x, z, y) => {
    const Z = zc + z + SWEEP * (x / CA) ** 2 * smooth01((z + 0.2 * B) / (1.1 * B));
    const t = taper(x);
    if (upper) return [x, Y0 + h + L * flare(x) + (-h + (y + h) * t), Z];
    return [x, -(Y0 + h) - L * flare(x) + (h + (y - h) * t), Z];
  };
  const geometry = sweepRings(CA, B, CR, { long: 130, short: 52, arc: 18 }, prof, place, ["top", "edge", "bottom"], "edge");
  // a point on the front edge's underside (d in from the outline), pushed out along the undercut's normal
  const frontEdge = (x, d, out = 0) => {
    const p = place(x, B - d, g(d));
    const k = Math.SQRT1_2 * out;
    return new THREE.Vector3(p[0], p[1] - k, p[2] + k);
  };
  return { geometry, frontEdge, place, B, zc, f, g };
}

/**
 * The fascia skin: a thin rounded slab whose face is flat behind the name; `curl(y)` moves the face forward (+) or
 * back (−) — its foot curls forward (the I/O lip mirrors the soft lower edge of the key light as a sheen) and its top
 * rolls back a little. A generous rounded bevel catches hairline highlights on its edges. uv = its own x/y (the curl
 * does not distort the print). Groups: face, rest.
 */
function fasciaGeometry(A, B, R, depth, bevel, curl) {
  const prof = [];
  const rings = 30;
  for (let k = 0; k <= rings; k++) prof.push({ d: B - (B - bevel) * Math.pow(k / rings, 0.7), h: 0, tag: "face" });
  for (let k = 1; k <= 10; k++) {
    const a = (Math.PI / 2) * (k / 10);
    prof.push({ d: bevel * (1 - Math.sin(a)), h: -bevel * (1 - Math.cos(a)), tag: "rest" });
  }
  prof.push({ d: 0, h: -depth + 0.002, tag: "rest" }, { d: 0.002, h: -depth, tag: "rest" }, { d: B, h: -depth, tag: "rest" });
  const place = (x, y, z) => [x, y, z + curl(y)];
  return sweepRings(A, B, R, { long: 150, short: 40, arc: 14 }, prof, place, ["face", "rest"], "rest");
}

/** Bakes every mesh under `source` and shears it into `target`: z −= (y − y0)·k (the core leans back). */
function shearInto(target, source, k, y0) {
  source.updateMatrixWorld(true);
  const inv = source.matrixWorld.clone().invert();
  const S = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, -k, 1, k * y0, 0, 0, 0, 1);
  const local = new THREE.Matrix4();
  source.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(local.multiplyMatrices(inv, m.matrixWorld));
    g.applyMatrix4(S);
    target.add(new THREE.Mesh(g, m.material));
  });
}

// ───────────────────────────── small parts (each faces +z, its front at z ≈ 0)
function discSlot(len, mats) {
  // a satin bezel standing a little proud round a dark slot, so the opening reads as a recess
  const ring = roundedRect(len + 0.044, 0.054, 0.027);
  ring.holes.push(roundedRect(len, 0.021, 0.0105));
  const bezel = extrudeSmooth(ring, 0.016, 0.0055, mats.bezel, { bevelSegments: 6 });
  const hole = smoothSlab(len + 0.004, 0.024, 0.006, 0.012, mats.void, 0.002);
  return group(at(bezel, 0, 0, 0.007), at(hole, 0, 0, 0.0005));
}
function usbC(mats) {
  const ring = roundedRect(0.064, 0.025, 0.012);
  ring.holes.push(roundedRect(0.05, 0.013, 0.0064));
  const shellRing = extrudeSmooth(ring, 0.01, 0.0028, mats.steel, { bevelSegments: 5 });
  const cavity = smoothSlab(0.052, 0.015, 0.01, 0.0075, mats.void, 0.002);
  const tongue = rbox(0.032, 0.0042, 0.008, 0.0018, mats.tongue, 3);
  return group(at(shellRing, 0, 0, 0.001), at(cavity, 0, 0, -0.005), at(tongue, 0, 0, -0.001));
}
function powerButton(mats) {
  // a domed cap in a dark well, ringed by the red standby light
  // (the profile runs from the rim to the apex, so the lathe's faces and normals point outwards)
  const s = 1.25;
  const cap = lathe([[0.031, 0], [0.031, 0.007], [0.028, 0.0115], [0.022, 0.0142], [0.014, 0.0155], [0.0005, 0.016]].map(([r, y]) => [r * s, y * s]), mats.button, { facing: "z", segments: 72 });
  const ring = torus(0.052, 0.0066, mats.standby, Math.PI * 2, 16, 128);
  const well = smoothSlab(0.126, 0.126, 0.008, 0.063, mats.void, 0.002);
  return group(at(well, 0, 0, -0.003), at(cap, 0, 0, -0.002), at(ring, 0, 0, 0.001));
}
/** A louvred vent: a raised satin frame round a dark opening with slats across it. Faces +z. */
function ventGrille(len, rows, pitch, mats) {
  const hgt = rows * pitch + 0.012;
  const frame = roundedRect(len + 0.03, hgt + 0.03, 0.03);
  frame.holes.push(roundedRect(len, hgt, 0.018));
  const g = new THREE.Group();
  g.add(at(extrudeSmooth(frame, 0.014, 0.005, mats.frame, { bevelSegments: 5 }), 0, 0, 0.004));
  g.add(at(smoothSlab(len + 0.004, hgt + 0.004, 0.006, 0.02, mats.void, 0.002), 0, 0, -0.001));
  for (let i = 0; i < rows; i++) {
    const y = -hgt / 2 + 0.006 + pitch * (i + 0.5);
    const slat = rbox(len - 0.006, pitch * 0.42, 0.012, pitch * 0.15, mats.slat, 3);
    slat.rotation.x = -0.35; // angled louvres: their tops catch the light
    g.add(at(slat, 0, y, 0.004));
  }
  return g;
}


/** The black backing of a vent wedge: a thin plate from the core's top (or foot) up to the cover's inner face. */
function wedgePlate(s, up, L, mat) {
  const pts = [];
  const xa = 0.45, xb = CX - 0.02, steps = 48;
  pts.push([xa, 0], [xb, 0]);
  for (let i = 0; i <= steps; i++) {
    const x = xb - ((xb - xa) * i) / steps;
    pts.push([x, G + L * flare(x) + 0.004]);
  }
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(s * x, up ? y : -y)));
  return new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: 0.01, bevelEnabled: false, curveSegments: 1 }), mat);
}


/** A front-to-back fall-off for a cover's colour (uv = plan coordinates, v ∈ [−B, B], front = +B). */
function falloffMap(B, back = 0.8) {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d");
  for (let r = 0; r < 256; r++) {
    const t = r / 255; // 0 = front, 1 = back
    const k = 1 - (1 - back) * smooth01((t - 0.12) / 0.88);
    const v = Math.round(255 * Math.pow(k, 1 / 2.2));
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(0, r, 4, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.repeat.set(1, 1 / (2 * B));
  tex.offset.set(0, 0.5);
  tex.updateMatrix();
  return tex;
}

// ───────────────────────────── the console
export function build({ text, lang }) {
  const mats = {
    white: M.white({ color: "#d2d2ce", roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, normalMap: null }),
    liner: M.white({ color: "#c6c6c2", roughness: 0.55, clearcoat: 0.1, normalMap: null }),
    body: M.textured({ color: "#111114", roughness: 0.55 }),
    front: M.gloss(),
    bezel: M.satin({ color: "#25262b", roughness: 0.45, clearcoat: 0.2 }),
    void: new THREE.MeshPhysicalMaterial({ color: "#020203", roughness: 0.95 }),
    steel: M.steel({ roughness: 0.28 }),
    tongue: M.satin({ color: "#1d1d22" }),
    button: M.satin({ color: "#3a3b42", roughness: 0.38 }),
    standby: M.glow("#d3121b", 2.6),
    frame: M.satin({ color: "#1d1e23", roughness: 0.6 }),
    slat: M.satin({ color: "#34363d", roughness: 0.45, clearcoat: 0.15 }),
    fin: new THREE.MeshPhysicalMaterial({ color: "#2a2b31", roughness: 0.55 }),
    light: M.glow(...LIGHT.lower),
    lightUp: M.glow(...LIGHT.upper),
    feet: M.rubber(),
  };
  const o = new THREE.Group();

  // ── the core, built upright and then sheared so it leans back
  const core = new THREE.Group();
  core.add(extrudeSmooth(roundedRect(2 * CX, 2 * CY, BR), CD, 0.03, mats.body));
  // the glossy fascia: the whole front between the joints, a hair proud of the body (a parting line round it)
  const FW = 2 * CX - 0.02, FH = 2 * CY - 0.044;
  const zs = ZF + 0.008;
  const io = -FH / 2 + 0.075; // the I/O line along its foot
  const curlY0 = -FH / 2 + 0.1; // the band below the name curls forward, tilting up into the key light's soft lower edge
  const CK = 0.6;
  const rollY0 = FH / 2 - 0.036; // and the band above it rolls back a little into the light (a glossy lip under the cover)
  const curl = (y) => CK * Math.max(0, curlY0 - y) ** 2 - 2.6 * Math.max(0, y - rollY0) ** 2;
  const onFace = (obj, x, y) => {
    obj.position.set(x, y, zs + 0.001 + curl(y));
    obj.rotation.x = -Math.atan(2 * CK * Math.max(0, curlY0 - y));
    return obj;
  };
  // the name sits centred in the space between the I/O line and the fascia's top
  const nameLo = io + 0.062 + 0.03, nameHi = FH / 2 - 0.04;
  const raise = (nameLo + nameHi) / 2;
  // English is width-limited by a short, tall-lettered word: a little smaller, so it is not the loudest name in the row
  // set check: the English capitals are capped at ~11–12% of the tile (was ~18% at 0.75), level with Accessories
  const fitW = lang === "en" ? 0.47 : 0.88; // "Consoles" is width-limited below 0.83 of the width; its size scales with fitW
  const title = titleMaterial(text, lang, FW, FH, mats.front, { fitW, fitH: Math.min(NAME_H, nameHi - nameLo) / FH, relief: 0, inkRoughness: 0.3 });
  for (const tex of [title.map, title.roughnessMap, title.normalMap]) {
    if (!tex) continue;
    tex.offset.y -= raise / FH;
    tex.updateMatrix();
  }
  core.add(at(new THREE.Mesh(fasciaGeometry(FW / 2, FH / 2, 0.04, 0.026, 0.014, curl), [title, mats.front]), 0, 0, zs));
  core.add(onFace(discSlot(0.66, mats), -0.62, io));
  core.add(onFace(powerButton(mats), 0.66, io));
  for (const x of [0.89, 1.02]) {
    const port = usbC(mats);
    port.scale.setScalar(1.3);
    core.add(onFace(port, x, io));
  }
  // the light line along the core's foot, in the joint with the lower cover
  core.add(at(rbox(FW - 0.1, 0.018, 0.018, 0.007, mats.light, 4), 0, -CY + 0.013, ZF - 0.004));
  // vents on both ends
  for (const s of [-1, 1]) {
    const v = ventGrille(1.0, 6, 0.05, mats);
    v.rotation.y = (s * Math.PI) / 2;
    core.add(at(v, s * (CX + 0.001), 0, -0.05));
  }
  shearInto(o, core, TR, -CY);


  // the open shell's mouths: where the covers lift away from the core towards its ends, a comb of dark fins over a
  // black backing fills each wedge — the console's vents, read from the front as a black waist flaring into the tips
  const finGeo = new THREE.BoxGeometry(1, 1, 1);
  for (const up of [true, false]) {
    const L = up ? LIFT.upper : LIFT.lower;
    const zf = up ? ZF - S - 0.004 : ZF - 0.004; // the wedge's front: the core's top or foot edge
    const base = up ? CY - 0.006 : -CY + 0.006;
    for (const s of [-1, 1]) {
      o.add(at(wedgePlate(s, up, L, mats.void), 0, base, zf - 0.17));
      for (let x = CX - 0.07; x > 0.45; x -= 0.034) {
        const open = G + L * flare(x) + 0.003; // from inside the core to just under the cover
        if (open < 0.03) break;
        const fin = new THREE.Mesh(finGeo, mats.fin);
        fin.scale.set(0.011, open, 0.36);
        o.add(at(fin, s * x, up ? base + open / 2 : base - open / 2, zf - 0.18));
      }
    }
  }

  // ── the covers
  const upper = coverGeometry(true);
  const lower = coverGeometry(false);
  // the upper cover's top falls off a little towards the back, as it would under a softbox in front of it
  const topWhite = mats.white.clone();
  topWhite.map = falloffMap(upper.B);
  o.add(new THREE.Mesh(upper.geometry, [topWhite, topWhite, mats.liner]));
  o.add(new THREE.Mesh(lower.geometry, [mats.white, mats.white, mats.liner]));
  // the light line along the upper cover's front edge, set into its undercut (round ends)
  const pts = [];
  const X1 = CA - CR - 0.02;
  const XL = -X1 + 0.08; // the turn shifts the cover's edge left of the core: start the line a little later
  for (let i = 0; i <= 160; i++) pts.push(upper.frontEdge(XL + ((X1 - XL) * i) / 160, 0.012, 0.002));
  const LR = 0.0076;
  o.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 320, LR, 12, false), mats.lightUp));
  for (const p of [pts[0], pts[pts.length - 1]]) o.add(at(new THREE.Mesh(new THREE.SphereGeometry(LR, 16, 10), mats.lightUp), p.x, p.y, p.z));

  // ── rubber feet under the lower cover's tips: the console rests on them, its middle floating a little
  lower.geometry.computeBoundingBox();
  const sole = lower.geometry.boundingBox.min.y - 0.006;
  const c = COVER.lower;
  for (const sx of [-1, 1])
    for (const zz of [lower.B - 0.22, -lower.B + 0.22]) {
      const x = sx * (CA - 0.2);
      const [px, py, pz] = lower.place(x, zz, -c.h - c.roll);
      const top = py + 0.004;
      const hgt = top - sole;
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, hgt, 40), mats.feet);
      o.add(at(foot, px, sole + hgt / 2, pz));
    }
  return o;
}
