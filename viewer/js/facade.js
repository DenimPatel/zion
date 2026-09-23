/**
 * Facades, computed in the fragment shader rather than sampled from a texture.
 *
 * The old city drew one 64x128 window bitmap repeated 2x2 on every building,
 * which is why a 30-file repo looked charming and a 5,000-file one looked like
 * a warehouse of identical boxes: the window grid had no relationship to the
 * building it was on, and two files with the same archetype were pixel-for-pixel
 * the same object.
 *
 * Here the facade is a function of the building's own numbers instead. Floor
 * height, bay width, window proportion, which windows are lit, how weathered the
 * concrete is and how the albedo is tinted all fall out of per-instance
 * attributes, so no two buildings in a repository resolve to the same wall --
 * and it still costs zero extra draw calls, zero texture memory, and one extra
 * varying set over the version it replaces.
 *
 * Everything the shader reads is plaintext geometry (`id`, `language` index,
 * `floors`, `loc`), never a decrypted string, so a locked city renders exactly
 * as its unlocked self does. That is the same promise `city.json` already makes.
 */

/**
 * Facade families. The index comes from the interned language id, so all of a
 * repository's Python wears one kind of wall and all of its SQL another -- the
 * language legend becomes readable in the massing itself.
 */
export const FACADE_STYLES = ['masonry', 'curtain wall', 'ribbon', 'industrial'];

export function styleFor(building) {
  // Language index, not language name: a locked city has no names but must look
  // identical to an unlocked one.
  const language = building.language === undefined || building.language < 0 ? 0 : building.language;
  const floors = building.floors || 0;
  const tall = (building.height || 0) > 26;
  if (building.archetype === 'warehouse' || building.archetype === 'silo') return 3;
  if (tall && floors > 24) return 1;
  return language % 3 === 0 ? 0 : language % 3 === 1 ? 2 : 1;
}

/** Stable 0..1 hash of an integer, used for every per-instance decision. */
export function seedFor(building) {
  let hash = 2166136261 ^ ((building.id || 0) + 1);
  hash = Math.imul(hash, 16777619);
  hash ^= (building.language || 0) + 0x9e37;
  hash = Math.imul(hash, 16777619);
  hash ^= (building.loc || 0) + ((building.floors || 0) << 7);
  hash = Math.imul(hash, 16777619);
  return ((hash >>> 0) % 65536) / 65536;
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const COMMON = /* glsl */ `
  varying vec3 vLocal;     // unit-space position, after part displacement
  varying vec3 vDims;      // this instance's world size, in metres
  varying vec3 vObjNormal; // object-space normal, for picking the wall
  varying float vLit;
  varying float vSeed;
  varying float vStyle;
  varying float vWeather;
  varying float vFloorH;
  varying float vHover;
`;

const HASH = /* glsl */ `
  float zhash(float n) { return fract(sin(n) * 43758.5453123); }
  float zhash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
`;

// aMassing is (part, partY0, partY1); see mergeParts for why they are packed.
const MASSING_HEAD = /* glsl */ `
  attribute vec3 aMassing;
  attribute float aSeed;
  ${HASH}
`;

// aTraits is (lit, style, weather, hover): the four numbers that decide how a
// building presents itself, in one slot.
const VERTEX_HEAD = /* glsl */ `
  ${MASSING_HEAD}
  attribute vec4 aTraits;
  attribute float aFloorH;
  ${COMMON}
`;

/**
 * Per-instance massing variation.
 *
 * Only ornament moves. The BODY part is left exactly where the layout put it,
 * so a building's footprint and height still mean the bytes and the lines they
 * were measured from; crowns, setbacks and podiums are free invention and are
 * where the silhouette variety comes from.
 */
const MASSING_BODY = /* glsl */ `
  float _r0 = zhash(aSeed * 91.7 + 3.1);
  float _r1 = zhash(aSeed * 57.3 + 11.9);
  float _r2 = zhash(aSeed * 23.9 + 71.3);
  float _part = aMassing.x, _y0 = aMassing.y, _y1 = aMassing.z;
  float _span = max(_y1 - _y0, 1e-4);
  float _t = clamp((transformed.y - _y0) / _span, 0.0, 1.0);

  if (_part == 1.0) {            // setback: narrower, and stopping short
    transformed.xz *= mix(0.62, 1.04, _r0);
    transformed.y = _y0 + _span * _t * mix(0.45, 1.0, _r1);
  } else if (_part == 2.0) {     // crown: often absent, occasionally a spire
    float keep = step(0.34, _r2);
    float lift = keep * mix(0.25, 2.1, _r1 * _r1);
    transformed.xz *= mix(0.55, 1.25, _r0);
    transformed.y = _y0 + _span * _t * lift;
  } else if (_part == 3.0) {     // podium: a skirt of varying generosity
    transformed.xz *= mix(0.94, 1.16, _r2);
    transformed.y = _y0 + _span * _t * mix(0.6, 1.5, _r0);
  }
`;

// The varyings the facade needs. Split out from the massing because the shadow
// pass shares the displacement -- otherwise a building would cast the shadow of
// a crown it does not have -- but has no normals or facade to carry.
const VERTEX_VARYINGS = /* glsl */ `
  vLocal = transformed;
  vObjNormal = objectNormal;
  vDims = vec3(
    length(instanceMatrix[0].xyz),
    length(instanceMatrix[1].xyz),
    length(instanceMatrix[2].xyz)
  );
  vLit = aTraits.x;
  vSeed = aSeed;
  vStyle = aTraits.y;
  vWeather = aTraits.z;
  vHover = aTraits.w;
  vFloorH = aFloorH;
`;

/**
 * The facade itself.
 *
 * `facadeSample` is called once and returns everything the three lighting
 * chunks need: an albedo multiplier, a roughness target, and a window glow.
 * Computing it once and reusing it keeps the fragment cost to a single grid
 * evaluation no matter how many places the result is used.
 */
const FRAGMENT_HEAD = /* glsl */ `
  ${COMMON}
  ${HASH}
  uniform float uHasWindows;
  uniform float uDetail;      // 1 near, 0 far: drops the fine passes at range

  struct Facade {
    vec3 tint;
    float roughness;
    float glow;
    vec3 glowColor;
  };

  Facade facadeSample() {
    Facade f;
    vec3 P = vLocal * vDims;                 // metres from the footprint centre
    vec3 n = normalize(vObjNormal);
    float ax = abs(n.x), ay = abs(n.y), az = abs(n.z);
    bool roof = ay >= max(ax, az);

    // Per-instance albedo. Wide enough that neighbours differ at a glance,
    // narrow enough that the archetype's own colour -- which the legend gives a
    // meaning to -- still governs which family a building belongs to.
    float shade = mix(0.76, 1.16, zhash(vSeed * 313.7));
    f.tint = vec3(shade) * vec3(
      1.0 + (zhash(vSeed * 77.1) - 0.5) * 0.16,
      1.0,
      1.0 + (zhash(vSeed * 131.3) - 0.5) * 0.18
    );
    f.roughness = 1.0;
    f.glow = 0.0;
    f.glowColor = vec3(1.0, 0.82, 0.52);

    if (roof) {
      // Roofs: gravel and a seam grid, a shade darker than the walls so the
      // skyline reads as a skyline from above.
      f.tint *= 0.62;
      if (uDetail > 0.5) {
        vec2 grid = P.xz / 2.4;
        float roofSharp = 1.0 - smoothstep(0.2, 0.7, max(fwidth(grid.x), fwidth(grid.y)));
        vec2 seam = abs(fract(grid) - 0.5);
        f.tint *= 1.0 - 0.18 * roofSharp * (1.0 - smoothstep(0.0, 0.06, min(seam.x, seam.y)));
        f.tint *= mix(1.0, 0.92 + 0.16 * zhash2(floor(grid) + vSeed * 17.0), roofSharp);
      }
      return f;
    }

    // Wall coordinates: u runs along the wall, v is height above the base.
    float u = (ax > az) ? P.z : P.x;
    float wallW = (ax > az) ? vDims.z : vDims.x;
    float face = (ax > az) ? (n.x > 0.0 ? 0.0 : 1.0) : (n.z > 0.0 ? 2.0 : 3.0);
    float v = P.y;
    float H = max(vDims.y, 0.001);

    // Grime rising out of the street, and the thin darkening in a corner that
    // sells a box as a solid.
    f.tint *= mix(0.72, 1.0, smoothstep(0.0, 5.0, v));
    float corner = min(abs(u + wallW * 0.5), abs(u - wallW * 0.5));
    f.tint *= mix(0.88, 1.0, smoothstep(0.0, 0.7, corner));

    if (uHasWindows < 0.5) {
      // Monuments and parks: stone courses and nothing else.
      if (uDetail > 0.5) {
        float courses = v / 1.6;
        float course = abs(fract(courses) - 0.5);
        f.tint *= 1.0 - 0.12 * (1.0 - smoothstep(0.2, 0.7, fwidth(courses)))
                             * (1.0 - smoothstep(0.0, 0.08, course));
      }
      return f;
    }

    float floorH = vFloorH;
    float plinth = floorH * mix(1.0, 1.9, zhash(vSeed * 401.1));
    float cornice = floorH * 0.45;

    // Bays are sized from the wall, then snapped so a whole number fits: a bay
    // that straddles a corner is the single thing that most gives a procedural
    // facade away. Kept near human scale -- around two metres -- so a narrow
    // building still gets a handful of windows per floor rather than two panes
    // the size of a garage door.
    float bayTarget = mix(1.9, 3.1, zhash(vSeed * 211.5));
    float cols = max(1.0, floor(wallW / bayTarget + 0.5));
    float bay = wallW / cols;

    vec2 cell = vec2((u + wallW * 0.5) / bay, (v - plinth) / floorH);
    float col = floor(cell.x);
    float row = floor(cell.y);
    float fx = fract(cell.x);
    float fy = fract(cell.y);

    // How big one window cell is on screen. Past roughly a pixel a hard grid
    // turns into moire, and a skyline of ten thousand buildings is mostly made
    // of cells that small, so everything below dissolves into the average it
    // would have integrated to instead of shimmering. This is the difference
    // between detail that survives scale and detail that punishes it.
    vec2 step2 = vec2(fwidth(cell.x), fwidth(cell.y));
    vec2 aa = max(step2, vec2(1e-4)) * 0.5;
    float sharp = 1.0 - smoothstep(0.22, 0.7, max(step2.x, step2.y));

    // Window aperture, per style.
    vec4 win = vec4(0.30, 0.70, 0.22, 0.64);                    // masonry
    if (vStyle > 2.5)      win = vec4(0.14, 0.86, 0.18, 0.78);  // industrial
    else if (vStyle > 1.5) win = vec4(0.05, 0.95, 0.36, 0.68);  // ribbon
    else if (vStyle > 0.5) win = vec4(0.11, 0.89, 0.17, 0.83);  // curtain wall

    float band = step(plinth, v) * step(v, H - cornice);
    float wx = smoothstep(win.x - aa.x, win.x + aa.x, fx) *
               (1.0 - smoothstep(win.y - aa.x, win.y + aa.x, fx));
    float wy = smoothstep(win.z - aa.y, win.z + aa.y, fy) *
               (1.0 - smoothstep(win.w - aa.y, win.w + aa.y, fy));
    // The far-field value is the window's share of its cell, which is exactly
    // what an infinitely-sampled grid averages to.
    float coverage = (win.y - win.x) * (win.w - win.z);
    float glass = band * mix(coverage, wx * wy, sharp);

    if (vStyle > 2.5) {
      // Industrial panes get a mullion cross, which is most of what makes a
      // shed window read as a shed window.
      float cross = max(
        1.0 - smoothstep(aa.x, aa.x + 0.03, abs(fx - 0.5)),
        1.0 - smoothstep(aa.y, aa.y + 0.05, abs(fy - 0.5))
      );
      glass *= 1.0 - cross * sharp;
    }

    // Floor slabs: a band at every storey, on every style. This alone makes a
    // three-function file and a forty-class one unmistakable from the same
    // distance, because the rows *are* the floors the parser found.
    float slab = (1.0 - smoothstep(aa.y, aa.y + 0.06, abs(fy - 0.04))) * band;
    f.tint *= 1.0 - 0.16 * slab * sharp;

    // Pier between windows: catches a highlight, and carries the weathering.
    float pier = (1.0 - glass) * sharp;
    f.tint *= 1.0 - 0.1 * pier *
      (1.0 - smoothstep(0.0, 0.12, min(abs(fx - win.x), abs(fx - win.y))));
    // Weathering: vertical streaks running down from the sills, strongest on
    // the files nothing has touched in a long time.
    float streak = zhash2(vec2(floor(u * 1.7), face));
    float run = smoothstep(0.35, 1.0, fract(v / (floorH * 3.0)));
    f.tint *= 1.0 - vWeather * 0.32 * streak * mix(0.45, run, sharp) * pier;

    // A darker band just under each window row: rain leaves the sill, the dirt
    // it carried stays. The cheapest cue that a wall has stood in weather rather
    // than been extruded this morning, and it costs one smoothstep.
    float sillDrip = (1.0 - smoothstep(0.0, 0.13, abs(fy - (win.z - 0.11)))) * band;
    f.tint *= 1.0 - (0.07 + vWeather * 0.15) * sillDrip * pier;

    // A gentle lift up the shaft above the plinth. A tall wall washed with one
    // flat value reads as a plane; letting it darken slightly toward the street
    // gives the mass somewhere for the eye to sit.
    f.tint *= mix(0.93, 1.0, smoothstep(plinth, plinth + H * 0.4, v));

    // Glass: darker and far smoother than the wall, so windows read in daylight
    // and not only as emissive dots after dark.
    f.tint *= mix(1.0, 0.34, glass);
    f.roughness = mix(mix(0.92, 0.74, step(0.5, vStyle) * step(vStyle, 1.5)), 0.14, glass);
    // Per-building surface variation, so a row of identical forms still takes
    // the light differently -- concrete, stone and painted panel do not return
    // the same highlight even under the same sky.
    f.roughness = clamp(f.roughness * mix(0.85, 1.15, zhash(vSeed * 97.7)), 0.05, 1.0);

    // Which windows are lit. At range the per-window dice roll averages back to
    // the building's documented ratio, so "lit means documented" still reads
    // from the overview even when no individual window is resolvable.
    float r = zhash2(vec2(row * 17.0 + col * 3.0, face * 29.0 + vSeed * 997.0));
    float dim = 0.35 + 0.65 * zhash2(vec2(col * 7.0 - row, vSeed * 131.0));
    float on = mix(vLit, step(1.0 - vLit, r) * dim, sharp);
    f.glow = glass * on;
    f.glowColor = mix(
      vec3(1.0, 0.78, 0.44),
      vec3(0.74, 0.86, 1.0),
      zhash2(vec2(row, col + vSeed * 53.0)) * 0.45 * sharp
    );

    // Plinth and cornice: the two bands that stop a tower looking extruded.
    float atPlinth = 1.0 - step(plinth, v);
    f.tint = mix(f.tint, f.tint * 0.7, atPlinth);
    f.roughness = mix(f.roughness, 0.95, atPlinth);
    // One doorway per building, on one face, in the middle of one bay.
    float doorBay = floor(zhash(vSeed * 613.0) * cols);
    float door = atPlinth * sharp *
      step(abs(col - doorBay), 0.5) *
      step(abs(face - floor(zhash(vSeed * 811.0) * 4.0)), 0.5) *
      step(0.3, fx) * step(fx, 0.7) * step(v, min(plinth * 0.72, 4.2));
    f.tint = mix(f.tint, f.tint * 0.42, door);
    f.glow = max(f.glow, door * vLit * 0.6);

    float atCornice = step(H - cornice, v);
    f.tint = mix(f.tint, f.tint * 1.18, atCornice);

    return f;
  }
`;

/**
 * Wire the facade into MeshStandardMaterial.
 *
 * Three's own chunks stay in place -- shadows, fog, tone mapping and the
 * hemisphere light all keep working -- and the facade only multiplies into
 * albedo, roughness and emissive at the three points where those are decided.
 */
export function patchFacade(material, { hasWindows = true, detail = true } = {}) {
  material.userData.facadeUniforms = {
    uHasWindows: { value: hasWindows ? 1 : 0 },
    uDetail: { value: detail ? 1 : 0 },
  };
  // The facade antialiases itself with screen-space derivatives; WebGL2 has
  // them unconditionally, and this is what asks for them on a WebGL1 fallback.
  material.extensions = { ...(material.extensions || {}), derivatives: true };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.facadeUniforms);

    shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + MASSING_BODY + VERTEX_VARYINGS
    );

    shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n' +
        '  Facade zFacade = facadeSample();\n' +
        '  diffuseColor.rgb *= zFacade.tint;'
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\n' +
        '  roughnessFactor = mix(roughnessFactor, zFacade.roughness, 0.85);'
      )
      .replace(
        '#include <emissivemap_fragment>',
        // The hover wash is added, not folded into the window glow, and it
        // deliberately sits outside `emissiveIntensity`.
        //
        // Pointing at a building used to set its lit-window fraction to 0.75,
        // which meant the viewer overwrote the one number the building exists
        // to report at the exact moment you asked to read it: a 2%-documented
        // file lit up as though it were 75% documented. The highlight now
        // glows the object rather than its windows, so it says "this one"
        // without saying anything false -- and because it bypasses the
        // emissive intensity, it still reads at noon and with the lit-windows
        // slider at zero.
        '  totalEmissiveRadiance = totalEmissiveRadiance * zFacade.glow * zFacade.glowColor\n' +
        // Modulated by the facade rather than painted flat over it, so the
        // highlighted building still reads as the building you were looking at
        // -- storeys, glass and piers all still visible through the wash.
        '    + vHover * vec3(0.26, 0.20, 0.10) * (0.35 + 0.65 * clamp(zFacade.tint, 0.0, 1.0));'
      );
  };

  // Two programs, not one per material: near and far differ only by `uDetail`,
  // and windows-or-not is a compile-time branch on a uniform either way.
  material.customProgramCacheKey = () => `zion-facade-${hasWindows ? 1 : 0}-${detail ? 1 : 0}`;
}

/**
 * Rooftop clutter shares the massing path -- which piece of the cluster a given
 * building actually gets is the same crown/setback dice roll -- but wants none
 * of the facade: it is painted metal, not a wall.
 */
export function patchRoofProps(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = MASSING_HEAD + 'varying float vSeed;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + MASSING_BODY + '  vSeed = aSeed;'
    );
    shader.fragmentShader = 'varying float vSeed;\n' + HASH + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n' +
      '  diffuseColor.rgb *= mix(0.62, 1.2, zhash(vSeed * 53.0));'
    );
  };
  material.customProgramCacheKey = () => 'zion-roof-props';
}

/**
 * The shadow pass, given the same massing displacement as the colour pass.
 *
 * Without this a crown the vertex shader collapsed would still cast its full
 * spire onto the street, and the variation would read as a bug rather than as
 * architecture.
 */
export function makeMassingDepthMaterial(THREE) {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = MASSING_HEAD + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + MASSING_BODY
    );
  };
  material.customProgramCacheKey = () => 'zion-massing-depth';
  return material;
}
