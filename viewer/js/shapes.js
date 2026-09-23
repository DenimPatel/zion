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
    // A second, narrower step -- one plinth reads as a base; two read as
    // something deliberately built up to, the way real monuments are.
    box(THREE, { w: 0.56, d: 0.56, y0: 0.15, y1: 0.23, part: PART_FIXED }),
    obelisk(THREE, { rTop: 0.2, rBottom: 0.32, y0: 0.22, y1: 0.86, part: PART_BODY }),
    // A cornice collar at the shaft/pyramidion transition, the detail line
    // real obelisks carry at that same seam.
    obelisk(THREE, { rTop: 0.23, rBottom: 0.23, y0: 0.85, y1: 0.885, part: PART_FIXED }),
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

  // A park: a grassed mound, five canopies, a path and a bench. Height is
  // small by construction, so this is mostly read from above -- the path and
  // bench are there for the street-level pass, so a park does not read as an
  // empty green tile up close.
  park: (THREE) => mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.12, part: PART_FIXED }),
    // A paved path, corner to corner, so the green reads as a place people
    // walk through rather than a lawn nobody enters.
    box(THREE, { w: 0.1, d: 1.06, x: 0, z: 0, y0: 0.1, y1: 0.13, part: PART_FIXED }),
    // A bench beside the path.
    box(THREE, { w: 0.16, d: 0.05, x: 0.14, z: -0.2, y0: 0.13, y1: 0.2, part: PART_FIXED }),
    box(THREE, { w: 0.16, d: 0.02, x: 0.14, z: -0.24, y0: 0.2, y1: 0.28, part: PART_FIXED }),
    ...[
      [-0.24, -0.3, 0.28, 0.52],
      [0.28, 0.1, 0.22, 0.4],
      [-0.1, 0.3, 0.2, 0.32],
      [-0.32, 0.18, 0.16, 0.28],
      [0.2, -0.32, 0.18, 0.36],
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

/**
 * A rooftop beacon: a short mast topped with a glowing orb, planted near a
 * corner of the roof so it doesn't fight the crown for space. Its colour
 * tier (dim, amber, red) is decided by which of three instanced meshes a
 * building's beacon goes into -- see `CityMesh._addHeatBeacons` -- so this
 * geometry itself carries no colour, just the shape every tier shares.
 * Reads at a glance the way a real rooftop warning light does: distinct from
 * the crane (a construction machine on top of the roof) and the antenna (a
 * mast that keeps rising well past the roofline) both defined below.
 */
export function beaconGeometry(THREE) {
  return mergeParts(THREE, [
    cylinder(THREE, { rTop: 0.03, rBottom: 0.045, x: 0, z: 0, y0: 0, y1: 0.55, segments: 6, part: PART_PODIUM }),
    tag(new THREE.SphereGeometry(0.11, 10, 8).translate(0, 0.66, 0), PART_CROWN, 0.55, 0.77),
  ]);
}

/**
 * Scaffolding: a lattice of corner poles and horizontal rings wrapping a
 * building's own footprint and height. Unlike the roof props and crane above,
 * this is scaled by the *building's* own instance transform (width, height,
 * depth), not a separate small-prop scale, so it always wraps the building it
 * belongs to exactly -- new construction on a new file, at the file's own
 * size. Marks a file born in the newest slice of the repo's history (S2 in
 * docs/VISUALIZATION_ROADMAP.md).
 */
export function scaffoldingGeometry(THREE) {
  const corners = [
    [-0.49, -0.49],
    [0.49, -0.49],
    [-0.49, 0.49],
    [0.49, 0.49],
  ];
  const parts = corners.map(([x, z]) =>
    cylinder(THREE, { rTop: 0.02, rBottom: 0.02, x, z, y0: 0, y1: 1, segments: 5, part: PART_FIXED })
  );
  for (const y of [0.25, 0.5, 0.75]) {
    parts.push(
      box(THREE, { w: 1.0, d: 0.03, x: 0, z: -0.49, y0: y, y1: y + 0.018, part: PART_FIXED }),
      box(THREE, { w: 1.0, d: 0.03, x: 0, z: 0.49, y0: y, y1: y + 0.018, part: PART_FIXED }),
      box(THREE, { w: 0.03, d: 1.0, x: -0.49, z: 0, y0: y, y1: y + 0.018, part: PART_FIXED }),
      box(THREE, { w: 0.03, d: 1.0, x: 0.49, z: 0, y0: y, y1: y + 0.018, part: PART_FIXED })
    );
  }
  return mergeParts(THREE, parts);
}

/**
 * A bus-factor-1 marker: a small post with a flag, planted at one corner of
 * the plot -- "for sale" the day the one person who understands this file
 * leaves (S12). Ground-level, unlike the roof props above, since ownership is
 * a property of the whole file rather than something happening on the roof.
 */
/**
 * A small triangular pennant, tapering away from the pole -- built by hand
 * (like `gable()` above) rather than a plane, so it reads as cloth rather
 * than as a signboard. Double-sided: a flag seen from behind should still
 * look like a flag, not vanish.
 */
function _pennant(THREE, { poleX = 0, y0, y1, length = 0.25, part = PART_CROWN }) {
  const top = [poleX, y1, 0];
  const bottom = [poleX, y0, 0];
  const tip = [poleX + length, (y0 + y1) / 2, 0];
  const positions = [];
  const normals = [];
  const push = (a, b, c, ny) => {
    for (const point of [a, b, c]) {
      positions.push(point[0], point[1], point[2]);
      normals.push(0, 0, ny);
    }
  };
  push(top, bottom, tip, 1); // front face
  push(tip, bottom, top, -1); // back face, opposite winding and normal
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return tag(geometry, part, y0, y1);
}

export function soleTenantMarkerGeometry(THREE) {
  return mergeParts(THREE, [
    cylinder(THREE, { rTop: 0.02, rBottom: 0.02, x: 0, z: 0, y0: 0, y1: 0.6, segments: 5, part: PART_FIXED }),
    _pennant(THREE, { poleX: 0, y0: 0.42, y1: 0.6, length: 0.28, part: PART_CROWN }),
  ]);
}

/**
 * A downtown antenna/spire: a thin mast rising well above the roofline, the
 * way a real skyline marks its tallest, most central towers. Marks a
 * building in the top slice of centrality (S8): co-change degree, import
 * in-degree, recent activity and ownership breadth combined.
 */
export function antennaGeometry(THREE) {
  return mergeParts(THREE, [
    cylinder(THREE, { rTop: 0.05, rBottom: 0.09, x: 0, z: 0, y0: 0, y1: 0.35, segments: 6, part: PART_PODIUM }),
    cylinder(THREE, { rTop: 0.008, rBottom: 0.03, x: 0, z: 0, y0: 0.3, y1: 1.5, segments: 6, part: PART_CROWN }),
    // An aircraft warning light at the very tip -- the detail that makes a
    // real skyline's tallest spires legible as landmarks rather than masts.
    tag(new THREE.SphereGeometry(0.045, 8, 6).translate(0, 1.5, 0), PART_CROWN, 1.46, 1.55),
  ]);
}

/**
 * A construction crane: a mast rising past the roofline with a long boom and a
 * short counter-jib. Marks the top decile of churn -- the file is being
 * actively worked, the way a crane on a roof means the building isn't
 * finished. Unit space, scaled and positioned per instance like the roof
 * clutter above; one draw call for every crane in the city.
 */
export function craneGeometry(THREE) {
  return mergeParts(THREE, [
    cylinder(THREE, { rTop: 0.045, rBottom: 0.06, x: 0, z: 0, y0: 0, y1: 1.35, segments: 6, part: PART_BODY }),
    box(THREE, { w: 0.9, d: 0.05, x: 0.42, z: 0, y0: 1.28, y1: 1.36, part: PART_SETBACK }),
    box(THREE, { w: 0.22, d: 0.05, x: -0.14, z: 0, y0: 1.28, y1: 1.4, part: PART_CROWN }),
    box(THREE, { w: 0.08, d: 0.08, x: -0.14, z: 0, y0: 1.15, y1: 1.28, part: PART_PODIUM }),
    // A hook, hanging from the boom's working end -- without it the mast and
    // boom alone read as an antenna with a crossbar. Stopped short of the
    // roof so it never appears to skewer the building it stands on.
    box(THREE, { w: 0.02, d: 0.02, x: 0.82, z: 0, y0: 0.85, y1: 1.28, part: PART_FIXED }),
    box(THREE, { w: 0.08, d: 0.08, x: 0.82, z: 0, y0: 0.78, y1: 0.86, part: PART_FIXED }),
    // A warning-light housing at the very top of the mast, the real-world
    // detail that makes a tower crane legible against a night sky.
    cylinder(THREE, { rTop: 0.001, rBottom: 0.05, x: 0, z: 0, y0: 1.36, y1: 1.46, segments: 6, part: PART_CROWN }),
  ]);
}
