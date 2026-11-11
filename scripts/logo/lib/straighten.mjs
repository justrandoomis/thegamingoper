// Straight-sided lettering for scripts/logo/trace.mjs: turns a traced outline into the polygon of its fitted edges.

import { flatten } from "./paths.mjs";

export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Intersection of the line through a→b with the line through c→d, or null when they are (nearly) parallel. */
export function intersectLines(a, b, c, d) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const cross = rx * sy - ry * sx;
  if (Math.abs(cross) < 1e-6 * Math.hypot(rx, ry) * Math.hypot(sx, sy) + 1e-12) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / cross;
  return [a[0] + rx * t, a[1] + ry * t];
}

/** Points about `spacing` apart along a closed subpath (the start point is not repeated at the end). */
export function sampleOutline(sub, spacing) {
  const coarse = flatten(sub, 24);
  if (distance(coarse[0], coarse[coarse.length - 1]) > 1e-9) coarse.push(coarse[0]);
  const out = [];
  let carried = 0;
  for (let i = 0; i + 1 < coarse.length; i++) {
    const a = coarse[i];
    const b = coarse[i + 1];
    const length = distance(a, b);
    let at = carried;
    while (at < length) {
      const t = at / length;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      at += spacing;
    }
    carried = at - length;
  }
  return out;
}

export function distanceToChord(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return distance(p, a);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length;
}

/** Douglas–Peucker corner candidates of a closed outline: sorted indices into `points`. */
export function dominantPoints(points, tolerance) {
  const n = points.length;
  const at = (i) => points[((i % n) + n) % n];
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) {
    cx += x / n;
    cy += y / n;
  }
  let first = 0;
  for (let i = 1; i < n; i++) if (distance(points[i], [cx, cy]) > distance(points[first], [cx, cy])) first = i;
  let second = first;
  for (let i = 0; i < n; i++) if (distance(points[i], points[first]) > distance(points[second], points[first])) second = i;

  const keep = new Set([first, second]);
  const split = (from, to) => {
    // `from` and `to` are unwrapped indices with from < to
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = from + 1; i < to; i++) {
      const d = distanceToChord(at(i), at(from), at(to));
      if (d > worstDistance) {
        worstDistance = d;
        worst = i;
      }
    }
    if (worst < 0) return;
    keep.add(((worst % n) + n) % n);
    split(from, worst);
    split(worst, to);
  };
  const [lo, hi] = first < second ? [first, second] : [second, first];
  split(lo, hi);
  split(hi, lo + n);

  // The two seeds were forced; drop any vertex the outline does not actually need.
  let indices = [...keep].sort((a, b) => a - b);
  for (let changed = true; changed && indices.length > 3; ) {
    changed = false;
    for (let k = 0; k < indices.length; k++) {
      const previous = indices[(k - 1 + indices.length) % indices.length];
      const next = indices[(k + 1) % indices.length];
      const from = previous;
      const to = next > previous ? next : next + n;
      let needed = false;
      for (let i = from + 1; i < to; i++) {
        if (distanceToChord(at(i), at(from), at(to)) > tolerance) {
          needed = true;
          break;
        }
      }
      if (!needed) {
        indices = indices.filter((_, j) => j !== k);
        changed = true;
        break;
      }
    }
  }
  return indices;
}

/**
 * Straight-sided capitals (T, A, M): replaces a traced outline by the polygon of its straight
 * edges. Lengths are screenshot pixels.
 *
 * At this resolution every corner of the trace arrives rounded off (radius about one pixel), which
 * makes "TAM TAM" look like a rounded typeface, although the screenshot shows crisp corners. The
 * edges between the corners are well measured, so:
 *
 *   1. the outline is split at its corners (Douglas–Peucker, `edgeTolerance`)
 *   2. a line is fitted to the middle of every edge at least `minEdge` long — the rounded ends are
 *      left out of the fit — and edges that are almost horizontal or vertical are made exactly so
 *      (`snapLong` degrees for long edges, `snapShort` for short stroke ends)
 *   3. each corner is put where two consecutive fitted lines meet. Short bevels between them are
 *      dropped if that meeting point is within `maxReach` of the bevel; otherwise they are kept as
 *      real short edges.
 *
 * Edge positions always come from the trace; nothing is moved to a grid or to a guessed typeface.
 * Returns null when the result would stray from the traced outline (the caller keeps the curves).
 */
export function straightenOutline(sub, { edgeTolerance, minEdge, maxReach, snapLong, snapShort }) {
  const points = sampleOutline(sub, 0.08);
  const n = points.length;
  if (n < 24) return null;
  const corners = dominantPoints(points, edgeTolerance);
  const m = corners.length;
  if (m < 3) return null;

  const edges = corners.map((from, k) => {
    const to = corners[(k + 1) % m] > from ? corners[(k + 1) % m] : corners[(k + 1) % m] + n;
    const a = points[from];
    const b = points[to % n];
    const chord = distance(a, b);
    const edge = { a, b, chord, reliable: chord >= minEdge, point: a, direction: [(b[0] - a[0]) / (chord || 1), (b[1] - a[1]) / (chord || 1)] };
    if (!edge.reliable) return edge;
    // Fit the middle of the edge, leaving out its rounded ends.
    const count = to - from;
    const trim = Math.min(Math.round(0.9 / 0.08), Math.floor(count * 0.3));
    let sx = 0;
    let sy = 0;
    let used = 0;
    for (let i = from + trim; i <= to - trim; i++) {
      sx += points[i % n][0];
      sy += points[i % n][1];
      used++;
    }
    const cx = sx / used;
    const cy = sy / used;
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (let i = from + trim; i <= to - trim; i++) {
      const dx = points[i % n][0] - cx;
      const dy = points[i % n][1] - cy;
      xx += dx * dx;
      xy += dx * dy;
      yy += dy * dy;
    }
    const angle = 0.5 * Math.atan2(2 * xy, xx - yy); // principal axis
    let direction = [Math.cos(angle), Math.sin(angle)];
    if (direction[0] * edge.direction[0] + direction[1] * edge.direction[1] < 0) direction = [-direction[0], -direction[1]];
    const snap = Math.sin(((chord >= 6 ? snapLong : snapShort) * Math.PI) / 180);
    if (Math.abs(direction[1]) <= snap) direction = [Math.sign(direction[0]), 0];
    else if (Math.abs(direction[0]) <= snap) direction = [0, Math.sign(direction[1])];
    edge.point = [cx, cy];
    edge.direction = direction;
    return edge;
  });

  const reliable = edges.map((edge, k) => (edge.reliable ? k : -1)).filter((k) => k >= 0);
  if (reliable.length < 3) return null;
  const along = (edge) => [edge.point[0] + edge.direction[0], edge.point[1] + edge.direction[1]];
  const ontoLine = (p, edge) => {
    const t = (p[0] - edge.point[0]) * edge.direction[0] + (p[1] - edge.point[1]) * edge.direction[1];
    return [edge.point[0] + edge.direction[0] * t, edge.point[1] + edge.direction[1] * t];
  };
  const toOutline = (p) => {
    let nearest = Infinity;
    for (let i = 0; i < n; i += 2) nearest = Math.min(nearest, distance(p, points[i]));
    return nearest;
  };
  const axisSnap = (direction, degrees) => {
    const limit = Math.sin((degrees * Math.PI) / 180);
    if (Math.abs(direction[1]) <= limit) return [Math.sign(direction[0]) || 1, 0];
    if (Math.abs(direction[0]) <= limit) return [0, Math.sign(direction[1]) || 1];
    return direction;
  };

  let polygon = [];
  for (let r = 0; r < reliable.length; r++) {
    const i = reliable[r];
    const j = reliable[(r + 1) % reliable.length];
    const first = edges[i];
    const second = edges[j];
    // Traced corner points between the end of edge i and the start of edge j (one if they are adjacent).
    const between = [];
    for (let k = (i + 1) % m; ; k = (k + 1) % m) {
      between.push(points[corners[k]]);
      if (k === j) break;
    }
    const meet = intersectLines(first.point, along(first), second.point, along(second));
    const cross = Math.abs(first.direction[0] * second.direction[1] - first.direction[1] * second.direction[0]);
    if (!meet || cross < 0.2) {
      // Parallel neighbours (the two sides of a thin stroke end): keep the traced corners, on the fitted lines.
      between.forEach((p, index) => polygon.push(index === 0 ? ontoLine(p, first) : index === between.length - 1 ? ontoLine(p, second) : p));
      continue;
    }
    // A corner of interior angle θ rounded with radius ρ leaves its outline ρ·(1/sin(θ/2) − 1) short
    // of the true corner: sharp corners may be restored from further away than blunt ones.
    const cosTurn = Math.max(-1, Math.min(1, first.direction[0] * second.direction[0] + first.direction[1] * second.direction[1]));
    const interior = Math.PI - Math.acos(cosTurn);
    const allowed = maxReach * (1 / Math.sin(interior / 2) - 1) + 0.35;
    if (toOutline(meet) <= allowed) {
      polygon.push(meet);
      continue;
    }
    // The edges do not meet near the outline: the corner is really cut off (apex of an A, foot of the
    // V in an M). Cut it with one straight edge through its furthest traced point.
    const centre = between.reduce((sum, p) => [sum[0] + p[0] / between.length, sum[1] + p[1] / between.length], [0, 0]);
    const reachOut = distance(meet, centre);
    const toward = [(meet[0] - centre[0]) / reachOut, (meet[1] - centre[1]) / reachOut];
    const from = corners[(i + 1) % m];
    const to = corners[j] >= from ? corners[j] : corners[j] + n;
    let furthest = between[0];
    let furthestAlong = -Infinity;
    for (let k = from; k <= to; k++) {
      const p = points[k % n];
      const projection = p[0] * toward[0] + p[1] * toward[1];
      if (projection > furthestAlong) {
        furthestAlong = projection;
        furthest = p;
      }
    }
    let cut = [-toward[1], toward[0]];
    if (between.length === 2 && distance(between[0], between[1]) >= 1.2) {
      const length = distance(between[0], between[1]);
      cut = [(between[1][0] - between[0][0]) / length, (between[1][1] - between[0][1]) / length];
    }
    cut = axisSnap(cut, 15);
    const cutEnd = [furthest[0] + cut[0], furthest[1] + cut[1]];
    const p1 = intersectLines(first.point, along(first), furthest, cutEnd);
    const p2 = intersectLines(furthest, cutEnd, second.point, along(second));
    if (p1 && p2 && distance(p1, furthest) < 3 && distance(p2, furthest) < 3) polygon.push(p1, p2);
    else between.forEach((p, index) => polygon.push(index === 0 ? ontoLine(p, first) : index === between.length - 1 ? ontoLine(p, second) : p));
  }

  // Drop corners that are not corners: almost no turn, and the outline stays put without them.
  for (let changed = true; changed && polygon.length > 3; ) {
    changed = false;
    for (let k = 0; k < polygon.length; k++) {
      const a = polygon[(k - 1 + polygon.length) % polygon.length];
      const b = polygon[k];
      const c = polygon[(k + 1) % polygon.length];
      const ab = distance(a, b);
      const bc = distance(b, c);
      if (ab < 1e-6 || bc < 1e-6) {
        polygon = polygon.filter((_, index) => index !== k);
        changed = true;
        break;
      }
      const cosine = ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) / (ab * bc);
      if (cosine > Math.cos((10 * Math.PI) / 180) && distanceToChord(b, a, c) < 0.4) {
        polygon = polygon.filter((_, index) => index !== k);
        changed = true;
        break;
      }
    }
  }

  // Merging can leave an edge a fraction of a degree off square: square the edges once more and
  // take each corner from its two edges.
  const count = polygon.length;
  const lines = polygon.map((p, k) => {
    const q = polygon[(k + 1) % count];
    const length = distance(p, q);
    const direction = [(q[0] - p[0]) / length, (q[1] - p[1]) / length];
    const snapped = length >= 1.5 ? axisSnap(direction, length >= 6 ? snapLong : snapShort) : direction;
    const middle = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    return [middle, [middle[0] + snapped[0], middle[1] + snapped[1]]];
  });
  polygon = polygon.map((p, k) => {
    const before = lines[(k - 1 + count) % count];
    const after = lines[k];
    const corner = intersectLines(before[0], before[1], after[0], after[1]);
    return corner && distance(corner, p) < 1 ? corner : p;
  });

  // Safety: every corner must stay near the traced outline, and the area must be preserved.
  for (const p of polygon) if (toOutline(p) > 4.5) return null;
  const area = (list) => Math.abs(list.reduce((sum, p, i) => sum + p[0] * list[(i + 1) % list.length][1] - list[(i + 1) % list.length][0] * p[1], 0)) / 2;
  const before = area(points);
  if (Math.abs(area(polygon) - before) > Math.max(0.08 * before, 1.5)) return null;
  return polygon;
}
