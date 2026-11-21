// core.js — renders one door: path-traced in a virtual photo studio, on a transparent background.
// Three passes per picture: the beauty (the floor invisible but still bouncing light), then the floor with and
// without the object — render.mjs turns their ratio into a real contact shadow under the object.
import { THREE, loadFonts, ensureTangents } from "./kit.js";
import { WebGLPathTracer } from "three-gpu-pathtracer";

export const LABELS = {
  ar: { devices: "أجهزة الألعاب", games: "الألعاب", controllers: "أيدي التحكم", headsets: "سماعات الرأس", accessories: "الإكسسوارات", topup: "بطاقات الشحن", used: "المستعمل", repair: "الصيانة" },
  en: { devices: "Consoles", games: "Games", controllers: "Controllers", headsets: "Headsets", accessories: "Accessories", topup: "Gift cards", used: "Used", repair: "Repair" },
  ckb: { devices: "ئامێرەکانی یاری", games: "یارییەکان", controllers: "دەسکەکانی یاری", headsets: "هێدسێتەکان", accessories: "پاشکۆکان", topup: "کارتی باڵانس", used: "بەکارهاتوو", repair: "چاککردنەوە" },
};
export const DOORS = Object.keys(LABELS.ar);

const query = new URLSearchParams(location.search);
const W = Number(query.get("w")) || 1600;
const H = Number(query.get("h")) || 1200;
const ASPECT = W / H;

// ───────────────────────────── renderer + path tracer
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.9;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const tracer = new WebGLPathTracer(renderer);
tracer.renderDelay = 0;
tracer.fadeDuration = 0;
tracer.minSamples = 1;
tracer.rasterizeScene = false;
tracer.dynamicLowRes = false;
tracer.tiles.set(2, 2);
tracer.bounces = 7;
tracer.transmissiveBounces = 5;
tracer.filterGlossyFactor = 0.3;
tracer.multipleImportanceSampling = true;
tracer.textureSize.set(2048, 2048);

// ───────────────────────────── camera: a long lens, a little above; the frame is 2 world units tall at the origin
const FOV = 16;
const ELEVATION = THREE.MathUtils.degToRad(12);
const DIST = 1 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const camera = new THREE.PerspectiveCamera(FOV, ASPECT, 0.1, 100);
camera.position.set(0, DIST * Math.sin(ELEVATION), DIST * Math.cos(ELEVATION));
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

// ───────────────────────────── the studio: soft boxes in an HDR environment (only their reflections and light show)
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function frameOf(dir) {
  const d = new THREE.Vector3(...dir).normalize();
  const ref = Math.abs(d.y) > 0.95 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
  const t1 = new THREE.Vector3().crossVectors(ref, d).normalize();
  const t2 = new THREE.Vector3().crossVectors(d, t1).normalize();
  return { d, t1, t2 };
}
/** Default studio. Each light: direction (towards the light), half-size in tangent units, edge softness, radiance, colour. */
export const STUDIO = {
  base: 0.025,
  sky: 0.05,
  ground: 0.03,
  lights: [
    { name: "key", dir: [-0.66, 0.74, 0.78], size: [0.55, 0.38], soft: 0.07, power: 5.2, color: [1, 0.985, 0.96] },
    { name: "fill", dir: [0.95, 0.15, 0.72], size: [0.5, 0.5], soft: 0.15, power: 0.7, color: [0.94, 0.97, 1] },
    { name: "top", dir: [0.05, 1, 0.12], size: [0.6, 0.5], soft: 0.12, power: 2.0, color: [1, 1, 1] },
    { name: "rimL", dir: [-0.95, 0.3, -0.5], size: [0.08, 0.8], soft: 0.03, power: 10, color: [0.86, 0.91, 1] },
    { name: "rimR", dir: [0.95, 0.3, -0.5], size: [0.08, 0.8], soft: 0.03, power: 10, color: [0.86, 0.91, 1] },
    { name: "front", dir: [0, -0.14, 1], size: [1.2, 0.14], soft: 0.12, power: 0.45, color: [1, 1, 1] },
  ],
};
function studioEnvironment(studio) {
  const w = 1024;
  const h = 512;
  const data = new Float32Array(w * h * 4);
  const lights = studio.lights.map((l) => ({ ...l, ...frameOf(l.dir) }));
  const dir = new THREE.Vector3();
  for (let r = 0; r < h; r++) {
    const v = (r + 0.5) / h;
    const phi = (1 - v) * Math.PI;
    const sp = Math.sin(phi);
    for (let c = 0; c < w; c++) {
      const u = (c + 0.5) / w;
      const theta = (u - 0.5) * 2 * Math.PI;
      dir.set(sp * Math.cos(theta), Math.cos(phi), sp * Math.sin(theta));
      const y = dir.y;
      let base = studio.base + (y > 0 ? studio.sky * y : studio.ground * -y);
      let R = base, G = base, B = base * 1.03;
      for (const L of lights) {
        const cos = dir.dot(L.d);
        if (cos <= 0) continue;
        const x = dir.dot(L.t1) / cos;
        const yy = dir.dot(L.t2) / cos;
        const fx = 1 - smoothstep(L.size[0] - L.soft, L.size[0] + L.soft, Math.abs(x));
        const fy = 1 - smoothstep(L.size[1] - L.soft, L.size[1] + L.soft, Math.abs(yy));
        if (fx <= 0 || fy <= 0) continue;
        // brighter at the centre, as a diffused soft box is
        const centre = 1 - 0.25 * ((x / L.size[0]) ** 2 + (yy / L.size[1]) ** 2) * 0.5;
        const k = L.power * fx * fy * Math.max(0.6, centre);
        R += k * L.color[0];
        G += k * L.color[1];
        B += k * L.color[2];
      }
      const i = (r * w + c) * 4;
      data[i] = R;
      data[i + 1] = G;
      data[i + 2] = B;
      data[i + 3] = 1;
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
/** The shadow table: an overhead soft box and an even dome, so the contact shadow sits under the object. */
export const SHADOW_STUDIO = {
  base: 0.3,
  sky: 0.25,
  ground: 0,
  lights: [{ name: "top", dir: [0, 1, 0.1], size: [0.42, 0.42], soft: 0.1, power: 6, color: [1, 1, 1] }],
};
let environment = studioEnvironment(STUDIO);
const shadowEnvironment = studioEnvironment(SHADOW_STUDIO);
export function setStudio(studio) {
  environment.dispose();
  environment = studioEnvironment(studio);
}

// ───────────────────────────── framing: the whole object inside the picture, nothing cut
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3().subVectors(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion), new THREE.Vector3()).normalize();
function ndcBounds(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  object.traverse((child) => {
    if (!child.isMesh || !child.visible) return;
    const pos = child.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 6000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld).project(camera);
      box.expandByPoint(v);
    }
  });
  return box;
}
function fit(object, meta) {
  const [mx, my] = meta.margin;
  for (let pass = 0; pass < 5; pass++) {
    const b = ndcBounds(object);
    const sx = mx / ((b.max.x - b.min.x) / 2);
    const sy = my / ((b.max.y - b.min.y) / 2);
    object.scale.multiplyScalar(Math.min(sx, sy));
    const b2 = ndcBounds(object);
    object.position.addScaledVector(RIGHT, (-(b2.max.x + b2.min.x) / 2) * ASPECT);
    object.position.addScaledVector(UP, meta.centerY - (b2.max.y + b2.min.y) / 2);
  }
}

// ───────────────────────────── the floor (a light grey table)
const floorMaterial = new THREE.MeshPhysicalMaterial({ color: "#b9b9b6", roughness: 0.9 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMaterial);
floor.rotation.x = -Math.PI / 2;

// ───────────────────────────── tracing
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** The canvas as raw RGBA (premultiplied, bottom-up rows), base64 — far faster than toDataURL on a GPU canvas. */
async function grab() {
  const gl = renderer.getContext();
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  const px = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const b64 = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.readAsDataURL(new Blob([px]));
  });
  return { b64, w, h };
}
/**
 * Accumulates `spp` samples. WebGL calls return before the GPU has done the work (finish() does not block in
 * Chrome), so a fence every few calls keeps the queue short and makes the timings real.
 */
async function trace(spp) {
  tracer.reset();
  const gl = renderer.getContext();
  let calls = 0;
  let fence = null;
  const settle = async () => {
    if (!fence) return;
    while (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) await new Promise((resolve) => setTimeout(resolve, 1));
    gl.deleteSync(fence);
    fence = null;
  };
  while (tracer.samples < spp) {
    if (tracer.isCompiling) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    tracer.renderSample();
    calls++;
    if (calls % 4 === 0) {
      await settle();
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    }
  }
  tracer.renderSample();
  await settle();
  fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  gl.flush();
  await settle();
}
/**
 * The tracer merges meshes with ONE material slot per mesh (three-gpu-pathtracer 0.0.28): a mesh with a material
 * array shifts every later mesh onto the wrong material. Split such meshes into one mesh per geometry group.
 */
function splitMultiMaterial(root) {
  const targets = [];
  root.traverse((c) => {
    if (c.isMesh && Array.isArray(c.material)) targets.push(c);
  });
  for (const mesh of targets) {
    const g = mesh.geometry;
    const total = g.index ? g.index.count : g.attributes.position.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
    const parts = new THREE.Group();
    parts.position.copy(mesh.position);
    parts.quaternion.copy(mesh.quaternion);
    parts.scale.copy(mesh.scale);
    parts.name = mesh.name;
    for (const grp of groups) {
      const mat = mesh.material[grp.materialIndex];
      if (!mat || grp.count <= 0) continue;
      const sub = new THREE.BufferGeometry();
      if (g.index) {
        for (const [name, attr] of Object.entries(g.attributes)) sub.setAttribute(name, attr);
        sub.setIndex(Array.from(g.index.array.slice(grp.start, grp.start + Math.min(grp.count, total - grp.start))));
      } else {
        const end = Math.min(grp.start + grp.count, total);
        for (const [name, attr] of Object.entries(g.attributes)) {
          const n = attr.itemSize;
          sub.setAttribute(name, new THREE.BufferAttribute(attr.array.slice(grp.start * n, end * n), n, attr.normalized));
        }
      }
      parts.add(new THREE.Mesh(sub, mat));
    }
    mesh.parent.add(parts);
    mesh.parent.remove(mesh);
  }
}
function prepare(object) {
  splitMultiMaterial(object);
  object.traverse((child) => {
    if (!child.isMesh) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    if (mats.some((m) => m && (m.normalMap || m.clearcoatNormalMap))) ensureTangents(child.geometry);
  });
}

let fontsReady = loadFonts();
export const ready = fontsReady.then(() => true);

/**
 * Renders a door. Returns three raw RGBA grabs (beauty, floor lit with the object, floor alone) and timings.
 * opts: spp (beauty samples), shadowSpp, bust (cache-buster for the object module), studio (override lights).
 */
export async function renderDoor(key, lang, opts = {}) {
  await fontsReady;
  const timings = {};
  let tm = performance.now();
  const lap = (name) => {
    const now = performance.now();
    timings[name] = (timings[name] ?? 0) + (now - tm);
    tm = now;
  };
  if (opts.studio) setStudio(opts.studio);
  const mod = await import(`./objects/${key}.js?v=${opts.bust ?? 0}`);
  const meta = { turn: -0.3, tilt: 0.0, gap: 0.0, margin: [0.9, 0.82], centerY: 0.06, ...(mod.meta ?? {}) };
  const object = mod.build({ text: LABELS[lang][key], lang, key });
  const holder = new THREE.Group();
  holder.add(object);
  holder.rotation.set(meta.tilt, meta.turn, 0);
  lap("build");
  prepare(holder);
  fit(holder, meta);
  lap("prepare");
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  floor.position.set(0, box.min.y - meta.gap, 0);

  const scene = new THREE.Scene();
  scene.background = null;
  scene.environment = environment;
  scene.environmentIntensity = opts.environmentIntensity ?? 1;
  scene.add(holder, floor);

  // 1 — beauty: the floor is matte (invisible to the camera, still there for bounce light)
  floorMaterial.matte = true;
  scene.environment = environment;
  tm = performance.now();
  tracer.setScene(scene, camera);
  lap("setScene");
  await trace(opts.spp ?? 512);
  lap("beauty");
  const beauty = await grab();
  lap("encode");

  let lit = null;
  let bare = null;
  if ((opts.shadowSpp ?? 160) > 0) {
    // 2 — the floor seen, with the object, on the shadow table
    floorMaterial.matte = false;
    scene.environment = shadowEnvironment;
    scene.environmentIntensity = 1;
    tracer.updateMaterials();
    tracer.updateEnvironment();
    lap("setScene");
    await trace(opts.shadowSpp ?? 160);
    lap("lit");
    lit = await grab();
    lap("encode");
    // 3 — the floor alone
    scene.remove(holder);
    tracer.setScene(scene, camera);
    lap("setScene");
    await trace(opts.shadowSpp ?? 160);
    lap("bare");
    bare = await grab();
    lap("encode");
  }
  floorMaterial.matte = true;

  let triangles = 0;
  holder.traverse((c) => {
    if (c.isMesh) triangles += (c.geometry.index ? c.geometry.index.count : c.geometry.attributes.position.count) / 3;
  });
  return { beauty, lit, bare, timings, triangles: Math.round(triangles), size: [W, H] };
}

window.renderDoor = renderDoor;
window.DOORS = DOORS;
window.studioReady = ready;
