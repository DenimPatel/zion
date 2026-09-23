/**
 * The architect's signals, drawn as things a building site actually has.
 *
 * Each prop answers "what is wrong with this building?" in the vocabulary of
 * construction rather than of a dashboard, and each maps to exactly one rule in
 * `analyzer/health.py` -- nothing here is decoration:
 *
 *   hazardBarrierGeometry  striped jersey barriers ringing the plot: a hotspot,
 *                          large and constantly being dug up. Unit X/Z is the
 *                          building's footprint (scaled per instance), Y is in
 *                          metres, so a barrier is waist-high on any building.
 *   rakingShoreGeometry    raking shores -- the timber/steel braces propped
 *                          against a wall that can no longer carry itself: an
 *                          oversized file. Scaled by the building's own
 *                          instance matrix, so X/Z in [-0.5, 0.5], Y in [0, 1].
 *   vacantBoardGeometry    a boarded-up entrance and a vacancy sign on a post:
 *                          an orphan candidate nobody imports. Unit X/Z is the
 *                          footprint, Y in metres.
 *   cyclePennantGeometry   a rooftop mast and a long pennant; every member of
 *                          one import cycle flies the same colour. Uniform
 *                          scale, y 0..~1.
 */

import {
  PART_FIXED,
  box,
  cylinder,
  mergeColouredParts,
  mergeParts,
  paint,
  pennant,
  tag,
} from '../primitives.js';

const ORANGE = [1.0, 0.45, 0.12];
const WHITE = [0.96, 0.95, 0.9];
const CONCRETE = [0.72, 0.72, 0.7];

/** A thin box between two points: the one diagonal member the kit lacks. */
function brace(THREE, from, to, w) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const span = b.clone().sub(a);
  const geometry = new THREE.BoxGeometry(span.length() || 1e-4, w, w);
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), span.normalize())
  );
  geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return tag(geometry, PART_FIXED, Math.min(a.y, b.y), Math.max(a.y, b.y));
}

/**
 * A ring of striped barriers just outside the footprint, with a gap on each
 * side the way a real cordon leaves a gate. Alternating orange and white
 * segments on a concrete foot; ~0.9 m tall.
 */
export function hazardBarrierGeometry(THREE) {
  const parts = [];
  const edge = 0.6; // outside the plot's own half-width of 0.5
  const segments = 5;
  const thick = 0.035;
  for (const side of [0, 1, 2, 3]) {
    for (let i = 0; i < segments; i++) {
      if (i === 2) continue; // the gate
      const t0 = -edge + (2 * edge * i) / segments;
      const t1 = t0 + (2 * edge) / segments - 0.02;
      const mid = (t0 + t1) / 2;
      const len = t1 - t0;
      const along = side % 2 === 0;
      const offset = side < 2 ? edge : -edge;
      const place = (g) => {
        if (along) g.translate(mid, 0, offset);
        else g.translate(offset, 0, mid);
        return g;
      };
      const w = along ? len : thick;
      const d = along ? thick : len;
      parts.push(paint(THREE, place(box(THREE, { w: along ? w : w * 1.6, d: along ? d * 1.6 : d, y0: 0, y1: 0.18, part: PART_FIXED })), CONCRETE));
      parts.push(paint(THREE, place(box(THREE, { w, d, y0: 0.18, y1: 0.9, part: PART_FIXED })), (i + side) % 2 ? WHITE : ORANGE));
    }
  }
  // A warning lamp on each corner post.
  for (const [x, z] of [[edge, edge], [-edge, edge], [edge, -edge], [-edge, -edge]]) {
    parts.push(paint(THREE, cylinder(THREE, { rTop: 0.02, rBottom: 0.025, y0: 0, y1: 1.3, x, z, segments: 6, part: PART_FIXED }), WHITE));
    parts.push(paint(THREE, tag(new THREE.SphereGeometry(0.05, 8, 4).translate(x, 1.35, z), PART_FIXED, 1.3, 1.4), ORANGE));
  }
  return mergeColouredParts(THREE, parts);
}

/**
 * Two raking shores on every face: a heavy diagonal raker from a sole plate
 * on the ground up to a wall plate at ~40% height, with a needle strut and a
 * wall plate so it reads as bracing rather than as a stray line.
 */
export function rakingShoreGeometry(THREE) {
  const parts = [];
  const reach = 0.22;
  for (const side of [0, 1, 2, 3]) {
    for (const t of [-0.26, 0.26]) {
      const rot = (p) => {
        const [x, y, z] = p;
        switch (side) {
          case 0: return [t + x, y, 0.5 + z];
          case 1: return [t + x, y, -0.5 - z];
          case 2: return [0.5 + z, y, t + x];
          default: return [-0.5 - z, y, t + x];
        }
      };
      parts.push(brace(THREE, rot([0, 0, reach]), rot([0, 0.42, 0.005]), 0.035));
      parts.push(brace(THREE, rot([0, 0, reach * 0.55]), rot([0, 0.22, 0.005]), 0.025));
      // Wall plate and sole plate.
      parts.push(brace(THREE, rot([0, 0.1, 0.004]), rot([0, 0.46, 0.004]), 0.03));
      parts.push(brace(THREE, rot([0, 0.005, 0.0]), rot([0, 0.005, reach + 0.03]), 0.04));
    }
  }
  return mergeParts(THREE, parts);
}

/**
 * A boarded-up entrance on the front face (two crossed planks over a
 * plywood panel) and a vacancy board on a post by the kerb.
 */
export function vacantBoardGeometry(THREE) {
  const PLY = [0.78, 0.63, 0.42];
  const PLANK = [0.55, 0.4, 0.25];
  const SIGN = [0.92, 0.9, 0.82];
  const POST = [0.35, 0.35, 0.38];
  const front = 0.5 + 0.012;
  return mergeColouredParts(THREE, [
    paint(THREE, box(THREE, { w: 0.32, d: 0.02, y0: 0, y1: 2.6, z: front, part: PART_FIXED }), PLY),
    paint(THREE, brace(THREE, [-0.15, 0.2, front + 0.015], [0.15, 2.4, front + 0.015], 0.05), PLANK),
    paint(THREE, brace(THREE, [0.15, 0.2, front + 0.02], [-0.15, 2.4, front + 0.02], 0.05), PLANK),
    paint(THREE, cylinder(THREE, { rTop: 0.02, rBottom: 0.02, y0: 0, y1: 2.4, x: 0.4, z: 0.66, segments: 6, part: PART_FIXED }), POST),
    paint(THREE, box(THREE, { w: 0.34, d: 0.02, y0: 1.5, y1: 2.3, x: 0.4, z: 0.68, part: PART_FIXED }), SIGN),
    // A red band across the sign, which is all a sign needs to say "vacant".
    paint(THREE, box(THREE, { w: 0.35, d: 0.025, y0: 1.8, y1: 1.98, x: 0.4, z: 0.68, part: PART_FIXED }), [0.85, 0.2, 0.18]),
  ]);
}

/** A rooftop mast with a long swallow-tail pennant, ~1 unit tall. */
export function cyclePennantGeometry(THREE) {
  return mergeParts(THREE, [
    box(THREE, { w: 0.12, d: 0.12, y0: 0, y1: 0.03, part: PART_FIXED }),
    cylinder(THREE, { rTop: 0.012, rBottom: 0.02, y0: 0.02, y1: 1.0, segments: 6, part: PART_FIXED }),
    tag(new THREE.SphereGeometry(0.03, 6, 4).translate(0, 1.01, 0), PART_FIXED, 0.98, 1.04),
    pennant(THREE, { poleX: 0, y0: 0.7, y1: 0.97, length: 0.55, part: PART_FIXED }),
    pennant(THREE, { poleX: 0, y0: 0.56, y1: 0.7, length: 0.3, part: PART_FIXED }),
  ]);
}
