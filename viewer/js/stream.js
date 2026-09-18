/**
 * Streaming: keep a camera-centred working set of districts.
 *
 * District chunks are fetched on approach and dropped when they fall well
 * behind, with hysteresis so a camera hovering on a boundary does not thrash.
 * Interiors use the same idea in miniature: fetched on entry, destroyed on exit.
 */

const NEAR = 1.0; // multiples of city span: load inside this radius
const FAR = 1.9; // unload beyond this multiple
const MAX_RESIDENT_BUILDINGS = 20000;

export class DistrictStreamer {
  constructor(source, options = {}) {
    this.source = source;
    this.near = (options.near ?? NEAR) * options.span;
    this.far = (options.far ?? FAR) * options.span;
    this.maxResident = options.maxResident ?? MAX_RESIDENT_BUILDINGS;
    this.resident = new Map(); // districtId -> buildings[]
    this.centroids = new Map();
    this.onChange = options.onChange || (() => {});
    this.lastCentre = null;
    this._busy = false;

    for (const district of source.manifest.districts) {
      const [x, z, w, h] = district.rect;
      this.centroids.set(district.id, { x: x + w / 2, z: z + h / 2 });
    }
  }

  /** Districts that should be resident for a given camera XZ. */
  desired(x, z) {
    const wanted = [];
    for (const district of this.source.manifest.districts) {
      const centre = this.centroids.get(district.id);
      const distance = Math.hypot(centre.x - x, centre.z - z);
      const isResident = this.resident.has(district.id);
      if (distance <= (isResident ? this.far : this.near)) {
        wanted.push({ district, distance });
      }
    }
    wanted.sort((a, b) => a.distance - b.distance);

    // Hard cap on resident buildings, nearest districts first.
    const chosen = [];
    let total = 0;
    for (const entry of wanted) {
      const count = entry.district.buildings;
      if (total + count > this.maxResident && chosen.length) continue;
      total += count;
      chosen.push(entry.district);
    }
    return chosen;
  }

  /** Update the working set if the camera moved enough to matter. */
  async update(x, z, force = false) {
    if (this._busy) return false;
    if (
      !force &&
      this.lastCentre &&
      Math.hypot(this.lastCentre.x - x, this.lastCentre.z - z) < this.near * 0.25
    ) {
      return false;
    }
    this.lastCentre = { x, z };
    const desired = this.desired(x, z);
    const desiredIds = new Set(desired.map((d) => d.id));

    let changed = false;
    for (const id of [...this.resident.keys()]) {
      if (!desiredIds.has(id)) {
        this.resident.delete(id);
        changed = true;
      }
    }

    this._busy = true;
    try {
      for (const district of desired) {
        if (this.resident.has(district.id)) continue;
        const buildings = await this.source.buildingsFor(district.id);
        this.resident.set(district.id, buildings);
        changed = true;
      }
    } finally {
      this._busy = false;
    }

    if (changed) this.onChange(this.buildings());
    return changed;
  }

  buildings() {
    const out = [];
    for (const list of this.resident.values()) out.push(...list);
    return out;
  }

  /** Load everything, for small cities where streaming is pointless. */
  async loadAll() {
    for (const district of this.source.manifest.districts) {
      const buildings = await this.source.buildingsFor(district.id);
      this.resident.set(district.id, buildings);
    }
    return this.buildings();
  }

  get residentCount() {
    let total = 0;
    for (const list of this.resident.values()) total += list.length;
    return total;
  }
}
