/**
 * Unit-space primitives shared by every geometry builder in the viewer.
 *
 * A building's massing, a rooftop beacon and a park tree are all assembled from
 * the same handful of shapes, so they live here rather than inside `shapes.js`.
 * Every builder composes tagged primitives with `mergeParts`, which concatenates
 * them into one non-indexed buffer while recording -- per vertex -- which *part*
 * of the assembly it belongs to (body, setback, crown, podium, fixed) and where
 * that part sits vertically. The vertex shader uses those three numbers to push
 * crowns, setbacks and podiums around per instance, which is how a hundred
 * buildings sharing one geometry still end up with a hundred rooflines. See
 * `facade.js`.
 *
 * Convention: geometry is unit-normalised -- X and Z in [-0.5, 0.5], Y in
 * [0, 1] for anything that will be scaled by a building's instance matrix. A
 * prop that carries its own scale (a crane, a beacon) may exceed that box as
 * long as its caller documents the scale it expects.
 */

// Part tags. BODY is never displaced -- it is the massing the footprint and
// height actually mean -- so per-instance variation can never contradict the
// data. Everything else is ornament and is free to move.
export const PART_BODY = 0;
export const PART_SETBACK = 1;
export const PART_CROWN = 2;
export const PART_PODIUM = 3;
export const PART_FIXED = 4;

export const TAU = Math.PI * 2;

/** Record which part a finished sub-geometry is, and where it sits vertically. */
export function tag(geometry, part, y0, y1) {
  geometry.userData.part = part;
  geometry.userData.y0 = y0;
  geometry.userData.y1 = y1;
  return geometry;
}

export function box(THREE, { w = 1, d = 1, y0 = 0, y1 = 1, x = 0, z = 0, part = PART_BODY }) {
  const geometry = new THREE.BoxGeometry(w, Math.max(1e-4, y1 - y0), d);
  geometry.translate(x, (y0 + y1) / 2, z);
  return tag(geometry, part, y0, y1);
}

export function cylinder(
  THREE,
  { rTop, rBottom, y0, y1, x = 0, z = 0, segments = 14, part = PART_BODY }
) {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, Math.max(1e-4, y1 - y0), segments);
  geometry.translate(x, (y0 + y1) / 2, z);
  return tag(geometry, part, y0, y1);
}

/** A four-sided tapered shaft, square-on to the world rather than diamond-on. */
export function obelisk(THREE, options) {
  const geometry = cylinder(THREE, { ...options, segments: 4 });
  geometry.rotateY(Math.PI / 4);
  return geometry;
}

export function dome(THREE, { radius, y0, height, x = 0, z = 0, part = PART_CROWN }) {
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
export function gable(THREE, { w, d, y0, y1, part = PART_FIXED }) {
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
 * A small triangular pennant, tapering away from the pole -- built by hand
 * (like `gable()` above) rather than a plane, so it reads as cloth rather
 * than as a signboard. Double-sided: a flag seen from behind should still
 * look like a flag, not vanish.
 */
export function pennant(THREE, { poleX = 0, y0, y1, length = 0.25, part = PART_CROWN }) {
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

/**
 * Concatenate tagged sub-geometries into one non-indexed buffer.
 *
 * Non-indexed costs some vertices but keeps the merge to three array copies and
 * lets each part carry flat per-vertex tags with no index remapping. The whole
 * city shares eight of these, so the size never matters.
 */
export function mergeParts(THREE, parts) {  const geometries = parts.map((g) => (g.index ? Object.assign(g.toNonIndexed(), { userData: g.userData }) : g));
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

/**
 * Flat-fill a sub-geometry's vertices with one colour, ready for a coloured
 * merge. The colour is a multiplier over whatever the instance colour already
 * is, not an absolute: a face is tinted *relative* to its archetype's colour, so
 * the legend's own colour still governs and an author tint still reaches it.
 */
export function paint(THREE, geometry, rgb) {
  const count = geometry.attributes.position.count;
  const color = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    color[i * 3] = rgb[0];
    color[i * 3 + 1] = rgb[1];
    color[i * 3 + 2] = rgb[2];
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  return geometry;
}

/**
 * `mergeParts`, plus a colour channel.
 *
 * A material can only carry one colour of its own, so this is how a single
 * instanced mesh paints several finishes -- a beacon's housing against its lens,
 * a town hall's stone against its roof -- without spending a draw call per
 * material. Every part must have been through `paint` first. The layout is
 * otherwise identical to `mergeParts`, including the packed (part, y0, y1)
 * massing tags and the disposal of the inputs.
 */
export function mergeColouredParts(THREE, parts) {
  const geometries = parts.map((part) =>
    part.index ? Object.assign(part.toNonIndexed(), { userData: part.userData }) : part
  );
  const total = geometries.reduce((sum, g) => sum + g.attributes.position.count, 0);

  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const massing = new Float32Array(total * 3);

  let offset = 0;
  for (const geometry of geometries) {
    const count = geometry.attributes.position.count;
    position.set(geometry.attributes.position.array, offset * 3);
    normal.set(geometry.attributes.normal.array, offset * 3);
    color.set(geometry.attributes.color.array, offset * 3);
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
  merged.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
  merged.setAttribute('aMassing', new THREE.BufferAttribute(massing, 3));
  merged.computeBoundingSphere();
  return merged;
}
