/**
 * The next layer of signals, drawn in the same construction-site vocabulary as
 * `health.js`. Each prop maps to exactly one rule in the analyzer:
 *
 *   noEntrySignGeometry    a red no-entry disc on a post at the plot corner:
 *                          an import that breaks the layering
 *                          (analyzer/architecture.py). Metres, at the origin.
 *   trafficConeGeometry    three traffic cones at the kerb: a risky file (a
 *                          hotspot, oversized or downtown) with no linked test
 *                          (analyzer/testmap.py). Metres, at the origin.
 *   crossBracingGeometry   steel X-bracing up every face: one function with 15+
 *                          decision points. Scaled by the building's instance
 *                          matrix, so X/Z in [-0.5, 0.5], Y in [0, 1].
 *   surveyStakeGeometry    a survey stake with a flag, tinted per instance:
 *                          changed since the baseline (analyzer/history.py).
 *                          Uniform scale, y 0..1.
 *   ownerNoticeGeometry    a purple notice board on two posts: CODEOWNERS names
 *                          someone who does not write this file
 *                          (analyzer/owners.py). Metres, at the origin.
 *
 * The three kerb-side props are real-world sized and placed by the caller at a
 * plot corner, never stretched by the footprint: a road sign is the same size
 * beside a kiosk and a tower, and a stretched disc stops reading as a sign.
 *   notePinGeometry        a map pin: the viewer's own note on a building.
 *                          Uniform scale, y 0..1.
 *
 * The third layer (impact, defects, debt, codes):
 *
 *   smokePlumeGeometry     smoke rising from an ember on the roof: commits
 *                          keep saying they fix this file (analyzer/health.py,
 *                          bug-prone). Uniform scale, y 0..1, on the roof.
 *   potholeGeometry        broken asphalt with a hazard-yellow rim, in the
 *                          road at the plot corner: TODO / FIXME / HACK / XXX
 *                          in the file's comments. Metres, at the origin;
 *                          the caller scales it with the marker count.
 *   codeNoticeGeometry     an orange notice on one post: a limit declared
 *                          under "codes" in .zion/rules.json is broken
 *                          (analyzer/architecture.py). Metres, at the origin.
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

const RED = [0.86, 0.12, 0.12];
const WHITE = [0.96, 0.95, 0.92];
const POST = [0.42, 0.43, 0.46];
const ORANGE = [1.0, 0.42, 0.08];

/** A thin box between two points (same member `health.js` uses for shores). */
function strut(THREE, from, to, w) {
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

/** A disc facing +Z: a cylinder turned on its side. */
function disc(THREE, { radius, x, y, z, depth = 0.04 }) {
  const geometry = new THREE.CylinderGeometry(radius, radius, depth, 18);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(x, y, z);
  return tag(geometry, PART_FIXED, y - radius, y + radius);
}

/**
 * A no-entry sign at the front-left corner of the plot, ~3 m tall: red disc,
 * white bar, on a grey post. Two faces, so it reads from either side.
 */
export function noEntrySignGeometry(THREE) {
  return mergeColouredParts(THREE, [
    paint(THREE, cylinder(THREE, { rTop: 0.05, rBottom: 0.06, y0: 0, y1: 2.4, segments: 6, part: PART_FIXED }), POST),
    paint(THREE, disc(THREE, { radius: 0.62, x: 0, y: 2.75, z: 0 }), RED),
    paint(THREE, box(THREE, { w: 0.82, d: 0.07, y0: 2.64, y1: 2.86, part: PART_FIXED }), WHITE),
  ]);
}

/** One traffic cone: a striped orange cone on a square base. */
function cone(THREE, x, z) {
  const parts = [
    paint(THREE, box(THREE, { w: 0.5, d: 0.5, y0: 0, y1: 0.05, x, z, part: PART_FIXED }), [0.12, 0.12, 0.12]),
    paint(THREE, cylinder(THREE, { rTop: 0.03, rBottom: 0.19, y0: 0.05, y1: 0.8, x, z, segments: 10, part: PART_FIXED }), ORANGE),
    paint(THREE, cylinder(THREE, { rTop: 0.105, rBottom: 0.13, y0: 0.4, y1: 0.52, x, z, segments: 10, part: PART_FIXED }), WHITE),
  ];
  return parts;
}

/** Three cones in a row along X, 0.7 m apart. */
export function trafficConeGeometry(THREE) {
  return mergeColouredParts(THREE, [...cone(THREE, -0.7, 0), ...cone(THREE, 0, 0), ...cone(THREE, 0.7, 0)]);
}

/**
 * Cross-bracing: on every face, a stack of X panels from the ground to the
 * roofline, with a horizontal tie between panels -- the exoskeleton a
 * structure gets when its frame is carrying more than it was designed to.
 */
export function crossBracingGeometry(THREE) {
  const parts = [];
  const panels = 4;
  const off = 0.508;
  const w = 0.012;
  for (const side of [0, 1, 2, 3]) {
    const at = (t, y) => {
      switch (side) {
        case 0: return [t, y, off];
        case 1: return [t, y, -off];
        case 2: return [off, y, t];
        default: return [-off, y, t];
      }
    };
    for (let i = 0; i < panels; i++) {
      const y0 = i / panels;
      const y1 = (i + 1) / panels;
      parts.push(strut(THREE, at(-0.42, y0), at(0.42, y1), w));
      parts.push(strut(THREE, at(0.42, y0), at(-0.42, y1), w));
      parts.push(strut(THREE, at(-0.45, y1), at(0.45, y1), w * 0.8));
    }
    parts.push(strut(THREE, at(-0.45, 0.002), at(-0.45, 1), w));
    parts.push(strut(THREE, at(0.45, 0.002), at(0.45, 1), w));
  }
  return mergeParts(THREE, parts);
}

/** A timber survey stake with a small flag; the flag colour rides in instanceColor. */
export function surveyStakeGeometry(THREE) {
  return mergeParts(THREE, [
    cylinder(THREE, { rTop: 0.02, rBottom: 0.03, y0: 0, y1: 1, segments: 5, part: PART_FIXED }),
    pennant(THREE, { poleX: 0, y0: 0.7, y1: 0.98, length: 0.42, part: PART_FIXED }),
    box(THREE, { w: 0.1, d: 0.1, y0: 0, y1: 0.05, part: PART_FIXED }),
  ]);
}

/** A notice board on two posts. */
export function ownerNoticeGeometry(THREE) {
  const PURPLE = [0.55, 0.36, 0.9];
  return mergeColouredParts(THREE, [
    paint(THREE, cylinder(THREE, { rTop: 0.035, rBottom: 0.04, y0: 0, y1: 2.0, x: -0.45, segments: 5, part: PART_FIXED }), POST),
    paint(THREE, cylinder(THREE, { rTop: 0.035, rBottom: 0.04, y0: 0, y1: 2.0, x: 0.45, segments: 5, part: PART_FIXED }), POST),
    paint(THREE, box(THREE, { w: 1.1, d: 0.05, y0: 1.2, y1: 2.05, part: PART_FIXED }), PURPLE),
    paint(THREE, box(THREE, { w: 0.8, d: 0.06, y0: 1.72, y1: 1.84, part: PART_FIXED }), WHITE),
    paint(THREE, box(THREE, { w: 0.6, d: 0.06, y0: 1.46, y1: 1.56, part: PART_FIXED }), WHITE),
  ]);
}

/** A map pin: a sphere on a needle, ~1 unit tall. */
export function notePinGeometry(THREE) {
  return mergeParts(THREE, [
    cylinder(THREE, { rTop: 0.03, rBottom: 0.005, y0: 0, y1: 0.7, segments: 6, part: PART_FIXED }),
    tag(new THREE.SphereGeometry(0.18, 12, 8).translate(0, 0.82, 0), PART_FIXED, 0.64, 1.0),
  ]);
}

const EMBER = [1.0, 0.42, 0.08];

/**
 * A smoke plume: low-poly puffs rising and drifting from an ember glow, dark
 * at the source and paler as the smoke thins. Unit scale, y 0..1, seated on
 * the roof by the caller -- it reads from any distance, where soot on a wall
 * would sit inside one form's setback and float off another's.
 */
export function smokePlumeGeometry(THREE) {
  const puffs = [
    // [x, y, z, radius, grey]
    [0, 0.12, 0, 0.14, 0.06],
    [0.05, 0.3, 0.02, 0.17, 0.1],
    [0.13, 0.5, -0.02, 0.2, 0.16],
    [0.24, 0.7, 0.03, 0.22, 0.24],
    [0.37, 0.88, 0, 0.2, 0.33],
  ];
  const parts = [paint(THREE, tag(new THREE.OctahedronGeometry(0.11, 0).translate(0, 0.06, 0), PART_FIXED, 0, 0.17), EMBER)];
  for (const [x, y, z, r, g] of puffs) {
    const puff = new THREE.IcosahedronGeometry(r, 1);
    puff.translate(x, y, z);
    parts.push(paint(THREE, tag(puff, PART_FIXED, y - r, y + r), [g, g * 0.96, g * 0.92]));
  }
  return mergeColouredParts(THREE, parts);
}

/** A flat disc standing `y0..y1` above the road. */
function patch(THREE, { radius, y0 = 0, y1, x, z, segments = 16 }) {
  return cylinder(THREE, { rTop: radius, rBottom: radius, y0, y1, x, z, segments, part: PART_FIXED });
}

/**
 * Two potholes and a crack, ringed in hazard yellow so they read from the air.
 * Raised a hand's width off the road: the district plate lies 3 cm above the
 * plinth, and anything flush with it disappears into it at range.
 */
export function potholeGeometry(THREE) {
  const RIM = [0.95, 0.8, 0.2];
  const HOLE = [0.03, 0.03, 0.035];
  return mergeColouredParts(THREE, [
    paint(THREE, patch(THREE, { radius: 0.7, y1: 0.12, x: 0, z: 0 }), RIM),
    paint(THREE, patch(THREE, { radius: 0.52, y1: 0.14, x: 0, z: 0 }), HOLE),
    paint(THREE, patch(THREE, { radius: 0.44, y1: 0.12, x: 1.05, z: 0.4, segments: 12 }), RIM),
    paint(THREE, patch(THREE, { radius: 0.3, y1: 0.14, x: 1.05, z: 0.4, segments: 12 }), HOLE),
    paint(THREE, box(THREE, { w: 1.0, d: 0.1, y0: 0, y1: 0.13, x: 0.5, z: -0.45, part: PART_FIXED }), HOLE),
  ]);
}

/** An orange code-violation notice on a single post, a white rule across it. */
export function codeNoticeGeometry(THREE) {
  const NOTICE = [1.0, 0.56, 0.1];
  return mergeColouredParts(THREE, [
    paint(THREE, cylinder(THREE, { rTop: 0.04, rBottom: 0.05, y0: 0, y1: 2.2, segments: 5, part: PART_FIXED }), POST),
    paint(THREE, box(THREE, { w: 0.9, d: 0.05, y0: 1.45, y1: 2.35, part: PART_FIXED }), NOTICE),
    paint(THREE, box(THREE, { w: 0.62, d: 0.06, y0: 1.95, y1: 2.05, part: PART_FIXED }), WHITE),
    paint(THREE, box(THREE, { w: 0.62, d: 0.06, y0: 1.7, y1: 1.78, part: PART_FIXED }), WHITE),
    paint(THREE, box(THREE, { w: 0.14, d: 0.06, y0: 1.53, y1: 1.63, part: PART_FIXED }), [0.1, 0.1, 0.1]),
  ]);
}
