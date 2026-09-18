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

export class Tour {
  constructor(source, camera, flight, dom) {
    this.source = source;
    this.camera = camera;
    this.flight = flight;
    this.dom = dom; // { container, caption, label }
    this.stop = 0;
    this.running = false;
    this.timer = null;
  }

  get stops() {
    const manifest = this.source.manifest;
    const s = (i) => this.source.s(i);
    return manifest.districts.map((district) => {
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
    this.running = true;
    this.stop = 0;
    this.dom.container.hidden = false;
    this._goto(0);
  }

  stopTour() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dom.container.hidden = true;
  }

  _goto(index) {
    const stops = this.stops;
    if (index >= stops.length) {
      this.stopTour();
      return;
    }
    this.stop = index;
    const entry = stops[index];
    this.dom.label.textContent = `Tour ${index + 1} / ${stops.length}`;
    this.dom.caption.textContent = entry.caption;
    this.flight.start(
      this.camera.position.clone(),
      this.camera.quaternion.clone(),
      new (this.camera.position.constructor)(...entry.eye),
      new (this.camera.position.constructor)(...entry.target),
      1.8
    );
    this.timer = setTimeout(() => {
      if (this.running) this._goto(index + 1);
    }, 2600);
  }
}
