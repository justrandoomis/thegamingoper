// kit.js — shared building blocks for the TamTam department doors (three.js, path traced).
// Materials, shapes, and the department name printed INTO a surface of the object.
// Object modules (objects/<door>.js) import from here; core.js renders them.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

export { THREE };

export const FONT = '"KufamLatin", "KufamArabic", "KufamArabicExt", sans-serif';

// ───────────────────────────── deterministic randomness (renders are repeatable)
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ───────────────────────────── procedural textures
function smooth(t) {
  return t * t * (3 - 2 * t);
}
/** Tileable value noise on a size×size grid of `cells`. */
function valueNoise(size, cells, seed) {
  const r = rng(seed);
  const grid = new Float32Array(cells * cells).map(() => r());
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * cells;
    const y0 = Math.floor(gy);
    const ty = smooth(gy - y0);
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const x0 = Math.floor(gx);
      const tx = smooth(gx - x0);
      const a = grid[(y0 % cells) * cells + (x0 % cells)];
      const b = grid[(y0 % cells) * cells + ((x0 + 1) % cells)];
      const c = grid[((y0 + 1) % cells) * cells + (x0 % cells)];
      const d = grid[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
      out[y * size + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return out;
}
/** A height field → tangent-space normal map canvas (OpenGL convention, +Y = +v). */
function heightToNormalCanvas(height, w, h, strength, wrap = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  const img = g.createImageData(w, h);
  const at = (x, y) => {
    if (wrap) return height[((y + h) % h) * w + ((x + w) % w)];
    return height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * strength; // canvas y is down; v is up (flipY)
      let nx = -dx;
      let ny = dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
const textureCache = new Map();
/**
 * A fine micro-texture normal map (moulded plastic grain, rubber, fabric), tileable.
 * kind: "grain" (fine plastic texture), "rubber" (softer, larger), "fabric" (woven cross-hatch).
 */
export function microNormal(kind = "grain", repeat = 6) {
  const key = `${kind}:${repeat}`;
  if (textureCache.has(key)) return textureCache.get(key);
  const size = 512;
  let height;
  if (kind === "fabric") {
    height = new Float32Array(size * size);
    const n = valueNoise(size, 64, 7);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const wx = Math.sin((x / size) * Math.PI * 2 * 48);
        const wy = Math.sin((y / size) * Math.PI * 2 * 48);
        height[y * size + x] = (Math.max(wx, 0) * 0.5 + Math.max(wy, 0) * 0.5) * 0.8 + n[y * size + x] * 0.4;
      }
  } else {
    const a = valueNoise(size, kind === "rubber" ? 48 : 128, 3);
    const b = valueNoise(size, kind === "rubber" ? 96 : 256, 5);
    height = a.map((v, i) => v * 0.6 + b[i] * 0.4);
  }
  const strength = kind === "fabric" ? 2.2 : kind === "rubber" ? 3.0 : 4.0;
  const tex = new THREE.CanvasTexture(heightToNormalCanvas(height, size, size, strength));
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.updateMatrix();
  textureCache.set(key, tex);
  return tex;
}

// ───────────────────────────── materials (MeshPhysicalMaterial — the path tracer supports these fields)
const P = (o) => new THREE.MeshPhysicalMaterial(o);
export const M = {
  /** Console-white moulded plastic, a faint clear coat. */
  white: (o = {}) => P({ color: "#f2f2f0", roughness: 0.34, clearcoat: 0.35, clearcoatRoughness: 0.22, normalMap: microNormal("grain", 10), normalScale: new THREE.Vector2(0.05, 0.05), ...o }),
  /** Piano-black gloss (touchpads, screens, console cores). */
  gloss: (o = {}) => P({ color: "#0a0a0c", roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.04, ...o }),
  /** Satin black plastic. */
  satin: (o = {}) => P({ color: "#141418", roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.35, ...o }),
  /** Textured black plastic (grips, housings), fine grain. */
  textured: (o = {}) => P({ color: "#17171b", roughness: 0.62, normalMap: microNormal("grain", 8), normalScale: new THREE.Vector2(0.35, 0.35), ...o }),
  /** Soft-touch rubber (sticks, cushions, cables). */
  rubber: (o = {}) => P({ color: "#101012", roughness: 0.82, normalMap: microNormal("rubber", 6), normalScale: new THREE.Vector2(0.25, 0.25), ...o }),
  /** The brand red, lacquered. */
  red: (o = {}) => P({ color: "#d3121b", roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1, ...o }),
  /** Mid grey plastic (handheld rails, Joy-Con-like greys). */
  grey: (o = {}) => P({ color: "#4f535b", roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.3, ...o }),
  /** Brushed / polished metals. */
  steel: (o = {}) => P({ color: "#d4d8de", metalness: 1, roughness: 0.24, ...o }),
  chrome: (o = {}) => P({ color: "#eef0f3", metalness: 1, roughness: 0.06, ...o }),
  gunmetal: (o = {}) => P({ color: "#2e3137", metalness: 0.85, roughness: 0.34, clearcoat: 0.4, clearcoatRoughness: 0.25, ...o }),
  gold: (o = {}) => P({ color: "#e6b75c", metalness: 1, roughness: 0.18, ...o }),
  /** Woven fabric / EVA shell cover with sheen. */
  fabric: (o = {}) => P({ color: "#1b1c21", roughness: 0.92, sheen: 1, sheenRoughness: 0.5, sheenColor: new THREE.Color("#5d6170"), normalMap: microNormal("fabric", 10), normalScale: new THREE.Vector2(0.6, 0.6), ...o }),
  /** Tinted clear plastic (game case shell). */
  clear: (color = "#2a56d6", o = {}) => P({ color, roughness: 0.08, transmission: 1, thickness: 0.05, ior: 1.49, attenuationColor: new THREE.Color(color), attenuationDistance: 0.6, ...o }),
  /** A light: emissive strip (light bars). Intensity is in scene units of radiance. */
  glow: (color = "#2f6bff", intensity = 6, o = {}) => P({ color: "#000000", emissive: color, emissiveIntensity: intensity, roughness: 0.3, ...o }),
};

// ───────────────────────────── tangents (normal maps need them in the path tracer)
/** Adds a tangent attribute (per-triangle for non-indexed geometry, MikkTSpace-like smooth for indexed). */
export function ensureTangents(geometry) {
  if (geometry.attributes.tangent || !geometry.attributes.uv || !geometry.attributes.normal) return geometry;
  if (geometry.index) {
    try {
      geometry.computeTangents();
      return geometry;
    } catch {
      /* fall through */
    }
  }
  const pos = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  const nor = geometry.attributes.normal;
  const count = pos.count;
  const tan = new Float32Array(count * 4);
  const idx = geometry.index ? geometry.index.array : null;
  const triCount = idx ? idx.length / 3 : count / 3;
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), t = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  for (let f = 0; f < triCount; f++) {
    const i0 = idx ? idx[f * 3] : f * 3, i1 = idx ? idx[f * 3 + 1] : f * 3 + 1, i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
    p0.fromBufferAttribute(pos, i0);
    p1.fromBufferAttribute(pos, i1);
    p2.fromBufferAttribute(pos, i2);
    const du1 = uv.getX(i1) - uv.getX(i0), dv1 = uv.getY(i1) - uv.getY(i0);
    const du2 = uv.getX(i2) - uv.getX(i0), dv2 = uv.getY(i2) - uv.getY(i0);
    e1.subVectors(p1, p0);
    e2.subVectors(p2, p0);
    const det = du1 * dv2 - du2 * dv1;
    const r = Math.abs(det) < 1e-12 ? 0 : 1 / det;
    t.copy(e1).multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(r);
    b.copy(e2).multiplyScalar(du1).addScaledVector(e1, -du2).multiplyScalar(r);
    for (const i of [i0, i1, i2]) {
      n.fromBufferAttribute(nor, i);
      const tt = t.clone().addScaledVector(n, -n.dot(t));
      if (tt.lengthSq() < 1e-12) tt.set(1, 0, 0).addScaledVector(n, -n.x);
      tt.normalize();
      const w = new THREE.Vector3().crossVectors(n, tt).dot(b) < 0 ? -1 : 1;
      tan[i * 4] = tt.x;
      tan[i * 4 + 1] = tt.y;
      tan[i * 4 + 2] = tt.z;
      tan[i * 4 + 3] = w;
    }
  }
  geometry.setAttribute("tangent", new THREE.BufferAttribute(tan, 4));
  return geometry;
}

// ───────────────────────────── shapes
export function at(obj, x = 0, y = 0, z = 0) {
  obj.position.set(x, y, z);
  return obj;
}
export function rot(obj, x = 0, y = 0, z = 0) {
  obj.rotation.set(x, y, z);
  return obj;
}
export function group(...children) {
  const g = new THREE.Group();
  for (const c of children.flat()) if (c) g.add(c);
  return g;
}
function mesh(geo, mat) {
  return new THREE.Mesh(geo, mat);
}
/** A rounded-rectangle outline (centred), corner radius r. */
export function roundedRect(w, h, r) {
  r = Math.max(0.0005, Math.min(r, w / 2 - 0.0005, h / 2 - 0.0005));
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
  return s;
}
/**
 * Extrudes a shape along +z, centred on z = 0, with a soft rounded bevel. `mat` may be one material or
 * [capMaterial, sideMaterial] (caps = front and back faces; sides include the bevel).
 * The caps' UVs are the shape's own x/y coordinates.
 */
export function extrude(shape, depth, bevel, mat, { bevelSegments = 10, curveSegments = 48 } = {}) {
  const b = Math.max(0, Math.min(bevel, depth / 2 - 0.0005));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.0001, depth - 2 * b), bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments, curveSegments });
  geo.translate(0, 0, -(depth - 2 * b) / 2);
  geo.computeVertexNormals();
  return mesh(geo, mat);
}
/** A slab: rounded rectangle w×h (corner r), depth d, rounded bevel. The outer size stays w×h. */
export function slab(w, h, d, r, mat, bevel = 0.025, opts) {
  return extrude(roundedRect(w, h, r), d, bevel, mat, opts);
}
/** A pill (stadium) slab. */
export function pill(w, h, d, mat, bevel = 0.03) {
  return slab(w, h, d, h / 2, mat, bevel);
}
export function rbox(w, h, d, r, mat, segments = 8) {
  return mesh(new RoundedBoxGeometry(w, h, d, segments, Math.min(r, w / 2 - 0.0005, h / 2 - 0.0005, d / 2 - 0.0005)), mat);
}
/** A cylinder whose axis points at the camera (+z). */
export function disc(r, h, mat, seg = 96, rTop = r) {
  const m = mesh(new THREE.CylinderGeometry(rTop, r, h, seg, 1), mat);
  m.rotation.x = Math.PI / 2;
  return m;
}
/** A lathe profile [[radius, height]…] spun round the y axis; `facing: "z"` turns its axis to the camera. */
export function lathe(points, mat, { segments = 96, facing = "y" } = {}) {
  const m = mesh(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), segments), mat);
  if (facing === "z") m.rotation.x = Math.PI / 2;
  return m;
}
export function ball(r, mat, w = 96, h = 64) {
  return mesh(new THREE.SphereGeometry(r, w, h), mat);
}
export function capsule(r, length, mat) {
  return mesh(new THREE.CapsuleGeometry(r, length, 16, 48), mat);
}
export function torus(radius, tube, mat, arc = Math.PI * 2, radialSegments = 32, tubularSegments = 160) {
  return mesh(new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments, arc), mat);
}
/** An arch in the xy plane from angle a0 to a1 (radians, 0 = +x). */
export function arch(radius, tube, a0, a1, mat) {
  const m = torus(radius, tube, mat, a1 - a0);
  m.rotation.z = a0;
  return m;
}
/** A tube along a smooth curve through points [[x,y,z]…]. */
export function tube(points, radius, mat, { closed = false, segments = 200, radial = 24 } = {}) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, "catmullrom", 0.5);
  return mesh(new THREE.TubeGeometry(curve, segments, radius, radial, closed), mat);
}
/**
 * A body extruded from a left-right symmetric outline: `half(shape)` draws the RIGHT half from the top centre
 * (x = 0) round to the bottom centre (x = 0); it is mirrored to close the outline.
 */
export function sculpt(half, depth, bevel, mat, opts) {
  const right = new THREE.Shape();
  half(right);
  const pts = right.getPoints(64);
  const all = [...pts, ...pts.slice(1, -1).reverse().map((q) => new THREE.Vector2(-q.x, q.y))];
  return extrude(new THREE.Shape(all), depth, bevel, mat, { bevelSegments: 14, ...opts });
}
/** Re-welds a mesh's vertices (keeping UVs) so its normals smooth across hard seams (for soft organic parts). */
export function smoothNormals(m) {
  const g = m.geometry.clone();
  g.deleteAttribute("normal");
  const welded = mergeVertices(g, 1e-4);
  welded.computeVertexNormals();
  m.geometry = welded;
  return m;
}

// ───────────────────────────── the department name, printed into a surface
function cssColor(c) {
  return "#" + new THREE.Color(c).getHexString();
}
/**
 * Draws the name onto canvases sized for a w×h face (world units): a colour map (face colour + ink), a roughness map
 * (ink a little more matte than the face) and a normal map (the letters stand up from the face by a hair, so their
 * edges catch the light). Returns textures mapped so the face's x/y coordinates [-w/2,w/2]×[-h/2,h/2] cover [0,1].
 *
 * opts: fitW, fitH (share of the face the text may fill), weight (CSS font weight), ink (colour), face (colour),
 *       relief (normal strength, 0 = flat print), inkRoughness, faceRoughness, dir ("rtl"/"ltr"), letterSpacing.
 */
export function printedTitle(text, lang, w, h, opts = {}) {
  const res = 2048;
  const W = res;
  const H = Math.max(64, Math.round((res * h) / w));
  const face = cssColor(opts.face ?? "#0b0b0d");
  const ink = cssColor(opts.ink ?? "#ffffff");
  const dir = opts.dir ?? (lang === "en" ? "ltr" : "rtl");
  const weight = opts.weight ?? 800;
  const maxW = W * (opts.fitW ?? 0.84);
  const maxH = H * (opts.fitH ?? 0.58);

  // measure: the largest size whose ink box fits
  const mc = document.createElement("canvas").getContext("2d");
  mc.direction = dir;
  let size = maxH * 1.3;
  let m;
  for (let i = 0; i < 200; i++) {
    mc.font = `${weight} ${size}px ${FONT}`;
    m = mc.measureText(text);
    const inkH = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    if ((m.width <= maxW && inkH <= maxH) || size < 24) break;
    size *= 0.97;
  }
  const baseline = H / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;

  // the ink mask
  const mask = document.createElement("canvas");
  mask.width = W;
  mask.height = H;
  const mg = mask.getContext("2d");
  mg.direction = dir;
  mg.textAlign = "center";
  mg.textBaseline = "alphabetic";
  mg.font = `${weight} ${size}px ${FONT}`;
  if (opts.letterSpacing) mg.letterSpacing = `${opts.letterSpacing}px`;
  mg.fillStyle = "#fff";
  mg.fillText(text, W / 2, baseline);

  // colour map: face colour + ink
  const color = document.createElement("canvas");
  color.width = W;
  color.height = H;
  const cg = color.getContext("2d");
  cg.fillStyle = face;
  cg.fillRect(0, 0, W, H);
  const inkLayer = document.createElement("canvas");
  inkLayer.width = W;
  inkLayer.height = H;
  const ig = inkLayer.getContext("2d");
  ig.fillStyle = ink;
  ig.fillRect(0, 0, W, H);
  ig.globalCompositeOperation = "destination-in";
  ig.drawImage(mask, 0, 0);
  cg.drawImage(inkLayer, 0, 0);

  // roughness map (green channel)
  const rough = document.createElement("canvas");
  rough.width = W;
  rough.height = H;
  const rg = rough.getContext("2d");
  const fr = Math.round(255 * (opts.faceRoughness ?? 0.12));
  const ir = Math.round(255 * (opts.inkRoughness ?? 0.42));
  rg.fillStyle = `rgb(${fr},${fr},${fr})`;
  rg.fillRect(0, 0, W, H);
  const rl = document.createElement("canvas");
  rl.width = W;
  rl.height = H;
  const rlg = rl.getContext("2d");
  rlg.fillStyle = `rgb(${ir},${ir},${ir})`;
  rlg.fillRect(0, 0, W, H);
  rlg.globalCompositeOperation = "destination-in";
  rlg.drawImage(mask, 0, 0);
  rg.drawImage(rl, 0, 0);

  // normal map from a blurred mask: the letters' edges lean outwards
  const relief = opts.relief ?? 1;
  let normal = null;
  if (relief > 0) {
    const blur = document.createElement("canvas");
    blur.width = W;
    blur.height = H;
    const bg = blur.getContext("2d");
    bg.filter = `blur(${Math.max(1.5, size * 0.018)}px)`;
    bg.drawImage(mask, 0, 0);
    const data = bg.getImageData(0, 0, W, H).data;
    const height = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) height[i] = data[i * 4 + 3] / 255;
    normal = heightToNormalCanvas(height, W, H, 14 * relief, false);
  }

  const mk = (canvas, colorSpace) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = colorSpace;
    t.anisotropy = 16;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(1 / w, 1 / h);
    t.offset.set(0.5, 0.5);
    t.updateMatrix();
    return t;
  };
  return {
    map: mk(color, THREE.SRGBColorSpace),
    roughnessMap: mk(rough, THREE.NoColorSpace),
    normalMap: normal ? mk(normal, THREE.NoColorSpace) : null,
    fontSize: size,
  };
}
/**
 * A face material that carries the printed name: `base` (a material from M) gives the finish; the face colour is
 * taken from it. Returns a new material.
 */
export function titleMaterial(text, lang, w, h, base, opts = {}) {
  const t = printedTitle(text, lang, w, h, { face: base.color, faceRoughness: base.roughness, ...opts });
  const m = base.clone();
  m.color = new THREE.Color("#ffffff");
  m.map = t.map;
  m.roughness = 1;
  m.roughnessMap = t.roughnessMap;
  if (t.normalMap) {
    m.normalMap = t.normalMap;
    m.normalScale = new THREE.Vector2(1, 1);
  } else {
    m.normalMap = null;
  }
  m.name = "title";
  return m;
}
/**
 * The usual title carrier: a slab whose FRONT face is printed with the name and whose sides keep the base finish.
 * Faces the camera (+z). Returns the mesh.
 */
export function titleSlab(text, lang, w, h, d, r, base, opts = {}, bevel = 0.025) {
  const side = base.clone();
  const cap = titleMaterial(text, lang, w, h, base, opts);
  return slab(w, h, d, r, [cap, side], bevel);
}

// ───────────────────────────── fonts
export async function loadFonts() {
  const faces = [
    new FontFace("KufamLatin", "url(/fonts/kufam-latin-wght.7073ba7c.woff2)", { weight: "400 900" }),
    new FontFace("KufamArabic", "url(/fonts/kufam-arabic-wght.3e456e1b.woff2)", { weight: "400 900" }),
    new FontFace("KufamArabicExt", "url(/fonts/kufam-arabic-wght-ext.c2703ab5.woff2)", { weight: "400 900" }),
  ];
  for (const face of faces) document.fonts.add(await face.load());
}
