/**
 * Folder names on the map, the way a city map prints borough names large and
 * street names small.
 *
 * Every region (a folder that splits into several neighbourhoods) and every
 * district gets a DOM label projected onto its centre. What is shown depends on
 * how far away the camera is: top-level regions read from anywhere, deeper
 * regions only as you come closer, and district names only near street level.
 * The overview tells you the boroughs; the fly-in tells you the blocks.
 *
 * DOM rather than sprites, because text drawn into a texture blurs at every
 * distance but one, and the label count is capped so the page never lays out
 * thousands of elements. Which labels are shown is re-decided at ~10 Hz, but
 * the chosen ones are re-projected every frame: at 10 Hz a fast fly-through
 * left the names stepping behind the buildings they sit on, which read as
 * jitter.
 */

const MAX_LABELS = 48;
const UPDATE_MS = 100;

export class MapLabels {
  constructor(container, camera) {
    this.container = container;
    this.camera = camera;
    this.items = [];
    this.pool = [];
    this.active = [];
    this.lastUpdate = 0;
    this.enabled = true;
    this.span = 1000;
    this.showGrades = true;
  }

  setGradesShown(shown) {
    this.showGrades = shown;
    this.lastUpdate = 0;
  }

  /**
   * `items`: [{ text, x, z, y, level, kind: 'region'|'district', weight, grade? }].
   * `grade` is the folder's health letter (analyzer/grades.py), drawn as a
   * badge after the name when the grades are switched on.
   * `span` is the city's width, which the distance thresholds scale with.
   */
  setItems(items, span) {
    this.items = items;
    this.span = Math.max(200, span || 1000);
    this.active = [];
    this.lastUpdate = 0;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.active = [];
      for (const el of this.pool) el.hidden = true;
    }
  }

  /** How close the camera must be before an item of this depth is named. */
  reach(item) {
    if (item.kind === 'region') {
      if (item.level <= 1) return Infinity;
      return this.span * (item.level === 2 ? 0.55 : 0.32);
    }
    return this.span * 0.22;
  }

  update(now, width, height) {
    if (!this.enabled) return;
    // Deciding *which* labels are shown is the costly part (sorting, collision,
    // text and class writes), and folder names do not change meaning over a
    // few metres, so it stays at ~10 Hz. Their *positions*, though, follow the
    // camera every frame -- otherwise a fast fly-through leaves the names
    // stepping behind the buildings they sit on.
    if (now - this.lastUpdate >= UPDATE_MS) {
      this.lastUpdate = now;
      this.choose(width, height);
    }
    this.place(width, height);
  }

  /** Rebuild the visible set: distance, culling, collisions, text and class. */
  choose(width, height) {
    const camera = this.camera;
    const v = this._v || (this._v = { x: 0, y: 0, z: 0 });
    const visible = [];
    for (const item of this.items) {
      const dx = item.x - camera.position.x;
      const dz = item.z - camera.position.z;
      const dy = (item.y || 0) - camera.position.y;
      const distance = Math.sqrt(dx * dx + dz * dz + dy * dy);
      if (distance > this.reach(item)) continue;
      const p = project(camera, item.x, item.y || 0, item.z, v);
      if (!p || p.x < -0.1 || p.x > 1.1 || p.y < -0.1 || p.y > 1.1) continue;
      visible.push({ item, distance });
    }
    // Shallow folders first; among regions of one level the bigger borough
    // wins a collision (its name says more about the map), among blocks the
    // nearest does (it is the one you are looking at).
    visible.sort((a, b) => {
      const ka = a.item.kind === 'region' ? a.item.level : 9;
      const kb = b.item.kind === 'region' ? b.item.level : 9;
      if (ka !== kb) return ka - kb;
      if (ka !== 9) return (b.item.weight || 0) - (a.item.weight || 0) || a.distance - b.distance;
      return a.distance - b.distance;
    });
    const placed = [];
    const active = [];
    let used = 0;
    for (const entry of visible) {
      if (used >= MAX_LABELS) break;
      const p = project(camera, entry.item.x, entry.item.y || 0, entry.item.z, v);
      if (!p) continue;
      const sx = p.x * width;
      const sy = p.y * height;
      // Skip a label that would sit on top of one already placed.
      const grade = this.showGrades && entry.item.grade ? entry.item.grade : '';
      const w = Math.min(240, 8 + entry.item.text.length * 7.5 + (grade ? 22 : 0));
      const box = { x0: sx - w / 2, x1: sx + w / 2, y0: sy - 11, y1: sy + 11 };
      if (placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue;
      placed.push(box);
      const el = this.element(used++);
      const key = `${entry.item.text}\u0000${grade}`;
      if (el.dataset.key !== key) {
        el.dataset.key = key;
        el.dataset.text = entry.item.text;
        el.textContent = entry.item.text;
        if (grade) {
          const badge = document.createElement('span');
          badge.className = `grade-badge grade-${grade}`;
          badge.textContent = grade;
          badge.title = `health grade ${grade}`;
          el.append(badge);
        }
      }
      const cls = `map-label ${entry.item.kind} level-${Math.min(3, entry.item.level || 0)}`;
      if (el.className !== cls) el.className = cls;
      el.hidden = false;
      active.push({ item: entry.item, el });
    }
    for (let i = used; i < this.pool.length; i++) this.pool[i].hidden = true;
    this.active = active;
  }

  /** Weld the chosen labels to their world points, once per rendered frame. */
  place(width, height) {
    const camera = this.camera;
    const v = this._v || (this._v = { x: 0, y: 0, z: 0 });
    for (const entry of this.active) {
      const item = entry.item;
      const p = project(camera, item.x, item.y || 0, item.z, v);
      if (!p || p.x < -0.1 || p.x > 1.1 || p.y < -0.1 || p.y > 1.1) {
        entry.el.hidden = true;
        continue;
      }
      entry.el.hidden = false;
      // Subpixel, not rounded: integer steps are what made a moving label
      // shiver even when its anchor had not moved a whole pixel.
      entry.el.style.transform =
        `translate(${p.x * width}px, ${p.y * height}px) translate(-50%, -50%)`;
    }
  }

  element(index) {
    while (this.pool.length <= index) {
      const el = document.createElement('div');
      el.className = 'map-label';
      el.hidden = true;
      this.container.append(el);
      this.pool.push(el);
    }
    return this.pool[index];
  }

  /** Labels currently on screen, for the self-test. */
  shown() {
    return this.pool.filter((el) => !el.hidden).map((el) => el.dataset.text || el.textContent);
  }
}

/** World point -> normalised screen (0..1, y down), or null behind the camera. */
function project(camera, x, y, z, out) {
  const e = camera.matrixWorldInverse.elements;
  const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
  if (vz > -0.5) return null; // behind the camera (view space looks down -z)
  const p = camera.projectionMatrix.elements;
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
  if (cw <= 0) return null;
  out.x = (cx / cw) * 0.5 + 0.5;
  out.y = 1 - ((cy / cw) * 0.5 + 0.5);
  return out;
}
