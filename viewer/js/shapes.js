/**
 * Archetype massing: one unit-normalised geometry per building form.
 *
 * Every shape here lives in the same box the old `BoxGeometry(1,1,1)` did --
 * X and Z in [-0.5, 0.5], Y in [0, 1] -- so the instance matrix that places a
 * building is unchanged: scale by (width, height, depth), translate to the
 * footprint centre. Swapping the geometry is therefore a pure rendering change
 * and the layout, the collision grid and the picking maths never learn about it.
 *
 * Each vertex additionally carries which *part* of the massing it belongs to,
 * and that part's vertical extent. The vertex shader uses those three numbers to
 * push crowns, setbacks and podiums around per instance, which is how a hundred
 * buildings sharing one geometry still end up with a hundred rooflines. See
 * `facade.js`.
 */

// Part tags. BODY is never displaced -- it is the massing the footprint and
// height actually mean -- so per-instance variation can never contradict the
// data. Everything else is ornament and is free to move.
export const PART_BODY = 0;
export const PART_SETBACK = 1;
export const PART_CROWN = 2;
export const PART_PODIUM = 3;
export const PART_FIXED = 4;

const TAU = Math.PI * 2;

/** Record which part a finished sub-geometry is, and where it sits vertically. */
function tag(geometry, part, y0, y1) {
  geometry.userData.part = part;
  geometry.userData.y0 = y0;
  geometry.userData.y1 = y1;
  return geometry;
}

function box(THREE, { w = 1, d = 1, y0 = 0, y1 = 1, x = 0, z = 0, part = PART_BODY }) {
  const geometry = new THREE.BoxGeometry(w, Math.max(1e-4, y1 - y0), d);
  geometry.translate(x, (y0 + y1) / 2, z);
  return tag(geometry, part, y0, y1);
}

function cylinder(THREE, { rTop, rBottom, y0, y1, x = 0, z = 0, segments = 14, part = PART_BODY }) {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, Math.max(1e-4, y1 - y0), segments);
  geometry.translate(x, (y0 + y1) / 2, z);
  return tag(geometry, part, y0, y1);
}

/** A four-sided tapered shaft, square-on to the world rather than diamond-on. */
function obelisk(THREE, options) {
  const geometry = cylinder(THREE, { ...options, segments: 4 });
  geometry.rotateY(Math.PI / 4);
  return geometry;
}

function dome(THREE, { radius, y0, height, x = 0, z = 0, part = PART_CROWN }) {
  const geometry = new THREE.SphereGeometry(radius, 12, 4, 0, TAU, 0, Math.PI / 2);
  geometry.scale(1, height / radius, 1);
  geometry.translate(x, y0, z);
  return tag(geometry, part, y0, y0 + height);
}

/**
 * A gable roof: a triangular prism ridged along X.
 *
 * Built by hand rather than from a primitive because three has no prism, and a
 * rotated box would give the wrong silhouette once the instance scale stretches
 * the footprint non-uniformly.
 */
function gable(THREE, { w, d, y0, y1, part = PART_FIXED }) {
  const hx = w / 2;
  const hz = d / 2;
  const positions = [];
  const normals = [];
  const push = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const point of [a, b, c]) {
      positions.push(point[0], point[1], point[2]);
      normals.push(nx, ny, nz);
    }
  };

  const ridgeA = [-hx, y1, 0];
  const ridgeB = [hx, y1, 0];
  const eave = [
    [-hx, y0, -hz], [hx, y0, -hz], [hx, y0, hz], [-hx, y0, hz],
  ];
  push(eave[0], eave[1], ridgeB); push(eave[0], ridgeB, ridgeA); // north slope
  push(eave[2], eave[3], ridgeA); push(eave[2], ridgeA, ridgeB); // south slope
  push(eave[0], ridgeA, eave[3]); // west gable end
  push(eave[1], eave[2], ridgeB); // east gable end

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return tag(geometry, part, y0, y1);
}

/**
 * Concatenate tagged sub-geometries into one non-indexed buffer.
 *
 * Non-indexed costs some vertices but keeps the merge to three array copies and
 * lets each part carry flat per-vertex tags with no index remapping. The whole
 * city shares eight of these, so the size never matters.
 */
export function mergeParts(THREE, parts) {
  const geometries = parts.map((g) => (g.index ? Object.assign(g.toNonIndexed(), { userData: g.userData }) : g));
  const total = geometries.reduce((sum, g) => sum + g.attributes.position.count, 0);

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  // (part, y0, y1) in one attribute rather than three.
  //
  // A building already spends eleven of WebGL's sixteen vertex attribute slots
  // -- an instance matrix alone is four -- and three separate floats here was
  // enough to push a later addition over the limit, which fails as an opaque
  // "too many attributes" link error rather than anything that points at a
  // cause. Packing related values keeps that headroom.
  const massing = new Float32Array(total * 3);

  let offset = 0;
  for (const geometry of geometries) {
    const count = geometry.attributes.position.count;
    position.set(geometry.attributes.position.array, offset * 3);
    normal.set(geometry.attributes.normal.array, offset * 3);
    for (let i = 0; i < count; i++) {
      massing[(offset + i) * 3] = geometry.userData.part;
      massing[(offset + i) * 3 + 1] = geometry.userData.y0;
      massing[(offset + i) * 3 + 2] = geometry.userData.y1;
    }
    offset += count;
  }
  for (const geometry of parts) geometry.dispose();
  for (const geometry of geometries) geometry.dispose();

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('aMassing', new THREE.BufferAttribute(massing, 3));
  // Instances are placed by matrix, so the shared geometry's own bounds are
  // meaningless for culling; three needs them non-null all the same.
  merged.computeBoundingSphere();
  return merged;
}

const BUILDERS = {
  // An office tower: podium, shaft, one setback, a crown that may or may not
  // be there. The setback and crown are the two the shader varies, which is
  // what keeps a district of towers from reading as a comb.
  tower: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.05, part: PART_PODIUM }),
    box(THREE, { w: 0.9, d: 0.9, y0: 0.02, y1: 0.74, part: PART_BODY }),
    box(THREE, { w: 0.66, d: 0.66, y0: 0.72, y1: 0.94, part: PART_SETBACK }),
    box(THREE, { w: 0.3, d: 0.3, y0: 0.92, y1: 1.0, part: PART_CROWN }),
  ]),

  // A slab block: one long body, a parapet lip that catches the sun, and a
  // rooftop plant room offset to one side so the roof is never symmetrical.
  slab: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.02, d: 1.02, y0: 0, y1: 0.04, part: PART_PODIUM }),
    box(THREE, { w: 0.94, d: 0.94, y0: 0.02, y1: 0.93, part: PART_BODY }),
    box(THREE, { w: 1.0, d: 1.0, y0: 0.91, y1: 0.96, part: PART_FIXED }),
    box(THREE, { w: 0.36, d: 0.44, x: 0.16, z: -0.12, y0: 0.95, y1: 1.0, part: PART_CROWN }),
  ]),

  // A shed: low, wide, pitched, with a loading dock apron on one side.
  warehouse: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.76, part: PART_BODY }),
    gable(THREE, { w: 1.04, d: 1.04, y0: 0.74, y1: 1.0 }),
    box(THREE, { w: 0.62, d: 0.08, z: -0.52, y0: 0, y1: 0.2, part: PART_FIXED }),
    box(THREE, { w: 0.12, d: 0.1, x: -0.3, z: 0.5, y0: 0.76, y1: 0.98, part: PART_FIXED }),
  ]),

  // A silo: a ribbed drum under a shallow cap, on a square footing.
  silo: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.05, part: PART_PODIUM }),
    cylinder(THREE, { rTop: 0.44, rBottom: 0.46, y0: 0.03, y1: 0.86, part: PART_BODY }),
    cylinder(THREE, { rTop: 0.49, rBottom: 0.49, y0: 0.42, y1: 0.46, segments: 14, part: PART_FIXED }),
    dome(THREE, { radius: 0.45, y0: 0.85, height: 0.15, part: PART_CROWN }),
  ]),

  // A monument: stepped plinth, tapered shaft, pyramidion. No windows.
  monument: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.08, part: PART_PODIUM }),
    box(THREE, { w: 0.74, d: 0.74, y0: 0.07, y1: 0.16, part: PART_FIXED }),
    obelisk(THREE, { rTop: 0.2, rBottom: 0.36, y0: 0.15, y1: 0.88, part: PART_BODY }),
    obelisk(THREE, { rTop: 0.001, rBottom: 0.2, y0: 0.87, y1: 1.0, part: PART_CROWN }),
  ]),

  // A town hall: broad steps, a colonnaded body, a lantern and a cupola. The
  // README of its folder, so it should read as civic from a street away.
  town_hall: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.07, part: PART_PODIUM }),
    box(THREE, { w: 0.88, d: 0.88, y0: 0.06, y1: 0.13, part: PART_FIXED }),
    box(THREE, { w: 0.78, d: 0.78, y0: 0.12, y1: 0.6, part: PART_BODY }),
    box(THREE, { w: 0.9, d: 0.9, y0: 0.58, y1: 0.68, part: PART_FIXED }),
    box(THREE, { w: 0.3, d: 0.3, y0: 0.66, y1: 0.88, part: PART_SETBACK }),
    dome(THREE, { radius: 0.2, y0: 0.87, height: 0.13, part: PART_CROWN }),
  ]),

  // A park: a grassed mound and three canopies. Height is small by
  // construction, so this is mostly read from above.
  park: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.12, part: PART_FIXED }),
    ...[
      [-0.2, -0.18, 0.3, 0.55],
      [0.24, 0.06, 0.24, 0.42],
      [-0.06, 0.26, 0.2, 0.34],
    ].flatMap(([x, z, spread, top]) => [
      box(THREE, { w: 0.05, d: 0.05, x, z, y0: 0.1, y1: top * 0.55, part: PART_FIXED }),
      tag(
        new THREE.IcosahedronGeometry(spread / 2, 0)
          .scale(1, 0.8, 1)
          .translate(x, top * 0.72, z),
        PART_FIXED,
        top * 0.4,
        top
      ),
    ]),
  ]),

  // A ruin: a truncated body and two broken stubs at different heights, so no
  // two ruins present the same broken edge to the camera.
  ruin: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.08, part: PART_PODIUM }),
    box(THREE, { w: 0.9, d: 0.9, y0: 0.05, y1: 0.54, part: PART_BODY }),
    box(THREE, { w: 0.34, d: 0.36, x: 0.26, z: 0.2, y0: 0.5, y1: 0.94, part: PART_SETBACK }),
    box(THREE, { w: 0.3, d: 0.26, x: -0.28, z: -0.22, y0: 0.5, y1: 0.72, part: PART_FIXED }),
    box(THREE, { w: 0.5, d: 0.08, x: -0.05, z: 0.34, y0: 0.5, y1: 0.62, part: PART_FIXED }),
  ]),
};

/**
 * The distant geometry: a plain box, as before.
 *
 * Silhouette detail is invisible past the LOD radius but the triangles are not,
 * so the far tier keeps the twelve-triangle massing and lets the facade shader
 * carry whatever still reads at that range.
 */
export function farGeometry(THREE) {
  return mergeParts(THREE, [box(THREE, { w: 1, d: 1, y0: 0, y1: 1, part: PART_BODY })]);
}

/** Cached per-archetype near geometry; eight of them serve the whole city. */
export function nearGeometry(THREE, archetype, cache) {
  if (cache.has(archetype)) return cache.get(archetype);
  const build = BUILDERS[archetype] || BUILDERS.warehouse;
  const geometry = build(THREE);
  cache.set(archetype, geometry);
  return geometry;
}

/**
 * Rooftop clutter: plant room, water tank, vent stack and a mast, merged into
 * one cluster so the entire city's roofs cost a single draw call.
 *
 * Placed in unit space like everything else, then scaled per building. Which of
 * the four pieces actually shows is decided per instance in the vertex shader.
 */
export function roofPropGeometry(THREE) {
  return mergeParts(THREE, [
    box(THREE, { w: 0.34, d: 0.28, x: -0.16, z: 0.12, y0: 0, y1: 0.55, part: PART_BODY }),
    cylinder(THREE, { rTop: 0.1, rBottom: 0.1, x: 0.18, z: -0.1, y0: 0.1, y1: 0.8, segments: 8, part: PART_SETBACK }),
    box(THREE, { w: 0.07, d: 0.07, x: 0.02, z: 0.3, y0: 0, y1: 1.0, part: PART_CROWN }),
    box(THREE, { w: 0.22, d: 0.18, x: 0.26, z: 0.24, y0: 0, y1: 0.3, part: PART_PODIUM }),
  ]);
}
