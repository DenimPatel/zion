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

    // The whole city's grade, by the same rule as every folder's.
    const cityGrade = manifest.grade;
    if (cityGrade && cityGrade.grade) {
      const p = document.createElement('p');
      p.className = 'hall-grade';
      const moved = cityGrade.baselineGrade ? cityGrade.score - cityGrade.baselineScore : 0;
      const trend = cityGrade.baselineGrade
        ? ` <span class="grade-trend ${moved > 0.5 ? 'better' : moved < -0.5 ? 'worse' : ''}">` +
          `${moved > 0.5 ? '▲' : moved < -0.5 ? '▼' : '='} ${cityGrade.baselineGrade} at the baseline</span>`
        : '';
      const why = (cityGrade.gradeWhy || []).slice(0, 3).map(([sig, pts]) => `${escapeHtml(sig)} −${pts}`).join(', ');
      p.innerHTML = `Health grade <span class="grade-badge grade-${cityGrade.grade}">${cityGrade.grade}</span> ` +
        `${Math.round(cityGrade.score)} / 100${trend}${why ? ` · most points lost to ${why}` : ''}`;
      this.body.append(p);
    }

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
      const g = district && district.grade
        ? `<span class="grade-badge grade-${district.grade}">${district.grade}</span>` +
          (district.baselineGrade && district.baselineGrade !== district.grade
            ? `<span class="grade-trend ${district.score > district.baselineScore ? 'better' : 'worse'}">` +
              `${district.score > district.baselineScore ? '▲' : '▼'}${district.baselineGrade}</span>`
            : '')
        : '—';
      tr.innerHTML =
        `<td>${escapeHtml(s(row.name))}</td>` +
        `<td>${g}</td>` +
        `<td class="num">${row.buildings}</td>` +
        `<td class="num">${row.loc.toLocaleString()}</td>` +
        `<td>${row.hasReadme ? 'README' : '—'}</td>`;
      tr.addEventListener('click', () => {
        if (district && this.onTeleport) this.onTeleport({ kind: 'district', district });
      });
      folderTable.append(tr);
    }

    // The main sequence: every folder with enough types to place, by its
    // instability (x) and abstractness (y). Click a dot to fly there.
    const placed = manifest.districts.filter((d) => d.abstractness >= 0 && d.instability >= 0);
    if (placed.length) {
      const h = document.createElement('h3');
      h.textContent = 'The main sequence (click a folder to fly there)';
      this.body.append(h);
      this.body.append(mainSequenceChart(placed, (d) => source.districtLabel(d), (district) => {
        if (this.onTeleport) this.onTeleport({ kind: 'district', district });
      }));
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

    this._dependencyMatrix(manifest, s);
    this._folderHealth(manifest);

    this.panel.hidden = false;
  }
}

/**
 * The dependency structure matrix: rows import columns. Only the folders with
 * the most cross-folder imports, so it stays a readable square; a cell with a
 * red outline holds an import against the layering. Click a row to fly there.
 */
CityHall.prototype._dependencyMatrix = function _dependencyMatrix(manifest, s) {
  const deps = manifest.dependencies;
  if (!deps || !deps.matrix || !deps.matrix.length) return;
  const involvement = new Map();
  for (const [a, b, n] of deps.matrix) {
    involvement.set(a, (involvement.get(a) || 0) + n);
    involvement.set(b, (involvement.get(b) || 0) + n);
  }
  // The busiest folders, ordered from least to most stable: leaves first,
  // foundations last. In that order a clean layering has every import above
  // the diagonal, so anything below it points the wrong way.
  const inst = (id) => {
    const d = manifest.districts[id];
    return d && d.instability >= 0 ? d.instability : 0.5;
  };
  const ids = [...involvement.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([id]) => id)
    .sort((a, b) => inst(b) - inst(a) || a - b);
  const cells = new Map(deps.matrix.map(([a, b, n]) => [`${a}>${b}`, n]));
  const violating = new Set((deps.violatingPairs || []).map(([a, b]) => `${a}>${b}`));
  const max = Math.max(1, ...deps.matrix.map((r) => r[2]));
  const name = (id) => {
    const district = manifest.districts[id];
    return district ? this.source.districtLabel(district) : String(id);
  };
  const h = document.createElement('h3');
  h.textContent = 'Dependencies between folders (row imports column)';
  this.body.append(h);
  const note = document.createElement('p');
  note.className = 'hall-note';
  const rules = deps.rules >= 0 ? s(deps.rules) : '';
  note.textContent = `${deps.violations} import(s) against the layering` +
    (rules && rules !== 'majority' ? ` (rules: ${rules}).` : ' (without a .zion/rules.json: folder pairs that import both ways).') +
    ' Folders run from leaves (unstable) to foundations (stable): in a clean layering every import sits above the diagonal.';
  this.body.append(note);
  const table = document.createElement('table');
  table.className = 'hall-matrix';
  const head = document.createElement('tr');
  head.append(document.createElement('th'));
  ids.forEach((id, index) => {
    const th = document.createElement('th');
    th.className = 'col';
    th.textContent = `${index + 1}`;
    th.title = name(id);
    head.append(th);
  });
  table.append(head);
  ids.forEach((row, index) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    const th = document.createElement('th');
    th.textContent = `${index + 1}. ${name(row)}`;
    tr.append(th);
    for (const col of ids) {
      const td = document.createElement('td');
      const n = cells.get(`${row}>${col}`) || 0;
      if (row === col) td.className = 'self';
      else if (n) {
        td.textContent = String(n);
        td.style.background = `rgba(77, 163, 255, ${(0.15 + 0.75 * (n / max)).toFixed(2)})`;
        td.title = `${name(row)} imports ${name(col)}: ${n}`;
        if (violating.has(`${row}>${col}`)) td.classList.add('violating');
      }
      tr.append(td);
    }
    tr.addEventListener('click', () => {
      const district = manifest.districts[row];
      if (district && this.onTeleport) this.onTeleport({ kind: 'district', district });
    });
    table.append(tr);
  });
  this.body.append(table);

  if (deps.coupling && deps.coupling.length) {
    const h2 = document.createElement('h3');
    h2.textContent = 'Folders that change together';
    this.body.append(h2);
    const coupling = document.createElement('table');
    coupling.className = 'hall-table';
    for (const [a, b, pairs, commits] of deps.coupling) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(name(a))} ↔ ${escapeHtml(name(b))}</td><td class="num">${pairs} pairs</td><td class="num">${commits} commits</td>`;
      coupling.append(tr);
    }
    this.body.append(coupling);
  }
};

/** One row per folder: instability, tests, who to ask. The architect's table. */
CityHall.prototype._folderHealth = function _folderHealth(manifest) {
  const flags = manifest.flags || {};
  if (!flags.imports && !flags.tests && !flags.authorship) return;
  const h = document.createElement('h3');
  h.textContent = 'Folders: coupling, tests and who to ask';
  this.body.append(h);
  const table = document.createElement('table');
  table.className = 'hall-table';
  const head = document.createElement('tr');
  head.innerHTML = '<td>folder</td><td class="num">Ca</td><td class="num">Ce</td><td class="num">I</td><td class="num">tested</td><td>ask</td>';
  table.append(head);
  const rows = [...manifest.districts].sort((a, b) => (b.ca + b.ce) - (a.ca + a.ce) || b.logicalLoc - a.logicalLoc).slice(0, 24);
  for (const district of rows) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    const inst = district.instability >= 0 ? district.instability.toFixed(2) : '—';
    const tested = district.sourceFiles ? `${district.testedFiles}/${district.sourceFiles}` : '—';
    const ask = (district.experts || []).map((e) => this.source.s(e.name)).filter(Boolean).slice(0, 2).join(', ') || '—';
    tr.innerHTML = `<td>${escapeHtml(this.source.districtLabel(district))}</td><td class="num">${district.ca || 0}</td>` +
      `<td class="num">${district.ce || 0}</td><td class="num">${inst}</td><td class="num">${tested}</td><td>${escapeHtml(ask)}</td>`;
    tr.addEventListener('click', () => {
      if (this.onTeleport) this.onTeleport({ kind: 'district', district });
    });
    table.append(tr);
  }
  this.body.append(table);
};

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

/**
 * Martin's main-sequence chart as inline SVG: instability on x, abstractness
 * on y, the ideal line A + I = 1 from top-left to bottom-right, and the two
 * zones it warns about shaded in the corners it avoids.
 */
function mainSequenceChart(districts, labelOf, onPick) {
  const NS = 'http://www.w3.org/2000/svg';
  const size = 260;
  const pad = 30;
  const inner = size - pad * 2;
  const x = (i) => pad + i * inner;
  const y = (a) => pad + (1 - a) * inner;
  const make = (tag, attrs, text) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text) node.textContent = text;
    return node;
  };
  const svg = make('svg', { viewBox: `0 0 ${size} ${size}`, class: 'main-sequence', role: 'img', 'aria-label': 'abstractness against instability per folder' });
  svg.append(make('rect', { x: pad, y: pad, width: inner, height: inner, class: 'ms-frame' }));
  // Zone of pain: bottom-left (stable, concrete). Zone of uselessness: top-right.
  svg.append(make('path', { d: `M${x(0)},${y(0)} L${x(0.35)},${y(0)} A${inner * 0.35},${inner * 0.35} 0 0 0 ${x(0)},${y(0.35)} Z`, class: 'ms-zone-pain' }));
  svg.append(make('path', { d: `M${x(1)},${y(1)} L${x(0.65)},${y(1)} A${inner * 0.35},${inner * 0.35} 0 0 0 ${x(1)},${y(0.65)} Z`, class: 'ms-zone-useless' }));
  svg.append(make('line', { x1: x(0), y1: y(1), x2: x(1), y2: y(0), class: 'ms-line' }));
  svg.append(make('text', { x: x(0) + 4, y: y(0) - 6, class: 'ms-zone' }, 'zone of pain'));
  svg.append(make('text', { x: x(1) - 4, y: y(1) + 14, class: 'ms-zone', 'text-anchor': 'end' }, 'zone of uselessness'));
  svg.append(make('text', { x: size / 2, y: size - 6, class: 'ms-axis', 'text-anchor': 'middle' }, 'instability I →'));
  const yLabel = make('text', { x: 10, y: size / 2, class: 'ms-axis', 'text-anchor': 'middle', transform: `rotate(-90 10 ${size / 2})` }, 'abstractness A →');
  svg.append(yLabel);
  const biggest = Math.max(1, ...districts.map((d) => d.logicalLoc || 1));
  for (const d of districts) {
    const r = 3 + 7 * Math.sqrt((d.logicalLoc || 1) / biggest);
    const dot = make('circle', {
      cx: x(d.instability), cy: y(d.abstractness), r,
      class: `ms-dot ${d.zone ? `ms-${d.zone}` : d.distance > 0.5 ? 'ms-far' : 'ms-near'}`,
      tabindex: 0,
    });
    dot.append(make('title', {}, `${labelOf(d)} · A ${d.abstractness.toFixed(2)} · I ${d.instability.toFixed(2)} · D ${d.distance.toFixed(2)}`));
    dot.addEventListener('click', () => onPick(d));
    dot.addEventListener('keydown', (event) => { if (event.key === 'Enter') onPick(d); });
    svg.append(dot);
  }
  return svg;
}
