/**
 * Construction-scene props: the tower crane, the scaffolding a new building
 * wears, and the rooftop plant clutter.
 *
 * These three are the silhouettes in the viewer that are *equipment* rather than
 * architecture, and at the construction depth of the City Hall landmark a tube
 * with a crossbar stops reading as a crane. Each builder here composes the same
 * primitives `shapes.js` uses into something with a lattice, a coupler and a fan
 * cowl -- the bar `parts/beacons.js` sets for a rooftop fixture, applied to the
 * three props that surround a building under construction.
 *
 * Unit spaces differ per prop, and the difference is the caller's contract:
 *
 *   craneGeometry        y 0..~1.46, mast at x/z ~ 0, jib reaching +x. The
 *                        caller scales it by its own (spread, spread*2.2,
 *                        spread) and yaws it per instance, so it must read from
 *                        every direction.
 *   scaffoldingGeometry  the *building's* unit box exactly -- X/Z in [-0.5, 0.5],
 *                        Y in [0, 1] -- because it is scaled by the building's
 *                        own instance matrix, not a separate prop scale.
 *   roofPropGeometry     unit space, y in [0, 1], four pieces whose part tags
 *                        are a contract with `facade.js::patchRoofProps`.
 */

import {
  PART_BODY,
  PART_CROWN,
  PART_FIXED,
  PART_PODIUM,
  PART_SETBACK,
  box,
  cylinder,
  mergeParts,
  obelisk,
  tag,
} from '../primitives.js';

/**
 * A thin box stretched between two arbitrary points, for lattice members.
 *
 * `box()` and `cylinder()` can only translate, and a crane mast or a scaffold
 * face is mostly diagonals -- a member that leans is the entire reason a frame
 * reads as a frame. Built as a box along X and rotated onto the chord it spans,
 * so it stays one primitive and twelve triangles like any other strut. The tag
 * records the chord's true vertical extent for the massing shader.
 */
function strut(THREE, { from, to, w = 0.012, part = PART_FIXED }) {
  const a = new THREE.Vector3(from[0], from[1], from[2]);
  const b = new THREE.Vector3(to[0], to[1], to[2]);
  const span = b.clone().sub(a);
  const length = span.length() || 1e-4;
  const geometry = new THREE.BoxGeometry(length, w, w);
  geometry.applyQuaternion(
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), span.normalize())
  );
  geometry.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return tag(geometry, part, Math.min(a.y, b.y), Math.max(a.y, b.y));
}

/**
 * A tower crane, ~648 triangles, merged into a single geometry.
 *
 * The old crane was one tube with a boom box, correct at skyline distance and a
 * flagpole from the plaza. Everything here is the machine a real crane is: a
 * four-chord lattice mast with rungs and face bracing, a slewing ring the upper
 * works pivot on, a glazed operator cab, a jib built as a triangular truss with
 * a trolley running the hoist rope, a counter-jib with its counterweight, a
 * mast-top apex with pendant tie bars, a hook block, and a warning-light
 * housing at the top.
 *
 * The part tags mirror the tags this geometry always carried -- BODY for the
 * mast, SETBACK for the jib, CROWN for the counter-jib, PODIUM for the cab,
 * FIXED for the rigging -- so the props keep sharing the massing path.
 */
export function craneGeometry(THREE) {
  const half = 0.055;
  const chord = 0.018;
  const mastTop = 1.29;
  const levels = [0, 0.43, 0.86, mastTop];
  const parts = [];

  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      parts.push(box(THREE, { w: chord, d: chord, x, z, y0: 0, y1: mastTop, part: PART_BODY }));
    }
  }
  for (const y of levels) {
    // A rung on each face, so the mast still reads as a cage edge-on to any two
    // of its four sides rather than as four loose posts.
    parts.push(
      box(THREE, {
        w: 2 * half + chord, d: chord, x: 0, z: -half, y0: y, y1: y + 0.02, part: PART_BODY,
      }),
      box(THREE, {
        w: 2 * half + chord, d: chord, x: 0, z: half, y0: y, y1: y + 0.02, part: PART_BODY,
      }),
      box(THREE, {
        w: chord, d: 2 * half + chord, x: -half, z: 0, y0: y, y1: y + 0.02, part: PART_BODY,
      }),
      box(THREE, {
        w: chord, d: 2 * half + chord, x: half, z: 0, y0: y, y1: y + 0.02, part: PART_BODY,
      })
    );
  }
  // One diagonal per panel, worked around the four faces in turn: every side
  // gets bracing without the triangle cost of double-lacing the whole mast.
  const faceCorners = [
    [-half, -half, half, -half],
    [half, -half, half, half],
    [half, half, -half, half],
    [-half, half, -half, -half],
  ];
  for (let panel = 0; panel < levels.length - 1; panel += 1) {
    for (let f = 0; f < 2; f += 1) {
      const [x0, z0, x1, z1] = faceCorners[(panel * 2 + f) % 4];
      // Alternate which end starts low so the bracing zig-zags rather than all
      // leaning the same way, which is what stops it reading as a solid plate.
      const rise = panel % 2 === 0;
      parts.push(strut(THREE, {
        from: [x0, rise ? levels[panel] : levels[panel + 1], z0],
        to: [x1, rise ? levels[panel + 1] : levels[panel], z1],
        w: 0.01,
        part: PART_BODY,
      }));
    }
  }

  // A slewing ring under the upper works: the jib, counter-jib and cab all
  // pivot on this one bearing, so without it they look welded to the mast.
  parts.push(cylinder(THREE, {
    rTop: 0.085, rBottom: 0.085, y0: mastTop, y1: 1.35, segments: 8, part: PART_BODY,
  }));

  // The operator cab, hung off the slewing unit on the jib side with a glass
  // band, because a box on a crane that is not glazed is not a cab.
  parts.push(
    box(THREE, { w: 0.13, d: 0.12, x: 0.11, z: 0.06, y0: 1.16, y1: 1.31, part: PART_PODIUM }),
    box(THREE, { w: 0.012, d: 0.09, x: 0.178, z: 0.06, y0: 1.19, y1: 1.28, part: PART_FIXED })
  );

  const jibY = 1.31;
  const jibTop = 1.4;
  const jibX0 = 0.06;
  const jibX1 = 0.95;
  const jibMid = (jibX0 + jibX1) / 2;
  // The jib: two bottom chords, one top chord and a web of diagonals between
  // them -- the triangular truss a real jib is, rather than a flat box, which
  // is also why it stays legible when the instance is yawed edge-on.
  parts.push(
    box(THREE, {
      w: jibX1 - jibX0, d: 0.014, x: jibMid, z: -0.028, y0: jibY, y1: jibY + 0.016,
      part: PART_SETBACK,
    }),
    box(THREE, {
      w: jibX1 - jibX0, d: 0.014, x: jibMid, z: 0.028, y0: jibY, y1: jibY + 0.016,
      part: PART_SETBACK,
    }),
    box(THREE, {
      w: jibX1 - jibX0, d: 0.016, x: jibMid, z: 0, y0: jibTop - 0.016, y1: jibTop,
      part: PART_SETBACK,
    })
  );
  const jibBays = 3;
  const jibBay = (jibX1 - jibX0) / jibBays;
  for (let i = 0; i < jibBays; i += 1) {
    const xa = jibX0 + i * jibBay;
    const xb = xa + jibBay;
    const lowZ = i % 2 === 0 ? -0.028 : 0.028;
    parts.push(
      strut(THREE, {
        from: [xa, jibY + 0.01, lowZ], to: [xb, jibTop - 0.01, 0], w: 0.009, part: PART_SETBACK,
      }),
      strut(THREE, {
        from: [xa, jibTop - 0.01, 0], to: [xb, jibY + 0.01, -lowZ], w: 0.009, part: PART_SETBACK,
      })
    );
  }

  // The counter-jib carries the counterweight that balances the load, so both
  // the short truss and the block at its tip are working parts, not trim. The
  // block stops short of the roof so it never looks like it rests on it.
  const cjX0 = -0.06;
  const cjX1 = -0.42;
  const cjMid = (cjX0 + cjX1) / 2;
  parts.push(
    box(THREE, {
      w: cjX0 - cjX1, d: 0.014, x: cjMid, z: -0.026, y0: jibY, y1: jibY + 0.016,
      part: PART_CROWN,
    }),
    box(THREE, {
      w: cjX0 - cjX1, d: 0.014, x: cjMid, z: 0.026, y0: jibY, y1: jibY + 0.016,
      part: PART_CROWN,
    }),
    box(THREE, {
      w: cjX0 - cjX1, d: 0.016, x: cjMid, z: 0, y0: jibTop - 0.016, y1: jibTop,
      part: PART_CROWN,
    }),
    box(THREE, { w: 0.13, d: 0.17, x: -0.35, z: 0, y0: 1.23, y1: 1.39, part: PART_CROWN }),
    strut(THREE, {
      from: [cjX0, jibY + 0.01, -0.026], to: [cjX1, jibTop - 0.01, 0],
      w: 0.009, part: PART_CROWN,
    }),
    strut(THREE, {
      from: [cjX0, jibTop - 0.01, 0], to: [cjX1, jibY + 0.01, 0.026],
      w: 0.009, part: PART_CROWN,
    })
  );

  // A mast-top apex, with the pendant tie bars running back from its head to
  // hold the jib up. Without the apex the jib looks cantilevered out of the
  // mast, which is the one thing a jib never is.
  parts.push(
    obelisk(THREE, { rTop: 0.018, rBottom: 0.05, y0: 1.35, y1: 1.44, part: PART_FIXED }),
    strut(THREE, { from: [0, 1.43, 0], to: [0.9, jibTop - 0.01, 0], w: 0.009, part: PART_FIXED }),
    strut(THREE, { from: [0, 1.43, 0], to: [-0.4, jibTop - 0.01, 0], w: 0.009, part: PART_FIXED })
  );

  // The trolley rides the jib with the hoist rope down to the hook block: the
  // working end of the machine, and the detail that says "crane" rather than
  // "antenna with a crossbar". The rope stops short of the roof.
  parts.push(
    box(THREE, {
      w: 0.05, d: 0.05, x: 0.62, z: 0, y0: jibY - 0.03, y1: jibY + 0.02, part: PART_FIXED,
    }),
    box(THREE, { w: 0.008, d: 0.008, x: 0.62, z: 0, y0: 0.86, y1: jibY - 0.03, part: PART_FIXED }),
    box(THREE, { w: 0.05, d: 0.03, x: 0.62, z: 0, y0: 0.8, y1: 0.86, part: PART_FIXED })
  );

  // A warning-light housing at the very top, the real-world detail that makes a
  // tower crane legible against a night sky.
  parts.push(cylinder(THREE, {
    rTop: 0.012, rBottom: 0.032, x: 0, z: 0, y0: 1.42, y1: 1.46, segments: 6, part: PART_CROWN,
  }));

  return mergeParts(THREE, parts);
}

/**
 * Scaffolding, ~800 triangles, wrapping a building's own unit box.
 *
 * This one is different from every other prop: the caller scales it by the
 * *building's* instance matrix, so the unit box is not a hint, it is the
 * building. Every offset below is therefore chosen so its outermost surface
 * stays inside 0.5 of the centre line, and the arithmetic is stated beside each
 * group rather than left to the eye:
 *
 *   rim = 0.47 is the standard centres. A 0.016 tube reaches 0.486; a base
 *   plate half-width of 0.025 reaches 0.495; a coupler half-width of 0.013
 *   reaches 0.483; a ledger or toe board reaches 0.485; a face strut's 0.006
 *   half-width reaches 0.476. Nothing exceeds 0.5. Vertically, the standards
 *   and the toe boards top out at exactly y = 1 and nothing dips below 0.
 *
 * The old frame was four poles and three rings -- a fence. This adds base
 * plates, couplers, ledgers at five lifts, diagonal face braces, a toe board
 * around the top lift, an access stair on one side, and thin netting panels the
 * caller's transparent material can veil. All PART_FIXED: a scaffold is placed
 * by the building's matrix, not the massing shader, so nothing here may move.
 */
export function scaffoldingGeometry(THREE) {
  const rim = 0.47;
  const tube = 0.016;
  const span = 2 * rim + tube;
  const corners = [[-rim, -rim], [rim, -rim], [rim, rim], [-rim, rim]];
  const parts = [];

  // Standards, on base plates so the frame stands on the deck rather than
  // hovering: plate half-width 0.025 at 0.47 = 0.495, and a 1/64 plate height
  // so its underside lands on exactly y = 0 rather than a float hair below it.
  for (const [x, z] of corners) {
    parts.push(
      cylinder(THREE, {
        rTop: tube, rBottom: tube, x, z, y0: 0, y1: 1, segments: 5, part: PART_FIXED,
      }),
      box(THREE, { w: 0.05, d: 0.05, x, z, y0: 0, y1: 0.015625, part: PART_FIXED })
    );
  }

  // Ledgers at five lifts rather than three: a lift is one working level, and
  // the extra two are what stop the frame reading as a fence. Front and back
  // rails have half-depth 0.012 at z = +/-0.47, so 0.482.
  const lifts = [0.16, 0.36, 0.56, 0.76, 0.96];
  for (const y of lifts) {
    parts.push(
      box(THREE, { w: span, d: 0.024, x: 0, z: -rim, y0: y, y1: y + 0.02, part: PART_FIXED }),
      box(THREE, { w: span, d: 0.024, x: 0, z: rim, y0: y, y1: y + 0.02, part: PART_FIXED }),
      box(THREE, { w: 0.024, d: span, x: -rim, z: 0, y0: y, y1: y + 0.02, part: PART_FIXED }),
      box(THREE, { w: 0.024, d: span, x: rim, z: 0, y0: y, y1: y + 0.02, part: PART_FIXED })
    );
  }

  // Couplers: the clamp that actually holds a ledger to a standard, modelled as
  // a slightly fatter collar at the joint. Half-width 0.013 at 0.47 = 0.483.
  for (const y of [0.36, 0.76, 0.96]) {
    for (const [x, z] of corners) {
      parts.push(box(THREE, {
        w: 0.026, d: 0.026, x, z, y0: y - 0.013, y1: y + 0.013, part: PART_FIXED,
      }));
    }
  }

  // A toe board around the top lift: the low rail that keeps a tool from
  // rolling off the deck. Half the widened span is 0.485, depth 0.028 at 0.47
  // is 0.484, and it tops out at exactly y = 1.
  const board = span + 0.03;
  parts.push(
    box(THREE, { w: board, d: 0.028, x: 0, z: -rim, y0: 0.9, y1: 1.0, part: PART_FIXED }),
    box(THREE, { w: board, d: 0.028, x: 0, z: rim, y0: 0.9, y1: 1.0, part: PART_FIXED }),
    box(THREE, { w: 0.028, d: board, x: -rim, z: 0, y0: 0.9, y1: 1.0, part: PART_FIXED }),
    box(THREE, { w: 0.028, d: board, x: rim, z: 0, y0: 0.9, y1: 1.0, part: PART_FIXED })
  );

  // Face braces: an X on each of the four faces between the base and the top
  // lift. Endpoints sit at the 0.47 corners; a strut's 0.006 half-width takes
  // the outermost point to 0.476.
  const braceTop = lifts[lifts.length - 1];
  for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0]]) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[j];
    parts.push(
      strut(THREE, { from: [x0, 0.05, z0], to: [x1, braceTop, z1], w: 0.012, part: PART_FIXED }),
      strut(THREE, { from: [x1, 0.05, z1], to: [x0, braceTop, z0], w: 0.012, part: PART_FIXED })
    );
  }

  // An access stair inside the +Z face: five treads on two stringers up to a
  // landing, because a scaffold nobody can climb is just a fence. Treads run
  // along X at z = 0.32 with a 0.3 walk width, so the deepest point is 0.47.
  for (let i = 0; i < 5; i += 1) {
    parts.push(box(THREE, {
      w: 0.09, d: 0.3, x: -0.2 + i * 0.1, z: 0.32,
      y0: 0.06 + i * 0.13, y1: 0.09 + i * 0.13, part: PART_FIXED,
    }));
  }
  parts.push(
    strut(THREE, { from: [-0.25, 0.04, 0.18], to: [0.25, 0.71, 0.18], w: 0.012, part: PART_FIXED }),
    strut(THREE, { from: [-0.25, 0.04, 0.46], to: [0.25, 0.71, 0.46], w: 0.012, part: PART_FIXED }),
    box(THREE, { w: 0.16, d: 0.3, x: 0.18, z: 0.32, y0: 0.71, y1: 0.74, part: PART_FIXED })
  );

  // Netting panels: four very thin boxes just inside the standards, so the
  // caller's transparent material can veil the frame without the panels poking
  // through it. 0.455 plus a 0.003 half-thickness = 0.458.
  const net = 0.455;
  parts.push(
    box(THREE, { w: 0.9, d: 0.006, x: 0, z: -net, y0: 0.04, y1: 0.96, part: PART_FIXED }),
    box(THREE, { w: 0.9, d: 0.006, x: 0, z: net, y0: 0.04, y1: 0.96, part: PART_FIXED }),
    box(THREE, { w: 0.006, d: 0.9, x: -net, z: 0, y0: 0.04, y1: 0.96, part: PART_FIXED }),
    box(THREE, { w: 0.006, d: 0.9, x: net, z: 0, y0: 0.04, y1: 0.96, part: PART_FIXED })
  );

  return mergeParts(THREE, parts);
}

/**
 * Rooftop plant clutter, ~448 triangles, in unit space with y in [0, 1].
 *
 * The part tags are a contract, not decoration: `facade.js::patchRoofProps`
 * reads them in the vertex shader to decide which piece of the cluster a given
 * building gets, so the four pieces keep exactly the tags they always had --
 *
 *   piece 1  PART_BODY     the plant room, never displaced
 *   piece 2  PART_SETBACK  the water tank on its steel frame
 *   piece 3  PART_CROWN    the vent stack with a rain cap
 *   piece 4  PART_PODIUM   the HVAC condenser with a fan cowl
 *
 * Each piece is now several primitives, so the helpers below re-tag every
 * sub-part with the *piece's* tag and vertical span rather than its own. The
 * shader scales a piece about its own base, so a tank that carried its legs'
 * span would come apart from them on any building whose seed nudges it.
 */
export function roofPropGeometry(THREE) {
  const plant = (geometry) => tag(geometry, PART_BODY, 0, 0.55);
  const tank = (geometry) => tag(geometry, PART_SETBACK, 0, 0.8);
  const stack = (geometry) => tag(geometry, PART_CROWN, 0, 1);
  const hvac = (geometry) => tag(geometry, PART_PODIUM, 0, 0.3);

  return mergeParts(THREE, [
    // 1. Plant room: a windowless utility block with a recessed door and a
    //    louvred intake, roofed by a slab that overhangs a little.
    plant(box(THREE, { w: 0.34, d: 0.28, x: -0.16, z: 0.12, y0: 0, y1: 0.52 })),
    plant(box(THREE, { w: 0.37, d: 0.31, x: -0.16, z: 0.12, y0: 0.52, y1: 0.55 })),
    plant(box(THREE, { w: 0.09, d: 0.016, x: -0.16, z: -0.028, y0: 0.02, y1: 0.26 })),
    ...[0.3, 0.36, 0.42].map((y) =>
      plant(box(THREE, { w: 0.012, d: 0.16, x: 0.014, z: 0.12, y0: y, y1: y + 0.025 }))
    ),

    // 2. Water tank: a cylindrical tank under a conical lid, standing on four
    //    legs and a ring beam so it is plant, not a bollard.
    ...[[-0.07, -0.07], [0.07, -0.07], [-0.07, 0.07], [0.07, 0.07]].map(([dx, dz]) =>
      tank(box(THREE, {
        w: 0.016, d: 0.016, x: 0.18 + dx, z: -0.1 + dz, y0: 0, y1: 0.22,
      }))
    ),
    tank(box(THREE, { w: 0.2, d: 0.2, x: 0.18, z: -0.1, y0: 0.2, y1: 0.23 })),
    tank(cylinder(THREE, {
      rTop: 0.11, rBottom: 0.11, x: 0.18, z: -0.1, y0: 0.23, y1: 0.62, segments: 10,
    })),
    tank(cylinder(THREE, {
      rTop: 0.015, rBottom: 0.115, x: 0.18, z: -0.1, y0: 0.62, y1: 0.72, segments: 10,
    })),
    tank(cylinder(THREE, {
      rTop: 0.022, rBottom: 0.022, x: 0.18, z: -0.1, y0: 0.72, y1: 0.76, segments: 6,
    })),

    // 3. Vent stack: a tall pipe on a flanged base with two pipe collars,
    //    topped by a conical rain cap on a short stem.
    stack(cylinder(THREE, {
      rTop: 0.03, rBottom: 0.036, x: 0.02, z: 0.3, y0: 0, y1: 0.9, segments: 8,
    })),
    stack(box(THREE, { w: 0.1, d: 0.1, x: 0.02, z: 0.3, y0: 0, y1: 0.03 })),
    ...[0.45, 0.7].map((y) =>
      stack(box(THREE, { w: 0.09, d: 0.09, x: 0.02, z: 0.3, y0: y, y1: y + 0.02 }))
    ),
    stack(cylinder(THREE, {
      rTop: 0.001, rBottom: 0.06, x: 0.02, z: 0.3, y0: 0.9, y1: 0.96, segments: 8,
    })),
    stack(box(THREE, { w: 0.02, d: 0.02, x: 0.02, z: 0.3, y0: 0.9, y1: 0.93 })),

    // 4. HVAC condenser: a cased unit on a curb, with a fan cowl and hub on
    //    top and two refrigerant pipes running down its side.
    hvac(box(THREE, { w: 0.26, d: 0.22, x: 0.26, z: 0.24, y0: 0, y1: 0.03 })),
    hvac(box(THREE, { w: 0.24, d: 0.2, x: 0.26, z: 0.24, y0: 0.03, y1: 0.24 })),
    hvac(cylinder(THREE, {
      rTop: 0.06, rBottom: 0.072, x: 0.26, z: 0.24, y0: 0.24, y1: 0.3, segments: 10,
    })),
    hvac(box(THREE, { w: 0.03, d: 0.03, x: 0.26, z: 0.24, y0: 0.28, y1: 0.3 })),
    hvac(box(THREE, { w: 0.014, d: 0.16, x: 0.386, z: 0.24, y0: 0.08, y1: 0.1 })),
    hvac(box(THREE, { w: 0.014, d: 0.16, x: 0.386, z: 0.24, y0: 0.14, y1: 0.16 })),
  ]);
}
