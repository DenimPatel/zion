/**
 * Building the city: one InstancedMesh per archetype.
 *
 * Draw calls stay bounded by the number of archetypes (~8), not by the number
 * of buildings, so a 50,000-file repo renders in the same number of calls as a
 * 28-file one. Everything per-building -- footprint, height, tint, the fraction
 * of lit windows, the storey height, the facade family, how weathered it is and
 * the seed that decides its roofline -- rides in the instance matrix, the
 * instance colour, and six instanced attributes.
 *
 * That last part is the whole reason a large repository no longer looks like a
 * field of identical boxes. The massing comes from `shapes.js` (eight silhouettes
 * rather than one, varied per instance in the vertex shader) and the walls come
 * from `facade.js` (computed per fragment from the building's own metrics rather
 * than sampled from one shared bitmap). Neither costs a draw call.
 */

import {
  antennaGeometry,
  craneGeometry,
  farGeometry,
  nearGeometry,
  roofPropGeometry,
  scaffoldingGeometry,
  soleTenantMarkerGeometry,
} from './shapes.js';
import { beaconGeometry, beaconTiers } from './parts/beacons.js';
import {
  makeMassingDepthMaterial,
  patchFacade,
  patchRoofProps,
  seedFor,
  styleFor,
} from './facade.js';

/** Archetypes whose walls are walls. Parks and monuments get stone, not glass. */
const WINDOWED = new Set(['tower', 'slab', 'warehouse', 'silo', 'town_hall', 'ruin']);

const LANDMARK_SCALE = { town_hall: 1.15 };

/** Archetypes whose geometry carries its own per-vertex colour zones. */
const VERTEX_COLOURED = new Set(['town_hall']);

/**
 * Where a flat roof actually is, as a fraction of the building's height.
 *
 * Only the two flat-topped office forms get clutter, and it sits on the top of
 * their *body* -- the terrace the setback rises out of -- rather than at some
 * fraction of the overall height, which would leave equipment hanging in the
 * air beside a crown. Gables, domes and pyramidions have nowhere to put a
 * water tank, so they get none.
 */
const ROOF_DECK = { tower: 0.73, slab: 0.91 };

/**
 * Detailed massing is ~50 triangles a building against the far tier's 12, so
 * the near tier is capped by count as well as by radius: past this many, the
 * furthest of them fall back to boxes rather than the frame rate falling over.
 *
 * At this budget a fully detailed near field is roughly 300,000 triangles --
 * about what one modest character model costs -- which is why the radius below
 * can afford to be generous.
 */
const MAX_DETAILED = 6000;

/** Rooftop clutter, tallest buildings first, in one extra draw call. */
const MAX_ROOF_PROPS = 3000;
const MAX_CRANES = 1500;

/**
 * The eight massing geometries, built once for the life of the page.
 *
 * Streaming rebuilds the city whenever the working set changes, and rebuilding
 * eight merged geometries on every chunk boundary would be a stutter for no
 * reason: they never depend on which buildings are resident.
 */
const MASSING_CACHE = new Map();

export const ARCHETYPE_COLORS = {
  tower: 0x8895a8,
  slab: 0x74808f,
  warehouse: 0x646d7a,
  silo: 0x9b8b6d,
  monument: 0xa093b0,
  town_hall: 0xd9a441,
  park: 0x4f7d4d,
  ruin: 0x4a4d55,
};

const ARCHETYPE_NAMES = {
  tower: 'tower',
  slab: 'slab',
  warehouse: 'warehouse',
  silo: 'silo',
  monument: 'monument',
  town_hall: 'town hall',
  park: 'park',
  ruin: 'ruin',
};

export function archetypeLabel(name) {
  return ARCHETYPE_NAMES[name] || name;
}

/** A second, decorrelated number from one seed, so X and Z jitter differ. */
function seedOffset(seed) {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * How tall one storey is on a given building, in metres.
 *
 * Where the parser found floors -- functions, classes, headings, notebook cells
 * -- the window rows *are* those floors: a three-function module gets three rows
 * of windows and a forty-class one gets forty, at a glance, from the street.
 * Files the parser could not read fall back to a seeded storey height so they
 * still differ from their neighbours.
 */
function storeyHeight(building, seed) {
  const floors = building.floors || 0;
  const height = building.height || 3;
  if (floors > 0) return Math.min(4.4, Math.max(2.5, height / floors));
  return 2.9 + seed * 1.4;
}

/**
 * A soft round glow, drawn once and reused by every beacon.
 *
 * The lamp's halo cannot be geometry: an additive icosahedron shows its own
 * facets and reads as a red ball bolted to the mast. A camera-facing point with
 * a radial falloff is a glow at any distance and any angle, and one `Points`
 * object carries every beacon in the city in a single draw call.
 */
function makeGlowTexture(THREE) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.5)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/** Ground: dark asphalt with a faint grid so motion reads at low altitude. */
export function makeGroundTexture(THREE) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#12161f';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(148,163,184,0.10)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(size, i);
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

function hueFor(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 360) / 360;
}

/**
 * Tint a base colour toward an author's hue.
 *
 * Only used when the manifest says authorship is meaningful; a single-author
 * repo falls back to the neutral palette rather than drawing a one-entry scale.
 */
function tintFor(THREE, baseHex, author, strength) {
  const base = new THREE.Color(baseHex);
  if (!author) return base;
  const authorColor = new THREE.Color().setHSL(hueFor(author), 0.42, 0.55);
  return base.clone().lerp(authorColor, strength);
}

export class CityMesh {
  constructor(THREE, source) {
    this.THREE = THREE;
    this.source = source;
    this.group = new THREE.Group();
    this.group.name = 'city';
    this.records = new Map(); // instanced mesh uuid -> building records
    this.meshes = new Map();  // instanced mesh uuid -> the mesh itself
    this.maxHeight = 1;
  }

  /**
   * Build the whole city from a list of building records.
   * Returns the THREE.Group; raycasting uses `this.records`.
   */
  build(buildings, options = {}) {
    const THREE = this.THREE;
    const manifest = this.source.manifest;
    const [bx, bz, bw, bh] = manifest.bounds;
    this.maxHeight = Math.max(1, ...buildings.map((b) => b.height || 0));

    // The manifest's degeneration flags decide whether a legend entry *can*
    // mean anything in this repository; the Keys panel decides whether the
    // reader wants it on screen. Each layer is therefore resolved as an
    // explicit option first, falling back to the flag, so switching one off by
    // hand is the same code path the flag already takes rather than a second
    // way of hiding geometry.
    const flag = (name) => Boolean(manifest.flags && manifest.flags[name]);
    const option = (name, fallback) =>
      options[name] === undefined ? fallback : Boolean(options[name]);
    const authorTint = option('authorTint', flag('authorship'));
    const litCap = options.litCap === undefined ? 1 : options.litCap;

    // Level of detail: one instanced mesh per archetype per tier, so draw calls
    // scale with archetypes, never with building count. Distant buildings keep
    // their facade and their glow -- the metaphor must survive at range, and
    // the shader averages the window grid rather than dropping it -- but fall
    // back to box massing, which is where the triangles actually go.
    const lodNear = options.lodNear !== undefined
      ? options.lodNear
      : Math.min(1800, Math.max(240, Math.max(bw, bh) * 0.75));
    // Remembered so the caller can tell when the camera has travelled far
    // enough that the near/far split is stale: detail is a function of where
    // the camera is, and nothing else recomputes it when the whole city is
    // resident (see `refreshResident` in main.js).
    this.lodRadius = lodNear;
    const cameraXZ = options.cameraXZ || null;

    // Detail is budgeted twice: by radius, and then by count. The radius alone
    // is not enough -- a dense repository can put ten thousand buildings inside
    // it -- so the nearest MAX_DETAILED win the detailed massing and the rest
    // are demoted to boxes. Nothing disappears; only its triangle count does.
    const ranked = [];
    for (const building of buildings) {
      const dx = (building.x || 0) - (cameraXZ ? cameraXZ.x : 0);
      const dz = (building.y || 0) - (cameraXZ ? cameraXZ.z : 0);
      ranked.push({ building, distance: cameraXZ ? Math.hypot(dx, dz) : 0 });
    }
    if (cameraXZ && ranked.length > MAX_DETAILED) ranked.sort((a, b) => a.distance - b.distance);

    const byArchetype = new Map();
    ranked.forEach((entry, rank) => {
      const key = entry.building.archetype || 'warehouse';
      if (!byArchetype.has(key)) byArchetype.set(key, { near: [], far: [] });
      const detailed = rank < MAX_DETAILED && (!cameraXZ || entry.distance <= lodNear);
      byArchetype.get(key)[detailed ? 'near' : 'far'].push(entry.building);
    });

    const far = farGeometry(THREE);
    const weathering = option('weathering', flag('recency'));

    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    const roofCandidates = [];
    const craneCandidates = [];
    const beaconCandidates = [];
    const scaffoldCandidates = [];
    const antennaCandidates = [];
    const soleTenantCandidates = [];
    const churnEligible = option('churn', flag('churn'));
    const ageEligible = option('age', flag('age'));
    const downtownEligible = option('downtown', flag('downtown'));
    const glass = new THREE.Color(0x8fd6ff);

    for (const [archetype, tiers] of byArchetype) {
      for (const tier of ['near', 'far']) {
      const members = tiers[tier];
      if (!members.length) continue;
      const detailed = tier === 'near';
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: archetype === 'park' ? 0.95 : archetype === 'monument' ? 0.32 : archetype === 'town_hall' ? 0.68 : 0.72,
        metalness: archetype === 'monument' ? 0.5 : 0.08,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0,
        // A town hall paints its own stone, trim, roof and glazing in vertex
        // colours -- see `civic.js` -- so one material can carry the material
        // separation that makes City Hall read as built rather than extruded.
        // Only the detailed tier: the far tier is a plain box with no colour
        // attribute, and a material that expects one renders it black.
        vertexColors: detailed && VERTEX_COLOURED.has(archetype),
      });
      patchFacade(material, { hasWindows: WINDOWED.has(archetype), detail: detailed });

      const geometry = detailed
        ? nearGeometry(THREE, archetype, MASSING_CACHE).clone()
        : far.clone();
      const mesh = new THREE.InstancedMesh(geometry, material, members.length);
      mesh.name = `buildings-${archetype}${detailed ? '' : '-far'}`;
      mesh.castShadow = detailed && archetype !== 'park';
      mesh.receiveShadow = detailed;
      // The displaced crowns and setbacks have to reach the shadow map too.
      if (mesh.castShadow) mesh.customDepthMaterial = makeMassingDepthMaterial(THREE);

      // (lit, style, weather, hover) per instance, in one attribute. A
      // building already spends eleven of the sixteen vertex attribute slots
      // WebGL guarantees, and the highlight needs a channel of its own rather
      // than borrowing the lit-window one.
      const traits = new Float32Array(members.length * 4);
      const seeds = new Float32Array(members.length);
      const storeys = new Float32Array(members.length);
      const lit = new Float32Array(members.length);

      members.forEach((building, index) => {
        const x = (building.x || 0) + (building.width || 4) / 2;
        const z = (building.y || 0) + (building.depth || 4) / 2;
        // Civic forms are drawn a little larger than their plot. City Hall has a
        // reserved plaza; a town hall is one README among the blocks around it,
        // and at city scale a faithful footprint leaves it looking like any
        // other one of them. Scaling about the footprint centre keeps it on its
        // plot, and collision, hover and the detail report all still measure the
        // real footprint -- only the drawn massing is exaggerated.
        //
        // Everything downstream of the footprint -- the massing, and the props
        // that stand on it -- is measured from the *drawn* dimensions, or a
        // crane would be planted at the data height and sink into a roof that is
        // drawn fifteen percent higher.
        const landmark = LANDMARK_SCALE[archetype] || 1;
        const width = (building.width || 4) * landmark;
        const depth = (building.depth || 4) * landmark;
        const height = (building.height || 3) * landmark;
        matrix.makeScale(width, height, depth);
        matrix.setPosition(x, 0, z);
        mesh.setMatrixAt(index, matrix);

        const author = authorTint ? this.source.s(building.author) : '';
        colour.copy(tintFor(THREE, ARCHETYPE_COLORS[archetype] || 0x777777, author, author ? 0.45 : 0));
        // Downtown: a glass tint on top of whatever archetype/author colour
        // already applies, so "this file is structurally central" reads
        // alongside the existing tint rather than replacing it.
        if (downtownEligible && building.downtown) colour.lerp(glass, 0.4);
        mesh.setColorAt(index, colour);

        // Parks and monuments carry no windows; everything else glows in
        // proportion to how documented it is.
        const value = building.lit === null || building.lit === undefined
          ? (archetype === 'park' ? 0 : 0.18)
          : building.lit;
        lit[index] = Math.min(litCap, Math.max(0, value));
        traits[index * 4] = lit[index];
        traits[index * 4 + 1] = styleFor(building);

        const seed = seedFor(building);
        seeds[index] = seed;
        storeys[index] = storeyHeight(building, seed);
        // Weathering only when the repository has enough history for "days
        // since last commit" to mean anything; a shallow clone gets clean walls
        // rather than a made-up patina. Saturates at two years.
        traits[index * 4 + 2] = weathering
          ? Math.min(1, (building.recencyDays || 0) / 730)
          : 0;

        // Detailed tier only. The far tier's massing is a plain box with no
        // terrace to stand on, so clutter there would either float above the
        // roofline or be buried inside it -- and at that range it is a pixel.
        const deck = ROOF_DECK[archetype];
        if (detailed && deck !== undefined && height > 9) {
          roofCandidates.push({ x, z, width, depth, height, deck, seed });
        }

        // Cranes mark the top decile of churn -- "this file is under active
        // construction" -- and only when the repo has enough commit history
        // for churn to mean anything (the same rule the legend already states).
        if (detailed && churnEligible && building.topChurn) {
          craneCandidates.push({ x, z, width, depth, height, seed });
        } else if (detailed && churnEligible && building.heat > 0) {
          // Below the crane's top-decile cutoff: a graded rooftop beacon
          // instead, so "somewhat active" is still visible and distinct from
          // "quiet". Bucketed by tier rather than a continuous shader.
          beaconCandidates.push({ x, z, width, depth, height, heat: building.heat });
        }

        // Scaffolding wraps the building's own exact footprint and height, so
        // it is built from the same matrix as the building itself rather than
        // a separately-scaled prop.
        if (detailed && ageEligible && building.isNew) {
          scaffoldCandidates.push(matrix.clone());
        }

        if (detailed && downtownEligible && building.downtown) {
          antennaCandidates.push({ x, z, width, depth, height });
        }

        if (detailed && authorTint && building.soleTenant) {
          soleTenantCandidates.push({ x, z, width, depth });
        }
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.setAttribute('aTraits', new THREE.InstancedBufferAttribute(traits, 4));
      mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
      mesh.geometry.setAttribute('aFloorH', new THREE.InstancedBufferAttribute(storeys, 1));
      // Keep the untouched colours so a hover highlight can be reverted exactly.
      if (mesh.instanceColor) {
        mesh.userData.baseColors = Float32Array.from(mesh.instanceColor.array);
      }
      mesh.userData.baseLit = Float32Array.from(lit);
      mesh.userData.baseEmissive = material.emissiveIntensity;

      this.records.set(mesh.uuid, members);
      this.meshes.set(mesh.uuid, mesh);
      this.group.add(mesh);
      }
    }
    far.dispose();

    this._addRoofProps(roofCandidates);
    this._addCranes(craneCandidates);
    this._addHeatBeacons(beaconCandidates);
    this._addScaffolding(scaffoldCandidates);
    this._addAntennas(antennaCandidates);
    this._addSoleTenantMarkers(soleTenantCandidates);
    this._addGround(bx, bz, bw, bh, buildings);
    this._addStreets(manifest.streets || []);
    this._addDistricts(manifest.districts || []);
    return this.group;
  }

  /**
   * Rooftop plant, tanks and masts, for every detailed building tall enough to
   * have a roof worth looking at.
   *
   * One instanced cluster, so the whole city's roofs are a single draw call, and
   * which pieces of the cluster survive is the same per-instance seed that
   * shaped the crown -- a building's roof and its roofline agree. Aerial is the
   * view people actually spend their time in, and a flat lid on every tower was
   * most of what made the overview read as a spreadsheet.
   */
  _addRoofProps(candidates) {
    if (!candidates.length) return;
    const THREE = this.THREE;
    // Tallest first: on a crowded roofline the tall roofs are the ones in view.
    if (candidates.length > MAX_ROOF_PROPS) {
      candidates.sort((a, b) => b.height - a.height);
      candidates.length = MAX_ROOF_PROPS;
    }

    const material = new THREE.MeshStandardMaterial({
      color: 0x6a7280,
      roughness: 0.68,
      metalness: 0.35,
    });
    patchRoofProps(material);

    const mesh = new THREE.InstancedMesh(roofPropGeometry(THREE), material, candidates.length);
    mesh.name = 'roof-props';
    mesh.castShadow = true;
    mesh.customDepthMaterial = makeMassingDepthMaterial(THREE);
    // Clutter is scenery, not a target: a mast must not steal the click that
    // belongs to the building it stands on.
    mesh.raycast = () => {};

    const matrix = new THREE.Matrix4();
    const seeds = new Float32Array(candidates.length);
    candidates.forEach((roof, index) => {
      // Sized off the smaller footprint dimension so clutter never overhangs,
      // and kept within a storey or two so it reads as equipment rather than as
      // another floor.
      const spread = Math.min(roof.width, roof.depth) * 0.8;
      const tall = Math.min(9, Math.max(2.5, spread * 1.15));
      matrix.makeScale(spread, tall, spread);
      // Sunk very slightly into the deck, so no gap opens under a tank when the
      // instance scale stretches a footprint.
      matrix.setPosition(
        roof.x + (roof.seed - 0.5) * roof.width * 0.16,
        roof.height * roof.deck - tall * 0.04,
        roof.z + (seedOffset(roof.seed) - 0.5) * roof.depth * 0.16
      );
      mesh.setMatrixAt(index, matrix);
      seeds[index] = roof.seed;
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    this.group.add(mesh);
  }

  /**
   * Construction cranes over the top decile of churn -- "this file is under
   * active construction", the same instanced-cluster technique as the roof
   * props above so churn at scale still costs one draw call.
   */
  _addCranes(candidates) {
    if (!candidates.length) return;
    const THREE = this.THREE;
    if (candidates.length > MAX_CRANES) {
      candidates.sort((a, b) => b.height - a.height);
      candidates.length = MAX_CRANES;
    }

    const material = new THREE.MeshStandardMaterial({
      color: 0xd9a531,
      roughness: 0.55,
      metalness: 0.4,
    });

    const mesh = new THREE.InstancedMesh(craneGeometry(THREE), material, candidates.length);
    mesh.name = 'cranes';
    mesh.castShadow = true;
    mesh.customDepthMaterial = makeMassingDepthMaterial(THREE);
    // Scenery, not a target -- the click belongs to the building underneath.
    mesh.raycast = () => {};

    const matrix = new THREE.Matrix4();
    candidates.forEach((crane, index) => {
      const spread = Math.min(crane.width, crane.depth) * 0.6;
      const rotation = new THREE.Matrix4().makeRotationY(seedOffset(crane.seed) * Math.PI * 2);
      matrix.makeScale(spread, spread * 2.2, spread);
      matrix.premultiply(rotation);
      matrix.setPosition(
        crane.x + (crane.seed - 0.5) * crane.width * 0.5,
        crane.height,
        crane.z + (seedOffset(crane.seed) - 0.5) * crane.depth * 0.5
      );
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /**
   * Rooftop beacons: a graded signal for "how active is this file lately",
   * distinct from cranes (which mark only the top decile, "under active
   * construction right now"). Bucketed into three tiers rather than one
   * continuous shader -- three ordinary materials, three small instanced
   * meshes, the same technique `_addCranes`/`_addRoofProps` already use.
   */
  _addHeatBeacons(candidates) {
    if (!candidates.length) return;
    const THREE = this.THREE;
    const TIERS = beaconTiers();
    const buckets = TIERS.map(() => []);
    for (const candidate of candidates) {
      const tier = TIERS.findIndex((t) => candidate.heat <= t.max);
      buckets[Math.max(0, tier)].push(candidate);
    }

    // The glow is collected across every tier and drawn as two point clouds
    // rather than as one shell per tier: one steady for the dim band, one that
    // blinks for the amber and red warning bands. A camera-facing point is a
    // soft glow from any angle, where an additive icosahedron showed its facets.
    const steady = { positions: [], colours: [] };
    const warning = { positions: [], colours: [] };
    const glowColour = new THREE.Color();
    this._beaconGlow = [];

    buckets.forEach((bucket, tierIndex) => {
      if (!bucket.length) return;
      const limited =
        bucket.length > MAX_ROOF_PROPS
          ? bucket.sort((a, b) => b.heat - a.heat).slice(0, MAX_ROOF_PROPS)
          : bucket;
      const tier = TIERS[tierIndex];
      // A muted tier tint, not the tier colour itself: a real obstruction light
      // is galvanised metal with a coloured lamp, so painting the whole fixture
      // amber or red made it read as a toy. The vertex colours keep the housing
      // dark, the steel colder and the lens near-white; the tier is carried by
      // the glow, which is where a lamp's colour actually is.
      const tint = new THREE.Color(0xffffff).lerp(new THREE.Color(tier.colour), 0.4);
      // No emissive here on purpose. three adds `emissive * emissiveIntensity`
      // uniformly across a material, so an emissive housing would glow as hard
      // as the lens and the fixture would read as one hot blob.
      const material = new THREE.MeshStandardMaterial({
        color: tint,
        vertexColors: true,
        roughness: 0.42,
        metalness: 0.3,
      });
      const mesh = new THREE.InstancedMesh(beaconGeometry(THREE), material, limited.length);
      mesh.name = `heat-beacons-${tierIndex}`;
      mesh.raycast = () => {};

      const matrix = new THREE.Matrix4();
      limited.forEach((beacon, index) => {
        const spread = Math.min(2.2, Math.max(0.7, Math.min(beacon.width, beacon.depth) * 0.35));
        const x = beacon.x + beacon.width * 0.18;
        const z = beacon.z + beacon.depth * 0.18;
        matrix.makeScale(spread, spread, spread);
        matrix.setPosition(x, beacon.height, z);
        mesh.setMatrixAt(index, matrix);
        // The lamp sits at y = 0.915 in the beacon's own unit space.
        const target = tierIndex === 0 ? steady : warning;
        glowColour.set(tier.emissive);
        target.positions.push(x, beacon.height + 0.915 * spread, z);
        target.colours.push(glowColour.r, glowColour.g, glowColour.b);
      });
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
    });

    for (const [target, blinking] of [[steady, false], [warning, true]]) {
      if (!target.positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(target.positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(target.colours, 3));
      const material = new THREE.PointsMaterial({
        size: 2.6,
        map: makeGlowTexture(THREE),
        vertexColors: true,
        transparent: true,
        opacity: blinking ? 0.85 : 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
        toneMapped: false,
      });
      const glow = new THREE.Points(geometry, material);
      // Named under `heat-beacons` so the Keys layer switch takes the glow with
      // the fixtures -- a glow left burning over a hidden beacon would lie.
      glow.name = blinking ? 'heat-beacons-glow-warning' : 'heat-beacons-glow-steady';
      glow.raycast = () => {};
      this.group.add(glow);
      this._beaconGlow.push({ material, opacity: material.opacity, blinking });
    }
  }

  /**
   * Blink the obstruction lights, the way the real ones blink.
   *
   * `seconds` is any monotonic render clock. The dim band stays lit -- a steady
   * grey beacon is the "somewhat active" signal -- while the amber and red
   * warning bands breathe, which is what separates them from one another.
   */
  setBeaconPulse(seconds) {
    if (!this._beaconGlow) return;
    const wave = 0.5 + 0.5 * Math.sin(seconds * 2.2);
    for (const entry of this._beaconGlow) {
      entry.material.opacity = entry.blinking
        ? entry.opacity * (0.3 + 0.7 * wave)
        : entry.opacity;
    }
  }

  /**
   * Re-tint every building by a different lens: archetype (the default,
   * matching how `build()` colours things), language, or author. The legend
   * panel is expected to switch its key to match (see main.js::renderLegend).
   *
   * Rewrites `baseColors` itself, not just the live instance colour, so a
   * hover highlight or an active filter reverts to the *new* lens rather than
   * snapping back to archetype colours.
   */
  recolour(lens) {
    const THREE = this.THREE;
    const manifest = this.source.manifest;
    const authorTint = Boolean(manifest.flags && manifest.flags.authorship);
    const colour = new THREE.Color();

    for (const [uuid, members] of this.records) {
      const mesh = this.meshes.get(uuid);
      if (!mesh || !mesh.userData.baseColors) continue;
      const archetype = mesh.name.replace(/^buildings-/, '').replace(/-far$/, '');
      const base = mesh.userData.baseColors;
      members.forEach((building, index) => {
        if (lens === 'language') {
          const lang = this.source.s(building.language);
          colour.copy(lang ? new THREE.Color().setHSL(hueFor(lang), 0.5, 0.55) : new THREE.Color(0x777777));
        } else if (lens === 'author') {
          const author = authorTint ? this.source.s(building.author) : '';
          colour.copy(author ? new THREE.Color().setHSL(hueFor(author), 0.45, 0.55) : new THREE.Color(0x777777));
        } else if (lens === 'era') {
          // Brick (old) -> concrete (mid) -> glass (new), a tertile of the
          // building's own age relative to the rest of the repo (S3).
          const ERA_COLOURS = { old: 0x8a5a44, mid: 0x8f97a3, new: 0xbfe3ef };
          colour.copy(new THREE.Color(ERA_COLOURS[building.era] || ERA_COLOURS.mid));
        } else if (lens === 'heat') {
          // Cool grey (stable) through amber to red (hottest): recent,
          // decay-weighted churn, not lifetime totals (S4).
          const value = Math.max(0, Math.min(1, building.heat || 0));
          colour.copy(new THREE.Color(0x4b5563).lerp(new THREE.Color(0xff4d2e), value));
        } else if (lens === 'downtown') {
          const centrality = Math.max(0, Math.min(1, building.centrality || 0));
          colour.copy(new THREE.Color(0x2a2c31).lerp(new THREE.Color(0x8fd6ff), centrality));
        } else {
          const author = authorTint ? this.source.s(building.author) : '';
          colour.copy(tintFor(THREE, ARCHETYPE_COLORS[archetype] || 0x777777, author, author ? 0.45 : 0));
          const downtownEligible = Boolean(manifest.flags && manifest.flags.downtown);
          if (downtownEligible && building.downtown) colour.lerp(new THREE.Color(0x8fd6ff), 0.4);
        }
        base[index * 3] = colour.r;
        base[index * 3 + 1] = colour.g;
        base[index * 3 + 2] = colour.b;
        mesh.setColorAt(index, colour);
      });
      mesh.instanceColor.needsUpdate = true;
    }
    // A filter's ghosting is relative to baseColors; redraw it against the
    // lens that just changed underneath it, rather than losing it.
    if (this._filtered) this.applyFilter(this._filtered.matchingIds);
  }

  /**
   * Ghost every building that does not match a filter, so "every README.md"
   * or "every .py file" reads at a glance without waiting for a rebuild.
   *
   * Same revertible-colour technique as `highlightDistrict`, run in the
   * opposite direction: matches keep their real colour, everything else is
   * lerped toward a dim, desaturated grey. `matchingIds` is a Set of building
   * ids (resident buildings only -- the id space is global, but a building
   * not currently loaded has no instance to dim).
   */
  applyFilter(matchingIds) {
    this.clearFilter();
    if (!matchingIds) return;
    const THREE = this.THREE;
    const ghost = new THREE.Color(0x2a2c31);
    const touched = [];

    for (const [uuid, members] of this.records) {
      const mesh = this.meshes.get(uuid);
      if (!mesh || !mesh.userData.baseColors) continue;
      const base = mesh.userData.baseColors;
      let any = false;
      members.forEach((building, index) => {
        if (matchingIds.has(building.id)) return;
        mesh.setColorAt(
          index,
          new THREE.Color(base[index * 3], base[index * 3 + 1], base[index * 3 + 2]).lerp(ghost, 0.82)
        );
        touched.push({ mesh, index });
        any = true;
      });
      if (any) mesh.instanceColor.needsUpdate = true;
    }
    this._filtered = { matchingIds, touched };
  }

  clearFilter() {
    const previous = this._filtered;
    if (!previous) return;
    this._filtered = null;
    const byMesh = new Map();
    for (const { mesh, index } of previous.touched) {
      if (!byMesh.has(mesh)) byMesh.set(mesh, []);
      byMesh.get(mesh).push(index);
    }
    for (const [mesh, indices] of byMesh) {
      const base = mesh.userData.baseColors;
      if (!base) continue;
      for (const index of indices) {
        mesh.setColorAt(
          index,
          new this.THREE.Color(base[index * 3], base[index * 3 + 1], base[index * 3 + 2])
        );
      }
      mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Scaffolding on every building born in the newest slice of the repo's
   * history -- "new buildings still have scaffolding up" (S2). One instanced
   * mesh, matrices copied straight from the buildings themselves, so it
   * wraps each one exactly with no extra per-building draw call.
   */
  _addScaffolding(matrices) {
    if (!matrices.length) return;
    const THREE = this.THREE;
    const material = new THREE.MeshStandardMaterial({
      color: 0xe8b04b,
      roughness: 0.6,
      metalness: 0.5,
      transparent: true,
      opacity: 0.85,
    });
    const mesh = new THREE.InstancedMesh(scaffoldingGeometry(THREE), material, matrices.length);
    mesh.name = 'scaffolding';
    // Scenery around the building, not a separate click target.
    mesh.raycast = () => {};
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /**
   * Antennas on downtown buildings -- the top slice of centrality (S8),
   * placed at each building's own roofline, one instanced mesh regardless of
   * how many towers the skyline's centre has.
   */
  _addAntennas(candidates) {
    if (!candidates.length) return;
    const THREE = this.THREE;
    const material = new THREE.MeshStandardMaterial({
      color: 0xd8ecf5,
      roughness: 0.3,
      metalness: 0.6,
      emissive: new THREE.Color(0xff5533),
      emissiveIntensity: 0.4,
    });
    const mesh = new THREE.InstancedMesh(antennaGeometry(THREE), material, candidates.length);
    mesh.name = 'antennas';
    mesh.raycast = () => {};
    const matrix = new THREE.Matrix4();
    candidates.forEach((tower, index) => {
      const spread = Math.min(tower.width, tower.depth) * 0.5;
      matrix.makeScale(spread, Math.max(4, spread * 3), spread);
      matrix.setPosition(tower.x, tower.height, tower.z);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /**
   * A small flag at one corner of every bus-factor-1 building's plot (S12):
   * one author owns almost all of it, and enough commits that it is not just
   * a file nobody else happened to touch yet.
   */
  _addSoleTenantMarkers(candidates) {
    if (!candidates.length) return;
    const THREE = this.THREE;
    const material = new THREE.MeshStandardMaterial({
      color: 0xd44b4b,
      roughness: 0.7,
      metalness: 0.1,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.InstancedMesh(soleTenantMarkerGeometry(THREE), material, candidates.length);
    mesh.name = 'sole-tenant-markers';
    mesh.raycast = () => {};
    const matrix = new THREE.Matrix4();
    const rotation = new THREE.Matrix4();
    const scaleMatrix = new THREE.Matrix4();
    candidates.forEach((plot, index) => {
      const scale = Math.min(2.2, Math.max(0.9, Math.min(plot.width, plot.depth) * 0.3));
      scaleMatrix.makeScale(scale, scale, scale);
      // The pennant is a flat plane; a fixed orientation would face the same
      // way on every plot and vanish edge-on from most camera angles. A
      // per-instance rotation keeps it a visible triangle more often, the
      // way real flags on real poles do not all point one direction.
      rotation.makeRotationY(seedOffset(plot.width + plot.depth + index) * Math.PI * 2);
      matrix.multiplyMatrices(rotation, scaleMatrix);
      matrix.setPosition(plot.x + 0.6, 0, plot.z + 0.6);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  _addGround(bx, bz, bw, bh, buildings) {
    const THREE = this.THREE;
    const pad = Math.max(40, Math.max(bw, bh) * 0.18);
    const texture = makeGroundTexture(THREE);
    texture.repeat.set(Math.max(1, bw / 24), Math.max(1, bh / 24));
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(bw + pad * 2, bh + pad * 2),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(bx + bw / 2, 0, bz + bh / 2);
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.group.add(ground);
  }

  _addStreets(streets) {
    if (!streets.length) return;
    const THREE = this.THREE;
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x2b3140,
      roughness: 0.9,
      metalness: 0.05,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, streets.length);
    mesh.name = 'streets';
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    streets.forEach(([x, z, w, h], index) => {
      matrix.makeScale(w, 1, h);
      matrix.setPosition(x + w / 2, 0.06, z + h / 2);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /** A thin plate under each district so blocks read as blocks. */
  _addDistricts(districts) {
    if (!districts.length) return;
    const THREE = this.THREE;
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      color: 0x1d2330,
      roughness: 1,
      metalness: 0,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, districts.length);
    mesh.name = 'district-plates';
    mesh.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    const white = new THREE.Color(0xffffff);
    // Ground heat (S5): a district's pavement warms in proportion to its own
    // share of recent activity, only when churn itself means anything --
    // "this neighbourhood is under active development", relative to its own
    // buildings, not the whole city. The instance colour multiplies the
    // plate's base tint, so heat 0 stays exactly today's plain grey plate.
    const churnEligible = Boolean(this.source.manifest.flags && this.source.manifest.flags.churn);
    const heatColour = new THREE.Color(0xff9046);
    const colour = new THREE.Color();
    districts.forEach((district, index) => {
      const [x, z, w, h] = district.rect;
      matrix.makeScale(w, 1, h);
      matrix.setPosition(x + w / 2, 0.03, z + h / 2);
      mesh.setMatrixAt(index, matrix);
      colour.copy(white);
      if (churnEligible && district.heat) {
        colour.lerp(heatColour, Math.min(1, district.heat) * 0.7);
      }
      mesh.setColorAt(index, colour);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.userData.baseColors = Float32Array.from(mesh.instanceColor.array);
    // instanceId -> district, so a plate under the cursor is a folder you can
    // inspect like any other repository entity.
    mesh.userData.districts = districts;
    this.group.add(mesh);
  }

  /** Scale every building's glow together with the time-of-day control. */
  setNightFactor(factor) {
    this.group.children.forEach((child) => {
      if (child.isInstancedMesh && child.material && child.material.emissiveIntensity !== undefined) {
        if (child.name.startsWith('buildings-')) {
          child.material.emissiveIntensity = factor;
        }
      }
    });
  }

  /**
   * Highlight one instance, and only one.
   *
   * Two channels change together: the instance colour brightens toward the
   * accent, and its lit-window scalar jumps, so the hovered building reads as
   * interactive by day and glows brighter at dusk -- without touching any other
   * building, and without a second draw call.
   */
  setHighlight(mesh, instanceId, strength = 0.62) {
    if (this._hover && (this._hover.mesh !== mesh || this._hover.instanceId !== instanceId)) {
      this.clearHighlight();
    }
    if (!mesh || instanceId === undefined || instanceId === null) return;
    if (!mesh.userData.baseColors) return;

    const THREE = this.THREE;
    const base = mesh.userData.baseColors;
    const accent = new THREE.Color(0xffc978);
    const colour = new THREE.Color(
      base[instanceId * 3],
      base[instanceId * 3 + 1],
      base[instanceId * 3 + 2]
    );
    colour.lerp(accent, strength);
    mesh.setColorAt(instanceId, colour);
    mesh.instanceColor.needsUpdate = true;

    // Buildings carry a hover channel; plates and impostors do not.
    const traits = mesh.geometry.getAttribute('aTraits');
    if (traits) {
      traits.setW(instanceId, 1);
      traits.needsUpdate = true;
    }

    this._hover = { mesh, instanceId };
  }

  clearHighlight() {
    const hover = this._hover;
    if (!hover) return;
    this._hover = null;
    const { mesh, instanceId } = hover;
    const base = mesh.userData.baseColors;
    if (base && mesh.instanceColor) {
      mesh.setColorAt(
        instanceId,
        new this.THREE.Color(
          base[instanceId * 3],
          base[instanceId * 3 + 1],
          base[instanceId * 3 + 2]
        )
      );
      mesh.instanceColor.needsUpdate = true;
    }
    const traits = mesh.geometry.getAttribute('aTraits');
    if (traits) {
      traits.setW(instanceId, 0);
      traits.needsUpdate = true;
    }
  }

  /**
   * Light up every building that belongs to one district.
   *
   * A district is a folder, so "look at this" means "look at all of these", and
   * one instance colour write per building says it far more clearly than an
   * outline around a hundred metres of ground.
   */
  highlightDistrict(districtId, strength = 0.38) {
    this.clearDistrictHighlight();
    const THREE = this.THREE;
    const accent = new THREE.Color(0xffc978);
    const touched = [];

    for (const [uuid, members] of this.records) {
      const mesh = this.meshes.get(uuid);
      if (!mesh || !mesh.userData.baseColors) continue;
      const base = mesh.userData.baseColors;
      // Same honest channel as the single-building highlight: a folder being
      // pointed out must not make every file in it look documented.
      const hoverAttribute = mesh.geometry.getAttribute('aTraits');
      let any = false;
      members.forEach((building, index) => {
        if (building.districtId !== districtId) return;
        mesh.setColorAt(
          index,
          new THREE.Color(base[index * 3], base[index * 3 + 1], base[index * 3 + 2]).lerp(
            accent,
            strength
          )
        );
        if (hoverAttribute) {
          touched.push({ hoverAttribute, index });
          hoverAttribute.setW(index, 0.55);
        }
        any = true;
      });
      if (any) {
        mesh.instanceColor.needsUpdate = true;
        if (hoverAttribute) hoverAttribute.needsUpdate = true;
      }
    }
    this._districtHighlight = { districtId, meshCount: this.records.size, marked: touched };
  }

  clearDistrictHighlight() {
    const previous = this._districtHighlight;
    if (!previous) return;
    this._districtHighlight = null;
    for (const entry of previous.marked || []) {
      entry.hoverAttribute.setW(entry.index, 0);
      entry.hoverAttribute.needsUpdate = true;
    }
    for (const [uuid, members] of this.records) {
      const mesh = this.meshes.get(uuid);
      if (!mesh || !mesh.userData.baseColors) continue;
      const base = mesh.userData.baseColors;
      let any = false;
      members.forEach((building, index) => {
        if (building.districtId !== previous.districtId) return;
        mesh.setColorAt(
          index,
          new this.THREE.Color(base[index * 3], base[index * 3 + 1], base[index * 3 + 2])
        );
        any = true;
      });
      if (any) mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Set the emissive strength for every building at once.
   *
   * Per-building differences are baked into the `aTraits` instanced attribute;
   * this is the single global multiplier the "lit windows" slider drives.
   */
  setGlow(value) {
    this.group.children.forEach((child) => {
      if (child.isInstancedMesh && child.name.startsWith('buildings-')) {
        child.material.emissiveIntensity = value;
      }
    });
  }

  /**
   * Show or hide one named prop cluster -- `cranes`, `heat-beacons`,
   * `scaffolding`, `sole-tenant-markers`.
   *
   * Each of those is its own InstancedMesh, so switching one off by hand is a
   * visibility change rather than a rebuild: only the encodings baked into the
   * building instances (tint, weathering, lit windows, downtown glass) need the
   * city rebuilt. Matching is by name prefix because the beacons are split into
   * one mesh per tier.
   */
  setLayerVisible(target, visible) {
    this.group.traverse((node) => {
      const drawable = node.isMesh || node.isPoints;
      if (drawable && typeof node.name === 'string' && node.name.startsWith(target)) {
        node.visible = visible;
      }
    });
  }
}

/**
 * The City Hall landmark.
 *
 * This is the one building in the city that is not a file: it is the repo's own
 * report card, standing at the centre of the plan. Walk up to it and press E,
 * or press C from anywhere.
 */
/**
 * A wireframe outline that snaps onto whatever is under the cursor.
 *
 * One reusable object rather than per-building geometry, so hovering stays
 * O(1) no matter how many buildings the city has.
 */
export function createHoverOutline(THREE) {
  const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
  geometry.translate(0, 0.5, 0);
  const material = new THREE.LineBasicMaterial({
    color: 0xffc978,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
  });
  const outline = new THREE.LineSegments(geometry, material);
  outline.name = 'hover-outline';
  outline.renderOrder = 999;
  outline.visible = false;
  outline.frustumCulled = false;
  return outline;
}

/**
 * One InstancedMesh from a placement list.
 *
 * The landmark is a few hundred small solids -- pilasters, capitals, acroteria
 * -- and batching them by material keeps the whole hall at a handful of draw
 * calls instead of a few hundred. A placement is
 * `[x, y, z, sx, sy, sz, rx, ry, rz]`; rotation is optional and defaults to none.
 */
function instancePlacements(THREE, geometry, material, placements) {
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const matrix = new THREE.Matrix4();
  placements.forEach((place, index) => {
    position.set(place[0], place[1], place[2]);
    scale.set(place[3], place[4], place[5]);
    euler.set(place[6] || 0, place[7] || 0, place[8] || 0);
    quaternion.setFromEuler(euler);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Concentric paving and an avenue cross, so the plaza is ground, not a disc. */
function makePlazaTexture(THREE) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.fillStyle = '#2f3542';
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.translate(c, c);
  ctx.strokeStyle = 'rgba(216,201,164,0.20)';
  for (let r = 40; r < c; r += 34) {
    ctx.lineWidth = r % 68 === 40 ? 3 : 1.4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(216,201,164,0.11)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 24; i += 1) {
    const a = (i / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 40, Math.sin(a) * 40);
    ctx.lineTo(Math.cos(a) * c, Math.sin(a) * c);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(216,201,164,0.16)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(-c, 0);
  ctx.lineTo(c, 0);
  ctx.moveTo(0, -c);
  ctx.lineTo(0, c);
  ctx.stroke();
  ctx.restore();
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

/** A painted clock face for the tower, so the landmark tells the hour twice a day. */
function makeClockTexture(THREE) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = size / 2;
  ctx.fillStyle = '#f2ead6';
  ctx.beginPath();
  ctx.arc(c, c, c, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#8c6f3f';
  ctx.lineWidth = size * 0.055;
  ctx.beginPath();
  ctx.arc(c, c, c * 0.94, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#2b2b2b';
  ctx.lineCap = 'round';
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    const inner = c * (i % 3 === 0 ? 0.68 : 0.76);
    const outer = c * 0.86;
    ctx.lineWidth = i % 3 === 0 ? size * 0.03 : size * 0.014;
    ctx.beginPath();
    ctx.moveTo(c + Math.sin(a) * inner, c - Math.cos(a) * inner);
    ctx.lineTo(c + Math.sin(a) * outer, c - Math.cos(a) * outer);
    ctx.stroke();
  }
  ctx.fillStyle = '#2b2b2b';
  const hand = (turns, length, width) => {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(turns * Math.PI * 2);
    ctx.fillRect(-width / 2, -length, width, length);
    ctx.restore();
  };
  hand(10.17 / 12, c * 0.44, size * 0.036);
  hand(10 / 60, c * 0.66, size * 0.022);
  ctx.beginPath();
  ctx.arc(c, c, size * 0.03, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}

export function createCityHall(THREE, bounds, maxHeight, hall = null) {
  const group = new THREE.Group();
  group.name = 'city-hall';
  const [bx, bz, bw, bh] = bounds;
  // The analyzer reserves a plaza and emits exactly where the landmark stands and
  // how big it is, so the massing here and the reserved ground there cannot drift
  // apart. The old centre-of-the-plan derivation stays as a fallback for
  // manifests built before the reserve existed -- those may still have buildings
  // standing on the spot.
  const centre = hall && hall.centre ? hall.centre : [bx + bw / 2, bz + bh / 2];
  const cx = centre[0];
  const cz = centre[1];
  const scale = hall && hall.scale
    ? hall.scale
    : Math.max(1.6, Math.min(4.5, maxHeight / 34));

  const stone = new THREE.MeshStandardMaterial({ color: 0xd8c9a4, roughness: 0.75, metalness: 0.05 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xb99f6b, roughness: 0.6, metalness: 0.15 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x8c6f3f, roughness: 0.5, metalness: 0.3 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x1d2a42,
    roughness: 0.25,
    metalness: 0.15,
    emissive: 0xffc978,
    emissiveIntensity: 0.3,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0xffc978,
    emissive: 0xffb347,
    emissiveIntensity: 1.1,
  });

  // The hall is laid out in its own frame, front facing -Z, and then the whole
  // group is dropped onto the reserved centre and scaled to the plaza. Working
  // in local units keeps the dimensions readable against each other.
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitColumn = new THREE.CylinderGeometry(1, 1, 1, 16);
  const unitCone = new THREE.ConeGeometry(1, 1, 12);
  const unitSphere = new THREE.SphereGeometry(1, 12, 10);
  const unitPlane = new THREE.PlaneGeometry(1, 1);

  const stoneBoxes = [];
  const trimBoxes = [];
  const roofBoxes = [];
  const glassBoxes = [];
  const columns = [];
  const colonnade = [];
  const trimColumns = [];
  const roofCones = [];
  const trimCones = [];
  const glows = [];
  const clockFaces = [];

  // Podium: two tiers, the lower one exactly the footprint the analyzer reserved.
  stoneBoxes.push([0, 0.7, 0, 30, 1.4, 20]);
  stoneBoxes.push([0, 2.0, 0, 27, 1.2, 18]);

  // A grand flight down the front; each step shallower as it rises.
  for (let i = 0; i < 6; i += 1) {
    const top = (2.6 * (i + 1)) / 6;
    const far = -11.4 + i * 0.55;
    stoneBoxes.push([0, top / 2, (far - 8.6) / 2, 17 - i * 0.4, top, -8.6 - far]);
  }

  // The body: a windowed block, pilastered, with a hooded entrance.
  stoneBoxes.push([0, 6.1, 1.8, 20, 7.0, 14]);
  for (const sx of [-1, 1]) {
    for (const z of [-4.8, 8.4]) {
      trimBoxes.push([sx * 10.05, 6.1, z, 0.5, 7.2, 1.0]);
    }
    for (const z of [-3.8, -1.2, 1.4, 4.0, 6.6]) {
      trimBoxes.push([sx * 10.05, 6.1, z, 0.5, 7.2, 0.9]);
    }
    for (const z of [-2.5, 0.1, 2.7, 5.3]) {
      glassBoxes.push([sx * 10.12, 6.2, z, 0.18, 3.9, 1.3]);
    }
  }
  for (const x of [-8.2, -4.1, 0, 4.1, 8.2]) {
    trimBoxes.push([x, 6.1, 8.85, 0.9, 7.2, 0.5]);
  }
  for (const x of [-6.1, -2.0, 2.0, 6.1]) {
    glassBoxes.push([x, 6.2, 8.85, 1.3, 3.9, 0.18]);
  }
  roofBoxes.push([0, 4.6, -5.3, 3.6, 4.0, 0.25]);
  trimBoxes.push([-1.95, 4.7, -5.32, 0.4, 4.2, 0.3]);
  trimBoxes.push([1.95, 4.7, -5.32, 0.4, 4.2, 0.3]);
  trimBoxes.push([0, 6.95, -5.35, 4.8, 0.5, 0.4]);
  glassBoxes.push([-4.2, 6.2, -5.25, 1.3, 3.9, 0.18]);
  glassBoxes.push([4.2, 6.2, -5.25, 1.3, 3.9, 0.18]);

  // Colonnade of eight, standing proud of the wall and carrying the entablature.
  // The shafts are the darker trim tone, so the colonnade separates from the
  // wall behind it instead of reading as one flat facade.
  const columnCount = 8;
  const columnSpread = 19;
  for (let i = 0; i < columnCount; i += 1) {
    const x = (i - (columnCount - 1) / 2) * (columnSpread / (columnCount - 1));
    colonnade.push([x, 6.1, -7.2, 0.62, 7.0, 0.62]);
    stoneBoxes.push([x, 2.8, -7.2, 1.5, 0.4, 1.5]);
    trimBoxes.push([x, 9.35, -7.2, 1.6, 0.5, 1.6]);
  }

  // Entablature: architrave, frieze and a cornice wide enough to roof the colonnade.
  stoneBoxes.push([0, 10.0, 1.2, 21, 0.8, 17.8]);
  trimBoxes.push([0, 10.9, 1.2, 21, 1.0, 17.8]);
  stoneBoxes.push([0, 11.75, 1.2, 22.4, 0.7, 18.6]);

  // A real gable over the colonnade: a triangular prism with a raking cornice,
  // a medallion in the tympanum, and acroteria on its three points.
  const pedimentShape = new THREE.Shape();
  pedimentShape.moveTo(-11.2, 0);
  pedimentShape.lineTo(11.2, 0);
  pedimentShape.lineTo(0, 3.4);
  pedimentShape.closePath();
  const pediment = new THREE.Mesh(
    new THREE.ExtrudeGeometry(pedimentShape, { depth: 6.0, bevelEnabled: false }),
    roof
  );
  pediment.position.set(0, 12.1, -8.3);
  pediment.castShadow = true;
  pediment.receiveShadow = true;
  group.add(pediment);

  // The doorway gets its own small gable, so the entrance reads as the entrance.
  const doorShape = new THREE.Shape();
  doorShape.moveTo(-2.4, 0);
  doorShape.lineTo(2.4, 0);
  doorShape.lineTo(0, 1.0);
  doorShape.closePath();
  const doorPediment = new THREE.Mesh(
    new THREE.ExtrudeGeometry(doorShape, { depth: 0.7, bevelEnabled: false }),
    trim
  );
  doorPediment.position.set(0, 6.95, -5.5);
  doorPediment.castShadow = true;
  group.add(doorPediment);

  const raking = Math.atan2(3.4, 11.2);
  trimBoxes.push([-5.6, 13.8, -8.55, 11.7, 0.5, 0.5, 0, 0, raking]);
  trimBoxes.push([5.6, 13.8, -8.55, 11.7, 0.5, 0.5, 0, 0, -raking]);
  trimBoxes.push([0, 12.25, -8.55, 23, 0.35, 0.6]);
  trimColumns.push([0, 13.3, -8.6, 1.0, 0.4, 1.0, Math.PI / 2, 0, 0]);
  trimCones.push([0, 16.0, -7.1, 0.5, 1.0, 0.5]);
  trimCones.push([-11.2, 12.6, -7.1, 0.45, 0.9, 0.45]);
  trimCones.push([11.2, 12.6, -7.1, 0.45, 0.9, 0.45]);

  // The tower: clock stage, open belfry, drum and dome -- the silhouette the
  // rest of the city navigates by.
  const towerZ = 3.5;
  stoneBoxes.push([0, 12.35, towerZ, 21, 0.5, 9.6]);
  stoneBoxes.push([0, 13.1, towerZ, 10, 1.2, 10]);
  stoneBoxes.push([0, 18.7, towerZ, 8, 10, 8]);
  for (const sx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      trimBoxes.push([sx * 3.7, 18.7, towerZ + dz * 3.7, 0.7, 10, 0.7]);
    }
  }
  trimBoxes.push([0, 16.0, towerZ, 8.4, 0.4, 8.4]);

  for (const [nx, nz, ry] of [[0, -1, Math.PI], [0, 1, 0], [-1, 0, -Math.PI / 2], [1, 0, Math.PI / 2]]) {
    const wide = nz !== 0;
    trimBoxes.push([
      nx * 4.03, 21.0, towerZ + nz * 4.03,
      wide ? 4.0 : 0.2, 4.0, wide ? 0.2 : 4.0,
    ]);
    clockFaces.push([nx * 4.16, 21.0, towerZ + nz * 4.16, 3.2, 3.2, 1, 0, ry, 0]);
  }

  stoneBoxes.push([0, 24.1, towerZ, 9.6, 0.8, 9.6]);
  trimBoxes.push([0, 24.6, towerZ, 9.9, 0.3, 9.9]);
  for (const sx of [-1, 1]) {
    for (const dz of [-1, 1]) {
      stoneBoxes.push([sx * 2.95, 26.15, towerZ + dz * 2.95, 1.1, 2.8, 1.1]);
    }
  }
  stoneBoxes.push([0, 27.9, towerZ, 8.6, 0.7, 8.6]);
  trimBoxes.push([0, 28.35, towerZ, 8.9, 0.2, 8.9]);

  columns.push([0, 29.35, towerZ, 3.1, 2.2, 3.1]);
  for (let i = 0; i < 8; i += 1) {
    const a = (i / 8) * Math.PI * 2;
    columns.push([Math.cos(a) * 3.0, 29.3, towerZ + Math.sin(a) * 3.0, 0.22, 2.0, 0.22]);
  }
  trimColumns.push([0, 30.6, towerZ, 3.5, 0.3, 3.5]);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(3.0, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    roof
  );
  dome.position.set(0, 30.75, towerZ);
  dome.castShadow = true;
  group.add(dome);

  trimColumns.push([0, 34.5, towerZ, 0.9, 1.5, 0.9]);
  roofCones.push([0, 35.65, towerZ, 1.15, 0.8, 1.15]);
  trimColumns.push([0, 36.5, towerZ, 0.12, 0.9, 0.12]);
  glows.push([0, 37.2, towerZ, 0.5, 0.5, 0.5]);

  // Plaza: reserved ground, paved, and not a raycast target. A wide disc left
  // raycastable swallowed every hover and click near the centre of the plan.
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(26, 64),
    new THREE.MeshStandardMaterial({ map: makePlazaTexture(THREE), roughness: 0.95 })
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(0, 0.09, 0);
  plaza.raycast = () => {};
  group.add(plaza);

  const curb = new THREE.Mesh(new THREE.RingGeometry(25.2, 26, 64), trim);
  curb.rotation.x = -Math.PI / 2;
  curb.position.set(0, 0.14, 0);
  curb.raycast = () => {};
  group.add(curb);

  for (let i = 0; i < 4; i += 1) {
    const a = Math.PI / 4 + i * (Math.PI / 2);
    const x = Math.cos(a) * 21;
    const z = Math.sin(a) * 21;
    trimColumns.push([x, 2.0, z, 0.16, 4.0, 0.16]);
    glows.push([x, 4.2, z, 0.4, 0.4, 0.4]);
  }

  group.add(instancePlacements(THREE, unitBox, stone, stoneBoxes));
  group.add(instancePlacements(THREE, unitBox, trim, trimBoxes));
  group.add(instancePlacements(THREE, unitBox, roof, roofBoxes));
  group.add(instancePlacements(THREE, unitBox, glass, glassBoxes));
  group.add(instancePlacements(THREE, unitColumn, stone, columns));
  group.add(instancePlacements(THREE, unitColumn, trim, colonnade));
  group.add(instancePlacements(THREE, unitColumn, trim, trimColumns));
  group.add(instancePlacements(THREE, unitCone, roof, roofCones));
  group.add(instancePlacements(THREE, unitCone, trim, trimCones));
  group.add(instancePlacements(THREE, unitSphere, glow, glows));
  group.add(instancePlacements(
    THREE,
    unitPlane,
    new THREE.MeshStandardMaterial({ map: makeClockTexture(THREE), roughness: 0.5, metalness: 0.05 }),
    clockFaces
  ));

  group.position.set(cx, 0, cz);
  group.scale.setScalar(scale);

  // The same rectangle the analyzer kept clear, so what walk mode collides with
  // is exactly the ground no building was put on.
  const footprint = hall && hall.footprint
    ? {
        x0: hall.footprint[0],
        z0: hall.footprint[1],
        x1: hall.footprint[0] + hall.footprint[2],
        z1: hall.footprint[1] + hall.footprint[3],
      }
    : { x0: cx - 15 * scale, z0: cz - 10 * scale, x1: cx + 15 * scale, z1: cz + 10 * scale };

  group.userData = {
    centre: new THREE.Vector3(cx, 0, cz),
    radius: hall && hall.plazaRadius ? hall.plazaRadius : 30 * scale,
    // Occupies the plan so walk mode cannot stand inside it.
    box: {
      id: -1,
      rel: '__city_hall__',
      ...footprint,
      height: 38 * scale,
      isCityHall: true,
    },
  };
  return group;
}

/**
 * L3 impostors: one box per district that is not currently resident.
 *
 * Chunk streaming keeps a bounded working set, which would otherwise leave a
 * hard edge where the loaded city stops. A single impostor box per unloaded
 * district -- sized from the manifest's own skyline envelope and maximum
 * height -- fills the horizon for one extra draw call, no matter how many
 * districts are missing.
 */
export function createImpostors(THREE, manifest, residentIds) {
  const missing = manifest.districts.filter((d) => !residentIds.has(d.id));
  if (!missing.length) return null;

  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  const material = new THREE.MeshStandardMaterial({
    color: 0x59637a,
    roughness: 0.95,
    metalness: 0.05,
    emissive: new THREE.Color(0x2a2f3d),
    emissiveIntensity: 1,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, missing.length);
  mesh.name = 'district-impostors';
  const matrix = new THREE.Matrix4();
  const white = new THREE.Color(0xffffff);

  missing.forEach((district, index) => {
    const [x, z, w, h] = district.rect;
    const envelope = district.skyline.envelope || [10, 10];
    // One massing block standing in for the district's skyline: wide enough to
    // read as a block, tall enough to read as its tallest building.
    const width = Math.max(8, Math.min(w * 0.7, envelope[0] * 3));
    const depth = Math.max(8, Math.min(h * 0.7, envelope[1] * 3));
    const height = Math.max(6, district.skyline.maxHeight * 0.85);
    matrix.makeScale(width, height, depth);
    matrix.setPosition(x + w / 2, 0, z + h / 2);
    mesh.setMatrixAt(index, matrix);
    mesh.setColorAt(index, white);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.userData.baseColors = Float32Array.from(mesh.instanceColor.array);
  mesh.userData.districts = missing;
  return mesh;
}

/**
 * A marker for a whole district, used to show what is being talked about.
 *
 * A district is not one object -- it is a folder -- so it gets a ground outline
 * and a translucent slab rather than a highlight on a single mesh.
 */
export function createDistrictMarker(THREE) {
  const group = new THREE.Group();
  group.name = 'district-marker';
  group.visible = false;
  group.renderOrder = 998;

  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      color: 0xffc978,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
  );
  fill.rotation.x = -Math.PI / 2;
  fill.renderOrder = 998;
  group.add(fill);

  const loop = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(1, 0, 1),
      new THREE.Vector3(0, 0, 1),
    ]),
    // Drawn through buildings on purpose: a district boundary should read even
    // when towers stand on it. The fill stays depth-tested so it never paints
    // over the city.
    new THREE.LineBasicMaterial({
      color: 0xffc978,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    })
  );
  loop.renderOrder = 1000;
  group.add(loop);

  group.userData.outline = loop;
  group.userData.fill = fill;
  return group;
}

/** Place a district marker over a district rect, raised just above the plate. */
export function placeDistrictMarker(marker, rect, y = 0.16) {
  const [x, z, w, h] = rect;
  marker.position.set(x, y, z);
  marker.userData.outline.scale.set(w, 1, h);
  marker.userData.fill.scale.set(w, 1, h);
  marker.userData.fill.position.set(w / 2, 0, h / 2);
  marker.userData.outline.position.set(0, 0, 0);
  marker.visible = true;
}
