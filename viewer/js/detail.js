/**
 * The detail window: everything about one building, one district, or one
 * filter/lasso selection, opened from the inspector's "Open details" button
 * (see inspector.js::_openDetailWindow) without leaving the main view behind.
 *
 * This is a standalone page with its own CitySource, not a 3D scene: it reads
 * the same manifest/index/chunk/detail data the main viewer does and lays it
 * out as a report, which is the roadmap's documented "first version" for S19
 * -- a full orbiting re-render of the selected building is future work, noted
 * in docs/VISUALIZATION_ROADMAP.md, and would need a browser to verify
 * visually, which this sandbox does not have.
 *
 * Coordination back to the main window is a BroadcastChannel: clicking a
 * co-changed file or a district's top file posts `{fly: buildingId}`, which
 * main.js listens for and hands to its existing `teleportTo`.
 */

import { CitySource } from './loader.js';
import { Vault } from './vault.js';
import { buildFacets, columnIndex } from './facets.js';

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('zion') : null;

// Element ids shared by detail.html and index.html's single-file overlay
// (see the `#detail` section main.js toggles) -- one module serves both.
const root = document.getElementById('detail-body');
const title = document.getElementById('detail-title');
const vaultForm = document.getElementById('detail-vault');

function flyTo(buildingId) {
  if (channel) channel.postMessage({ fly: buildingId });
}

/** Clear the panel before rendering a new selection into it. */
export function resetDetailPanel() {
  if (root) root.innerHTML = '';
  if (title) title.textContent = 'loading…';
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function metricList(rows) {
  const dl = el('dl', { className: 'detail-metrics' });
  for (const [key, value] of rows) {
    dl.append(el('dt', { textContent: key }), el('dd', { textContent: value }));
  }
  return dl;
}

function sparkline(activity) {
  if (!activity || !activity.length || !activity.some((v) => v > 0)) return null;
  const max = Math.max(1, ...activity);
  // activity[0] is the most recent month; lay the bars oldest-to-newest,
  // left to right, the way a calendar reads.
  const bars = activity
    .slice()
    .reverse()
    .map((value) => el('span', { className: 'spark-bar', style: `height:${Math.max(2, Math.round((value / max) * 28))}px` }));
  return el('div', { className: 'sparkline' }, bars);
}

export async function renderBuilding(source, id) {
  const index = await source.index();
  const cols = columnIndex(source.manifest.indexColumns);
  const row = index.find((r) => r[cols.id] === id);
  if (!row) {
    root.append(el('p', { textContent: `Building ${id} was not found in this city.` }));
    return;
  }
  const districtId = row[cols.district];
  const buildings = await source.buildingsFor(districtId);
  const building = buildings.find((b) => b.id === id) || {};
  const district = source.districts.find((d) => d.id === districtId);

  title.textContent = source.label(building) || `building ${id}`;
  const flags = source.manifest.flags || {};

  const rows = [
    ['path', source.locked ? '(locked)' : source.s(building.path)],
    ['district', district ? source.districtLabel(district) : String(districtId)],
    ['language', source.s(building.language)],
    ['archetype', building.archetype],
    ['logical lines', (building.loc || 0).toLocaleString()],
    ['floors', String(building.floors || 0)],
    ['documented', `${Math.round((building.docRatio || 0) * 100)}%`],
  ];
  if (flags.churn) {
    rows.push(['commits', String(building.commits || 0)]);
    rows.push(['churn', `${building.churn || 0} lines added + deleted`]);
    rows.push(['under active construction', building.topChurn ? 'yes (top decile of churn)' : 'no']);
  }
  if (flags.recency) rows.push(['recency', `${Math.round(building.recencyDays || 0)} days since last commit`]);
  if (flags.age) {
    rows.push(['age', `${Math.round(building.ageDays || 0)} days old (${building.era})`]);
    rows.push(['new construction', building.isNew ? 'yes' : 'no']);
  }
  if (flags.churn) rows.push(['heat (recent activity)', `${Math.round((building.heat || 0) * 100)}th percentile`]);
  if (flags.downtown) {
    rows.push(['centrality', `${Math.round((building.centrality || 0) * 100)}th percentile`]);
    rows.push(['downtown', building.downtown ? 'yes' : 'no']);
    rows.push(['imported by', `${building.importInDegree || 0} other file(s) (best-effort)`]);
  }
  if (flags.authorship && building.author >= 0) {
    rows.push(['author', source.s(building.author)]);
    rows.push(['ownership', `${Math.round((building.ownership || 0) * 100)}% of lines`]);
  }
  root.append(metricList(rows));

  if (flags.churn && building.activity) {
    const spark = sparkline(building.activity);
    if (spark) root.append(el('h2', { textContent: 'Commits per month (last 24 months)' }), spark);
  }

  const flyButton = el('button', { className: 'chip-btn', textContent: 'Fly here in the main window →' });
  flyButton.addEventListener('click', () => flyTo(id));
  root.append(flyButton);

  try {
    const detail = await source.detail(building);
    if (detail.floors && detail.floors.length) {
      root.append(el('h2', { textContent: 'Floors' }));
      const list = el('div', { className: 'floor-list' });
      for (const floor of detail.floors) {
        list.append(
          el('div', { className: 'floor-row' }, [
            el('span', { className: 'floor-name', textContent: source.s(floor.name) || '(anonymous)' }),
            el('span', { className: 'floor-kind', textContent: floor.kind }),
            el('span', { className: 'floor-loc', textContent: `${floor.loc} lines` }),
          ])
        );
      }
      root.append(list);
    }
  } catch (error) {
    root.append(el('p', { className: 'hint', textContent: `Floors unavailable: ${error.message}` }));
  }

  if (flags.coupling) {
    const bridges = await source.bridges();
    const related = bridges.filter(([a, b]) => a === id || b === id);
    if (related.length) {
      root.append(el('h2', { textContent: 'Changes together with' }));
      const list = el('div', { className: 'floor-list' });
      const byId = new Map(index.map((r) => [r[cols.id], r]));
      for (const [a, b, count] of related.slice(0, 30)) {
        const otherId = a === id ? b : a;
        const otherRow = byId.get(otherId);
        const name = otherRow ? source.s(otherRow[cols.name]) : `building ${otherId}`;
        const button = el('button', {
          className: 'chip-btn',
          textContent: `${source.locked ? `building ${otherId}` : name} (${count}×)`,
        });
        button.addEventListener('click', () => flyTo(otherId));
        list.append(button);
      }
      root.append(list);
    }
  }
}

export async function renderDistrict(source, id) {
  const district = source.districts.find((d) => d.id === id);
  if (!district) {
    root.append(el('p', { textContent: `District ${id} was not found in this city.` }));
    return;
  }
  title.textContent = source.districtLabel(district);
  const breadcrumb = (district.pathSegments || []).map((i) => source.s(i)).join(' / ');
  if (breadcrumb && !source.locked) root.append(el('p', { className: 'hint', textContent: breadcrumb }));
  const flags = source.manifest.flags || {};

  const rows = [
    ['buildings', String(district.buildings)],
    ['logical lines', (district.logicalLoc || 0).toLocaleString()],
    ['documented', `${district.documented} of ${district.buildings}`],
    ['language', source.s(district.primaryLanguage)],
    ['test files', String(district.testFiles)],
    ['data files', String(district.dataFiles)],
    ['tallest', `${Math.round(district.skyline.maxHeight)} m`],
    ['README', district.hasReadme ? (source.locked ? '(locked)' : source.s(district.readmeRel)) : 'none'],
  ];
  if (flags.authorship) rows.push(['mayor', source.locked ? '(locked)' : source.s(district.mayor) || 'unknown']);
  if (flags.churn) rows.push(['heat (recent activity)', `${Math.round((district.heat || 0) * 100)}% of scale`]);
  if (flags.age) rows.push(['new files', `${district.newFiles || 0} of ${district.buildings}`]);
  if (flags.downtown) rows.push(['central business district', district.isCbd ? 'yes' : 'no']);
  root.append(metricList(rows));

  const index = await source.index();
  const cols = columnIndex(source.manifest.indexColumns);
  const members = index.filter((r) => r[cols.district] === id).sort((a, b) => b[cols.loc] - a[cols.loc]);

  root.append(el('h2', { textContent: 'Facets' }));
  const facets = buildFacets(members, source.manifest.indexColumns, (i) => source.s(i), () => '');
  const chipRow = el('div', { className: 'floor-list' });
  for (const chip of [...facets.archetypes, ...facets.languages].slice(0, 12)) {
    chipRow.append(el('span', { className: 'chip-btn', textContent: `${chip.label} (${chip.count})` }));
  }
  root.append(chipRow);

  const fileButton = (row) => {
    const buildingId = row[cols.id];
    const button = el('button', {
      className: 'chip-btn',
      textContent: `${source.locked ? `building ${buildingId}` : source.s(row[cols.name])} — ${row[cols.loc]} lines`,
    });
    button.addEventListener('click', () => {
      resetDetailPanel();
      if (document.body.classList.contains('detail-page')) {
        // Keep the URL shareable when this is the standalone page; the
        // in-page overlay has no query string of its own to update.
        const params = new URLSearchParams(location.search);
        params.set('b', String(buildingId));
        params.delete('d');
        history.replaceState(null, '', `${location.pathname}?${params}`);
      }
      renderBuilding(source, buildingId);
    });
    return button;
  };

  const filesHeading = el('h2', { textContent: 'Largest files in this district' });
  const filesList = el('div', { className: 'floor-list' });
  const renderFiles = (prefix) => {
    filesHeading.textContent = prefix ? `Files under ${prefix}/` : 'Largest files in this district';
    filesList.innerHTML = '';
    const scoped = prefix ? members.filter((row) => source.s(row[cols.path]).startsWith(`${prefix}/`)) : members;
    for (const row of scoped.slice(0, 20)) filesList.append(fileButton(row));
  };

  // Sub-folders (S13's "first version": a breakdown one level deeper than
  // this district's own block, not a re-layout of the treemap itself -- see
  // analyzer/emit.py::_subfolders_of). Clicking one narrows the file list
  // below by path prefix, without touching the district's geometry at all.
  if (district.subfolders && district.subfolders.length && !source.locked) {
    root.append(el('h2', { textContent: 'Sub-folders' }));
    const subRow = el('div', { className: 'floor-list' });
    let activePrefix = null;
    for (const sub of district.subfolders) {
      const name = source.s(sub.name);
      const chip = el('button', {
        className: 'chip-btn',
        textContent: `${name}/ (${sub.files} files, ${sub.loc} lines)`,
      });
      chip.addEventListener('click', () => {
        activePrefix = activePrefix === name ? null : name;
        renderFiles(activePrefix);
      });
      subRow.append(chip);
    }
    root.append(subRow);
  }

  root.append(filesHeading, filesList);
  renderFiles(null);
}

async function unlockFlow(source) {
  return new Promise((resolve) => {
    vaultForm.hidden = false;
    vaultForm.addEventListener(
      'submit',
      async (event) => {
        event.preventDefault();
        const passphrase = new FormData(vaultForm).get('passphrase');
        const vault = new Vault(source.manifest);
        source.vault = vault;
        await vault.unlock(String(passphrase || ''));
        try {
          await source.unlockStrings();
          vaultForm.hidden = true;
          resolve();
        } catch (error) {
          vaultForm.querySelector('.hint').textContent = `Could not unlock: ${error.message}`;
        }
      },
      { once: true }
    );
  });
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const source = new CitySource('.');
  await source.load();
  const locked = (await source.loadStrings()) === null;
  if (locked) await unlockFlow(source);

  const buildingId = params.has('b') ? Number(params.get('b')) : null;
  const districtId = params.has('d') ? Number(params.get('d')) : null;

  if (buildingId !== null) {
    await renderBuilding(source, buildingId);
  } else if (districtId !== null) {
    await renderDistrict(source, districtId);
  } else {
    title.textContent = 'Nothing selected';
    root.append(el('p', { textContent: 'Open this page from a building or district in the main city view.' }));
  }
}

// Only auto-run when loaded as the standalone page (detail.html sets this
// class on <body>). The single-file build imports renderBuilding/
// renderDistrict/resetDetailPanel directly into its own overlay instead,
// reusing the *already loaded* main-window CitySource rather than fetching
// everything a second time.
if (document.body.classList.contains('detail-page')) {
  boot().catch((error) => {
    title.textContent = 'Could not load';
    root.append(el('p', { textContent: error.message }));
  });
}
