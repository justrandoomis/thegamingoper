/**
 * TamTam clay renders — scene kit.
 *
 * One module that every model and the render page share, so the whole set looks like one
 * family: same light rig, same material recipe, same camera language.
 *
 *   models/<key>.mjs   export function build(kit, options) → THREE.Object3D   (millimetres)
 *   render.html        createStage().render(object, { view }) → RGBA pixels
 *
 * Browser ES module. `three` and `three/addons/` come from the import map in render.html
 * (served from /node_modules/three); the geometry / material half also imports in Node,
 * which is how build.mjs and the tests reach `expectedAspect()`.
 *
 * Conventions
 *   - Units are millimetres. +X is the device's right (seen from the front), +Y is up,
 *     +Z points at the viewer: the front face of a device looks down +Z.
 *   - Geometry helpers return closed, non-indexed BufferGeometry with creased normals
 *     (smooth where faces meet under ~40°, hard above), ready for `mesh()`.
 *   - Flat things (`slab`, `extrude`) are drawn as a 2D outline in XY and get their
 *     thickness along +Z. Round things (`lathe`, `puck`, `ring`) spin around +Y.
 *     Every helper takes `axis` to point that native axis somewhere else.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export { THREE };

const DEG = Math.PI / 180;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ────────────────────────────────────────────────────────────────────────────
 * 1. Camera language
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The three views of scripts/art/catalog.json.
 *   azimuth    degrees the camera orbits around the object, 0 = straight in front, positive =
 *              towards the device's right side. The light rig orbits with the camera, so the key
 *              light always falls from the upper left of the picture.
 *   elevation  degrees above the horizon.
 *   lens       camera distance in units of the object's bounding radius: bigger = flatter
 *              perspective (7.5 ≈ a 100 mm product lens).
 * A model may override any of these per view: `export const views = { hero: { azimuth: -32 } }`.
 */
export const VIEWS = Object.freeze({
  hero: Object.freeze({ azimuth: 30, elevation: 18, lens: 7.5 }),
  front: Object.freeze({ azimuth: 0, elevation: 4, lens: 12 }),
  back: Object.freeze({ azimuth: 210, elevation: 18, lens: 7.5 }),
});

/** Share of the frame (larger side) the object and its shadow occupy: 8% padding on each side. */
export const FILL = 0.84;

export function resolveView(view = 'hero', overrides) {
  if (typeof view === 'object') return { ...VIEWS.hero, ...view };
  const base = VIEWS[view];
  if (!base) throw new Error(`kit: unknown view "${view}" (expected ${Object.keys(VIEWS).join(', ')})`);
  return { ...base, ...(overrides && overrides[view]) };
}

function orbitDirection(azimuthDeg, elevationDeg, out = new THREE.Vector3()) {
  const a = azimuthDeg * DEG, e = elevationDeg * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

/**
 * Rough width / height of the finished picture for a box of the catalogue size, without rendering
 * anything. Used for the placeholder block of art that has no render yet.
 */
export function expectedAspect(mm, view = 'hero', overrides) {
  const v = resolveView(view, overrides);
  const [w, h, d] = mm;
  const radius = 0.5 * Math.hypot(w, h, d);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, radius * 40);
  const centre = new THREE.Vector3(0, h / 2, 0);
  camera.position.copy(centre).addScaledVector(orbitDirection(v.azimuth, v.elevation), v.lens * radius);
  camera.lookAt(centre);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const p = new THREE.Vector3();
  for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
    p.set((sx * w) / 2, sy * h, (sz * d) / 2).project(camera);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const bw = maxX - minX, bh = maxY - minY;
  const pad = (Math.max(bw, bh) * (1 - FILL)) / (2 * FILL);
  return (bw + 2 * pad) / (bh + 2 * pad);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 2. Light rig (shared by every render — do not tune per model)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Soft studio lighting, expressed as what falls on the object rather than as lamps:
 *   key     large softbox, upper left of the picture (a cone of directions `radius` degrees wide)
 *   sky     big overhead dome: the fill, and the source of the soft contact shadows
 *   bounce  light coming back up from a pale floor
 *   rim     narrow light from behind, opposite the key, so dark objects keep an edge
 * `irradiance` is in scene-linear units on a surface that faces the light; a white clay surface
 * turned to the key ends up just under paper white.
 * Every frame is the average of many renders, each with one direction drawn from each of the four
 * sources and a sub-pixel camera shift. That is what makes the shadows soft and the edges clean.
 */
export const RIG = Object.freeze({
  exposure: 1.3,
  key: Object.freeze({ azimuth: -42, elevation: 48, radius: 17, irradiance: 2.15, color: '#fff8ee', ground: 0.14 }),
  sky: Object.freeze({ minElevation: 6, irradiance: 1.3, color: '#edf2ff', ground: 1 }),
  bounce: Object.freeze({ maxElevation: -8, irradiance: 0.42, color: '#fff7ef' }),
  rim: Object.freeze({ azimuth: 138, elevation: 26, radius: 9, irradiance: 1.1, color: '#f3f6ff', ground: 0 }),
  ambient: 0.16,
  /**
   * Contact shadow. `ground` above is how much each light counts on the floor: mostly the
   * overhead part of the sky (a tight pool under the object), a touch of key for direction, no
   * long cast shadows. darkness: opacity where the floor is fully covered · floor: occlusion
   * below this is dropped, so the shadow ends · gamma: falloff · fade: where it must be gone,
   * as distances past the object's footprint in units of its radius.
   */
  shadow: Object.freeze({ darkness: 0.78, floor: 0.035, gamma: 1.15, fade: Object.freeze([0.03, 0.36]) }),
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. Colours and materials
 * ──────────────────────────────────────────────────────────────────────────── */

/** House colours. "black" hardware is charcoal on purpose: pure black loses its form. */
export const colors = Object.freeze({
  black: '#2a2b2f',
  jet: '#18191c',
  graphite: '#3d3f45',
  slate: '#5b5e66',
  grey: '#9a9da3',
  silver: '#c9cbcf',
  white: '#f3f2ee',
  red: '#e2231a',
  coral: '#ff5f52',
  orange: '#ff7a1a',
  yellow: '#ffc93c',
  green: '#1f9d3a',
  turquoise: '#18b5b0',
  lightBlue: '#35b4ea',
  blue: '#1d5fe0',
  navy: '#1c2f5e',
  violet: '#7b4bea',
  nintendo: '#e60012',
  playstation: '#0057d9',
  xbox: '#107c10',
  handheld: '#7b4bea',
});

function patched(source, find, replacement, label) {
  if (!source.includes(find)) {
    throw new Error(`kit: shader patch "${label}" does not match three r${THREE.REVISION}; update kit.mjs`);
  }
  return source.replace(find, replacement);
}

let physicalChunks = null;
function patchedPhysicalChunks() {
  if (physicalChunks) return physicalChunks;
  let pars = THREE.ShaderChunk.lights_physical_pars_fragment;
  pars = patched(pars,
    'clearcoatSpecularDirect += ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );',
    'clearcoatSpecularDirect += ttDirect.y * ccIrradiance * BRDF_GGX_Clearcoat( directLight.direction, geometryViewDir, geometryClearcoatNormal, material );',
    'direct clearcoat');
  pars = patched(pars,
    'reflectedLight.directSpecular += irradiance * specularBRDF * material.multiScatteringCompensation;',
    'reflectedLight.directSpecular += ttDirect.x * irradiance * specularBRDF * material.multiScatteringCompensation;',
    'direct specular');
  let maps = THREE.ShaderChunk.lights_fragment_maps;
  maps = patched(maps,
    'iblIrradiance += getIBLIrradiance( geometryNormal );',
    'iblIrradiance += ttIbl.x * getIBLIrradiance( geometryNormal );',
    'ibl diffuse');
  maps = patched(maps, 'radiance += iblRadiance;', 'radiance += ttIbl.y * iblRadiance;', 'ibl specular');
  maps = patched(maps,
    'clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );',
    'clearcoatRadiance += ttIbl.z * getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );',
    'ibl clearcoat');
  physicalChunks = { pars: 'uniform vec2 ttDirect;\nuniform vec3 ttIbl;\n' + pars, maps };
  return physicalChunks;
}

/**
 * MeshPhysicalMaterial wired to the rig.
 *
 * The rig lights the scene twice: many shadowed directional samples (soft shadows, but a glossy
 * surface would show them as separate dots) and one blurred studio environment (smooth
 * reflections, but no shadows). Each lobe of a material listens to the half that suits it:
 * rough lobes (roughness ≥ 0.45) take the shadowed samples, glossy lobes take the environment.
 * Diffuse light always comes from the shadowed samples.
 */
function physical(parameters, mix = {}) {
  const material = new THREE.MeshPhysicalMaterial(parameters);
  const roughBase = material.roughness >= 0.45;
  const roughCoat = material.clearcoatRoughness >= 0.45;
  const direct = new THREE.Vector2(mix.directSpecular ?? (roughBase ? 1 : 0), mix.directCoat ?? (roughCoat ? 1 : 0));
  const ibl = new THREE.Vector3(mix.iblDiffuse ?? 0, mix.iblSpecular ?? (roughBase ? 0 : 1), mix.iblCoat ?? (roughCoat ? 0 : 1));
  material.userData.tt = { direct, ibl };
  material.onBeforeCompile = (shader) => {
    const chunks = patchedPhysicalChunks();
    shader.uniforms.ttDirect = { value: direct };
    shader.uniforms.ttIbl = { value: ibl };
    shader.fragmentShader = patched(shader.fragmentShader, '#include <lights_physical_pars_fragment>', chunks.pars, 'physical pars include');
    shader.fragmentShader = patched(shader.fragmentShader, '#include <lights_fragment_maps>', chunks.maps, 'light maps include');
  };
  material.customProgramCacheKey = () => 'tamtam-rig-1';
  return material;
}

/** Sheen in the colour of the material itself: a soft bloom on pale clay, almost none on black. */
function sheenOf(color) {
  const c = new THREE.Color(color).multiplyScalar(1.7);
  return c.setRGB(Math.min(c.r + 0.015, 1), Math.min(c.g + 0.015, 1), Math.min(c.b + 0.015, 1));
}

/**
 * The house material: soft matte clay with a gentle sheen — a designer vinyl toy, not glossy
 * plastic. Use it for every body, shell, button and cap.
 *   finish  'matte' (default) | 'satin' (a little more sheen, e.g. an upper panel) | 'soft' (rubber: no gloss at all)
 *   map     optional colour texture (see `paint()`), applied through the mesh UVs; pass white as the colour
 */
export function clay(color = colors.white, { finish = 'matte', map = null, roughness, coat } = {}) {
  const recipe = {
    matte: { roughness: 0.64, clearcoat: 0.22, clearcoatRoughness: 0.34, sheen: 0.45 },
    satin: { roughness: 0.5, clearcoat: 0.42, clearcoatRoughness: 0.24, sheen: 0.3 },
    soft: { roughness: 0.86, clearcoat: 0, clearcoatRoughness: 0.5, sheen: 0.7 },
  }[finish];
  if (!recipe) throw new Error(`kit.clay: unknown finish "${finish}"`);
  return physical({
    color: new THREE.Color(color),
    map,
    metalness: 0,
    roughness: roughness ?? recipe.roughness,
    clearcoat: coat ?? recipe.clearcoat,
    clearcoatRoughness: recipe.clearcoatRoughness,
    sheen: recipe.sheen,
    sheenRoughness: 0.5,
    sheenColor: sheenOf(color),
  });
}

/** Glossy moulded plastic (piano black cores, lacquered panels). Reflects the studio softly. */
export function gloss(color = colors.jet, { roughness = 0.2 } = {}) {
  return physical({ color: new THREE.Color(color), metalness: 0, roughness, clearcoat: 1, clearcoatRoughness: 0.08 });
}

/** Soft metal: stick shafts, heatsinks, contacts. */
export function metal(color = colors.silver, { roughness = 0.36 } = {}) {
  return physical({ color: new THREE.Color(color), metalness: 1, roughness }, { iblSpecular: 1, directSpecular: 0 });
}

/** The inside of holes, slots, ports and vents: swallows light. */
export function hollow(color = '#060607') {
  return physical({ color: new THREE.Color(color), metalness: 0, roughness: 1 }, { directSpecular: 0, iblSpecular: 0 });
}

/**
 * See-through plastic or glass: a clear game case, a tempered-glass sheet, a visor. Whatever is
 * behind it shows through, and so does the floor shadow. Build clear parts with
 * `mesh(geometry, clear(), { cast: false })`: a shadow map only knows solid shadows, and a solid
 * shadow under glass looks wrong. Give the part an opaque rim or edge if it needs a highlight.
 */
export function clear(color = '#dfe6ee', { opacity = 0.24 } = {}) {
  return physical({
    color: new THREE.Color(color), metalness: 0, roughness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05,
    transparent: true, opacity, depthWrite: false,
  });
}

/** A lit accent (status light, light bar, glowing ring). `strength` 1 ≈ paper white. */
export function glow(color = colors.blue, strength = 2.4) {
  const c = new THREE.Color(color);
  return physical({
    color: c.clone().multiplyScalar(0.25),
    emissive: c,
    emissiveIntensity: strength,
    metalness: 0,
    roughness: 0.5,
  });
}

/**
 * Glow that reaches the surfaces around an accent: a small unshadowed point light.
 * `strength` is the light arriving a quarter of the way out; nothing is lit past `reach` (mm).
 */
export function accentLight(color, strength = 1.5, reach = 60) {
  const light = new THREE.PointLight(new THREE.Color(color), strength * (reach * 0.25) ** 2, reach, 2);
  light.castShadow = false;
  return light;
}

const glareCache = new Map();
function glareTexture(aspect) {
  const key = aspect.toFixed(3);
  if (glareCache.has(key)) return glareCache.get(key);
  const W = 384, H = Math.max(8, Math.round(W / aspect));
  const data = new Uint8Array(W * H * 4);
  const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  // One soft diagonal reflection: a band leaning like "/", crisp on its left edge and dying away
  // to the right, plus a whisper of depth towards the upper left. Coordinates are in units of
  // the screen height so the lean looks the same on every screen shape.
  const lean = 62 * DEG, nx = Math.sin(lean), ny = -Math.cos(lean);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = ((x + 0.5) / W) * aspect, py = (y + 0.5) / H;
      const s = (px - 0.36 * aspect) * nx + (py - 0.5) * ny;
      const edge = clamp((s + 0.03) / 0.06, 0, 1);
      const band = edge * edge * (3 - 2 * edge) * Math.exp(-Math.max(s, 0) / 0.17);
      const lift = 0.35 + 0.65 * py;
      const depth = 0.006 * clamp(1 - px / aspect + py * 0.6, 0, 1.6);
      const v = 0.06 * band * lift + depth;
      const i = (y * W + x) * 4;
      data[i] = Math.round(255 * toSrgb(v * 0.8));
      data[i + 1] = Math.round(255 * toSrgb(v * 0.9));
      data[i + 2] = Math.round(255 * toSrgb(v));
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  glareCache.set(key, texture);
  return texture;
}

/**
 * Screen glass: a dark glossy insert with one soft diagonal reflection. Put it on a `slab()`
 * that faces the viewer and pass the slab's width / height so the reflection keeps its lean.
 */
export function glass({ aspect = 16 / 9, color = '#050608' } = {}) {
  return physical({
    color: new THREE.Color(color),
    metalness: 0,
    roughness: 0.14,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    emissive: new THREE.Color('#ffffff'),
    emissiveIntensity: 1,
    emissiveMap: glareTexture(aspect),
  }, { iblSpecular: 0, iblCoat: 0.18 }); // the painted reflection does the work; the studio only whispers
}

/**
 * A painted colour texture (generated covers, card faces, labels). `draw(ctx, w, h)` gets a 2D
 * canvas context; the result maps onto the front of a `slab()` (u → right, v → up).
 * Browser only. Never draw a real logo, wordmark, character or cover artwork.
 */
export function paint(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  draw(ctx, width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. Outlines (2D profiles for slab / extrude)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A closed 2D profile, counter-clockwise. `at(inset)` returns the flat point list
 * [x0, y0, x1, y1, …] of the profile shrunk inwards by `inset` mm (negative grows it) with the
 * same number of points at every inset — which is what lets `slab()` round an edge exactly.
 */
export class Outline {
  constructor(count, sample) {
    this.count = count;
    this.sample = sample;
  }

  at(inset = 0) {
    return this.sample(inset);
  }

  bounds(inset = 0) {
    const p = this.at(inset);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    }
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
  }

  /** The same outline somewhere else (mm). */
  move(dx, dy) {
    return new Outline(this.count, (inset) => {
      const p = this.sample(inset);
      for (let i = 0; i < p.length; i += 2) { p[i] += dx; p[i + 1] += dy; }
      return p;
    });
  }

  /** The same outline turned by `degrees` counter-clockwise around the origin. */
  rotate(degrees) {
    const c = Math.cos(degrees * DEG), s = Math.sin(degrees * DEG);
    return new Outline(this.count, (inset) => {
      const p = this.sample(inset);
      for (let i = 0; i < p.length; i += 2) {
        const x = p[i], y = p[i + 1];
        p[i] = x * c - y * s; p[i + 1] = x * s + y * c;
      }
      return p;
    });
  }

  /** The same outline flipped left ↔ right. */
  mirror() {
    return new Outline(this.count, (inset) => {
      const p = this.sample(inset), n = p.length / 2, out = new Array(p.length);
      for (let i = 0; i < n; i++) { out[2 * i] = -p[2 * (n - 1 - i)]; out[2 * i + 1] = p[2 * (n - 1 - i) + 1]; }
      return out;
    });
  }
}

function signedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * Any polygon with rounded corners. `radius` is one number or one per vertex (0 = sharp).
 * Corner radii shrink with the inset (and grow in concave corners), so the rounded edge of a
 * slab keeps a true offset shape.
 *   segments  steps per rounded corner
 *   edge      pieces each straight side is cut into — raise it (12–32) for anything you will
 *             `deform()`, so long sides can bend smoothly
 */
export function polygon(points, radius = 0, { segments = 10, edge = 1 } = {}) {
  let pts = points.map(([x, y]) => [x, y]);
  let radii = Array.isArray(radius) ? radius.slice() : new Array(pts.length).fill(radius);
  if (radii.length !== pts.length) throw new Error('kit.polygon: need one radius per point');
  if (signedArea(pts) < 0) { pts = pts.reverse(); radii = radii.reverse(); }
  const n = pts.length;
  const dir = [], nor = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    dir.push([dx / len, dy / len]);
    nor.push([-dy / len, dx / len]); // left of the edge = inside
  }
  const turn = [];
  for (let i = 0; i < n; i++) {
    const e1 = dir[(i + n - 1) % n], e2 = dir[i];
    turn.push(Math.atan2(e1[0] * e2[1] - e1[1] * e2[0], e1[0] * e2[0] + e1[1] * e2[1]));
  }
  const sample = (inset) => {
    const corner = [];
    for (let i = 0; i < n; i++) {
      const n1 = nor[(i + n - 1) % n], n2 = nor[i];
      const k = inset / Math.max(0.2, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      corner.push([pts[i][0] + (n1[0] + n2[0]) * k, pts[i][1] + (n1[1] + n2[1]) * k]);
    }
    const rad = [], tan = [];
    for (let i = 0; i < n; i++) {
      const r = Math.max(turn[i] >= 0 ? radii[i] - inset : radii[i] + inset, 0);
      rad.push(r);
      tan.push(r * Math.tan(Math.abs(turn[i]) / 2));
    }
    const fit = new Array(n).fill(1);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const len = Math.hypot(corner[j][0] - corner[i][0], corner[j][1] - corner[i][1]);
      const need = tan[i] + tan[j];
      if (need > len && need > 0) { const s = len / need; fit[i] = Math.min(fit[i], s); fit[j] = Math.min(fit[j], s); }
    }
    const arcs = [];
    for (let i = 0; i < n; i++) {
      const e1 = dir[(i + n - 1) % n], n1 = nor[(i + n - 1) % n];
      const r = rad[i] * fit[i], t = tan[i] * fit[i], th = turn[i], sgn = th >= 0 ? 1 : -1;
      const ax = corner[i][0] - e1[0] * t, ay = corner[i][1] - e1[1] * t;
      const cx = ax + n1[0] * r * sgn, cy = ay + n1[1] * r * sgn;
      const a0 = Math.atan2(ay - cy, ax - cx);
      const arc = [];
      for (let k = 0; k <= segments; k++) {
        if (r < 1e-9) { arc.push(corner[i][0], corner[i][1]); continue; }
        const a = a0 + th * (k / segments);
        arc.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      arcs.push(arc);
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const arc = arcs[i], next = arcs[(i + 1) % n];
      for (const v of arc) out.push(v);
      const bx = arc[arc.length - 2], by = arc[arc.length - 1];
      for (let k = 1; k < edge; k++) out.push(bx + ((next[0] - bx) * k) / edge, by + ((next[1] - by) * k) / edge);
    }
    return out;
  };
  return new Outline(n * (segments + edge), sample);
}

/** Rectangle centred on the origin. `radius`: one number, or [topLeft, topRight, bottomRight, bottomLeft]. */
export function rect(width, height, radius = 0, options) {
  const r = Array.isArray(radius) ? radius : [radius, radius, radius, radius];
  const hw = width / 2, hh = height / 2;
  return polygon([[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], [r[3], r[2], r[1], r[0]], options);
}

/** Stadium shape: a rectangle with fully round ends. */
export function pill(width, height, options) {
  return rect(width, height, Math.min(width, height) / 2, options);
}

export function circle(radius, { segments = 72 } = {}) {
  return ellipse(radius, radius, { segments });
}

export function ellipse(radiusX, radiusY, { segments = 72 } = {}) {
  return new Outline(segments, (inset) => {
    const out = new Array(segments * 2), rx = Math.max(radiusX - inset, 0), ry = Math.max(radiusY - inset, 0);
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      out[2 * i] = Math.cos(a) * rx;
      out[2 * i + 1] = Math.sin(a) * ry;
    }
    return out;
  });
}

/** Squircle: `exponent` 2 is an ellipse, 4–5 is the soft-square of modern hardware. */
export function superellipse(width, height, exponent = 4, { segments = 96 } = {}) {
  return new Outline(segments, (inset) => {
    const out = new Array(segments * 2), a = Math.max(width / 2 - inset, 0), b = Math.max(height / 2 - inset, 0);
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      out[2 * i] = a * Math.sign(c) * Math.abs(c) ** (2 / exponent);
      out[2 * i + 1] = b * Math.sign(s) * Math.abs(s) ** (2 / exponent);
    }
    return out;
  });
}

/** Plus / cross shape (d-pads, plus buttons). `size` is the full span, `arm` the bar width. */
export function plus(size, arm, radius = arm * 0.25, options) {
  const s = size / 2, a = arm / 2, inner = radius * 0.5;
  return polygon(
    [[-a, -s], [a, -s], [a, -a], [s, -a], [s, a], [a, a], [a, s], [-a, s], [-a, a], [-s, a], [-s, -a], [-a, -a]],
    [radius, radius, inner, radius, radius, inner, radius, radius, inner, radius, radius, inner],
    options,
  );
}

function toOutline(value) {
  if (value instanceof Outline) return value;
  if (Array.isArray(value)) return polygon(value, 0, { segments: 0 });
  throw new Error('kit: expected an Outline (rect, pill, circle, polygon, …) or a list of [x, y] points');
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. Solids
 * ──────────────────────────────────────────────────────────────────────────── */

const Z_TURNS = { z: null, '-z': ['y', 180], y: ['x', -90], '-y': ['x', 90], x: ['y', 90], '-x': ['y', -90] };
const Y_TURNS = { y: null, '-y': ['x', 180], z: ['x', 90], '-z': ['x', -90], x: ['z', -90], '-x': ['z', 90] };

function finish(geometry, turn, crease = 40) {
  geometry.deleteAttribute('normal');
  const g = toCreasedNormals(geometry, crease * DEG);
  if (turn) {
    const [axis, degrees] = turn;
    if (axis === 'x') g.rotateX(degrees * DEG);
    else if (axis === 'y') g.rotateY(degrees * DEG);
    else g.rotateZ(degrees * DEG);
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function turnFor(table, axis, helper) {
  if (!(axis in table)) throw new Error(`kit.${helper}: axis must be one of ${Object.keys(table).join(', ')}`);
  return table[axis];
}

/**
 * The workhorse: an outline given thickness, with rounded edges and an optional pillowed or
 * dished face. Use it for bodies, shells, plates, screens, buttons and key caps.
 *
 *   slab(rect(194, 116, 4), 13.9, { bevel: 2.5 })              a tablet body
 *   slab(circle(4), 2.2, { bevel: 0.8, dome: 0.5 })            a soft round button
 *   slab(rect(60, 40, 6), 3, { axis: 'y' })                    a plate lying flat (front face up)
 *
 * Options
 *   bevel, bevelBack  edge rounding radius, front and back (default: a soft 30% of the depth, max 1.2 mm)
 *   dome, domeBack    mm the middle of the face rises (+) or sinks (−), or a function u → mm (u: 0 centre … 1 edge)
 *   rings             concentric subdivisions of the faces — raise it (8–24) before `deform()`
 *   axis              where the front face looks: 'z' (default), '-z', 'x', '-x', 'y', '-y'
 * The outline must be star-shaped around its middle (true for every convex shape and for
 * `plus`); use `extrude()` for U / L / ring shapes and anything with holes.
 */
export function slab(outline, depth, options = {}) {
  const o = toOutline(outline);
  const soft = Math.min(depth * 0.3, 1.2);
  const { bevel = soft, bevelBack = bevel, bevelSegments = 6, dome = 0, domeBack = 0, axis = 'z', crease = 40 } = options;
  const rings = options.rings ?? (dome || domeBack ? 10 : 1);
  const bf = clamp(bevel, 0, depth / 2), bb = clamp(bevelBack, 0, depth - bf);
  const zf = depth / 2, zb = -depth / 2;
  const domeF = typeof dome === 'function' ? dome : (u) => dome * (1 - u * u);
  const domeB = typeof domeBack === 'function' ? domeBack : (u) => domeBack * (1 - u * u);
  const n = o.count;
  const bounds = o.bounds(0);
  const centroidOf = (p) => {
    let x = 0, y = 0;
    for (let i = 0; i < p.length; i += 2) { x += p[i]; y += p[i + 1]; }
    return [x / n, y / n];
  };
  const scaled = (p, c, s) => {
    const out = new Array(p.length);
    for (let i = 0; i < p.length; i += 2) { out[i] = c[0] + (p[i] - c[0]) * s; out[i + 1] = c[1] + (p[i + 1] - c[1]) * s; }
    return out;
  };
  const ringList = [];
  // front face, centre outwards
  const capF = o.at(bf), cF = centroidOf(capF);
  for (let k = 1; k <= rings; k++) ringList.push({ xy: scaled(capF, cF, k / rings), z: zf + domeF(k / rings) });
  // front edge
  for (let j = 1; j <= bevelSegments && bf > 0; j++) {
    const t = (j / bevelSegments) * (Math.PI / 2);
    ringList.push({ xy: o.at(bf * (1 - Math.sin(t))), z: zf - bf * (1 - Math.cos(t)) });
  }
  // wall
  if (depth - bf - bb > 1e-6) ringList.push({ xy: o.at(0), z: zb + bb });
  // back edge
  for (let j = 1; j <= bevelSegments && bb > 0; j++) {
    const t = (1 - j / bevelSegments) * (Math.PI / 2);
    ringList.push({ xy: o.at(bb * (1 - Math.sin(t))), z: zb + bb * (1 - Math.cos(t)) });
  }
  // back face, edge inwards
  const capB = o.at(bb), cB = centroidOf(capB);
  for (let k = rings - 1; k >= 1; k--) ringList.push({ xy: scaled(capB, cB, k / rings), z: zb - domeB(k / rings) });

  const pos = [], uv = [];
  const vert = (x, y, z) => {
    pos.push(x, y, z);
    uv.push((x - bounds.minX) / (bounds.width || 1), (y - bounds.minY) / (bounds.height || 1));
  };
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-18) return;
    vert(ax, ay, az); vert(bx, by, bz); vert(cx, cy, cz);
  };
  const first = ringList[0], last = ringList[ringList.length - 1];
  const apexF = [cF[0], cF[1], zf + domeF(0)], apexB = [cB[0], cB[1], zb - domeB(0)];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tri(apexF[0], apexF[1], apexF[2], first.xy[2 * i], first.xy[2 * i + 1], first.z, first.xy[2 * j], first.xy[2 * j + 1], first.z);
    tri(last.xy[2 * i], last.xy[2 * i + 1], last.z, apexB[0], apexB[1], apexB[2], last.xy[2 * j], last.xy[2 * j + 1], last.z);
  }
  for (let r = 0; r + 1 < ringList.length; r++) {
    const a = ringList[r], b = ringList[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = a.xy[2 * i], ay = a.xy[2 * i + 1], a2x = a.xy[2 * j], a2y = a.xy[2 * j + 1];
      const bx = b.xy[2 * i], by = b.xy[2 * i + 1], b2x = b.xy[2 * j], b2y = b.xy[2 * j + 1];
      tri(ax, ay, a.z, bx, by, b.z, b2x, b2y, b.z);
      tri(ax, ay, a.z, b2x, b2y, b.z, a2x, a2y, a.z);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return finish(geometry, turnFor(Z_TURNS, axis, 'slab'), crease);
}

/**
 * Like `slab`, for outlines `slab` cannot fill: U / L / ring shapes and plates with holes.
 * `holes` is a list of outlines (use `.move(x, y)` to place them); edges of the plate and of
 * the holes are rounded by `bevel`. Faces are flat (no dome, not meant for `deform`).
 *
 *   extrude(rect(138, 138, 18), 1.4, { bevel: 0.4, holes: grid(11, 11, 12).map(([x, y]) => circle(4.6).move(x, y)) })
 */
export function extrude(outline, depth, options = {}) {
  const o = toOutline(outline);
  const { bevel = Math.min(depth * 0.3, 1.2), bevelSegments = 4, holes = [], axis = 'z', crease = 40 } = options;
  const b = clamp(bevel, 0, depth / 2 - 1e-4);
  const toVectors = (flat) => {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i], y = flat[i + 1], prev = out[out.length - 1];
      if (!prev || Math.hypot(prev.x - x, prev.y - y) > 1e-7) out.push(new THREE.Vector2(x, y));
    }
    if (out.length > 1 && out[0].distanceTo(out[out.length - 1]) < 1e-7) out.pop();
    return out;
  };
  const shape = new THREE.Shape(toVectors(o.at(b)));
  for (const hole of holes) shape.holes.push(new THREE.Path(toVectors(toOutline(hole).at(-b))));
  const inner = depth - 2 * b;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: inner, steps: 1, curveSegments: 1,
    bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: 0, bevelSegments,
  });
  geometry.translate(0, 0, -inner / 2);
  const bounds = o.bounds(0), p = geometry.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    uv[2 * i] = (p.getX(i) - bounds.minX) / (bounds.width || 1);
    uv[2 * i + 1] = (p.getY(i) - bounds.minY) / (bounds.height || 1);
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return finish(geometry, turnFor(Z_TURNS, axis, 'extrude'), crease);
}

/** A box with every edge rounded by the same radius. Centred on the origin. */
export function box(width, height, depth, radius = Math.min(width, height, depth) * 0.12, { segments = 6 } = {}) {
  const r = Math.min(radius, width / 2, height / 2, depth / 2);
  const geometry = new RoundedBoxGeometry(width, height, depth, segments, r);
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * A profile spun around an axis. `profile` is a list of [radius, height] pairs traced from the
 * bottom of the axis, out along the underside, up the outside and back in along the top.
 * Repeat a point to make a hard corner; corners sharper than ~40° stay hard anyway.
 */
export function lathe(profile, { segments = 64, axis = 'y', crease = 40 } = {}) {
  const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0), y));
  return finish(new THREE.LatheGeometry(points, segments), turnFor(Y_TURNS, axis, 'lathe'), crease);
}

/**
 * A round button / knob / foot: a cylinder sitting on y = 0 with a rounded top rim.
 *   top  mm the middle of the top rises (+, domed) or sinks (−, dished)
 */
export function puck(radius, height, options = {}) {
  const { bevel = Math.min(radius, height) * 0.3, bevelBottom = 0, top = 0, segments = 64, axis = 'y', crease = 40 } = options;
  const b = clamp(bevel, 0, Math.min(radius, height)), bb = clamp(bevelBottom, 0, Math.min(radius, height - b));
  const arc = 6, p = [[0, 0]];
  if (bb > 0) {
    for (let k = 0; k <= arc; k++) { const t = (k / arc) * (Math.PI / 2); p.push([radius - bb + bb * Math.sin(t), bb - bb * Math.cos(t)]); }
  } else p.push([radius, 0]);
  if (b > 0) {
    for (let k = 0; k <= arc; k++) { const t = (k / arc) * (Math.PI / 2); p.push([radius - b + b * Math.cos(t), height - b + b * Math.sin(t)]); }
  } else p.push([radius, height]);
  const steps = top ? 10 : 1, flat = radius - b;
  for (let k = 1; k <= steps; k++) { const s = 1 - k / steps; p.push([flat * s, height + top * (1 - s * s)]); }
  return lathe(p, { segments, axis, crease });
}

/** A flat washer / collar sitting on y = 0 (stick rings, bezels, light rings). */
export function ring(outerRadius, innerRadius, height, { bevel = Math.min(height, outerRadius - innerRadius) * 0.3, segments = 64, axis = 'y', crease = 40 } = {}) {
  const b = clamp(bevel, 0, Math.min(height, (outerRadius - innerRadius) / 2)), arc = 5;
  const p = [[innerRadius, 0], [outerRadius, 0]];
  if (b > 0) {
    for (let k = 0; k <= arc; k++) { const t = (k / arc) * (Math.PI / 2); p.push([outerRadius - b + b * Math.cos(t), height - b + b * Math.sin(t)]); }
    for (let k = 0; k <= arc; k++) { const t = (k / arc) * (Math.PI / 2); p.push([innerRadius + b - b * Math.sin(t), height - b + b * Math.cos(t)]); }
  } else p.push([outerRadius, height], [innerRadius, height]);
  p.push([innerRadius, 0]);
  return lathe(p, { segments, axis, crease });
}

/** A rod with round ends, `length` long overall. */
export function capsule(radius, length, { axis = 'y', segments = 32 } = {}) {
  const geometry = new THREE.CapsuleGeometry(radius, Math.max(length - 2 * radius, 0), 10, segments);
  const turn = turnFor(Y_TURNS, axis, 'capsule');
  if (turn) {
    if (turn[0] === 'x') geometry.rotateX(turn[1] * DEG);
    else geometry.rotateZ(turn[1] * DEG);
  }
  geometry.computeBoundingBox();
  return geometry;
}

/** A doughnut in the XY plane (around +Z unless `axis` says otherwise). */
export function torus(radius, tube, { axis = 'z', segments = 96, arc = 360 } = {}) {
  const geometry = new THREE.TorusGeometry(radius, tube, 20, segments, arc * DEG);
  const turn = turnFor(Z_TURNS, axis, 'torus');
  if (turn) {
    if (turn[0] === 'x') geometry.rotateX(turn[1] * DEG);
    else geometry.rotateY(turn[1] * DEG);
  }
  geometry.computeBoundingBox();
  return geometry;
}

/** A round cable / strap / wire bent smoothly through `points` ([x, y, z] each). */
export function tube(points, radius, { closed = false, segments = 12, steps } = {}) {
  const curve = new THREE.CatmullRomCurve3(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)), closed, 'centripetal');
  const geometry = new THREE.TubeGeometry(curve, steps ?? Math.max(24, points.length * 16), radius, segments, closed);
  geometry.computeBoundingBox();
  return geometry;
}

/**
 * Cut every triangle edge longer than `maxEdge` mm in half, again and again, until none is left.
 * Shared edges are cut at the same point from both sides, so the surface stays closed.
 */
export function refine(geometry, maxEdge) {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  let pos = Array.from(source.attributes.position.array);
  let uv = source.attributes.uv ? Array.from(source.attributes.uv.array) : null;
  const limit = maxEdge * maxEdge;
  for (let pass = 0; pass < 10; pass++) {
    const nextPos = [], nextUv = uv ? [] : null;
    let cut = false;
    for (let t = 0; t < pos.length / 9; t++) {
      const P = [0, 1, 2].map((i) => [pos[t * 9 + i * 3], pos[t * 9 + i * 3 + 1], pos[t * 9 + i * 3 + 2]]);
      const U = uv ? [0, 1, 2].map((i) => [uv[t * 6 + i * 2], uv[t * 6 + i * 2 + 1]]) : null;
      const far = (a, b) => (P[a][0] - P[b][0]) ** 2 + (P[a][1] - P[b][1]) ** 2 + (P[a][2] - P[b][2]) ** 2 > limit;
      const long = [far(0, 1), far(1, 2), far(2, 0)];
      const count = long[0] + long[1] + long[2];
      // corners 0-2 plus the midpoints of edges 0-1, 1-2, 2-0 as 3, 4, 5
      for (let e = 0; e < 3; e++) {
        const a = e, b = (e + 1) % 3;
        P.push([(P[a][0] + P[b][0]) / 2, (P[a][1] + P[b][1]) / 2, (P[a][2] + P[b][2]) / 2]);
        if (U) U.push([(U[a][0] + U[b][0]) / 2, (U[a][1] + U[b][1]) / 2]);
      }
      const emit = (...indices) => { for (const i of indices) { nextPos.push(P[i][0], P[i][1], P[i][2]); if (U) nextUv.push(U[i][0], U[i][1]); } };
      if (count === 0) { emit(0, 1, 2); continue; }
      cut = true;
      if (count === 3) { emit(0, 3, 5, 3, 1, 4, 5, 4, 2, 3, 4, 5); continue; }
      // rotate so the pattern below always starts at corner `s`
      const s = count === 1 ? long.indexOf(true) : (long.indexOf(false) + 1) % 3;
      const a = s, b = (s + 1) % 3, c = (s + 2) % 3, ab = 3 + s, bc = 3 + b;
      if (count === 1) emit(a, ab, c, ab, b, c); // only a–b is long
      else emit(ab, b, bc, a, ab, bc, a, bc, c); // a–b and b–c are long
    }
    pos = nextPos;
    uv = nextUv;
    if (!cut) break;
  }
  const refined = new THREE.BufferGeometry();
  refined.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (uv) refined.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return refined;
}

/**
 * Bend, bow or taper a solid: `fn(p)` moves each vertex (a THREE.Vector3, mutate it). Use the
 * geometry it returns. The solid needs enough vertices to bend: build slabs with
 * `{ rings: 16 }` and outlines with `{ edge: 12 }`, or pass `maxEdge` (mm) here to have long
 * triangles cut up first — the way to bend an `extrude()` with holes.
 */
export function deform(geometry, fn, { crease = 40, maxEdge } = {}) {
  const g = maxEdge ? refine(geometry, maxEdge) : geometry.index ? geometry.toNonIndexed() : geometry;
  const p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v, i);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  p.needsUpdate = true;
  return finish(g, null, crease);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 6. Putting things together
 * ──────────────────────────────────────────────────────────────────────────── */

function applyPlacement(object, { at, rot, scale, name } = {}) {
  if (at) object.position.set(at[0], at[1], at[2]);
  if (rot) object.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
  if (scale !== undefined) Array.isArray(scale) ? object.scale.set(scale[0], scale[1], scale[2]) : object.scale.setScalar(scale);
  if (name) object.name = name;
  return object;
}

/** A part. `at` [x, y, z] in mm, `rot` [x, y, z] in degrees. */
export function mesh(geometry, material, placement = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.castShadow = placement.cast ?? true;
  m.receiveShadow = placement.receive ?? true;
  return applyPlacement(m, placement);
}

/** Several parts moved as one. */
export function group(children = [], placement = {}) {
  const g = new THREE.Group();
  for (const child of children) if (child) g.add(child);
  return applyPlacement(g, placement);
}

/** A copy of a part (sharing geometry and materials) flipped left ↔ right. */
export function mirrorX(object) {
  const copy = object.clone(true);
  copy.position.x = -object.position.x;
  copy.rotation.y = -object.rotation.y;
  copy.rotation.z = -object.rotation.z;
  copy.scale.x = -object.scale.x;
  return copy;
}

/**
 * Centres of a regular grid, centred on the origin: [[x, y], …].
 *   stagger  shift every other row by half a pitch
 *   keep     (x, y, column, row) → false to drop a point (round a corner, leave a gap)
 */
export function grid(columns, rows, pitchX, pitchY = pitchX, { stagger = false, keep } = {}) {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = (c - (columns - 1) / 2) * pitchX + (stagger && r % 2 ? pitchX / 2 : 0);
      const y = (r - (rows - 1) / 2) * pitchY;
      if (!keep || keep(x, y, c, r)) out.push([x, y]);
    }
  }
  return out;
}

/**
 * Points evenly spaced on a circle around the origin: [[x, y, 0, spin], …]. `spin` (degrees)
 * turns each stamped copy to face outwards — fan blades, a ring of holes, screws.
 *   radial(7, 18)                      seven points on a 18 mm circle
 *   radial(12, 30, { start: 15 })      first point 15° round from +X
 */
export function radial(count, radius, { start = 0, arc = 360 } = {}) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const degrees = start + (arc * i) / (arc >= 360 ? count : Math.max(count - 1, 1));
    out.push([Math.cos(degrees * DEG) * radius, Math.sin(degrees * DEG) * radius, 0, degrees]);
  }
  return out;
}

/**
 * One geometry stamped at many places in the XY plane of the returned object — vent slots,
 * speaker holes, rows of contacts. Each point is [x, y], [x, y, z] or [x, y, z, spin] with
 * `spin` in degrees around Z. Rotate / position the result like any part.
 */
export function stamp(geometry, material, points, placement = {}) {
  const im = new THREE.InstancedMesh(geometry, material, points.length);
  const m = new THREE.Matrix4(), turn = new THREE.Matrix4();
  points.forEach(([x, y, z = 0, spin = 0], i) => {
    m.makeTranslation(x, y, z);
    if (spin) m.multiply(turn.makeRotationZ(spin * DEG));
    im.setMatrixAt(i, m);
  });
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = placement.cast ?? true;
  im.receiveShadow = placement.receive ?? true;
  im.computeBoundingBox();
  im.computeBoundingSphere();
  return applyPlacement(im, placement);
}

/**
 * A field of dark openings — vent slots (`size: [w, h]`), round holes (`radius`), ports — on a
 * surface. Give `at` a point ON the surface; the field lies in the XY plane of the returned
 * object and faces its +Z, so turn it with `rot` for other faces (top: [-90, 0, 0], back:
 * [0, 180, 0], right side: [0, 90, 0]). They are dark inlays, not real holes: cheap, and they
 * read at thumbnail size. For holes you can see through, cut them with `extrude({ holes })`.
 */
export function vents(points, { radius, size, depth = 0.6, material = hollow(), ...placement } = {}) {
  const outline = size ? rect(size[0], size[1], Math.min(size[0], size[1]) / 2) : circle(radius ?? 1, { segments: 24 });
  const geometry = slab(outline, depth, { bevel: Math.min(depth * 0.4, 0.2) });
  geometry.translate(0, 0, 0.05 - depth / 2); // sunk into the surface, a hair proud so it never z-fights
  return stamp(geometry, material, points, placement);
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. Stage: renderer, rig, shadow catcher, auto-framing camera
 * ──────────────────────────────────────────────────────────────────────────── */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }`;

const ACCUMULATE_FRAGMENT = /* glsl */ `
  uniform sampler2D tPrevious;
  uniform sampler2D tSample;
  uniform float uWeight;
  uniform float uKeep;
  varying vec2 vUv;
  void main() {
    vec4 s = texture2D( tSample, vUv );
    s.rgb = clamp( s.rgb, vec3( 0.0 ), vec3( 48.0 ) ); // one stray highlight must not outweigh the rest
    gl_FragColor = texture2D( tPrevious, vUv ) * uKeep + s * uWeight;
  }`;

// Tone curve: the shoulder of the Khronos PBR Neutral operator without its toe, so product
// colours stay true and dark hardware keeps its shading. Output is straight (non-premultiplied)
// sRGB with the top row first.
const RESOLVE_FRAGMENT = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tGround;
  uniform float uExposure;
  uniform vec3 uShadow; // darkness, floor, gamma
  uniform float uCoverageOnly;
  varying vec2 vUv;
  vec3 tone( vec3 c ) {
    const float start = 0.76;
    const float desaturation = 0.15;
    float peak = max( c.r, max( c.g, c.b ) );
    if ( peak < start ) return c;
    float d = 1.0 - start;
    float newPeak = 1.0 - d * d / ( peak + d - start );
    c *= newPeak / peak;
    float g = 1.0 - 1.0 / ( desaturation * ( peak - newPeak ) + 1.0 );
    return mix( c, vec3( newPeak ), g );
  }
  vec3 encode( vec3 c ) {
    c = clamp( c, 0.0, 1.0 );
    return mix( c * 12.92, 1.055 * pow( c, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, c ) );
  }
  void main() {
    vec2 uv = vec2( vUv.x, 1.0 - vUv.y );
    vec4 c = texture2D( tColor, uv );
    vec4 g = texture2D( tGround, uv );
    float cover = clamp( c.a, 0.0, 1.0 );
    if ( uCoverageOnly > 0.5 ) { gl_FragColor = vec4( cover ); return; }
    vec3 color = c.a > 1e-5 ? c.rgb / c.a : vec3( 0.0 );
    color = encode( tone( max( color, 0.0 ) * uExposure ) );
    float occlusion = g.g > 1e-4 ? g.r / g.g : 0.0;
    float shade = uShadow.x * pow( clamp( ( occlusion - uShadow.y ) / ( 1.0 - uShadow.y ), 0.0, 1.0 ), uShadow.z );
    float ground = clamp( g.g / max( 1.0 - cover, 1e-4 ), 0.0, 1.0 );
    float alpha = cover + ( 1.0 - cover ) * shade * ground;
    gl_FragColor = vec4( alpha > 1e-5 ? color * cover / alpha : vec3( 0.0 ), alpha );
  }`;

const GROUND_MASK = /* glsl */ `
  uniform float ttWeight[ 4 ];
  uniform vec4 ttFoot;
  varying vec2 vTtGround;
  float ttOcclusion() {
    float occlusion = 0.0;
    #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    DirectionalLightShadow directionalLight;
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
      directionalLight = directionalLightShadows[ i ];
      occlusion += ttWeight[ i ] * ( 1.0 - getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) );
    }
    #pragma unroll_loop_end
    #endif
    vec2 q = max( abs( vTtGround ) - ttFoot.xy, 0.0 );
    return occlusion * ( 1.0 - smoothstep( ttFoot.z, ttFoot.w, length( q ) ) );
  }`;

function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function permutation(n, seed) {
  const random = mulberry32(seed), order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * The stage renders any Object3D with the shared rig and returns straight-alpha RGBA pixels:
 * the object, centred, filling FILL of the frame, with its soft contact shadow and nothing else.
 */
export function createStage({ canvas } = {}) {
  const target = canvas ?? document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas: target, alpha: true, antialias: false, premultipliedAlpha: true,
    preserveDrawingBuffer: true, powerPreference: 'high-performance',
  });
  const gl = renderer.getContext();
  if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('kit: this GPU / driver cannot render to float textures (EXT_color_buffer_float)');
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace; // the resolve pass below encodes sRGB itself
  renderer.toneMapping = THREE.NoToneMapping; // …and applies the neutral tone curve
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;

  const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
  const info = {
    three: THREE.REVISION,
    gpu: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    software: false,
  };
  info.software = /swiftshader|llvmpipe|software|basic render/i.test(info.gpu);

  const OBJECT_LAYER = 0, GROUND_LAYER = 1;
  const scene = new THREE.Scene();
  const pivot = new THREE.Group();
  scene.add(pivot);
  const ambient = new THREE.AmbientLight(0xffffff, RIG.ambient);
  ambient.layers.enableAll(); // lights are collected per camera layer, and the floor has its own
  scene.add(ambient);

  const camera = new THREE.PerspectiveCamera(20, 1, 1, 10000);

  const mapScale = info.software ? 0.5 : 1;
  const makeLight = (spec, mapSize) => {
    const light = new THREE.DirectionalLight(new THREE.Color(spec.color), 1);
    light.castShadow = true;
    light.shadow.mapSize.set(mapSize * mapScale, mapSize * mapScale);
    light.shadow.radius = 1.6;
    // Shadow maps hold the far side of every solid (three's default for front-sided materials),
    // so lit faces never shadow themselves and need no slack. A small bias the other way — into
    // the shadow — closes the bright hairline where one part rests on another.
    light.shadow.bias = 0.00024;
    light.layers.enableAll();
    scene.add(light, light.target);
    return light;
  };
  // Order matters: the ground shader weights the shadow of light i with ttWeight[i].
  const lights = {
    key: makeLight(RIG.key, 4096),
    sky: makeLight(RIG.sky, 2048),
    bounce: makeLight(RIG.bounce, 1024),
    rim: makeLight(RIG.rim, 2048),
  };

  const groundUniforms = { ttWeight: { value: [0, 0, 0, 0] }, ttFoot: { value: new THREE.Vector4(1, 1, 0, 1) } };
  const groundMaterial = new THREE.ShadowMaterial({ color: 0x000000 });
  groundMaterial.transparent = false;
  groundMaterial.blending = THREE.NoBlending;
  groundMaterial.toneMapped = false;
  groundMaterial.onBeforeCompile = (shader) => {
    shader.uniforms.ttWeight = groundUniforms.ttWeight;
    shader.uniforms.ttFoot = groundUniforms.ttFoot;
    shader.vertexShader = patched(shader.vertexShader, '#include <common>', '#include <common>\nvarying vec2 vTtGround;', 'ground varying');
    shader.vertexShader = patched(shader.vertexShader, '#include <begin_vertex>', '#include <begin_vertex>\nvTtGround = ( modelMatrix * vec4( position, 1.0 ) ).xz;', 'ground position');
    shader.fragmentShader = patched(shader.fragmentShader, '#include <shadowmask_pars_fragment>', GROUND_MASK, 'ground mask');
    shader.fragmentShader = patched(shader.fragmentShader, 'gl_FragColor = vec4( color, opacity * ( 1.0 - getShadowMask() ) );', 'gl_FragColor = vec4( ttOcclusion(), 1.0, 0.0, 1.0 );', 'ground output');
  };
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), groundMaterial);
  ground.receiveShadow = true;
  ground.castShadow = false;
  ground.layers.set(GROUND_LAYER);
  scene.add(ground);

  // Studio environment for glossy lobes, rebuilt per camera azimuth so it orbits with the rig.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environments = new Map();
  const hdr = (v) => new THREE.MeshBasicMaterial({ color: new THREE.Color(v, v, v), side: THREE.DoubleSide });
  function environmentFor(azimuth) {
    const cacheKey = azimuth.toFixed(2);
    if (environments.has(cacheKey)) return environments.get(cacheKey);
    const studio = new THREE.Scene();
    const dome = new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      vertexShader: 'varying vec3 vDir; void main() { vDir = normalize( position ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
      fragmentShader: 'varying vec3 vDir; void main() { float h = normalize( vDir ).y; vec3 c = h > 0.0 ? mix( vec3( 0.26 ), vec3( 1.25 ), smoothstep( 0.0, 0.9, h ) ) : mix( vec3( 0.26 ), vec3( 0.03 ), smoothstep( 0.0, -0.4, h ) ); gl_FragColor = vec4( c, 1.0 ); }',
    }));
    studio.add(dome);
    const panel = (az, el, w, h, value) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), hdr(value));
      m.position.copy(orbitDirection(azimuth + az, el)).multiplyScalar(22);
      m.lookAt(0, 0, 0);
      studio.add(m);
    };
    panel(RIG.key.azimuth, RIG.key.elevation, 15, 15, 7.5);
    panel(RIG.rim.azimuth, RIG.rim.elevation, 5, 15, 5);
    panel(72, 12, 12, 14, 0.9);
    const rt = pmrem.fromScene(studio, 0.035, 0.1, 200);
    dome.geometry.dispose();
    environments.set(cacheKey, rt.texture);
    return rt.texture;
  }

  // Fullscreen passes.
  const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeometry = new THREE.PlaneGeometry(2, 2);
  const pass = (fragmentShader, uniforms) => {
    const material = new THREE.ShaderMaterial({ vertexShader: QUAD_VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });
    const quad = new THREE.Mesh(quadGeometry, material);
    quad.frustumCulled = false;
    const quadScene = new THREE.Scene();
    quadScene.add(quad);
    return { material, scene: quadScene };
  };
  const accumulatePass = pass(ACCUMULATE_FRAGMENT, { tPrevious: { value: null }, tSample: { value: null }, uWeight: { value: 1 }, uKeep: { value: 0 } });
  const resolvePass = pass(RESOLVE_FRAGMENT, {
    tColor: { value: null }, tGround: { value: null }, uExposure: { value: RIG.exposure },
    uShadow: { value: new THREE.Vector3(RIG.shadow.darkness, RIG.shadow.floor, RIG.shadow.gamma) },
    uCoverageOnly: { value: 0 },
  });

  const targetSets = new Map();
  function targetsFor(size) {
    if (targetSets.has(size)) return targetSets.get(size);
    const float = () => new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    const set = {
      sample: new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
      color: [float(), float()],
      ground: [float(), float()],
      out: new THREE.WebGLRenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }),
    };
    targetSets.set(size, set);
    return set;
  }

  const state = { subject: null, centre: new THREE.Vector3(), radius: 1, size: new THREE.Vector3(), triangles: 0 };

  function mount(subject) {
    if (state.subject === subject) return;
    pivot.clear();
    pivot.position.set(0, 0, 0);
    pivot.add(subject);
    pivot.updateMatrixWorld(true);
    let triangles = 0;
    subject.traverse((o) => {
      if (o.isLight) o.layers.enableAll();
      if (o.isMesh) {
        const count = o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count;
        triangles += (count / 3) * (o.isInstancedMesh ? o.count : 1);
      }
    });
    const bounds = new THREE.Box3().setFromObject(subject, true);
    if (bounds.isEmpty()) throw new Error('kit: build() returned an object with no geometry');
    const c = bounds.getCenter(new THREE.Vector3());
    bounds.getSize(state.size);
    pivot.position.set(-c.x, -bounds.min.y, -c.z); // stand it on the floor, centred
    pivot.updateMatrixWorld(true);
    state.subject = subject;
    state.centre.set(0, state.size.y / 2, 0);
    state.radius = 0.5 * state.size.length();
    state.triangles = Math.round(triangles);

    const R = state.radius;
    for (const light of Object.values(lights)) {
      const cam = light.shadow.camera;
      cam.left = cam.bottom = -R * 1.04;
      cam.right = cam.top = R * 1.04;
      cam.near = R * 0.5;
      cam.far = R * 5.5;
      cam.updateProjectionMatrix();
      light.shadow.normalBias = 0;
      light.target.position.copy(state.centre);
      light.target.updateMatrixWorld();
    }
    ground.scale.setScalar(R * 60);
    ground.position.set(0, -R * 0.0015, 0); // a hair below the feet so the contact itself is in shadow
    ground.updateMatrixWorld();
    groundUniforms.ttFoot.value.set(state.size.x / 2, state.size.z / 2, RIG.shadow.fade[0] * R, RIG.shadow.fade[1] * R);
  }

  function sequences(samples, azimuth) {
    const seq = [];
    const orderKey = permutation(samples, 11), orderSky = permutation(samples, 23), orderBounce = permutation(samples, 37), orderRim = permutation(samples, 53);
    const cone = (spec, index) => {
      const axis = orbitDirection(azimuth + spec.azimuth, spec.elevation);
      const t = new THREE.Vector3(0, 1, 0).cross(axis).normalize(), b = new THREE.Vector3().crossVectors(axis, t);
      const r = Math.sqrt((index + 0.5) / samples) * Math.tan(spec.radius * DEG), a = index * GOLDEN_ANGLE;
      return axis.addScaledVector(t, Math.cos(a) * r).addScaledVector(b, Math.sin(a) * r).normalize();
    };
    const dome = (index, yFrom, yTo) => {
      const y = yFrom + (yTo - yFrom) * ((index + 0.5) / samples), r = Math.sqrt(Math.max(0, 1 - y * y)), a = index * GOLDEN_ANGLE + azimuth * DEG;
      return new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r);
    };
    const skyFloor = Math.sin(RIG.sky.minElevation * DEG), bounceCeil = Math.sin(RIG.bounce.maxElevation * DEG);
    const power = {
      key: RIG.key.irradiance,
      sky: (2 * RIG.sky.irradiance) / (1 + skyFloor),
      bounce: (2 * RIG.bounce.irradiance) / (1 - bounceCeil),
      rim: RIG.rim.irradiance,
    };
    let total = 0;
    for (let i = 0; i < samples; i++) {
      const u = halton(i + 1, 2), v = halton(i + 1, 3);
      const tent = (x) => (x < 0.5 ? Math.sqrt(2 * x) - 1 : 1 - Math.sqrt(2 - 2 * x)); // ±1 px triangle filter
      const s = {
        jitter: [tent(u), tent(v)],
        key: cone(RIG.key, orderKey[i]),
        sky: dome(orderSky[i], skyFloor, 1),
        bounce: dome(orderBounce[i], -1, bounceCeil),
        rim: cone(RIG.rim, orderRim[i]),
      };
      s.weights = [
        RIG.key.ground * power.key * Math.max(s.key.y, 0),
        RIG.sky.ground * power.sky * Math.max(s.sky.y, 0) ** 2, // squared: low sky would only draw long streaks
        0,
        RIG.rim.ground * power.rim * Math.max(s.rim.y, 0),
      ];
      total += s.weights[0] + s.weights[1] + s.weights[2] + s.weights[3];
      seq.push(s);
    }
    const norm = total > 0 ? samples / total : 0;
    for (const s of seq) s.weights = s.weights.map((w) => w * norm);
    return { seq, power };
  }

  /** Average `samples` jittered renders of the frame { full, x, y } (in pixels of a virtual full-size picture). */
  function accumulate(size, samples, frame, azimuth) {
    const t = targetsFor(size);
    const { seq, power } = sequences(samples, azimuth);
    const R = state.radius;
    lights.key.intensity = power.key;
    lights.sky.intensity = power.sky;
    lights.bounce.intensity = power.bounce;
    lights.rim.intensity = power.rim;
    let color = 0, groundIndex = 0;
    const add = (pair, index, first) => {
      accumulatePass.material.uniforms.tPrevious.value = pair[index].texture;
      accumulatePass.material.uniforms.tSample.value = t.sample.texture;
      accumulatePass.material.uniforms.uWeight.value = 1 / samples;
      accumulatePass.material.uniforms.uKeep.value = first ? 0 : 1;
      renderer.setRenderTarget(pair[1 - index]);
      renderer.render(accumulatePass.scene, quadCamera);
      return 1 - index;
    };
    for (let i = 0; i < samples; i++) {
      const s = seq[i];
      camera.setViewOffset(frame.full, frame.full, frame.x + s.jitter[0], frame.y + s.jitter[1], size, size);
      for (const name of ['key', 'sky', 'bounce', 'rim']) {
        lights[name].position.copy(state.centre).addScaledVector(s[name], R * 3);
        lights[name].updateMatrixWorld();
      }
      groundUniforms.ttWeight.value = s.weights;

      // the object…
      camera.layers.set(OBJECT_LAYER);
      renderer.shadowMap.needsUpdate = true;
      renderer.setRenderTarget(t.sample);
      renderer.clear(true, true, false);
      renderer.render(scene, camera);
      color = add(t.color, color, i === 0);

      // …then the floor behind it, catching the same shadows (depth is kept from the object pass)
      camera.layers.set(GROUND_LAYER);
      renderer.setRenderTarget(t.sample);
      renderer.clear(true, false, false);
      renderer.render(scene, camera);
      groundIndex = add(t.ground, groundIndex, i === 0);
    }
    resolvePass.material.uniforms.tColor.value = t.color[color].texture;
    resolvePass.material.uniforms.tGround.value = t.ground[groundIndex].texture;
    const read = (coverageOnly) => {
      resolvePass.material.uniforms.uCoverageOnly.value = coverageOnly ? 1 : 0;
      renderer.setRenderTarget(t.out);
      renderer.render(resolvePass.scene, quadCamera);
      const buffer = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(t.out, 0, 0, size, size, buffer);
      return buffer;
    };
    const pixels = read(false);
    // the object without its shadow, to centre the picture on the object itself
    const object = alphaBounds(read(true), size, 6);
    renderer.setRenderTarget(null);
    camera.clearViewOffset();
    return { pixels, object, all: alphaBounds(pixels, size, 3) };
  }

  function alphaBounds(pixels, size, threshold) {
    let minX = size, minY = size, maxX = -1, maxY = -1;
    for (let y = 0; y < size; y++) {
      const row = y * size * 4;
      for (let x = 0; x < size; x++) {
        if (pixels[row + x * 4 + 3] >= threshold) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    return maxX < 0 ? null : { minX, minY, maxX: maxX + 1, maxY: maxY + 1 };
  }

  /**
   * Render `subject`.
   *   view      'hero' | 'front' | 'back' | { azimuth, elevation, lens }
   *   size      picture is size × size pixels
   *   samples   renders averaged into the picture (soft shadows + anti-aliasing); 256 is the house quality
   * Returns { width, height, pixels (Uint8Array RGBA, straight alpha, top row first), bounds, stats }.
   * The object sits in the middle of the frame and its larger side fills `fill` of it; the
   * shadow lives in the margin (the frame only widens when a shadow is larger than the margin).
   * bounds.object / bounds.all are pixel boxes { minX, minY, maxX, maxY } without / with the shadow.
   */
  function render(subject, { view = 'hero', size = 1600, samples = 256, fill = FILL } = {}) {
    const started = performance.now();
    mount(subject);
    const v = resolveView(view);
    const R = state.radius;

    // Camera: orbit, look at the middle, wide enough to hold the object and its shadow.
    const distance = v.lens * R;
    camera.position.copy(state.centre).addScaledVector(orbitDirection(v.azimuth, v.elevation), distance);
    camera.up.set(0, 1, 0);
    camera.lookAt(state.centre);
    const reach = RIG.shadow.fade[1] * R;
    const loose = Math.hypot(state.size.x / 2 + reach, state.size.z / 2 + reach, state.size.y / 2);
    camera.fov = (2 * Math.asin(Math.min(0.9, (loose * 1.03) / distance))) / DEG;
    camera.aspect = 1;
    camera.near = Math.max(distance - loose * 1.6, distance * 0.02);
    camera.far = distance + loose * 1.6;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    scene.environment = environmentFor(v.azimuth);

    // Pass 1 — small and quick, only to see how much of that loose frame is actually used.
    const probeSize = 400, probeSamples = Math.min(24, samples);
    const probe = accumulate(probeSize, probeSamples, { full: probeSize, x: 0, y: 0 }, v.azimuth);
    const o = probe.object, s = probe.all;
    if (!o || !s) throw new Error('kit: nothing was drawn — is the object empty or fully transparent?');
    if (s.minX === 0 || s.minY === 0 || s.maxX === probeSize || s.maxY === probeSize) {
      console.warn('kit: the object or its shadow touches the edge of the probe frame; framing may clip');
    }
    // Pass 2 — the picture: centred on the object, which fills `fill` of the frame.
    const cx = (o.minX + o.maxX) / 2, cy = (o.minY + o.maxY) / 2;
    const half = Math.max(
      (Math.max(o.maxX - o.minX, o.maxY - o.minY) + 2) / 2 / fill,
      cx - s.minX + 2, s.maxX - cx + 2, cy - s.minY + 2, s.maxY - cy + 2,
    );
    const side = (2 * half) / probeSize, full = size / side;
    const shot = accumulate(size, samples, { full, x: (cx / probeSize - side / 2) * full, y: (cy / probeSize - side / 2) * full }, v.azimuth);
    return {
      width: size, height: size, pixels: shot.pixels, bounds: { object: shot.object, all: shot.all },
      stats: { ms: Math.round(performance.now() - started), samples, triangles: state.triangles, radius: +R.toFixed(2), sizeMm: state.size.toArray().map((n) => +n.toFixed(2)) },
    };
  }

  function dispose() {
    for (const set of targetSets.values()) {
      set.sample.dispose(); set.out.dispose();
      set.color.forEach((t) => t.dispose()); set.ground.forEach((t) => t.dispose());
    }
    for (const texture of environments.values()) texture.dispose();
    pmrem.dispose();
    renderer.dispose();
  }

  return { render, dispose, info, renderer, canvas: target };
}
