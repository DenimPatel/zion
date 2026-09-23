/**
 * Civic and landmark detail: the five forms a repository reads as public
 * buildings rather than as offices.
 *
 * A town hall, a grain silo, a monument, a downtown spire and a bus-factor
 * flag are the archetypes whose silhouette is doing all the talking -- an
 * office tower can be a box with a good wall shader, but a monument that is a
 * box is just a box. These builders spend the same kind of construction detail
 * the City Hall landmark spends on its own massing, at a fraction of the
 * triangle budget, so the few tiles the city means as civic actually read that
 * way from a street away.
 *
 * Every builder still lives in the unit box the massing primitives do: X and Z
 * in [-0.5, 0.5], Y in [0, 1], scaled per instance by (width, height, depth).
 * The PART_BODY fraction is the load-bearing number -- `WINDOWED` in `city.js`
 * gates the whole window pass on the archetype and the facade sizes its rows
 * from the body span -- so each body top is preserved exactly as `shapes.js`
 * had it: town halls stop at 0.6, silos and monuments at 0.86. Ornament rides
 * above that as PART_FIXED, PART_SETBACK or PART_CROWN and is free to move.
 *
 * The antenna is the one prop that exceeds the unit box (mast to y = 1.5):
 * its caller scales it by (spread, max(4, spread * 3), spread) and plants it
 * at a roofline, so its vertical extents are measured against that scale.
 */

import {
  PART_BODY,
  PART_CROWN,
  PART_FIXED,
  PART_PODIUM,
  PART_SETBACK,
  box,
  cylinder,
  dome,
  gable,
  mergeColouredParts,
  mergeParts,
  obelisk,
  paint,
  pennant,
  tag,
} from '../primitives.js';

export function townHallGeometry(THREE) {
  // Five finishes inside one material. The archetype's own gold -- the colour
  // the Keys panel shows -- stays the base, and each zone is a multiplier over
  // it, the way `createCityHall` separates its stone from its trim, its roof and
  // its glass. Without that separation a town hall was a single flat colour and
  // read as a gold office block, which is exactly what it must not read as.
  const STONE = [0.8, 0.77, 0.7];
  const TRIM = [1.0, 0.98, 0.92];
  const ROOF = [0.5, 0.38, 0.26];
  const GLASS = [0.15, 0.18, 0.24];
  const DARK = [0.26, 0.23, 0.2];
  const GOLD = [1.0, 0.9, 0.55];
  const stone = (g) => paint(THREE, g, STONE);
  const trim = (g) => paint(THREE, g, TRIM);
  const roof = (g) => paint(THREE, g, ROOF);
  const glass = (g) => paint(THREE, g, GLASS);
  const dark = (g) => paint(THREE, g, DARK);
  const gold = (g) => paint(THREE, g, GOLD);

  const parts = [];

  // The podium: the reserved footprint and its skirt.
  parts.push(
    stone(box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.05, part: PART_PODIUM })),
    trim(box(THREE, { w: 0.88, d: 0.88, y0: 0.04, y1: 0.12, part: PART_FIXED }))
  );

  // CRITICAL: the real massing with its top at y = 0.6. `WINDOWED` gates the
  // window pass on this archetype and the facade lays its rows out over the body
  // span, so this one number must not move.
  parts.push(stone(box(THREE, { w: 0.78, d: 0.78, y0: 0.12, y1: 0.6, part: PART_BODY })));

  // A broad flight up to the front, each tread climbing toward the massing, so
  // the entrance reads as approached rather than as a wall with a hole in it.
  // Kept PART_FIXED: a staircase that lifted off its own steps under the
  // per-instance displacement would be a bug, not silhouette variety.
  for (let i = 0; i < 3; i += 1) {
    const y0 = 0.05 + i * 0.024;
    parts.push(trim(box(THREE, {
      w: 0.9 - i * 0.06,
      d: 0.07,
      z: -0.465 + i * 0.028,
      y0,
      y1: y0 + 0.026,
      part: PART_FIXED,
    })));
  }

  // The colonnade: six shafts standing proud of the body's front wall, with the
  // depth of the portico carried by bases and capitals rather than implied by
  // one flat box. The shafts are the pieces the eye counts, so they are the ones
  // worth their triangles.
  for (let i = 0; i < 6; i += 1) {
    const x = (i - 2.5) * 0.132;
    parts.push(
      trim(cylinder(THREE, {
        rTop: 0.026, rBottom: 0.03, x, z: -0.42, y0: 0.15, y1: 0.58, segments: 6, part: PART_FIXED,
      })),
      trim(box(THREE, { w: 0.07, d: 0.07, x, z: -0.42, y0: 0.12, y1: 0.15, part: PART_FIXED })),
      trim(box(THREE, { w: 0.075, d: 0.075, x, z: -0.42, y0: 0.58, y1: 0.62, part: PART_FIXED }))
    );
  }

  // Flanks: pilasters to set the rhythm of the wall. The windows themselves are
  // left to the facade shader, which already lays its rows out over the body
  // span from the file's own floor count -- adding geometric openings on top of
  // that would fight the painted ones.
  for (const sx of [-1, 1]) {
    for (const z of [-0.24, 0, 0.24]) {
      parts.push(trim(box(THREE, {
        w: 0.03, d: 0.06, x: sx * 0.395, z, y0: 0.12, y1: 0.6, part: PART_FIXED,
      })));
    }
  }

  // Corner quoins: an alternating stack on each corner, the detail that makes a
  // masonry corner read as bonded rather than as two planes meeting.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      for (let i = 0; i < 3; i += 1) {
        const y0 = 0.14 + i * 0.146;
        parts.push(trim(box(THREE, {
          w: 0.05, d: 0.05, x: sx * 0.374, z: sz * 0.374, y0, y1: y0 + 0.062, part: PART_FIXED,
        })));
      }
    }
  }

  // Entablature: architrave, frieze and a cornice that overhangs -- the
  // horizontal band that ties the portico back into the massing.
  parts.push(
    trim(box(THREE, { w: 0.92, d: 0.84, y0: 0.62, y1: 0.66, part: PART_FIXED })),
    trim(box(THREE, { w: 0.88, d: 0.8, y0: 0.66, y1: 0.7, part: PART_FIXED })),
    trim(box(THREE, { w: 0.96, d: 0.9, y0: 0.7, y1: 0.74, part: PART_FIXED }))
  );

  // A balustrade around the roof: rail on all four sides, posts along the two
  // long ones. From above -- where the overview lives -- this is the line that
  // separates a civic roof from a flat top.
  parts.push(
    trim(box(THREE, { w: 0.9, d: 0.035, z: -0.42, y0: 0.76, y1: 0.8, part: PART_FIXED })),
    trim(box(THREE, { w: 0.9, d: 0.035, z: 0.42, y0: 0.76, y1: 0.8, part: PART_FIXED })),
    trim(box(THREE, { w: 0.035, d: 0.875, x: -0.43, y0: 0.76, y1: 0.8, part: PART_FIXED })),
    trim(box(THREE, { w: 0.035, d: 0.875, x: 0.43, y0: 0.76, y1: 0.8, part: PART_FIXED }))
  );
  for (const x of [-0.28, -0.09, 0.09, 0.28]) {
    parts.push(
      trim(box(THREE, { w: 0.04, d: 0.04, x, z: -0.42, y0: 0.74, y1: 0.8, part: PART_FIXED })),
      trim(box(THREE, { w: 0.04, d: 0.04, x, z: 0.42, y0: 0.74, y1: 0.8, part: PART_FIXED }))
    );
  }

  // A small gable over the entrance: the pediment that makes the door the door.
  // The roof itself stays flat so the lantern above has somewhere to stand.
  parts.push(trim(gable(THREE, { w: 0.6, d: 0.14, y0: 0.78, y1: 0.9, part: PART_FIXED })
    .translate(0, 0, -0.37)));
  // A clock in the pediment, the one detail every civic front of this kind has
  // and the reason a town hall is legible as a public building at a glance.
  parts.push(gold(
    cylinder(THREE, { rTop: 0.05, rBottom: 0.05, y0: -0.012, y1: 0.012, segments: 12 })
      .rotateX(Math.PI / 2)
      .translate(0, 0.84, -0.45)
  ));

  // The doorway, set back behind the columns on the body wall, with its own
  // little hood so the centre bay reads as an entrance.
  parts.push(
    dark(box(THREE, { w: 0.14, d: 0.02, z: -0.4, y0: 0.12, y1: 0.36, part: PART_FIXED })),
    roof(gable(THREE, { w: 0.18, d: 0.06, y0: 0.36, y1: 0.44, part: PART_FIXED }).translate(0, 0, -0.4))
  );

  // A columned lantern under a cornice and a dome: the cupola that gives the
  // silhouette its civic hat. SETBACK and CROWN, so the vertex shader may vary
  // its height the way it varies a tower's crown.
  parts.push(
    stone(box(THREE, { w: 0.28, d: 0.28, y0: 0.76, y1: 0.81, part: PART_SETBACK })),
    stone(cylinder(THREE, { rTop: 0.1, rBottom: 0.11, y0: 0.8, y1: 0.9, segments: 8, part: PART_SETBACK })),
    trim(cylinder(THREE, { rTop: 0.125, rBottom: 0.125, y0: 0.84, y1: 0.855, segments: 8, part: PART_FIXED })),
    trim(cylinder(THREE, { rTop: 0.14, rBottom: 0.14, y0: 0.895, y1: 0.915, segments: 8, part: PART_FIXED })),
    roof(dome(THREE, { radius: 0.105, y0: 0.91, height: 0.07, part: PART_CROWN })),
    gold(cylinder(THREE, { rTop: 0.001, rBottom: 0.01, y0: 0.975, y1: 1.0, segments: 4, part: PART_CROWN })),
    gold(tag(new THREE.SphereGeometry(0.014, 6, 4).translate(0, 0.978, 0), PART_CROWN, 0.964, 0.992))
  );

  return mergeColouredParts(THREE, parts);
}

export function siloGeometry(THREE) {
  // Banding ribs every few metres up the drum: the single detail that makes a
  // smooth cylinder read as a grain silo rather than as a tank. Twelve-sided
  // where the body is fourteen, so the ribs cannot z-fight with the drum.
  const ribs = [];
  for (const y of [0.16, 0.3, 0.44, 0.58, 0.72]) {
    ribs.push(cylinder(THREE, {
      rTop: 0.47,
      rBottom: 0.47,
      y0: y,
      y1: y + 0.02,
      segments: 12,
      part: PART_FIXED,
    }));
  }

  // A ladder up the flank with a caged top: the human-scale detail that says
  // this drum is climbed, not just looked at. Kept on +X, where the unit box
  // still has room; the cage hoops are open half-cylinders, so they wrap the
  // ladder's outboard side without dropping a solid ring through the drum.
  const ladder = [];
  for (const z of [-0.05, 0.05]) {
    ladder.push(box(THREE, {
      w: 0.018,
      d: 0.018,
      x: 0.44,
      z,
      y0: 0.06,
      y1: 0.8,
      part: PART_FIXED,
    }));
  }
  for (let i = 0; i < 7; i += 1) {
    ladder.push(box(THREE, {
      w: 0.02,
      d: 0.1,
      x: 0.44,
      y0: 0.1 + i * 0.1,
      y1: 0.112 + i * 0.1,
      part: PART_FIXED,
    }));
  }
  for (const y of [0.28, 0.44, 0.6, 0.74]) {
    ladder.push(tag(
      new THREE.CylinderGeometry(0.045, 0.045, 0.012, 6, 1, true, 0, Math.PI)
        .translate(0.44, y, 0),
      PART_FIXED,
      y - 0.006,
      y + 0.006
    ));
  }
  for (const z of [-0.045, 0.045]) {
    ladder.push(box(THREE, {
      w: 0.012,
      d: 0.012,
      x: 0.485,
      z,
      y0: 0.26,
      y1: 0.76,
      part: PART_FIXED,
    }));
  }

  // A catwalk and its railing near the top: the platform the cap is serviced
  // from, and the reason the drum's silhouette is not a plain cylinder.
  const catwalk = [
    cylinder(THREE, {
      rTop: 0.49,
      rBottom: 0.49,
      y0: 0.78,
      y1: 0.8,
      segments: 14,
      part: PART_FIXED,
    }),
    cylinder(THREE, {
      rTop: 0.48,
      rBottom: 0.48,
      y0: 0.89,
      y1: 0.91,
      segments: 14,
      part: PART_FIXED,
    }),
  ];
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    catwalk.push(box(THREE, {
      w: 0.02,
      d: 0.02,
      x: Math.cos(a) * 0.46,
      z: Math.sin(a) * 0.46,
      y0: 0.8,
      y1: 0.9,
      part: PART_FIXED,
    }));
  }

  return mergeParts(THREE, [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.05, part: PART_PODIUM }),
    // CRITICAL: the drum, with its top at y = 0.86 exactly as before.
    cylinder(THREE, { rTop: 0.44, rBottom: 0.46, y0: 0.03, y1: 0.86, part: PART_BODY }),
    ...ribs,
    // A shallow cone cap with an aeration vent at its crown, so the drum is
    // closed the way a real grain silo is rather than left open to the sky.
    cylinder(THREE, {
      rTop: 0.001,
      rBottom: 0.46,
      y0: 0.86,
      y1: 0.97,
      segments: 14,
      part: PART_CROWN,
    }),
    cylinder(THREE, {
      rTop: 0.03,
      rBottom: 0.035,
      y0: 0.96,
      y1: 1.0,
      segments: 6,
      part: PART_CROWN,
    }),
    ...catwalk,
    ...ladder,
  ]);
}

export function monumentGeometry(THREE) {
  // Three shallow steps, each a little narrower than the one below: a single
  // plinth reads as a base, three read as something deliberately built up to,
  // the way real monuments are.
  const steps = [
    box(THREE, { w: 1.0, d: 1.0, y0: 0, y1: 0.05, part: PART_PODIUM }),
    box(THREE, { w: 0.84, d: 0.84, y0: 0.045, y1: 0.09, part: PART_FIXED }),
    box(THREE, { w: 0.68, d: 0.68, y0: 0.085, y1: 0.13, part: PART_FIXED }),
  ];
  const base = [
    box(THREE, { w: 0.52, d: 0.52, y0: 0.125, y1: 0.21, part: PART_FIXED }),
    box(THREE, { w: 0.58, d: 0.58, y0: 0.2, y1: 0.235, part: PART_FIXED }),
  ];
  // Corner posts on the base: the shafts that make the base a base and not
  // another step, holding the shaft as if it were carried rather than set down.
  const posts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      posts.push(box(THREE, {
        w: 0.07,
        d: 0.07,
        x: sx * 0.2,
        z: sz * 0.2,
        y0: 0.2,
        y1: 0.32,
        part: PART_FIXED,
      }));
    }
  }
  // A bronze wreath on the base's front face: eight short bars stood on a
  // circle. The kit has no torus, and a solid disc here would read as a
  // medallion rather than as the wreath a war memorial carries.
  const wreath = [];
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    wreath.push(tag(
      new THREE.BoxGeometry(0.022, 0.06, 0.016)
        .rotateZ(a)
        .translate(Math.cos(a) * 0.055, 0.17 + Math.sin(a) * 0.055, -0.266),
      PART_FIXED,
      0.09,
      0.25
    ));
  }

  return mergeParts(THREE, [
    ...steps,
    ...base,
    ...posts,
    // CRITICAL: the tapered obelisk shaft, with its top at y = 0.86.
    obelisk(THREE, { rTop: 0.2, rBottom: 0.32, y0: 0.22, y1: 0.86, part: PART_BODY }),
    // A cornice collar at the shaft/pyramidion seam -- the detail line real
    // obelisks carry at exactly that transition.
    obelisk(THREE, { rTop: 0.23, rBottom: 0.23, y0: 0.85, y1: 0.885, part: PART_FIXED }),
    obelisk(THREE, { rTop: 0.001, rBottom: 0.2, y0: 0.87, y1: 0.98, part: PART_CROWN }),
    // A small bronze ball finial, so the point is not the only note at the top.
    tag(new THREE.SphereGeometry(0.015, 6, 4).translate(0, 0.985, 0), PART_CROWN, 0.97, 1.0),
    ...wreath,
  ]);
}

export function antennaGeometry(THREE) {
  // The mast is four tapering runs rather than one cone: at this scale the eye
  // reads the change of slope as a real guyed mast, and the runs give the
  // equipment ring and the guys something to attach to.
  const mast = [
    cylinder(THREE, {
      rTop: 0.03,
      rBottom: 0.055,
      y0: 0.04,
      y1: 0.55,
      segments: 6,
      part: PART_PODIUM,
    }),
    cylinder(THREE, {
      rTop: 0.016,
      rBottom: 0.03,
      y0: 0.55,
      y1: 1.0,
      segments: 6,
      part: PART_CROWN,
    }),
    cylinder(THREE, {
      rTop: 0.008,
      rBottom: 0.016,
      y0: 1.0,
      y1: 1.35,
      segments: 6,
      part: PART_CROWN,
    }),
    cylinder(THREE, {
      rTop: 0.001,
      rBottom: 0.008,
      y0: 1.35,
      y1: 1.5,
      segments: 6,
      part: PART_CROWN,
    }),
  ];

  // A service ring around the mast, with a railing lip and a cabinet on the
  // deck: the equipment a mast this tall actually carries, and the reason the
  // shaft is not a bare pole.
  const rig = [
    cylinder(THREE, {
      rTop: 0.1,
      rBottom: 0.1,
      y0: 0.5,
      y1: 0.53,
      segments: 8,
      part: PART_FIXED,
    }),
    cylinder(THREE, {
      rTop: 0.105,
      rBottom: 0.105,
      y0: 0.53,
      y1: 0.55,
      segments: 6,
      part: PART_FIXED,
    }),
    box(THREE, { w: 0.08, d: 0.06, x: 0.05, z: 0.05, y0: 0.53, y1: 0.6, part: PART_FIXED }),
  ];

  // Two dishes, a lower one facing +X and a higher one facing +Z, each with a
  // small feed rod -- so the mast reads as a communications spire rather than
  // a bare pole with a light on it.
  const dishes = [
    tag(new THREE.CylinderGeometry(0.055, 0.055, 0.012, 8).rotateZ(Math.PI / 2)
      .translate(0.13, 0.7, 0), PART_FIXED, 0.68, 0.72),
    tag(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 8).rotateX(Math.PI / 2)
      .translate(0, 0.86, 0.12), PART_FIXED, 0.84, 0.88),
    box(THREE, { w: 0.06, d: 0.012, x: 0.17, z: 0, y0: 0.69, y1: 0.71, part: PART_FIXED }),
    box(THREE, { w: 0.012, d: 0.06, x: 0, z: 0.16, y0: 0.85, y1: 0.87, part: PART_FIXED }),
  ];

  // Guy wires leave the mast high and reach the roofline low and wide, so the
  // caller's (spread, tall, spread) scale turns them into real tie lines
  // instead of the flat zig-zag a unit-box drawing would give.
  const anchor = 0.42;
  const rise = 1.0;
  const tilt = Math.atan2(anchor, rise);
  const span = Math.hypot(anchor, rise);
  const wire = (about, sign, x, z) => {
    const geometry = new THREE.CylinderGeometry(0.004, 0.004, span, 4);
    if (about === 'z') geometry.rotateZ(sign * tilt);
    else geometry.rotateX(sign * tilt);
    geometry.translate(x, (rise + 0.05) / 2, z);
    return tag(geometry, PART_FIXED, 0, rise);
  };
  const guys = [
    wire('z', 1, anchor / 2, 0),
    wire('z', -1, -anchor / 2, 0),
    wire('x', -1, 0, anchor / 2),
    wire('x', 1, 0, -anchor / 2),
  ];

  return mergeParts(THREE, [
    box(THREE, { w: 0.18, d: 0.18, y0: 0, y1: 0.05, part: PART_PODIUM }),
    ...mast,
    ...rig,
    ...dishes,
    ...guys,
    // An aircraft warning light at the very tip -- the detail that makes a
    // real skyline's tallest spires legible as landmarks rather than masts.
    tag(new THREE.SphereGeometry(0.035, 8, 4).translate(0, 1.5, 0), PART_CROWN, 1.46, 1.55),
  ]);
}

export function soleTenantMarkerGeometry(THREE) {
  // Plate, collar, pole, finial, flag. The collar is there so the pole meets
  // the ground through a base instead of growing out of it; the finial is
  // there so the top of the pole is finished even when the pennant is edge-on
  // to the camera and vanishes to a line.
  return mergeParts(THREE, [
    box(THREE, { w: 0.16, d: 0.16, y0: 0, y1: 0.025, part: PART_FIXED }),
    cylinder(THREE, {
      rTop: 0.022,
      rBottom: 0.028,
      y0: 0.02,
      y1: 0.06,
      segments: 6,
      part: PART_FIXED,
    }),
    cylinder(THREE, {
      rTop: 0.012,
      rBottom: 0.018,
      y0: 0.05,
      y1: 0.84,
      segments: 6,
      part: PART_FIXED,
    }),
    tag(new THREE.SphereGeometry(0.03, 6, 4).translate(0, 0.855, 0), PART_CROWN, 0.83, 0.89),
    pennant(THREE, { poleX: 0, y0: 0.58, y1: 0.8, length: 0.3, part: PART_CROWN }),
  ]);
}
