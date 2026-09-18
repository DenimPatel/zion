/**
 * Building the city: one InstancedMesh per archetype.
 *
 * Draw calls stay bounded by the number of archetypes (~8), not by the number
 * of buildings, so a 50,000-file repo renders in the same number of calls as a
 * 28-file one. Everything per-building -- footprint, height, tint, and the
 * fraction of lit windows -- rides in the instance matrix, the instance colour,
 * and one extra instanced attribute.
 */

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

/** A small procedural window grid, used as the emissive map. */
export function makeWindowTexture(THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const cols = 4;
  const rows = 12;
  const cellW = canvas.width / cols;
  const cellH = canvas.height / rows;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * cellW + cellW * 0.22;
      const y = row * cellH + cellH * 0.2;
      const w = cellW * 0.56;
      const h = cellH * 0.5;
      const shade = 120 + Math.floor(Math.random() * 135);
      ctx.fillStyle = `rgb(${shade}, ${Math.floor(shade * 0.88)}, ${Math.floor(shade * 0.66)})`;
      ctx.fillRect(x, y, w, h);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
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

/**
 * Inject a per-instance "lit windows" scalar into the standard material.
 *
 * The emissive map draws the windows; this attribute decides how brightly each
 * individual building's windows glow, which is the whole metaphor -- lit means
 * documented.
 */
function patchLitWindows(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float aLit;\nvarying float vLit;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vLit = aLit;'
      );
    shader.fragmentShader =
      'varying float vLit;\n' +
      shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= vLit;'
      );
  };
  material.customProgramCacheKey = () => 'zion-lit-windows';
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
    // their glow (the metaphor must survive at range) but drop the window
    // texture, which is the expensive part of the fragment shader.
    const lodNear = options.lodNear !== undefined
      ? options.lodNear
      : Math.min(900, Math.max(140, Math.max(bw, bh) * 0.45));
    const cameraXZ = options.cameraXZ || null;

    const byArchetype = new Map();
    for (const building of buildings) {
      const key = building.archetype || 'warehouse';
      if (!byArchetype.has(key)) byArchetype.set(key, { near: [], far: [] });
      const bucket = byArchetype.get(key);
      if (cameraXZ) {
        const dx = (building.x || 0) - cameraXZ.x;
        const dz = (building.y || 0) - cameraXZ.z;
        (Math.hypot(dx, dz) <= lodNear ? bucket.near : bucket.far).push(building);
      } else {
        bucket.near.push(building);
      }
    }

    const geometry = new THREE.BoxGeometry(1, 1, 1);
    geometry.translate(0, 0.5, 0); // origin at the base, so scaling grows upward
    const windowTexture = makeWindowTexture(THREE);

    const matrix = new THREE.Matrix4();
    const colour = new THREE.Color();

    for (const [archetype, tiers] of byArchetype) {
      for (const tier of ['near', 'far']) {
      const members = tiers[tier];
      if (!members.length) continue;
      const material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: archetype === 'park' ? 0.95 : 0.72,
        metalness: archetype === 'monument' ? 0.35 : 0.08,
        emissive: new THREE.Color(0xffc978),
        emissiveMap: tier === 'near' ? windowTexture : null,
        emissiveIntensity: 0,
      });
      patchLitWindows(material);

      const mesh = new THREE.InstancedMesh(geometry.clone(), material, members.length);
      mesh.name = `buildings-${archetype}${tier === 'far' ? '-far' : ''}`;
      mesh.castShadow = tier === 'near' && archetype !== 'park';
      mesh.receiveShadow = tier === 'near';

      const lit = new Float32Array(members.length);
      members.forEach((building, index) => {
        const width = building.width || 4;
        const depth = building.depth || 4;
        const x = (building.x || 0) + width / 2;
        const z = (building.y || 0) + depth / 2;
        matrix.makeScale(width, building.height || 3, depth);
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
      });

      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.setAttribute('aLit', new THREE.InstancedBufferAttribute(lit, 1));
      // Keep the untouched colours so a hover highlight can be reverted exactly.
      if (mesh.instanceColor) {
        mesh.userData.baseColors = Float32Array.from(mesh.instanceColor.array);
      }
      mesh.userData.baseLit = Float32Array.from(lit);
      mesh.userData.baseEmissive = material.emissiveIntensity;

      this.records.set(mesh.uuid, members);
      this.group.add(mesh);
      }
    }

    this._addGround(bx, bz, bw, bh, buildings);
    this._addStreets(manifest.streets || []);
    this._addDistricts(manifest.districts || []);
    return this.group;
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
    districts.forEach((district, index) => {
      const [x, z, w, h] = district.rect;
      matrix.makeScale(w, 1, h);
      matrix.setPosition(x + w / 2, 0.03, z + h / 2);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
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
  setHighlight(mesh, instanceId) {
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
    colour.lerp(accent, 0.62);
    mesh.setColorAt(instanceId, colour);
    mesh.instanceColor.needsUpdate = true;

    const litAttribute = mesh.geometry.getAttribute('aLit');
    if (litAttribute) {
      const boosted = Math.min(1, Math.max(0.75, mesh.userData.baseLit[instanceId] + 0.55));
      litAttribute.setX(instanceId, boosted);
      litAttribute.needsUpdate = true;
    }

    this._hover = { mesh, instanceId, baseLit: mesh.userData.baseLit[instanceId] };
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
    const litAttribute = mesh.geometry.getAttribute('aLit');
    if (litAttribute) {
      litAttribute.setX(instanceId, hover.baseLit);
      litAttribute.needsUpdate = true;
    }
  }

  /**
   * Set the emissive strength for every building at once.
   *
   * Per-building differences are baked into the `aLit` instanced attribute;
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
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}
