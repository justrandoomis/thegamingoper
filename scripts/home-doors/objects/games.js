// «الألعاب» — video games: three Blu-ray-size keep cases in smoke-grey polypropylene and a disc. The front case, turned
// landscape with its spine on top, carries the name on its near-black sleeved cover under a thin brand-red header line, and
// leans back a little until its top edge rests on the right end of the case behind it. The two rear cases stand flat on
// the table turned away to the left, so perspective fans their tops up to the left while their right ends step down,
// clear of the front case's corner. The disc stands on its rim behind the front case's right end, its hole half out,
// data side out — clear hub over the label's printed reverse, mirror band, plain brushed-silver data area —
// leaning back onto the middle case's corner. Every contact is solved from the geometry; nothing floats.
// Units: 1 = 10 cm (case 17 × 13.5 × 1.4 cm, disc 12 cm Ø × 1.2 mm). The table is y = 0.
import { THREE, at, roundedRect, extrude, slab, torus, tube, titleMaterial } from "../kit.js";

export const meta = { turn: -0.28, tilt: 0, gap: 0.04, margin: [0.85, 0.82], centerY: 0.04 };

const P = (o) => new THREE.MeshPhysicalMaterial(o);

// ───────────────────────────── dimensions and placement
const W = 1.7, H = 1.35, D = 0.14; // a keep case lying landscape
const R = 0.06; // its corner radius (6 mm)
const B = 0.016; // its edge round-over (1.6 mm)
const MG = 0.032; // the insert's margin from the case edge
const T0 = 0.0006, T1 = 0.0016; // the insert sheet's back and front, over the shell face
const LEAN = 0.15; // the front case leans back (rad): enough to rest, not so much that the sleeve mirrors the key light
const BAND = 0.045; // the cover's red header (4.5 mm): an accent line, wrapping over the spine
const DISC_X = 0.86; // the disc's foot: its hub crosses the front case's right wall, the hole half out — sliding out from behind
const DISC_Z = -0.012; // just behind the front case's foot
const DISC_LEAN = 0.254; // the disc's lean: its mirror then holds the key light's lower edge (≤ 0.23 it goes black)
const MID = { yaw: 0.5 }; // the rear cases stand on the table turned away to the left (right ends forward):
const FAR = { dx: -0.18, yaw: 0.64 }; // perspective raises their far ends into a fan, and their right ends step left

// ───────────────────────────── materials
/** The case's tinted polypropylene: a skin over a pale core (what the hollow case shows inside: the tray, the insert's
 * white reverse); the caps are thin and clear, the moulded edges a little denser and softer. */
function shellMats(tint, deep, { cap = 0.2, side = 0.12 } = {}) {
  return [
    P({ color: tint, roughness: 0.05, transmission: 1, thickness: 0.14, ior: 1.5, attenuationColor: new THREE.Color(deep), attenuationDistance: cap }),
    P({ color: tint, roughness: 0.12, transmission: 1, thickness: 0.05, ior: 1.5, attenuationColor: new THREE.Color(deep), attenuationDistance: side }),
  ];
}
const SMOKE = { tint: "#c9ccd3", deep: "#3a3e46", core: "#b4b8c0", glow: 0.15 };
/** Printed card under the clear sleeve: the sleeve's gloss is the print's own specular lobe (it converges far faster
 * than a clearcoat in the tracer, which samples a clearcoat only ~4% of the time). */
const print = (color, roughness = 0.1, o = {}) => P({ color, roughness, ...o });
const clearFilm = () => P({ color: "#ffffff", roughness: 0.03, transmission: 1, thickness: 0.004, ior: 1.5 });

// a rounded rectangle with per-corner radii, centred
function rrect(w, h, tl, tr, br, bl) {
  const s = new THREE.Shape();
  const x = w / 2, y = h / 2;
  s.moveTo(-x + bl, -y);
  s.lineTo(x - br, -y);
  if (br) s.absarc(x - br, -y + br, br, -Math.PI / 2, 0, false);
  s.lineTo(x, y - tr);
  if (tr) s.absarc(x - tr, y - tr, tr, 0, Math.PI / 2, false);
  s.lineTo(-x + tl, y);
  if (tl) s.absarc(-x + tl, y - tl, tl, Math.PI / 2, Math.PI, false);
  s.lineTo(-x, -y + bl);
  if (bl) s.absarc(-x + bl, -y + bl, bl, Math.PI, Math.PI * 1.5, false);
  return s;
}
const sheet = (shape, depth, mats) => extrude(shape, depth, 0, mats, { curveSegments: 16 });
const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

// ───────────────────────────── a keep case
/** The printed insert where it wraps over the spine: a thin C-section following the shell's rounded top edge. */
function spineWrap(L, mat, lip = 0.05) {
  const s = new THREE.Shape();
  const d = D, h = H, b = B;
  const fx = d / 2 - b, bx = -d / 2 + b, cy = h / 2 - b; // arc centres (x = depth z, y = height)
  s.moveTo(d / 2 + T1, cy);
  s.absarc(fx, cy, b + T1, 0, Math.PI / 2, false);
  s.lineTo(bx, h / 2 + T1);
  s.absarc(bx, cy, b + T1, Math.PI / 2, Math.PI, false);
  s.lineTo(-d / 2 - T1, cy - lip);
  s.lineTo(-d / 2 - T0, cy - lip);
  s.lineTo(-d / 2 - T0, cy);
  s.absarc(bx, cy, b + T0, Math.PI, Math.PI / 2, true);
  s.lineTo(fx, h / 2 + T0);
  s.absarc(fx, cy, b + T0, Math.PI / 2, 0, true);
  s.closePath();
  const m = extrude(s, L, 0, mat, { curveSegments: 10 });
  m.rotation.y = -Math.PI / 2;
  return m;
}
/** The sleeve where it drapes over the insert's edge: a fine clear bead round the left, bottom and right of the insert. */
function sleeveBead(iw, top, bot, ir, z) {
  const pts = [];
  const o = 0.0006; // just outside the paper edge
  const x = iw / 2 + o, yb = bot - o, yt = top;
  const r = ir + o;
  const line = (x0, y0, x1, y1, n) => {
    for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, z]);
  };
  const arc = (cx, cy, a0, a1, n) => {
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
    }
  };
  // top-left corner arc (from the spine round-over) → down the left → bottom → up the right → top-right arc
  arc(-x + r, yt - ir, Math.PI / 2, Math.PI, 8);
  line(-x, yt - ir, -x, yb + r, 40);
  arc(-x + r, yb + r, Math.PI, Math.PI * 1.5, 10);
  line(-x + r, yb, x - r, yb, 50);
  arc(x - r, yb + r, -Math.PI / 2, 0, 10);
  line(x, yb + r, x, yt - ir, 40);
  arc(x - r, yt - ir, 0, Math.PI / 2, 8);
  pts.push([x - r, yt - ir + r, z]);
  return tube(pts, 0.0018, clearFilm(), { segments: 600, radial: 8 });
}
/**
 * A Blu-ray-size keep case lying landscape, spine on top, centred: the insert's header band runs up the cover and over
 * the spine (two hinge grooves), the tinted rim shows on the three opening edges, which carry the parting seam.
 */
function gameCase({ tint, deep, core, glow = 0.15, band, cover, spine = band, bandH = BAND, title, att }) {
  const g = new THREE.Group();
  const w = W, h = H, d = D;
  g.add(extrude(roundedRect(w, h, R), d, B, shellMats(tint, deep, att), { bevelSegments: 8, curveSegments: 20 }));
  // what the thin skin shows: the hollow case's insides (tray, insert reverse) as one opaque core, clear of the corners;
  // its faint glow stands in for the light the moulding pipes round from its lit faces, so the rims in shade still glow
  const sk = 0.016;
  g.add(slab(w - 2 * sk, h - 2 * sk, d - 2 * sk, R - sk, P({ color: core, roughness: 0.5, emissive: core, emissiveIntensity: glow }), 0.006));
  // the insert under the sleeve: corners concentric with the moulding
  const iw = w - 2 * MG;
  const ir = R - MG;
  const top = h / 2 - B;
  const bot = -h / 2 + MG;
  const th = top - bandH - bot;
  const z = d / 2 + (T0 + T1) / 2;
  const edge = print("#e9e9e6", 0.5);
  // (the band's sheen is held back a little so the brand red stays saturated under the sleeve)
  g.add(at(sheet(rrect(iw, bandH, ir, ir, 0, 0), T1 - T0, [print(band, 0.1, { specularIntensity: 0.6 }), edge]), 0, top - bandH / 2, z));
  const base = print(cover, 0.08);
  const coverMat = title ? titleMaterial(title.text, title.lang, iw, th, base, { fitW: 0.58, fitH: 0.44, relief: 0, inkRoughness: 0.1 }) : base;
  g.add(at(sheet(rrect(iw, th, 0, 0, ir, ir), T1 - T0, [coverMat, edge]), 0, bot + th / 2, z));
  g.add(sleeveBead(iw, top, bot, ir, d / 2 + 0.00185));
  // the insert wraps round to the back cover: what the clear edges show from behind is the paper's white reverse
  const back = print("#e4e5e7", 0.5);
  g.add(at(sheet(rrect(iw, top - bot, ir, ir, ir, ir), T1 - T0, [back, edge]), 0, (top + bot) / 2, -z));
  // the spine: the band wraps over the straight part of the top edge (stopping just inside the corners' tangents)
  const L = w - 2 * R - 0.008;
  const spineMat = print(spine, 0.14);
  g.add(spineWrap(L, [spineMat, spineMat]));
  // two hinge grooves cut along it: a dark channel with a lit far lip, flush with the wrap
  const groove = P({ color: "#07080b", roughness: 0.7 });
  const lipMat = print("#c9ccd2", 0.35);
  for (const s of [-1, 1]) {
    const zc = s * (d / 2 - B - 0.012);
    g.add(at(box(L, 0.0004, 0.014, groove), 0, h / 2 + T1 - 0.00015, zc));
    g.add(at(box(L, 0.0004, 0.003, lipMat), 0, h / 2 + T1 - 0.00012, zc - 0.0085)); // the far wall, facing the camera
  }
  // the parting seam where the lid closes on the tray, on the opening edges: a hair that just breaks the wall
  const seamMat = P({ color: "#0a0c12", roughness: 0.45 });
  for (const s of [-1, 1]) g.add(at(box(0.0012, h - 2 * R, 0.004, seamMat), s * (w / 2 - 0.0004), 0, -0.012));
  g.add(at(box(w - 2 * R, 0.0012, 0.004, seamMat), 0, -h / 2 + 0.0004, -0.012));
  return g;
}

// ───────────────────────────── the disc
function spectrum(t) {
  // 380–700 nm → sRGB-ish (Bruton), t in [0,1]
  const wl = 380 + Math.min(1, Math.max(0, t)) * 320;
  let r = 0, g = 0, b = 0;
  if (wl < 440) { r = -(wl - 440) / 60; b = 1; }
  else if (wl < 490) { g = (wl - 440) / 50; b = 1; }
  else if (wl < 510) { g = 1; b = -(wl - 510) / 20; }
  else if (wl < 580) { r = (wl - 510) / 70; g = 1; }
  else if (wl < 645) { r = 1; g = -(wl - 645) / 65; }
  else r = 1;
  const f = wl < 420 ? 0.3 + (0.7 * (wl - 380)) / 40 : wl > 680 ? 0.3 + (0.7 * (700 - wl)) / 20 : 1;
  return [r * f, g * f, b * f];
}
const wrapA = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (n) => { let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };
const STREAK = 0; // no diffraction colour: the data side is plain brushed silver
let discTex = null;
/** The data side: a silver mirror (F0) with two opposite diffraction streaks; the emissive map holds the same colours. */
function discTextures() {
  if (discTex) return discTex;
  const N = 2048; // the tracer's texture size: one texel per texel, no resampling
  const mk = () => {
    const c = document.createElement("canvas");
    c.width = c.height = N;
    return c;
  };
  const cc = mk(), ec = mk();
  const cg = cc.getContext("2d"), eg = ec.getContext("2d");
  const ci = cg.createImageData(N, N), ei = eg.createImageData(N, N);
  let seed = 7; // a triangular dither: the gentle angular sheen spans only ~15 grey levels a quarter turn, and plain
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296); // rounding bands it into wedges
  const q = (v) => Math.max(0, Math.min(255, Math.round(255 * Math.min(1, v) + rnd() + rnd() - 1)));
  const th0 = 2.35; // the streaks' axis (upper left ↔ lower right): towards the key light; the lower one shows
  const sg = 0.36;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = ((x + 0.5) / N) * 2 - 1;
      const v = 1 - ((y + 0.5) / N) * 2;
      const r = Math.hypot(u, v); // 1 = rim (0.6 units)
      const a = Math.atan2(v, u);
      const dA = wrapA(a - th0), dB = wrapA(a - th0 - Math.PI);
      const wA = Math.exp(-((dA / sg) ** 2)), wB = Math.exp(-((dB / sg) ** 2));
      // the written layer ends at 80% of the radius; the zones read as faint, soft rings
      const outer = sstep(0.788, 0.812, r);
      const written = 1 - 0.45 * outer;
      const zone = 0.985 + 0.015 * sstep(0.568, 0.592, r) + 0.03 * outer;
      const tA = 0.5 + dA / (2.3 * sg) + (r - 0.68) * 0.55;
      const tB = 0.5 - dB / (2.3 * sg) + (r - 0.68) * 0.55;
      const sA = spectrum(tA), sB = spectrum(tB);
      const sheen = 0.9 + 0.1 * Math.cos(2 * (a - th0 - 0.7));
      const brush = 1 + 0.035 * (hash(Math.round(r * 1400)) - 0.5) + 0.02 * (hash(Math.round(r * 380) + 9001) - 0.5); // fine concentric lathe lines
      const silver = 0.5 * zone * sheen * brush;
      const i = (y * N + x) * 4;
      for (let k = 0; k < 3; k++) {
        const col = sA[k] * wA + sB[k] * wB;
        const w = Math.min(1, (wA + wB) * STREAK * written);
        ci.data[i + k] = q(silver * (1 - w) + (0.1 + (0.9 * col) / Math.max(1e-3, wA + wB)) * w);
        ei.data[i + k] = q(col * written);
      }
      ci.data[i + 3] = ei.data[i + 3] = 255;
    }
  }
  cg.putImageData(ci, 0, 0);
  eg.putImageData(ei, 0, 0);
  const tex = (c, cs) => {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = cs;
    t.anisotropy = 16;
    t.repeat.set(1 / 1.2, 1 / 1.2);
    t.offset.set(0.5, 0.5);
    t.updateMatrix();
    return t;
  };
  discTex = { map: tex(cc, THREE.SRGBColorSpace), emissiveMap: tex(ec, THREE.SRGBColorSpace) };
  return discTex;
}
const DT = 0.012; // the disc's thickness
const SEG = 512; // steps round the disc
/** A flat ring facing +z (or −z), finely subdivided both ways, its normals exact; UVs are its own x/y (as an extrude cap). */
function ringFace(r0, r1, z, mat, { facing = 1, theta = SEG, phi = 8 } = {}) {
  const g = new THREE.RingGeometry(r0, r1, theta, phi);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i), p.getY(i));
  if (facing < 0) g.rotateY(Math.PI);
  g.translate(0, 0, z);
  return new THREE.Mesh(g, mat);
}
/** A surface of revolution about the disc's axis from a profile [[r, z]…]; a profile run anticlockwise in (r, z) faces
 * out of the solid (lathe normals are analytic, so no facets). */
function revolve(profile, mat, segments = SEG) {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(r, z)), segments);
  g.rotateX(Math.PI / 2);
  return new THREE.Mesh(g, mat);
}
/** A cylindrical wall of radius r from z0 to z1, facing away from the axis (or towards it). */
const wall = (r, z0, z1, mat, inward = false) => revolve(inward ? [[r, z1], [r, z0]] : [[r, z0], [r, z1]], mat);
/** Points along a straight run (n steps) and a quarter arc, for lathe profiles. */
const run = (a, b, n) => Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
const arcPts = (cx, cz, r, a0, a1, n) => Array.from({ length: n }, (_, i) => [cx + r * Math.cos(a0 + ((a1 - a0) * i) / n), cz + r * Math.sin(a0 + ((a1 - a0) * i) / n)]);
/** A 12 cm disc facing +z, centred: hole → clear clamping hub (over the label's printed reverse) with its stacking ring
 * → mirror band → data → clear rim. Every face is a fine ring or a lathe, so the mirror shows no wedges. */
function gameDisc() {
  const g = new THREE.Group();
  const t = DT / 2;
  const { map } = discTextures();
  const data = P({ color: "#ffffff", map, metalness: 1, roughness: 0.14 }); // plain brushed silver: no emissive, no iridescence
  const label = print("#16171c", 0.4);
  const clear = P({ color: "#ffffff", roughness: 0.04, transmission: 1, thickness: 0.012, ior: 1.58, attenuationColor: new THREE.Color("#8a9098"), attenuationDistance: 0.014 });
  const mirror = P({ color: "#767a82", metalness: 1, roughness: 0.1 }); // a step under the data silver, so it doesn't outshine the name
  const ink = P({ color: "#d3d5da", roughness: 0.45 }); // the label's white print, seen from behind through the hub
  // the metallised body, 0.17–0.585: data face and mirror band in front, the label behind, closed by its two walls
  g.add(ringFace(0.225, 0.585, t, data, { phi: 16 }));
  g.add(ringFace(0.17, 0.225, t, mirror, { phi: 4 }));
  g.add(ringFace(0.17, 0.585, -t, label, { facing: -1, theta: 256, phi: 8 }));
  g.add(wall(0.585, -t, t, label));
  g.add(wall(0.17, -t, t, label, true));
  // the clear rim 0.585–0.6, its outer edge rounded (r = 4 mm… of a 1.2 mm disc: a soft 0.4 mm round-over)
  const rb = 0.004, r0 = 0.5852;
  g.add(revolve([...run([r0, -t], [0.6 - rb, -t], 3), ...arcPts(0.6 - rb, -t + rb, rb, -Math.PI / 2, 0, 6), ...run([0.6, -t + rb], [0.6, t - rb], 2), ...arcPts(0.6 - rb, t - rb, rb, 0, Math.PI / 2, 6), [0.6 - rb, t], [r0, t]], clear));
  g.add(wall(r0, -t, t, clear, true));
  // the clear clamping hub 0.075–0.17 (its back 1 mm short of the label), the hole's edges rounded
  const hb = 0.0025, h0 = -t + 0.001, h1 = t, r1 = 0.1698, rh = 0.075;
  g.add(revolve([...run([r1, h1], [rh + hb, h1], 8), ...arcPts(rh + hb, h1 - hb, hb, Math.PI / 2, Math.PI, 6), ...run([rh, h1 - hb], [rh, h0 + hb], 2), ...arcPts(rh + hb, h0 + hb, hb, Math.PI, Math.PI * 1.5, 6), ...run([rh + hb, h0], [r1, h0], 8), [r1, h0]], clear));
  g.add(wall(r1, h0, h1, clear));
  // the label's print behind the hub, seen through it
  const k0 = 0.0765, k1 = 0.1685, kz = -t + 0.0008;
  g.add(ringFace(k0, k1, kz, ink, { phi: 3 }));
  g.add(ringFace(k0, k1, -t, label, { facing: -1, theta: 256, phi: 2 }));
  g.add(wall(k1, -t, kz, label));
  g.add(wall(k0, -t, kz, label, true));
  g.add(at(torus(0.163, 0.0025, clear, Math.PI * 2, 12, SEG), 0, 0, t)); // the moulded stacking ring, half sunk
  return g;
}

// ───────────────────────────── placing things on the table
/** Stands a centred case on the table: its bottom-back edge on the floor line through (x, 0, z), leaning back about it. */
function stand(obj, { x = 0, z = 0, lean = 0 }) {
  const p = new THREE.Group();
  p.add(at(obj, 0, H / 2, D / 2));
  p.position.set(x, 0, z);
  p.rotation.x = -lean;
  return p;
}
/**
 * Where an upright case stands when turned about the vertical so its right end comes forward by `yaw`, with the
 * frontmost point of its right end (on the rounded front-right edge) at (xr, ·, zr): its group position and its front
 * (insert) and back planes as z(X) over the case's x extent.
 */
function placeYaw({ xr, zr, yaw }) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const px = W / 2 - B + B * s, pz = D / 2 - B + B * c; // the frontmost point, in the case's own frame
  const gx = xr - (px * c - pz * s), gz = zr - (px * s + pz * c);
  // a case-frame point (x, z) lands at X = gx + x·c − z·s, Z = gz + x·s + z·c
  const plane = (zl) => (X) => gz + zl * c + (X - gx + zl * s) * Math.tan(yaw);
  const x0 = gx - (W / 2) * c - (D / 2) * s, x1 = gx + (W / 2) * c - (D / 2) * s; // the front face's ends
  return { xr, gx, gz, yaw, front: plane(D / 2 + T1), back: plane(-D / 2 - T1), x0, x1 };
}
function standYaw(obj, pl) {
  const g = new THREE.Group();
  g.add(at(obj, 0, H / 2, 0));
  g.rotation.y = -pl.yaw;
  g.position.set(pl.gx, 0, pl.gz);
  return g;
}
/**
 * The disc's lean: it stands on its rim at (DISC_X, 0, DISC_Z) and leans back until its back face first touches the
 * case behind it (front plane z = front(X) over x0…x1, up to the case's height).
 */
function discLean(mid) {
  let best = 0.6;
  for (let u = -0.6; u <= 0.6; u += 0.002) {
    const X = DISC_X + u;
    if (X < mid.x0 || X > mid.x1) continue;
    const K = DISC_Z - mid.front(X);
    for (let v = 0.2; v <= 1.2; v += 0.002) {
      if (u * u + (v - 0.6) ** 2 > 0.36) continue;
      // v·sin(lean) + (T/2)·cos(lean) = K at contact; the first point to reach the case sets the lean
      let lean = 0.25;
      for (let it = 0; it < 6; it++) lean = Math.asin(Math.min(0.95, Math.max(0, (K - (DT / 2) * Math.cos(lean)) / v)));
      if (v * Math.cos(lean) > H) continue;
      best = Math.min(best, lean);
    }
  }
  return best;
}
/** The middle case's right end, slid along the front case's top edge until the disc resting on it leans DISC_LEAN. */
function solveMid(zf) {
  let lo = DISC_X - 0.6 + 0.002, hi = 0.5;
  for (let i = 0; i < 22; i++) {
    const xr = (lo + hi) / 2;
    if (discLean(placeYaw({ xr, zr: zf, yaw: MID.yaw })) > DISC_LEAN) lo = xr;
    else hi = xr;
  }
  return placeYaw({ xr: hi, zr: zf, yaw: MID.yaw });
}

export function build({ text, lang }) {
  const o = new THREE.Group();
  // the front case leans back on its bottom-back edge
  o.add(stand(gameCase({ ...SMOKE, band: "#d3121b", cover: "#141519", title: { text, lang } }), { lean: LEAN }));
  // its top-back edge (the wrapped spine's round-over) is its furthest-back point: the middle case's right end touches it
  const zf = -(H - B) * Math.sin(LEAN) + B * Math.cos(LEAN) - (B + T1);
  const mid = solveMid(zf);
  o.add(standYaw(gameCase({ ...SMOKE, band: "#262a31", cover: "#141922" }), mid));
  // the far case's right end rests on the middle case's back, a step to the left
  const xf = mid.xr + FAR.dx;
  const far = placeYaw({ xr: xf, zr: mid.back(xf) - 0.0004, yaw: FAR.yaw });
  o.add(standYaw(gameCase({ ...SMOKE, band: "#8a919b", spine: "#b0b6be", cover: "#15171c" }), far));
  // the disc stands on its rim behind the front case's foot, leaning back onto the middle case's corner
  const dsk = new THREE.Group();
  dsk.add(at(gameDisc(), 0, 0.6, 0));
  dsk.rotation.x = -discLean(mid);
  o.add(at(dsk, DISC_X, 0.0015, DISC_Z));
  return o;
}
