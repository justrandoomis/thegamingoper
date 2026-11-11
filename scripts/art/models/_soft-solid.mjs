/**
 * Soft solids — organic shells the kit's slab / lathe helpers cannot make: gamepad bodies with
 * grips, a headband, anything that has to flow from one form into another.
 *
 * A shape is a signed distance function f(x, y, z) in millimetres, negative inside. Shapes are
 * combined with `union` / `intersect` / `subtract` (each with an optional blend radius, which is
 * what makes a grip grow out of a body instead of sticking to it), and `solid()` turns the result
 * into a closed, smooth-shaded mesh geometry for `kit.mesh()`: naive surface nets on a regular
 * grid, every vertex then pulled onto the true surface, normals taken from the field.
 *
 * Helper file (the "_" prefix keeps it from matching a catalogue key). It adds geometry only:
 * models still use kit materials, kit.mesh() and the kit's small-part helpers on top.
 *
 *   import * as soft from './_soft-solid.mjs';
 *   const outline = soft.region(kit.polygon(points, radii));          // 2D, tabulated
 *   const body = (x, y, z) => soft.roundEdge(outline(x, y), Math.abs(z + 14) - 14, 9);
 *   parts.push(kit.mesh(soft.solid(kit, body, { min: [-90, -70, -40], max: [90, 50, 10] }), kit.clay()));
 */

const DEG = Math.PI / 180;

/* ── small maths ──────────────────────────────────────────────────────────── */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
/** 0 below `a`, 1 above `b`, an S-curve between (a > b runs the other way). */
export const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ── combining distances ──────────────────────────────────────────────────── */

/** Both shapes. `k` > 0 melts them together over about k mm (a fillet where they meet). */
export function union(a, b, k = 0) {
  if (k <= 0) return a < b ? a : b;
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
/** Only where both shapes are. `k` > 0 rounds the edge where their surfaces cross. */
export const intersect = (a, b, k = 0) => -union(-a, -b, k);
/** The first shape with the second cut away. `k` > 0 rounds the cut edge. */
export const subtract = (a, b, k = 0) => -union(-a, b, k);

/**
 * A 2D distance (to an outline) and a distance along the third axis (to a pair of faces), joined
 * with an edge of radius `r`: the soft-solid version of kit.slab().
 */
export function roundEdge(d2, dz, r) {
  const a = d2 + r, b = dz + r;
  return Math.min(Math.max(a, b), 0) + Math.hypot(Math.max(a, 0), Math.max(b, 0)) - r;
}

/* ── primitives: each returns f(x, y, z) ──────────────────────────────────── */

export function sphere(c, r) {
  return (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;
}

/** Box of half-size `half` (measured to the outside) with every edge rounded by `r`. */
export function roundBox(c, half, r = 0) {
  const hx = half[0] - r, hy = half[1] - r, hz = half[2] - r;
  return (x, y, z) => {
    const qx = Math.abs(x - c[0]) - hx, qy = Math.abs(y - c[1]) - hy, qz = Math.abs(z - c[2]) - hz;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}

/** A rod from `a` to `b` with round ends. */
export function capsule(a, b, r) {
  const bx = b[0] - a[0], by = b[1] - a[1], bz = b[2] - a[2], l2 = bx * bx + by * by + bz * bz || 1;
  return (x, y, z) => {
    const px = x - a[0], py = y - a[1], pz = z - a[2];
    const t = clamp((px * bx + py * by + pz * bz) / l2, 0, 1);
    return Math.hypot(px - bx * t, py - by * t, pz - bz * t) - r;
  };
}

/**
 * The same shape somewhere else: turned by `rot` (degrees, the kit's order: X, then Y, then Z
 * axes of the turned shape, as in kit.mesh) and moved to `at`.
 */
export function place(shape, { at = [0, 0, 0], rot = [0, 0, 0] } = {}) {
  const [a, b, c] = rot.map((d) => d * DEG);
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  // rows of R = Rx · Ry · Rz (three.js Euler 'XYZ'); the query point is taken back with Rᵀ
  const m = [
    cb * cc, -cb * sc, sb,
    ca * sc + sa * sb * cc, ca * cc - sa * sb * sc, -sa * cb,
    sa * sc - ca * sb * cc, sa * cc + ca * sb * sc, ca * cb,
  ];
  return (x, y, z) => {
    const px = x - at[0], py = y - at[1], pz = z - at[2];
    return shape(m[0] * px + m[3] * py + m[6] * pz, m[1] * px + m[4] * py + m[7] * pz, m[2] * px + m[5] * py + m[8] * pz);
  };
}

/* ── 2D outlines ──────────────────────────────────────────────────────────── */

/**
 * Distance to a closed outline — a kit Outline (rect, polygon, pill, …) or a flat
 * [x0, y0, x1, y1, …] list — as a function d(x, y), negative inside. The exact distance is
 * tabulated once on a fine grid and read back with bilinear interpolation, so a body can use a
 * detailed silhouette at no cost per sample. `d.exact(x, y)` is the untabulated distance and
 * `d.bounds` the outline's box.
 */
export function region(outline, { cell = 0.25, pad = 18 } = {}) {
  const p = Array.isArray(outline) ? outline : outline.at(0);
  const n = p.length / 2;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, p[2 * i]); maxX = Math.max(maxX, p[2 * i]);
    minY = Math.min(minY, p[2 * i + 1]); maxY = Math.max(maxY, p[2 * i + 1]);
  }
  const exact = (x, y) => {
    let best = Infinity, inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = p[2 * i], ay = p[2 * i + 1], bx = p[2 * j], by = p[2 * j + 1];
      const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay;
      const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0, 1);
      const dx = wx - ex * t, dy = wy - ey * t, d = dx * dx + dy * dy;
      if (d < best) best = d;
      if ((ay > y) !== (by > y) && x < ax + ((y - ay) / (by - ay)) * ex) inside = !inside;
    }
    return inside ? -Math.sqrt(best) : Math.sqrt(best);
  };
  const x0 = minX - pad, y0 = minY - pad;
  const nx = Math.ceil((maxX - minX + 2 * pad) / cell) + 1, ny = Math.ceil((maxY - minY + 2 * pad) / cell) + 1;
  const table = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) table[i + j * nx] = exact(x0 + i * cell, y0 + j * cell);
  const d = (x, y) => {
    let u = (x - x0) / cell, v = (y - y0) / cell, over = 0;
    if (u < 0) { over += u * u; u = 0; } else if (u > nx - 1.001) { over += (u - nx + 1.001) ** 2; u = nx - 1.001; }
    if (v < 0) { over += v * v; v = 0; } else if (v > ny - 1.001) { over += (v - ny + 1.001) ** 2; v = ny - 1.001; }
    const i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j, o = i + j * nx;
    const value = (table[o] * (1 - fu) + table[o + 1] * fu) * (1 - fv) + (table[o + nx] * (1 - fu) + table[o + nx + 1] * fu) * fv;
    return over ? value + Math.sqrt(over) * cell : value;
  };
  d.exact = exact;
  d.bounds = { minX, minY, maxX, maxY };
  return d;
}

/* ── meshing ──────────────────────────────────────────────────────────────── */

/**
 * The surface f = 0 as a closed mesh geometry (indexed, with normals), ready for kit.mesh().
 *   min, max  box that holds the whole shape with at least two cells to spare, [x, y, z] in mm
 *   cell      grid step in mm: 1 suits a hand-sized shell, 0.5–0.7 a small part
 *   project   Newton steps that pull each vertex onto the true surface (0 leaves the raw net)
 * Edges sharper than a cell come out chamfered: blend cuts with a radius of about one cell
 * (`subtract(a, b, 1.2)`) and the mesh follows the round edge cleanly instead.
 */
export function solid(kit, f, { min, max, cell = 1, project = 2 } = {}) {
  const { THREE } = kit;
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1, ny = Math.ceil((max[1] - min[1]) / cell) + 1, nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const field = new Float32Array(nx * ny * nz);
  for (let k = 0, n = 0; k < nz; k++) {
    const z = min[2] + k * cell;
    for (let j = 0; j < ny; j++) {
      const y = min[1] + j * cell;
      for (let i = 0; i < nx; i++) field[n++] = f(min[0] + i * cell, y, z);
    }
  }

  // One vertex per cell the surface passes through: the mean of its crossings on the cell edges.
  const sy = nx, sz = nx * ny, cx = nx - 1, cy = ny - 1;
  const vertexOf = new Int32Array(cx * cy * (nz - 1)).fill(-1);
  const corner = [0, 1, sy, sy + 1, sz, sz + 1, sz + sy, sz + sy + 1]; // bit 0: +x · bit 1: +y · bit 2: +z
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const v = new Float64Array(8), pos = [];
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const o = i + j * sy + k * sz;
    let mask = 0;
    for (let c = 0; c < 8; c++) { v[c] = field[o + corner[c]]; if (v[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    if (i === 0 || j === 0 || k === 0 || i === nx - 2 || j === ny - 2 || k === nz - 2) {
      throw new Error(`soft.solid: the shape reaches the edge of its box near [${[min[0] + i * cell, min[1] + j * cell, min[2] + k * cell].map((n) => n.toFixed(0))}] — widen min / max`);
    }
    let px = 0, py = 0, pz = 0, count = 0;
    for (const [a, b] of edges) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      px += (a & 1) + ((b & 1) - (a & 1)) * t;
      py += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t;
      pz += (a >> 2) + ((b >> 2) - (a >> 2)) * t;
      count++;
    }
    vertexOf[i + j * cx + k * cx * cy] = pos.length / 3;
    pos.push(min[0] + (i + px / count) * cell, min[1] + (j + py / count) * cell, min[2] + (k + pz / count) * cell);
  }
  if (!pos.length) throw new Error('soft.solid: the shape is empty inside its box');

  // One quad per grid edge that crosses the surface, between the four cells around that edge.
  const index = [];
  const at = (i, j, k) => vertexOf[i + j * cx + k * cx * cy];
  const far2 = (a, b) => (pos[3 * a] - pos[3 * b]) ** 2 + (pos[3 * a + 1] - pos[3 * b + 1]) ** 2 + (pos[3 * a + 2] - pos[3 * b + 2]) ** 2;
  const quad = (a, b, c, d, flip) => {
    if (flip) { const t = b; b = d; d = t; }
    if (far2(a, c) <= far2(b, d)) index.push(a, b, c, a, c, d); else index.push(a, b, d, b, c, d);
  };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const o = i + j * sy + k * sz, inside = field[o] < 0;
    if (inside !== (field[o + 1] < 0)) quad(at(i, j - 1, k - 1), at(i, j, k - 1), at(i, j, k), at(i, j - 1, k), !inside);
    if (inside !== (field[o + sy] < 0)) quad(at(i, j, k), at(i, j, k - 1), at(i - 1, j, k - 1), at(i - 1, j, k), !inside);
    if (inside !== (field[o + sz] < 0)) quad(at(i, j, k), at(i - 1, j, k), at(i - 1, j - 1, k), at(i, j - 1, k), !inside);
  }

  // Pull the vertices onto the surface and read the normals off the field.
  const count = pos.length / 3, normal = new Float32Array(pos.length), h = cell * 0.4, reach = cell * 0.75;
  for (let n = 0; n < count; n++) {
    let x = pos[3 * n], y = pos[3 * n + 1], z = pos[3 * n + 2], gx = 0, gy = 0, gz = 1;
    for (let pass = 0; ; pass++) {
      gx = (f(x + h, y, z) - f(x - h, y, z)) / (2 * h);
      gy = (f(x, y + h, z) - f(x, y - h, z)) / (2 * h);
      gz = (f(x, y, z + h) - f(x, y, z - h)) / (2 * h);
      const g2 = gx * gx + gy * gy + gz * gz;
      if (pass >= project || g2 < 1e-9) break;
      let step = -f(x, y, z) / g2;
      const length = Math.abs(step) * Math.sqrt(g2);
      if (length > reach) step *= reach / length;
      x += gx * step; y += gy * step; z += gz * step;
    }
    const length = Math.hypot(gx, gy, gz) || 1;
    pos[3 * n] = x; pos[3 * n + 1] = y; pos[3 * n + 2] = z;
    normal[3 * n] = gx / length; normal[3 * n + 1] = gy / length; normal[3 * n + 2] = gz / length;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setIndex(index);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Where a ray along one axis first meets the surface: the coordinate on `axis` at which f turns
 * negative, walking from `from` towards `to` with the other two coordinates fixed. Use it to
 * stand a button on a curved face. Returns `to` when nothing is hit.
 *   hit(body, 'z', [x, y], 20, -20)     the height of the face under (x, y)
 */
export function hit(f, axis, [u, v], from, to, step = 0.5) {
  const at = axis === 'x' ? (t) => f(t, u, v) : axis === 'y' ? (t) => f(u, t, v) : (t) => f(u, v, t);
  const dir = Math.sign(to - from) || 1;
  let a = from;
  if (at(a) < 0) return from;
  for (let t = from + dir * step; dir * (to - t) >= 0; t += dir * step) {
    if (at(t) < 0) {
      let b = t;
      for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (at(m) < 0) b = m; else a = m; }
      return (a + b) / 2;
    }
    a = t;
  }
  return to;
}

/** Outward unit normal of the surface near a point, [x, y, z]. */
export function normalAt(f, x, y, z, h = 0.3) {
  const gx = f(x + h, y, z) - f(x - h, y, z), gy = f(x, y + h, z) - f(x, y - h, z), gz = f(x, y, z + h) - f(x, y, z - h);
  const length = Math.hypot(gx, gy, gz) || 1;
  return [gx / length, gy / length, gz / length];
}
