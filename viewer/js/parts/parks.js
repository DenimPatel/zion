/**
 * A park: one building whose form is the archetype of a public green.
 *
 * A park is a place rather than a file, so it is the one massing judged from
 * inside rather than from the skyline: it is entered, not read. The old tile was
 * a slab of green with five canopies and one path across it -- legible from the
 * aerial view, and a vacant lot from the street. This builder lays out the
 * things that turn a green tile into ground people use: a walled lawn, a cross
 * of paving that leaves the plot through gates in that wall, water, a grove, a
 * tended garden, a bandstand to walk toward and furniture to sit on once you
 * arrive.
 *
 * Height is the constraint that shapes everything here. A park's building height
 * in the data is tiny, so every piece stays low -- the tallest, a conifer's tip,
 * reaches y = 0.59 -- which keeps the vertical compression of a low-height
 * instance reading as a shallow relief model rather than a smear. Nothing is a
 * building body, so nothing may be displaced by the massing shader: every
 * sub-geometry is PART_FIXED, and the whole park is one merged buffer like the
 * other archetypes, so a repo of a hundred parks still costs one draw call.
 *
 * Every piece is painted in its own material (vertex colours, merged with
 * `mergeColouredParts`): lawn, paving, stone, water, foliage, timber, iron. The
 * instance colour over them is near white under the archetype lens, so the
 * park reads as a park; under any data lens the vertex colours are switched
 * off and the whole park takes the lens colour, like every other building.
 */

import { PART_FIXED, box, cylinder, mergeColouredParts, paint, tag } from '../primitives.js';

const LAWN_GREEN = [0.36, 0.6, 0.3];
const KNOLL_GREEN = [0.3, 0.52, 0.26];
const PAVING = [0.84, 0.8, 0.7];
const PLAZA = [0.9, 0.86, 0.76];
const WALL = [0.72, 0.68, 0.62];
const WATER = [0.3, 0.55, 0.78];
const SPRAY = [0.86, 0.94, 1.0];
const HEDGE = [0.18, 0.4, 0.2];
const SOIL = [0.45, 0.32, 0.22];
const BLOOM = [0.9, 0.42, 0.55];
const TRUNK = [0.42, 0.3, 0.2];
const LEAF = [0.3, 0.58, 0.28];
const LEAF_LIGHT = [0.46, 0.7, 0.32];
const PINE = [0.16, 0.42, 0.28];
const TIMBER = [0.6, 0.42, 0.26];
const IRON = [0.2, 0.21, 0.24];
const LANTERN = [1.0, 0.9, 0.6];
const PAVILION = [0.95, 0.94, 0.9];
const PAVILION_ROOF = [0.66, 0.22, 0.2];

/**
 * A broad, round-crowned tree: a tapered trunk under two stacked blobs.
 *
 * Two blobs rather than one, because a single sphere reads as a bush; the
 * smaller upper lobe is what makes the silhouette a deciduous tree from above.
 */
function broadTree(THREE, x, z, ground) {
  return [
    paint(THREE, cylinder(THREE, {
      rTop: 0.012, rBottom: 0.02, x, z, y0: ground, y1: ground + 0.14,
      segments: 5, part: PART_FIXED,
    }), TRUNK),
    paint(THREE, tag(
      new THREE.IcosahedronGeometry(0.06, 0).scale(1, 0.85, 1).translate(x, ground + 0.2, z),
      PART_FIXED,
      ground + 0.14,
      ground + 0.26
    ), LEAF),
    paint(THREE, tag(
      new THREE.IcosahedronGeometry(0.043, 0).scale(1, 0.8, 1).translate(x, ground + 0.29, z),
      PART_FIXED,
      ground + 0.25,
      ground + 0.34
    ), LEAF_LIGHT),
  ];
}

/**
 * A slim conifer: two cones over a short trunk, so it reads against the broad
 * canopies above as a different species even at a glance.
 */
function conicalTree(THREE, x, z, ground) {
  return [
    paint(THREE, cylinder(THREE, {
      rTop: 0.009, rBottom: 0.016, x, z, y0: ground, y1: ground + 0.16,
      segments: 5, part: PART_FIXED,
    }), TRUNK),
    paint(THREE, cylinder(THREE, {
      rTop: 0.004, rBottom: 0.05, x, z, y0: ground + 0.12, y1: ground + 0.3,
      segments: 6, part: PART_FIXED,
    }), PINE),
    paint(THREE, cylinder(THREE, {
      rTop: 0.003, rBottom: 0.035, x, z, y0: ground + 0.28, y1: ground + 0.42,
      segments: 6, part: PART_FIXED,
    }), PINE),
  ];
}

/** A clipped ornamental shrub -- one squashed blob, low enough to edge a bed. */
function shrub(THREE, x, z, ground) {
  return [
    paint(THREE, tag(
      new THREE.IcosahedronGeometry(0.026, 0).scale(1, 0.8, 1).translate(x, ground + 0.03, z),
      PART_FIXED,
      ground,
      ground + 0.06
    ), HEDGE),
  ];
}

/**
 * A park bench: slatted seat, back and two legs.
 *
 * The back sits behind the seat rather than centred on it, so the bench faces
 * one way -- toward the path it was set beside -- instead of reading as a
 * symmetric block from any direction.
 */
function bench(THREE, x, z, ground) {
  return [
    paint(THREE, box(THREE, {
      w: 0.13, d: 0.04, x, z: z - 0.005, y0: ground + 0.06, y1: ground + 0.085, part: PART_FIXED,
    }), TIMBER),
    paint(THREE, box(THREE, {
      w: 0.13, d: 0.022, x, z: z + 0.028,
      y0: ground + 0.085, y1: ground + 0.145, part: PART_FIXED,
    }), TIMBER),
    paint(THREE, box(THREE, {
      w: 0.022, d: 0.03, x: x - 0.05, z, y0: ground, y1: ground + 0.06, part: PART_FIXED,
    }), IRON),
    paint(THREE, box(THREE, {
      w: 0.022, d: 0.03, x: x + 0.05, z, y0: ground, y1: ground + 0.06, part: PART_FIXED,
    }), IRON),
  ];
}

/** A lamp post: a slim standard under a boxy lantern head, not a streetlight. */
function lamp(THREE, x, z, ground) {
  return [
    paint(THREE, cylinder(THREE, {
      rTop: 0.012, rBottom: 0.018, x, z, y0: ground, y1: ground + 0.28,
      segments: 5, part: PART_FIXED,
    }), IRON),
    paint(THREE, box(THREE, {
      w: 0.05, d: 0.05, x, z, y0: ground + 0.28, y1: ground + 0.34, part: PART_FIXED,
    }), LANTERN),
  ];
}

export function parkGeometry(THREE) {
  // The lawn's top plane, and the level things are actually planted at -- a
  // hair below it, so no prop sits exactly on the surface and z-fights the
  // grass it stands in.
  const LAWN = 0.13;
  const LAND = 0.11;
  // The grove is planted on a low knoll, which is the mound the base needs to
  // be more than a plate: a park's ground is rolled, not poured.
  const KNOLL = 0.18;
  const ON_KNOLL = KNOLL - 0.01;

  // The bandstand's ring of posts, generated so the colonnade stays even.
  const posts = [0, 1, 2, 3, 4, 5].map((step) => {
    const angle = (step / 6) * Math.PI * 2;
    return paint(THREE, cylinder(THREE, {
      rTop: 0.011, rBottom: 0.011, segments: 5, part: PART_FIXED,
      x: 0.29 + Math.cos(angle) * 0.125,
      z: 0.29 + Math.sin(angle) * 0.125,
      y0: 0.22, y1: 0.4,
    }), PAVILION);
  });

  return mergeColouredParts(THREE, [
    // The lawn. A flat plate rather than a dome, because the paved cross has to
    // lie on it and a dome would leave the paths hovering at their edges.
    paint(THREE, box(THREE, { w: 1, d: 1, y0: 0, y1: LAWN, part: PART_FIXED }), LAWN_GREEN),

    // A kerb with a gate on each axis: the wall says "this ground is kept", and
    // the gates say "walk in" -- a park nobody can enter is just a lawn.
    paint(THREE, box(THREE, { w: 0.42, d: 0.04, x: -0.29, z: -0.48, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.42, d: 0.04, x: 0.29, z: -0.48, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.42, d: 0.04, x: -0.29, z: 0.48, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.42, d: 0.04, x: 0.29, z: 0.48, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.04, d: 0.42, x: -0.48, z: -0.29, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.04, d: 0.42, x: -0.48, z: 0.29, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.04, d: 0.42, x: 0.48, z: -0.29, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),
    paint(THREE, box(THREE, { w: 0.04, d: 0.42, x: 0.48, z: 0.29, y0: LAND, y1: 0.2, part: PART_FIXED }), WALL),

    // A cross of paving, wide enough to read as a route from directly above and
    // joined by a small plaza where the arms meet -- the crossing is where a
    // park's life actually gathers, so it is paved wider than the paths.
    paint(THREE, box(THREE, { w: 0.08, d: 1, x: 0, z: 0, y0: LAND, y1: 0.155, part: PART_FIXED }), PAVING),
    paint(THREE, box(THREE, { w: 1, d: 0.08, x: 0, z: 0, y0: LAND, y1: 0.155, part: PART_FIXED }), PAVING),
    paint(THREE, box(THREE, { w: 0.2, d: 0.2, x: 0, z: 0, y0: LAND, y1: 0.16, part: PART_FIXED }), PLAZA),

    // The knoll under the grove, low enough that it never reads as a mound of
    // its own -- just ground that has been shaped.
    paint(THREE, cylinder(THREE, {
      rTop: 0.135, rBottom: 0.155, x: 0.285, z: -0.285, y0: LAND, y1: KNOLL, segments: 10,
      part: PART_FIXED,
    }), KNOLL_GREEN),

    // A fountain in the north-west quarter: a shallow basin with a raised lip,
    // a water surface just below it and a jet rising from the middle. The lip is
    // the basin's own top cap left exposed around a smaller water disc, so the
    // rim costs nothing and always lines up.
    paint(THREE, cylinder(THREE, {
      rTop: 0.115, rBottom: 0.105, x: -0.24, z: -0.24, y0: LAND, y1: 0.175, segments: 12,
      part: PART_FIXED,
    }), WALL),
    paint(THREE, tag(
      new THREE.CircleGeometry(0.1, 12).rotateX(-Math.PI / 2).translate(-0.24, 0.179, -0.24),
      PART_FIXED,
      0.175,
      0.179
    ), WATER),
    paint(THREE, cylinder(THREE, {
      rTop: 0.005, rBottom: 0.028, x: -0.24, z: -0.24, y0: 0.175, y1: 0.3, segments: 6,
      part: PART_FIXED,
    }), SPRAY),
    paint(THREE, tag(
      new THREE.IcosahedronGeometry(0.026, 0).scale(1, 0.8, 1).translate(-0.24, 0.31, -0.24),
      PART_FIXED,
      0.3,
      0.33
    ), SPRAY),

    // A garden in the south-west quarter: two lengths of clipped hedge making an
    // L, two raised beds and a bed of shrubs, so a park shows tended ground and
    // not only lawn.
    paint(THREE, box(THREE, { w: 0.3, d: 0.04, x: -0.25, z: 0.16, y0: LAND, y1: 0.21, part: PART_FIXED }), HEDGE),
    paint(THREE, box(THREE, { w: 0.04, d: 0.2, x: -0.4, z: 0.29, y0: LAND, y1: 0.21, part: PART_FIXED }), HEDGE),
    paint(THREE, box(THREE, { w: 0.15, d: 0.09, x: -0.29, z: 0.29, y0: LAND, y1: 0.19, part: PART_FIXED }), BLOOM),
    paint(THREE, box(THREE, { w: 0.09, d: 0.14, x: -0.15, z: 0.3, y0: LAND, y1: 0.19, part: PART_FIXED }), SOIL),

    // Benches face the paths they were set beside, one in the garden and one
    // just off the plaza in the south-east quarter.
    ...bench(THREE, -0.26, 0.4, LAND),
    ...bench(THREE, 0.13, 0.12, LAND),

    // Three lamps, spaced around the plaza rather than at its corners, so the
    // crossing is lit without boxing it in.
    ...lamp(THREE, -0.07, -0.15, LAND),
    ...lamp(THREE, -0.07, 0.15, LAND),
    ...lamp(THREE, 0.07, 0.2, LAND),

    // The grove: broad and conical trees interleaved at varied heights, planted
    // on the knoll so the wood has a floor of its own. Two species only -- a
    // park's planting reads as designed when it repeats, not when it surprises.
    ...broadTree(THREE, 0.19, -0.19, ON_KNOLL),
    ...broadTree(THREE, 0.38, -0.38, ON_KNOLL),
    ...conicalTree(THREE, 0.38, -0.19, ON_KNOLL),
    ...conicalTree(THREE, 0.19, -0.38, ON_KNOLL),
    ...broadTree(THREE, 0.285, -0.285, ON_KNOLL),
    ...shrub(THREE, 0.285, -0.19, ON_KNOLL),
    ...shrub(THREE, 0.285, -0.38, ON_KNOLL),

    // A bandstand in the south-east quarter, the thing to walk toward: a stepped
    // drum, a ring of columns, a conical cap and a finial -- the same hierarchy
    // of base, shaft and crown a real pavilion has, at a park's scale.
    paint(THREE, cylinder(THREE, {
      rTop: 0.155, rBottom: 0.165, x: 0.29, z: 0.29, y0: LAND, y1: 0.17, segments: 10,
      part: PART_FIXED,
    }), WALL),
    paint(THREE, cylinder(THREE, {
      rTop: 0.145, rBottom: 0.145, x: 0.29, z: 0.29, y0: 0.17, y1: 0.22, segments: 10,
      part: PART_FIXED,
    }), PAVILION),
    ...posts,
    paint(THREE, cylinder(THREE, {
      rTop: 0.006, rBottom: 0.2, x: 0.29, z: 0.29, y0: 0.4, y1: 0.5, segments: 8, part: PART_FIXED,
    }), PAVILION_ROOF),
    paint(THREE, cylinder(THREE, {
      rTop: 0.006, rBottom: 0.02, x: 0.29, z: 0.29, y0: 0.5, y1: 0.55,
      segments: 5, part: PART_FIXED,
    }), LANTERN),
  ]);
}
