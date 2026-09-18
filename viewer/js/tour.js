/**
 * City Hall and the guided tour.
 *
 * City Hall is a synthetic landmark at the centre of the city -- it is not a
 * file, it is the repo's own report card. Its table is the search affordance:
 * clicking a row flies you to that building.
 *
 * The tour is the 30-second "show me this repo" answer: one cinematic stop per
 * district, with a caption built from the same numbers the skyline is built
 * from.
 */

export class CityHall {
  constructor(source, dom) {
    this.source = source;
    this.panel = dom.panel;
    this.body = dom.body;
    this.title = dom.title;
    this.onTeleport = null;
    dom.close.addEventListener('click', () => this.hide());
  }

  get open() {
    return !this.panel.hidden;
  }

  hide() {
    this.panel.hidden = true;
  }

  show() {
    const source = this.source;
    const manifest = source.manifest;
    if (source.locked) {
      this.title.textContent = 'City Hall — locked';
      this.body.innerHTML = '';
      const locked = document.createElement('p');
      locked.className = 'hall-summary';
      locked.textContent =
        'This city was built with --encrypt. The report is encrypted along with every ' +
        'path, name and author. Press U, enter the passphrase, and the report appears ' +
        'here without changing a single building.';
      this.body.append(locked);
      this.panel.hidden = false;
      return;
    }
    const stats = manifest.stats;
    const flags = manifest.flags || {};
    const s = (i) => source.s(i);

    this.title.textContent = 'City Hall';
    this.body.innerHTML = '';

    const summary = document.createElement('p');
    summary.className = 'hall-summary';
    summary.textContent =
      `${stats.fileCount.toLocaleString()} buildings in ${stats.districtCount} districts · ` +
      `${stats.logicalLoc.toLocaleString()} logical lines · ` +
      `${Math.round(stats.docCoverage * 100)}% of files documented · ` +
      `${stats.districtsWithReadme} of ${stats.districtsTotal} districts have a README.`;
    this.body.append(summary);

    for (const note of stats.notes || []) {
      const p = document.createElement('p');
      p.className = 'hall-note';
      p.textContent = s(note);
      this.body.append(p);
    }

    const section = (heading) => {
      const h = document.createElement('h3');
      h.textContent = heading;
      this.body.append(h);
      const table = document.createElement('table');
      table.className = 'hall-table';
      this.body.append(table);
      return table;
    };

    // Languages
    const langTable = section('Languages');
    for (const row of stats.languages) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(s(row.name))}</td>` +
        `<td class="num">${row.files}</td>` +
        `<td class="num">${row.loc.toLocaleString()}</td>`;
      langTable.append(tr);
    }

    // Folders -> teleport
    const folderTable = section('Districts (click to fly there)');
    for (const row of stats.folders) {
      const district = manifest.districts.find((d) => d.name === row.name);
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.innerHTML =
        `<td>${escapeHtml(s(row.name))}</td>` +
        `<td class="num">${row.buildings}</td>` +
        `<td class="num">${row.loc.toLocaleString()}</td>` +
        `<td>${row.hasReadme ? 'README' : '—'}</td>`;
      tr.addEventListener('click', () => {
        if (district && this.onTeleport) this.onTeleport({ kind: 'district', district });
      });
      folderTable.append(tr);
    }

    // Largest files -> teleport
    const fileTable = section('Largest files (click to fly there)');
    for (const row of stats.largestFiles) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.innerHTML =
        `<td class="path">${escapeHtml(s(row.path))}</td>` +
        `<td class="num">${row.loc.toLocaleString()}</td>` +
        `<td class="num">${row.floors}</td>`;
      tr.addEventListener('click', () => {
        const building = this.source.buildings.find((b) => b.path === row.path);
        if (building && this.onTeleport) this.onTeleport({ kind: 'building', building });
      });
      fileTable.append(tr);
    }

    if (flags.authorship && stats.authors.length) {
      const authorTable = section('Authors');
      for (const row of stats.authors) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHtml(s(row.name))}</td>` +
          `<td class="num">${row.lines.toLocaleString()}</td>` +
          `<td class="num">${row.files}</td>`;
        authorTable.append(tr);
      }
    }

    this.panel.hidden = false;
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/**
 * The guided tour: one continuous route, not a sequence of jumps.
 *
 * The first version flew to a district, stopped, and flew again. That looked
 * broken for two compounding reasons, and the fix is shaped by both:
 *
 *  1. `CameraFlight` writes straight to the camera and never touches the fly
 *     camera's own position. The moment a leg ended, the render loop fell
 *     through to `fly.update()`, which re-applied the fly camera's stored state
 *     and snapped the view back home. Hence "it comes to home after each tour".
 *  2. Restarting a flight per stop meant re-deciding the camera every couple of
 *     seconds, which reads as a series of lurches rather than a route.
 *
 * So the tour now owns the camera for its whole duration and follows a single
 * closed spline through every stop, slowing into each one and accelerating out,
 * returning to where it began and carrying on. The fly camera is kept in step
 * every frame, so handing control back moves the camera not at all.
 */

const MIN_LEG_SECONDS = 1.8;
const MAX_LEG_SECONDS = 5.5;
const CRUISE_SPEED = 60; // metres per second, before normalising

// A whole circuit is paced to roughly this long, so a 4-district village and a
// 30-district city both read as a tour rather than a sprint or a crawl.
// Each stop gets a dwell as long as its travel leg, so the camera actually
// stops and holds on what the caption is describing -- twice the time per stop
// compared with travelling straight through.
const DWELL_FACTOR = 1.0;
const SECONDS_PER_STOP = 6.8;
const MIN_CIRCUIT_SECONDS = 20;
const MAX_CIRCUIT_SECONDS = 150;

// A tour of 320 districts is not a tour. Beyond this, stops are sampled evenly
// so the circuit stays an overview, and the label says so.
const MAX_TOUR_STOPS = 32;

/** Zero velocity at both ends, so the camera eases into each stop. */
function smootherStep(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export class Tour {
  constructor(THREE, source, camera, flight, dom) {
    this.THREE = THREE;
    this.source = source;
    this.camera = camera;
    this.flight = flight;
    this.dom = dom; // { container, caption, label, fly }
    this.running = false;
    this.stopIndex = -1;
    this.route = null;
    this.phase = 'lead';
    this.elapsed = 0;
  }

  /**
   * One stop per district, carrying that district's numbers as the caption.
   *
   * Capped at `MAX_TOUR_STOPS`, sampled evenly, because a 320-district city
   * should still produce a watchable tour.
   */
  get stops() {
    const manifest = this.source.manifest;
    const s = (i) => this.source.s(i);
    const all = manifest.districts;
    const districts =
      all.length <= MAX_TOUR_STOPS
        ? all
        : Array.from({ length: MAX_TOUR_STOPS }, (_, i) =>
            all[Math.floor((i * all.length) / MAX_TOUR_STOPS)]
          );
    this.sampledFrom = all.length;
    return districts.map((district) => {
      const [x, z, w, h] = district.rect;
      const span = Math.max(w, h);
      const height = Math.max(24, district.skyline.maxHeight);
      return {
        district,
        eye: [x + w / 2 - span * 0.42, height * 1.35 + 18, z + h / 2 + span * 0.5],
        target: [x + w / 2, height * 0.35, z + h / 2],
        caption:
          `${s(district.key)} — ${district.buildings} buildings, ` +
          `${district.logicalLoc.toLocaleString()} logical lines, ` +
          `${district.documented} documented, ` +
          `${district.testFiles} test files, ` +
          `${district.dataFiles} data files, ` +
          `${district.hasReadme ? 'has a README' : 'no README'}.`,
      };
    });
  }

  start() {
    if (this.running) {
      this.stopTour();
      return;
    }
    const stops = this.stops;
    if (!stops.length) return;
    const THREE = this.THREE;

    const eyePoints = stops.map((stop) => new THREE.Vector3(...stop.eye));
    const lookPoints = stops.map((stop) => new THREE.Vector3(...stop.target));

    // Where the camera is now, and the point it is currently looking toward.
    const from = this.camera.position.clone();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    const lookFrom = from.clone().addScaledVector(forward, 60);

    // Phase 1: one arcing approach from wherever the camera happens to be to the
    // first stop, so the tour never begins by teleporting.
    const approach = from.distanceTo(eyePoints[0]);
    this.lead = {
      from,
      to: eyePoints[0].clone(),
      lookFrom,
      lookTo: lookPoints[0].clone(),
      // A vertical arc, so the approach lifts over the skyline rather than
      // ploughing through it.
      lift: Math.min(140, Math.max(18, approach * 0.22)),
      duration: Math.min(
        MAX_LEG_SECONDS * 1.4,
        Math.max(MIN_LEG_SECONDS, approach / CRUISE_SPEED)
      ),
    };

    // Phase 2: a closed loop through every stop, so the last leg genuinely
    // returns to the starting point and continues from there.
    this.route = {
      eye: new THREE.CatmullRomCurve3(eyePoints, true, 'catmullrom', 0.5),
      look: new THREE.CatmullRomCurve3(lookPoints, true, 'catmullrom', 0.5),
      stops,
      legTimes: [],
      legStarts: [],
      total: 0,
    };
    // Raw leg times from distance, then scaled together so the circuit lands
    // near its target length. Scaling keeps the relative pacing -- long legs
    // still take longer -- while stopping a wide city from being crossed at
    // several hundred metres per second.
    const raw = [];
    for (let i = 0; i < stops.length; i++) {
      const next = (i + 1) % stops.length;
      const distance = eyePoints[i].distanceTo(eyePoints[next]);
      raw.push(Math.min(MAX_LEG_SECONDS, Math.max(MIN_LEG_SECONDS, distance / CRUISE_SPEED)));
    }
    const rawTotal = raw.reduce((sum, value) => sum + value, 0);
    const target = Math.min(
      MAX_CIRCUIT_SECONDS,
      Math.max(MIN_CIRCUIT_SECONDS, stops.length * SECONDS_PER_STOP)
    );
    const factor = 1 + DWELL_FACTOR;
    const scale = rawTotal > 0 ? target / (rawTotal * factor) : 1;

    let accumulated = 0;
    for (const time of raw) {
      const scaled = time * scale;
      this.route.legTimes.push(scaled);
      this.route.legStarts.push(accumulated);
      accumulated += scaled;
    }
    this.route.total = accumulated;

    // Interleave a dwell at every stop with the travel between stops. Building
    // the schedule explicitly keeps "hold here" and "move there" as separate,
    // readable states instead of hiding the pause inside an easing curve.
    this.route.segments = [];
    let clock = 0;
    for (let i = 0; i < stops.length; i++) {
      const dwell = this.route.legTimes[i] * DWELL_FACTOR;
      this.route.segments.push({ type: 'dwell', stop: i, start: clock, duration: dwell });
      clock += dwell;
      this.route.segments.push({
        type: 'travel',
        from: i,
        to: (i + 1) % stops.length,
        start: clock,
        duration: this.route.legTimes[i],
      });
      clock += this.route.legTimes[i];
    }
    this.route.total = clock;

    this.phase = 'lead';
    this.elapsed = 0;
    this.stopIndex = -1;
    this.running = true;
    this.dom.container.hidden = false;
    this._announce(0);
    this.update(0);
  }

  stopTour() {
    this.running = false;
    this.dom.container.hidden = true;
    // Leave the fly camera exactly where the tour left the view, so releasing
    // control does not move the camera at all.
    this._syncFly();
  }

  get progress() {
    if (!this.running || !this.route) return 0;
    if (this.phase === 'lead') return 0;
    return Math.max(0, Math.min(1, this.elapsed / this.route.total));
  }

  /** Jump straight to the next stop, for when the tour is taking too long. */
  skipToNext() {
    if (!this.running || !this.route || this.phase !== 'loop') return false;
    const index = this._segmentAt(this.elapsed);
    for (let i = index + 1; i < this.route.segments.length; i++) {
      if (this.route.segments[i].type === 'dwell') {
        this.elapsed = this.route.segments[i].start;
        return true;
      }
    }
    // Past the last dwell: wrap to the first.
    this.elapsed = 0;
    return true;
  }

  _segmentAt(elapsed) {
    const segments = this.route.segments;
    for (let i = segments.length - 1; i >= 0; i--) {
      if (elapsed >= segments[i].start) return i;
    }
    return 0;
  }

  _announce(index) {
    if (index === this.stopIndex) return;
    this.stopIndex = index;
    const stop = this.route.stops[index];
    const total = this.route.stops.length;
    const sampled =
      this.sampledFrom && this.sampledFrom > total ? ` of ${this.sampledFrom} districts` : '';
    this.dom.label.textContent = `Tour ${index + 1} / ${total}${sampled}`;
    this.dom.caption.textContent = stop.caption;
    // Tell the viewer which block is being described, so there is something to
    // look at while the camera holds.
    if (this.dom.onStop) this.dom.onStop(stop.district, index);
  }

  /** Advance the tour. Returns true when it drove the camera this frame. */
  update(dt) {
    if (!this.running || !this.route) return false;
    this.elapsed += dt;

    if (this.phase === 'lead') {
      const t = Math.min(1, this.elapsed / this.lead.duration);
      const eased = smootherStep(t);
      const position = this.lead.from.clone().lerp(this.lead.to, eased);
      position.y += Math.sin(Math.PI * eased) * this.lead.lift;
      const target = this.lead.lookFrom.clone().lerp(this.lead.lookTo, eased);
      this._place(position, target);
      if (t >= 1) {
        this.phase = 'loop';
        this.elapsed = 0;
        this.stopIndex = -1;
        this._announce(0);
      }
      this._syncFly();
      return true;
    }

    // Phase 2: continuous loop of dwells and travels. Wrap rather than stop, so
    // the route never doubles back on itself.
    if (this.elapsed >= this.route.total) {
      this.elapsed -= this.route.total;
      this.stopIndex = -1;
    }

    const segment = this.route.segments[this._segmentAt(this.elapsed)];
    const legs = this.route.stops.length;

    if (segment.type === 'dwell') {
      // Hold on the stop. A slow drift inward keeps it from looking frozen
      // while still not moving away from what is being described.
      const local = Math.max(0, Math.min(1, (this.elapsed - segment.start) / segment.duration));
      const u = segment.stop / legs;
      const position = this.route.eye.getPoint(u);
      const target = this.route.look.getPoint(u);
      const push = 0.06 * local;
      position.lerp(target, push);
      this._announce(segment.stop);
      this._place(position, target);
    } else {
      const local = Math.max(0, Math.min(1, (this.elapsed - segment.start) / segment.duration));
      const eased = smootherStep(local);
      // `getPoint`, not `getPointAt`: parameterising by segment is what makes one
      // leg correspond to exactly one stop, which is what the easing assumes.
      const u = (segment.from + eased) / legs;
      // Announce the destination, so the highlight is already on the block the
      // camera is approaching.
      this._announce(segment.to);
      this._place(this.route.eye.getPoint(u), this.route.look.getPoint(u));
    }
    this._syncFly();
    return true;
  }

  _place(position, target) {
    this.camera.position.copy(position);
    this.camera.lookAt(target);
  }

  /**
   * Keep the fly camera in step with the tour camera.
   *
   * Without this, the render loop hands control back to a fly camera still
   * sitting wherever the tour began, and the view snaps.
   */
  _syncFly() {
    const fly = this.dom.fly;
    if (!fly) return;
    fly.position.copy(this.camera.position);
    const THREE = this.THREE;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    fly.yaw = Math.atan2(-forward.x, -forward.z);
    fly.pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
  }
}
