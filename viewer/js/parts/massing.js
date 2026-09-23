/**
 * Elaborated massing for the four ordinary archetypes: tower, slab, warehouse
 * and ruin.
 *
 * These are the forms a district is made of, and the old versions were three to
 * five boxes each -- which is what made an aerial view of a thousand buildings
 * read as a spreadsheet rather than a city. The City Hall earned its presence
 * from a podium, an articulated shaft, a crown and a roofline; nothing about
 * that depth is specific to a landmark. It is just composed by hand here in
 * unit space instead of one building at a time in world space.
 *
 * The rules every builder below obeys:
 *
 * - Unit space, X and Z in [-0.5, 0.5], Y in [0, 1]; the per-instance matrix
 *   scales by (width, height, depth). Swapping the geometry is therefore still
 *   a pure rendering change -- the layout, the collision grid and the picking
 *   maths never learn about it.
 * - The BODY part is the real massing and spans y = 0 up to the archetype's
 *   height fraction (tower 0.74, slab 0.93, warehouse 0.76, ruin 0.54). It is
 *   the one part the vertex shader never moves, so it is where anything the
 *   data must keep meaning -- the height, the footprint, the floor slabs --
 *   belongs.
 * - PODIUM is the ground-level base, SETBACK and CROWN are the ornament the
 *   shader re-rolls per instance, FIXED is anything that must never move.
 * - Stacked ornament pins its *bottom* to the piece below, because the shader
 *   only ever displaces y as `y0 + span * t * k` (k >= 0.45): a bottom always
 *   stays where it was drawn, while a top can drop or lift. Every setback,
 *   crown and podium tier here is therefore seated against the minimum reach
 *   of the tier beneath it, so a district of shrunken silhouettes never shows a
 *   floating slab of roof.
 * - Nothing here paints windows: the facade shader paints every wall it is
 *   given, from the building's own numbers, and a window box would only fight
 *   it.
 *
 * Triangle budgets are hard -- a district may hold thousands of these -- so the
 * elaborate shapes are bought with boxes and low-segment cylinders, never with
 * high-segment primitives.
 */

import {
  PART_BODY,
  PART_CROWN,
  PART_FIXED,
  PART_PODIUM,
  PART_SETBACK,
  box,
  cylinder,
  gable,
  mergeParts,
  obelisk,
} from '../primitives.js';

/**
 * An office tower: an engaged colonnade under a canopy, a chamfered shaft with
 * a full-height pier expression, two setbacks and a crown that reads either as
 * a roof plant enclosure or, when the shader stretches it, as a spire base.
 *
 * The chamfers are the shaft itself, built as an eight-sided prism rotated half
 * a segment so a flat faces each world axis. That keeps the four walls that
 * face the street square-on to the facade shader -- windows still land in a
 * grid -- while the corners read as cut, which is the single cheapest way to
 * stop a tower being a rectangle.
 *
 * Rooftop clutter is placed on the BODY's deck, so the BODY still tops out at
 * exactly 0.74 and the terrace left by the first setback is real roof.
 */
export function towerGeometry(THREE) {
  const parts = [
    // The plot line, FIXED: the podium skirt below can shrink by 6% on the
    // shader's roll, and a 1.0 curb under it is what keeps the ground plane
    // filled to the edge the layout reserved, roll or no roll.
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.015, part: PART_FIXED }),

    // A ground apron the full footprint, then a wider canopy slab over a
    // recessed lobby. The body shaft fills the space between them, so the two
    // podium tiers can breathe apart without anything floating.
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.03, part: PART_PODIUM }),
    box(THREE, { w: 1.0, d: 1.0, y0: 0.03, y1: 0.075, part: PART_PODIUM }),

    // Chamfered shaft: across-flats 0.9, so the flats sit at 0.45 and the cut
    // corners pull the silhouette in from a hard square.
    cylinder(THREE, {
      rTop: 0.469,
      rBottom: 0.487,
      y0: 0,
      y1: 0.74,
      segments: 8,
      part: PART_BODY,
    }).rotateY(Math.PI / 8),

    // A thin cornice where the shaft meets its terrace, the line every real
    // tower carries there; it is FIXED because a cornice that drifted off its
    // shaft would read as a modelling error rather than as variety.
    cylinder(THREE, {
      rTop: 0.503,
      rBottom: 0.503,
      y0: 0.715,
      y1: 0.74,
      segments: 8,
      part: PART_FIXED,
    }).rotateY(Math.PI / 8),

    // Two setback tiers. The second is seated at 0.80, below the first tier's
    // lowest possible top (0.74 + 0.14 * 0.45 = 0.803), so the shrunken case
    // still overlaps instead of opening a slot of sky.
    box(THREE, { w: 0.6, d: 0.6, y0: 0.74, y1: 0.88, part: PART_SETBACK }),
    box(THREE, { w: 0.42, d: 0.42, y0: 0.8, y1: 0.96, part: PART_SETBACK }),

    // The crown: a tapered plant enclosure, or a spire base when the shader
    // lifts it. Its bottom sits low inside the first tier and well inside that
    // tier's narrowest plan, so on the roll that deletes it the collapsed
    // shell is buried in the parapet rather than hanging a storey in the air.
    obelisk(THREE, { rTop: 0.1, rBottom: 0.145, y0: 0.79, y1: 1.0, part: PART_CROWN }),
  ];

  // Engaged colonnade: eight piers standing on the apron, their tops embedded
  // in the canopy at every podium height the shader can choose.
  for (const [x, z] of [
    [0.44, 0.17], [0.44, -0.17], [-0.44, -0.17], [-0.44, 0.17],
    [0.17, 0.44], [-0.17, 0.44], [0.17, -0.44], [-0.17, -0.44],
  ]) {
    parts.push(box(THREE, { w: 0.06, d: 0.06, x, z, y0: 0, y1: 0.05, part: PART_PODIUM }));
  }

  // Vertical pier expression: three piers per wall on the four street-facing
  // flats, then one on each chamfer. Full height to the terrace, so the shaft
  // reads as fluted rather than extruded, and it is BODY because a pier is the
  // massing -- never the ornament.
  for (const [x, z, w, d] of [
    [0.47, -0.13, 0.06, 0.07], [0.47, 0, 0.06, 0.07], [0.47, 0.13, 0.06, 0.07],
    [-0.47, -0.13, 0.06, 0.07], [-0.47, 0, 0.06, 0.07], [-0.47, 0.13, 0.06, 0.07],
    [-0.13, 0.47, 0.07, 0.06], [0, 0.47, 0.07, 0.06], [0.13, 0.47, 0.07, 0.06],
    [-0.13, -0.47, 0.07, 0.06], [0, -0.47, 0.07, 0.06], [0.13, -0.47, 0.07, 0.06],
  ]) {
    parts.push(box(THREE, { w, d, x, z, y0: 0.05, y1: 0.74, part: PART_BODY }));
  }
  // The chamfer piers are the one place a rotation is safe -- their footprint
  // is a square, so a non-uniform instance scale stretches them along two axes
  // at once rather than shearing a silhouette. Rotating before the move (the
  // other order would swing the pier around the footprint centre and onto the
  // axis walls) puts each one across a cut corner, proud of the chamfer by 0.03.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(
        box(THREE, { w: 0.16, d: 0.08, y0: 0.05, y1: 0.74, part: PART_BODY })
          .rotateY(Math.PI / 4)
          .translate(sx * 0.311, 0, sz * 0.311)
      );
    }
  }

  return mergeParts(THREE, parts);
}

/**
 * A slab block: a taller base storey under a projecting cornice, a parapet lip
 * rather than a lid, and expressed vertical bays so the long roof edge is not
 * one extrusion.
 *
 * The base storey is BODY, not podium: a slab's ground floor being taller than
 * its office floors is the building's real shape, and the shader must not be
 * free to take it away. The podium slot is kept for the plinth and the entry
 * canopy, which are the parts that may vary.
 */
export function slabGeometry(THREE) {
  const parts = [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.025, part: PART_PODIUM }),

    // Base storey, wider than the shaft above it, so the cornice has something
    // to sit on and the ground floor reads as a storey and not a wall.
    box(THREE, { w: 0.98, d: 0.98, y0: 0, y1: 0.14, part: PART_BODY }),
    box(THREE, { w: 1.04, d: 1.04, y0: 0.125, y1: 0.15, part: PART_FIXED }),

    box(THREE, { w: 0.92, d: 0.92, y0: 0.13, y1: 0.93, part: PART_BODY }),

    // Parapet lip as four bars, not a lid: the deck stays open, the plant room
    // sits visibly in it, and the sun still catches the top edge.
    box(THREE, { w: 1.0, d: 0.06, z: 0.47, y0: 0.905, y1: 0.965, part: PART_FIXED }),
    box(THREE, { w: 1.0, d: 0.06, z: -0.47, y0: 0.905, y1: 0.965, part: PART_FIXED }),
    box(THREE, { w: 0.06, d: 0.88, x: 0.47, y0: 0.905, y1: 0.965, part: PART_FIXED }),
    box(THREE, { w: 0.06, d: 0.88, x: -0.47, y0: 0.905, y1: 0.965, part: PART_FIXED }),

    // Entry canopy, proud of the base storey on one face only -- a slab's
    // entrance is a place, and a place has a side.
    box(THREE, { w: 0.34, d: 0.1, z: 0.48, y0: 0.02, y1: 0.1, part: PART_FIXED }),

    // Rooftop plant room, offset to one side so the roof is never symmetrical.
    // Seated at 0.90, inside the shaft rather than on top of it, so the absent
    // roll buries it in the massing instead of leaving a lid over the deck --
    // and so even the widest roll of its plan stays inside the 0.92 shaft.
    box(THREE, {
      w: 0.36,
      d: 0.44,
      x: 0.16,
      z: -0.12,
      y0: 0.9,
      y1: 1.0,
      part: PART_CROWN,
    }),
  ];

  // Expressed vertical bays: five shallow piers per face, running from the
  // cornice to the parapet. They land on the shaft as BODY, because a bay
  // division is how the building is built, not a decoration on it.
  for (const offset of [-0.34, -0.17, 0, 0.17, 0.34]) {
    parts.push(
      box(THREE, { w: 0.05, d: 0.05, x: offset, z: 0.475, y0: 0.14, y1: 0.9, part: PART_BODY }),
      box(THREE, { w: 0.05, d: 0.05, x: offset, z: -0.475, y0: 0.14, y1: 0.9, part: PART_BODY }),
      box(THREE, { w: 0.05, d: 0.05, x: 0.475, z: offset, y0: 0.14, y1: 0.9, part: PART_BODY }),
      box(THREE, { w: 0.05, d: 0.05, x: -0.475, z: offset, y0: 0.14, y1: 0.9, part: PART_BODY })
    );
  }

  return mergeParts(THREE, parts);
}

/**
 * A shed: a pitched roof with a ridge cap, three roller doors under a loading
 * canopy on the dock side, a lean-to office, an external stair, roof vents and
 * a chimney.
 *
 * The roof is FIXED rather than setback or crown: a pitched roof *is* the
 * warehouse, and a per-instance re-roll that could flatten it would trade the
 * form's silhouette for variety it can get from its vents and chimney instead
 * (which are CROWN, and so are absent on some sheds).
 *
 * The body is held back to 0.88 so the lean-to can attach to its wall and still
 * reach the plot edge, and a FIXED curb under the podium slab keeps the ground
 * plane met to the reserved footprint whatever the podium roll does.
 */
export function warehouseGeometry(THREE) {
  const parts = [
    // The plot line, FIXED, for the same reason as the tower's curb: whatever
    // the podium roll does to the yard slab above, the ground is never short of
    // the reserved footprint.
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.02, part: PART_FIXED }),

    // The loading yard: the plinth the body, lean-to and stair all stand on.
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.03, part: PART_PODIUM }),

    box(THREE, { w: 0.88, d: 0.88, y0: 0, y1: 0.76, part: PART_BODY }),

    // Gable, ridged along X, eaves just past the body so the roof has a shadow
    // line of its own, and a ridge cap so the apex is a thing rather than an
    // intersection of two planes.
    gable(THREE, { w: 0.94, d: 0.94, y0: 0.74, y1: 1.0 }),
    box(THREE, { w: 0.8, d: 0.08, y0: 0.965, y1: 1.0, part: PART_FIXED }),

    // Loading dock: a raised sill, three roller doors standing proud of the
    // wall, and a canopy over the lot of them. The doors only read because the
    // sill buries their bottoms -- a dock door starts at lorry-bed height.
    box(THREE, { w: 0.62, d: 0.1, z: -0.48, y0: 0, y1: 0.2, part: PART_FIXED }),
    box(THREE, { w: 0.16, d: 0.03, x: -0.24, z: -0.45, y0: 0.03, y1: 0.42, part: PART_FIXED }),
    box(THREE, { w: 0.16, d: 0.03, x: 0, z: -0.45, y0: 0.03, y1: 0.42, part: PART_FIXED }),
    box(THREE, { w: 0.16, d: 0.03, x: 0.24, z: -0.45, y0: 0.03, y1: 0.42, part: PART_FIXED }),
    box(THREE, { w: 0.8, d: 0.1, z: -0.52, y0: 0.47, y1: 0.51, part: PART_FIXED }),

    // Lean-to office: a low annex against one wall with its own roof slab. It
    // stands in the margin between the 0.88 body and the yard edge, so it is
    // an attachment rather than a bulge that would overlap a neighbour.
    box(THREE, { w: 0.12, d: 0.46, x: 0.44, z: -0.24, y0: 0.02, y1: 0.36, part: PART_FIXED }),
    box(THREE, { w: 0.16, d: 0.5, x: 0.43, z: -0.24, y0: 0.34, y1: 0.375, part: PART_FIXED }),

    // Chimney: one stack, seated at 0.76 so it starts inside the roof prism
    // and so the deleted roll hides it there instead of leaving a floating cap.
    // It stops at the ridge line, since 1.0 is the height the data declared;
    // the crown's own lift is what may carry it past that.
    box(THREE, { w: 0.12, d: 0.12, x: -0.3, z: 0.2, y0: 0.76, y1: 1.0, part: PART_CROWN }),
  ];

  // External stair up the far wall: solid blocks climbing in step, so it reads
  // as a stair from the side even at a distance, where a thin stringer would
  // not. It is FIXED: access is part of the shed, not an ornament the shader
  // may re-roll away.
  for (let i = 0; i < 5; i += 1) {
    parts.push(
      box(THREE, {
        w: 0.09,
        d: 0.16,
        x: -0.46,
        z: -0.3 + i * 0.13,
        y0: 0.02,
        y1: 0.06 + i * 0.07,
        part: PART_FIXED,
      })
    );
  }

  // Roof vents: CROWN, so a district of sheds has some roofs vented and some
  // bare. Each is seated at 0.76 -- under the roof surface even where the
  // widest roll of its own plan pushes it out toward the eave -- so the
  // vanished case hides inside the prism, never as a disc lying on the slope.
  for (const [x, z, y1] of [[0.2, 0.28, 0.95], [-0.22, -0.28, 0.95], [0.05, 0.3, 0.93]]) {
    parts.push(
      cylinder(THREE, {
        rTop: 0.04,
        rBottom: 0.05,
        x,
        z,
        y0: 0.76,
        y1,
        segments: 6,
        part: PART_CROWN,
      })
    );
  }

  return mergeParts(THREE, parts);
}

/**
 * A ruin: broken perimeter walls at four different heights, two exposed floor
 * slabs, a window void you can see through, a surviving core and corner column,
 * a fallen column and rubble.
 *
 * The massing is hollow on purpose. A ruin that is still a solid box reads as
 * an unfinished shed; the shell is what lets you see the floor slabs through
 * the missing roof, and the window void through to the far wall. Each wall is
 * its own closed box, so every surface facing the camera -- outside or inside
 * the shell -- is a front face and nothing disappears.
 *
 * The tall surviving fragment is SETBACK, keeping the archetype's promise that
 * no two ruins present the same broken edge, while the corner column, the
 * rubble and the fallen column are FIXED: the parts of a ruin that have already
 * stopped moving.
 */
export function ruinGeometry(THREE) {
  const parts = [
    // West wall, the tallest survivor, opened by a window void between its
    // piers at y 0.20-0.40. Four boxes make the hole; a real opening is worth
    // far more than any amount of rubble.
    box(THREE, { w: 0.1, d: 0.9, x: -0.45, y0: 0, y1: 0.2, part: PART_BODY }),
    box(THREE, { w: 0.1, d: 0.9, x: -0.45, y0: 0.4, y1: 0.54, part: PART_BODY }),
    box(THREE, { w: 0.1, d: 0.29, x: -0.45, z: 0.305, y0: 0.2, y1: 0.4, part: PART_BODY }),
    box(THREE, { w: 0.1, d: 0.26, x: -0.45, z: -0.32, y0: 0.2, y1: 0.4, part: PART_BODY }),

    // The other three walls, each broken at its own height so the silhouette
    // never presents a level edge. The north wall is two heights, split where
    // the collapse took the corner.
    box(THREE, { w: 0.5, d: 0.1, x: -0.2, z: -0.45, y0: 0, y1: 0.34, part: PART_BODY }),
    box(THREE, { w: 0.4, d: 0.1, x: 0.25, z: -0.45, y0: 0, y1: 0.22, part: PART_BODY }),
    box(THREE, { w: 0.1, d: 0.9, x: 0.45, y0: 0, y1: 0.46, part: PART_BODY }),
    box(THREE, { w: 0.9, d: 0.1, z: 0.45, y0: 0, y1: 0.18, part: PART_BODY }),

    // Exposed floor slabs, overlapping the walls so no gap opens at an edge.
    box(THREE, { w: 0.86, d: 0.86, y0: 0.16, y1: 0.2, part: PART_BODY }),
    box(THREE, { w: 0.86, d: 0.86, y0: 0.34, y1: 0.38, part: PART_BODY }),

    // The surviving core, rising from the ground so it is always supported, and
    // scaling about its own centre so the shader can never slide it out over
    // the empty shell. It carries the height the ruin was drawn at, so the
    // shrunken roll reads as more of the building gone rather than as a shorter
    // building -- the same job the old free-standing stub did.
    box(THREE, { w: 0.34, d: 0.34, y0: 0, y1: 0.94, part: PART_SETBACK }),

    // The surviving corner column: plinth, shaft, broken capital. Proud of the
    // corner so it is legible as a column rather than as wall thickness.
    box(THREE, { w: 0.16, d: 0.16, x: -0.45, z: -0.45, y0: 0, y1: 0.05, part: PART_FIXED }),
    box(THREE, { w: 0.13, d: 0.13, x: -0.45, z: -0.45, y0: 0.04, y1: 0.58, part: PART_FIXED }),
    box(THREE, { w: 0.19, d: 0.19, x: -0.45, z: -0.45, y0: 0.54, y1: 0.62, part: PART_FIXED }),

    // A jagged fragment still clinging to the west wall's break line.
    box(THREE, { w: 0.24, d: 0.12, x: -0.38, z: 0.05, y0: 0.5, y1: 0.68, part: PART_FIXED }),

    // Rubble at the base and on the ground floor, varied in size so it reads
    // as debris rather than as pavement.
    box(THREE, { w: 0.1, d: 0.12, x: 0.3, z: 0.36, y0: 0, y1: 0.06, part: PART_FIXED }),
    box(THREE, { w: 0.14, d: 0.08, x: 0.38, z: 0.2, y0: 0, y1: 0.05, part: PART_FIXED }),
    box(THREE, { w: 0.07, d: 0.09, x: -0.12, z: 0.42, y0: 0, y1: 0.04, part: PART_FIXED }),
    box(THREE, { w: 0.09, d: 0.07, x: 0.42, z: -0.3, y0: 0, y1: 0.04, part: PART_FIXED }),
    box(THREE, { w: 0.12, d: 0.1, x: 0.1, z: 0.3, y0: 0, y1: 0.03, part: PART_FIXED }),
    box(THREE, { w: 0.06, d: 0.06, x: 0.24, z: 0.42, y0: 0, y1: 0.05, part: PART_FIXED }),

    // A fallen column lying across the ground floor, which is why the west
    // wall's window void is worth having: the two details are seen together.
    cylinder(THREE, {
      rTop: 0.05,
      rBottom: 0.05,
      y0: 0,
      y1: 0.36,
      segments: 6,
      part: PART_FIXED,
    })
      .rotateZ(Math.PI / 2)
      .translate(0.15, 0.05, -0.24),
  ];

  return mergeParts(THREE, parts);
}
