// TamTam home department doors — modelled and rendered with three.js (no generated pictures).
// Each door: a product built from primitives whose own dark panel carries the department's name.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const SIZE = 1024;
const LABELS = {
  ar: { devices: "أجهزة الألعاب", games: "الألعاب", controllers: "أيدي التحكم", headsets: "سماعات الرأس", accessories: "الإكسسوارات", topup: "بطاقات الشحن", used: "المستعمل", repair: "الصيانة" },
  en: { devices: "Consoles", games: "Games", controllers: "Controllers", headsets: "Headsets", accessories: "Accessories", topup: "Gift cards", used: "Used", repair: "Repair" },
  ckb: { devices: "ئامێرەکانی یاری", games: "یارییەکان", controllers: "دەسکەکانی یاری", headsets: "هێدسێتەکان", accessories: "پاشکۆکان", topup: "کارتی باڵانس", used: "بەکارهاتوو", repair: "چاککردنەوە" },
};
const FONT = '"KufamLatin", "KufamArabic", "KufamArabicExt", sans-serif';

// ───────────────────────────── renderer, camera, light
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(2);
renderer.setSize(SIZE, SIZE);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const FOV = 18;
const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
camera.position.set(0, 0, 1 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
camera.lookAt(0, 0, 0);

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function baseScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#04050c");
  scene.environment = envMap;
  scene.environmentIntensity = 0.32;
  // the soft cool light on the backdrop behind the object
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(256, 230, 0, 256, 230, 300);
  grad.addColorStop(0, "rgba(30,36,70,0.32)");
  grad.addColorStop(0.55, "rgba(12,14,30,0.14)");
  grad.addColorStop(1, "rgba(4,5,12,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(5, 5), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
  glow.position.z = -1.6;
  scene.add(glow);

  const key = new THREE.DirectionalLight("#ffffff", 2.4);
  key.position.set(-2.5, 4, 5);
  scene.add(key);
  const fill = new THREE.DirectionalLight("#9fb4ff", 0.7);
  fill.position.set(3, -1, 4);
  scene.add(fill);
  const rimL = new THREE.PointLight("#7f9bff", 18, 8);
  rimL.position.set(-2.4, 0.6, -0.6);
  scene.add(rimL);
  const rimR = new THREE.PointLight("#7f9bff", 18, 8);
  rimR.position.set(2.4, 0.6, -0.6);
  scene.add(rimR);
  const top = new THREE.PointLight("#ffffff", 10, 8);
  top.position.set(0, 2.2, 1.2);
  scene.add(top);
  return scene;
}

// ───────────────────────────── materials
const M = {
  panel: () => new THREE.MeshPhysicalMaterial({ color: "#121318", roughness: 0.42, metalness: 0.1, clearcoat: 0.7, clearcoatRoughness: 0.3 }),
  gloss: () => new THREE.MeshPhysicalMaterial({ color: "#090a0e", roughness: 0.3, metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.28 }),
  matte: (color = "#16171c") => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 }),
  white: () => new THREE.MeshPhysicalMaterial({ color: "#eef0f4", roughness: 0.38, clearcoat: 0.4, clearcoatRoughness: 0.4 }),
  grey: () => new THREE.MeshPhysicalMaterial({ color: "#3a3d45", roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.5 }),
  rubber: () => new THREE.MeshStandardMaterial({ color: "#0b0c0f", roughness: 0.7 }),
  red: () => new THREE.MeshPhysicalMaterial({ color: "#d8141c", roughness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.35 }),
  steel: () => new THREE.MeshStandardMaterial({ color: "#c9ced6", roughness: 0.25, metalness: 1 }),
  gunmetal: () => new THREE.MeshStandardMaterial({ color: "#23252b", roughness: 0.45, metalness: 0.75 }),
  gold: () => new THREE.MeshStandardMaterial({ color: "#e2b453", roughness: 0.28, metalness: 1 }),
  glow: (color, k = 2.2) => new THREE.MeshStandardMaterial({ color: "#000000", emissive: color, emissiveIntensity: k, roughness: 0.4 }),
};

// ───────────────────────────── small builders
function rbox(w, h, d, r, mat) {
  return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 10, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001)), mat);
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
  return new THREE.Mesh(geo, mat);
}
/** A disc facing the camera (axis z). */
function disc(r, h, mat, seg = 64) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat);
  m.rotation.x = Math.PI / 2;
  return m;
}
function at(mesh, x, y, z = 0) {
  mesh.position.set(x, y, z);
  return mesh;
}
/** An arch in the xy plane (opening downward), from angle a0 to a1 (radians, 0 = +x). */
function arch(radius, tube, a0, a1, mat) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 24, 96, a1 - a0), mat);
  m.rotation.z = a0;
  return m;
}
/** An analog stick: well, stem and a concave-looking cap with a rim. */
function stick(scale = 1) {
  const g = new THREE.Group();
  g.add(at(disc(0.17, 0.03, M.gloss()), 0, 0, 0));
  g.add(at(disc(0.07, 0.1, M.rubber()), 0, 0, 0.05));
  g.add(at(disc(0.125, 0.035, M.rubber()), 0, 0, 0.11));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.016, 16, 48), M.matte("#1b1c21"));
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
  const maxW = W * (opts.fitW ?? 0.8);
  const maxH = H * (opts.fitH ?? 0.5);
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
  // a soft dark inlay under the letters, then the letters: reads as print in the surface, not a sticker
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
  const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.55, emissive: "#ffffff", emissiveMap: tex, emissiveIntensity: 0.55, depthWrite: false });
  return new THREE.Mesh(new THREE.PlaneGeometry(width, height), mat);
}

/** The dark panel across the middle with the name on its face. Returns the group. */
function titledPanel(text, lang, w, h, d, r, mat, labelOpts) {
  const g = new THREE.Group();
  g.add(slab(w, h, d, r, mat));
  g.add(at(labelPlane(text, lang, w, h, labelOpts), 0, 0, d / 2 + 0.004));
  return g;
}

// ───────────────────────────── the eight objects
const BUILD = {
  /** A gamepad: white grips and sticks at the sides, the touch panel carries the name. */
  controllers(scene, text, lang) {
    for (const s of [-1, 1]) {
      const shell = new THREE.Mesh(new THREE.SphereGeometry(0.5, 64, 48), M.white());
      shell.scale.set(0.95, 1.0, 0.42);
      scene.add(at(shell, s * 1.07, 0.02, -0.12));
      const horn = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.55, 16, 32), M.white());
      horn.rotation.z = s * 0.28;
      horn.scale.z = 0.7;
      scene.add(at(horn, s * 1.0, -0.55, -0.14));
      const st = stick(1.05);
      scene.add(at(st, s * 0.86, -0.3, 0.02));
    }
    // d-pad (left) and face buttons (right) on the shells
    for (const [dx, dy] of [[0, 0.07], [0, -0.07], [0.07, 0], [-0.07, 0]]) {
      scene.add(at(rbox(0.06, 0.06, 0.03, 0.012, M.gloss()), -0.97 + dx, 0.2 + dy, 0.09));
      scene.add(at(disc(0.03, 0.03, M.gloss()), 0.97 + dx, 0.2 + dy, 0.09));
    }
    // the light bar around the touch panel
    scene.add(at(slab(1.545, 0.605, 0.16, 0.21, M.glow("#1f55ff", 1.5)), 0, 0.06, -0.03));
    scene.add(at(titledPanel(text, lang, 1.5, 0.56, 0.2, 0.2, M.panel()), 0, 0.06, 0));
  },

  /** A home console lying flat: white shells and blue light strips at the ends, glossy black body. */
  devices(scene, text, lang) {
    for (const s of [-1, 1]) {
      const shell = rbox(0.62, 0.9, 0.6, 0.26, M.white());
      shell.rotation.z = s * -0.05;
      scene.add(at(shell, s * 1.1, 0, -0.1));
      scene.add(at(rbox(0.035, 0.56, 0.3, 0.015, M.glow("#1f6bff", 1.8)), s * 0.815, 0, 0.03));
    }
    scene.add(at(slab(1.7, 0.78, 0.34, 0.3, M.matte("#1a1b21")), 0, 0, -0.1));
    scene.add(at(rbox(0.32, 0.018, 0.02, 0.008, M.matte("#2a2c33")), -0.5, 0.36, 0.08));
    scene.add(at(titledPanel(text, lang, 1.56, 0.64, 0.3, 0.26, M.gloss()), 0, 0, 0));
  },

  /** A game case: translucent blue shell, discs showing at both sides, the cover carries the name. */
  games(scene, text, lang) {
    const shell = new THREE.MeshPhysicalMaterial({ color: "#1d3fb8", roughness: 0.18, transparent: true, opacity: 0.55, clearcoat: 1 });
    scene.add(at(rbox(2.3, 0.86, 0.1, 0.03, shell), 0, 0, -0.1));
    for (const s of [-1, 1]) {
      const cc = document.createElement("canvas");
      cc.width = cc.height = 512;
      const cg = cc.getContext("2d");
      const conic = cg.createConicGradient(s * 0.6, 256, 256);
      const stops = ["#aeb4c2", "#e9ecf2", "#9fd0ff", "#c9a6ff", "#ffc9a8", "#e9ecf2", "#8f95a3", "#dfe3ea", "#a8ffd8", "#9fd0ff", "#e9ecf2", "#aeb4c2"];
      stops.forEach((color, i) => conic.addColorStop(i / (stops.length - 1), color));
      cg.fillStyle = conic;
      cg.fillRect(0, 0, 512, 512);
      const sheen = new THREE.CanvasTexture(cc);
      sheen.colorSpace = THREE.SRGBColorSpace;
      const face = new THREE.MeshStandardMaterial({ map: sheen, roughness: 0.3, metalness: 0.85 });
      const d = at(disc(0.4, 0.012, [M.steel(), face, M.steel()], 96), s * 0.88, 0, -0.02);
      scene.add(d);
      scene.add(at(disc(0.13, 0.014, M.steel()), s * 0.88, 0, -0.016));
      scene.add(at(disc(0.045, 0.02, M.gloss()), s * 0.88, 0, -0.012));
    }
    scene.add(at(titledPanel(text, lang, 1.24, 0.78, 0.08, 0.025, M.matte("#191a1f"), { fitW: 0.72, fitH: 0.42 }), 0, 0, 0.04));
    // the cover's spine edge
    scene.add(at(rbox(0.012, 0.74, 0.085, 0.004, M.matte("#2b2d34")), -0.58, 0, 0.045));
  },

  /** A headset: the red padded band arches over, ear cups at the sides, the name on the band's panel. */
  headsets(scene, text, lang) {
    const outer = arch(0.99, 0.075, 0.1, Math.PI - 0.1, M.gunmetal());
    outer.scale.y = 0.62;
    scene.add(at(outer, 0, -0.06, -0.05));
    const pad = arch(0.9, 0.11, 0.26, Math.PI - 0.26, M.red());
    pad.scale.y = 0.6;
    scene.add(at(pad, 0, -0.06, -0.02));
    for (const s of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.26, 64), M.gunmetal());
      cup.rotation.z = Math.PI / 2;
      scene.add(at(cup, s * 1.08, -0.08, -0.05));
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.355, 0.355, 0.04, 64), M.rubber());
      ring.rotation.z = Math.PI / 2;
      scene.add(at(ring, s * 0.96, -0.08, -0.05));
    }
    scene.add(at(titledPanel(text, lang, 1.72, 0.56, 0.24, 0.2, M.panel()), 0, -0.08, 0.05));
  },

  /** A carrying case: red trim and handle, a cable wrapped across the front, the name on the lid. */
  accessories(scene, text, lang) {
    scene.add(at(slab(1.86, 0.92, 0.3, 0.3, M.red()), 0, -0.02, -0.08));
    const handle = arch(0.36, 0.05, 0.15, Math.PI - 0.15, M.rubber());
    handle.scale.y = 0.75;
    scene.add(at(handle, 0, 0.42, -0.08));
    const grip = arch(0.36, 0.068, 0.75, Math.PI - 0.75, M.red());
    grip.scale.y = 0.75;
    scene.add(at(grip, 0, 0.42, -0.08));
    // fabric lid
    const fabric = M.matte("#17181d");
    const n = document.createElement("canvas");
    n.width = n.height = 256;
    const ng = n.getContext("2d");
    for (let i = 0; i < 256; i += 2) for (let j = 0; j < 256; j += 2) {
      const v = 110 + Math.floor(Math.random() * 60);
      ng.fillStyle = `rgb(${v},${v},${v})`;
      ng.fillRect(i, j, 2, 2);
    }
    const bump = new THREE.CanvasTexture(n);
    bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
    bump.repeat.set(10, 5);
    fabric.bumpMap = bump;
    fabric.bumpScale = 0.6;
    scene.add(at(titledPanel(text, lang, 1.78, 0.84, 0.32, 0.27, fabric, { fitW: 0.78, fitH: 0.3 }), 0, -0.02, 0));
    // the cable across the lower front, its strap and its plug
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-1.2, -0.3, 0.19), new THREE.Vector3(-0.5, -0.33, 0.2), new THREE.Vector3(0.1, -0.31, 0.2), new THREE.Vector3(0.52, -0.3, 0.2)]);
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 64, 0.022, 16), M.rubber()));
    const curve2 = new THREE.CatmullRomCurve3([new THREE.Vector3(-1.2, -0.36, 0.19), new THREE.Vector3(-0.4, -0.385, 0.2), new THREE.Vector3(0.4, -0.37, 0.2), new THREE.Vector3(1.2, -0.38, 0.19)]);
    scene.add(new THREE.Mesh(new THREE.TubeGeometry(curve2, 64, 0.022, 16), M.rubber()));
    scene.add(at(rbox(0.13, 0.15, 0.06, 0.02, M.red()), -0.05, -0.34, 0.2));
    scene.add(at(rbox(0.14, 0.06, 0.05, 0.02, M.rubber()), 0.58, -0.3, 0.2));
    scene.add(at(rbox(0.09, 0.04, 0.03, 0.012, M.steel()), 0.69, -0.3, 0.2));
  },

  /** Gift cards: a fan of cards with lit edges and gold chips behind, the front card carries the name. */
  topup(scene, text, lang) {
    for (const [s, color] of [[-1, "#2f8bff"], [1, "#ffb43a"]]) {
      const back = new THREE.Group();
      back.add(slab(1.52, 0.94, 0.03, 0.09, M.glow(color, 2.0), 0.01));
      back.add(at(slab(1.47, 0.89, 0.034, 0.075, M.matte("#20222c"), 0.01), 0, 0, 0.002));
      back.add(at(rbox(0.19, 0.15, 0.012, 0.03, M.gold()), s * 0.24, 0.0, 0.024));
      for (const dy of [-0.035, 0, 0.035]) back.add(at(rbox(0.19, 0.004, 0.014, 0.001, M.matte("#8a6a26")), s * 0.24, dy, 0.025));
      back.rotation.z = s * -0.09;
      scene.add(at(back, s * 0.62, s * 0.03, -0.14));
    }
    scene.add(at(titledPanel(text, lang, 1.3, 0.82, 0.05, 0.085, M.panel(), { fitW: 0.86, fitH: 0.4 }), 0, 0, 0));
  },

  /** A handheld console: grips with sticks and buttons, an inspection tick on the screen that carries the name. */
  used(scene, text, lang) {
    scene.add(at(slab(1.5, 0.86, 0.12, 0.07, M.matte("#1d1e24")), 0, 0, -0.03));
    for (const s of [-1, 1]) {
      scene.add(at(slab(0.46, 0.86, 0.14, 0.17, M.grey()), s * 0.97, 0, -0.03));
      scene.add(at(stick(0.72), s * 0.93, s === -1 ? 0.2 : -0.12, 0.05));
      const cy = s === -1 ? -0.14 : 0.2;
      for (const [dx, dy] of [[0, 0.065], [0, -0.065], [0.065, 0], [-0.065, 0]]) scene.add(at(disc(0.028, 0.03, M.gloss()), s * 0.93 + dx, cy + dy, 0.05));
    }
    scene.add(at(titledPanel(text, lang, 1.36, 0.74, 0.1, 0.035, M.gloss(), { fitW: 0.74, fitH: 0.36 }), 0, 0, 0.01));
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
    const seal = disc(0.085, 0.012, [M.matte("#0e7a36"), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.35 }), M.matte("#0e7a36")]);
    seal.rotation.y = Math.PI / 2; // turn the cap's texture upright
    scene.add(at(seal, -0.56, 0.26, 0.07));
  },

  /** A toolbox: gunmetal body, red latches and handle, a wrench and a screwdriver behind it; the name on its plate. */
  repair(scene, text, lang) {
    scene.add(at(rbox(2.6, 0.84, 0.5, 0.05, M.gunmetal()), 0, -0.02, -0.2));
    scene.add(at(rbox(2.6, 0.02, 0.51, 0.005, M.matte("#0b0c0f")), 0, 0.3, -0.2));
    const handle = arch(0.36, 0.05, 0.1, Math.PI - 0.1, M.red());
    handle.scale.y = 0.62;
    scene.add(at(handle, 0, 0.4, -0.2));
    for (const s of [-1, 1]) {
      scene.add(at(rbox(0.14, 0.32, 0.07, 0.03, M.red()), s * 0.92, 0.05, 0.07));
      scene.add(at(rbox(0.16, 0.05, 0.08, 0.02, M.steel()), s * 0.92, 0.22, 0.07));
      scene.add(at(disc(0.022, 0.09, M.steel()), s * 0.92, -0.04, 0.08));
    }
    // a screwdriver (left) and a wrench (right) standing behind the box
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.5, 24), M.steel());
    shaft.rotation.z = 0.25;
    scene.add(at(shaft, -0.78, 0.62, -0.3));
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.22, 12, 24), M.red());
    grip.rotation.z = 0.25;
    scene.add(at(grip, -0.7, 0.36, -0.3));
    const jaw = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.035, 16, 48, Math.PI * 1.45), M.steel());
    jaw.rotation.z = Math.PI * 0.55;
    scene.add(at(jaw, 0.82, 0.78, -0.3));
    const bar = rbox(0.07, 0.5, 0.03, 0.012, M.steel());
    bar.rotation.z = -0.2;
    scene.add(at(bar, 0.76, 0.48, -0.3));
    scene.add(at(titledPanel(text, lang, 1.5, 0.56, 0.12, 0.2, M.panel()), 0, -0.04, 0.02));
  },
};

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
  BUILD[key](scene, LABELS[lang][key], lang);
  renderer.render(scene, camera);
  return renderer.domElement.toDataURL("image/png");
};
window.DOORS = Object.keys(BUILD);
window.studioReady = ready.then(() => true);
