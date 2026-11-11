/**
 * What the gamepad models share: the recipe for a pad-shaped shell, the step that lays a finished
 * pad down the way a real one rests, and the camera for a pad lying on the table.
 * Helper file ("_" prefix): used by _dualsense.mjs and _xbox-pad.mjs (both lie flat, as their
 * catalogue heights of 66 / 61 mm say) and by switch-pro-controller-2.mjs (shell recipe only: the
 * catalogue gives it 105 mm high, so it stands on its grips).
 *
 * A pad is modelled in its own frame — X to its right, Y towards the triggers, Z out of the face,
 * so the face is the XY plane like every other kit part — and `layFlat()` turns it onto its back.
 */
import * as soft from './_soft-solid.mjs';

/**
 * Pads lie flat, so the camera stands higher than for a console: the hero looks down at 40°,
 * and "front" is the face seen from (almost) straight above.
 */
export const VIEWS = Object.freeze({
  hero: Object.freeze({ azimuth: 30, elevation: 40 }),
  front: Object.freeze({ azimuth: 0, elevation: 76, lens: 12 }),
});

/**
 * A right-hand half outline [[x, y, radius], …] (counter-clockwise, bottom to top) → both halves,
 * as the two arguments of kit.polygon(). A point on the centre line (x = 0) is used once.
 */
export function mirrored(half) {
  const left = half.filter(([x]) => x !== 0).reverse();
  return [
    half.map(([x, y]) => [x, y]).concat(left.map(([x, y]) => [-x, y])),
    half.map(([, , r]) => r).concat(left.map(([, , r]) => r)),
  ];
}

/**
 * The shell of a pad as a soft solid: a face-on silhouette given thickness.
 *   outline   soft.region() of the silhouette
 *   faceEdge  radius where the face rolls into the flanks; backEdge the same at the back
 *             (faceEdge + backEdge must not exceed the thinnest place)
 *   bend      y → mm the shell is pushed back there: how the grips sweep away from the face
 *   crown     (x, y) → mm the face has dropped there: 0 on the crest
 *   thick     (x, y) → mm from face to back
 * Returns
 *   body(x, y, z)                 the shell
 *   above(x, y, z, depth)         negative from the face down to `depth` mm inside
 *   patch(zone, lift, depth, k)   a panel that follows the shell: the shell grown by `lift` mm
 *                                 (negative sinks it), kept where zone(x, y) < 0, `depth` mm deep
 *   faceZ(x, y)                   height of the face
 *   onFace(kit, x, y, parts, sink) a kit group standing square on the face (its +Z is the normal)
 */
export function padShell({ outline, faceEdge, backEdge, bend, crown, thick }) {
  const body = (x, y, z) => {
    const zw = z + bend(y), top = -crown(x, y);
    const d2 = outline(x, y);
    return zw > top - faceEdge ? soft.roundEdge(d2, zw - top, faceEdge) : soft.roundEdge(d2, top - thick(x, y) - zw, backEdge);
  };
  const above = (x, y, z, depth) => -crown(x, y) - depth - (z + bend(y));
  const patch = (zone, lift, depth, k = 1) => (x, y, z) => soft.intersect(soft.intersect(body(x, y, z) - lift, zone(x, y), k), above(x, y, z, depth), k);
  const faceZ = (x, y) => soft.hit(body, 'z', [x, y], 16, -45);
  const onFace = (kit, x, y, children, sink = 0) => {
    const z = faceZ(x, y);
    const group = kit.group(children, { at: [x, y, z - sink] });
    group.quaternion.setFromUnitVectors(new kit.THREE.Vector3(0, 0, 1), new kit.THREE.Vector3(...soft.normalAt(body, x, y, z)));
    return group;
  };
  return { body, above, patch, faceZ, onFace };
}

/**
 * Lay the pad on the table: turn it onto its back and lean it until both the grips (y < split)
 * and the trigger end (y > split) touch — the way the real thing comes to rest. `resting` are
 * the geometries (in the pad's frame) that can touch the table. Returns the finished group.
 */
export function layFlat(kit, parts, resting, { split = 0 } = {}) {
  const lowest = (lean, front) => {
    const s = Math.sin(lean), c = Math.cos(lean);
    let low = Infinity;
    for (const geometry of resting) {
      const p = geometry.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) if ((p[i + 1] < split) === front) low = Math.min(low, p[i + 1] * s + p[i + 2] * c);
    }
    return low;
  };
  let lo = -0.6, hi = 0.6; // radians the face leans towards the viewer; leaning further lowers the grips
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (lowest(mid, true) > lowest(mid, false)) lo = mid; else hi = mid; }
  const lean = ((lo + hi) / 2) * (180 / Math.PI);
  return kit.group(parts, { rot: [lean - 90, 0, 0] });
}
