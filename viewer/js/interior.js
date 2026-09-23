/**
 * Interiors: walking the floors of a building and reading its source.
 *
 * Floor detail is fetched on entry and destroyed on exit; at most two interiors
 * are cached. Nothing about interiors is precomputed, which is what keeps a
 * 50,000-file city from carrying 50,000 rooms.
 *
 * A floor's text comes from byte offsets into `f/<id>.src`, so what is rendered
 * is exactly what the parser measured -- no re-parsing, no JSON escaping.
 */

const CACHE_LIMIT = 2;

/** A floor plate's tint: what kind of definition it is, orange when branch-heavy. */
function plateColour(floor) {
  if (!floor) return 0x46516a;
  if ((floor.complexity || 0) >= 15) return 0xff8a2e;
  return {
    class: 0x8a6ad6,
    function: 0x4d86c9,
    method: 0x3aa6a0,
    heading: 0x7c8a7a,
    section: 0x7c8a7a,
    cell: 0x3aa6a0,
  }[floor.kind] || 0x46516a;
}

/**
 * Draw text onto a canvas sized to the wall it will cover.
 *
 * `columns` is chosen from the canvas width so the text is not stretched, and
 * long lines are wrapped rather than clipped.
 */
function makeTextTexture(THREE, text, options = {}) {
  const {
    width = 2048,
    height = 512,
    font = '17px ui-monospace, SFMono-Regular, Menlo, monospace',
    colour = '#dbe4f4',
    background = '#080b12',
    lineHeight = 22,
    padding = 22,
    columns = Math.floor((width - padding * 2) / 9.6),
  } = options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = font;
  ctx.textBaseline = 'top';

  const lines = [];
  for (const raw of text.split('\n')) {
    const expanded = raw.replace(/\t/g, '    ');
    if (expanded.length <= columns) {
      lines.push(expanded);
    } else {
      for (let i = 0; i < expanded.length; i += columns) {
        lines.push(expanded.slice(i, i + columns));
      }
    }
  }

  const rows = Math.max(1, Math.floor((height - padding * 2) / lineHeight));
  const shown = lines.slice(0, rows - (lines.length > rows ? 1 : 0));

  shown.forEach((line, index) => {
    // Comments and docstrings read dimmer, so the code shape shows through.
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
      ctx.fillStyle = '#7f8ea8';
    } else {
      ctx.fillStyle = colour;
    }
    ctx.fillText(line, padding, padding + index * lineHeight);
  });

  if (lines.length > rows) {
    ctx.fillStyle = '#ffb347';
    ctx.fillText(
      `\u2026 ${lines.length - rows} more lines`,
      padding,
      padding + (rows - 1) * lineHeight
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class Interior {
  constructor(THREE, source, renderer) {
    this.THREE = THREE;
    this.source = source;
    this.renderer = renderer;
    this.scene = null;
    this.camera = null;
    this.building = null;
    this.floorIndex = 0;
    this.floors = [];
    this.sourceText = '';
    this.cache = new Map();
    this.walk = null;
    this.room = { width: 34, depth: 26, height: 6.4 };
  }

  get active() {
    return this.scene !== null;
  }

  async enter(building, walkCamera) {
    const detail = await this.source.detail(building);
    const blob = building.source ? await this.source.source(building) : '';
    this.building = building;
    this.floors = detail.floors || [];
    this.sourceText = blob;
    this.floorIndex = 0;
    this.walk = walkCamera;
    this._buildRoom(building);
    this.cache.set(building.id, { detail, blob });
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
    return detail;
  }

  _buildRoom(building) {
    const THREE = this.THREE;
    const { width, depth, height } = this.room;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070c);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));

    const lamp = new THREE.PointLight(0xfff2dc, 55, 60, 2);
    lamp.position.set(0, height - 0.8, 2);
    scene.add(lamp);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.35);
    fill.position.set(-6, 8, 6);
    scene.add(fill);

    // Floor with a faint grid, so walking has a sense of speed.
    const floorCanvas = document.createElement('canvas');
    floorCanvas.width = floorCanvas.height = 128;
    const fctx = floorCanvas.getContext('2d');
    fctx.fillStyle = '#20242e';
    fctx.fillRect(0, 0, 128, 128);
    fctx.strokeStyle = 'rgba(148,163,184,0.18)';
    for (let i = 0; i <= 128; i += 32) {
      fctx.beginPath();
      fctx.moveTo(i, 0);
      fctx.lineTo(i, 128);
      fctx.stroke();
      fctx.beginPath();
      fctx.moveTo(0, i);
      fctx.lineTo(128, i);
      fctx.stroke();
    }
    const floorTexture = new THREE.CanvasTexture(floorCanvas);
    floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
    floorTexture.repeat.set(width / 4, depth / 4);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.95 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);

    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({ color: 0x0d1017, roughness: 1 })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = height;
    scene.add(ceiling);

    // Back wall: the source for the current floor.
    this.codeWall = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ map: makeTextTexture(THREE, this._floorText(), { height: 400 }) })
    );
    this.codeWall.position.set(0, height / 2, -depth / 2 + 0.02);
    scene.add(this.codeWall);

    // Left wall: the building's metrics and floor list.
    this.metaWall = new THREE.Mesh(
      new THREE.PlaneGeometry(depth, height),
      new THREE.MeshBasicMaterial({
        map: makeTextTexture(THREE, this._metaText(building), {
          width: 1536,
          height: 384,
          colour: '#a9bad4',
        }),
      })
    );
    this.metaWall.rotation.y = Math.PI / 2;
    this.metaWall.position.set(-width / 2 + 0.02, height / 2, 0);
    scene.add(this.metaWall);

    // Right wall: a quiet accent so the room reads as enclosed.
    const right = new THREE.Mesh(
      new THREE.PlaneGeometry(depth, height),
      new THREE.MeshStandardMaterial({ color: 0x1b2130, roughness: 1 })
    );
    right.rotation.y = -Math.PI / 2;
    right.position.set(width / 2 - 0.02, height / 2, 0);
    scene.add(right);

    const back = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshStandardMaterial({ color: 0x141a26, roughness: 1 })
    );
    back.position.set(0, height / 2, depth / 2 - 0.02);
    back.rotation.y = Math.PI;
    scene.add(back);

    // A small floor stack in the far corner: a model of the building, not a rug
    // across the room. The highlighted plate is the floor you are standing on.
    // Floors that mean something (S9): each plate is tinted by what the floor
    // is -- class, function, method, heading, cell -- turns orange when that
    // definition is branch-heavy, and is as wide as its share of the lines, so
    // the model says which floors carry the building before any is read.
    this.plates = [];
    const plateCount = Math.max(1, Math.min(this.floors.length, 14));
    const maxLoc = Math.max(1, ...this.floors.slice(0, plateCount).map((f) => f.loc || 0));
    for (let i = 0; i < plateCount; i++) {
      const floor = this.floors[i];
      const share = floor ? 0.35 + 0.65 * Math.sqrt((floor.loc || 0) / maxLoc) : 1;
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(5.4 * share, 0.16, 3.6),
        new THREE.MeshStandardMaterial({
          color: i === this.floorIndex ? 0xffb347 : plateColour(floor),
          emissive: i === this.floorIndex ? 0xffb347 : 0x000000,
          emissiveIntensity: i === this.floorIndex ? 0.35 : 0,
          transparent: true,
          opacity: i === this.floorIndex ? 1 : 0.7,
        })
      );
      plate.position.set(-width / 2 + 6.5, 1.0 + i * 0.42, -depth / 2 + 4.5);
      scene.add(plate);
      this.plates.push(plate);
    }

    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(68, 16 / 9, 0.1, 300);
    this._placeCamera();
  }

  _floorText() {
    const floor = this.floors[this.floorIndex];
    if (!floor) {
      return this.sourceText.slice(0, 12000) || 'No source available for this building.';
    }
    const slice = this.sourceText.slice(floor.srcOffset, floor.srcOffset + floor.srcLength);
    const header = [
      `${this.source.s(this.building?.path || '')}`,
      `floor ${this.floorIndex + 1} / ${this.floors.length}   ${this.source.s(floor.name)}   (${floor.kind}` +
        `${floor.loc ? `, ${floor.loc} lines` : ''}${floor.complexity ? `, ${floor.complexity} decision points` : ''})`,
      floor.doc >= 0 ? `${this.source.s(floor.doc)}` : '',
      '\u2500'.repeat(96),
    ]
      .filter((line) => line !== '')
      .join('\n');
    return `${header}\n${slice || '(no source slice recorded for this floor)'}`;
  }

  _metaText(building) {
    const source = this.source;
    const flags = source.manifest.flags || {};
    const lines = [
      source.s(building.path),
      '',
      `form        ${building.archetype}`,
      `language    ${source.s(building.language)}`,
      `height      ${building.loc.toLocaleString()} logical lines`,
      `floors      ${building.floors}`,
      `documented  ${Math.round((building.docRatio || 0) * 100)}%`,
      `bytes       ${building.bytes.toLocaleString()}`,
      `commits     ${building.commits}`,
    ];
    if (flags.authorship && building.author >= 0) {
      lines.push(`author      ${source.s(building.author)}`);
    }
    if (building.parseConfidence !== 'high') {
      lines.push('', `parsed with ${building.parseConfidence} confidence`);
    }
    lines.push('', 'floors      plates: purple class · blue function · teal method · grey heading · orange 15+ branches');
    this.floors.slice(0, 18).forEach((floor, index) => {
      const marker = index === this.floorIndex ? '>' : ' ';
      lines.push(`${marker} ${source.s(floor.name)}`);
    });
    if (this.floors.length > 18) lines.push(`  \u2026 ${this.floors.length - 18} more`);
    lines.push('', '[ ] change floor    E or Esc leave');
    return lines.join('\n');
  }

  nextFloor(delta) {
    if (!this.floors.length) return;
    this.floorIndex = Math.max(0, Math.min(this.floors.length - 1, this.floorIndex + delta));
    this._refreshTextures();
  }

  _refreshTextures() {
    const THREE = this.THREE;
    this.codeWall.material.map.dispose();
    this.codeWall.material.map = makeTextTexture(THREE, this._floorText(), { height: 400 });
    this.codeWall.material.needsUpdate = true;

    this.metaWall.material.map.dispose();
    this.metaWall.material.map = makeTextTexture(
      THREE,
      this._metaText(this.building),
      { width: 1536, height: 384, colour: '#a9bad4' }
    );
    this.metaWall.material.needsUpdate = true;

    this.plates.forEach((plate, index) => {
      const active = index === this.floorIndex;
      plate.material.color.set(active ? 0xffb347 : plateColour(this.floors[index]));
      plate.material.emissive.set(active ? 0xffb347 : 0x000000);
      plate.material.emissiveIntensity = active ? 0.35 : 0;
      plate.material.opacity = active ? 1 : 0.7;
    });
  }

  _placeCamera() {
    if (!this.camera) return;
    // Stand back from the code wall so a useful width of text is in view.
    this.camera.position.set(2.5, 1.75, 8.5);
    this.camera.lookAt(0, 1.9, -this.room.depth / 2);
  }

  movePlayer(dx, dz) {
    if (!this.camera) return;
    const halfW = this.room.width / 2 - 1.2;
    const halfD = this.room.depth / 2 - 1.2;
    this.camera.position.x = Math.max(-halfW, Math.min(halfW, this.camera.position.x + dx));
    this.camera.position.z = Math.max(-halfD, Math.min(halfD, this.camera.position.z + dz));
  }

  look(yaw, pitch) {
    if (!this.camera) return;
    const distance = 20;
    const target = new this.THREE.Vector3(
      this.camera.position.x - Math.sin(yaw) * Math.cos(pitch) * distance,
      this.camera.position.y + Math.sin(pitch) * distance,
      this.camera.position.z - Math.cos(yaw) * Math.cos(pitch) * distance
    );
    this.camera.lookAt(target);
  }

  resize(aspect) {
    if (this.camera) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
  }

  exit() {
    if (this.scene) {
      this.scene.traverse((node) => {
        if (node.geometry) node.geometry.dispose();
        if (node.material) {
          if (node.material.map) node.material.map.dispose();
          node.material.dispose();
        }
      });
    }
    this.scene = null;
    this.camera = null;
    this.building = null;
  }
}
