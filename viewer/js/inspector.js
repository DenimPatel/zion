/**
 * The inspector: pick a building, a floor, or a district and show its metrics.
 *
 * Everything shown here is derived from the analysis, never guessed in the
 * browser. Fields whose metric family was switched off by the confidence rules
 * say so instead of rendering a meaningless zero.
 */

import { archetypeLabel } from './city.js';

const FORMULA = {
  height: (b) => `${b.loc.toLocaleString()} logical lines`,
  footprint: (b, dims) =>
    (b.plate === null || b.plate === undefined
      ? `${formatBytes(b.bytes)} on disk`
      : `${b.plate} lines per floor`) + (dims ? ` \u00b7 ${dims}` : ''),
  floors: (b) => `${b.floors} ${b.floors === 1 ? 'floor' : 'floors'}`,
  lit: (b) => (b.lit === null ? 'no windows (data or binary)' : `${Math.round((b.lit || 0) * 100)}% of windows lit`),
  commits: (b) => `${b.commits} ${b.commits === 1 ? 'commit' : 'commits'} touching this file`,
  recency: (b) => `${Math.round(b.recencyDays)} days since last commit`,
  churn: (b) => `${b.churn} lines added + deleted`,
};

/** The plot as it was actually placed, in metres. */
function plotSize(building) {
  const w = building.width;
  const d = building.depth;
  if (!w || !d) return '';
  return `${w.toFixed(1)} \u00d7 ${d.toFixed(1)} m plot`;
}

export function formatBytes(value) {
  if (value === null || value === undefined) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit === 0 ? `${size} B` : `${size.toFixed(1)} ${units[unit]}`;
}

export class Inspector {
  constructor(source) {
    this.source = source;
    this.panel = document.getElementById('inspector');
    this.title = document.getElementById('inspector-title');
    this.pathEl = document.getElementById('inspector-path');
    this.metrics = document.getElementById('inspector-metrics');
    this.floorsEl = document.getElementById('inspector-floors');
    this.hint = document.getElementById('inspector-source-hint');
    this.openDetail = document.getElementById('inspector-open-detail');
    this.selected = null;
    document.getElementById('inspector-close').addEventListener('click', () => this.hide());
    if (this.openDetail) {
      this.openDetail.addEventListener('click', () => this._openDetailWindow());
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.hide();
    });
  }

  hide() {
    this.panel.hidden = true;
    this.selected = null;
  }

  /**
   * Open the detail window for whatever is currently selected.
   *
   * `onOpenDetail`, when set by main.js, takes precedence: a single-file
   * build has no second HTML document to link to (`file://` cannot navigate
   * between two local documents reliably either), so main.js wires this to
   * the same in-page overlay `detail.js` renders for the multi-file case.
   * Otherwise this falls back to a real new-tab navigation to detail.html.
   */
  _openDetailWindow() {
    if (!this.selected) return;
    const id = this.selected.kind === 'building' ? this.selected.building.id : this.selected.district.id;
    if (typeof this.onOpenDetail === 'function') {
      this.onOpenDetail(this.selected.kind, id);
      return;
    }
    const query = this.selected.kind === 'building' ? `?b=${id}` : `?d=${id}`;
    window.open(`detail.html${query}`, '_blank');
  }

  showBuilding(building) {
    this.selected = { kind: 'building', building };
    const source = this.source;
    this.panel.hidden = false;
    this.title.textContent = source.label(building) || source.s(building.path);
    this.pathEl.textContent = source.locked ? '(locked)' : source.s(building.path);
    if (this.openDetail) this.openDetail.hidden = false;

    const rows = [
      ['language', source.s(building.language)],
      ['form', archetypeLabel(building.archetype)],
      ['height', FORMULA.height(building)],
      ['footprint', FORMULA.footprint(building, plotSize(building))],
      ['floors', FORMULA.floors(building)],
      ['documented', `${Math.round((building.docRatio || 0) * 100)}%`],
      ['windows', FORMULA.lit(building)],
    ];

    if (building.rows !== null && building.rows !== undefined) {
      rows.splice(3, 0, ['rows', `${(building.rows || 0).toLocaleString()} rows`]);
    }

    const flags = source.manifest.flags || {};
    if (flags.authorship && building.author >= 0) {
      rows.push(['author', source.s(building.author)]);
      rows.push(['ownership', `${Math.round((building.ownership || 0) * 100)}% of lines`]);
    }
    if (flags.churn) rows.push(['churn', FORMULA.churn(building)]);
    rows.push(['commits', FORMULA.commits(building)]);
    if (flags.recency) rows.push(['recency', FORMULA.recency(building)]);
    if (building.lastMessage >= 0) {
      rows.push(['last message', source.s(building.lastMessage)]);
    }
    if (building.parseConfidence !== 'high') {
      rows.push(['parser', `${building.parseConfidence} confidence`]);
    }

    this.metrics.innerHTML = '';
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      this.metrics.append(dt, dd);
    }

    this.floorsEl.innerHTML = '';
    if (building.floors > 0) {
      const heading = document.createElement('h2');
      heading.textContent = 'Floors';
      this.floorsEl.append(heading);
      this._loadFloors(building);
    }

    this.hint.textContent = building.source
      ? 'Press E (in walk mode, standing outside) to read its source on the walls.'
      : building.isBinary
        ? 'Binary artefact — no source to show.'
        : '';
  }

  async _loadFloors(building) {
    try {
      const detail = await this.source.detail(building);
      const source = this.source;
      for (const floor of detail.floors || []) {
        const row = document.createElement('div');
        row.className = 'floor';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent =
          '  '.repeat(Math.min(floor.depth || 0, 4)) + (source.s(floor.name) || '(anonymous)');
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = floor.kind;
        row.append(name, kind);
        this.floorsEl.append(row);
      }
      if (!detail.floors || !detail.floors.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'No top-level symbols were found in this file.';
        this.floorsEl.append(empty);
      }
    } catch (error) {
      const failed = document.createElement('p');
      failed.className = 'hint';
      failed.textContent = `Could not load floors: ${error.message}`;
      this.floorsEl.append(failed);
    }
  }

  showDistrict(district) {
    this.selected = { kind: 'district', district };
    const source = this.source;
    this.panel.hidden = false;
    this.title.textContent = source.districtLabel(district);
    // A breadcrumb of ancestor folder names (S13/S14): the district itself is
    // still one flat block in the treemap, but the path it sits at is real.
    this.pathEl.textContent = source.locked
      ? '(locked)'
      : (district.pathSegments || []).map((i) => source.s(i)).join(' / ') || source.s(district.key);
    if (this.openDetail) this.openDetail.hidden = false;

    const rows = [
      ['buildings', String(district.buildings)],
      ['logical lines', (district.logicalLoc || 0).toLocaleString()],
      ['documented', `${district.documented} of ${district.buildings}`],
      ['language', source.s(district.primaryLanguage)],
      ['test files', String(district.testFiles)],
      ['data files', String(district.dataFiles)],
      ['tallest', `${Math.round(district.skyline.maxHeight)} m`],
      ['README', district.hasReadme ? source.s(district.readmeRel) : 'none'],
    ];
    if (source.manifest.flags && source.manifest.flags.authorship) {
      rows.push(['mayor', source.s(district.mayor) || 'unknown']);
    }

    this.metrics.innerHTML = '';
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      this.metrics.append(dt, dd);
    }
    this.floorsEl.innerHTML = '';
    this.hint.textContent = 'Click a building to inspect it individually.';
  }
}
