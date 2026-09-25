/**
 * The minimap: the whole plan in a corner, and a way to get anywhere on it.
 *
 * A city seen from the street loses its shape -- which district you are in,
 * where the one you are looking for is, how far it is. The minimap keeps the
 * plan on screen at all times: regions, roads and district plates straight
 * from the manifest (so districts that have not streamed in are still there),
 * tinted by the active colour lens, with the filter's matches, the selection
 * and the reader's noted files marked on top, and the camera drawn as a view
 * cone (or, in the plan view, as the rectangle of ground on screen).
 *
 * Click flies there; drag scrubs across the city; the wheel zooms the map, not
 * the camera. It is a 2D canvas rather than a second WebGL pass: the plan is a
 * few hundred rectangles, and a canvas is cheap, sharp at any pixel ratio, and
 * independent of what is resident.
 *
 * Nothing here reads a name except through `host.districtLabel`, which already
 * respects a locked city.
 */

const STORAGE_KEY = 'zion.minimap.collapsed';
const ZOOM_MIN = 1;
const ZOOM_MAX = 8;
const REGION_FILL = ['#141a26', '#18202e', '#1c2536', '#212b3d'];
const SELECTION = '#ffb347';
const MATCH = '#f8fafc';
const NOTE = '#ff5fa2';

function readCollapsed() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === '1') return true;
    if (value === '0') return false;
  } catch {
    // Storage can be blocked (private window, file://); the map still works.
  }
  return window.innerWidth < 700;
}

function writeCollapsed(collapsed) {
  try {
    localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    /* not persisted, which is fine */
  }
}

export class MiniMap {
  /**
   * `host` is the viewer's side of the contract:
   *   manifest, THREE, camera
   *   buildings()            resident buildings
   *   colourOf(building)     a THREE.Color under the current lens
   *   matches()              Set of matching building ids, or null (no filter)
   *   positionOf(id)         {x, z, approximate?} for any building id
   *   selection()            {kind, building|district} or null
   *   notedIds()             Set of building ids with a note, or null
   *   districtLabel(d)       a display name
   *   mode()                 'fly' | 'walk' | 'orbit' | 'top' | 'interior'
   *   visibleRect()          [x, z, w, h] of the plan view, when mode is 'top'
   *   navigate(x, z, how)    how = 'fly' (animated) | 'scrub' (immediate) | {district}
   *   gradesShown()          whether folder grade letters are drawn
   *   flows()                the plan view's folder arrows [{from, to, weight, violates}]
   */
  constructor(root, host) {
    this.root = root;
    this.host = host;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.tip = root.querySelector('.minimap-tip');
    this.zoom = 1;
    this.dirty = true;
    this.lastDraw = 0;
    this.background = document.createElement('canvas');
    this.focus = null; // map centre in world units when zoomed in
    this.drag = null;
    this.collapsed = readCollapsed();
    this._applyCollapsed();

    root.querySelector('.minimap-toggle').addEventListener('click', () => this.toggle());
    root.querySelector('.minimap-pill').addEventListener('click', () => this.toggle(false));
    root.querySelector('.minimap-zoom-in').addEventListener('click', () => this.setZoom(this.zoom * 2));
    root.querySelector('.minimap-zoom-out').addEventListener('click', () => this.setZoom(this.zoom / 2));

    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (event) => this._down(event));
    canvas.addEventListener('pointermove', (event) => this._move(event));
    canvas.addEventListener('pointerup', (event) => this._up(event));
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('pointerleave', () => { this.tip.hidden = true; });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const world = this.toWorld(event);
      this.setZoom(this.zoom * (event.deltaY < 0 ? 1.5 : 1 / 1.5), world);
    }, { passive: false });
    // Keys typed over the map must not also fly the camera.
    root.addEventListener('keydown', (event) => event.stopPropagation());

    this._observeFooter();
  }

  /** Keep the map clear of the footer, whose height changes as it wraps. */
  _observeFooter() {
    const footer = document.getElementById('controls');
    if (!footer) return;
    const set = () => document.documentElement.style.setProperty('--footer-h', `${footer.offsetHeight}px`);
    set();
    if ('ResizeObserver' in window) new ResizeObserver(set).observe(footer);
    window.addEventListener('resize', set);
  }

  toggle(collapsed = !this.collapsed) {
    this.collapsed = collapsed;
    writeCollapsed(collapsed);
    this._applyCollapsed();
    this.invalidate();
  }

  _applyCollapsed() {
    this.root.classList.toggle('collapsed', this.collapsed);
    document.body.classList.toggle('minimap-open', !this.collapsed);
    const button = this.root.querySelector('.minimap-toggle');
    if (button) button.setAttribute('aria-expanded', String(!this.collapsed));
  }

  setZoom(zoom, around) {
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom));
    if (next === this.zoom) return;
    this.zoom = next;
    this.focus = next === 1 ? null : (around || this.focus || this._cameraGround());
    this.invalidate();
  }

  /** Anything the background shows changed: lens, filter, residency, notes, selection. */
  invalidate() {
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  _size() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.background.width = width;
      this.background.height = height;
      this.dirty = true;
    }
    return { width, height, ratio, cssWidth: rect.width, cssHeight: rect.height };
  }

  /** World window currently mapped onto the canvas: [x, z, w, h]. */
  _window() {
    const [bx, bz, bw, bh] = this.host.manifest.bounds;
    const pad = Math.max(bw, bh) * 0.03;
    const span = Math.max(bw, bh) + pad * 2;
    const size = span / this.zoom;
    const centre = this.zoom === 1 || !this.focus
      ? { x: bx + bw / 2, z: bz + bh / 2 }
      : this.focus;
    return [centre.x - size / 2, centre.z - size / 2, size, size];
  }

  _transform() {
    const { width, height } = this._size();
    const [wx, wz, ww, wh] = this._window();
    const scale = Math.min(width / ww, height / wh);
    const ox = (width - ww * scale) / 2 - wx * scale;
    const oz = (height - wh * scale) / 2 - wz * scale;
    return { scale, ox, oz, width, height };
  }

  toCanvas(x, z, t = this._transform()) {
    return [x * t.scale + t.ox, z * t.scale + t.oz];
  }

  /** Canvas event -> world ground point. */
  toWorld(event) {
    const rect = this.canvas.getBoundingClientRect();
    const t = this._transform();
    const ratio = t.width / Math.max(1, rect.width);
    const cx = (event.clientX - rect.left) * ratio;
    const cz = (event.clientY - rect.top) * ratio;
    return { x: (cx - t.ox) / t.scale, z: (cz - t.oz) / t.scale };
  }

  _cameraGround() {
    const position = this.host.camera.position;
    return { x: position.x, z: position.z };
  }

  districtAt(point) {
    for (const district of this.host.manifest.districts || []) {
      const [x, z, w, h] = district.rect;
      if (point.x >= x && point.x <= x + w && point.z >= z && point.z <= z + h) return district;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Pointer
  // -------------------------------------------------------------------------

  _down(event) {
    if (event.button !== 0) return;
    this.drag = { x: event.clientX, y: event.clientY, moved: 0 };
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* synthetic events have no pointer to capture */
    }
  }

  _move(event) {
    const world = this.toWorld(event);
    const district = this.districtAt(world);
    if (district && !this.drag) {
      this.tip.hidden = false;
      this.tip.textContent = this.host.districtLabel(district);
    } else if (!this.drag) {
      this.tip.hidden = true;
    }
    if (!this.drag) return;
    this.drag.moved += Math.abs(event.clientX - this.drag.x) + Math.abs(event.clientY - this.drag.y);
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
    if (this.drag.moved > 4) this.host.navigate(world.x, world.z, 'scrub');
  }

  _up(event) {
    const drag = this.drag;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      /* nothing to release */
    }
    if (!drag || drag.moved > 4) return;
    const world = this.toWorld(event);
    const district = event.shiftKey ? this.districtAt(world) : null;
    if (district) this.host.navigate(world.x, world.z, { district });
    else this.host.navigate(world.x, world.z, 'fly');
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  /** Called every frame; redraws at ~20 Hz, the background only when dirty. */
  update(now) {
    if (this.collapsed || this.root.hidden) return;
    if (now - this.lastDraw < 50) return;
    this.lastDraw = now;
    // Zoomed in, the map follows the camera once it nears the edge.
    if (this.zoom > 1 && this.host.mode() !== 'interior') {
      const ground = this._cameraGround();
      const [wx, wz, ww, wh] = this._window();
      const inset = ww * 0.2;
      if (ground.x < wx + inset || ground.x > wx + ww - inset || ground.z < wz + inset || ground.z > wz + wh - inset) {
        this.focus = ground;
        this.dirty = true;
      }
    }
    const t = this._transform();
    if (this.dirty) this._drawBackground(t);
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, t.width, t.height);
    ctx.drawImage(this.background, 0, 0);
    this._drawFlows(ctx, t);
    this._drawCamera(ctx, t);
  }

  _drawBackground(t) {
    this.dirty = false;
    const host = this.host;
    const manifest = host.manifest;
    const ctx = this.background.getContext('2d');
    const ratio = t.width / Math.max(1, this.canvas.getBoundingClientRect().width || 1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#070a12';
    ctx.fillRect(0, 0, t.width, t.height);

    const rect = (r, fill) => {
      const [x, z] = this.toCanvas(r[0], r[1], t);
      ctx.fillStyle = fill;
      ctx.fillRect(x, z, r[2] * t.scale, r[3] * t.scale);
    };

    for (const region of manifest.regions || []) {
      rect(region.rect, REGION_FILL[Math.min(REGION_FILL.length - 1, region.level || 0)]);
    }

    // Roads by class: highways wide and bright, alleys thin and dim.
    for (const street of manifest.streets || []) {
      const cls = street.length > 4 ? street[4] : 2;
      const [x, z] = this.toCanvas(street[0], street[1], t);
      ctx.fillStyle = cls === 0 ? '#3a4254' : cls === 1 ? '#2e3545' : '#252b38';
      const w = Math.max(street[2] * t.scale, 0.5 * ratio);
      const h = Math.max(street[3] * t.scale, 0.5 * ratio);
      // Streets are rectangles already; keep hairline ones visible.
      ctx.fillRect(x, z, w, h);
    }

    // City Hall's plaza: the one landmark every city has, as a gold disc.
    const hall = manifest.cityHall;
    if (hall && hall.centre) {
      const [hx, hz] = this.toCanvas(hall.centre[0], hall.centre[1], t);
      ctx.fillStyle = 'rgba(217,164,65,0.28)';
      ctx.strokeStyle = 'rgba(217,164,65,0.8)';
      ctx.lineWidth = ratio;
      ctx.beginPath();
      ctx.arc(hx, hz, Math.max(3 * ratio, (hall.plazaRadius || 10) * t.scale * 0.8), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // District plates tinted by the lens: the mean colour of what stands on it.
    const buildings = host.buildings() || [];
    const sums = new Map();
    const colours = new Map();
    for (const building of buildings) {
      const colour = host.colourOf(building);
      if (!colour) continue;
      colours.set(building.id, colour);
      let sum = sums.get(building.district);
      if (!sum) sums.set(building.district, (sum = { r: 0, g: 0, b: 0, n: 0 }));
      sum.r += colour.r;
      sum.g += colour.g;
      sum.b += colour.b;
      sum.n += 1;
    }
    for (const district of manifest.districts || []) {
      const sum = sums.get(district.id);
      const fill = sum
        ? `rgba(${Math.round((sum.r / sum.n) * 255)},${Math.round((sum.g / sum.n) * 255)},${Math.round((sum.b / sum.n) * 255)},0.38)`
        : 'rgba(80,90,110,0.25)';
      rect(district.rect, fill);
    }

    // Buildings, where they are big enough to be more than noise.
    const matches = host.matches();
    for (const building of buildings) {
      const w = (building.width || 4) * t.scale;
      const d = (building.depth || 4) * t.scale;
      if (w < 0.6 && d < 0.6) continue;
      const colour = colours.get(building.id);
      if (!colour) continue;
      const dim = matches && !matches.has(building.id);
      const [x, z] = this.toCanvas(building.x || 0, building.y || 0, t);
      ctx.fillStyle = dim ? 'rgba(60,64,72,0.7)' : `#${colour.getHexString()}`;
      ctx.fillRect(x, z, Math.max(w, 0.8), Math.max(d, 0.8));
    }

    // Filter matches: bright dots, so a handful of hits in a large city can
    // still be found. Non-resident matches sit at their district's centre.
    if (matches && matches.size) {
      ctx.fillStyle = MATCH;
      const radius = Math.max(1.4, 1.6 * ratio);
      let drawn = 0;
      for (const id of matches) {
        const point = host.positionOf(id);
        if (!point) continue;
        const [x, z] = this.toCanvas(point.x, point.z, t);
        ctx.beginPath();
        ctx.arc(x, z, point.approximate ? radius * 0.8 : radius, 0, Math.PI * 2);
        ctx.fill();
        if (++drawn > 5000) break;
      }
    }

    // Folder grades, where the plate is big enough to carry a letter.
    if (host.gradesShown && host.gradesShown()) {
      const GRADE = { A: '#3ddc84', B: '#a3d65c', C: '#e6c34a', D: '#ff9a2e', F: '#ff4d5e' };
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const district of manifest.districts || []) {
        if (!district.grade) continue;
        const [x, z, w, h] = district.rect;
        const size = Math.min(w, h) * t.scale;
        if (size < 16 * ratio) continue;
        const [cx, cz] = this.toCanvas(x + w / 2, z + h / 2, t);
        const font = Math.min(18 * ratio, size * 0.45);
        ctx.font = `700 ${font}px system-ui, sans-serif`;
        ctx.lineWidth = 3 * ratio;
        ctx.strokeStyle = 'rgba(7,10,18,0.85)';
        ctx.strokeText(district.grade, cx, cz);
        ctx.fillStyle = GRADE[district.grade] || '#ccc';
        ctx.fillText(district.grade, cx, cz);
      }
    }

    // The reader's notes, as pins.
    const noted = host.notedIds();
    if (noted && noted.size) {
      for (const id of noted) {
        const point = host.positionOf(id);
        if (!point) continue;
        const [x, z] = this.toCanvas(point.x, point.z, t);
        this._pin(ctx, x, z, NOTE, ratio);
      }
    }

    // The selection: a ring around a building, an outline around a folder.
    const selection = host.selection();
    if (selection) {
      ctx.strokeStyle = SELECTION;
      ctx.lineWidth = 1.6 * ratio;
      if (selection.kind === 'building' && selection.building) {
        const b = selection.building;
        const [x, z] = this.toCanvas((b.x || 0) + (b.width || 4) / 2, (b.y || 0) + (b.depth || 4) / 2, t);
        ctx.beginPath();
        ctx.arc(x, z, 5 * ratio, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const target = selection.district || selection.region;
        if (target && target.rect) {
          const [x, z] = this.toCanvas(target.rect[0], target.rect[1], t);
          ctx.strokeRect(x, z, target.rect[2] * t.scale, target.rect[3] * t.scale);
        }
      }
    }
  }

  _drawFlows(ctx, t) {
    const flows = this.host.flows ? this.host.flows() : [];
    if (!flows.length) return;
    const ratio = t.width / Math.max(1, this.canvas.getBoundingClientRect().width || 1);
    const heaviest = Math.max(1, ...flows.map((f) => f.weight));
    for (const flow of flows) {
      const [ax, az] = this.toCanvas(flow.from.x, flow.from.z, t);
      const [bx, bz] = this.toCanvas(flow.to.x, flow.to.z, t);
      const dx = bx - ax;
      const dz = bz - az;
      const length = Math.hypot(dx, dz);
      if (length < 4) continue;
      const nx = -dz / length;
      const nz = dx / length;
      const mx = (ax + bx) / 2 + nx * length * 0.18;
      const mz = (az + bz) / 2 + nz * length * 0.18;
      ctx.strokeStyle = flow.violates ? '#ff3b30' : '#4da3ff';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = (0.8 + 2 * Math.sqrt(flow.weight / heaviest)) * ratio;
      ctx.beginPath();
      ctx.moveTo(ax, az);
      ctx.quadraticCurveTo(mx, mz, bx, bz);
      ctx.stroke();
      // Arrowhead along the curve's end tangent.
      const angle = Math.atan2(bz - mz, bx - mx);
      const head = 5 * ratio;
      ctx.beginPath();
      ctx.moveTo(bx, bz);
      ctx.lineTo(bx - Math.cos(angle - 0.45) * head, bz - Math.sin(angle - 0.45) * head);
      ctx.lineTo(bx - Math.cos(angle + 0.45) * head, bz - Math.sin(angle + 0.45) * head);
      ctx.closePath();
      ctx.fill();
    }
  }

  _pin(ctx, x, z, colour, ratio) {
    const r = 2.6 * ratio;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(x, z);
    ctx.lineTo(x - r, z - r * 1.8);
    ctx.arc(x, z - r * 2.2, r, Math.PI * 0.8, Math.PI * 0.2);
    ctx.closePath();
    ctx.fill();
  }

  _drawCamera(ctx, t) {
    const host = this.host;
    const mode = host.mode();
    if (mode === 'interior') return;
    const ratio = t.width / Math.max(1, this.canvas.getBoundingClientRect().width || 1);
    ctx.strokeStyle = '#8fd6ff';
    ctx.fillStyle = 'rgba(143,214,255,0.18)';
    ctx.lineWidth = 1.4 * ratio;
    if (mode === 'top') {
      const [x, z, w, h] = host.visibleRect();
      const [cx, cz] = this.toCanvas(x, z, t);
      ctx.fillRect(cx, cz, w * t.scale, h * t.scale);
      ctx.strokeRect(cx, cz, w * t.scale, h * t.scale);
      return;
    }
    const camera = host.camera;
    const forward = new host.THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const heading = Math.atan2(forward.x, forward.z);
    let [px, pz] = this.toCanvas(camera.position.x, camera.position.z, t);
    // Off the map (the opening camera stands well outside the city): pin the
    // marker to the edge, still pointing the way the camera looks.
    const inset = 7 * ratio;
    const offMap = px < inset || pz < inset || px > t.width - inset || pz > t.height - inset;
    if (offMap) {
      px = Math.max(inset, Math.min(t.width - inset, px));
      pz = Math.max(inset, Math.min(t.height - inset, pz));
    }
    // The cone's length is how far the eye reaches on the ground, capped to
    // stay readable: looking down it is short, looking level it is long.
    const reach = Math.min(40 * ratio, Math.max(14 * ratio, (1 - Math.abs(forward.y)) * 40 * ratio));
    const half = ((camera.fov || 60) * Math.PI) / 360 * (camera.aspect || 1);
    ctx.beginPath();
    ctx.moveTo(px, pz);
    ctx.lineTo(px + Math.sin(heading - half) * reach, pz + Math.cos(heading - half) * reach);
    ctx.lineTo(px + Math.sin(heading + half) * reach, pz + Math.cos(heading + half) * reach);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#8fd6ff';
    ctx.beginPath();
    ctx.arc(px, pz, 3 * ratio, 0, Math.PI * 2);
    ctx.fill();
  }
}
