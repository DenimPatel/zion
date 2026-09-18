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

import { farGeometry, nearGeometry, roofPropGeometry } from './shapes.js';
import {
  makeMassingDepthMaterial,
  patchFacade,
  patchRoofProps,
  seedFor,
  styleFor,
} from './facade.js';

/** Archetypes whose walls are walls. Parks and monuments get stone, not glass. */
const WINDOWED = new Set(['tower', 'slab', 'warehouse', 'silo', 'town_hall', 'ruin']);

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

    const authorTint = Boolean(manifest.flags && manifest.flags.authorship);
    const litCap = options.litCap === undefined ? 1 : options.litCap;

    // Level of detail: one instanced mesh per archetype per tier, so draw calls
    // scale with archetypes, never with building count. Distant buildings keep
    // their facade and their glow -- the metaphor must survive at range, and
    // the shader averages the window grid rather than dropping it -- but fall
    // back to box massing, which is where the triangles actually go.
    const lodNear = options.lodNear !== undefined
      ? options.lodNear
      : Math.min(1800, Math.max(240, Math.max(bw, bh) * 0.75));
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
    const weathering = Boolean(manifest.flags && manifest.flags.recency);

    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();
    const roofCandidates = [];

    for (const [archetype, tiers] of byArchetype) {
      for (const tier of ['near', 'far']) {
      const members = tiers[tier];
      if (!members.length) continue;
      const detailed = tier === 'near';
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: archetype === 'park' ? 0.95 : 0.72,
        metalness: archetype === 'monument' ? 0.35 : 0.08,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0,
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
        const width = building.width || 4;
        const depth = building.depth || 4;
        const height = building.height || 3;
        const x = (building.x || 0) + width / 2;
        const z = (building.y || 0) + depth / 2;
        matrix.makeScale(width, height, depth);
        matrix.setPosition(x, 0, z);
        mesh.setMatrixAt(index, matrix);

        const author = authorTint ? this.source.s(building.author) : '';
        colour.copy(tintFor(THREE, ARCHETYPE_COLORS[archetype] || 0x777777, author, author ? 0.45 : 0));
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
    districts.forEach((district, index) => {
      const [x, z, w, h] = district.rect;
      matrix.makeScale(w, 1, h);
      matrix.setPosition(x + w / 2, 0.03, z + h / 2);
      mesh.setMatrixAt(index, matrix);
      mesh.setColorAt(index, white);
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

export function createCityHall(THREE, bounds, maxHeight) {
  const group = new THREE.Group();
  group.name = 'city-hall';
  const [bx, bz, bw, bh] = bounds;
  const cx = bx + bw / 2;
  const cz = bz + bh / 2;
  const scale = Math.max(1.6, Math.min(4.5, maxHeight / 34));

  const stone = new THREE.MeshStandardMaterial({ color: 0xd8c9a4, roughness: 0.75, metalness: 0.05 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xb99f6b, roughness: 0.6, metalness: 0.15 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x8c6f3f, roughness: 0.5, metalness: 0.3 });

  // A plaza so the landmark reads as public ground rather than a plot.
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(26 * scale, 48),
    new THREE.MeshStandardMaterial({ color: 0x3a3f4c, roughness: 1 })
  );
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.set(cx, 0.09, cz);
  // The plaza is ground, not a target. Leaving it raycastable made a wide disc
  // at the centre of the plan swallow every hover and click near it.
  plaza.raycast = () => {};
  group.add(plaza);

  // Stepped base.
  const base = new THREE.Mesh(new THREE.BoxGeometry(30 * scale, 2.2 * scale, 20 * scale), stone);
  base.position.set(cx, 1.1 * scale, cz);
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const steps = new THREE.Mesh(new THREE.BoxGeometry(24 * scale, 3.4 * scale, 16 * scale), stone);
  steps.position.set(cx, 3.9 * scale, cz);
  steps.castShadow = true;
  group.add(steps);

  // Colonnade front.
  const columnGeometry = new THREE.CylinderGeometry(0.85 * scale, 0.85 * scale, 6.4 * scale, 12);
  const columnCount = 6;
  const columns = new THREE.InstancedMesh(columnGeometry, trim, columnCount);
  columns.castShadow = true;
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < columnCount; i++) {
    const offset = (i - (columnCount - 1) / 2) * 3.4 * scale;
    matrix.makeTranslation(cx + offset, 8.9 * scale, cz - 8 * scale);
    columns.setMatrixAt(i, matrix);
  }
  columns.instanceMatrix.needsUpdate = true;
  group.add(columns);

  const pediment = new THREE.Mesh(new THREE.BoxGeometry(24 * scale, 2.2 * scale, 16 * scale), roof);
  pediment.position.set(cx, 11.2 * scale, cz);
  pediment.castShadow = true;
  group.add(pediment);

  // A clock tower with a dome, to be visible from across the city.
  const tower = new THREE.Mesh(new THREE.BoxGeometry(7 * scale, 14 * scale, 7 * scale), stone);
  tower.position.set(cx, 19.3 * scale, cz);
  tower.castShadow = true;
  group.add(tower);

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(4.4 * scale, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2),
    roof
  );
  dome.position.set(cx, 26.3 * scale, cz);
  dome.castShadow = true;
  group.add(dome);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(1.3 * scale, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xffc978, emissive: 0xffb347, emissiveIntensity: 1.1 })
  );
  beacon.position.set(cx, 31.4 * scale, cz);
  group.add(beacon);

  group.userData = {
    centre: new THREE.Vector3(cx, 0, cz),
    radius: 30 * scale,
    // Occupies the plan so walk mode cannot stand inside it.
    box: {
      id: -1,
      rel: '__city_hall__',
      x0: cx - 15 * scale,
      z0: cz - 10 * scale,
      x1: cx + 15 * scale,
      z1: cz + 10 * scale,
      height: 33 * scale,
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
