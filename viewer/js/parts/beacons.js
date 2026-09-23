/**
 * A realistic rooftop obstruction beacon: the red/amber aviation warning light
 * a tall building carries at a roof corner so aircraft can see the skyline at
 * night.
 *
 * `shapes.js` had a beacon that was a bare mast with a glowing ball, which read
 * as a lamp but not as a fixture -- nothing about it said the thing was bolted
 * to a roof, guyed against wind, or serviced by anyone. This build follows the
 * bar `createCityHall` sets for the landmark: a flanged, bolted base; a tapered,
 * guyed mast; a control box with conduit; a cross-arm carrying a secondary lamp;
 * and a hooded main lamp under a lightning spike. Every part is here because it
 * answers a question a viewer might ask about an object that is otherwise three
 * triangles at street distance.
 *
 * Unit space, deliberately unlike a building: the base sits at y = 0 and the
 * spike tip at y = 1, so the caller's scale is simply "how tall the whole
 * beacon is". The widest point is a base-plate corner at a radius of ~0.23,
 * inside the 0.35 a caller needs to tuck one into a roof corner. Vertices carry
 * a `color` channel rather than a texture, so one material with
 * `vertexColors: true` paints the housing, the structural steel and the lens
 * apart from each other without spending a second draw call.
 */

import {
  PART_BODY,
  PART_CROWN,
  PART_FIXED,
  PART_PODIUM,
  TAU,
  box,
  cylinder,
  mergeColouredParts,
  paint,
  tag,
} from '../primitives.js';

// Three finishes, not three materials. The housing is the desaturated grey
// every rooftop rig ends up; the steel is darker and colder, for the parts that
// carry load (bolts, guys, arms); the lens is near-white so it stays the
// brightest surface under any tier colour. Saturation is kept low because the
// tier colour the caller multiplies over the top is already doing the
// signalling, and a saturated housing would fight it.
const HOUSING = [0.63, 0.66, 0.70];
const STEEL = [0.41, 0.43, 0.47];
const LENS = [0.97, 0.99, 1.0];

/**
 * A thin box stretched between two points in the X-Y plane, for guy wires and
 * cross-arm braces. `box()` only translates, and a wire that leans away from the
 * mast is the entire reason a guyed mast reads as guyed, so this rotates one
 * into place; the tag records its true vertical extent, not the pre-rotation one.
 */
function strut(THREE, { x0, y0, x1, y1, z = 0, w = 0.006, part = PART_FIXED }) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = Math.hypot(dx, dy);
  const geometry = new THREE.BoxGeometry(w, length, w);
  geometry.rotateZ(-Math.atan2(dx, dy));
  geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, z);
  return tag(geometry, part, Math.min(y0, y1), Math.max(y0, y1));
}

/**
 * One obstruction beacon, ~480 triangles, merged into a single geometry.
 *
 * The part tags are the caller's contract with the massing shader: the base is
 * PODIUM so it can skirt, the mast and neck are BODY so they stay exactly as
 * placed, and the lamps are CROWN. Nothing is displaced unless the caller
 * chooses to patch the material.
 */
export function beaconGeometry(THREE) {
  const housing = (geometry) => paint(THREE, geometry, HOUSING);
  const steel = (geometry) => paint(THREE, geometry, STEEL);
  const lens = (geometry) => paint(THREE, geometry, LENS);

  return mergeColouredParts(THREE, [
    // Base: a square plate with a raised hub and four anchor bolts. A beacon
    // merely balanced on a roof is a prop; one bolted through it is a fixture,
    // and four bolt heads are the cheapest way to say so.
    steel(box(THREE, { w: 0.32, d: 0.32, y0: 0, y1: 0.028, part: PART_PODIUM })),
    housing(cylinder(THREE, {
      rTop: 0.10, rBottom: 0.12, y0: 0.026, y1: 0.07, segments: 8, part: PART_PODIUM,
    })),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) =>
      steel(box(THREE, {
        w: 0.024, d: 0.024, x: sx * 0.115, z: sz * 0.115, y0: 0.028, y1: 0.076,
        part: PART_PODIUM,
      }))
    ),
    // Mast: tapers from the hub to the lamp. A constant-diameter pole reads as
    // a stick from across the city; the taper is most of what says engineered.
    housing(cylinder(THREE, {
      rTop: 0.028, rBottom: 0.05, y0: 0.06, y1: 0.62, segments: 8, part: PART_BODY,
    })),
    // Three guys, not four: the plate's corners stay readable from above, and
    // the silhouette stops being radially symmetric. Rotating one wire about
    // the mast is how a real rig gets its even 120-degree stays.
    ...[0, 1, 2].map((index) =>
      steel(strut(THREE, { x0: 0.03, y0: 0.52, x1: 0.15, y1: 0.03 })).rotateY((index / 3) * TAU)
    ),
    // Control box and its conduit: the servicing story, and the vertical line
    // that keeps the lower mast from reading as empty air.
    housing(box(THREE, {
      w: 0.10, d: 0.075, x: 0.085, z: 0.045, y0: 0.09, y1: 0.24, part: PART_FIXED,
    })),
    steel(box(THREE, {
      w: 0.02, d: 0.02, x: 0.075, z: 0.045, y0: 0.24, y1: 0.70, part: PART_FIXED,
    })),
    // Cross-arm, braced back to the mast, carrying the secondary lamp. Real
    // rigs carry two lamps so one failure cannot darken a whole roof.
    steel(box(THREE, { w: 0.30, d: 0.03, y0: 0.705, y1: 0.73, part: PART_FIXED })),
    steel(strut(THREE, { w: 0.005, x0: 0.03, y0: 0.65, x1: 0.11, y1: 0.705 })),
    steel(strut(THREE, { w: 0.005, x0: -0.03, y0: 0.65, x1: -0.11, y1: 0.705 })),
    steel(box(THREE, { w: 0.014, d: 0.014, x: 0.13, y0: 0.70, y1: 0.735, part: PART_FIXED })),
    housing(cylinder(THREE, {
      rTop: 0.026, rBottom: 0.018, x: 0.13, y0: 0.635, y1: 0.70, segments: 6, part: PART_CROWN,
    })),
    housing(cylinder(THREE, {
      rTop: 0.018, rBottom: 0.032, x: 0.13, y0: 0.698, y1: 0.722, segments: 6, part: PART_CROWN,
    })),
    lens(cylinder(THREE, {
      rTop: 0.016, rBottom: 0.016, x: 0.13, y0: 0.623, y1: 0.635, segments: 6, part: PART_CROWN,
    })),
    // Neck and the main head: housing, a lens band set proud of the housing so
    // it catches light from every side, and a flared hood whose overhang
    // shadows that lens the way a real shade does.
    housing(cylinder(THREE, {
      rTop: 0.024, rBottom: 0.032, y0: 0.60, y1: 0.75, segments: 8, part: PART_BODY,
    })),
    housing(cylinder(THREE, {
      rTop: 0.055, rBottom: 0.04, y0: 0.75, y1: 0.895, segments: 10, part: PART_CROWN,
    })),
    lens(cylinder(THREE, {
      rTop: 0.058, rBottom: 0.058, y0: 0.895, y1: 0.935, segments: 10, part: PART_CROWN,
    })),
    housing(cylinder(THREE, {
      rTop: 0.045, rBottom: 0.078, y0: 0.935, y1: 0.972, segments: 10, part: PART_FIXED,
    })),
    // The lightning spike, up to the exact unit height the caller scales by.
    steel(cylinder(THREE, {
      rTop: 0.002, rBottom: 0.010, y0: 0.972, y1: 1.0, segments: 6, part: PART_CROWN,
    })),
  ]);
}

/**
 * The three grading bands a building's heat falls into, in ascending order.
 *
 * Fields, all consumed by the caller:
 *   max       inclusive upper bound on `heat`; the last band is Infinity
 *   colour    base albedo for the tier, multiplied over the vertex colours
 *   emissive  the lamp's own colour, lit regardless of scene light
 *   intensity emissive multiplier -- hotter files burn brighter
 *   pulse     0..1 how hard this tier blinks; the caller animates it
 *
 * The bands and their colours are unchanged from the three materials
 * `CityMesh._addHeatBeacons` used before; only `pulse` is new, so a steady grey,
 * an amber and a blinking red still mean what the legend says.
 */
export function beaconTiers() {
  return [
    { max: 0.65, colour: 0x6b7686, emissive: 0x3a4552, intensity: 0.5, pulse: 0 },
    { max: 0.85, colour: 0xe0a63a, emissive: 0xe0a63a, intensity: 1.1, pulse: 0.6 },
    { max: Infinity, colour: 0xe0503a, emissive: 0xff5533, intensity: 1.6, pulse: 1.0 },
  ];
}
