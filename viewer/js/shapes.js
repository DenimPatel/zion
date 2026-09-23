/**
 * Archetype massing: one unit-normalised geometry per building form.
 *
 * Every shape here lives in the same box the old `BoxGeometry(1,1,1)` did --
 * X and Z in [-0.5, 0.5], Y in [0, 1] -- so the instance matrix that places a
 * building is unchanged: scale by (width, height, depth), translate to the
 * footprint centre. Swapping the geometry is therefore a pure rendering change
 * and the layout, the collision grid and the picking maths never learn about it.
 *
 * The primitives these are built from live in `primitives.js`, and the larger
 * assemblies live beside this file under `parts/` -- civic landmarks, the
 * construction props and the park. This module is the registry that names them
 * and the place the two forms small enough to write inline are written.
 */

import { PART_BODY, box, mergeParts } from './primitives.js';
import { monumentGeometry, siloGeometry, townHallGeometry } from './parts/civic.js';
import { parkGeometry } from './parts/parks.js';
import { ruinGeometry, slabGeometry, towerGeometry, warehouseGeometry } from './parts/massing.js';

export {
  PART_BODY,
  PART_CROWN,
  PART_FIXED,
  PART_PODIUM,
  PART_SETBACK,
  mergeParts,
} from './primitives.js';

// The assemblies that live in their own files. Re-exported here because
// `city.js` imports every prop geometry from this one module -- the caller does
// not care which file a shape was written in, only that it is unit-normalised
// and tagged.
export { antennaGeometry, soleTenantMarkerGeometry } from './parts/civic.js';
export { craneGeometry, roofPropGeometry, scaffoldingGeometry } from './parts/construction.js';

const BUILDERS = {
  // The four ordinary forms, the civic landmarks and the park all live in
  // `parts/` now -- each is an assembly long enough to deserve its own file,
  // with the City Hall landmark as the elaboration bar. This map is the only
  // place the viewer learns which file a form was written in; everything above
  // it (layout, collision, picking) still sees one unit-normalised geometry.
  tower: (THREE) => towerGeometry(THREE),
  slab: (THREE) => slabGeometry(THREE),
  warehouse: (THREE) => warehouseGeometry(THREE),
  silo: (THREE) => siloGeometry(THREE),
  monument: (THREE) => monumentGeometry(THREE),
  town_hall: (THREE) => townHallGeometry(THREE),
  park: (THREE) => parkGeometry(THREE),
  ruin: (THREE) => ruinGeometry(THREE),
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
