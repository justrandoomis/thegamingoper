// TamTam home department doors — modelled and rendered with three.js (no generated pictures).
// Each door is a whole product built from primitives whose own dark panel carries the department's name.
// Transparent background: only the object and its soft contact shadow are drawn. Every object is fitted
// to the frame, so nothing is cut at the edges.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/addons/lights/RectAreaLightUniformsLib.js";

const SIZE = 1024;
const LABELS = {
  ar: { devices: "أجهزة الألعاب", games: "الألعاب", controllers: "أيدي التحكم", headsets: "سماعات الرأس", accessories: "الإكسسوارات", topup: "بطاقات الشحن", used: "المستعمل", repair: "الصيانة" },
  en: { devices: "Consoles", games: "Games", controllers: "Controllers", headsets: "Headsets", accessories: "Accessories", topup: "Gift cards", used: "Used", repair: "Repair" },
  ckb: { devices: "ئامێرەکانی یاری", games: "یارییەکان", controllers: "دەسکەکانی یاری", headsets: "هێدسێتەکان", accessories: "پاشکۆکان", topup: "کارتی باڵانس", used: "بەکارهاتوو", repair: "چاککردنەوە" },
};
const FONT = '"KufamLatin", "KufamArabic", "KufamArabicExt", sans-serif';

// ───────────────────────────── renderer, camera
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(2);
renderer.setSize(SIZE, SIZE);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
RectAreaLightUniformsLib.init();

// a long lens, a little above the object: the frame is 2 × 2 world units at the origin
const FOV = 16;
const ELEVATION = THREE.MathUtils.degToRad(11);
const DIST = 1 / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
camera.position.set(0, DIST * Math.sin(ELEVATION), DIST * Math.cos(ELEVATION));
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

/** A studio: soft area key and fill, a shadow-casting key, two cool rims, the room's reflections. */
function baseScene() {
  const scene = new THREE.Scene();
  scene.environment = envMap;
  scene.environmentIntensity = 0.45;

  const key = new THREE.RectAreaLight("#ffffff", 7, 3.2, 2.2);
  key.position.set(-2.2, 3.2, 4);
  key.lookAt(0, 0, 0);
  scene.add(key);
  const fill = new THREE.RectAreaLight("#cfdcff", 2.6, 3, 3);
  fill.position.set(3.4, 0.4, 3.2);
  fill.lookAt(0, 0, 0);
  scene.add(fill);

  const sun = new THREE.DirectionalLight("#ffffff", 1.6);
  sun.position.set(-1.6, 4.2, 3.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.5, far: 14 });
  sun.shadow.radius = 6;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);

  for (const side of [-1, 1]) {
    const rim = new THREE.SpotLight("#8aa6ff", 26, 9, Math.PI / 5, 0.7, 2);
    rim.position.set(side * 3, 1.4, -2.2);
    rim.target.position.set(0, 0, 0);
    scene.add(rim, rim.target);
  }
  scene.add(new THREE.HemisphereLight("#ffffff", "#20222c", 0.35));
  return scene;
}

// ───────────────────────────── materials
function noiseTexture(repeatX, repeatY, low = 100, spread = 80) {
  const n = document.createElement("canvas");
  n.width = n.height = 256;
  const g = n.getContext("2d");
  for (let i = 0; i < 256; i += 2) for (let j = 0; j < 256; j += 2) {
    const v = low + Math.floor(Math.random() * spread);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(i, j, 2, 2);
  }
  const t = new THREE.CanvasTexture(n);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  return t;
}
const M = {
  panel: () => new THREE.MeshPhysicalMaterial({ color: "#131419", roughness: 0.4, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.28 }),
  gloss: () => new THREE.MeshPhysicalMaterial({ color: "#08090d", roughness: 0.22, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.18 }),
  matte: (color = "#16171c") => new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.05 }),
  white: () => new THREE.MeshPhysicalMaterial({ color: "#f1f2f5", roughness: 0.42, clearcoat: 0.5, clearcoatRoughness: 0.35 }),
  grey: () => new THREE.MeshPhysicalMaterial({ color: "#454851", roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.45 }),
  rubber: () => new THREE.MeshStandardMaterial({ color: "#0c0d10", roughness: 0.72 }),
  red: () => new THREE.MeshPhysicalMaterial({ color: "#dc1620", roughness: 0.42, clearcoat: 0.6, clearcoatRoughness: 0.3 }),
  fabric: (color = "#191a20") => new THREE.MeshPhysicalMaterial({ color, roughness: 0.95, sheen: 1, sheenRoughness: 0.55, sheenColor: new THREE.Color("#6b7080"), bumpMap: noiseTexture(14, 7), bumpScale: 0.7 }),
  steel: () => new THREE.MeshPhysicalMaterial({ color: "#cfd4dc", roughness: 0.3, metalness: 1, anisotropy: 0.6 }),
  gunmetal: () => new THREE.MeshPhysicalMaterial({ color: "#2a2d34", roughness: 0.42, metalness: 0.8, clearcoat: 0.3, clearcoatRoughness: 0.4 }),
  gold: () => new THREE.MeshStandardMaterial({ color: "#e6b858", roughness: 0.26, metalness: 1 }),
  glow: (color, k = 1.6) => new THREE.MeshStandardMaterial({ color: "#05060a", emissive: color, emissiveIntensity: k, roughness: 0.4 }),
};

// ───────────────────────────── builders
function solid(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
function rbox(w, h, d, r, mat) {
  return solid(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 10, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), mat));
}
/** A slab in the xy plane: corner radius r, depth d, soft bevelled edges. Centred on the origin. */
function slab(w, h, d, r, mat, bevel = 0.022) {
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001);
  const b = Math.min(bevel, d / 2 - 0.001, r * 0.9);
  const iw = w / 2 - b;
  const ih = h / 2 - b;
  const ir = Math.max(r - b, 0.001);
  const shape = new THREE.Shape();
  shape.moveTo(-iw + ir, -ih);
  shape.lineTo(iw - ir, -ih);
  shape.absarc(iw - ir, -ih + ir, ir, -Math.PI / 2, 0, false);
  shape.lineTo(iw, ih - ir);
  shape.absarc(iw - ir, ih - ir, ir, 0, Math.PI / 2, false);
  shape.lineTo(-iw + ir, ih);
  shape.absarc(-iw + ir, ih - ir, ir, Math.PI / 2, Math.PI, false);
  shape.lineTo(-iw, -ih + ir);
  shape.absarc(-iw + ir, -ih + ir, ir, Math.PI, Math.PI * 1.5, false);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: d - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 8, curveSegments: 32 });
  geo.translate(0, 0, -(d - 2 * b) / 2);
  return solid(new THREE.Mesh(geo, mat));
}
/** A disc facing the camera (axis z). */
function disc(r, h, mat, seg = 64) {
  const m = solid(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat));
  m.rotation.x = Math.PI / 2;
  return m;
}
function at(mesh, x, y, z = 0) {
  mesh.position.set(x, y, z);
  return mesh;
}
/** An arch in the xy plane, from angle a0 to a1 (radians, 0 = +x). */
function arch(radius, tube, a0, a1, mat) {
  const m = solid(new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 28, 120, a1 - a0), mat));
  m.rotation.z = a0;
  return m;
}
function ball(r, mat) {
  return solid(new THREE.Mesh(new THREE.SphereGeometry(r, 64, 48), mat));
}
/** An analog stick: well, stem, cap and rim. */
function stick(scale = 1) {
  const g = new THREE.Group();
  g.add(at(disc(0.17, 0.03, M.gloss()), 0, 0, 0));
  g.add(at(disc(0.07, 0.1, M.rubber()), 0, 0, 0.05));
  g.add(at(disc(0.125, 0.035, M.rubber()), 0, 0, 0.11));
  const rim = solid(new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.016, 16, 48), M.matte("#22242a")));
  rim.position.z = 0.128;
  g.add(rim);
  g.scale.setScalar(scale);
  return g;
}

// ───────────────────────────── the name, printed on the object's own panel
function labelPlane(text, lang, width, height, opts = {}) {
  const W = 2048;
  const H = Math.round((W * height) / width);
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  g.direction = lang === "en" ? "ltr" : "rtl";
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  const maxW = W * (opts.fitW ?? 0.82);
  const maxH = H * (opts.fitH ?? 0.52);
  let size = maxH;
  let box;
  for (;;) {
    g.font = `700 ${size}px ${FONT}`;
    const m = g.measureText(text);
    box = { w: m.width, up: m.actualBoundingBoxAscent, down: m.actualBoundingBoxDescent };
    if ((box.w <= maxW && box.up + box.down <= maxH * 1.25) || size < 40) break;
    size *= 0.96;
  }
  const y = H / 2 + (box.up - box.down) / 2;
  g.shadowColor = "rgba(0,0,0,0.6)";
  g.shadowBlur = size * 0.05;
  g.shadowOffsetY = size * 0.012;
  g.fillStyle = "#ffffff";
  g.fillText(text, W / 2, y);
  g.shadowColor = "transparent";
  g.fillText(text, W / 2, y);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.55, emissive: "#ffffff", emissiveMap: tex, emissiveIntensity: 0.6, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
}
/** The dark panel with the name on its face. */
function titledPanel(text, lang, w, h, d, r, mat, labelOpts) {
  const g = new THREE.Group();
  g.add(slab(w, h, d, r, mat));
  g.add(at(labelPlane(text, lang, w, h, labelOpts), 0, 0, d / 2 + 0.004));
  return g;
}

// ───────────────────────────── the eight objects (each returns a whole object, built around the origin)
const BUILD = {
  /** A gamepad: white grips with sticks, d-pad and buttons; the touch panel carries the name. */
  controllers(text, lang) {
    const o = new THREE.Group();
    // the dark middle of the pad, behind the panel
    o.add(at(slab(1.66, 1.0, 0.3, 0.34, M.matte("#15161b")), 0, -0.1, -0.08));
    for (const s of [-1, 1]) {
      const shell = ball(0.46, M.white());
      shell.scale.set(0.92, 1.0, 0.5);
      o.add(at(shell, s * 0.9, 0.04, -0.1));
      const horn = solid(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.46, 16, 32), M.white()));
      horn.rotation.z = s * 0.3;
      horn.scale.z = 0.78;
      o.add(at(horn, s * 0.98, -0.46, -0.13));
      o.add(at(stick(0.86), s * 0.5, -0.38, 0.07));
      // shoulder buttons
      o.add(at(rbox(0.3, 0.09, 0.16, 0.04, M.gloss()), s * 0.82, 0.46, -0.14));
    }
    for (const [dx, dy] of [[0, 0.07], [0, -0.07], [0.07, 0], [-0.07, 0]]) {
      o.add(at(rbox(0.058, 0.058, 0.03, 0.012, M.gloss()), -1.0 + dx, 0.12 + dy, 0.12));
      o.add(at(disc(0.03, 0.03, M.gloss()), 1.0 + dx, 0.12 + dy, 0.12));
    }
    o.add(at(slab(1.545, 0.6, 0.16, 0.21, M.glow("#1f55ff", 1.5)), 0, 0.08, 0.0));
    o.add(at(titledPanel(text, lang, 1.5, 0.555, 0.2, 0.2, M.panel()), 0, 0.08, 0.03));
    return o;
  },

  /** A home console lying flat: white shells, blue light strips, a glossy black body. */
  devices(text, lang) {
    const o = new THREE.Group();
    for (const s of [-1, 1]) {
      const shell = slab(0.42, 0.96, 0.62, 0.2, M.white(), 0.05);
      shell.rotation.z = s * -0.04;
      o.add(at(shell, s * 0.97, 0, -0.06));
      o.add(at(rbox(0.035, 0.6, 0.34, 0.015, M.glow("#1f6bff", 1.8)), s * 0.805, 0, 0.03));
    }
    o.add(at(slab(1.78, 0.8, 0.44, 0.3, M.matte("#191a20")), 0, 0, -0.08));
    // disc slot and two small ports
    o.add(at(rbox(0.36, 0.014, 0.02, 0.006, M.matte("#30323a")), -0.44, 0.365, 0.14));
    o.add(at(rbox(0.05, 0.02, 0.02, 0.006, M.steel()), 0.5, 0.365, 0.14));
    o.add(at(rbox(0.05, 0.02, 0.02, 0.006, M.steel()), 0.6, 0.365, 0.14));
    o.add(at(titledPanel(text, lang, 1.56, 0.62, 0.3, 0.26, M.gloss()), 0, -0.02, 0.08));
    return o;
  },

  /** A game case: translucent blue shell, two discs showing at the sides, the cover carries the name. */
  games(text, lang) {
    const o = new THREE.Group();
    const shell = new THREE.MeshPhysicalMaterial({ color: "#2148c8", roughness: 0.15, transparent: true, opacity: 0.62, clearcoat: 1, clearcoatRoughness: 0.1 });
    o.add(at(slab(2.0, 0.92, 0.12, 0.04, shell, 0.012), 0, 0, -0.1));
    for (const s of [-1, 1]) {
      const cc = document.createElement("canvas");
      cc.width = cc.height = 512;
      const cg = cc.getContext("2d");
      const conic = cg.createConicGradient(s * 0.6, 256, 256);
      const stops = ["#aeb4c2", "#eef1f6", "#9fd0ff", "#c9a6ff", "#ffc9a8", "#eef1f6", "#8f95a3", "#dfe3ea", "#a8ffd8", "#9fd0ff", "#eef1f6", "#aeb4c2"];
      stops.forEach((color, i) => conic.addColorStop(i / (stops.length - 1), color));
      cg.fillStyle = conic;
      cg.fillRect(0, 0, 512, 512);
      const sheen = new THREE.CanvasTexture(cc);
      sheen.colorSpace = THREE.SRGBColorSpace;
      const face = new THREE.MeshStandardMaterial({ map: sheen, roughness: 0.28, metalness: 0.85 });
      o.add(at(disc(0.38, 0.012, [M.steel(), face, M.steel()], 96), s * 0.6, 0, -0.02));
      o.add(at(disc(0.12, 0.014, M.steel()), s * 0.6, 0, -0.016));
      o.add(at(disc(0.042, 0.02, M.gloss()), s * 0.6, 0, -0.012));
    }
    o.add(at(titledPanel(text, lang, 1.34, 0.84, 0.09, 0.03, M.matte("#191a20"), { fitW: 0.74, fitH: 0.4 }), 0, 0, 0.05));
    o.add(at(rbox(0.012, 0.8, 0.095, 0.004, M.matte("#2f313a")), -0.63, 0, 0.055));
    return o;
  },

  /** A headset: a red padded band over the top, cushioned cups at the sides, the name on its band panel. */
  headsets(text, lang) {
    const o = new THREE.Group();
    const outer = arch(0.9, 0.07, 0.02, Math.PI - 0.02, M.gunmetal());
    outer.scale.y = 0.78;
    o.add(at(outer, 0, -0.02, -0.06));
    const pad = arch(0.82, 0.1, 0.5, Math.PI - 0.5, M.red());
    pad.scale.y = 0.76;
    o.add(at(pad, 0, -0.02, -0.04));
    for (const s of [-1, 1]) {
      const cup = ball(0.36, M.gunmetal());
      cup.scale.set(0.42, 1.0, 0.9);
      o.add(at(cup, s * 0.97, -0.2, -0.06));
      const cushion = solid(new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.085, 24, 64), M.rubber()));
      cushion.rotation.y = Math.PI / 2;
      cushion.scale.set(1, 1.15, 1);
      o.add(at(cushion, s * 0.86, -0.2, -0.06));
      const ring = solid(new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.02, 16, 64), M.red()));
      ring.rotation.y = Math.PI / 2;
      ring.scale.set(1, 1.15, 1);
      o.add(at(ring, s * 1.07, -0.2, -0.06));
    }
    o.add(at(titledPanel(text, lang, 1.6, 0.54, 0.22, 0.2, M.panel()), 0, -0.2, 0.08));
    return o;
  },

  /** A carrying case: red trim and handle, a strapped cable across the front, the name on the fabric lid. */
  accessories(text, lang) {
    const o = new THREE.Group();
    o.add(at(slab(1.9, 0.98, 0.34, 0.32, M.red(), 0.04), 0, 0, -0.1));
    const handle = arch(0.34, 0.05, 0.12, Math.PI - 0.12, M.rubber());
    handle.scale.y = 0.72;
    o.add(at(handle, 0, 0.46, -0.1));
    const grip = arch(0.34, 0.068, 0.8, Math.PI - 0.8, M.red());
    grip.scale.y = 0.72;
    o.add(at(grip, 0, 0.46, -0.1));
    o.add(at(titledPanel(text, lang, 1.8, 0.88, 0.36, 0.29, M.fabric(), { fitW: 0.78, fitH: 0.3 }), 0, 0.02, 0));
    // the cable, its strap and its plug
    for (const y of [-0.26, -0.31]) {
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.66, y, 0.2), new THREE.Vector3(-0.2, y - 0.012, 0.205), new THREE.Vector3(0.25, y - 0.004, 0.205), new THREE.Vector3(0.6, y, 0.2)]);
      o.add(solid(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.02, 16), M.rubber())));
    }
    o.add(at(rbox(0.12, 0.14, 0.06, 0.02, M.red()), -0.05, -0.285, 0.21));
    o.add(at(rbox(0.12, 0.055, 0.045, 0.018, M.rubber()), 0.64, -0.26, 0.2));
    o.add(at(rbox(0.07, 0.035, 0.028, 0.01, M.steel()), 0.73, -0.26, 0.2));
    return o;
  },

  /** Gift cards: two lit cards with gold chips fanned behind, the front card carries the name. */
  topup(text, lang) {
    const o = new THREE.Group();
    for (const [s, color] of [[-1, "#2f8bff"], [1, "#ffb43a"]]) {
      const back = new THREE.Group();
      back.add(slab(1.42, 0.9, 0.035, 0.09, M.glow(color, 1.7), 0.012));
      back.add(at(slab(1.385, 0.865, 0.04, 0.078, M.matte("#23252f"), 0.012), 0, 0, 0.003));
      back.add(at(slab(0.2, 0.16, 0.014, 0.035, M.gold(), 0.005), s * 0.5, 0.12, 0.026));
      for (const dy of [-0.035, 0, 0.035]) back.add(at(rbox(0.2, 0.004, 0.016, 0.001, M.matte("#8a6a26")), s * 0.5, 0.12 + dy, 0.027));
      back.rotation.z = s * -0.13;
      o.add(at(back, s * 0.3, 0.07, -0.12 - (s > 0 ? 0.05 : 0)));
    }
    o.add(at(titledPanel(text, lang, 1.42, 0.9, 0.05, 0.09, M.panel(), { fitW: 0.8, fitH: 0.34 }), 0, -0.06, 0.02));
    return o;
  },

  /** A handheld console: grips with sticks and buttons, an inspection tick; the screen carries the name. */
  used(text, lang) {
    const o = new THREE.Group();
    o.add(at(slab(1.56, 0.9, 0.14, 0.08, M.matte("#1d1e24")), 0, 0, -0.03));
    for (const s of [-1, 1]) {
      o.add(at(slab(0.4, 0.9, 0.17, 0.17, M.grey()), s * 0.93, 0, -0.03));
      o.add(at(stick(0.66), s * 0.93, s === -1 ? 0.2 : -0.12, 0.06));
      const cy = s === -1 ? -0.14 : 0.2;
      for (const [dx, dy] of [[0, 0.06], [0, -0.06], [0.06, 0], [-0.06, 0]]) o.add(at(disc(0.026, 0.03, M.gloss()), s * 0.93 + dx, cy + dy, 0.06));
      o.add(at(rbox(0.26, 0.05, 0.12, 0.02, M.gloss()), s * 0.9, 0.46, -0.05));
    }
    o.add(at(titledPanel(text, lang, 1.4, 0.76, 0.1, 0.04, M.gloss(), { fitW: 0.74, fitH: 0.36 }), 0, 0, 0.02));
    // the inspection tick: a green enamel seal on the corner of the screen (no words)
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    g.fillStyle = "#17a34a";
    g.beginPath();
    g.arc(128, 128, 120, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#ffffff";
    g.lineWidth = 12;
    g.beginPath();
    g.arc(128, 128, 98, 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 28;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.beginPath();
    g.moveTo(78, 132);
    g.lineTo(114, 168);
    g.lineTo(182, 94);
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const seal = disc(0.085, 0.014, [M.matte("#0e7a36"), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 }), M.matte("#0e7a36")]);
    seal.rotation.y = Math.PI / 2; // turn the cap's texture upright
    o.add(at(seal, -0.58, 0.27, 0.08));
    return o;
  },

  /** A toolbox: gunmetal body, red latches and handle, a wrench and a screwdriver in it; the name on its plate. */
  repair(text, lang) {
    const o = new THREE.Group();
    o.add(at(slab(1.9, 0.86, 0.5, 0.07, M.gunmetal(), 0.03), 0, -0.1, -0.2));
    o.add(at(rbox(1.92, 0.02, 0.52, 0.005, M.matte("#0b0c0f")), 0, 0.17, -0.2));
    const handle = arch(0.34, 0.05, 0.08, Math.PI - 0.08, M.red());
    handle.scale.y = 0.6;
    o.add(at(handle, 0, 0.32, -0.2));
    for (const s of [-1, 1]) {
      o.add(at(rbox(0.13, 0.3, 0.07, 0.03, M.red()), s * 0.82, 0.02, 0.07));
      o.add(at(rbox(0.15, 0.05, 0.08, 0.02, M.steel()), s * 0.82, 0.18, 0.07));
      o.add(at(disc(0.02, 0.09, M.steel()), s * 0.82, -0.07, 0.08));
    }
    const shaft = solid(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 24), M.steel()));
    shaft.rotation.z = 0.22;
    o.add(at(shaft, -0.7, 0.62, -0.32));
    const grip = solid(new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.2, 12, 24), M.red()));
    grip.rotation.z = 0.22;
    o.add(at(grip, -0.63, 0.36, -0.32));
    const jaw = solid(new THREE.Mesh(new THREE.TorusGeometry(0.085, 0.034, 16, 48, Math.PI * 1.45), M.steel()));
    jaw.rotation.z = Math.PI * 0.55;
    o.add(at(jaw, 0.74, 0.72, -0.32));
    const bar = rbox(0.07, 0.44, 0.03, 0.012, M.steel());
    bar.rotation.z = -0.2;
    o.add(at(bar, 0.69, 0.45, -0.32));
    o.add(at(titledPanel(text, lang, 1.4, 0.54, 0.12, 0.2, M.panel()), 0, -0.12, 0.06));
    return o;
  },
};

// ───────────────────────────── framing: the whole object inside the picture, nothing cut
const TURN = -0.2; // a slight three-quarter turn, so the depth reads
const MARGIN = 0.9; // the object fills 90% of the frame's width or height

function ndcBounds(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  object.traverse((child) => {
    if (!child.isMesh) return;
    const pos = child.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(child.matrixWorld).project(camera);
      box.expandByPoint(v);
    }
  });
  return box;
}
const RIGHT = new THREE.Vector3(1, 0, 0);
const UP = new THREE.Vector3(0, Math.cos(ELEVATION), -Math.sin(ELEVATION));
function fit(object) {
  for (let pass = 0; pass < 4; pass++) {
    const b = ndcBounds(object);
    const half = Math.max((b.max.x - b.min.x) / 2, (b.max.y - b.min.y) / 2);
    object.scale.multiplyScalar(MARGIN / half);
    const b2 = ndcBounds(object);
    object.position.addScaledVector(RIGHT, -(b2.max.x + b2.min.x) / 2);
    object.position.addScaledVector(UP, -(b2.max.y + b2.min.y) / 2);
  }
}
/** A soft contact shadow on the ground under the object. */
function contactShadow(object) {
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(0,0,0,0.5)");
  grad.addColorStop(0.5, "rgba(0,0,0,0.22)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const w = (box.max.x - box.min.x) * 1.08;
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.5), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.set((box.max.x + box.min.x) / 2, box.min.y - 0.015, (box.max.z + box.min.z) / 2);
  return blob;
}

// ───────────────────────────── fonts, then the entry point the render script calls
async function loadFonts() {
  const faces = [
    new FontFace("KufamLatin", "url(/fonts/kufam-latin-wght.7073ba7c.woff2)", { weight: "400 900" }),
    new FontFace("KufamArabic", "url(/fonts/kufam-arabic-wght.3e456e1b.woff2)", { weight: "400 900" }),
    new FontFace("KufamArabicExt", "url(/fonts/kufam-arabic-wght-ext.c2703ab5.woff2)", { weight: "400 900" }),
  ];
  for (const face of faces) document.fonts.add(await face.load());
}
const ready = loadFonts();

window.renderDoor = async (key, lang) => {
  await ready;
  const scene = baseScene();
  const object = BUILD[key](LABELS[lang][key], lang);
  object.rotation.y = TURN;
  scene.add(object);
  fit(object);
  scene.add(contactShadow(object));
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
};
window.DOORS = Object.keys(BUILD);
window.studioReady = ready.then(() => true);
